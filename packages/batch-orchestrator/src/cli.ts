#!/usr/bin/env node
/**
 * `specbatch` - run a batch of prompts end to end (FR-B3, FR-B15).
 *
 *   specbatch run <batch.yaml> [--out DIR] [--deadline MINUTES] [--resume] [--dry-run]
 *   specbatch validate <batch.yaml>
 *   specbatch report <result.json> [--out DIR]
 *
 * Exit codes are the contract for CI:
 *   0  every requested site was delivered (built, degraded or deduplicated)
 *   1  the batch ran but some sites failed
 *   2  the manifest is invalid, or the run could not start
 *   3  the deadline or the cost ceiling aborted the batch
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { toProblem } from "@pg/spec-schema";
import { loadBatchJob, parseBatchYaml } from "./load.js";
import { runBatch, writeReports } from "./index.js";
import { toMarkdown } from "./report.js";
import type { BatchResult } from "./types.js";

interface Flags {
  command: string;
  path: string | undefined;
  out: string | undefined;
  deadlineMinutes: number | undefined;
  resume: boolean;
  dryRun: boolean;
  json: boolean;
  quiet: boolean;
}

function parseFlags(argv: string[]): Flags {
  const flags: Flags = {
    command: argv[0] ?? "",
    path: argv[1],
    out: undefined,
    deadlineMinutes: undefined,
    resume: false,
    dryRun: false,
    json: false,
    quiet: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--out" || arg === "-o") flags.out = argv[++i];
    else if (arg === "--deadline") flags.deadlineMinutes = Number(argv[++i]);
    else if (arg === "--resume") flags.resume = true;
    else if (arg === "--dry-run") flags.dryRun = true;
    else if (arg === "--json") flags.json = true;
    else if (arg === "--quiet" || arg === "-q") flags.quiet = true;
  }
  return flags;
}

const USAGE = `specbatch - compile and build many sites from one manifest

  specbatch run <batch.yaml> [--out DIR] [--deadline MINUTES] [--resume] [--dry-run]
  specbatch validate <batch.yaml>
  specbatch report <result.json> [--out DIR]

  --out DIR             output root (overrides the manifest's output.dest)
  --deadline MINUTES    wall-clock budget for the whole batch
  --resume              continue from the journal in the output root
  --dry-run             resolve and report the plan without building
  --json                machine-readable progress on stdout
`;

function progressPrinter(json: boolean, quiet: boolean) {
  return (event: { phase: string; [key: string]: unknown }): void => {
    if (quiet) return;
    if (json) {
      process.stdout.write(JSON.stringify({ event }) + "\n");
      return;
    }
    switch (event["phase"]) {
      case "started":
        process.stdout.write(`batch ${String(event["batch_id"])}: ${String(event["total"])} sites\n`);
        break;
      case "job": {
        const done = Number(event["done"]);
        const total = Number(event["total"]);
        const pctDone = total === 0 ? 100 : Math.round((done / total) * 100);
        process.stdout.write(
          `[${String(done).padStart(3)}/${String(total)} ${String(pctDone).padStart(3)}%] ${String(event["site_id"])} -> ${String(event["status"])}\n`,
        );
        break;
      }
      case "warning":
        process.stderr.write(`warn ${String(event["code"])}: ${String(event["message"])}\n`);
        break;
      case "finished":
        process.stdout.write(`finished: ${String(event["status"])} in ${(Number(event["elapsed_ms"]) / 1000).toFixed(1)}s\n`);
        break;
    }
  };
}

/** Reads a file, reporting a missing path as a clean CLI error rather than ENOENT. */
async function readTextOrNull(path: string, label: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      process.stderr.write(`specbatch: no such ${label}: ${path}\n`);
      return null;
    }
    throw error;
  }
}

