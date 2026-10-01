/**
 * Batch manifest loader (FR-B2). Accepts YAML only, validates against the shared
 * BatchJob schema, applies defaults explicitly (no hidden environment knobs).
 */

import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { assertWith, validateWith, type Diagnostic } from "@pg/spec-schema";
import type { BatchJob } from "./types.js";

export interface LoadResult {
  job: BatchJob;
  issues: Diagnostic[];
}

export function parseBatchYaml(source: string, path?: string): LoadResult {
  let parsed: unknown;
  try {
    parsed = parseYaml(source, { schema: "core" });
  } catch (error) {
    return {
      job: {} as BatchJob,
      issues: [
        {
          code: "E_B_BATCH_INVALID",
          severity: "error",
          message: `YAML parse error: ${(error as Error).message}`,
          ...(path ? { pointer: path } : {}),
          source: "B",
        },
      ],
    };
  }

  const validation = validateWith<BatchJob>("batchJob", parsed);
  if (!validation.valid) {
    return {
      job: (parsed as BatchJob) ?? ({} as BatchJob),
        issues: validation.issues.map((issue) => ({
          code: "E_B_BATCH_INVALID",
          severity: "error",
          message: issue.message,
          pointer: issue.pointer === undefined ? path : (path ? `${path}${issue.pointer}` : issue.pointer),
          source: "B",
        })),
      };
    }

  const job = validation.value;
  return { job, issues: [] };
}

export async function loadBatchJob(filePath: string): Promise<BatchJob> {
  const raw = await readFile(filePath, "utf8");
  const result = parseBatchYaml(raw, filePath);
  if (result.issues.some((issue) => issue.severity === "error")) {
    const first = result.issues.find((issue) => issue.severity === "error");
    throw new Error(first?.message ?? "batch job is invalid");
  }
  return assertWith<BatchJob>("batchJob", result.job, "BatchJob", filePath);
}
