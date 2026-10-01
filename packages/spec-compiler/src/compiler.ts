/**
 * Component A: the SpecCompiler.
 *
 * Single most important constraint, restated from the spec:
 *   emit a schema-valid, canonicalized, hash-bound SiteSpec within ONE model
 *   call plus at most 2 structured repairs, never exceeding the caller's
 *   deadline, and fall back to a model-free synthesizer rather than fail.
 *
 * The shape of the method reflects that constraint: every failure path has a
 * defined successor, and the terminal state is always a usable envelope.
 */

import {
  canonicalize,
  specHash,
  validateSiteSpec,
  parseBlockProps,
  summarizeIssues,
  validateSpecEnvelope,
  type Diagnostic,
  type ValidationIssue,
  type BlockType,
} from "@pg/spec-schema";
import { MetricLogger, noopLogger } from "@pg/telemetry";
import { A_WARNINGS, aError } from "./errors.js";
import { cacheKey, FileSpecCache, MemorySpecCache, type CacheKeyParts, type SpecCache } from "./cache.js";
import { extractIntent } from "./intent.js";
import { canonicalizeSpec, MAX_SPEC_BYTES } from "./canonicalize.js";
import { buildInitialPrompt, buildRepairPrompt } from "./prompt.js";
import { synthesizeSiteSpec } from "./synthesizer.js";
import { extractJsonObject, type LlmCompletion, type LlmProvider } from "./llm/provider.js";
import { DeterministicProvider } from "./llm/deterministic.js";
import { LlmRequestError } from "./llm/openai-compatible.js";
import { COMPILER_VERSION, type CompileRequest, type SiteSpec, type SpecEnvelope } from "./types.js";

export interface CompilerOptions {
  provider: LlmProvider;
  cache?: SpecCache;
  logger?: MetricLogger;
  /** Hard ceiling on the whole compile, including repairs. */
  deadlineMs?: number;
  /** Shared across all lanes; defaults to a per-compile timeout. */
  onWarning?: (diagnostic: Diagnostic) => void;
}

export interface CompileOptions {
  /** Overrides the request's own value. */
  modelTier?: "fast" | "standard" | "premium";
  signal?: AbortSignal;
  deadlineMs?: number;
  /** Forces the model-free path regardless of the configured provider. */
  forceFallback?: boolean;
}

const DEFAULT_DEADLINE_MS = 30_000;
const MAX_REPAIRS = 2;
/** FR-A1: a prompt longer than this is rejected with E_A_PROMPT_TOO_LONG. */
const MAX_PROMPT_CHARS = 4000;

interface Accumulator {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  modelId: string;
  modelTier: "fast" | "standard" | "premium";
  repairAttempts: number;
  llmCalls: number;
  warnings: Diagnostic[];
}

export class SpecCompiler {
  private readonly provider: LlmProvider;
  private readonly cache: SpecCache;
  private readonly logger: MetricLogger;
  private readonly deadlineMs: number;
  private readonly emit: (diagnostic: Diagnostic) => void;

  constructor(options: CompilerOptions) {
    this.provider = options.provider;
    this.cache = options.cache ?? new MemorySpecCache();
    this.logger = options.logger ?? noopLogger("@pg/spec-compiler", COMPILER_VERSION);
    this.deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
    this.emit = options.onWarning ?? (() => {});
  }

  get cacheStats(): SpecCache["stats"] {
    return this.cache.stats;
  }

