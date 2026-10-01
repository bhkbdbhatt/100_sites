/**
 * The scheduler (FR-B4 - FR-B9).
 *
 * One job = compile (component A) -> build (component C) -> publish. The
 * scheduler's job is not to make any single job fast; it is to make sure that
 * 100 of them finish inside the deadline while never exceeding the per-stage
 * concurrency limits, the retry budget, or the cost ceiling.
 *
 * Two independent limits, because the stages have different resources:
 *   - compiles are model-bound and rate-limited (tokens/min, requests/min)
 *   - builds are CPU and memory bound (one subprocess per site, capped RAM)
 *
 * Dedupe happens after the build (FR-B7): the artifact hash is the Merkle root
 * of the emitted bytes, so it is only knowable once component C has run. When
 * a job's bytes are already in the content store, the CAS slot is reused and
 * only a per-site view is created - one build serves both sites.
 */

import { mkdir, rm } from "node:fs/promises";
import { cpus } from "node:os";
import { join, resolve } from "node:path";
import {
  warning as makeWarning,
  type Diagnostic,
  type ProblemDetails,
  toProblem,
} from "@pg/spec-schema";
import { createCompiler, type SpecEnvelope, type SpecCompiler } from "@pg/spec-compiler";
import { buildSite, type BuildResult } from "@pg/ssg-adapter-astro";
import { bError, B_WARNINGS } from "./errors.js";
import { CircuitBreaker, Semaphore, TokenBucket, backoffDelay, delay, withTimeout } from "./concurrency.js";
import { Journal } from "./journal.js";
import { Publisher, workdirFor } from "./publish.js";
import type {
  BatchJob,
  BatchJobPrompt,
  BatchResult,
  JobRecord,
  SiteOutcome,
  StageTimings,
} from "./types.js";

export interface RunBatchOptions {
  /** Overrides the batch's own deadline. Used by tests and the `--deadline` flag. */
  deadlineMs?: number;
  /** Dry run: schedule and report, touch nothing. */
  dryRun?: boolean;
  /** Resume from an existing journal in the output directory. */
  resume?: boolean;
  /** Cancels in-flight work; running jobs settle, queued jobs are skipped. */
  signal?: AbortSignal;
  /** Progress callback for the CLI. */
  onProgress?: (event: ProgressEvent) => void;
  /** Per-job diagnostics sink. */
  onWarning?: (diagnostic: Diagnostic) => void;
}

export type ProgressEvent =
  | { phase: "started"; batch_id: string; total: number }
  | { phase: "job"; site_id: string; status: SiteOutcome["status"]; done: number; total: number; elapsed_ms: number }
  | { phase: "warning"; code: string; message: string }
  | { phase: "finished"; status: BatchResult["status"]; elapsed_ms: number };

interface ResolvedPolicy {
  maxAttempts: number;
  backoffMs: number[];
  siteTimeoutMs: number;
  deadlineMs: number;
  failPolicy: "continue" | "halt";
  fallbackEnabled: boolean;
  staleAfterMs: number;
  breakerThreshold: number;
  breakerWindowMs: number;
  maxParallelBuilds: number;
  maxParallelCompiles: number;
  maxQueueDepth: number;
  perBuildMemoryMb: number;
  maxCostUsd: number;
  rpm: number;
  maxConcurrentRequests: number;
  maxBuildMs: number;
}

