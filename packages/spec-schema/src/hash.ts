/**
 * Content addressing primitives.
 *
 * `specHash`  - BLAKE3-256 over the canonical form of a SiteSpec, with all
 *               provenance/timestamp fields stripped. This is the join key
 *               between components A, B and C and the cache/dedupe key.
 * `sha256Hex` - SHA-256 over raw bytes, used for the file manifest and the
 *               Merkle artifact root that component B publishes under.
 */

import { createHash } from "node:crypto";
import { blake3 } from "@noble/hashes/blake3";
import { canonicalize } from "./canonical-json.js";

const SPEC_HASH_PREFIX = "blake3:";
const ARTIFACT_HASH_PREFIX = "sha256:";
/**
 * Keys that mark an object as a SpecEnvelope rather than a SiteSpec.
 *
 * `SiteSpec.meta` is required content (title, description, locale, theme) and
 * must be hashed. `SpecEnvelope.meta` is provenance and must not be. The two
 * are distinguished by shape, not by key name.
 */
const PROVENANCE_MARKERS = ["spec_version", "compiler_version", "spec_hash"];

function isEnvelopeLike(value: unknown): value is { spec: unknown; meta: unknown } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (!("spec" in candidate) || !("meta" in candidate)) return false;
  const meta = candidate["meta"];
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return false;
  return PROVENANCE_MARKERS.some((marker) => marker in (meta as Record<string, unknown>));
}

export function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

export function sha256Hex(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * BLAKE3-256 of a UTF-8 string, prefixed for self-describing log output.
 */
export function blake3Hex(input: string | Uint8Array): string {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  return toHex(blake3(bytes));
}

/**
 * BLAKE3 over a JSON value in RFC 8785 canonical form.
 *
 * `stripProvenance` (default true) unwraps a SpecEnvelope so the hash covers
 * only the spec content. Provenance legitimately varies between two runs of the
 * same logical spec (compiler version, timestamps, token counts, repair
 * counts); excluding it is what makes the hash stable across a cache hit and a
 * fresh compile. A SiteSpec passed directly is hashed in full, `meta` included,
 * because two sites with different titles are not the same site.
 */
export function specHash(spec: unknown, options: { stripProvenance?: boolean } = {}): string {
  const { stripProvenance = true } = options;
  const subject = stripProvenance && isEnvelopeLike(spec) ? spec.spec : spec;
  return SPEC_HASH_PREFIX + blake3Hex(canonicalize(subject));
}

export function isSpecHash(value: string): boolean {
  return new RegExp(`^${SPEC_HASH_PREFIX}[0-9a-f]{64}$`).test(value);
}

export function isArtifactHash(value: string): boolean {
  return new RegExp(`^${ARTIFACT_HASH_PREFIX}[0-9a-f]{64}$`).test(value);
}

/**
 * Merkle root over a file manifest. Each leaf is the canonical form of
 * `{ path, bytes, sha256 }`; the root is the SHA-256 of the sorted leaves.
 * Path separators are normalized to "/" so the root is platform independent.
 */
export function merkleRoot(
  files: ReadonlyArray<{ path: string; bytes: number; sha256: string }>,
): string {
  const normalized = files
    .map((file) => ({
      path: file.path.split("\\").join("/"),
      bytes: file.bytes,
      sha256: file.sha256,
    }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const leaves = normalized.map((file) => canonicalize(file));
  return ARTIFACT_HASH_PREFIX + sha256Hex(leaves.join("\n"));
}
