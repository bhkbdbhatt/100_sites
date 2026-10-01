/** Component C error table (section 4.4). */

import { defineErrors, errorSpec, problem, type ProblemError } from "@pg/spec-schema";

export const C_ERRORS = defineErrors("C", {
  E_C_TEMPLATE_UNSUPPORTED: {
    code: "E_C_TEMPLATE_UNSUPPORTED",
    title: "Template version is outside the adapter's supported range",
    status: 409,
    retryable: false,
  },
  E_C_STORE_UNAVAILABLE: {
    code: "E_C_STORE_UNAVAILABLE",
    title: "Shared dependency store is missing or unreadable",
    status: 503,
    retryable: true,
  },
  E_C_SPEC_INVALID: {
    code: "E_C_SPEC_INVALID",
    title: "Spec failed schema validation inside the adapter",
    status: 422,
    retryable: false,
  },
  E_C_BLOCK_UNSUPPORTED: {
    code: "E_C_BLOCK_UNSUPPORTED",
    title: "A hard-required block has neither a renderer nor a fallback",
    status: 422,
    retryable: false,
  },
  E_C_TEMPLATE_COMPILE: {
    code: "E_C_TEMPLATE_COMPILE",
    title: "SSG build failed",
    status: 500,
    retryable: false,
  },
  E_C_MODULE_RESOLVE: {
    code: "E_C_MODULE_RESOLVE",
    title: "Dependency resolution failed",
    status: 500,
    retryable: true,
  },
  E_C_OUT_OF_MEMORY: {
    code: "E_C_OUT_OF_MEMORY",
    title: "Build exceeded its memory cap",
    status: 500,
    retryable: true,
  },
  E_C_BUDGET_EXCEEDED: {
    code: "E_C_BUDGET_EXCEEDED",
    title: "A hard performance budget was exceeded",
    status: 422,
    retryable: false,
  },
  E_C_A11Y_FAILED: {
    code: "E_C_A11Y_FAILED",
    title: "Accessibility gate hard failure",
    status: 422,
    retryable: false,
  },
  E_C_SECURITY_VIOLATION: {
    code: "E_C_SECURITY_VIOLATION",
    title: "Output contains executable content or an unsafe construct",
    status: 422,
    retryable: false,
  },
  E_C_PATH_ESCAPE: {
    code: "E_C_PATH_ESCAPE",
    title: "An emitted path resolved outside the site root",
    status: 400,
    retryable: false,
  },
  E_C_TIMEOUT: {
    code: "E_C_TIMEOUT",
    title: "Build exceeded its wall-clock timeout",
    status: 504,
    retryable: true,
  },
  E_C_WORKDIR_INVALID: {
    code: "E_C_WORKDIR_INVALID",
    title: "Working directory resolved outside the staging root",
    status: 400,
    retryable: false,
  },
});

export const C_WARNINGS = {
  W_C_BLOCK_DOWNGRADED: "W_C_BLOCK_DOWNGRADED",
  W_C_BLOCK_PROPS_INVALID: "W_C_BLOCK_PROPS_INVALID",
  W_C_PAGE_MISSING: "W_C_PAGE_MISSING",
  W_C_PAGE_UNEXPECTED: "W_C_PAGE_UNEXPECTED",
  W_C_ASSET_DEGRADED: "W_C_ASSET_DEGRADED",
  W_C_ASSET_OFFLINE: "W_C_ASSET_OFFLINE",
  W_C_ASSET_SLOT_UNKNOWN: "W_C_ASSET_SLOT_UNKNOWN",
  W_C_BUDGET_SOFT_EXCEEDED: "W_C_BUDGET_SOFT_EXCEEDED",
  W_C_A11Y_SOFT: "W_C_A11Y_SOFT",
  W_C_INTEGRATION_UNSUPPORTED: "W_C_INTEGRATION_UNSUPPORTED",
  W_C_DETERMINISM_RISK: "W_C_DETERMINISM_RISK",
} as const;

export function cError(
  code: keyof typeof C_ERRORS,
  detail: string,
  extra: { instance?: string; errors?: Array<{ pointer?: string; keyword?: string; message: string }> } = {},
): ProblemError {
  return problem("C", errorSpec(C_ERRORS, code), detail, extra);
}