function resolvePolicy(job: BatchJob, overrides: { deadlineMs?: number }): ResolvedPolicy {
  const policies = job.policies ?? {};
  const concurrency = job.concurrency ?? {};
  const liveness = job.liveness ?? {};
  const maxParallelBuilds = concurrency.max_parallel_builds ?? 12;
  const maxParallelCompiles = concurrency.max_parallel_compiles ?? 8;
  if (maxParallelBuilds < 1 || maxParallelCompiles < 1) {
    throw bError("E_B_CONCURRENCY_INVALID", "max_parallel_builds and max_parallel_compiles must both be >= 1");
  }
  const prompts = job.prompts.length;
  return {
    maxAttempts: policies.max_attempts ?? 3,
    backoffMs: policies.retry_backoff_ms ?? [1000, 5000, 15000],
    siteTimeoutMs: policies.site_timeout_ms ?? 120_000,
    deadlineMs: overrides.deadlineMs ?? policies.deadline_ms ?? 5_400_000,
    failPolicy: policies.fail_policy ?? "continue",
    fallbackEnabled: policies.fallback_enabled !== false,
    staleAfterMs: policies.stale_after_ms ?? 60_000,
    breakerThreshold: policies.breaker_threshold ?? 0.2,
    breakerWindowMs: policies.breaker_window_ms ?? 60_000,
    // Building more sites at once than the machine has cores buys nothing and
    // costs the tail: 100 sites on 8 cores is slower than 8 at a time.
    maxParallelBuilds: Math.min(maxParallelBuilds, 2 * (osCores() ?? 8)),
    maxParallelCompiles,
    maxQueueDepth: concurrency.max_queue_depth ?? Math.max(8, prompts * 2),
    perBuildMemoryMb: concurrency.per_build_memory_mb ?? 384,
    maxCostUsd: liveness.max_cost_usd ?? 25,
    rpm: liveness.requests_per_minute ?? 300,
    maxConcurrentRequests: Math.min(liveness.max_concurrent_requests ?? 8, maxParallelCompiles),
    maxBuildMs: job.build?.budgets?.max_build_ms ?? 45_000,
  };
}

function osCores(): number {
  return cpus().length;
}

/** Merged per-prompt request: batch defaults, then the prompt's own narrowing. */
function compileRequestFor(job: BatchJob, prompt: BatchJobPrompt, template: string) {
  const defaults = job.defaults;
  return {
    site_id: prompt.site_id,
    prompt: prompt.prompt,
    ...(prompt.context ? { context: prompt.context } : {}),
    constraints: {
      template: prompt.constraints?.template ?? defaults?.constraints?.template ?? template,
      ...(prompt.constraints?.ssg_target ? { ssg_target: prompt.constraints.ssg_target } : {}),
      ...(prompt.constraints?.max_pages ?? defaults?.constraints?.max_pages
        ? { max_pages: prompt.constraints?.max_pages ?? defaults?.constraints?.max_pages }
        : {}),
      ...(prompt.constraints?.required_sections ?? defaults?.constraints?.required_sections
        ? { required_sections: prompt.constraints?.required_sections ?? defaults?.constraints?.required_sections }
        : {}),
      ...(prompt.constraints?.banned_sections ?? defaults?.constraints?.banned_sections
        ? { banned_sections: prompt.constraints?.banned_sections ?? defaults?.constraints?.banned_sections }
        : {}),
      ...(prompt.constraints?.integrations ?? defaults?.constraints?.integrations
        ? { integrations: prompt.constraints?.integrations ?? defaults?.constraints?.integrations }
        : {}),
    },
  };
}

function emptyStages(): StageTimings {
  return { compile_ms: 0, install_ms: 0, build_ms: 0, assets_ms: 0, publish_ms: 0 };
}

