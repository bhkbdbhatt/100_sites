/**
 * RFC 8785 JSON Canonicalization Scheme (JCS).
 *
 * Canonical form is the foundation of every content-addressed decision in the
 * pipeline: `spec_hash` (A -> B join key), `artifact_hash` (B -> CAS key), and
 * the byte-identity guarantee of `dist/` (C). A non-canonical serializer would
 * silently break all three.
 *
 * Rules implemented per RFC 8785 section 3.2:
 *  - object members sorted by key, compared as UTF-16 code unit sequences
 *  - no insignificant whitespace
 *  - minimal string escaping (only ", \, and C0 controls)
 *  - ES6 `Number::toString` serialization, with -0 normalized to "0"
 *  - undefined, functions, symbols, NaN and Infinity are errors, not omissions
 */

export class CanonicalizationError extends Error {
  override readonly name = "CanonicalizationError";
  constructor(message: string, readonly path: string) {
    super(`${message} (at ${path || "<root>"})`);
  }
}

const ESCAPES: Record<string, string> = {
  '"': '\\"',
  "\\": "\\\\",
  "\b": "\\b",
  "\f": "\\f",
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
};

function serializeString(value: string, path: string): string {
  let out = '"';
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    const escape = ESCAPES[ch];
    if (escape !== undefined) {
      out += escape;
    } else if (code < 0x20) {
      out += "\\u" + code.toString(16).padStart(4, "0");
    } else {
      out += ch;
    }
  }
  return out + '"';
}

function serializeNumber(value: number, path: string): string {
  if (!Number.isFinite(value)) {
    throw new CanonicalizationError(`non-finite number ${String(value)} cannot be canonicalized`, path);
  }
  if (Object.is(value, -0)) return "0";
  return String(value);
}

function write(value: unknown, path: string): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      return serializeNumber(value, path);
    case "string":
      return serializeString(value, path);
    case "object":
      break;
    default:
      throw new CanonicalizationError(`value of type ${typeof value} cannot be canonicalized`, path);
  }

  if (Array.isArray(value)) {
    let out = "[";
    for (let i = 0; i < value.length; i += 1) {
      if (i > 0) out += ",";
      const item = value[i];
      if (item === undefined) {
        throw new CanonicalizationError("array hole / undefined is not permitted", `${path}/${i}`);
      }
      out += write(item, `${path}/${i}`);
    }
    return out + "]";
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  let out = "{";
  let written = 0;
  for (const key of keys) {
    const member = record[key];
    if (member === undefined) {
      throw new CanonicalizationError("undefined object member is not permitted", `${path}/${key}`);
    }
    if (written > 0) out += ",";
    out += serializeString(key, path) + ":" + write(member, `${path}/${key}`);
    written += 1;
  }
  return out + "}";
}

/** Canonicalize any JSON-compatible value to its RFC 8785 string form. */
export function canonicalize(value: unknown): string {
  return write(value, "");
}

/** Parse-then-canonicalize round trip, used as a defensive normalization pass. */
export function canonicalizeJson<T = unknown>(json: string): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new CanonicalizationError(
      `input is not valid JSON: ${(error as Error).message}`,
      "",
    );
  }
  return JSON.parse(canonicalize(parsed)) as T;
}
