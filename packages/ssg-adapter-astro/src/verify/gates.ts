/**
 * Output gates (FR-C12 - FR-C16).
 *
 * Hard gates throw; soft gates return `warn` and surface a warning code. Every
 * gate inspects the *emitted bytes* rather than the in-memory model, because the
 * renderer and the gate are independent: a bug in the renderer must not be able
 * to talk its way past the checks.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, relative, resolve, sep } from "node:path";
import { contrastRatio } from "@pg/spec-compiler";
import type { DesignTokens } from "@pg/spec-compiler";
import { cError } from "../errors.js";
import type { PageRenderResult } from "../render/page.js";

export type GateStatus = "pass" | "warn" | "fail" | "skip";

export interface GateOutcome {
  status: GateStatus;
  detail?: string;
  warningCode?: string;
}

export const SKIP: GateOutcome = { status: "skip" };

/** Walk every file under `dir` and report path, byte size and sha256. */
export async function collectFiles(
  dir: string,
  root = dir,
): Promise<Array<{ path: string; bytes: number; sha256: string }>> {
  const out: Array<{ path: string; bytes: number; sha256: string }> = [];
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return out;
  }
  for (const entry of entries.sort()) {
    const full = join(dir, entry);
    const info = await stat(full);
    if (info.isDirectory()) {
      out.push(...(await collectFiles(full, root)));
    } else if (info.isFile()) {
      out.push({ path: relative(root, full).split(sep).join("/"), bytes: info.size, sha256: await sha256File(full) });
    }
  }
  return out;
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  hash.update(await readFile(path));
  return hash.digest("hex");
}

export interface BundleMetrics {
  total_bytes: number;
  css_bytes: number;
  js_bytes: number;
  image_bytes: number;
  image_count: number;
  largest_bundle_kb: number;
  largest_file: string;
  page_count: number;
}

export function bundleMetrics(files: ReadonlyArray<{ path: string; bytes: number }>): BundleMetrics {
  let css = 0;
  let js = 0;
  let images = 0;
  let imageCount = 0;
  let largest = { path: "", bytes: 0 };
  let total = 0;
  for (const file of files) {
    total += file.bytes;
    const ext = file.path.slice(file.path.lastIndexOf("."));
    if (ext === ".css") css += file.bytes;
    else if (ext === ".js" || ext === ".mjs") js += file.bytes;
    else if ([".jpg", ".jpeg", ".png", ".webp", ".avif", ".gif", ".svg"].includes(ext)) {
      images += file.bytes;
      imageCount += 1;
    }
    if (file.bytes > largest.bytes) largest = { path: file.path, bytes: file.bytes };
  }
  return {
    total_bytes: total,
    css_bytes: css,
    js_bytes: js,
    image_bytes: images,
    image_count: imageCount,
    largest_bundle_kb: Number((largest.bytes / 1024).toFixed(3)),
    largest_file: largest.path,
    page_count: files.filter((file) => file.path.endsWith(".html")).length,
  };
}

export function bundleGate(metrics: BundleMetrics, maxBundleKb: number, hard: boolean): GateOutcome {
  if (metrics.largest_bundle_kb > maxBundleKb) {
    if (hard) {
      throw cError(
        "E_C_BUDGET_EXCEEDED",
        `largest file is ${metrics.largest_bundle_kb} kB (${metrics.largest_file}); hard cap is ${maxBundleKb} kB`,
      );
    }
    return { status: "warn", detail: `largest file ${metrics.largest_bundle_kb} kB over ${maxBundleKb} kB`, warningCode: "W_C_BUDGET_SOFT_EXCEEDED" };
  }
  return { status: "pass", detail: `${metrics.largest_bundle_kb} kB <=${maxBundleKb} kB` };
}

export function pagesGate(pageCount: number, maxPages: number): GateOutcome {
  if (pageCount > maxPages) {
    throw cError("E_C_BUDGET_EXCEEDED", `emitted ${pageCount} pages; cap is ${maxPages}`);
  }
  return { status: "pass", detail: `${pageCount} pages <=${maxPages}` };
}

export function buildTimeGate(totalMs: number, maxBuildMs: number, hard: boolean): GateOutcome {
  if (totalMs > maxBuildMs) {
    if (hard) throw cError("E_C_BUDGET_EXCEEDED", `build took ${totalMs} ms; cap is ${maxBuildMs} ms`);
    return { status: "warn", detail: `${totalMs} ms >${maxBuildMs} ms`, warningCode: "W_C_BUDGET_SOFT_EXCEEDED" };
  }
  return { status: "pass", detail: `${totalMs} ms <=${maxBuildMs} ms` };
}

