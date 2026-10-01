#!/usr/bin/env node
/**
 * Repository lint. Deliberately dependency-free: the rules below are the ones
 * that have actually caught bugs in this codebase, not a style guide.
 *
 *   node scripts/lint.mjs [paths...]
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";

const roots = process.argv.slice(2);
const targets = roots.length > 0 ? roots : ["packages", "scripts"];
const SKIP_DIRS = new Set(["dist", "node_modules", ".git", "out", "coverage", ".work"]);

const problems = [];
const files = [];

async function walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full);
    } else if ([".ts", ".mjs", ".js"].includes(extname(entry.name))) {
      files.push(full);
    }
  }
}

for (const target of targets) {
  const full = resolve(target);
  const info = await stat(full).catch(() => null);
  if (!info) {
    problems.push({ file: target, line: 0, rule: "path", message: "path does not exist" });
    continue;
  }
  if (info.isDirectory()) await walk(full);
  else files.push(full);
}

for (const file of files) {
  const rel = relative(process.cwd(), file).replace(/\\/g, "/");
  const source = await readFile(file, "utf8");
  const lines = source.split("\n");
  // This file contains the rule patterns as string literals, so it cannot be
  // checked by the rules it defines.
  const isSelf = rel.endsWith("scripts/lint.mjs");

  lines.forEach((line, index) => {
    const lineNo = index + 1;
    const trimmed = line.trim();
    // Trailing whitespace survives into emitted HTML and hashes.
    if (/\s+$/.test(line) && trimmed.length > 0) {
      problems.push({ file: rel, line: lineNo, rule: "no-trailing-whitespace", message: "trailing whitespace" });
    }
    if (/\t/.test(line)) {
      problems.push({ file: rel, line: lineNo, rule: "no-tabs", message: "tab character" });
    }
    // `any` defeats the strict configuration this repo is built on.
    if (/:\s*any\b/.test(line) && !/any\[\]/.test(line) && !/Record<string,\s*any>/.test(line)) {
      problems.push({ file: rel, line: lineNo, rule: "no-any", message: "explicit `any`" });
    }
    // Debug leftovers.
    if (/\bconsole\.(log|debug)\(/.test(line) && !rel.startsWith("scripts/")) {
      problems.push({ file: rel, line: lineNo, rule: "no-console", message: "console.log outside scripts/" });
    }
    if (/\bdebugger\b/.test(line) && !isSelf) {
      problems.push({ file: rel, line: lineNo, rule: "no-debugger", message: "debugger statement" });
    }
    if (/\bTODO\b|\bFIXME\b|\bXXX\b/.test(line) && !/eslint|@todo/.test(line) && !isSelf) {
      problems.push({ file: rel, line: lineNo, rule: "no-todo", message: "unresolved TODO/FIXME" });
    }
  });

  // ESM relative imports must carry the .js extension or Node will not resolve
  // them. Anchored to a line start so a string containing "from \".\" is not
  // mistaken for an import statement.
  for (const match of source.matchAll(/^\s*(?:import|export)[^;\n]*?from\s+"(\.[^"]+)"/gm)) {
    const specifier = match[1];
    const lineNo = source.slice(0, match.index).split("\n").length;
    if (!/\.(js|mjs|json)$/.test(specifier)) {
      problems.push({ file: rel, line: lineNo, rule: "import-extension", message: `relative import '${specifier}' has no extension` });
    }
  }

  // Template literals interpolated into HTML or SQL are the classic injection seam.
  for (const match of source.matchAll(/(innerHTML|dangerouslySetInnerHTML|exec\(|query\()\s*\(?([^)]*)\$\{/g)) {
    problems.push({ file: rel, line: 0, rule: "review-interpolation", message: `interpolated argument near${match[1]}` });
  }

  if (/\r/.test(source)) {
    const lineNo = source.slice(0, source.indexOf("\r")).split("\n").length;
    problems.push({ file: rel, line: lineNo, rule: "no-crlf", message: "CRLF line ending; use LF" });
  }
    if (source.length > 0 && !source.endsWith("\n")) {
      problems.push({ file: rel, line: lines.length, rule: "final-newline", message: "file does not end with a newline" });
    }
}

const grouped = new Map();
for (const problem of problems) {
  const key = problem.rule;
  if (!grouped.has(key)) grouped.set(key, []);
  grouped.get(key).push(problem);
}

if (problems.length === 0) {
  console.log(`PASS: lint, ${files.length} file(s) clean`);
  process.exit(0);
}

for (const [rule, list] of grouped) {
  console.log(`\n${rule} (${list.length})`);
  for (const problem of list.slice(0, 10)) {
    console.log(`  ${problem.file}${problem.line ? `:${problem.line}` : ""}  ${problem.message}`);
  }
  if (list.length > 10) console.log(`  ... and ${list.length - 10} more`);
}
console.log(`\nFAIL: lint, ${problems.length} problem(s) in ${files.length} file(s)`);
process.exit(1);
