#!/usr/bin/env node
/**
 * Normalize source files: strip trailing whitespace, ensure a final newline.
 * Idempotent. Excludes this file.
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";

const SKIP_DIRS = new Set(["dist", "node_modules", ".git", "out", ".work", "coverage"]);
const SELF = resolve("scripts/normalize-whitespace.mjs");

async function walk(dir, acc = []) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, acc);
    else if ([".ts", ".mjs"].includes(extname(entry.name))) acc.push(resolve(full));
  }
  return acc;
}

const roots = process.argv.slice(2);
const targets = roots.length > 0 ? roots : ["packages", "scripts"];
const files = [];
for (const target of targets) {
  const info = await (await import("node:fs/promises")).stat(target).catch(() => null);
  if (!info) continue;
  if (info.isDirectory()) await walk(target, files);
  else files.push(resolve(target));
}

let fixed = 0;
for (const file of files) {
  if (file === SELF) continue;
  const source = await readFile(file, "utf8");
  // CRLF is normalized to LF: the emitted HTML must be byte-stable across
  // platforms, and a stray \r in a template literal becomes part of a hash.
  const unified = source.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const stripped = unified.split("\n").map((line) => line.replace(/[ \t]+$/, "")).join("\n");
  const normalized = stripped.replace(/\n*$/, "\n");
  if (normalized !== source) {
    await writeFile(file, normalized, "utf8");
    fixed += 1;
    console.log("  fixed", file);
  }
}
console.log(`normalized ${fixed} of ${files.length} file(s)`);
