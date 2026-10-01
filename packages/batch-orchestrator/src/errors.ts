/** Component B error table (section 4.4). */

import { defineErrors, errorSpec, problem, type ProblemError } from "@pg/spec-schema";

export const B_ERRORS = defineErrors("B", {
  E_B_BATCH_INVALID: {
    code: "E_B_BATCH_INVALID",
    title: "BatchJob failed schema validation",
    status: 422,
    retryable: false,
  },
  E_B_DEADLINE_EXCEEDED: {
    code: "E_B_DEADLINE_EXCEEDED",
    title: "The batch deadline passed before all jobs settled",
    status: 504,
    retryable: false,
  },
  E_B_COMPILE_FAILED: {
    code: "E_B_COMPILE_FAILED",
    title: "Component A failed after its repair and fallback budget",
    status: 502,
    retryable: true,
  },
  E_B_BUILD_FAILED: {
    code: "E_B_BUILD_FAILED",
    title: "Component C failed after its fallback budget",
    status: 502,
    retryable: true,
  },
  E_B_RATE_LIMITED: {
    code: "E_B_RATE_LIMITED",
    title: "Provider rate limit",
    status: 429,
    retryable: true,
  },
  E_B_PROVIDER_UNAVAILABLE: {
    code: "E_B_PROVIDER_UNAVAILABLE",
    title: "Model provider is unreachable",
    status: 503,
    retryable: true,
  },
  E_B_PUBLISH_FAILED: {
    code: "E_B_PUBLISH_FAILED",
    title: "Atomic publication failed",
    status: 500,
    retryable: true,
  },
  E_B_STATE_CORRUPT: {
    code: "E_B_STATE_CORRUPT",
    title: "The journal could not be replayed",
    status: 500,
    retryable: false,
  },
  E_B_TEMPLATE_UNAVAILABLE: {
    code: "E_B_TEMPLATE_UNAVAILABLE",
    title: "No adapter satisfies the requested template",
    status: 409,
    retryable: false,
  },
  E_B_BUDGET_EXCEEDED: {
    code: "E_B_BUDGET_EXCEEDED",
    title: "A batch-level budget was exhausted",
    status: 422,
    retryable: false,
  },
  E_B_CONCURRENCY_INVALID: {
    code: "E_B_CONCURRENCY_INVALID",
    title: "Requested concurrency is outside the supported range",
    status: 400,
    retryable: false,
  },
  E_B_PATH_ESCAPE: {
    code: "E_B_PATH_ESCAPE",
    title: "An output path resolved outside the batch root",
    status: 400,
    retryable: false,
  },
  E_B_CANCELLED: {
    code: "E_B_CANCELLED",
    title: "The batch was cancelled",
    status: 499,
    retryable: false,
  },
});

export const B_WARNINGS = {
  W_B_DEGRADED: "W_B_DEGRADED",
  W_B_DEDUPLICATED: "W_B_DEDUPLICATED",
  W_B_RETRY: "W_B_RETRY",
  W_B_FALLBACK: "W_B_FALLBACK",
  W_B_DEADLINE_PRESSURE: "W_B_DEADLINE_PRESSURE",
  W_B_RESUMED: "W_B_RESUMED",
  W_B_THROTTLED: "W_B_THROTTLED",
  W_B_STALE_JOB: "W_B_STALE_JOB",
} as const;

export function bError(
  code: keyof typeof B_ERRORS,
  detail: string,
  extra: { instance?: string; errors?: Array<{ pointer?: string; keyword?: string; message: string }> } = {},
): ProblemError {
  return problem("B", errorSpec(B_ERRORS, code), detail, extra);
}
