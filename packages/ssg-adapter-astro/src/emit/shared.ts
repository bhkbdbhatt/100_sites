/**
 * Shared emitter plumbing: safe path resolution, deterministic file writing,
 * robots/sitemap/RSS/404 generation.
 *
 * Every path that reaches the filesystem goes through `resolveWithin` from
 * @pg/spec-schema, so a spec that smuggles `../../etc` fails loudly (FR-C17)
 * instead of writing outside the site root.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { resolveWithin } from "@pg/spec-schema";
import type { PageSpec, SiteSpec } from "@pg/spec-compiler";
import { cError } from "../errors.js";
import { escapeHtml } from "../html.js";
import type { PageRenderResult } from "../render/page.js";

export interface EmitTarget {
  outDir: string;
  /** Pages already rendered, keyed by spec path. */
  pages: Map<string, PageRenderResult>;
  spec: SiteSpec;
  minify: boolean;
}

/** "/pricing/" -> "pricing/index.html", "/" -> "index.html" (FR-C10). */
export function outputPathFor(pagePath: string, trailingSlash: "always" | "never" | "ignore"): string {
  const segments = pagePath.split("/").filter((segment) => segment.length > 0);
  if (segments.length === 0) return "index.html";
  if (trailingSlash === "always" || trailingSlash === "ignore") {
    return posix.join(segments.join("/"), "index.html");
  }
  return segments.join("/") + ".html";
}

export async function writeWithin(outDir: string, relativePath: string, contents: string | Uint8Array): Promise<string> {
  let target: string;
  try {
    target = resolveWithin(outDir, relativePath);
  } catch (error) {
    throw cError("E_C_PATH_ESCAPE", `refusing to write '${relativePath}': ${(error as Error).message}`);
  }
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, contents);
  return target;
}

export function sitemapXml(spec: SiteSpec): string {
  const urls = spec.pages
    .filter((page) => !page.seo.noindex)
    .map((page) => {
      const loc = escapeHtml(page.seo.canonical ?? page.path);
      return `  <url><loc>${loc}</loc>${page.seo.title ? `<title>${escapeHtml(page.seo.title)}</title>` : ""}</url>`;
    })
    .join("\n");
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`,
    urls,
    `</urlset>`,
    ``,
  ].join("\n");
}

export function robotsTxt(spec: SiteSpec): string {
  return [`User-agent: *`, `Allow: /`, spec.seo.robots.includes("noindex") ? "Disallow: /" : "", ``].join("\n");
}

export function rssXml(spec: SiteSpec, pages: Map<string, PageRenderResult>): string {
  const posts = spec.pages.filter((page) => page.archetype === "blog_post");
  if (posts.length === 0) return "";
  const items = posts
    .map((page) =>
      [
        "    <item>",
        `      <title>${escapeHtml(page.title)}</title>`,
        `      <link>${escapeHtml(page.seo.canonical ?? page.path)}</link>`,
        `      <guid isPermaLink="true">${escapeHtml(page.seo.canonical ?? page.path)}</guid>`,
        `      <description>${escapeHtml(page.seo.description)}</description>`,
        "    </item>",
      ].join("\n"),
    )
    .join("\n");
  void pages;
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<rss version="2.0">`,
    "  <channel>",
    `    <title>${escapeHtml(spec.meta.title)}</title>`,
    `    <link>/</link>`,
    `    <description>${escapeHtml(spec.meta.description)}</description>`,
    items,
    "  </channel>",
    `</rss>`,
    ``,
  ].join("\n");
}

export function notFoundHtml(spec: SiteSpec): string {
  return [
    `<!doctype html>`,
    `<html lang="${escapeHtml(spec.meta.locale)}">`,
    `<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">`,
    `<title>Page not found | ${escapeHtml(spec.meta.title)}</title>`,
    `<meta name="robots" content="noindex">`,
    `<link rel="stylesheet" href="/css/main.css"></head>`,
    `<body><main id="main"><h1 id="page-title">Page not found</h1>`,
    `<p>The page you were looking for is not here.</p>`,
    `<p><a href="/">Back to ${escapeHtml(spec.meta.brand_name || spec.meta.title)}</a></p>`,
    `</main></body></html>`,
    ``,
  ].join("\n");
}

/**
 * A no-JavaScript redirect/notice document. `spec.build.redirects` is honoured
 * through real files rather than server config so static hosting works.
 */
export function redirectHtml(to: string, status: number): string {
  const canonical = escapeHtml(to);
  return [
    `<!doctype html>`,
    `<html lang="en">`,
    `<head><meta charset="utf-8"><meta http-equiv="refresh" content="${status}; url=${canonical}">`,
    `<link rel="canonical" href="${canonical}">`,
    `<meta name="robots" content="noindex">`,
    `<title>Redirecting</title></head>`,
    `<body><p>This page moved to <a href="${canonical}">${canonical}</a>.</p></body>`,
    `</html>`,
    ``,
  ].join("\n");
}

export function writeRedirects(outDir: string, redirects: Array<{ from: string; to: string; status?: number }>): Promise<string[]> {
  return Promise.all(
    redirects.map(async (redirect) => {
      const target = redirect.to.endsWith(".html") ? redirect.to : outputPathFor(redirect.to, "never");
      const source = redirect.from.endsWith(".html") ? redirect.from : outputPathFor(redirect.from, "never");
      await writeWithin(outDir, source, redirectHtml(target, redirect.status ?? 301));
      return source;
    }),
  );
}

export function siteHeadersFile(spec: SiteSpec): string {
  const lines = spec.build.headers?.map((header) => `${header.name}:${header.value}`) ?? [];
  lines.push("X-Content-Type-Options: nosniff", "Referrer-Policy: strict-origin-when-cross-origin");
  return lines.join("\n") + "\n";
}

export function joinUrl(...parts: string[]): string {
  return posix.join(...parts);
}

export { join };
