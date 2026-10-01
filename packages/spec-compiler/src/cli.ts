#!/usr/bin/env node
/**
 * `speccompile` - compile one prompt to a spec, for inspection and debugging.
 * Not the batch path; the orchestrator calls the library directly.
 */

import { readFile } from "node:fs/promises";
import { createCompiler } from "./index.js";
import { validateSiteSpec } from "@pg/spec-schema";
import type { CompileRequest } from "./types.js";

const USAGE = `speccompile --site-id <id> --prompt-file <path> [options]

Options:
  --site-id <id>        required; lowercase slug
  --prompt <text>       prompt text (alternative to --prompt-file)
  --prompt-file <path>  read the prompt from a file
  --out <path>          write the envelope JSON here (default: stdout)
  --provider <name>     deterministic | openai-compatible (default: deterministic)
  --model <id>          model id for openai-compatible
  --base-url <url>      gateway base url
  --max-pages <n>       page ceiling
  --cache-dir <path>    enable the content-addressed spec cache
  --tier <t>            fast | standard | premium
  --help
`;

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[key] = "true";
    else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args["help"]) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (!args["site-id"]) {
    process.stderr.write("E_A_PROMPT_EMPTY: --site-id is required\n" + USAGE);
    return 2;
  }
  const prompt = args["prompt-file"] ? await readFile(args["prompt-file"], "utf8") : args["prompt"];
  if (!prompt) {
    process.stderr.write("E_A_PROMPT_EMPTY: --prompt or --prompt-file is required\n");
    return 2;
  }

  const request: CompileRequest = {
    site_id: args["site-id"],
    prompt,
    ...(args["max-pages"] ? { constraints: { max_pages: Number(args["max-pages"]) } } : {}),
    ...(args["tier"] ? { compile_options: { model_tier: args["tier"] as "fast" } } : {}),
  };

  const compiler = createCompiler({
    provider: (args["provider"] as "deterministic") ?? "deterministic",
    ...(args["base-url"] ? { baseUrl: args["base-url"] } : {}),
    ...(args["model"] ? { model: args["model"] } : {}),
    ...(args["cache-dir"] ? { cacheDir: args["cache-dir"] } : {}),
    onWarning: (warning) => process.stderr.write(`warn ${warning.code}: ${warning.message}\n`),
  });

  const started = Date.now();
  const envelope = await compiler.compile(request);
  const validation = validateSiteSpec(envelope.spec);
  const json = JSON.stringify(envelope, null, 2);

  if (args["out"]) {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(args["out"], json + "\n", "utf8");
    process.stdout.write(
      `${envelope.spec.meta.title}  pages=${envelope.spec.pages.length}  hash=${envelope.meta.spec_hash.slice(0, 20)}…  degraded=${envelope.meta.degraded}  valid=${validation.valid} ${Date.now() - started}ms -> ${args["out"]}\n`,
    );
  } else {
    process.stdout.write(json + "\n");
  }
  return validation.valid ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
