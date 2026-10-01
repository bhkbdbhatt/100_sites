/**
 * Page assembly: spec pages + resolved assets -> HTML documents.
 *
 * Exactly one `<h1>` per page (FR-C20 a11y hard gate). The hero renders the h1
 * from the page title when a hero is present; otherwise the renderer injects a
 * visible heading so no page ships without one.
 */

import type { PageSpec, SiteSpec } from "@pg/spec-compiler";
import type { ResolvedAsset } from "../assets/resolver.js";
import { renderBlock, type RenderContext } from "./blocks.js";
import { renderDocument } from "./document.js";
import { escapeHtml } from "../html.js";

export interface PageRenderResult {
  path: string;
  html: string;
  /** Title text wrapped in h1 - used for OG and heading-order assertions. */
  h1: string;
  blockCount: number;
  degradedBlocks: string[];
  propsIssues: number;
}

function titleH1(page: PageSpec): string {
  return `<h1 id="page-title" class="page-title">${escapeHtml(page.title)}</h1>`;
}

export function renderPage(
  page: PageSpec,
  spec: SiteSpec,
  assets: Map<string, ResolvedAsset>,
): PageRenderResult {
  const context: RenderContext = { assets, externalRequests: 0, locale: spec.meta.locale };
  const degradedBlocks: string[] = [];
  let propsIssues = 0;
  const parts: string[] = [titleH1(page)];

  for (const block of page.blocks) {
    const outcome = renderBlock(block, context);
    propsIssues += outcome.propsIssues;
    if (outcome.effectiveType !== block.type) degradedBlocks.push(`${block.type}->${outcome.effectiveType}`);
    parts.push(outcome.html);
  }

  const body = parts.join("\n");
  const shell = renderDocument(page, { spec, assets });
  const html = shell.replace("<!--blocks-->", body);

  return {
    path: page.path,
    html,
    h1: page.title,
    blockCount: page.blocks.length,
    degradedBlocks,
    propsIssues,
  };
}

export function renderAllPages(
  spec: SiteSpec,
  assets: Map<string, ResolvedAsset>,
): PageRenderResult[] {
  return spec.pages.map((page) => renderPage(page, spec, assets));
}
