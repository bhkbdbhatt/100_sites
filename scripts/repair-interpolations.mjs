#!/usr/bin/env node
/**
 * One-off repair: restore `$` on template-literal interpolations that lost it.
 *
 * A `{` inside template text is treated as a damaged interpolation only if the
 * balanced expression that follows starts with an identifier or `(`, contains
 * no top-level `:` (which would make it an object literal or JSON example), and
 * closes on the same logical line. That excludes the JSON contract examples
 * embedded in the system prompt, where `{` follows `"key": ` or a quote.
 *
 * Positions outside template literals are never considered, so schema defaults
 * such as `default: "{site_id}"` are left untouched.
 *
 *   node scripts/repair-interpolations.mjs            # report only
 *   node scripts/repair-interpolations.mjs --write    # apply
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";

const WRITE = process.argv.includes("--write");
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

/** True when a `/` at this position starts a regex literal, not a division. */
function startsRegex(source, index) {
  for (let i = index - 1; i >= 0; i -= 1) {
    const c = source[i];
    if (/\s/.test(c)) continue;
    if (/[)\]}]/.test(c)) return false;
    if (/[([{;,=:?&|!+\-*%~^]/.test(c)) return true;
    // A keyword such as `return` also precedes a regex.
    const word = source.slice(Math.max(0, i - 8), i + 1);
    return /\b(return|typeof|case|in|of|new|do|else|yield|await|delete|void|instanceof)$/.test(word);
  }
  return true;
}

/**
 * Indices of every `{` that sits directly in template text (not inside a
 * nested `${...}`, a string, or a comment).
 */
function candidateBraces(source) {
  const positions = [];
  const n = source.length;
  let i = 0;

  while (i < n) {
    const ch = source[i];

    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "/" && source[i + 1] === "/") {
      const end = source.indexOf("\n", i);
      i = end === -1 ? n : end;
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    if (ch === "/" && startsRegex(source, i)) {
      // Regex literal: a quote inside it must not open a string.
      i += 1;
      let inClass = false;
      while (i < n) {
        const c = source[i];
        if (c === "\\") i += 2;
        else if (c === "[") {
          inClass = true;
          i += 1;
        } else if (c === "]") {
          inClass = false;
          i += 1;
        } else if (c === "/" && !inClass) break;
        else if (c === "\n") break;
        else i += 1;
      }
      i += 1;
      while (i < n && /[a-z]/.test(source[i])) i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      i += 1;
      while (i < n) {
        if (source[i] === "\\") i += 2;
        else if (source[i] === ch) break;
        else i += 1;
      }
      i += 1;
      continue;
    }
    if (ch === "`") {
      // Inside template text. Walk to the closing backtick, stepping over
      // `${...}` expressions wholesale.
      i += 1;
      while (i < n) {
        if (source[i] === "\\") {
          i += 2;
          continue;
        }
        if (source[i] === "$" && source[i + 1] === "{") {
          i = skipExpression(source, i + 1);
          continue;
        }
        if (source[i] === "{") {
          positions.push(i);
          i += 1;
          continue;
        }
        if (source[i] === "`") break;
        i += 1;
      }
      i += 1;
      continue;
    }
    i += 1;
  }
  return positions;
}

/** Skips a balanced `{...}` starting at the brace; returns the index after it. */
function skipExpression(source, braceIndex) {
  const n = source.length;
  let depth = 0;
  let i = braceIndex;
  while (i < n) {
    const c = source[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      i += 1;
      while (i < n && source[i] !== quote) {
        if (source[i] === "\\") i += 1;
        i += 1;
      }
      i += 1;
      continue;
    }
    if (c === "/" && source[i + 1] === "/") {
      const end = source.indexOf("\n", i);
      i = end === -1 ? n : end;
      continue;
    }
    if (c === "/" && startsRegex(source, i)) {
      i += 1;
      let inClass = false;
      while (i < n) {
        const d = source[i];
        if (d === "\\") i += 2;
        else if (d === "[") {
          inClass = true;
          i += 1;
        } else if (d === "]") {
          inClass = false;
          i += 1;
        } else if (d === "/" && !inClass) break;
        else if (d === "\n") break;
        else i += 1;
      }
      i += 1;
      while (i < n && /[a-z]/.test(source[i])) i += 1;
      continue;
    }
    if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
    i += 1;
  }
  return n;
}

/**
 * If `{` at `start` is a damaged interpolation, returns the end index of its
 * closing brace; otherwise undefined.
 */
function interpolationEnd(source, start) {
  const first = source[start + 1];
  if (first === undefined) return undefined;
  if (!/[A-Za-z_$(]/.test(first)) return undefined;

  const n = source.length;
  let depth = 0;
  let sawTopLevelColon = false;
  let sawTopLevelQuestion = false;

  for (let i = start; i < n; i += 1) {
    const c = source[i];
    if (c === "\\") {
      i += 1;
      continue;
    }
    if (c === "\n") return undefined;
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      i += 1;
      while (i < n && source[i] !== quote) {
        if (source[i] === "\\") i += 1;
        i += 1;
      }
      continue;
    }
    if (c === "{") {
      depth += 1;
      continue;
    }
    if (c === ":" && depth === 1) {
      sawTopLevelColon = true;
      continue;
    }
    if (c === "?" && depth === 1) {
      sawTopLevelQuestion = true;
      continue;
    }
    if (c === "}") {
      depth -= 1;
      if (depth === 0) {
        const inner = source.slice(start + 1, i);
        if (inner.length === 0 || inner.length > 200) return undefined;
        // A top-level `:` means this is CSS or JSON, not an expression --
        // unless the expression is a ternary, whose `:` is preceded by a `?`.
        if (sawTopLevelColon && !sawTopLevelQuestion) return undefined;
        return i;
      }
    }
  }
  return undefined;
}

let total = 0;
const changed = [];

for (const file of files.sort()) {
  const source = await readFile(file, "utf8");
  const candidates = candidateBraces(source);
  if (candidates.length === 0) continue;

  // Collect insertion points, right to left so earlier indices stay valid.
  const inserts = [];
  for (const pos of candidates) {
    if (source[pos - 1] === "$") continue;
    if (interpolationEnd(source, pos) !== undefined) inserts.push(pos);
  }
  if (inserts.length === 0) continue;

  const chars = [...source];
  for (const pos of inserts.reverse()) chars.splice(pos, 0, "$");
  const text = chars.join("");

  total += inserts.length;
  changed.push(
    `${relative(process.cwd(), file).replace(/\\/g, "/")}: ${inserts.length}`,
  );
  if (WRITE) await writeFile(file, text, "utf8");
}

console.log(`${WRITE ? "repaired" : "would repair"} ${total} interpolation(s)`);
for (const line of changed) console.log("  " + line);
