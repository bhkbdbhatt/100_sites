/**
 * RFC 9457 problem details - the single error shape crossing every component
 * boundary. Each producing component owns a namespace of `code` values; the
 * `retryable` flag is the contract that lets the orchestrator's retry policy
 * (FR-B8) be table-driven rather than code paths.
 */

export type Severity = "error" | "warning";

export interface Diagnostic {
  /** Stable, greppable identifier, e.g. `W_C_ASSET_OFFLINE`. */
  code: string;
  severity: Severity;
  message: string;
  /** JSON pointer into the offending document, when applicable. */
  pointer?: string;
  /** Component that raised it: A, B or C. */
  source?: "A" | "B" | "C" | "SCHEMA";
}

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  code: string;
  detail: string;
  instance: string;
  trace_id?: string;
  retryable: boolean;
  degraded_possible?: boolean;
  errors?: Array<{ pointer?: string; keyword?: string; message: string }>;
}

const ERROR_BASE = "https://errors.hundred.local/";

export class PluginError extends Error {
  override readonly name = "PluginError";
  readonly problem: ProblemDetails;

  constructor(problem: ProblemDetails) {
    super(`${problem.code}:${problem.detail}`);
    this.problem = problem;
  }

  get code(): string {
    return this.problem.code;
  }

  get retryable(): boolean {
    return this.problem.retryable;
  }

  toJSON(): ProblemDetails {
    return this.problem;
  }
}

export interface ErrorSpec {
  code: string;
  title: string;
  status: number;
  retryable: boolean;
  degraded_possible?: boolean;
}

/**
 * Declares the error table for a component. Keeping this exhaustive at module
 * load makes "what can this plugin fail with" a compile-time visible property
 * rather than folklore in a catch block.
 */
export function defineErrors(
  component: "A" | "B" | "C" | "SCHEMA",
  table: Record<string, ErrorSpec>,
): Readonly<Record<string, ErrorSpec>> {
  for (const [name, spec] of Object.entries(table)) {
    if (!name.startsWith("E_") && !name.startsWith("W_")) {
      throw new Error(`error code ${name} in component ${component} must start with E_ or W_`);
    }
    if (spec.status < 400 || spec.status > 599) {
      throw new Error(`error code ${name} has non-error status ${spec.status}`);
    }
  }
  return Object.freeze(table);
}

/**
 * Type-safe lookup into a declared error table. `noUncheckedIndexedAccess`
 * makes raw indexing return `ErrorSpec | undefined`; this narrows it, and a
 * missing code is a programming error we want to fail loudly on.
 */
export function errorSpec(
  table: Readonly<Record<string, ErrorSpec>>,
  code: string,
): ErrorSpec {
  const found = table[code];
  if (!found) {
    throw new Error(`error code ${code} is not declared in this component's error table`);
  }
  return found;
}

export function problem(
  component: "A" | "B" | "C" | "SCHEMA",
  spec: ErrorSpec,
  detail: string,
  extra: Partial<ProblemDetails> = {},
): ProblemError {
  return new ProblemError(
    {
      type: ERROR_BASE + spec.code,
      title: spec.title,
      status: spec.status,
      code: spec.code,
      detail,
      instance: extra.instance ?? `/${component.toLowerCase()}`,
      ...(extra.trace_id ? { trace_id: extra.trace_id } : {}),
      retryable: spec.retryable,
      ...(spec.degraded_possible === undefined ? {} : { degraded_possible: spec.degraded_possible }),
      ...(extra.errors ? { errors: extra.errors } : {}),
    },
    component,
  );
}

export class ProblemError extends PluginError {
  constructor(
    problemDetails: ProblemDetails,
    readonly component: "A" | "B" | "C" | "SCHEMA",
  ) {
    super(problemDetails);
  }

  /** Narrowing helper for the orchestrator's retry and fallback ladders. */
  isRetryable(): boolean {
    return this.problem.retryable;
  }

  canDegrade(): boolean {
    return this.problem.degraded_possible === true;
  }
}

export function isProblemError(value: unknown): value is ProblemError {
  return value instanceof PluginError;
}

export function toDiagnostic(error: unknown, fallbackCode: string): Diagnostic {
  if (isProblemError(error)) {
    return {
      code: error.problem.code,
      severity: "error",
      message: error.problem.detail,
      source: error.component,
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { code: fallbackCode, severity: "error", message };
}

/**
 * Normalizes anything thrown - including a plain `Error` from a dependency or
 * a Node system error - into a problem document. Process boundaries (the child
 * runner, the CLI, the orchestrator's worker) use this so an unexpected throw
 * still arrives as a typed, retryable-or-not failure rather than a stack trace.
 */
export function toProblem(
  error: unknown,
  fallbackCode: string,
  instance?: string,
  component: "A" | "B" | "C" | "SCHEMA" = "SCHEMA",
): ProblemDetails {
  if (isProblemError(error)) return error.problem;
  const detail = error instanceof Error ? error.message : String(error);
  return {
    type: ERROR_BASE + fallbackCode,
    title: fallbackCode,
    status: 500,
    code: fallbackCode,
    detail,
    instance: instance ?? `/${component.toLowerCase()}`,
    retryable: false,
  };
}

export function warning(code: string, message: string, pointer?: string): Diagnostic {
  return pointer === undefined
    ? { code, severity: "warning", message }
    : { code, severity: "warning", message, pointer };
}
