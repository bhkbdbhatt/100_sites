/**
 * Content-addressed spec cache (FR-A15).
 *
 * Keyed by everything that can change the output: the sanitized prompt, the
 * context, the constraints, and the compile options that affect generation.
 * The key deliberately excludes the model tier, so a `fast` compile can serve
 * a later `standard` request for the same inputs; what it does not exclude is
 * anything that would make a hit incorrect.
 *
 * Reads verify `spec_hash` (NFR-A13). A corrupt or truncated entry is treated
 * as a miss and re-derived rather than propagated.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { blake3Hex, canonicalize, specHash } from "@pg/spec-schema";
import type { SpecEnvelope } from "./types.js";

export interface CacheKeyParts {
  siteId: string;
  promptHash: string;
  context: unknown;
  constraints: unknown;
  options: { seed: number; maxPages: number; locale: string };
}

export function cacheKey(parts: CacheKeyParts): string {
  return blake3Hex(
    canonicalize({
      v: 1,
      site: parts.siteId,
      prompt: parts.promptHash,
      context: parts.context ?? null,
      constraints: parts.constraints ?? null,
      options: parts.options,
    }),
  ).slice(0, 32);
}

export interface SpecCache {
  get(key: string): Promise<SpecEnvelope | null>;
  put(key: string, envelope: SpecEnvelope): Promise<void>;
  readonly stats: { hits: number; misses: number; writes: number; corrupt: number };
}

export class MemorySpecCache implements SpecCache {
  private readonly entries = new Map<string, SpecEnvelope>();
  readonly stats = { hits: 0, misses: 0, writes: 0, corrupt: 0 };

  async get(key: string): Promise<SpecEnvelope | null> {
    const found = this.entries.get(key);
    if (!found) {
      this.stats.misses += 1;
      return null;
    }
    if (found.meta.spec_hash !== specHash(found.spec)) {
      this.entries.delete(key);
      this.stats.corrupt += 1;
      this.stats.misses += 1;
      return null;
    }
    this.stats.hits += 1;
    return found;
  }

  async put(key: string, envelope: SpecEnvelope): Promise<void> {
    this.entries.set(key, envelope);
    this.stats.writes += 1;
  }

  get size(): number {
    return this.entries.size;
  }
}

/**
 * Filesystem cache. Two-level fanout keeps directory sizes sane at 100k
 * entries; writes go through a temp file + rename so a crash mid-write cannot
 * leave a half-parsed entry that later reads as a corrupt miss.
 */
export class FileSpecCache implements SpecCache {
  readonly stats = { hits: 0, misses: 0, writes: 0, corrupt: 0 };

  constructor(private readonly root: string) {}

  private pathFor(key: string): string {
    return join(this.root, key.slice(0, 2), key.slice(2, 4), key + ".json");
  }

  async get(key: string): Promise<SpecEnvelope | null> {
    try {
      const raw = await readFile(this.pathFor(key), "utf8");
      const parsed = JSON.parse(raw) as SpecEnvelope;
      if (parsed.meta.spec_hash !== specHash(parsed.spec)) {
        this.stats.corrupt += 1;
        this.stats.misses += 1;
        return null;
      }
      this.stats.hits += 1;
      return parsed;
    } catch {
      this.stats.misses += 1;
      return null;
    }
  }

  async put(key: string, envelope: SpecEnvelope): Promise<void> {
    const target = this.pathFor(key);
    await mkdir(dirname(target), { recursive: true });
    const temp = target + "." + process.pid + ".tmp";
    await writeFile(temp, canonicalize(envelope), "utf8");
    await rename(temp, target);
    this.stats.writes += 1;
  }
}