export function lcpGate(estimateMs: number, maxLcpMs: number): GateOutcome {
  if (estimateMs > maxLcpMs) {
    return { status: "warn", detail: `LCP estimate ${estimateMs} ms > ${maxLcpMs} ms`, warningCode: "W_C_BUDGET_SOFT_EXCEEDED" };
  }
  return { status: "pass", detail: `LCP estimate ${estimateMs} ms <= ${maxLcpMs} ms` };
}

export function clsGate(estimate: number, maxCls: number): GateOutcome {
  if (estimate > maxCls) {
    return { status: "warn", detail: `CLS estimate ${estimate} > ${maxCls}`, warningCode: "W_C_BUDGET_SOFT_EXCEEDED" };
  }
  return { status: "pass", detail: `CLS estimate ${estimate} <= ${maxCls}` };
}

/**
 * LCP/CLS estimates from the emitted structure. Not a substitute for a real
 * trace (FR-C14 accepts an estimate with the method recorded), but every input
 * is measurable from the bytes: CSS bytes on the critical path, the hero image
 * size, and whether any media element lacks explicit dimensions.
 */
export function estimateCoreWebVitals(pages: PageRenderResult[], cssBytes: number, heroBytes: number): { lcpMs: number; cls: number } {
  const connection = 1500;
  const transferMs = ((cssBytes + heroBytes) / 1024 / 1.5) * 8 * 8;
  const renderMs = 120;
  const lcpMs = Math.round(connection + transferMs + renderMs);
  // CLS is 0 when every img carries width/height, which the renderers guarantee.
  const missingDimensions = pages.reduce((total, page) => {
    const imgTags = page.html.match(/<img\b[^>]*>/g) ?? [];
    return total + imgTags.filter((tag) => !/\bwidth="\d+"/.test(tag) || !/\bheight="\d+"/.test(tag)).length;
  }, 0);
  const cls = Math.min(1, Number((missingDimensions * 0.02).toFixed(4)));
  return { lcpMs, cls };
}

export interface A11yReport extends GateOutcome {
  findings: Array<{ code: string; detail: string }>;
}

/**
 * Structural WCAG checks that can be decided from HTML alone (FR-C15).
 * Anything requiring a real AT is out of scope and reported as a soft warning
 * rather than silently passed.
 */
export function a11yGate(pages: PageRenderResult[], minContrast: number, tokens: DesignTokens): A11yReport {
  const findings: Array<{ code: string; detail: string }> = [];

  // Hard: contrast. A hard failure here would invalidate every page.
  const pairs: Array<[string, string, string]> = [
    ["text/bg", tokens.color.text, tokens.color.bg],
    ["text/surface", tokens.color.text, tokens.color.surface],
    ["muted/bg", tokens.color.muted, tokens.color.bg],
    ["accent_fg/accent", tokens.color.accent_fg, tokens.color.accent],
  ];
  for (const [label, fg, bg] of pairs) {
    const ratio = contrastRatio(fg, bg);
    if (ratio < minContrast) {
      findings.push({ code: "contrast", detail: `${label} is ${ratio}:1, below ${minContrast}:1` });
    }
  }

  // Hard: exactly one h1 per page, and a heading hierarchy with no skips.
  for (const page of pages) {
    const h1s = page.html.match(/<h1\b/g) ?? [];
    if (h1s.length !== 1) {
      findings.push({ code: "heading-count", detail: `${page.path} has ${h1s.length} h1 elements` });
    }
    const levels = [...page.html.matchAll(/<h([1-6])\b/g)].map((match) => Number(match[1]));
    let previous = 0;
    for (const level of levels) {
      if (previous !== 0 && level > previous + 1) {
        findings.push({ code: "heading-order", detail: `${page.path} jumps from h ${previous} to h ${level}` });
        break;
      }
      previous = level;
    }
  }

  // Hard: every image needs alt text; decorative art carries a title in the SVG.
  for (const page of pages) {
    for (const tag of page.html.match(/<img\b[^>]*>/g) ?? []) {
      if (!/\balt="[^"]*"/.test(tag)) {
        findings.push({ code: "img-alt", detail: `${page.path} has an img without alt` });
        break;
      }
    }
  }

  // Soft: landmarks and a skip link are template guarantees, but verify rather
  // than assume - a degraded page could plausibly lose them.
  const soft: Array<{ code: string; detail: string }> = [];
  for (const page of pages) {
    if (!/<main\b/.test(page.html)) soft.push({ code: "landmark-main", detail: `${page.path} has no <main>` });
    if (!/href="#main"/.test(page.html)) soft.push({ code: "skip-link", detail: `${page.path} has no skip link` });
    if (!/<html lang=/.test(page.html)) soft.push({ code: "html-lang", detail: `${page.path} has no lang attribute` });
  }

  const hardFindings = findings;
  if (hardFindings.length > 0) {
    throw cError(
      "E_C_A11Y_FAILED",
      `accessibility hard failures:${hardFindings.map((f) => f.detail).join("; ")}`,
      { errors: hardFindings.map((f) => ({ keyword: f.code, message: f.detail })) },
    );
  }
  if (soft.length > 0) {
    return { status: "warn", detail: soft[0]!.detail, warningCode: "W_C_A11Y_SOFT", findings: soft };
  }
  return { status: "pass", detail: "contrast, headings, alt text and landmarks verified", findings: [] };
}

