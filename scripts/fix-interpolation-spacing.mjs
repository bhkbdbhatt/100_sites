#!/usr/bin/env node
/**
 * Companion to repair-interpolations.mjs.
 *
 * The same corruption that stripped `$` also ate the space in front of it, so
 * recovered strings read `plan:100` instead of `plan: 100`. TypeScript cannot
 * catch this -- the result is still a valid template literal -- and it only
 * shows up in human-facing output.
 *
 * Only template *text* is eligible. Interpolation bodies are skipped wholesale,
 * which is what keeps composed identifiers intact: in
 * `` `${job.batch_id}:${prompt.site_id}` `` the `:` sits inside the first
 * expression and the two fragments must stay glued.
 *
 * Within template text a `${` preceded by a letter, digit, `:` or `|` lost its
 * separating space. These stay glued because the preceding character is not in
 * that set:
 *
 *   }${"{"}   adjacent interpolation   ${a}${"{"}${b}
 *   _${"{"}   identifier join           ${id}_${"{"}${suffix}
 *   .${"{"}   dotted path               a.${"{"}${b}
 *   -${"{"}   slug / kebab              ${slug}-${"{"}${n}
 *
 *   node scripts/fix-interpolation-spacing.mjs [--write]
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

const NEEDS_SPACE_BEFORE = /[A-Za-z0-9:|]/;

/**
 * Machine-readable prefixes that must stay glued to their value. These are not
 * prose, so `blake3:${hash}` keeps its shape: the spec_hash contract is
 * `<algorithm>:<hex>` and the adapter compares it as a string.
 */
const IDENTIFIER_PREFIXES = new Set([
  "blake3",
  "sha256",
  "sha512",
  "http",
  "https",
  "mailto",
  "urn",
  "id",
  "uuid",
]);

/** Returns the bare word ending at `end`, or "" if it is not word-like. */
function wordBefore(source, end) {
  let start = end;
  while (start > 0 && /[A-Za-z0-9_]/.test(source[start - 1])) start -= 1;
  return /^[A-Za-z][A-Za-z0-9_]*$/.test(source.slice(start, end)) ? source.slice(start, end) : "";
}

/**
 * True when the expression at `dollar` is a conditional append that already
 * supplies its own leading space, e.g. `class="plan${hit ? " on" : ""}"`.
 * Adding a space outside it would yield a double space.
 */
function suppliesItsOwnSpace(source, dollar) {
  const body = source.slice(dollar, skipInterpolation(source, dollar));
  const match = /\?\s*(["'`])([^"'`]*)\1/.exec(body);
  return match !== null && match[2].startsWith(" ");
}

/** Skips a `${...}` expression body starting at the `$`. Returns index past `}`. */
function skipInterpolation(source, dollar) {
  const n = source.length;
  let depth = 0;
  let i = dollar + 1; // at `{`
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
 * Offsets of `$` characters that open an interpolation from template text and
 * whose preceding character should have been followed by a space.
 */
function spacingOffsets(source) {
  const offsets = [];
  const n = source.length;
  let i = 0;

  while (i < n) {
    const c = source[i];

    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "/" && source[i + 1] === "/") {
      const end = source.indexOf("\n", i);
      i = end === -1 ? n : end;
      continue;
    }
    if (c === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      i += 1;
      while (i < n && source[i] !== c) {
        if (source[i] === "\\") i += 1;
        i += 1;
      }
      i += 1;
      continue;
    }
    if (c === "`") {
      i += 1;
      while (i < n) {
        if (source[i] === "\\") {
          i += 2;
          continue;
        }
        if (source[i] === "$" && source[i + 1] === "{") {
          // Composed identifiers glue a separator directly onto the previous
          // fragment: `${job.batch_id}:${prompt.site_id}`. The `}` before the
          // `:` gives that away, so leave it alone.
          const composed = source[i - 1] === ":" && source[i - 2] === "}";
          // An escape sequence such as `\n\n${USAGE}` ends in a letter but is
          // a newline, not a word.
          const afterEscape = source[i - 2] === "\\";

          // A conditional append like `plan${hit ? " on" : ""}` already
          // includes its own separator.
          const selfSpaced = suppliesItsOwnSpace(source, i);

          // `blake3:${hash}` and friends are structured values, not prose.
          const structured =
            source[i - 1] === ":" && IDENTIFIER_PREFIXES.has(wordBefore(source, i - 1));

          // `a|${b}|${c}` is a delimited seed; inserting spaces changes the hash.
          const delimited = source[i - 1] === "|" && source[i - 2] === "}";

          // SVG geometry is positional: `viewBox="0 0${w} ${h}"` must stay
          // `0 0 W H`, and a space here would make the attribute invalid.
          const positional = /[\d.]\s+0$/.test(source.slice(Math.max(0, i - 10), i));

          if (
            !composed &&
            !afterEscape &&
            !selfSpaced &&
            !structured &&
            !delimited &&
            !positional &&
            i > 0 &&
            NEEDS_SPACE_BEFORE.test(source[i - 1])
          ) {
            offsets.push(i);
          }
          i = skipInterpolation(source, i);
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
  return offsets;
}

let total = 0;

for (const file of files.sort()) {
  const source = await readFile(file, "utf8");
  const offsets = spacingOffsets(source);
  if (offsets.length === 0) continue;

  const chars = [...source];
  for (const offset of offsets.reverse()) chars.splice(offset, 0, " ");
  const updated = chars.join("");

  total += offsets.length;
  console.log(`${relative(process.cwd(), file).replace(/\\/g, "/")}: ${offsets.length}`);

  const beforeLines = source.split("\n");
  const afterLines = updated.split("\n");
  for (let i = 0; i < beforeLines.length; i += 1) {
    if (beforeLines[i] === afterLines[i]) continue;
    console.log(`    - ${beforeLines[i].trim()}`);
    console.log(`    + ${afterLines[i].trim()}`);
  }

  if (WRITE) await writeFile(file, updated, "utf8");
}

console.log(`${WRITE ? "spaced" : "would space"} ${total} interpolation(s)`);
