/**
 * OpenAI-compatible chat completions provider.
 *
 * Works against any gateway that speaks `/v1/chat/completions` with optional
 * JSON-schema response format. Uses `fetch` with an argv-free, header-only
 * transport: no shell, no URL built from prompt content (NFR-A17).
 *
 * The API key is read from the environment exactly once and is never included
 * in an error, a log line, or a `ProblemDetails` payload (NFR-A16).
 */

import { extractJsonObject, type LlmCompletion, type LlmInput, type LlmProvider } from "./provider.js";

export interface OpenAiCompatibleOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
  costPer1kInputUsd?: number;
  costPer1kOutputUsd?: number;
  /** Extra headers, e.g. a gateway org id. Must not contain secrets you log. */
  headers?: Record<string, string>;
}

export class LlmRequestError extends Error {
  override readonly name = "LlmRequestError";
  constructor(
    message: string,
    readonly kind: "timeout" | "rate_limited" | "provider_error" | "content_filtered" | "malformed",
    readonly httpStatus?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: { content?: string | null };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string; code?: string; type?: string };
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

export class OpenAiCompatibleProvider implements LlmProvider {
  readonly id = "openai-compatible";
  readonly model: string;
  readonly costPer1kInputUsd: number;
  readonly costPer1kOutputUsd: number;
  private readonly endpoint: string;
  private readonly timeoutMs: number;

  constructor(private readonly options: OpenAiCompatibleOptions) {
    if (!options.apiKey) {
      throw new Error("OpenAiCompatibleProvider requires an API key; supply it via the environment, never in source");
    }
    this.model = options.model;
    this.endpoint = options.baseUrl.replace(/\/+$/, "") + "/chat/completions";
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.costPer1kInputUsd = options.costPer1kInputUsd ?? 0.003;
    this.costPer1kOutputUsd = options.costPer1kOutputUsd ?? 0.012;
  }

  async complete(input: LlmInput): Promise<LlmCompletion> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const onOuterAbort = (): void => controller.abort();
    input.signal?.addEventListener("abort", onOuterAbort, { once: true });
    const startedAt = performance.now();

    try {
      const body: Record<string, unknown> = {
        model: this.model,
        messages: [
          { role: "system", content: input.system },
          { role: "user", content: input.user },
        ],
        max_tokens: input.maxOutputTokens,
        temperature: input.temperature,
      };
      if (input.responseSchema) {
        body["response_format"] = {
          type: "json_schema",
          json_schema: { name: "site_spec", strict: true, schema: input.responseSchema },
        };
      }

      const response = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.options.apiKey}`,
          ...(this.options.headers ?? {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
        if (response.status === 429) {
          throw new LlmRequestError("provider rate limit", "rate_limited", 429, retryAfterMs);
        }
        if (response.status === 408 || response.status === 504) {
          throw new LlmRequestError("provider gateway timeout", "timeout", response.status, retryAfterMs);
        }
        // Read the body for diagnosis but never surface the key.
        const text = await response.text().catch(() => "");
        throw new LlmRequestError(
          `provider returned ${response.status}: ${text.slice(0, 300)}`,
          "provider_error",
          response.status,
          retryAfterMs,
        );
      }

      const payload = (await response.json()) as ChatCompletionResponse;
      if (payload.error) {
        const kind = payload.error.type?.includes("content_filter") ? "content_filtered" : "provider_error";
        throw new LlmRequestError(`provider error: ${payload.error.message ?? "unknown"}`, kind, response.status);
      }
      const choice = payload.choices?.[0];
      const content = choice?.message?.content;
      if (typeof content !== "string" || content.trim().length === 0) {
        throw new LlmRequestError("provider returned an empty completion", "malformed", response.status);
      }

      return {
        text: content,
        usage: {
          inputTokens: payload.usage?.prompt_tokens ?? 0,
          outputTokens: payload.usage?.completion_tokens ?? 0,
        },
        model: this.model,
        finishReason: normalizeFinishReason(choice?.finish_reason),
        latencyMs: Math.round(performance.now() - startedAt),
      };
    } catch (error) {
      if (error instanceof LlmRequestError) throw error;
      if (error instanceof Error && (error.name === "AbortError" || controller.signal.aborted)) {
        throw new LlmRequestError(`model call exceeded ${this.timeoutMs}ms`, "timeout");
      }
      throw new LlmRequestError(
        `model call failed: ${error instanceof Error ? error.message : String(error)}`,
        "provider_error",
      );
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", onOuterAbort);
    }
  }
}

function normalizeFinishReason(reason: string | null | undefined): LlmCompletion["finishReason"] {
  switch (reason) {
    case "stop": return "stop";
    case "length": return "length";
    case "content_filter": return "content_filter";
    default: return "unknown";
  }
}

/**
 * Local file provider used for regression fixtures and offline development.
 * Reads a pre-recorded completion keyed by the user prompt hash.
 */
export class ScriptedProvider implements LlmProvider {
  readonly id = "scripted";
  readonly model = "scripted";
  readonly costPer1kInputUsd = 0;
  readonly costPer1kOutputUsd = 0;

  constructor(private readonly responses: Map<string, string>) {}

  async complete(input: LlmInput): Promise<LlmCompletion> {
    const key = input.user.slice(0, 200);
    const scripted = this.responses.get(key) ?? [...this.responses.values()][0];
    if (!scripted) throw new LlmRequestError("no scripted response available", "malformed");
    const parsed = extractJsonObject(scripted);
    return {
      text: scripted,
      usage: { inputTokens: Math.ceil(input.user.length / 4), outputTokens: Math.ceil(scripted.length / 4) },
      model: this.model,
      finishReason: "stop",
      latencyMs: 0,
    };
  }
}