  /**
   * The whole component. Never throws for content or provider reasons: a
   * failure degrades to the deterministic synthesizer. It does throw for
   * contract violations of the *request* itself, because those are the
   * caller's bug and a silent fallback would hide them.
   */
  async compile(rawRequest: CompileRequest, options: CompileOptions = {}): Promise<SpecEnvelope> {
    const startedAt = Date.now();
    const deadlineMs = options.deadlineMs ?? this.deadlineMs;
    const deadlineAt = startedAt + deadlineMs;

    const request = this.prepareRequest(rawRequest);
    const intent = extractIntent(request);
    const accumulator: Accumulator = {
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      modelId: this.provider.model,
      modelTier: options.modelTier ?? request.compile_options?.model_tier ?? "standard",
      repairAttempts: 0,
      llmCalls: 0,
      warnings: [],
    };

    this.warn(
      accumulator,
      intent.redactions > 0
        ? { code: A_WARNINGS.W_A_PII_REDACTED, severity: "warning", message: `${intent.redactions} value(s) redacted before egress` }
        : null,
    );
    this.warn(
      accumulator,
      intent.injectionFindings > 0
        ? {
            code: A_WARNINGS.W_A_INJECTION_NEUTRALIZED,
            severity: "warning",
            message: `${intent.injectionFindings} instruction-shaped span(s) neutralized in the prompt`,
          }
        : null,
    );

    const key = this.cacheKeyFor(request, intent);
    const cached = await this.cache.get(key);
    if (cached && !options.forceFallback) {
      return this.finalize(cached, accumulator, startedAt, "hit");
    }

    let envelope: SpecEnvelope;
    if (options.forceFallback) {
      envelope = this.fallback(request, intent, accumulator, 1);
    } else {
      envelope = await this.modelPath(request, intent, accumulator, deadlineAt, options.signal);
    }

    envelope.meta.degraded = envelope.meta.degraded === true;
    envelope.meta.fallback_depth = envelope.meta.fallback_depth ?? (envelope.meta.degraded ? 1 : 0);
    envelope = this.finalize(envelope, accumulator, startedAt, "miss");

    const validation = validateSpecEnvelope<SpecEnvelope>(envelope, false);
    if (!validation.valid) {
      // A final safety net: even a canonicalized spec must satisfy the contract
      // before it can be handed to the orchestrator. Falling back here is the
      // last line of defence for the batch's delivery guarantee.
      const recovered = this.fallback(request, intent, accumulator, (envelope.meta.fallback_depth ?? 0) + 1);
      return this.finalize(recovered, accumulator, startedAt, "miss");
    }

    if (!options.forceFallback) {
      await this.cache.put(key, envelope);
    }
    this.logger.observe("spec.compile_latency_ms", Date.now() - startedAt, { tier: accumulator.modelTier });
    this.logger.count("spec.llm_calls", accumulator.llmCalls, { tier: accumulator.modelTier });
    this.logger.count("spec.cache", accumulator.modelId === this.provider.model ? 1 : 0, {});
    return envelope;
  }

  /** Model path with bounded repair, then the model-free fallback. */
  private async modelPath(
    request: CompileRequest,
    intent: ReturnType<typeof extractIntent>,
    accumulator: Accumulator,
    deadlineAt: number,
    signal: AbortSignal | undefined,
  ): Promise<SpecEnvelope> {
    const maxRepairs = Math.min(
      MAX_REPAIRS,
      request.compile_options?.max_repair_attempts ?? MAX_REPAIRS,
    );
    let prompt = buildInitialPrompt(request, intent);
    let previousText: string | null = null;
    let lastIssues: string = "";

    for (let attempt = 0; attempt <= maxRepairs; attempt += 1) {
      const remaining = deadlineAt - Date.now();
      if (remaining <= 500) {
        this.warn(accumulator, {
          code: A_WARNINGS.W_A_PROMPT_TRUNCATED,
          severity: "warning",
          message: `deadline reached after ${attempt} attempt(s); falling back`,
        });
        return this.fallback(request, intent, accumulator, 1);
      }
      accumulator.repairAttempts = attempt;

      let completion: LlmCompletion;
      try {
        completion = await this.provider.complete({
          system: prompt.system,
          user: prompt.user,
          maxOutputTokens: request.compile_options?.max_output_tokens ?? 8192,
          temperature: attempt === 0 ? 0.2 : 0.05,
          context: { request, intent },
          ...(signal ? { signal } : {}),
        });
        accumulator.llmCalls += 1;
        accumulator.modelId = completion.model;
        accumulator.inputTokens += completion.usage.inputTokens;
        accumulator.outputTokens += completion.usage.outputTokens;
        accumulator.costUsd +=
          (completion.usage.inputTokens / 1000) * this.provider.costPer1kInputUsd +
          (completion.usage.outputTokens / 1000) * this.provider.costPer1kOutputUsd;
      } catch (error) {
        return this.handleProviderError(error, request, intent, accumulator, attempt);
      }

      if (completion.finishReason === "content_filter") {
        return this.fallback(request, intent, accumulator, 1, "provider refused the request");
      }
      if (completion.finishReason === "length") {
        this.warn(accumulator, {
          code: A_WARNINGS.W_A_TOKEN_BUDGET_TRUNCATED,
          severity: "warning",
          message: "provider truncated the response at the token ceiling",
        });
      }

      previousText = completion.text;
      const outcome = this.assemble(completion.text, request, accumulator);
      if (outcome.envelope) return outcome.envelope;

      lastIssues = summarizeIssues(outcome.issues);
      this.logger.count("spec.repair_required", 1, { attempt: String(attempt) });
      prompt = buildRepairPrompt(request, intent, previousText, lastIssues, attempt + 1);
    }

    this.warn(accumulator, {
      code: "W_A_REPAIR_EXHAUSTED",
      severity: "warning",
      message: `model output still invalid after ${maxRepairs} repair(s): ${lastIssues.split("\n")[0] ?? "unknown"}`,
    });
    return this.fallback(request, intent, accumulator, 1);
  }

