/**
 * Child-process entry point (section 6.3, NFR-C14).
 *
 * The orchestrator spawns this file once per site so that a renderer crash, an
 * out-of-memory event or a hung build costs one site rather than the batch. The
 * protocol is deliberately dull: the BuildRequest arrives as JSON on stdin, the
 * BuildResult leaves as JSON on stdout, diagnostics go to stderr, and the exit
 * code is the contract.
 *
 *   0  success (built or built_degraded)
 *   1  a hard gate failed; stdout carries a failed BuildResult
 *   2  invalid BuildRequest
 *   3  internal error
 */

import { buildSite, type BuildRequest, type BuildResult } from "./adapter.js";
import { toProblem, type ProblemDetails } from "@pg/spec-schema";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export async function main(): Promise<void> {
  const raw = await readStdin();
  if (raw.trim() === "") {
    process.stderr.write("__hundred_ssg_child: empty BuildRequest\n");
    process.exit(2);
  }

  let request: BuildRequest;
  try {
    request = JSON.parse(raw) as BuildRequest;
  } catch (error) {
    process.stderr.write(`__hundred_ssg_child: invalid JSON: ${(error as Error).message}\n`);
    process.exit(2);
  }

  try {
    const { result } = await buildSite(request);
    process.stdout.write(JSON.stringify(result));
    process.exit(result.status === "failed" ? 1 : 0);
  } catch (error) {
    const problem: ProblemDetails = toProblem(error, "E_C_TEMPLATE_COMPILE", `/${request.site_id}`, "C");
    const failed: BuildResult = {
      site_id: request.site_id,
      status: "failed",
      spec_hash: request.spec_hash ?? `blake3:${"0".repeat(64)}`,
      out_dir: request.workdir,
      pages: 0,
      files: [],
      metrics: {
        install_ms: 0,
        build_ms: 0,
        total_ms: 0,
        total_bytes: 0,
        largest_bundle_kb: 0,
        css_bytes: 0,
        js_bytes: 0,
        image_count: 0,
        image_bytes: 0,
        page_count: 0,
        external_request_count: 0,
        lcp_estimate_ms: 0,
        cls_estimate: 0,
      },
      gate: {},
      diagnostics: [
        {
          code: problem.code,
          severity: "error",
          message: problem.detail,
          source: "C",
          pointer: problem.instance,
        },
      ],
    };
    process.stderr.write(`${JSON.stringify(problem)}\n`);
    process.stdout.write(JSON.stringify(failed));
    process.exit(1);
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("child.js") || process.argv[1].endsWith("child.ts"));

if (invokedDirectly) {
  void main();
}
