/** Component B wire types: BatchJob in, BatchResult out, plus the journal's records. */

import type { AssetSlot, SiteSpec, SpecEnvelope } from "@pg/spec-compiler";
import type { Diagnostic, ProblemDetails } from "@pg/spec-schema";

export type JobStatus = "pending" | "running" | "built" | "built_degraded" | "deduplicated" | "failed" | "skipped";

export interface StageTimings {
  compile_ms: number;
  install_ms: number;
  build_ms: number;
  assets_ms: number;
  publish_ms: number;
}

export interface JobRecord {
  job_id: string;
  site_id: string;
  prompt: string;
  index: number;
  status: JobStatus;
  attempts: number;
  fallback_depth: number;
  started_at: string;
  settled_at?: string;
  spec_hash?: string;
  artifact_hash?: string;
  out_dir?: string;
  warnings?: string[];
  error?: ProblemDetails;
  stages?: StageTimings;
  pages?: number;
  total_bytes?: number;
}

export interface BatchJobPrompt {
  site_id: string;
  prompt: string;
  constraints?: {
    template?: string;
    ssg_target?: "astro" | "zola" | "eleventy";
    max_pages?: number;
    required_sections?: string[];
    banned_sections?: string[];
    integrations?: Array<"rss" | "analytics" | "newsletter" | "cms" | "i18n">;
  };
  context?: {
    brand?: { name?: string; tagline?: string; colors?: string[]; logo_slot?: string };
    audience?: string;
    locale?: string;
    keywords?: string[];
    references?: string[];
  };
}

/**
 * BatchJob as written in `batch.yaml`. Field names follow the published
 * batchJobSchema so a manifest validates against the shared contract without a
 * translation layer.
 */
export interface BatchJob {
  batch_id: string;
  tenant?: string;
  template: string;
  prompts: BatchJobPrompt[];
  /** Merged over each prompt's own constraints; a prompt may only narrow these. */
  defaults?: Omit<BatchJobPrompt, "site_id" | "prompt" | "context">;
  policies?: {
    max_attempts?: number;
    retry_backoff_ms?: number[];
    site_timeout_ms?: number;
    /** Wall-clock budget for the whole batch. Enforced, not advisory. */
    deadline_ms?: number;
    fail_policy?: "continue" | "halt";
    fallback_enabled?: boolean;
    stale_after_ms?: number;
    breaker_threshold?: number;
    breaker_window_ms?: number;
  };
  concurrency?: {
    max_parallel_builds?: number;
    max_parallel_compiles?: number;
    max_queue_depth?: number;
    per_build_memory_mb?: number;
  };
  /** Per-batch overrides for component C. */
  build?: {
    /** Driver for component C. The static emitter is hermetic and the default. */
    ssg?: "astro" | "static";
    asset_resolver?: "auto" | "local" | "remote" | "placeholder";
    budgets?: {
      max_bundle_kb?: number;
      max_pages?: number;
      max_build_ms?: number;
      max_lcp_ms?: number;
      max_cls?: number;
      hard?: boolean;
    };
  };
  output?: {
    dest?: string;
    per_site_dir?: string;
    archive?: boolean;
    archive_format?: "zip" | "tar.gz";
    artifact_store?: string;
    staging?: string;
    work?: string;
    /** Keep each job's staging tree after publication. Off by default. */
    keep_workdir?: boolean;
    report_formats?: Array<"csv" | "json" | "markdown" | "timeline" | "gantt">;
    network_allowlist?: string[];
  };
  network?: { offline?: boolean; allowlist?: string[] };
  liveness?: {
    provider?: "openai-compatible" | "deterministic";
    model_id?: string;
    base_url?: string;
    api_key_env?: string;
    max_concurrent_requests?: number;
    requests_per_minute?: number;
    max_tokens_per_minute?: number;
    request_timeout_ms?: number;
    max_cost_usd?: number;
  };
}

export interface SiteOutcome {
  site_id: string;
  status: "built" | "built_degraded" | "deduplicated" | "failed" | "skipped";
  degraded?: boolean;
  spec_hash?: string;
  artifact_hash?: string;
  stages: StageTimings;
  attempts: number;
  fallback_depth: number;
  pages?: number;
  total_bytes?: number;
  largest_bundle_kb?: number;
  external_js_kb?: number;
  cost_usd?: number;
  warnings?: string[];
  error?: ProblemDetails | null;
}

export interface BatchTotals {
  requested: number;
  built: number;
  built_degraded: number;
  deduplicated: number;
  failed: number;
  skipped: number;
  pages: number;
  total_bytes: number;
  cost_usd: number;
  wall_ms: number;
  /** Wall time of the longest single job; the batch cannot be faster than this. */
  critical_path_ms: number;
}

export interface BatchResult {
  batch_id: string;
  status: "completed" | "completed_with_failures" | "aborted_deadline" | "aborted_budget" | "cancelled";
  template: string;
  started_at: string;
  finished_at: string;
  sites: SiteOutcome[];
  totals: BatchTotals;
  warnings: Diagnostic[];
  resumed_from?: string;
}

export type JournalEvent =
  | { type: "batch_started"; batch_id: string; at: string; prompts: number; resumed_from?: string }
  | { type: "job_started"; job_id: string; site_id: string; index: number; at: string; attempt: number }
  | {
      type: "job_settled";
      job_id: string;
      site_id: string;
      status: JobStatus;
      attempts: number;
      fallback_depth: number;
      at: string;
      spec_hash?: string;
      artifact_hash?: string;
      out_dir?: string;
      warnings?: string[];
      error?: ProblemDetails;
      stages?: StageTimings;
      pages?: number;
      total_bytes?: number;
    }
  | { type: "job_skipped"; job_id: string; site_id: string; reason: string; at: string }
  | { type: "batch_finished"; batch_id: string; status: BatchResult["status"]; at: string };

export type { SiteSpec, SpecEnvelope, AssetSlot };