/** Public entry so callers can compute the same ratios without the gate. */
export function contrastSummary(tokens: DesignTokens): Record<string, number> {
  const out: Record<string, number> = {};
  const pairs: Array<[string, string, string]> = [
    ["text/bg", tokens.color.text, tokens.color.bg],
    ["text/surface", tokens.color.text, tokens.color.surface],
    ["muted/bg", tokens.color.muted, tokens.color.bg],
    ["accent/bg", tokens.color.accent, tokens.color.bg],
    ["accent_fg/accent", tokens.color.accent_fg, tokens.color.accent],
  ];
  for (const [label, fg, bg] of pairs) {
    out[label] = contrastRatio(fg, bg);
  }
  return out;
}

const EXTERNAL_HREF = /(?:src|href)\s*=\s*"https?:\/\//gi;
// FR-A9 requires a canonical URL, and real multi-domain SEO setups use an
// absolute origin there. That is declarative metadata, not a third-party
// subresource the page loads, so it must not trip the hermeticity gate.
const CANONICAL_LINK = /<link\b[^>]*\brel\s*=\s*["']?canonical["']?[^>]*>/gi;
const DANGEROUS = [
  [/<script\b(?![^>]*application\/ld\+json)/i, "executable script element"],
  [/\son[a-z]+\s*=\s*"/i, "inline event handler attribute"],
  [/javascript:/i, "javascript: URL"],
  [/<\s*iframe/i, "iframe element"],
  [/<\s*object\b/i, "object element"],
  [/<\s*embed\b/i, "embed element"],
  [/expression\s*\(/i, "css expression()"],
  [/-moz-binding/i, "moz-binding"],
  [/data:text\/html/i, "data:text/html URI"],
] as const;

/**
 * Security gate (FR-C16, NFR-C22): no executable content, no third-party
 * references in the markup, no absolute filesystem paths leaking into output.
 */
export function securityGate(pages: PageRenderResult[], outDir: string): GateOutcome {
  const findings: string[] = [];
  const outPrefix = resolve(outDir).toLowerCase();
  for (const page of pages) {
    for (const [pattern, label] of DANGEROUS) {
      if (pattern.test(page.html)) findings.push(`${page.path}:${label}`);
    }
    const external = page.html.replace(CANONICAL_LINK, "").match(EXTERNAL_HREF);
    if (external) {
      findings.push(`${page.path}:${external.length} external reference(s), e.g. ${external[0]!.slice(0, 80)}`);
    }
    if (page.html.toLowerCase().includes(outPrefix)) {
      findings.push(`${page.path}: leaks the absolute output path`);
    }
  }
  if (findings.length > 0) {
    throw cError("E_C_SECURITY_VIOLATION", findings.join("; "), {
      errors: findings.map((detail) => ({ keyword: "security", message: detail })),
    });
  }
  return { status: "pass", detail: "no executable content and no external references" };
}

/** Spec fidelity: every page the spec declares was emitted (FR-C10). */
export function specFidelityGate(
  declaredPaths: string[],
  emittedPaths: string[],
  degradedBlocks: string[],
): GateOutcome {
  const missing = declaredPaths.filter((path) => !emittedPaths.includes(path));
  if (missing.length > 0) {
    throw cError("E_C_SPEC_INVALID", `spec declared pages that were not emitted:${missing.join(", ")}`);
  }
  const unexpected = emittedPaths.filter((path) => !declaredPaths.includes(path));
  if (unexpected.length > 0) {
    return { status: "warn", detail: `emitted undeclared pages:${unexpected.join(", ")}`, warningCode: "W_C_PAGE_UNEXPECTED" };
  }
  if (degradedBlocks.length > 0) {
    return {
      status: "warn",
      detail: `${degradedBlocks.length} block(s) rendered as a fallback type`,
      warningCode: "W_C_BLOCK_DOWNGRADED",
    };
  }
  return { status: "pass", detail: `${emittedPaths.length} pages match the spec` };
}

export { SKIP as SKIP_GATE };
