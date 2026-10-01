/**
 * Validation. Single source of truth for all three components.
 *
 * The asymmetry required by section 5.1 is implemented here and nowhere else:
 *
 *   - the *writer* (A) validates strictly: every object node has
 *     `additionalProperties: false`, so a hallucinated key is a hard error.
 *   - the *reader* (B) validates tolerantly: `additionalProperties` is relaxed
 *     to `true` throughout, so an additive minor version from a newer A does
 *     not crash an older B. Fields annotated `x-required: true` are still
 *     enforced by `assertRequiredExtensions`.
 *
 * Version policy: same major -> accept; same major, unknown minor -> accept
 * with W_B_SPEC_VERSION_DRIFT; unknown major -> reject.
 */

import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import ajvFormatsModule from "ajv-formats";
import { SCHEMA_BASE } from "./schemas/common.js";
import {
  batchJobSchema,
  batchResultSchema,
  buildRequestSchema,
  buildResultSchema,
  compileRequestSchema,
  siteSpecSchema,
  specEnvelopeSchema,
} from "./schemas/index.js";
import { defineErrors, errorSpec, problem, type ProblemError } from "./problem.js";

export const SCHEMA_ERRORS = defineErrors("SCHEMA", {
  E_SCHEMA_INVALID: {
    code: "E_SCHEMA_INVALID",
    title: "Document failed schema validation",
    status: 422,
    retryable: false,
  },
  E_SCHEMA_UNKNOWN_MAJOR: {
    code: "E_SCHEMA_UNKNOWN_MAJOR",
    title: "Document declares an incompatible major schema version",
    status: 409,
    retryable: false,
  },
  E_SCHEMA_MISSING_REQUIRED_EXTENSION: {
    code: "E_SCHEMA_MISSING_REQUIRED_EXTENSION",
    title: "Document omits a field marked required across minor versions",
    status: 422,
    retryable: false,
  },
});

export interface ValidationIssue {
  pointer: string;
  keyword: string;
  message: string;
}

export interface ValidationResult<T> {
  valid: boolean;
  value: T;
  issues: ValidationIssue[];
}

/**
 * The *reader* form of a schema: `additionalProperties` relaxed to `true`
 * throughout and the `$id` dropped, so the tolerant copy can be compiled
 * alongside the strict one without colliding in Ajv's registry.
 */
function relax(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(relax);
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, member] of Object.entries(value as Record<string, unknown>)) {
    if (key === "$id" || key === "title" || key === "description") continue;
    if (key === "additionalProperties") {
      out[key] = true;
      continue;
    }
    out[key] = relax(member);
  }
  return out;
}

const addFormats = ajvFormatsModule as unknown as (ajv: unknown) => void;

const ajv = new Ajv2020({ allErrors: true, strict: false, allowUnionTypes: true, validateFormats: true });
addFormats(ajv as never);

ajv.addSchema(siteSpecSchema as never, `${SCHEMA_BASE}/site-spec/1.0.0.json`);
ajv.addSchema(buildRequestSchema as never, `${SCHEMA_BASE}/build-request/1.0.0.json`);
ajv.addSchema(buildResultSchema as never, `${SCHEMA_BASE}/build-result/1.0.0.json`);
ajv.addSchema(batchJobSchema as never, `${SCHEMA_BASE}/batch-job/1.0.0.json`);
ajv.addSchema(batchResultSchema as never, `${SCHEMA_BASE}/batch-result/1.0.0.json`);

const compiled = {
  siteSpec: ajv.compile(siteSpecSchema as never),
  siteSpecTolerant: ajv.compile(relax(siteSpecSchema) as never),
  specEnvelope: ajv.compile(specEnvelopeSchema as never),
  specEnvelopeTolerant: ajv.compile(relax(specEnvelopeSchema) as never),
  compileRequest: ajv.compile(compileRequestSchema as never),
  buildRequest: ajv.compile(buildRequestSchema as never),
  buildRequestTolerant: ajv.compile(relax(buildRequestSchema) as never),
  buildResult: ajv.compile(buildResultSchema as never),
  batchJob: ajv.compile(batchJobSchema as never),
  batchResult: ajv.compile(batchResultSchema as never),
};

export type ValidatorName = keyof typeof compiled;

