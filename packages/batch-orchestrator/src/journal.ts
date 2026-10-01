/**
 * The journal (FR-B10): crash-safe batch state, and the source of truth for
 * "exactly once" publication (FR-B11).
 *
 * Design constraints that shape this file:
 *
 *  - Append-only. Each settled job writes one JSON line. A torn final line is
 *    discarded on replay rather than failing the batch: a half-written record
 *    is exactly the "did not finish" case the retry path already handles.
 *  - fsync on every append before the job is considered done. Without it,
 *    "published" can be true in memory and false on disk after a power loss,
 *    which is the failure mode exactly-once publication exists to prevent.
 *  - Deterministic replay. Replaying a journal yields the same job statuses in
 *    the same order, so resume does not depend on wall-clock or map ordering.
 */

import { appendFile, mkdir, open, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { bError } from "./errors.js";
import type { JobRecord, JobStatus, JournalEvent } from "./types.js";

export interface JournalOptions {
  path: string;
  /** When false, appends skip fsync. Tests only; the batch always fsyncs. */
  durable?: boolean;
}

export class Journal {
  private readonly path: string;
  private readonly durable: boolean;
  private appendCount = 0;

  constructor(options: JournalOptions) {
    this.path = options.path;
    this.durable = options.durable !== false;
  }

  get entries(): number {
    return this.appendCount;
  }

  async init(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, "", { flag: "a" });
  }

  /**
   * Appends one event and (in durable mode) flushes it to stable storage
   * before resolving. The caller may only treat the job as settled after this
   * returns.
   */
  async append(event: JournalEvent): Promise<void> {
    const line = JSON.stringify(event) + "\n";
    await appendFile(this.path, line, "utf8");
    if (this.durable) {
      const handle = await open(this.path, "r+");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
    this.appendCount += 1;
  }

  /** Reads every complete record. A trailing partial line is ignored. */
  async read(): Promise<JournalEvent[]> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw bError("E_B_STATE_CORRUPT", `journal unreadable: ${(error as Error).message}`);
    }
    const events: JournalEvent[] = [];
    const lines = raw.split("\n");
    for (const line of lines) {
      if (line.trim() === "") continue;
      try {
        events.push(JSON.parse(line) as JournalEvent);
      } catch {
        // Torn write from an interrupted process: everything before it is still
        // valid, and the job it described is re-run rather than assumed done.
        break;
      }
    }
    return events;
  }

  /**
   * Replays the journal into per-job state. The last record for a job wins,
   * which makes a sequence of state transitions self-correcting: a job that was
   * started then retried is `running` only if the last record says so.
   */
  async replay(): Promise<{ jobs: Map<string, JobRecord>; published: Map<string, string>; resumedFrom: string | null }> {
    const events = await this.read();
    const jobs = new Map<string, JobRecord>();
    const published = new Map<string, string>();

    for (const event of events) {
      switch (event.type) {
        case "batch_started": {
          jobs.clear();
          published.clear();
          break;
        }
        case "job_started": {
          const previous = jobs.get(event.job_id);
          jobs.set(event.job_id, {
            job_id: event.job_id,
            site_id: event.site_id,
            prompt: previous?.prompt ?? "",
            index: previous?.index ?? -1,
            status: "running",
            attempts: previous?.attempts ?? 0,
            fallback_depth: previous?.fallback_depth ?? 0,
            started_at: event.at,
          });
          break;
        }
        case "job_settled": {
          const previous = jobs.get(event.job_id);
          jobs.set(event.job_id, {
            job_id: event.job_id,
            site_id: event.site_id,
            prompt: previous?.prompt ?? "",
            index: previous?.index ?? -1,
            status: event.status,
            attempts: event.attempts,
            fallback_depth: event.fallback_depth,
            started_at: previous?.started_at ?? event.at,
            settled_at: event.at,
            ...(event.site_id ? {} : {}),
            ...(event.status === "built" || event.status === "built_degraded" || event.status === "deduplicated"
              ? { spec_hash: event.spec_hash, artifact_hash: event.artifact_hash, out_dir: event.out_dir }
              : {}),
            ...(event.warnings ? { warnings: event.warnings } : {}),
            ...(event.error ? { error: event.error } : {}),
            ...(event.stages ? { stages: event.stages } : {}),
            ...(event.pages !== undefined ? { pages: event.pages } : {}),
            ...(event.total_bytes !== undefined ? { total_bytes: event.total_bytes } : {}),
          });
          if (event.artifact_hash) published.set(event.artifact_hash, event.site_id);
          break;
        }
        case "job_skipped": {
          const previous = jobs.get(event.job_id);
          jobs.set(event.job_id, {
            job_id: event.job_id,
            site_id: event.site_id,
            prompt: previous?.prompt ?? "",
            index: previous?.index ?? -1,
            status: "skipped",
            attempts: previous?.attempts ?? 0,
            fallback_depth: previous?.fallback_depth ?? 0,
            started_at: previous?.started_at ?? event.at,
            settled_at: event.at,
          });
          break;
        }
        case "batch_finished": {
          break;
        }
      }
    }

    const lastStarted = [...events].reverse().find((event) => event.type === "batch_started");
    return { jobs, published, resumedFrom: lastStarted && lastStarted.type === "batch_started" ? lastStarted.batch_id : null };
  }

  /** Job ids still needing work: never started, or started without a settle. */
  static pendingJobs(jobs: Map<string, JobRecord>, allJobIds: string[]): string[] {
    return allJobIds.filter((jobId) => {
      const record = jobs.get(jobId);
      return !record || record.status === "running";
    });
  }
}

export function journalPath(batchRoot: string, batchId: string): string {
  return join(batchRoot, "journal", `${batchId}.ndjson`);
}

export type { JobStatus };