  private handleProviderError(
    error: unknown,
    request: CompileRequest,
    intent: ReturnType<typeof extractIntent>,
    accumulator: Accumulator,
    attempt: number,
  ): SpecEnvelope {
    if (!(error instanceof LlmRequestError)) {
      this.warn(accumulator, {
        code: "W_A_PROVIDER_ERROR",
        severity: "warning",
        message: `provider error: ${error instanceof Error ? error.message : String(error)}`,
      });
      return this.fallback(request, intent, accumulator, attempt + 1);
    }
    switch (error.kind) {
      case "content_filtered":
        return this.fallback(request, intent, accumulator, attempt + 1, "provider refused the request");
      case "rate_limited":
        this.warn(accumulator, {
          code: "E_A_RATE_LIMITED",
          severity: "warning",
          message: `rate limited; escalating to the model-free path (retryAfter ${error.retryAfterMs ?? 0}ms)`,
        });
        return this.fallback(request, intent, accumulator, attempt + 1);
      case "timeout":
        return this.fallback(request, intent, accumulator, attempt + 1, `model timeout: ${error.message}`);
      default:
        return this.fallback(request, intent, accumulator, attempt + 1, `provider error: ${error.message}`);
    }
  }

  /**
   * Parse -> canonicalize -> block-prop check -> design gate -> size cap.
   * Returns an envelope or the validation issues that caused rejection.
   */
  private assemble(
    text: string,
    request: CompileRequest,
    accumulator: Accumulator,
  ): { envelope: SpecEnvelope | null; issues: ValidationIssue[] } {
    let parsed: unknown;
    try {
      parsed = extractJsonObject(text);
    } catch (error) {
      return {
        envelope: null,
        issues: [{ pointer: "/", keyword: "parse", message: (error as Error).message }],
      };
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { envelope: null, issues: [{ pointer: "/", keyword: "type", message: "expected a JSON object" }] };
    }

    const specCandidate = (parsed as { spec?: unknown }).spec ?? parsed;
    const candidate = this.decorate(specCandidate as SiteSpec, accumulator);

    const validation = validateSiteSpec(candidate, false);
    if (!validation.valid) {
      return { envelope: null, issues: validation.issues };
    }

    const canonical = canonicalizeSpec(candidate);
    const bytes = Buffer.byteLength(canonicalize(canonical), "utf8");
    if (bytes > MAX_SPEC_BYTES) {
      return {
        envelope: null,
        issues: [{ pointer: "/", keyword: "maxLength", message: `serialized spec is ${bytes} bytes, cap is ${MAX_SPEC_BYTES}` }],
      };
    }

    return {
      envelope: {
        spec: canonical,
        meta: {
          spec_version: "1.0.0",
          spec_hash: specHash(canonical),
          compiler_version: COMPILER_VERSION,
          model_id: accumulator.modelId,
          model_tier: accumulator.modelTier,
          // The deterministic provider *is* the fallback synthesizer, so an
          // offline compile is a degraded compile even though it validates
          // cleanly. Reporting otherwise would make the offline budget run
          // look better than a production one.
          degraded: this.provider.id === "deterministic",
          fallback_depth: this.provider.id === "deterministic" ? 1 : 0,
          warnings: [],
        },
      },
      issues: [],
    };
  }

  /**
   * Post-processing a valid-but-suspicious spec still needs: block props that
   * the model invented get dropped rather than rendered, and ungrounded
   * quantitative claims get flagged.
   */
  private decorate(spec: SiteSpec, accumulator: Accumulator): SiteSpec {
    const out: SiteSpec = structuredClone(spec);
    let invalidBlocks = 0;
    for (const page of out.pages ?? []) {
      for (const block of page.blocks ?? []) {
        const parsed = parseBlockProps(block.type as BlockType, block.props ?? {});
        if (!parsed.valid) invalidBlocks += 1;
        block.props = parsed.props;
      }
    }
    if (invalidBlocks > 0) {
      this.warn(accumulator, {
        code: A_WARNINGS.W_A_BLOCK_PROPS_INVALID,
        severity: "warning",
        message: `${invalidBlocks} block(s) carried props outside the declared shape; unknown keys were dropped`,
      });
    }
    return out;
  }

