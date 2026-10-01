/**
 * LLM provider abstraction.
 *
 * NFR-A4 is the constraint this interface exists to protect: exactly one model
 * call per attempt, so a 100-site batch costs ~100-300 calls rather than the
 * 1,200 a per-page design would need. Nothing in the compiler may issue a
 * per-page request, and `complete()` is the only egress point to a provider.
 */

import type { Diagnostic } from "@pg/spec-schema";
import type { CompileRequest, Intent } from "../types.js";

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface LlmCompletion {
  /** Raw text the provider returned; may be fenced or prose-wrapped. */
  text: string;
  usage: LlmUsage;
  model: string;
  /** Provider-reported finish reason, useful for diagnosing truncation. */
  finishReason?: "stop" | "length" | "content_filter" | "tool_calls" | "unknown";
  latencyMs: number;
}

export interface LlmProvider {
  readonly id: string;
  readonly model: string;
  /**
   * One structured-output call. Implementations must not retry internally;
   * retry policy belongs to the compiler so it can be budgeted against the
   * batch deadline (NFR-A8).
   */
  complete(input: LlmInput): Promise<LlmCompletion>;
  /** Per-1k-token price used by the cost ledger; 0 for local providers. */
  readonly costPer1kInputUsd: number;
  readonly costPer1kOutputUsd: number;
}

export interface LlmInput {
  system: string;
  user: string;
  maxOutputTokens: number;
  temperature: number;
  /** JSON Schema the response must satisfy, when the provider supports it. */
  responseSchema?: unknown;
  /**
   * Opaque, immutable payload for providers that need structured inputs rather
   * than prose (the deterministic synthesizer needs the parsed request, not the
   * prompt). Passed per call, never held on the provider, so implementations
   * stay re-entrant (NFR-A9).
   */
  context?: unknown;
  signal?: AbortSignal;
}

export interface LlmFailure extends Diagnostic {
  kind: "timeout" | "rate_limited" | "provider_error" | "content_filtered" | "budget" | "malformed";
  retryAfterMs?: number;
  httpStatus?: number;
}

/** Extracts the first balanced JSON object from a possibly prose-wrapped reply. */
export function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  const withoutFence = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  const candidates = [withoutFence, trimmed];
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      const slice = sliceFirstObject(candidate);
      if (slice !== null) {
        try {
          return JSON.parse(slice);
        } catch {
          /* try next candidate */
        }
      }
    }
  }
  throw new Error("response contained no parseable JSON object");
}

function sliceFirstObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

export interface TierPricing {
  fast: { model: string; input: number; output: number };
  standard: { model: string; input: number; output: number };
  premium: { model: string; input: number; output: number };
}

export const DEFAULT_PRICING: TierPricing = {
  fast: { model: "small-fast", input: 0.00015, output: 0.0006 },
  standard: { model: "general-1", input: 0.003, output: 0.012 },
  premium: { model: "general-1-large", input: 0.012, output: 0.036 },
};

export function pricingForTier(tier: "fast" | "standard" | "premium"): TierPricing["fast"] {
  return DEFAULT_PRICING[tier];
}

export type { CompileRequest, Intent };
