/**
 * The Astro driver (FR-C9).
 *
 * Astro is invoked as a child process so a compiler crash or an out-of-memory
 * event kills the build rather than the batch (NFR-C14, section 6.3). The
 * adapter writes a real Astro project into the staging workdir, then runs
 * `astro build` with `--root`.
 *
 * If Astro is not installed locally the driver reports `E_C_MODULE_RESOLVE`
 * with a retryable flag, and the orchestrator's fallback ladder drops the site
 * onto the static driver. That is the whole point of the fallback depth: a
 * missing toolchain degrades one site, never the batch.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { PageRenderResult } from "../render/page.js";
import { cError } from "../errors.js";
import type { EmitTarget } from "./shared.js";
import { notFoundHtml, outputPathFor, robotsTxt, sitemapXml, writeWithin } from "./shared.js";

export interface AstroEmitResult {
  files: string[];
  pages: PageRenderResult[];
  degraded: boolean;
  installMs: number;
  buildMs: number;
  buildLog: string;
}

/** Astro is resolvable only from the staging workdir or a hoisted node_modules. */
export function resolveAstroBin(workdir: string): string | undefined {
  const candidates = [
    join(workdir, "node_modules", ".bin", "astro.cmd"),
    join(workdir, "node_modules", ".bin", "astro"),
    join(workdir, "..", "node_modules", ".bin", "astro.cmd"),
    join(process.cwd(), "node_modules", ".bin", "astro.cmd"),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

interface RunOutcome {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function run(command: string, args: string[], cwd: string, timeoutMs: number, env: NodeJS.ProcessEnv): Promise<RunOutcome> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...env, NODE_OPTIONS: `--max-old-space-size=${env.ASTRO_MEMORY_MB ?? 384}`, CI: "1" },
      shell: process.platform === "win32",
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolvePromise({ code: null, signal: null, stdout, stderr: stderr + error.message, timedOut });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolvePromise({ code, signal, stdout, stderr, timedOut });
    });
  });
}

export async function emitAstro(target: EmitTarget, workdir: string, timeoutMs: number): Promise<AstroEmitResult> {
  const installStart = Date.now();
  const astroBin = resolveAstroBin(workdir);
  if (!astroBin) {
    throw cError(
      "E_C_MODULE_RESOLVE",
      "astro is not installed in the staging workdir; fall back to the static driver",
      { instance: workdir },
    );
  }
  const installMs = Date.now() - installStart;

  // Project scaffolding. Deterministic content, so a rebuild is byte-identical.
  const files: string[] = [];
  await writeWithin(workdir, "package.json", JSON.stringify({ name: "hundred-site", private: true, type: "module" }, null, 2) + "\n");
  await writeWithin(
    workdir,
    "astro.config.mjs",
    [
      `import { defineConfig } from "astro/config";`,
      `export default defineConfig({`,
      `  output: "static",`,
      `  trailingSlash: ${JSON.stringify(target.spec.build.trailing_slash)},`,
      `  build: { format: "file", inlineStylesheets: ${JSON.stringify(target.spec.build.minify ? "auto" : "never")} },`,
      `  compressHTML: ${target.spec.build.minify ? "true" : "false"},`,
      `  devToolbar: { enabled: false },`,
      `});`,
      ``,
    ].join("\n"),
  );
  await writeWithin(
    workdir,
    "tsconfig.json",
    JSON.stringify({ extends: "astro/tsconfigs/strict", include: [".astro/types.d.ts", "**/*"] }, null, 2) + "\n",
  );
  await writeWithin(workdir, "src/styles/global.css", `@import "../dist/css/main.css";\n`);

  for (const page of target.spec.pages) {
    const rendered = target.pages.get(page.path);
    if (!rendered) continue;
    const relative = outputPathFor(page.path, target.spec.build.trailing_slash).replace(/\/index\.html$/, ".astro");
    const body = rendered.html.replace(/^<!doctype html>\s*/i, "");
    await writeWithin(
      workdir,
      join("src", "pages", relative.replace(/\\/g, "/")),
      `---\nimport "../../styles/global.css";\n---\n${body}\n`,
    );
    files.push(relative);
  }
  if (target.spec.seo.sitemap) await writeWithin(workdir, "public/sitemap.xml", sitemapXml(target.spec));
  await writeWithin(workdir, "public/robots.txt", robotsTxt(target.spec));
  await writeWithin(workdir, "src/pages/404.astro", notFoundHtml(target.spec));

  const buildStart = Date.now();
  const outcome = await run(astroBin, ["build", "--root", workdir, "--outDir", join(target.outDir, "_astro")], workdir, timeoutMs, process.env);
  const buildMs = Date.now() - buildStart;
  const buildLog = `${outcome.stdout}\n${outcome.stderr}`.trim().slice(0, 400);

  if (outcome.timedOut) {
    throw cError("E_C_TIMEOUT", `astro build exceeded ${timeoutMs} ms`, { instance: workdir });
  }
  if (outcome.code !== 0) {
    throw cError("E_C_TEMPLATE_COMPILE", `astro build exited ${outcome.code ?? outcome.signal}: ${buildLog}`, {
      instance: workdir,
    });
  }

  return {
    files,
    pages: [...target.pages.values()],
    degraded: false,
    installMs,
    buildMs,
    buildLog,
  };
}
