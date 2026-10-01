/**
 * Batch reports (FR-B13): one BatchResult document plus the derived views.
 *
 * The JSON report is the machine-readable contract. CSV and Markdown exist
 * because a human is usually the first to read a batch outcome, and a 100-row
 * JSON document is a poor thing to hand someone. Both are derived from the
 * same object, so they cannot disagree with each other.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BatchResult, SiteOutcome } from "./types.js";

export interface ReportOptions {
  /** Directory to write into. Created if missing. */
  dir: string;
  batchId: string;
  /** Formats to emit. "json" is always written: it is the contract. */
  formats?: Array<"json" | "csv" | "markdown">;
}

const CSV_COLUMNS = [
  "site_id",
  "status",
  "degraded",
  "pages",
  "total_bytes",
  "largest_bundle_kb",
  "external_js_kb",
  "attempts",
  "fallback_depth",
  "compile_ms",
  "build_ms",
  "publish_ms",
  "cost_usd",
  "spec_hash",
  "artifact_hash",
  "error_code",
  "warnings",
] as const;

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(result: BatchResult): string {
  const rows = result.sites.map((site) =>
    [
      site.site_id,
      site.status,
      site.degraded === undefined ? "" : String(site.degraded),
      site.pages ?? "",
      site.total_bytes ?? "",
      site.largest_bundle_kb ?? "",
      site.external_js_kb ?? "",
      site.attempts,
      site.fallback_depth,
      site.stages.compile_ms,
      site.stages.build_ms,
      site.stages.publish_ms,
      site.cost_usd ?? "",
      site.spec_hash ?? "",
      site.artifact_hash ?? "",
      site.error?.code ?? "",
      (site.warnings ?? []).join(" "),
    ]
      .map(csvCell)
      .join(","),
  );
  return [CSV_COLUMNS.join(","), ...rows].join("\n") + "\n";
}

function pct(count: number, total: number): string {
  return total === 0 ? "0%" : `${Math.round((count / total) * 100)}%`;
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

export function toMarkdown(result: BatchResult): string {
  const t = result.totals;
  const delivered = t.built + t.built_degraded + t.deduplicated;
  const failed = result.sites.filter((site) => site.status === "failed");
  const degraded = result.sites.filter((site) => site.status === "built_degraded");
  const slowest = [...result.sites]
    .map((site) => ({ site, ms: site.stages.compile_ms + site.stages.build_ms + site.stages.publish_ms }))
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 5);

  const lines = [
    `# Batch ${result.batch_id}`,
    "",
    `- status: **${result.status}**`,
    `- template: \`${result.template}\``,
    `- started: ${result.started_at}`,
    `- finished: ${result.finished_at}`,
    `- wall clock: ${seconds(t.wall_ms)}`,
    `- longest single site: ${seconds(t.critical_path_ms)}`,
    "",
    "## Delivery",
    "",
    "| outcome | sites | share |",
    "| --- | --- | --- |",
    `| built | ${t.built} | ${pct(t.built, t.requested)} |`,
    `| built (degraded) | ${t.built_degraded} | ${pct(t.built_degraded, t.requested)} |`,
    `| deduplicated | ${t.deduplicated} | ${pct(t.deduplicated, t.requested)} |`,
    `| failed | ${t.failed} | ${pct(t.failed, t.requested)} |`,
    `| skipped | ${t.skipped} | ${pct(t.skipped, t.requested)} |`,
    "",
    `Delivered **${delivered} of ${t.requested}** (${pct(delivered, t.requested)}): ${t.pages} pages, ${(t.total_bytes / 1024).toFixed(1)} kB total, $${t.cost_usd.toFixed(4)}.`,
    "",
  ];

  if (degraded.length > 0) {
    lines.push("## Degraded", "", "| site | why |", "| --- | --- |");
    for (const site of degraded) {
      lines.push(`| ${site.site_id} | ${(site.warnings ?? []).join(", ") || "fallback path used"} |`);
    }
    lines.push("");
  }

  if (failed.length > 0) {
    lines.push("## Failed", "", "| site | attempts | code | detail |", "| --- | --- | --- | --- |");
    for (const site of failed) {
      lines.push(
        `| ${site.site_id} | ${site.attempts} | ${site.error?.code ?? "unknown"} | ${(site.error?.detail ?? "").replace(/\|/g, "\\|").slice(0, 160)} |`,
      );
    }
    lines.push("");
  }

  if (slowest.length > 0) {
    lines.push("## Slowest sites", "", "| site | compile | build | publish | total |", "| --- | --- | --- | --- | --- |");
    for (const { site, ms } of slowest) {
      lines.push(
        `| ${site.site_id} | ${site.stages.compile_ms} ms | ${site.stages.build_ms} ms | ${site.stages.publish_ms} ms | ${ms} ms |`,
      );
    }
    lines.push("");
  }

  if (result.warnings.length > 0) {
    lines.push("## Batch warnings", "");
    for (const warning of result.warnings) lines.push(`- \`${warning.code}\`: ${warning.message}`);
    lines.push("");
  }

  return lines.join("\n");
}

export async function writeReports(result: BatchResult, options: ReportOptions): Promise<string[]> {
  const formats = options.formats ?? ["json", "csv", "markdown"];
  await mkdir(options.dir, { recursive: true });
  const written: string[] = [];

  const jsonPath = join(options.dir, `${options.batchId}.result.json`);
  await writeFile(jsonPath, JSON.stringify(result, null, 2) + "\n", "utf8");
  written.push(jsonPath);

  if (formats.includes("csv")) {
    const csvPath = join(options.dir, `${options.batchId}.sites.csv`);
    await writeFile(csvPath, toCsv(result), "utf8");
    written.push(csvPath);
  }
  if (formats.includes("markdown")) {
    const mdPath = join(options.dir, `${options.batchId}.report.md`);
    await writeFile(mdPath, toMarkdown(result), "utf8");
    written.push(mdPath);
  }
  return written;
}

/** Site outcome for the CLI summary line. Kept separate from the writer. */
export function summarize(site: SiteOutcome): string {
  const bits = [`${site.site_id}: ${site.status}`];
  if (site.pages !== undefined) bits.push(`${site.pages}p`);
  if (site.error) bits.push(site.error.code);
  if (site.warnings && site.warnings.length > 0) bits.push(site.warnings.join(","));
  return bits.join(" ");
}