  /** FR-A16: the model-free synthesizer, marked degraded. */
  private fallback(
    request: CompileRequest,
    intent: ReturnType<typeof extractIntent>,
    accumulator: Accumulator,
    depth: number,
    reason?: string,
  ): SpecEnvelope {
    this.warn(accumulator, {
      code: A_WARNINGS.W_A_FALLBACK_ENGAGED,
      severity: "warning",
      message: `deterministic fallback engaged at depth ${depth}${reason ? `: ${reason}` : ""}`,
    });
    const { spec, unverifiedClaims, truncated } = synthesizeSiteSpec(intent, request);
    const canonical = canonicalizeSpec(spec);
    if (truncated) {
      this.warn(accumulator, {
        code: A_WARNINGS.W_A_TOKEN_BUDGET_TRUNCATED,
        severity: "warning",
        message: `page set truncated to ${canonical.pages.length} to respect max_pages`,
      });
    }
    return {
      spec: canonical,
      meta: {
        spec_version: "1.0.0",
        spec_hash: specHash(canonical),
        compiler_version: COMPILER_VERSION,
        prompt_hash: undefined,
        model_id: "deterministic-synthesizer",
        model_tier: "fast",
        degraded: true,
        fallback_depth: Math.min(4, Math.max(1, depth)),
        warnings: unverifiedClaims.slice(0, 20).map((claim) => ({
          code: A_WARNINGS.W_A_CLAIM_UNVERIFIED,
          severity: "warning" as const,
          message: `${claim.text} (${claim.pointer})`,
          pointer: claim.pointer,
        })),
      },
    };
  }

  private finalize(
    envelope: SpecEnvelope,
    accumulator: Accumulator,
    startedAt: number,
    cache: "hit" | "miss" | "bypass",
  ): SpecEnvelope {
    return {
      spec: envelope.spec,
      meta: {
        ...envelope.meta,
        spec_version: "1.0.0",
        spec_hash: specHash(envelope.spec),
        compiler_version: COMPILER_VERSION,
        model_id: envelope.meta.model_id ?? accumulator.modelId,
        model_tier: envelope.meta.model_tier ?? accumulator.modelTier,
        token_usage: { input: accumulator.inputTokens, output: accumulator.outputTokens },
        cost_usd: Math.round(accumulator.costUsd * 1e6) / 1e6,
        latency_ms: Date.now() - startedAt,
        repair_attempts: envelope.meta.repair_attempts ?? accumulator.repairAttempts,
        redactions: accumulator.warnings.some((w) => w.code === A_WARNINGS.W_A_PII_REDACTED) ? 1 : 0,
        cache,
        degraded: envelope.meta.degraded === true,
        fallback_depth: envelope.meta.fallback_depth ?? 0,
        warnings: [...accumulator.warnings, ...(envelope.meta.warnings ?? [])].slice(0, 50),
      },
    };
  }

  private prepareRequest(raw: CompileRequest): CompileRequest {
    const trimmedPrompt = raw.prompt ?? "";
    if (trimmedPrompt.trim().length === 0) {
      throw aError("E_A_PROMPT_EMPTY", "prompt is empty or whitespace only", { instance: `/compile/${raw.site_id}` });
    }
    if (trimmedPrompt.length > MAX_PROMPT_CHARS) {
      // FR-A1 is explicit: over-length input is rejected, not quietly clipped.
      // Truncating would silently compile a different site than the brief
      // describes, and the caller cannot tell from the spec that it happened.
      throw aError(
        "E_A_PROMPT_TOO_LONG",
        `prompt is ${trimmedPrompt.length} characters, limit is ${MAX_PROMPT_CHARS}`,
        { instance: `/compile/${raw.site_id}` },
      );
    }
    return { ...raw, prompt: trimmedPrompt };
  }

  private cacheKeyFor(request: CompileRequest, intent: ReturnType<typeof extractIntent>): string {
    const parts: CacheKeyParts = {
      siteId: request.site_id,
      promptHash: intent.promptHash,
      context: request.context ?? null,
      constraints: request.constraints ?? null,
      options: {
        seed: request.compile_options?.seed ?? intent.seed,
        maxPages: request.constraints?.max_pages ?? 12,
        locale: intent.locale,
      },
    };
    return cacheKey(parts);
  }

  private warn(accumulator: Accumulator, diagnostic: Diagnostic | null): void {
    if (!diagnostic) return;
    if (accumulator.warnings.length < 40) accumulator.warnings.push({ ...diagnostic, source: "A" });
    this.emit(diagnostic);
  }
}

/** Convenience factory: the model-free compiler, used offline and in tests. */
export function createOfflineCompiler(options: Omit<CompilerOptions, "provider"> = {}): SpecCompiler {
  return new SpecCompiler({ ...options, provider: new DeterministicProvider() });
}

/** Factory for a production compiler against an OpenAI-compatible gateway. */
export function createProviderCompiler(options: {
  provider: LlmProvider;
  cacheRoot?: string;
  logger?: MetricLogger;
  deadlineMs?: number;
  onWarning?: (diagnostic: Diagnostic) => void;
}): SpecCompiler {
  return new SpecCompiler({
    provider: options.provider,
    cache: options.cacheRoot ? new FileSpecCache(options.cacheRoot) : new MemorySpecCache(),
    ...(options.logger ? { logger: options.logger } : {}),
    ...(options.deadlineMs !== undefined ? { deadlineMs: options.deadlineMs } : {}),
    ...(options.onWarning ? { onWarning: options.onWarning } : {}),
  });
}

export { FileSpecCache, MemorySpecCache };
