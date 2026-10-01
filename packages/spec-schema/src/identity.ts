/**
 * Identity, slug and path-safety primitives.
 *
 * `site_id` is a filesystem path component in three of the four stores we own
 * (workdir, staging, out/). It is therefore validated as a security boundary,
 * not merely as a naming convention (FR-B14, NFR-B18).
 */

import { randomUUID } from "node:crypto";

const SITE_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,60}[a-z0-9])?$/;
const BATCH_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{2,63}$/;

/** Windows reserved device names; checked on every platform for portability. */
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

/** Segments that may never appear as a generated page path component. */
const RESERVED_SEGMENTS = new Set([
  "_",
  "__",
  "api",
  "node_modules",
  "404",
  "500",
  "dist",
  "out",
  "staging",
  "blobs",
  "con",
  "prn",
  "aux",
  "nul",
  "com1",
  "com2",
  "com3",
  "com4",
  "lpt1",
  "lpt2",
  "lpt3",
]);

export function isValidSiteId(value: unknown): value is string {
  return typeof value === "string" && SITE_ID_PATTERN.test(value) && !WINDOWS_DEVICE.test(value);
}

export function isValidBatchId(value: unknown): value is string {
  return typeof value === "string" && BATCH_ID_PATTERN.test(value);
}

const TRANSLITERATE: Record<string, string> = {
  "\u00d8": "O", "\u00f8": "o", "\u00c6": "AE", "\u00e6": "ae", "\u0152": "OE", "\u0153": "oe",
  "\u00df": "ss", "\u00c4": "A", "\u00e4": "a", "\u00d6": "O", "\u00f6": "o",
  "\u00dc": "U", "\u00fc": "u", "\u00e5": "a", "\u00e2": "a", "\u00ee": "i",
  "\u00f4": "o", "\u00fb": "u", "\u00e9": "e", "\u00e8": "e", "\u00ea": "e",
};

/** Characters NFKD cannot decompose, so they need an explicit mapping. */
const TRANSLITERATE_PATTERN = new RegExp(
  "[" + Object.keys(TRANSLITERATE).map((ch) => "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0")).join("") + "]",
  "g",
);

/**
 * Fold arbitrary user text into a URL-safe slug: lowercase, ASCII-transliterated,
 * hyphen separated, truncated to 64 chars, never a reserved segment.
 */
export function slugify(input: string, maxLength = 64): string {
  const folded = input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(TRANSLITERATE_PATTERN, (m) => TRANSLITERATE[m] ?? m)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, Math.max(1, maxLength))
    .replace(/-+$/g, "");
  if (folded.length === 0 || RESERVED_SEGMENTS.has(folded)) {
    return "page-" + (folded.length > 0 ? folded : "x");
  }
  return folded;
}

/** Normalize a page path to a canonical leading-slash, no-trailing-slash form. */
export function normalizePath(input: string): string {
  const trimmed = input.trim();
  const withLeading = trimmed.startsWith("/") ? trimmed : "/" + trimmed;
  const collapsed = withLeading.replace(/\/{2,}/g, "/");
  if (collapsed === "/") return "/";
  return collapsed.replace(/\/+$/, "") || "/";
}

export function pathSegments(input: string): string[] {
  return normalizePath(input)
    .split("/")
    .filter((segment) => segment.length > 0);
}

export function isReservedSegment(segment: string): boolean {
  return RESERVED_SEGMENTS.has(segment.toLowerCase()) || WINDOWS_DEVICE.test(segment);
}

function isAbsoluteLike(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith("/") || value.startsWith("\\\\");
}

/**
 * Resolve `relative` under `root` and refuse anything that escapes.
 * This is the single choke point every filesystem write goes through.
 */
export function resolveWithin(root: string, relative: string): string {
  const normalizedRoot = root.replace(/[\\/]+$/, "");
  const candidate = relative.replace(/\\/g, "/");
  if (isAbsoluteLike(candidate)) {
    throw new Error(`absolute path not permitted under root: ${relative}`);
  }
  const segments: string[] = [];
  for (const segment of candidate.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment.includes("\0")) throw new Error("NUL byte in path");
    if (segment === "..") {
      if (segments.length === 0) {
        throw new Error(`path escapes root: ${relative}`);
      }
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  if (segments.length === 0) return normalizedRoot;
  return [normalizedRoot, ...segments].join("\\");
}

/** Lexicographically sortable, collision-resistant id for events and jobs. */
export function ulid(now = Date.now()): string {
  const time = now.toString(36).padStart(10, "0").slice(-10);
  return time + randomUUID().replace(/-/g, "").slice(0, 16);
}

export function newJobId(siteId: string): string {
  return "job_" + fnv1a(siteId).padStart(7, "0").slice(0, 7) + "_" + randomUUID().slice(0, 8);
}

function fnv1a(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}
