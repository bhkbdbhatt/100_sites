/**
 * Model-free provider: runs the deterministic synthesizer as if it were a
 * model response.
 *
 * Two jobs. It is the implementation behind the compiler's fallback ladder
 * (FR-A16, NFR-A11/A12), and it is how the whole pipeline is exercised end to
 * end without network access - a 100-site batch runs offline and produces real
 * output, which is what makes the time budget measurable rather than
 * aspirational.
 *
 * Because it is a provider, the repair path, the token ledger and the cache all
 * see exactly the same code path they see in production.
 */

import { canonicalize } from "@pg/spec-schema";
import { synthesizeSiteSpec } from "../synthesizer.js";
import { extractIntent } from "../intent.js";
import type { CompileRequest } from "../types.js";
import type { LlmCompletion, LlmInput, LlmProvider } from "./provider.js";

export class DeterministicProvider implements LlmProvider {
  readonly id = "deterministic";
  readonly model = "deterministic-synthesizer";
  readonly costPer1kInputUsd = 0;
  readonly costPer1kOutputUsd = 0;

  /**
   * Stateless by construction: the parsed request arrives per call through
   * `input.context` (FR-A16's data path), never on the instance, so a single
   * provider serves every concurrent compile lane (NFR-A9).
   */
  async complete(input: LlmInput): Promise<LlmCompletion> {
    const startedAt = performance.now();
    const context = input.context as { request?: CompileRequest; intent?: ReturnType<typeof extractIntent> } | undefined;
    const request = context?.request;
    if (!request) {
      throw new Error("DeterministicProvider requires input.context.request; call it through SpecCompiler");
    }
    const intent = context?.intent ?? extractIntent(request);
    const { spec, unverifiedClaims } = synthesizeSiteSpec(intent, request);
    const text = canonicalize(spec);
    return {
      text,
      usage: {
        inputTokens: Math.ceil(input.user.length / 4),
        outputTokens: Math.ceil(text.length / 4),
      },
      model: this.model,
      finishReason: unverifiedClaims.length > 0 ? "stop" : "stop",
      latencyMs: Math.round(performance.now() - startedAt),
    };
  }
}
