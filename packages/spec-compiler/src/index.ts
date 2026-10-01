export { SpecCompiler, createOfflineCompiler, createProviderCompiler } from "./compiler.js";
export { FileSpecCache, MemorySpecCache, cacheKey } from "./cache.js";
export { DeterministicProvider } from "./llm/deterministic.js";
export { OpenAiCompatibleProvider, ScriptedProvider, LlmRequestError } from "./llm/openai-compatible.js";
export { extractJsonObject, DEFAULT_PRICING } from "./llm/provider.js";
export type { LlmProvider, LlmCompletion, LlmInput } from "./llm/provider.js";
export { extractIntent } from "./intent.js";
export { synthesizeSiteSpec } from "./synthesizer.js";
export { canonicalizeSpec } from "./canonicalize.js";
export { buildDesignTokens, verifyDesignTokens, seededRandom } from "./design.js";
export { contrastRatio, ensureContrast, parseHex, toHex, assertContrast } from "./color.js";
export { buildInitialPrompt, buildRepairPrompt, SYSTEM_PROMPT } from "./prompt.js";
export { A_ERRORS, A_WARNINGS, aError } from "./errors.js";
export { COMPILER_VERSION } from "./types.js";
export type {
  CompileRequest,
  SiteSpec,
  SpecEnvelope,
  SpecProvenance,
  Intent,
  PageSpec,
  ContentBlock,
  AssetSlot,
  DesignTokens,
} from "./types.js";

import { SpecCompiler } from "./compiler.js";
import { DeterministicProvider } from "./llm/deterministic.js";
import { OpenAiCompatibleProvider } from "./llm/openai-compatible.js";
import { FileSpecCache, MemorySpecCache } from "./cache.js";
import { COMPILER_VERSION, type CompileRequest } from "./types.js";
import { A_ERRORS } from "./errors.js";
import { DEFAULT_PRICING, type LlmProvider } from "./llm/provider.js";

export interface CreateCompilerConfig {
  provider?: "openai-compatible" | "deterministic";
  baseUrl?: string;
  model?: string;
  apiKeyEnv?: string;
  cacheDir?: string;
  deadlineMs?: number;
  onWarning?: (diagnostic: { code: string; message: string }) => void;
}

/**
 * Resolves a compiler from environment configuration. The API key is read here
 * and nowhere else, so no other module can accidentally log it (NFR-A16).
 */
export function createCompiler(config: CreateCompilerConfig = {}): SpecCompiler {
  const mode = config.provider ?? "deterministic";
  if (mode === "deterministic") {
    return new SpecCompiler({
      provider: new DeterministicProvider(),
      cache: config.cacheDir ? new FileSpecCache(config.cacheDir) : new MemorySpecCache(),
      ...(config.deadlineMs ? { deadlineMs: config.deadlineMs } : {}),
      ...(config.onWarning ? { onWarning: config.onWarning } : {}),
    });
  }
  const apiKey = process.env[config.apiKeyEnv ?? "HUNDRED_LLM_API_KEY"] ?? "";
  const provider: LlmProvider = new OpenAiCompatibleProvider({
    baseUrl: config.baseUrl ?? process.env["HUNDRED_LLM_BASE_URL"] ?? "https://api.openai.com/v1",
    apiKey,
    model: config.model ?? process.env["HUNDRED_LLM_MODEL"] ?? "gpt-4o-mini",
    costPer1kInputUsd: DEFAULT_PRICING.standard.input,
    costPer1kOutputUsd: DEFAULT_PRICING.standard.output,
  });
  return new SpecCompiler({
    provider,
    cache: config.cacheDir ? new FileSpecCache(config.cacheDir) : new MemorySpecCache(),
    ...(config.deadlineMs ? { deadlineMs: config.deadlineMs } : {}),
    ...(config.onWarning ? { onWarning: config.onWarning } : {}),
  });
}

export { A_ERRORS as ERRORS };
export type { CompileRequest as Request };
