#!/usr/bin/env node
/**
 * The measured 100-site run.
 *
 * `specbatch run` is the product; this script is the harness that makes the run
 * reproducible and its numbers quotable. It fails loudly rather than reporting a
 * partial success as a success, because the whole point of the exercise is a
 * trustworthy end-to-end measurement.
 *
 *   node scripts/run-100.mjs                       # examples/batch-100.yaml -> out/100
 *   node scripts/run-100.mjs --out .work/hundred   # different destination
 *   node scripts/run-100.mjs --manifest other.yaml
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { runBatch, parseBatchYaml, writeReports } from "../packages/batch-orchestrator/dist/index.js";

const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  console.log(`run-100 - measured 100-site batch

  node scripts/run-100.mjs [--manifest FILE] [--out DIR] [--keep-workdir]

  --manifest FILE   batch manifest to run (default examples/batch-100.yaml)
  --out DIR         output root (default out/100)
  --keep-workdir    keep per-site build scratch space
  --help            show this message

Exits 0 only when every requested site was delivered with no failures or skips.`);
  process.exit(0);
}

function flag(name, fallback) {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? fallback : args[at + 1];
}

const manifestPath = flag("manifest", "examples/batch-100.yaml");
const outDir = flag("out", "out/100");
const keepWork = args.includes("--keep-workdir");

if (!existsSync(manifestPath)) {
  console.error(`run-100: no manifest at ${manifestPath}`);
  process.exit(64);
}

const parsed = parseBatchYaml(await readFile(manifestPath, "utf8"), manifestPath);
if (parsed.issues.length > 0) {
  console.error(`run-100: ${manifestPath} is not a valid BatchJob:`);
  for (const issue of parsed.issues) console.error(`  ${issue.severity} ${issue.code}: ${issue.message}`);
  process.exit(65);
}

const job = parsed.job;
const requested = job.prompts.length;
const jobs = [
  ["manifest", manifestPath],
  ["prompts", requested],
  ["parallel builds", job.concurrency?.max_parallel_builds ?? "default"],
  ["parallel compiles", job.concurrency?.max_parallel_compiles ?? "default"],
  ["cost ceiling", job.liveness?.max_cost_usd ?? "none"],
];
console.log("=".repeat(72));
console.log("HUNDRED - 100-site batch");
console.log("=".repeat(72));
for (const [label, value] of jobs) console.log(`  ${label.padEnd(16)} ${value}`);
console.log(`  ${"output".padEnd(16)} ${outDir}`);
console.log(`  ${"started".padEnd(16)} ${new Date().toISOString()}`);
console.log("-".repeat(72));

const startedAt = Date.now();
const result = await runBatch({ ...job, output: { ...job.output, dest: outDir, keep_workdir: keepWork } });

const wallMs = Date.now() - startedAt;
const t = result.totals;
const delivered = t.built + t.built_degraded + t.deduplicated;
const mb = (t.total_bytes / 1024 / 1024).toFixed(2);
const externalJsKb = result.sites.reduce((sum, site) => sum + (site.external_js_kb ?? 0), 0);
// The scheduler's own clock is authoritative; the local stopwatch includes
// manifest parsing and report writing on top of it.
const seconds = t.wall_ms / 1000;

console.log("-".repeat(72));
console.log("Result");
console.log("-".repeat(72));
console.log(`  status            ${result.status}`);
console.log(`  delivered         ${delivered}/${t.requested}`);
console.log(`    built           ${t.built}`);
console.log(`    degraded        ${t.built_degraded}`);
console.log(`    deduplicated    ${t.deduplicated}`);
console.log(`  failed            ${t.failed}`);
console.log(`  skipped           ${t.skipped}`);
console.log(`  pages             ${t.pages}`);
console.log(`  bytes             ${t.total_bytes} (${mb} MB)`);
console.log(`  external js       ${externalJsKb} kB`);
console.log(`  cost              $${t.cost_usd.toFixed(4)}`);
console.log(`  wall clock        ${(t.wall_ms / 1000).toFixed(1)}s (harness ${(wallMs / 1000).toFixed(1)}s)`);
console.log(`  critical path     ${(t.critical_path_ms / 1000).toFixed(1)}s`);
console.log(`  mean per site     ${delivered === 0 ? "n/a" : `${Math.round(t.wall_ms / delivered)}ms`}`);
console.log(`  throughput        ${seconds === 0 ? 0 : (t.pages / seconds).toFixed(1)} pages/s`);

if (t.failed > 0) {
  console.log("\nFailures");
  console.log("-".repeat(72));
  for (const site of result.sites.filter((s) => s.status === "failed")) {
    console.log(`  ${site.site_id.padEnd(18)} ${site.error?.code ?? "unknown"}: ${(site.error?.detail ?? "").slice(0, 90)}`);
  }
}

const degradedSites = result.sites.filter((s) => s.status === "built_degraded");
if (degradedSites.length > 0) {
  console.log("\nDegraded (offline assets resolved to deterministic placeholders)");
  console.log("-".repeat(72));
  for (const site of degradedSites) {
    console.log(`  ${site.site_id.padEnd(18)} ${(site.warnings ?? []).join(", ")}`);
  }
}

if (result.warnings.length > 0) {
  console.log("\nBatch warnings");
  console.log("-".repeat(72));
  for (const warning of result.warnings) console.log(`  ${warning.code}: ${warning.message}`);
}

const reports = await writeReports(result, {
  dir: join(resolve(outDir), "reports"),
  batchId: job.batch_id,
});
console.log(`\nReports:`);
for (const path of reports) console.log(`  ${path}`);

// A run that lost sites is not a passing run, whatever the status string says.
const complete = result.status === "completed" && delivered === requested && t.failed === 0 && t.skipped === 0;
console.log(`\n${complete ? "PASS" : "INCOMPLETE"}: ${delivered}/${requested} delivered, ${t.failed} failed, ${t.skipped} skipped`);
process.exit(complete ? 0 : 1);