function toIssues(errors: ErrorObject[] | null | undefined): ValidationIssue[] {
  return (errors ?? []).map((error) => ({
    pointer: error.instancePath === "" ? "/" : error.instancePath,
    keyword: error.keyword,
    message: error.message ?? "invalid",
  }));
}

export function validateWith<T>(name: ValidatorName, value: unknown): ValidationResult<T> {
  const fn = compiled[name] as ValidateFunction<T> & { value?: T };
  const valid = fn(value) as boolean;
  return { valid, value: (fn.value ?? (value as T)) as T, issues: valid ? [] : toIssues(fn.errors) };
}

export class SchemaViolation extends Error {
  override readonly name = "SchemaViolation";
  constructor(
    readonly subject: string,
    readonly issues: ValidationIssue[],
  ) {
    super(`${subject}:${issues.length} schema issue(s); first at ${issues[0]?.pointer} ${issues[0]?.message}`);
  }
}

/** Throws a ProblemError with RFC 9457 detail and a machine-readable error list. */
export function assertWith<T>(name: ValidatorName, value: unknown, subject: string, instance: string): T {
  const result = validateWith<T>(name, value);
  if (!result.valid) {
    throw problem(
      "SCHEMA",
      errorSpec(SCHEMA_ERRORS, "E_SCHEMA_INVALID"),
      `${subject} failed validation (${name}); first: ${result.issues[0]?.pointer} ${result.issues[0]?.message}`,
      { instance, errors: result.issues.slice(0, 25) },
    );
  }
  return result.value;
}

export const validateSiteSpec = <T = unknown>(spec: unknown, tolerant = false): ValidationResult<T> =>
  validateWith<T>(tolerant ? "siteSpecTolerant" : "siteSpec", spec);

export function assertSiteSpec<T = unknown>(spec: unknown, subject = "SiteSpec", instance = "/compile"): T {
  return assertWith<T>("siteSpec", spec, subject, instance);
}

export const validateSpecEnvelope = <T = unknown>(env: unknown, tolerant = false): ValidationResult<T> =>
  validateWith<T>(tolerant ? "specEnvelopeTolerant" : "specEnvelope", env);

export function assertSpecEnvelope<T = unknown>(env: unknown, instance = "/compile"): T {
  return assertWith<T>("specEnvelope", env, "SpecEnvelope", instance);
}

export const validateBuildRequest = <T = unknown>(req: unknown, tolerant = false): ValidationResult<T> =>
  validateWith<T>(tolerant ? "buildRequestTolerant" : "buildRequest", req);

export function assertBuildRequest<T = unknown>(req: unknown, instance = "/build"): T {
  return assertWith<T>("buildRequest", req, "BuildRequest", instance);
}

export const validateBatchJob = <T = unknown>(job: unknown): ValidationResult<T> =>
  validateWith<T>("batchJob", job);

export function assertBatchJob<T = unknown>(job: unknown, instance = "/batch"): T {
  return assertWith<T>("batchJob", job, "BatchJob", instance);
}

export function assertBuildResult<T = unknown>(result: unknown, instance = "/build"): T {
  return assertWith<T>("buildResult", result, "BuildResult", instance);
}

export const validateBatchResult = <T = unknown>(result: unknown): ValidationResult<T> =>
  validateWith<T>("batchResult", result);

/**
 * Version compatibility (section 5.1). Returns null when compatible, or a
 * human-readable reason when the document must be rejected.
 */
export function specVersionIncompatibility(
  declared: string,
  supportedMajor = "1",
): { ok: true; drift: boolean } | { ok: false; reason: string } {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(declared);
  if (!match) return { ok: false, reason: `unparseable spec_version ${JSON.stringify(declared)}` };
  const major = match[1]!;
  if (major !== supportedMajor) {
    return { ok: false, reason: `spec_version major ${major} is not supported (this build speaks ${supportedMajor}.x)` };
  }
  return { ok: true, drift: declared !== "1.0.0" };
}

/** Re-serializes ajv errors into the compact diff fed back to a repairing model. */
export function summarizeIssues(issues: readonly ValidationIssue[], limit = 12): string {
  return issues
    .slice(0, limit)
    .map((issue) => `-${issue.pointer}: ${issue.message} (${issue.keyword})`)
    .join("\n");
}

export type { ProblemError };
