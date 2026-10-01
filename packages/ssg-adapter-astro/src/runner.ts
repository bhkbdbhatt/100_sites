/**
 * The child-process runner (FR-C3, NFR-C14).
 *
 * One process per site, hard wall-clock kill, stdout carrying a BuildResult.
 * The orchestrator talks to the adapter exclusively through this function, so
 * the isolation boundary lives in exactly one place and the in-process path
 * stays a test convenience rather than a second, divergent implementation.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { cError } from "./errors.js";
import type { BuildRequest, BuildResult } from "./adapter.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CHILD_ENTRY = join(HERE, "child.js");

export interface ChildOutcome {
  result: BuildResult | undefined;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  timedOut: boolean;
  /** Wall time spent in the child, for the orchestrator's stage metrics. */
  elapsedMs: number;
}

export function childEntryPoint(): string {
  return CHILD_ENTRY;
}

/**
 * Runs one build in a child process. `timeoutMs` is enforced by the parent, so
 * a wedged renderer cannot extend the batch past its deadline - the site fails
 * and the batch continues.
 */
export function runBuildChild(
  request: BuildRequest,
  timeoutMs: number,
  options: { entry?: string; env?: NodeJS.ProcessEnv; onStderr?: (chunk: string) => void } = {},
): Promise<ChildOutcome> {
  const entry = options.entry ?? CHILD_ENTRY;
  const startedAt = Date.now();

  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [entry], {
      cwd: request.workdir,
      env: {
        ...process.env,
        ...options.env,
        // Memory cap is applied to the child, not inherited (section 6.3).
        NODE_OPTIONS: `--max-old-space-size=${request.build?.memory_mb ?? 384}`,
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, Math.max(1000, timeoutMs));

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      options.onStderr?.(text);
    });

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      clearTimeout(timer);
      let parsed: BuildResult | undefined;
      try {
        parsed = stdout.trim() === "" ? undefined : (JSON.parse(stdout) as BuildResult);
      } catch {
        parsed = undefined;
      }
      resolvePromise({ result: parsed, exitCode, signal, stderr, timedOut, elapsedMs: Date.now() - startedAt });
    };

    child.on("error", (error) => {
      clearTimeout(timer);
      resolvePromise({
        result: undefined,
        exitCode: null,
        signal: null,
        stderr: stderr + `spawn failed: ${error.message}`,
        timedOut: false,
        elapsedMs: Date.now() - startedAt,
      });
    });
    child.on("close", finish);

    child.stdin.on("error", () => {
      /* the close handler already reported whatever happened */
    });
    child.stdin.end(JSON.stringify(request));
  });
}

/** Convenience wrapper that turns a child failure into a typed error. */
export async function buildSiteIsolated(
  request: BuildRequest,
  timeoutMs: number,
): Promise<BuildResult> {
  const outcome = await runBuildChild(request, timeoutMs);
  if (outcome.timedOut) {
    throw cError("E_C_TIMEOUT", `build of ${request.site_id} exceeded ${timeoutMs} ms and was killed`);
  }
  if (!outcome.result) {
    throw cError(
      "E_C_TEMPLATE_COMPILE",
      `build of ${request.site_id} produced no BuildResult (exit ${outcome.exitCode ?? outcome.signal}): ${outcome.stderr.slice(0, 200)}`,
    );
  }
  return outcome.result;
}
