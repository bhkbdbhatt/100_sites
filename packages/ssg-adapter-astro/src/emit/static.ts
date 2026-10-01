/**
 * The hermetic static driver (FR-C9, NFR-C18, NFR-C21).
 *
 * This is the default driver. It has no toolchain to install, no plugin
 * resolution step, no lockfile to freeze and no chance of a network call, which
 * is what makes the per-site budget predictable: the whole build is
 * `render -> write -> hash`, measured in milliseconds, with no process spawn.
 *
 * Astro is offered as an alternative driver for teams that want the framework's
 * DX; it is not required for correctness and never required for the batch.
 */

import type { PageRenderResult } from "../render/page.js";
import { baseCss } from "../css/tokens.js";
import type { EmitTarget } from "./shared.js";
import {
  notFoundHtml,
  outputPathFor,
  rssXml,
  robotsTxt,
  siteHeadersFile,
  sitemapXml,
  writeRedirects,
  writeWithin,
} from "./shared.js";
import type { ResolvedAsset } from "../assets/resolver.js";

export interface StaticEmitResult {
  files: string[];
  pages: PageRenderResult[];
  /** True when at least one asset fell back to a generated placeholder. */
  degraded: boolean;
}

export async function emitStatic(
  target: EmitTarget,
  assets: Map<string, ResolvedAsset>,
): Promise<StaticEmitResult> {
  const { spec, outDir } = target;
  const written: string[] = [];

  // Pages. Trailing-slash handling comes from the spec, not the driver.
  for (const page of spec.pages) {
    const rendered = target.pages.get(page.path);
    if (!rendered) continue;
    const relative = outputPathFor(page.path, spec.build.trailing_slash);
    await writeWithin(outDir, relative, rendered.html);
    written.push(relative);
  }

  // Stylesheet. Single file, no external font fetches (NFR-C9).
  const css = baseCss(spec.design.tokens);
  await writeWithin(outDir, "css/main.css", css);
  written.push("css/main.css");

  // SEO surfaces.
  if (spec.seo.sitemap) {
    await writeWithin(outDir, "sitemap.xml", sitemapXml(spec));
    written.push("sitemap.xml");
  }
  await writeWithin(outDir, "robots.txt", robotsTxt(spec));
  written.push("robots.txt");
  await writeWithin(outDir, "404.html", notFoundHtml(spec));
  written.push("404.html");

  if ((spec.build.integrations ?? []).includes("rss")) {
    const rss = rssXml(spec, target.pages);
    if (rss !== "") {
      await writeWithin(outDir, "rss.xml", rss);
      written.push("rss.xml");
    }
  }

  if (spec.build.headers && spec.build.headers.length > 0) {
    await writeWithin(outDir, "_headers", siteHeadersFile(spec));
    written.push("_headers");
  }

  if (spec.build.redirects && spec.build.redirects.length > 0) {
    written.push(...(await writeRedirects(outDir, spec.build.redirects)));
  }

  const degraded = [...assets.values()].some((asset) => asset.tier === "placeholder");
  return { files: written, pages: [...target.pages.values()], degraded };
}
