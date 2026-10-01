/** Component A error table (section 2.4). Exhaustive by construction. */

import { defineErrors, errorSpec, problem, type ProblemError } from "@pg/spec-schema";

export const A_ERRORS = defineErrors("A", {
  E_A_PROMPT_EMPTY: {
    code: "E_A_PROMPT_EMPTY",
    title: "Prompt failed validation",
    status: 400,
    retryable: false,
  },
  E_A_PROMPT_TOO_LONG: {
    code: "E_A_PROMPT_TOO_LONG",
    title: "Prompt exceeds the 4000 character limit",
    status: 413,
    retryable: false,
  },
  E_A_PROMPT_UNSAFE: {
    code: "E_A_PROMPT_UNSAFE",
    title: "Prompt contained instruction-shaped content that was neutralized",
    status: 422,
    retryable: false,
    degraded_possible: true,
  },
  E_A_SCHEMA_INVALID: {
    code: "E_A_SCHEMA_INVALID",
    title: "Compiled spec failed schema validation",
    status: 422,
    retryable: false,
    degraded_possible: true,
  },
  E_A_REPAIR_EXHAUSTED: {
    code: "E_A_REPAIR_EXHAUSTED",
    title: "Structured repair attempts exhausted",
    status: 422,
    retryable: false,
    degraded_possible: true,
  },
  E_A_LLM_TIMEOUT: {
    code: "E_A_LLM_TIMEOUT",
    title: "Model provider deadline exceeded",
    status: 504,
    retryable: true,
    degraded_possible: true,
  },
  E_A_RATE_LIMITED: {
    code: "E_A_RATE_LIMITED",
    title: "Model provider rate limit or client-side token bucket exhausted",
    status: 429,
    retryable: true,
    degraded_possible: true,
  },
  E_A_PROVIDER_ERROR: {
    code: "E_A_PROVIDER_ERROR",
    title: "Model provider returned an error",
    status: 502,
    retryable: true,
    degraded_possible: true,
  },
  E_A_CONTENT_FILTERED: {
    code: "E_A_CONTENT_FILTERED",
    title: "Model provider refused the request",
    status: 422,
    retryable: false,
    degraded_possible: true,
  },
  E_A_BUDGET_EXCEEDED: {
    code: "E_A_BUDGET_EXCEEDED",
    title: "Token or cost budget exhausted",
    status: 402,
    retryable: false,
    degraded_possible: true,
  },
  E_A_SPEC_TOO_LARGE: {
    code: "E_A_SPEC_TOO_LARGE",
    title: "Serialized spec exceeds the 1 MiB cap",
    status: 500,
    retryable: false,
    degraded_possible: true,
  },
});

export const A_WARNINGS = {
  W_A_FALLBACK_ENGAGED: "W_A_FALLBACK_ENGAGED",
  W_A_TOKEN_BUDGET_TRUNCATED: "W_A_TOKEN_BUDGET_TRUNCATED",
  W_A_CLAIM_UNVERIFIED: "W_A_CLAIM_UNVERIFIED",
  W_A_INJECTION_NEUTRALIZED: "W_A_INJECTION_NEUTRALIZED",
  W_A_PII_REDACTED: "W_A_PII_REDACTED",
  W_A_PROMPT_TRUNCATED: "W_A_PROMPT_TRUNCATED",
  W_A_BLOCK_PROPS_INVALID: "W_A_BLOCK_PROPS_INVALID",
  W_A_SPEC_VERSION_DRIFT: "W_A_SPEC_VERSION_DRIFT",
} as const;

export function aError(
  code: keyof typeof A_ERRORS,
  detail: string,
  extra: { instance?: string; trace_id?: string; errors?: Array<{ pointer?: string; keyword?: string; message: string }> } = {},
): ProblemError {
  return problem("A", errorSpec(A_ERRORS, code), detail, extra);
}