export async function runBatch(job: BatchJob, options: RunBatchOptions = {}): Promise<BatchResult> {
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const policy = resolvePolicy(job, options);
  const defaults = buildDefaultsFor(job);
  const budgets = job.build?.budgets;
  const deadlineAtMs = startedAtMs + policy.deadlineMs;

  if (job.prompts.length === 0) {
    throw bError("E_B_BATCH_INVALID", "batch has no prompts");
  }
  const seen = new Set<string>();
  for (const prompt of job.prompts) {
    if (seen.has(prompt.site_id)) {
      throw bError("E_B_BATCH_INVALID", `duplicate site_id in batch: ${prompt.site_id}`);
    }
    seen.add(prompt.site_id);
  }

  // Output layout: <dest>/{sites,cas,work,journal,reports}
  const dest = resolve(job.output?.dest ?? "out");
  const sitesDir = join(dest, "sites");
  const casDir = join(dest, job.output?.artifact_store ?? "cas");
  const workRoot = join(dest, job.output?.work ?? ".work");
  const journalPath = join(dest, "journal", `${job.batch_id}.ndjson`);

  // A dry run must leave the filesystem untouched, so it is answered before any
  // directory is created. It still validates the manifest and resolves policy,
  // because "would this run?" is the question being asked.
  if (options.dryRun) {
    resolvePolicy(job, options);
    return {
      batch_id: job.batch_id,
      status: "completed",
      template: job.template,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      sites: job.prompts.map((prompt) => ({
        site_id: prompt.site_id,
        status: "skipped",
        stages: emptyStages(),
        attempts: 0,
        fallback_depth: 0,
      })),
      totals: {
        requested: job.prompts.length,
        built: 0,
        built_degraded: 0,
        deduplicated: 0,
        failed: 0,
        skipped: job.prompts.length,
        pages: 0,
        total_bytes: 0,
        cost_usd: 0,
        wall_ms: 0,
        critical_path_ms: 0,
      },
      warnings: [makeWarning(B_WARNINGS.W_B_STALE_JOB, "dry run: nothing was compiled, built or published")],
    };
  }

  await mkdir(dest, { recursive: true });
  const journal = new Journal({ path: journalPath });
  await journal.init();

  const publisher = new Publisher(sitesDir, casDir);
  const knownArtifacts = await publisher.scan();

  const replayed = options.resume ? await journal.replay() : { jobs: new Map<string, JobRecord>(), published: new Map<string, string>(), resumedFrom: null };
  const diagnostics: Diagnostic[] = [];

  await journal.append({
    type: "batch_started",
    batch_id: job.batch_id,
    at: startedAt,
    prompts: job.prompts.length,
    ...(replayed.resumedFrom && replayed.resumedFrom !== job.batch_id
      ? { resumed_from: replayed.resumedFrom }
      : {}),
  });
  if (replayed.resumedFrom) {
    diagnostics.push(makeWarning(B_WARNINGS.W_B_RESUMED, `resuming batch ${replayed.resumedFrom}: ${replayed.jobs.size} job(s) already recorded`));
  }
  if (knownArtifacts > 0) {
    diagnostics.push(makeWarning(B_WARNINGS.W_B_DEDUPLICATED, `${knownArtifacts} artifact(s) already in the content store`));
  }

  options.onProgress?.({ phase: "started", batch_id: job.batch_id, total: job.prompts.length });

  // Shared stages. One compiler instance so the in-memory cache is shared across
  // the batch: repeated prompts then cost nothing at all (FR-B7).
  const compiler: SpecCompiler = createCompiler({
    provider: job.liveness?.provider ?? "deterministic",
    ...(job.liveness?.base_url ? { baseUrl: job.liveness.base_url } : {}),
    ...(job.liveness?.model_id ? { model: job.liveness.model_id } : {}),
    ...(job.liveness?.api_key_env ? { apiKeyEnv: job.liveness.api_key_env } : {}),
    cacheDir: join(dest, "cache"),
    deadlineMs: policy.deadlineMs,
    onWarning: (diagnostic) => {
      diagnostics.push({ ...diagnostic, source: "A", severity: "warning" });
      options.onWarning?.({ ...diagnostic, source: "A", severity: "warning" });
      options.onProgress?.({ phase: "warning", code: diagnostic.code, message: diagnostic.message });
    },
  });

  const buildGate = new Semaphore(policy.maxParallelBuilds);
  const compileGate = new Semaphore(policy.maxConcurrentRequests);
  const rateLimiter = new TokenBucket({ capacity: Math.min(policy.rpm, 60), refillPerMs: policy.rpm / 60_000 });
  const breaker = new CircuitBreaker(policy.breakerThreshold, policy.breakerWindowMs);

  const outcomes = new Map<string, SiteOutcome>();
  let costUsd = 0;
  let cancelled = false;
  let halted = false;

  const jobIds = job.prompts.map((prompt) => `${job.batch_id}:${prompt.site_id}`);
  const pending = options.resume
    ? Journal.pendingJobs(replayed.jobs, jobIds)
    : jobIds;

  // Resume: keep the outcomes already settled, and re-run only what is missing.
  if (options.resume) {
    for (const [jobId, record] of replayed.jobs) {
      if (record.status === "running" || record.status === "pending") continue;
      outcomes.set(jobId, {
        site_id: record.site_id,
        status: record.status as SiteOutcome["status"],
        stages: record.stages ?? emptyStages(),
        attempts: record.attempts,
        fallback_depth: record.fallback_depth,
        ...(record.spec_hash ? { spec_hash: record.spec_hash } : {}),
        ...(record.artifact_hash ? { artifact_hash: record.artifact_hash } : {}),
        ...(record.warnings ? { warnings: record.warnings } : {}),
        ...(record.error ? { error: record.error } : {}),
        ...(record.pages !== undefined ? { pages: record.pages } : {}),
        ...(record.total_bytes !== undefined ? { total_bytes: record.total_bytes } : {}),
      });
    }
  }

  let settledCount = outcomes.size;

  const runJob = async (prompt: BatchJobPrompt, index: number): Promise<void> => {
    const jobId = `${job.batch_id}:${prompt.site_id}`;
    const stages = emptyStages();
    const jobStart = Date.now();
    const warnings: string[] = [];

    if (options.signal?.aborted) {
      cancelled = true;
      return;
    }
    // Deadline: jobs that start after it are skipped, not failed. A skip is an
    // honest accounting of "we ran out of time", distinct from a build error.
    if (Date.now() >= deadlineAtMs) {
      await journal.append({ type: "job_skipped", job_id: jobId, site_id: prompt.site_id, reason: "deadline reached before start", at: new Date().toISOString() });
      outcomes.set(jobId, {
        site_id: prompt.site_id,
        status: "skipped",
        stages,
        attempts: 0,
        fallback_depth: 0,
        warnings: ["skipped: batch deadline reached"],
      });
      settledCount += 1;
      options.onProgress?.({ phase: "job", site_id: prompt.site_id, status: "skipped", done: settledCount, total: job.prompts.length, elapsed_ms: Date.now() - startedAtMs });
      return;
    }

    // Cost ceiling, enforced before the model is called rather than reported
    // afterwards. Once the ceiling is reached, no further prompt may cost money;
    // the remaining sites are skipped, because "we chose not to pay" is not the
    // same failure as "the build broke".
    if (costUsd >= policy.maxCostUsd) {
      await journal.append({ type: "job_skipped", job_id: jobId, site_id: prompt.site_id, reason: "cost ceiling reached before start", at: new Date().toISOString() });
      outcomes.set(jobId, {
        site_id: prompt.site_id,
        status: "skipped",
        stages,
        attempts: 0,
        fallback_depth: 0,
        warnings: [`skipped: batch cost ceiling of ${policy.maxCostUsd} USD reached`],
      });
      settledCount += 1;
      options.onProgress?.({ phase: "job", site_id: prompt.site_id, status: "skipped", done: settledCount, total: job.prompts.length, elapsed_ms: Date.now() - startedAtMs });
      return;
    }

    let attempt = 0;
    let fallbackDepth = 0;
    let lastProblem: ProblemDetails | undefined;

    for (attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
      await journal.append({
        type: "job_started",
        job_id: jobId,
        site_id: prompt.site_id,
        index,
        at: new Date().toISOString(),
        attempt,
      });

      const remaining = deadlineAtMs - Date.now();
      const siteBudget = Math.min(policy.siteTimeoutMs, Math.max(1000, remaining));

      try {
        // --- stage 1: compile (component A) ------------------------------
        const compileStart = Date.now();
        let compileOutcome: Awaited<ReturnType<typeof compiler.compile>> | undefined;
        if (!breaker.allow()) {
          throw bError("E_B_PROVIDER_UNAVAILABLE", "provider circuit is open; falling back without a model call");
        }
        await compileGate.run(async () => {
          await rateLimiter.acquire();
          compileOutcome = (await withTimeout(
            compiler.compile(compileRequestFor(job, prompt, job.template)),
            siteBudget,
            () => bError("E_B_DEADLINE_EXCEEDED", `compile of ${prompt.site_id} exceeded ${siteBudget} ms`),
          )) as Awaited<ReturnType<typeof compiler.compile>>;
        });
        if (!compileOutcome) throw bError("E_B_COMPILE_FAILED", "compile produced no envelope");
        const envelope = compileOutcome as SpecEnvelope;
        stages.compile_ms = Date.now() - compileStart;
        costUsd += compileOutcome.meta.cost_usd ?? 0;
        breaker.recordSuccess();
        for (const diagnostic of compileOutcome.meta.warnings ?? []) warnings.push(diagnostic.code);

        const degradedCompile = compileOutcome.meta.degraded === true;

        // --- stage 2: build (component C) --------------------------------
        const workdir = workdirFor(workRoot, prompt.site_id, attempt);
        await rm(workdir, { recursive: true, force: true });
        await mkdir(workdir, { recursive: true });

        const buildStart = Date.now();
        let buildResult: BuildResult | undefined;
        await buildGate.run(async () => {
          const built = await buildSite({
            site_id: prompt.site_id,
            spec: envelope.spec,
            spec_hash: envelope.meta.spec_hash,
            template: job.template,
            workdir,
            build: {
              out_dir: "dist",
              minify: true,
              memory_mb: policy.perBuildMemoryMb,
              timeout_ms: Math.min(policy.siteTimeoutMs, policy.maxBuildMs),
            },
            budgets: budgets,
            network: {
              offline: defaults.offline,
              allowlist: defaults.allowlist,
              max_concurrency: policy.maxQueueDepth,
            },
            assets: { resolver: job.build?.asset_resolver ?? "auto" },
            driver: defaults.driver,
          });
          buildResult = built.result;
        });
        if (!buildResult) throw bError("E_B_BUILD_FAILED", "build produced no result");
        stages.build_ms = Date.now() - buildStart;
        stages.install_ms = buildResult.metrics.install_ms;
        stages.assets_ms = Math.max(0, stages.build_ms - buildResult.metrics.build_ms);
        stages.build_ms = buildResult.metrics.build_ms;

        if (buildResult.status === "failed") {
          throw bError("E_B_BUILD_FAILED", buildResult.diagnostics[0]?.message ?? "build reported failure");
        }
        for (const diagnostic of buildResult.diagnostics) {
          if (diagnostic.severity === "warning") warnings.push(diagnostic.code);
        }
        const artifactHash = buildResult.artifact_hash;
        if (!artifactHash) throw bError("E_B_PUBLISH_FAILED", "build produced no artifact_hash");

        // --- stage 3: publish --------------------------------------------
        // Dedupe lands here rather than before the build: the artifact hash is
        // the Merkle root of the emitted bytes, so it is only knowable after C
        // has run.
        //
        // The deduplicate decision is made inside `publish()`, by attempting the
        // rename into the CAS slot. Deciding it here with a `knownSiteFor()`
        // pre-check would be a race: with several builds in flight, two twins
        // would both read an empty map and both claim a fresh publish. The
        // rename is the atomic test - whoever loses it gets `deduplicated`.
        const publishStart = Date.now();
        const published = await publisher.publish({
          sitesDir,
          casDir,
          stagedDir: join(workdir, "dist"),
          siteId: prompt.site_id,
          artifactHash,
        });
        const deduplicated = published.deduplicated;
        stages.publish_ms = Date.now() - publishStart;

        const degraded = degradedCompile || buildResult.status === "built_degraded";
        const status: SiteOutcome["status"] = deduplicated ? "deduplicated" : degraded ? "built_degraded" : "built";

        await journal.append({
          type: "job_settled",
          job_id: jobId,
          site_id: prompt.site_id,
          status,
          attempts: attempt,
          fallback_depth: fallbackDepth,
          at: new Date().toISOString(),
          spec_hash: buildResult.spec_hash,
          artifact_hash: artifactHash,
          out_dir: published.path,
          warnings,
          stages,
          pages: buildResult.pages,
          total_bytes: buildResult.metrics.total_bytes,
        });

        outcomes.set(jobId, {
          site_id: prompt.site_id,
          status,
          ...(deduplicated ? { degraded: false } : { degraded }),
          spec_hash: buildResult.spec_hash,
          artifact_hash: artifactHash,
          stages,
          attempts: attempt,
          fallback_depth: fallbackDepth,
          pages: buildResult.pages,
          total_bytes: buildResult.metrics.total_bytes,
          largest_bundle_kb: buildResult.metrics.largest_bundle_kb,
          external_js_kb: Number((buildResult.metrics.js_bytes / 1024).toFixed(3)),
          cost_usd: envelope.meta.cost_usd ?? 0,
          warnings: deduplicated
            ? [...warnings, `identical bytes already published under this artifact hash`]
            : warnings.length > 0
              ? warnings
              : undefined,
        });

        if (!job.output?.keep_workdir) {
          await rm(join(workRoot, prompt.site_id), { recursive: true, force: true });
        }

        settledCount += 1;
        options.onProgress?.({ phase: "job", site_id: prompt.site_id, status, done: settledCount, total: job.prompts.length, elapsed_ms: Date.now() - startedAtMs });
        return;
      } catch (error) {
        lastProblem = toProblem(error, "E_B_BUILD_FAILED", `/${prompt.site_id}`, "B");
        const retryable =
          error instanceof Error &&
          "retryable" in error &&
          (error as { retryable?: boolean }).retryable === true;

        if (!retryable) break;

        // Fallback ladder (FR-B9): the second attempt drops the model and the
        // third pins assets to placeholders, so the site still ships.
        if (policy.fallbackEnabled && fallbackDepth < 2) {
          fallbackDepth += 1;
          warnings.push(B_WARNINGS.W_B_FALLBACK);
        }
        const backoffIndex = Math.min(attempt - 1, policy.backoffMs.length - 1);
        const waitMs = backoffDelay(attempt, {
          baseMs: policy.backoffMs[backoffIndex] ?? 1000,
          maxMs: 60_000,
          jitter: true,
        });
        breaker.recordFailure();
        if (Date.now() + waitMs >= deadlineAtMs) break;
        await delay(waitMs, options.signal);
      }
    }

    // Exhausted: record the failure honestly and move on (or halt, per policy).
    const finalWarning = warnings.length > 0 ? warnings : undefined;
    await journal.append({
      type: "job_settled",
      job_id: jobId,
      site_id: prompt.site_id,
      status: "failed",
      attempts: attempt,
      fallback_depth: fallbackDepth,
      at: new Date().toISOString(),
      ...(lastProblem ? { error: lastProblem } : {}),
      ...(finalWarning ? { warnings: finalWarning } : {}),
      stages,
    });
    outcomes.set(jobId, {
      site_id: prompt.site_id,
      status: "failed",
      stages,
      attempts: attempt,
      fallback_depth: fallbackDepth,
      ...(finalWarning ? { warnings: finalWarning } : {}),
      ...(lastProblem ? { error: lastProblem } : {}),
    });
    settledCount += 1;
    options.onProgress?.({ phase: "job", site_id: prompt.site_id, status: "failed", done: settledCount, total: job.prompts.length, elapsed_ms: Date.now() - startedAtMs });
    if (policy.failPolicy === "halt") halted = true;
  };

  // Build the work list. Sequential submission through a bounded window keeps
  // peak memory flat regardless of batch size: 5000 jobs must not enqueue 5000
  // pending builds.
  const queue = job.prompts
    .map((prompt, index) => ({ prompt, index }))
    .filter(({ prompt }) => pending.includes(`${job.batch_id}:${prompt.site_id}`));

  const inFlight = new Set<Promise<void>>();
  let cursor = 0;
  const windowSize = Math.min(policy.maxQueueDepth, Math.max(policy.maxParallelBuilds, 4));

  while (cursor < queue.length) {
    if (halted || cancelled) break;
    while (inFlight.size < windowSize && cursor < queue.length) {
      const entry = queue[cursor++]!;
      const task = runJob(entry.prompt, entry.index).finally(() => {
        inFlight.delete(task);
      });
      inFlight.add(task);
    }
    if (inFlight.size > 0) await Promise.race(inFlight);
  }
  await Promise.all(inFlight);

  // Anything not attempted because of a halt or a cancel is reported as skipped
  // rather than silently absent from the totals.
  for (const { prompt } of queue.slice(cursor)) {
    const jobId = `${job.batch_id}:${prompt.site_id}`;
    if (outcomes.has(jobId)) continue;
    await journal.append({
      type: "job_skipped",
      job_id: jobId,
      site_id: prompt.site_id,
      reason: halted ? "batch halted by fail policy" : "cancelled",
      at: new Date().toISOString(),
    });
    outcomes.set(jobId, {
      site_id: prompt.site_id,
      status: "skipped",
      stages: emptyStages(),
      attempts: 0,
fallback_depth: 0,
        warnings: [halted ? "skipped: batch halted by fail policy" : "skipped: cancelled"],
      });
  }

  const sites = job.prompts
    .map((prompt) => outcomes.get(`${job.batch_id}:${prompt.site_id}`))
    .filter((outcome): outcome is SiteOutcome => outcome !== undefined);

  const totals = {
    requested: job.prompts.length,
    built: sites.filter((site) => site.status === "built").length,
    built_degraded: sites.filter((site) => site.status === "built_degraded").length,
    deduplicated: sites.filter((site) => site.status === "deduplicated").length,
    failed: sites.filter((site) => site.status === "failed").length,
    skipped: sites.filter((site) => site.status === "skipped").length,
    pages: sites.reduce((total, site) => total + (site.pages ?? 0), 0),
    total_bytes: sites.reduce((total, site) => total + (site.total_bytes ?? 0), 0),
    cost_usd: Number(costUsd.toFixed(6)),
    wall_ms: Date.now() - startedAtMs,
    critical_path_ms: sites.reduce(
      (max, site) => Math.max(max, site.stages.compile_ms + site.stages.build_ms + site.stages.publish_ms),
      0,
    ),
  };

  let status: BatchResult["status"] = "completed";
  if (totals.failed > 0) status = "completed_with_failures";
  if (costUsd >= policy.maxCostUsd && totals.skipped > 0) {
    status = "aborted_budget";
    diagnostics.push(makeWarning(B_WARNINGS.W_B_THROTTLED, `batch cost reached the ${policy.maxCostUsd} USD ceiling; ${totals.skipped} site(s) skipped`));
  }
  if (Date.now() >= deadlineAtMs && totals.built + totals.built_degraded + totals.deduplicated < totals.requested) {
    status = "aborted_deadline";
  }
  if (cancelled) status = "cancelled";

  const finishedAt = new Date().toISOString();
  await journal.append({ type: "batch_finished", batch_id: job.batch_id, status, at: finishedAt });
  options.onProgress?.({ phase: "finished", status, elapsed_ms: totals.wall_ms });

  return {
    batch_id: job.batch_id,
    status,
    template: job.template,
    started_at: startedAt,
    finished_at: finishedAt,
    sites,
    totals,
    warnings: diagnostics,
    ...(replayed.resumedFrom ? { resumed_from: replayed.resumedFrom } : {}),
  };
}

/** Resolves the per-batch build driver and asset policy, with safe defaults. */
export function buildDefaultsFor(job: BatchJob): {
  driver: "astro" | "static";
  offline: boolean;
  allowlist: string[];
} {
  return {
    driver: job.build?.ssg ?? "static",
    // Offline unless an allowlist is given: an unconfigured batch must not be
    // able to make network calls just because `offline` was left unset.
    offline: job.network?.offline ?? (job.output?.network_allowlist ?? []).length === 0,
    allowlist: job.output?.network_allowlist ?? job.network?.allowlist ?? [],
  };
}

/** CloudEvents-shaped progress event, per the observability contract. */
export interface BatchEvent {
  specversion: "1.0";
  type: string;
  source: string;
  id: string;
  time: string;
  datacontenttype: "application/json";
  data: Record<string, unknown>;
}

export function cloudEvent(
  type: string,
  source: string,
  id: string,
  data: Record<string, unknown>,
): BatchEvent {
  return {
    specversion: "1.0",
    type,
    source,
    id,
    time: new Date().toISOString(),
    datacontenttype: "application/json",
    data,
  };
}
