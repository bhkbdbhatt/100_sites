/**
 * Public surface of the orchestrator (FR-B1 - FR-B3).
 */

export { runBatch, buildDefaultsFor, cloudEvent } from "./scheduler.js";
export type { RunBatchOptions, ProgressEvent, BatchEvent } from "./scheduler.js";

export { B_ERRORS, B_WARNINGS, bError } from "./errors.js";

export { Journal, journalPath } from "./journal.js";
export type { JournalOptions } from "./journal.js";

export { Publisher, workdirFor } from "./publish.js";
export type { PublishOptions, PublishResult } from "./publish.js";

export { Semaphore, TokenBucket, CircuitBreaker, backoffDelay, withRetry, withTimeout, delay } from "./concurrency.js";

export { writeReports, toCsv, toMarkdown, summarize } from "./report.js";
export type { ReportOptions } from "./report.js";

export { loadBatchJob, parseBatchYaml } from "./load.js";

export type {
  BatchJob,
  BatchJobPrompt,
  BatchResult,
  BatchTotals,
  JobRecord,
  JobStatus,
  JournalEvent,
  SiteOutcome,
  StageTimings,
} from "./types.js";
