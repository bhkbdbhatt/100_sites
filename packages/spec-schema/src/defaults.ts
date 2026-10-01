/**
 * Schema defaults, resolved in one place.
 *
 * The JSON Schema carries `default` annotations for documentation, but a
 * validator is not an applicator: defaults have to be materialized before
 * validation or a required field that only has a default will be rejected.
 * `withDefaults` applies them by walking the schema alongside the value.
 */

import { batchJobSchema, buildRequestSchema, compileRequestSchema, siteSpecSchema } from "./schemas/index.js";

type Json = Record<string, unknown>;

function isPlainObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function apply(schema: unknown, value: unknown, path: string): unknown {
  if (!isPlainObject(schema)) return value;

  if (value === undefined) {
    const fallback = schema["default"];
    if (fallback !== undefined) return structuredClone(fallback);
    if (schema["type"] === "object") {
      const properties = schema["properties"];
      if (isPlainObject(properties)) {
        const produced: Json = {};
        for (const [key, child] of Object.entries(properties)) {
          const resolved = apply(child, undefined, `${path}/${key}`);
          if (resolved !== undefined) produced[key] = resolved;
        }
        return Object.keys(produced).length > 0 ? produced : undefined;
      }
    }
    return undefined;
  }

  if (Array.isArray(value)) {
    const items = schema["items"];
    if (items === undefined) return value;
    return value.map((entry, index) => apply(items, entry, `${path}/${index}`));
  }

  if (isPlainObject(value)) {
    const properties = isPlainObject(schema["properties"]) ? (schema["properties"] as Json) : {};
    const out: Json = { ...value };
    for (const [key, childSchema] of Object.entries(properties)) {
      const resolved = apply(childSchema, out[key], `${path}/${key}`);
      if (resolved === undefined) delete out[key];
      else out[key] = resolved;
    }
    return out;
  }

  return value;
}

/**
 * Returns a copy of `value` with every schema `default` materialized.
 * Arrays, scalars and unknown keys pass through untouched.
 */
export function withDefaults<T>(schema: unknown, value: unknown): T {
  return apply(schema, value, "") as T;
}

export const CONTRACTS = {
  "compile-request": compileRequestSchema,
  "build-request": buildRequestSchema,
  "batch-job": batchJobSchema,
  "site-spec": siteSpecSchema,
} as const;

export type ContractName = keyof typeof CONTRACTS;

/** Applies defaults for a named top-level contract. */
export function applyContractDefaults(name: ContractName, value: unknown): unknown {
  return withDefaults(CONTRACTS[name], value);
}
