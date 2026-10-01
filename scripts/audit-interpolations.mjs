#!/usr/bin/env node
/**
 * One-off diagnostic: locate template-literal interpolation sites whose leading
 * `$` was lost, and any U+FFFD replacement characters.
 */

import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";

const SKIP = new Set(["dist", "node_modules", ".git", "out", ".work", "coverage"]);
const files = [];

async function walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || SKIP.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walk(full);
    else if ([".ts", ".mjs"].includes(extname(entry.name))) files.push(full);
  }
}

for (const root of ["packages", "scripts"]) await walk(root);

let totalMissing = 0;
let totalFffd = 0;
const report = [];

for (const file of files.sort()) {
  const source = await readFile(file, "utf8");
  const rel = relative(process.cwd(), file).replace(/\\/g, "/");
  const lines = source.split("\n");
  const hits = [];

  lines.forEach((line, index) => {
    const fffd = (line.match(/\uFFFD/g) ?? []).length;
    totalFffd += fffd;
    if (fffd) hits.push({ line: index + 1, kind: "U+FFFD", text: line.trim() });

    // `{ident...}` that is NOT preceded by `$` and is not an object literal.
    // Object literals always have a `:` or a newline/`,`/`}` right after `{`.
    const re = /(?<![$\\])\{([A-Za-z_$][A-Za-z0-9_$.[\]()"'| ]*?[A-Za-z0-9_$)\]])\}/g;
    let match;
    while ((match = re.exec(line)) !== null) {
      const inner = match[1];
      // Skip things that are plainly object literal keys.
      const after = line.slice(match.index + match[0].length, match.index + match[0].length + 3);
      if (/^\s*[:,]/.test(after)) continue;
      if (line.slice(match.index - 1, match.index) === ":") continue;
      hits.push({ line: index + 1, kind: "missing-$", text: line.trim() });
    }
  });

  if (hits.length > 0) {
    totalMissing += hits.filter((h) => h.kind === "missing-$").length;
    report.push({ rel, hits });
  }
}

console.log(`files scanned: ${files.length}`);
console.log(`missing-$ candidates: ${totalMissing}`);
console.log(`U+FFFD replacement chars: ${totalFffd}`);
console.log("");
for (const { rel, hits } of report) {
  const missing = hits.filter((h) => h.kind === "missing-$").length;
  const fffd = hits.filter((h) => h.kind === "U+FFFD").length;
  console.log(`${rel}  (${missing} missing-$, ${fffd} U+FFFD)`);
  for (const hit of hits.slice(0, 4)) console.log(`   ${hit.line}: ${hit.text.slice(0, 110)}`);
  if (hits.length > 4) console.log(`   ... ${hits.length - 4} more`);
}
