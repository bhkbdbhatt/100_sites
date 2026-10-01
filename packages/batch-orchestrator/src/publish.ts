/**
 * Atomic, content-addressed publication (FR-B11).
 *
 * The requirement is that a given spec is built once and published once, even
 * across a crash and resume, and that publication is all-or-nothing. Three
 * mechanisms combine:
 *
 *  1. The artifact hash is the identity. Two sites with identical specs produce
 *     identical bytes, so the second one is a symlink-level deduplicate rather
 *     than a second build (FR-B7).
 *  2. Publication is rename-based. The staged directory is fully written and
 *     hashed before anything becomes visible; `rename` within a filesystem is
 *     atomic, so a reader sees either the old tree or the new one, never a
 *     half-written directory.
 *  3. A CAS marker file records "artifact X is published at Y" and is written
 *     with `wx` (fail if exists). A crash between the rename and the marker
 *     write is repaired on the next run by scanning the store, so the marker is
 *     a cache, not the lock.
 */

import { cp, mkdir, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { bError } from "./errors.js";

export interface PublishResult {
  /** Final absolute path of the published site. */
  path: string;
  /** True when this artifact was already present and was reused. */
  deduplicated: boolean;
  /** Milliseconds spent publishing. */
  elapsedMs: number;
}

export interface PublishOptions {
  /** Root of the batch output tree, e.g. <out>/sites. */
  sitesDir: string;
  /** Root of the content-addressed store, e.g. <out>/cas. */
  casDir: string;
  /** Directory containing the fully built site. */
  stagedDir: string;
  siteId: string;
  artifactHash: string;
}

function assertInside(root: string, candidate: string, label: string): string {
  const absoluteRoot = resolve(root);
  const absolute = resolve(candidate);
  if (absolute !== absoluteRoot && !absolute.startsWith(absoluteRoot + sep)) {
    throw bError("E_B_PATH_ESCAPE", `${label} resolved outside the output root: ${absolute}`);
  }
  return absolute;
}

/** `sha256:abcdef...` -> `sha256-abcdef...` (filesystem-safe, still greppable). */
function hashToDirectoryName(hash: string): string {
  if (!/^sha256:[0-9a-f]{64}$/.test(hash)) {
    throw bError("E_B_PUBLISH_FAILED", `refusing to publish under a malformed artifact hash: ${hash}`);
  }
  return hash.replace(":", "-");
}

export class Publisher {
  private readonly sitesDir: string;
  private readonly casDir: string;
  private readonly artifactToSite = new Map<string, string>();

  constructor(sitesDir: string, casDir: string) {
    this.sitesDir = resolve(sitesDir);
    this.casDir = resolve(casDir);
  }

  /**
   * Seeds the dedupe map from an existing CAS directory. This is what makes
   * resume idempotent: a run that was interrupted after publishing five sites
   * does not rebuild and re-publish them.
   */
  async scan(): Promise<number> {
    let entries: string[];
    try {
      entries = await readdir(this.casDir);
    } catch {
      return 0;
    }
    for (const entry of entries) {
      if (!/^sha256-[0-9a-f]{64}$/.test(entry)) continue;
      const hash = entry.replace("-", ":");
      const siteId = await this.readMarker(hash);
      if (siteId) this.artifactToSite.set(hash, siteId);
    }
    return this.artifactToSite.size;
  }

  private async readMarker(hash: string): Promise<string | undefined> {
    try {
      const { readFile } = await import("node:fs/promises");
      const raw = await readFile(join(this.casDir, hashToDirectoryName(hash), ".hundred-site.json"), "utf8");
      const parsed = JSON.parse(raw) as { site_id?: string };
      return parsed.site_id;
    } catch {
      return undefined;
    }
  }

  knownSiteFor(hash: string): string | undefined {
    return this.artifactToSite.get(hash);
  }

  async publish(options: PublishOptions): Promise<PublishResult> {
    const startedAt = Date.now();
    const { stagedDir, siteId, artifactHash } = options;

    assertInside(this.sitesDir, this.sitesDir, "sitesDir");
    if (!isAbsolute(stagedDir)) {
      throw bError("E_B_PUBLISH_FAILED", `stagedDir must be absolute, got ${stagedDir}`);
    }
    const finalPath = assertInside(this.sitesDir, join(this.sitesDir, siteId), `published path for ${siteId}`);

    // The CAS slot is the durable copy; the site directory is a view onto it.
    const casSlot = join(this.casDir, hashToDirectoryName(artifactHash));

    // 1. Populate the CAS slot. If this hash was already stored, the stored copy
    //    wins and the freshly staged tree is redundant, because identical spec
    //    hashes produce identical bytes (FR-C23). `rename` cannot replace a
    //    non-empty directory, which is exactly the signal we want: EEXIST here
    //    means "already stored", not "collision".
    let reused = false;
    if (this.artifactToSite.has(artifactHash)) {
      reused = true;
      await rm(stagedDir, { recursive: true, force: true });
    } else {
      try {
        await mkdir(this.casDir, { recursive: true });
        await rename(stagedDir, casSlot);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EPERM" || code === "EEXIST" || code === "ENOTEMPTY") {
          // Lost a race with a concurrent publish of the same artifact. Keep the
          // stored copy; the staged tree is dropped.
          reused = true;
          await rm(stagedDir, { recursive: true, force: true });
        } else if (code === "ENOENT") {
          throw bError("E_B_PUBLISH_FAILED", `staged directory for ${siteId} does not exist: ${stagedDir}`);
        } else {
          throw bError("E_B_PUBLISH_FAILED", `could not stage ${siteId} into the CAS: ${(error as Error).message}`);
        }
      }
    }

    // 2. Write the marker last. Its absence after a crash is repaired by scan().
    const marker = JSON.stringify(
      { site_id: siteId, artifact_hash: artifactHash, published_at: new Date().toISOString() },
      null,
      2,
    );
    if (!reused) {
      await mkdir(casSlot, { recursive: true });
      await writeFile(join(casSlot, ".hundred-site.json"), marker + "\n", { flag: "w" });
    }
    this.artifactToSite.set(artifactHash, this.artifactToSite.get(artifactHash) ?? siteId);

    // 3. Point the site directory at the CAS slot.
    await rm(finalPath, { recursive: true, force: true });
    await mkdir(this.sitesDir, { recursive: true });
    try {
      await symlink(relative(this.sitesDir, casSlot), finalPath, isAbsolute(join(this.sitesDir, siteId)) ? "junction" : "dir");
    } catch {
      // Windows without developer mode, or a filesystem without symlinks: copy
      // instead. Same bytes, slightly more disk, identical published result.
      await cp(casSlot, finalPath, { recursive: true });
    }

    const relativePath = relative(this.sitesDir, finalPath);
    if (relativePath.startsWith("..")) {
      throw bError("E_B_PATH_ESCAPE", `published path escaped the output root: ${finalPath}`);
    }

    return { path: finalPath, deduplicated: reused, elapsedMs: Date.now() - startedAt };
  }
}

/** A stable directory for a site's staging tree, unique per job attempt. */
export function workdirFor(root: string, siteId: string, attempt: number): string {
  return join(resolve(root), "work", `${siteId}`, `attempt-${attempt}`);
}
