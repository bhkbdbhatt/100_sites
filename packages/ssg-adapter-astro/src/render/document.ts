/**
 * The document shell: header, nav, footer, SEO head, optional JSON-LD (FR-C11).
 * No JavaScript is emitted here or anywhere else; NFR-C9 caps JS at 0 kB.
 */

import type { PageSpec, SiteSpec } from "@pg/spec-compiler";
import type { ResolvedAsset } from "../assets/resolver.js";
import { attrs, escapeHtml, escapeJsonLd, safeUrl, secondsToIso } from "../html.js";

export interface DocumentContext {
  spec: SiteSpec;
  assets: Map<string, ResolvedAsset>;
  /** Set on the page containing the hero so OG images resolve. */
  siteUrl?: string;
}

/**
 * Navigation label. Page titles carry a ` - Brand` suffix for the document
 * title; repeating it on every nav item reads as noise, so the suffix is
 * stripped here and the full title stays available for the h1 and <title>.
 */
function navLabel(page: PageSpec, brand: string): string {
  if (page.path === "/") return "Home";
  const suffix = ` -${brand}`;
  return page.title.endsWith(suffix) ? page.title.slice(0, -suffix.length) : page.title;
}

function navHtml(spec: SiteSpec, currentPath: string): string {
  const brand = spec.meta.brand_name || spec.meta.title;
  const links = spec.pages
    .filter((page) => page.archetype !== "legal" || spec.pages.length <= 6)
    .slice(0, 8)
    .map((page) => {
      const isCurrent = page.path === currentPath;
      return `<li><a ${attrs({ href: safeUrl(page.path), "aria-current": isCurrent ? "page" : undefined })}>${escapeHtml(navLabel(page, brand))}</a></li>`;
    })
    .join("");
  if (links === "") return "";
  return `<nav aria-label="Primary"><ul class="nav">${links}</ul></nav>`;
}

function footerHtml(spec: SiteSpec): string {
  const brand = spec.meta.brand_name || spec.meta.title;
  // No year: a timestamp in the footer would make the output differ between two
  // builds of the same spec and break the determinism requirement (FR-C23).
  return `<footer><p>&copy;${escapeHtml(brand)}</p></footer>`;
}

export function renderDocument(page: PageSpec, ctx: DocumentContext): string {
  const { spec } = ctx;
  const title = page.seo.title || `${page.title} | ${spec.meta.brand_name || spec.meta.title}`;
  const description = page.seo.description || spec.meta.description;
  const themeColor = spec.design.tokens.color.accent;

  const ogSlotId = page.seo.og_image_slot ?? spec.seo.default_og_image_slot;
  const og = ogSlotId ? ctx.assets.get(ogSlotId) : undefined;

  const jsonLdBlocks: string[] = [];
  if (page.archetype === "landing" || page.path === "/") {
    const org = {
      "@context": "https://schema.org",
      "@type": "Organization",
      name: spec.meta.brand_name || spec.meta.title,
      ...(spec.seo.organization?.url ? { url: spec.seo.organization.url } : {}),
      ...(spec.seo.organization?.logo_slot && ctx.assets.get(spec.seo.organization.logo_slot)
        ? { logo: "/" + ctx.assets.get(spec.seo.organization.logo_slot)!.path }
        : {}),
      ...(spec.meta.description ? { description: spec.meta.description } : {}),
    };
    jsonLdBlocks.push(escapeJsonLd(org));
  }
  if (page.seo.jsonld) {
    for (const node of page.seo.jsonld) jsonLdBlocks.push(escapeJsonLd(node));
  }

  const robots = page.seo.noindex ? "noindex,nofollow" : spec.seo.robots;

  const head = [
    `<meta charset="utf-8">`,
    `<meta name="viewport" content="width=device-width, initial-scale=1">`,
    `<title>${escapeHtml(title)}</title>`,
    `<meta name="description" content="${escapeHtml(description)}">`,
    `<meta name="robots" content="${escapeHtml(robots)}">`,
    `<meta name="theme-color" content="${escapeHtml(themeColor)}">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:title" content="${escapeHtml(title)}">`,
    `<meta property="og:description" content="${escapeHtml(description)}">`,
    og ? `<meta property="og:image" content="/${escapeHtml(og.path)}">` : "",
    `<meta name="twitter:card" content="summary_large_image">`,
    page.seo.canonical ? `<link rel="canonical" href="${safeUrl(page.seo.canonical)}">` : "",
    `<link rel="stylesheet" href="/css/main.css">`,
    ...jsonLdBlocks.map((json) => `<script type="application/ld+json">${json}</script>`),
  ].join("");

  const body = [
    `<a href="#main" class="visually-hidden">Skip to content</a>`,
    `<header class="site-header">`,
    `<a href="/" class="brand">${escapeHtml(spec.meta.brand_name || spec.meta.title)}</a>`,
    navHtml(spec, page.path),
    `</header>`,
    `<main id="main">`,
    `<!--blocks-->`,
    `</main>`,
    footerHtml(spec),
  ].join("");

  return `<!doctype html>\n<html lang="${escapeHtml(spec.meta.locale)}">\n<head>${head}</head>\n<body>${body}</body>\n</html>\n`;
}

export { secondsToIso };