async function main(argv: string[]): Promise<number> {
  const flags = parseFlags(argv);

  if (flags.command === "" || flags.command === "--help" || flags.command === "-h") {
    process.stdout.write(USAGE);
    return flags.command === "" ? 2 : 0;
  }

  if (flags.command === "validate") {
    if (!flags.path) return fail("validate needs a manifest path");
    const source = await readTextOrNull(flags.path, "manifest");
    if (source === null) return 2;
    const parsed = parseBatchYaml(source, flags.path);
    if (parsed.issues.length === 0) {
      process.stdout.write(`ok: ${flags.path} is a valid BatchJob with ${parsed.job.prompts.length} prompt(s)\n`);
      return 0;
    }
    for (const issue of parsed.issues) {
      process.stderr.write(`${issue.severity} ${issue.code}: ${issue.message}${issue.pointer ? ` (${issue.pointer})` : ""}\n`);
    }
    return 2;
  }

  if (flags.command === "report") {
    if (!flags.path) return fail("report needs a result path");
    const raw = await readTextOrNull(flags.path, "result file");
    if (raw === null) return 2;
    let result: BatchResult;
    try {
      result = JSON.parse(raw) as BatchResult;
    } catch (error) {
      return fail(`result file is not valid JSON: ${(error as Error).message}`);
    }

    const batchId = result.batch_id ?? "batch";
    if (flags.out) {
      const formats = flags.json ? (["json"] as const) : (["json", "csv", "markdown"] as const);
      const written = await writeReports(result, {
        dir: resolve(flags.out),
        batchId,
        formats: [...formats],
      });
      if (!flags.quiet) {
        process.stdout.write(`reports: ${written.join(", ")}\n`);
      }
      return 0;
    }

    if (flags.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    } else {
      process.stdout.write(toMarkdown(result));
    }
    return 0;
  }

  if (flags.command !== "run") return fail(`unknown command '${flags.command}'\n\n${USAGE}`);
  if (!flags.path) return fail("run needs a manifest path");

  let job;
  try {
    job = await loadBatchJob(flags.path);
  } catch (error) {
    return fail(`manifest is invalid: ${(error as Error).message}`);
  }
  if (flags.out) job.output = { ...(job.output ?? {}), dest: flags.out };

  const controller = new AbortController();
  const onSignal = (): void => controller.abort();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    const result = await runBatch(job, {
      ...(flags.deadlineMinutes !== undefined ? { deadlineMs: flags.deadlineMinutes * 60_000 } : {}),
      dryRun: flags.dryRun,
      resume: flags.resume,
      signal: controller.signal,
      onProgress: progressPrinter(flags.json, flags.quiet),
    });

    const dest = resolve(job.output?.dest ?? "out");
    // A dry run reports the plan and nothing else: no report files, no tree.
    if (flags.dryRun) {
      if (!flags.quiet) {
        process.stdout.write(`plan: ${result.totals.requested} site(s) would be built into ${dest}\n`);
      }
      return 0;
    }
    const reports = await writeReports(result, { dir: resolve(dest, "reports"), batchId: job.batch_id });
    if (!flags.quiet) {
      process.stdout.write(`reports: ${reports.join(", ")}\n`);
      process.stdout.write(
        `delivered ${result.totals.built + result.totals.built_degraded + result.totals.deduplicated}/${result.totals.requested} ` +
          `(${result.totals.pages} pages, ${(result.totals.total_bytes / 1024 / 1024).toFixed(2)} MB, ` +
          `${(result.totals.wall_ms / 1000).toFixed(1)}s)\n`,
      );
    }

    if (result.status === "aborted_deadline" || result.status === "aborted_budget") return 3;
    return result.totals.failed > 0 ? 1 : 0;
  } catch (error) {
    const problem = toProblem(error, "E_B_BATCH_INVALID", flags.path, "B");
    process.stderr.write(JSON.stringify(problem, null, 2) + "\n");
    return 2;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

function fail(message: string): number {
  process.stderr.write(`specbatch: ${message}\n`);
  return 2;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`specbatch: unhandled error: ${String(error)}\n`);
    process.exitCode = 2;
  },
);
