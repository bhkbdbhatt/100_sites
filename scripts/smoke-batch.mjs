#!/usr/bin/env node
/**
 * Component B smoke test.
 *
 * Covers the behaviours that are cheap to assert and expensive to get wrong:
 * manifest validation, a real multi-site batch, dedupe, resume, deadline
 * enforcement, reports and CAS publication.
 */

import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  loadBatchJob,
  parseBatchYaml,
  runBatch,
  writeReports,
  toCsv,
  toMarkdown,
  summarize,
  Journal,
  Publisher,
  Semaphore,
  TokenBucket,
  CircuitBreaker,
  backoffDelay,
  B_ERRORS,
  bError,
} from "../packages/batch-orchestrator/dist/index.js";

let failures = 0;
let checks = 0;

function check(condition, message) {
  checks += 1;
  if (condition) {
    console.log(`  ok  ${message}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${message}`);
  }
}

function eq(actual, expected, message) {
  check(actual === expected, `${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

const root = await mkdtemp(join(tmpdir(), "hundred-b-smoke-"));
console.log(`component B smoke: ${root}`);

try {
  // ---------------------------------------------------------------- manifest
  console.log("\n[1] manifest validation");
  const validYaml = `batch_id: smoke-1
template: astro-nano
prompts:
  - site_id: alpha
    prompt: Alpha Yoga, a yoga studio. Calm tone.
  - site_id: beta
    prompt: Beta Bakery, a wood-fired bakery. Plainspoken tone.
`;
  const parsed = parseBatchYaml(validYaml, "smoke-1.yaml");
  eq(parsed.issues.length, 0, "valid manifest has no issues");
  eq(parsed.job.prompts.length, 2, "both prompts parsed");

  const badYaml = `batch_id: smoke-bad
template: astro-nano
prompts:
  - site_id: alpha
    prompt: Missing template? No: extra key below.
    unknown_field: 1
`;
  const bad = parseBatchYaml(badYaml, "smoke-bad.yaml");
  check(bad.issues.length > 0, "unknown field is rejected");
  check(
    bad.issues.some((issue) => issue.pointer !== undefined),
    "issues carry a JSON pointer",
  );

  const emptyYaml = `batch_id: smoke-empty
template: astro-nano
prompts: []
`;
  const empty = parseBatchYaml(emptyYaml, "smoke-empty.yaml");
  check(empty.issues.length > 0, "zero prompts is rejected");

  const batchPath = join(root, "batch.yaml");
  await (await import("node:fs/promises")).writeFile(batchPath, validYaml, "utf8");
  const loaded = await loadBatchJob(batchPath);
  eq(loaded.batch_id, "smoke-1", "loadBatchJob reads the manifest");

  const missing = await loadBatchJob(join(root, "does-not-exist.yaml")).then(
    () => null,
    (error) => error,
  );
  check(missing !== null, "missing manifest rejects");

  // ------------------------------------------------------------------- errors
  console.log("\n[2] error table");
  const err = bError("E_B_BUILD_FAILED", "boom");
  eq(err.code, "E_B_BUILD_FAILED", "error carries its code");
  eq(err.retryable, true, "E_B_BUILD_FAILED is retryable");
  eq(bError("E_B_BATCH_INVALID", "bad").retryable, false, "E_B_BATCH_INVALID is not retryable");
  eq(
    B_ERRORS.E_B_DEADLINE_EXCEEDED.retryable,
    false,
    "E_B_DEADLINE_EXCEEDED is not retryable: retrying cannot un-pass a deadline",
  );

  // -------------------------------------------------------------- concurrency
  console.log("\n[3] concurrency primitives");
  const sem = new Semaphore(2);
  let concurrent = 0;
  let peak = 0;
  await Promise.all(
    Array.from({ length: 12 }, () =>
      sem.run(async () => {
        concurrent += 1;
        peak = Math.max(peak, concurrent);
        await new Promise((resolve) => setTimeout(resolve, 5));
        concurrent -= 1;
      }),
    ),
  );
  eq(peak, 2, "semaphore never exceeds its limit");

  const bucket = new TokenBucket({ capacity: 2, refillPerMs: 0 });
  await bucket.acquire();
  await bucket.acquire();
  const starved = await bucket.acquire().then(
    () => null,
    (error) => error,
  );
  check(starved instanceof RangeError, "an empty bucket with no refill rejects instead of spinning");

  // 0.2 tokens per ms is one token every 5ms, so the second acquire must wait.
  const slow = new TokenBucket({ capacity: 1, refillPerMs: 0.2 });
  await slow.acquire();
  const pacedStart = Date.now();
  await slow.acquire();
  const pacedMs = Date.now() - pacedStart;
  check(pacedMs >= 5, `a slow bucket paces the second acquire (>= 5ms, got ${pacedMs}ms)`);

  const breaker = new CircuitBreaker(0.5, 60_000);
  breaker.recordFailure();
  breaker.recordFailure();
  check(!breaker.allow(), "breaker opens after sustained failures");
  breaker.recordSuccess();
  breaker.recordSuccess();
  check(breaker.allow(), "breaker closes again after recovery");

  const d1 = backoffDelay(1, { baseMs: 100, maxMs: 10_000, jitter: false });
  const d2 = backoffDelay(2, { baseMs: 100, maxMs: 10_000, jitter: false });
  const d3 = backoffDelay(3, { baseMs: 100, maxMs: 10_000, jitter: false });
  check(d1 < d2 && d2 < d3, `backoff grows (${d1}, ${d2}, ${d3})`);
  check(backoffDelay(20, { baseMs: 100, maxMs: 10_000, jitter: false }) <= 10_000, "backoff respects maxMs");

  // -------------------------------------------------------------------- batch
  console.log("\n[4] real batch (compile -> build -> publish)");
  const dest = join(root, "out");
  const job = {
    ...loaded,
    batch_id: "smoke-run",
    liveness: { provider: "deterministic", max_cost_usd: 25 },
    policies: { max_attempts: 2, site_timeout_ms: 120_000, fail_policy: "continue", fallback_enabled: true },
    concurrency: { max_parallel_builds: 2, max_parallel_compiles: 2 },
    output: { dest, artifact_store: "cas", report_formats: ["json", "csv", "markdown"] },
  };

  const progress = [];
  const result = await runBatch(job, {
    onProgress: (event) => progress.push(event),
  });

  eq(result.batch_id, "smoke-run", "result carries the batch id");
  eq(result.totals.requested, 2, "two sites requested");
  eq(result.totals.failed, 0, "no site failed");
  check(result.totals.built + result.totals.built_degraded + result.totals.deduplicated === 2, "both sites delivered");
  eq(result.sites.length, 2, "one outcome per prompt");
  check(progress[0]?.phase === "started", "first progress event is 'started'");
  eq(progress.at(-1)?.phase, "finished", "last progress event is 'finished'");
  check(result.totals.wall_ms > 0, "wall clock recorded");
  check(result.totals.pages > 0, "pages were produced");

  for (const site of result.sites) {
    check(["built", "built_degraded", "deduplicated"].includes(site.status), `${site.site_id} delivered as ${site.status}`);
    check(typeof site.spec_hash === "string" && site.spec_hash.length > 0, `${site.site_id} has a spec hash`);
    check(typeof site.artifact_hash === "string" && site.artifact_hash.length > 0, `${site.site_id} has an artifact hash`);
    check((site.external_js_kb ?? 0) === 0, `${site.site_id} ships zero external JS`);
    check(await exists(join(sitesDirOf(dest), site.site_id, "index.html")), `${site.site_id} published index.html`);
  }

  function sitesDirOf(destination) {
    return join(destination, "sites");
  }

  // ---------------------------------------------------------------- dedupe
  console.log("\n[5] dedupe by artifact bytes");
  const dupJob = {
    ...job,
    batch_id: "smoke-dedupe",
    output: { ...job.output, dest: join(root, "out-dedupe") },
  };
  // Identical prompt + identical constraints => identical spec => identical bytes.
  dupJob.prompts = [
    { site_id: "twin-one", prompt: dupJob.prompts[0].prompt },
    { site_id: "twin-two", prompt: dupJob.prompts[0].prompt },
  ];
  const dupResult = await runBatch(dupJob);
  eq(dupResult.totals.requested, 2, "two twin sites requested");
  eq(dupResult.totals.deduplicated, 1, "the second twin was deduplicated");
  check(
    (await exists(join(root, "out-dedupe", "sites", "twin-two", "index.html"))),
    "the deduplicated site still has its own directory",
  );
  const twins = dupResult.sites.map((site) => site.artifact_hash);
  eq(twins[0], twins[1], "both twins report the same artifact hash");

  // --------------------------------------------------------------- journal
  console.log("\n[6] journal and resume");
  const journalFile = join(dest, "journal", "smoke-run.ndjson");
  check(await exists(journalFile), "journal file written");
  const journal = new Journal({ path: journalFile });
  const replayed = await journal.replay();
  eq(replayed.jobs.size, 2, "journal replays both jobs");
  eq(replayed.resumedFrom, "smoke-run", "journal reports the batch it belongs to");
  check(
    [...replayed.jobs.values()].every((record) => record.status !== "running"),
    "no job is left in 'running'",
  );
  check(await exists(journalFile), "journal survives replay");

  // A brand new site added to the manifest, resumed: only the new one is built.
  const resumeJob = {
    ...job,
    batch_id: "smoke-run",
    prompts: [...job.prompts, { site_id: "gamma", prompt: "Gamma Cycles, a bicycle repair shop. Practical tone." }],
  };
  const resumeResult = await runBatch(resumeJob, { resume: true });
  eq(resumeResult.totals.requested, 3, "resumed batch sees three sites");
  eq(resumeResult.resumed_from, "smoke-run", "result records the resume point");
  const gamma = resumeResult.sites.find((site) => site.site_id === "gamma");
  check(gamma !== undefined && gamma.status !== "failed", "only the new site was built on resume");
  const alpha = resumeResult.sites.find((site) => site.site_id === "alpha");
  eq(alpha.attempts, 1, "already-settled sites are not re-run");

  // ---------------------------------------------------------------- deadline
  console.log("\n[7] deadline enforcement");
  const deadlineJob = {
    ...job,
    batch_id: "smoke-deadline",
    prompts: [
      { site_id: "late-1", prompt: "Late One, a locksmith. Brief tone." },
      { site_id: "late-2", prompt: "Late Two, a florist. Seasonal tone." },
    ],
    output: { ...job.output, dest: join(root, "out-deadline") },
  };
  const deadlineResult = await runBatch(deadlineJob, { deadlineMs: 1 });
  eq(deadlineResult.status, "aborted_deadline", "an exhausted deadline aborts the batch");
  eq(deadlineResult.totals.skipped, 2, "sites after the deadline are skipped, not failed");
  eq(deadlineResult.totals.failed, 0, "a deadline is not a failure");

  // ----------------------------------------------------------------- dry run
  console.log("\n[8] dry run touches nothing");
  const dryDest = join(root, "out-dry");
  const dryResult = await runBatch({ ...job, output: { ...job.output, dest: dryDest } }, { dryRun: true });
  eq(dryResult.totals.skipped, 2, "dry run skips every site");
  check(!(await exists(join(dryDest, "sites", "alpha"))), "dry run published nothing");

  // ------------------------------------------------------------------ reports
  console.log("\n[9] reports");
  const csv = toCsv(result);
  check(csv.split("\n").length >= 3, "csv has a header and one row per site");
  check(csv.includes("alpha") && csv.includes("beta"), "csv names every site");
  const md = toMarkdown(result);
  check(md.includes("smoke-run"), "markdown names the batch");
  check(md.includes("|"), "markdown renders a table");
  const summary = result.sites.map((site) => summarize(site));
  check(summary.length === 2, "summary has one line per site");
  check(summary.every((line) => !line.includes("undefined")), "summary has no undefined values");

  const reportDir = join(root, "reports");
  const written = await writeReports(result, { dir: reportDir, batchId: result.batch_id });
  check(written.length >= 2, "several report files written");
  for (const path of written) check(await exists(path), `report exists: ${path.replace(root, "<tmp>")}`);
  const jsonReports = (await readdir(reportDir)).filter((name) => name.endsWith(".json"));
  check(jsonReports.length > 0, "a machine-readable report exists");
  if (jsonReports.length > 0) {
    const parsedReport = JSON.parse(await readFile(join(reportDir, jsonReports[0]), "utf8"));
    check(parsedReport.batch_id === "smoke-run", "report round-trips the batch id");
  }

  // --------------------------------------------------------------------- CAS
  console.log("\n[10] content store");
  const casDir = join(dest, "cas");
  const siteDirs = await readdir(join(dest, "sites"));
  check(siteDirs.includes("alpha") && siteDirs.includes("beta"), "one directory per delivered site");
  const pub = new Publisher(join(dest, "sites"), casDir);
  const scanned = await pub.scan();
  check(scanned >= 2, `CAS holds at least one slot per distinct artifact (${scanned})`);
  const alphaHash = result.sites.find((site) => site.site_id === "alpha").artifact_hash;
  eq(pub.knownSiteFor(alphaHash), "alpha", "CAS maps the artifact hash back to its site");

  // ------------------------------------------------------------------ budget
  console.log("\n[11] cost ceiling");
  // The deterministic provider is free, so cost stays at exactly 0. A zero
  // ceiling therefore blocks every job before it starts, which is the point:
  // the ceiling is enforced ahead of the call, not tallied after it.
  const budgetJob = {
    ...job,
    batch_id: "smoke-budget",
    liveness: { provider: "deterministic", max_cost_usd: 0 },
    output: { ...job.output, dest: join(root, "out-budget") },
  };
  const budgetResult = await runBatch(budgetJob);
  eq(budgetResult.status, "aborted_budget", "a zero cost ceiling aborts the batch");
  eq(budgetResult.totals.skipped, 2, "sites past the ceiling are skipped, not failed");
  eq(budgetResult.totals.cost_usd, 0, "nothing was spent");
  check(
    budgetResult.warnings.some((w) => w.message.includes("ceiling")),
    "the abort is explained in the warnings",
  );
  check(
    !(await exists(join(root, "out-budget", "sites", "alpha"))),
    "the ceiling stops the build, not just the report",
  );

  console.log("\n[11b] a budget above zero does not trip");
  const affordableJob = {
    ...job,
    batch_id: "smoke-budget-ok",
    liveness: { provider: "deterministic", max_cost_usd: 5 },
    output: { ...job.output, dest: join(root, "out-budget-ok") },
  };
  const affordable = await runBatch(affordableJob);
  eq(affordable.status, "completed", "a generous ceiling completes normally");
  eq(affordable.totals.skipped, 0, "nothing was skipped");

  // ------------------------------------------------------------------ cancel
  console.log("\n[12] cancellation");
  const controller = new AbortController();
  controller.abort();
  const cancelJob = {
    ...job,
    batch_id: "smoke-cancel",
    prompts: job.prompts.map((p, i) => ({ ...p, site_id: `${p.site_id}-cancel-${i}` })),
    output: { ...job.output, dest: join(root, "out-cancel") },
  };
  const cancelResult = await runBatch(cancelJob, { signal: controller.signal });
  eq(cancelResult.status, "cancelled", "an aborted signal cancels the batch");
  eq(cancelResult.totals.built + cancelResult.totals.built_degraded, 0, "nothing was built after cancellation");

  // ---------------------------------------------------------------- summary
  console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: component B smoke, ${failures} failure(s) of ${checks} check(s)`);
} finally {
  await rm(root, { recursive: true, force: true });
}

process.exitCode = failures === 0 ? 0 : 1;
