/**
 * Spec canonicalization (FR-A13) and provenance-free hashing (FR-A14).
 *
 * Canonicalization is what makes `spec_hash` a stable identity: without it, a
 * model that happens to order two blocks differently, or a repair pass that
 * reorders page properties, would produce a "different" site and defeat both
 * the cache and the artifact dedupe in component B.
 */

import { canonicalize, normalizePath, parseBlockProps, slugify, type BlockType } from "@pg/spec-schema";
import type { AssetSlot, ContentBlock, PageSpec, SiteSpec } from "./types.js";

const DEFAULT_KEY_ORDER: Record<string, number> = {
  meta: 0,
  design: 1,
  pages: 2,
  seo: 3,
  assets: 4,
  build: 5,
  compliance: 6,
};

function sortKeysRecursively(value: unknown, order: Record<string, number> = DEFAULT_KEY_ORDER): unknown {
  if (Array.isArray(value)) return value.map((item) => sortKeysRecursively(item, order));
  if (value === null || typeof value !== "object") return value;
  const entries = Object.entries(value as Record<string, unknown>).filter(([, member]) => member !== undefined);
  entries.sort((a, b) => {
    const rankA = order[a[0]] ?? 100 + Object.keys(order).length;
    const rankB = order[b[0]] ?? 100 + Object.keys(order).length;
    if (rankA !== rankB) return rankA - rankB;
    return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
  });
  const out: Record<string, unknown> = {};
  for (const [key, member] of entries) out[key] = sortKeysRecursively(member, order);
  return out;
}

function canonicalBlock(block: ContentBlock, pagePath: string, seen: Set<string>): ContentBlock {
  let id = slugify(block.id || block.type, 40).replace(/-/g, "_");
  if (id === "" || id === "page_x") id = block.type.replace(/-/g, "_");
  let candidate = id;
  let suffix = 2;
  while (seen.has(candidate)) {
    candidate = `${id}_${suffix}`;
    suffix += 1;
  }
  seen.add(candidate);

  const parsed = parseBlockProps(block.type as BlockType, block.props);
  const out: ContentBlock = { id: candidate, type: block.type, props: sortKeysRecursively(parsed.props) as Record<string, unknown> };
  if (block.locale) out.locale = block.locale;
  if (block.unverified) out.unverified = true;
  void pagePath;
  return out;
}

function canonicalPage(page: PageSpec, seenBlockIds: Set<string>): PageSpec {
  const path = normalizePath(page.path);
  const blocks = page.blocks.map((block) => canonicalBlock(block, path, seenBlockIds));
  const out: PageSpec = {
    path,
    title: page.title.trim().replace(/\s+/g, " "),
    archetype: page.archetype,
    blocks,
    seo: {
      title: page.seo.title.trim(),
      description: page.seo.description.trim(),
      ...(page.seo.canonical ? { canonical: normalizePath(page.seo.canonical) } : {}),
      ...(page.seo.noindex ? { noindex: true } : {}),
      ...(page.seo.og_image_slot ? { og_image_slot: page.seo.og_image_slot } : {}),
      ...(page.seo.jsonld && page.seo.jsonld.length > 0 ? { jsonld: page.seo.jsonld } : {}),
    },
  };
  if (page.purpose) out.purpose = page.purpose.trim();
  return out;
}

/**
 * Slot ids keep hyphens. `slugify` permits them, the AssetSlot pattern permits
 * them, and rewriting them here would silently break every `image_slot` /
 * `slots[]` reference in the block props, because those references are
 * string keys that this function has no way to rewrite in lockstep.
 */
function canonicalAsset(asset: AssetSlot): AssetSlot {
  return {
    slot_id: slugify(asset.slot_id, 40),
    role: asset.role,
    alt: asset.alt.trim().replace(/\s+/g, " "),
    aspect_ratio: asset.aspect_ratio,
    source_query: asset.source_query.trim().replace(/\s+/g, " "),
    ...(asset.dominant_hint ? { dominant_hint: asset.dominant_hint.trim() } : {}),
  };
}

/**
 * Full normalization pass. Pure: returns a new object, never mutates input.
 * Ordering is total, so two runs that agree semantically hash identically.
 */
export function canonicalizeSpec(spec: SiteSpec): SiteSpec {
  const seenPaths = new Set<string>();
  const seenBlockIds = new Set<string>();

  const pages = spec.pages
    .map((page) => canonicalPage(page, seenBlockIds))
    .filter((page) => {
      if (seenPaths.has(page.path)) return false;
      seenPaths.add(page.path);
      return true;
    })
    .sort((a, b) => (a.path === "/" ? -1 : b.path === "/" ? 1 : a.path < b.path ? -1 : 1));

  const seenSlots = new Set<string>();
  const assets = spec.assets
    .map(canonicalAsset)
    .filter((asset) => {
      if (seenSlots.has(asset.slot_id)) return false;
      seenSlots.add(asset.slot_id);
      return true;
    })
    .sort((a, b) => (a.slot_id < b.slot_id ? -1 : a.slot_id > b.slot_id ? 1 : 0));

  const canonical: SiteSpec = {
    meta: {
      title: spec.meta.title.trim().replace(/\s+/g, " "),
      description: spec.meta.description.trim().replace(/\s+/g, " "),
      locale: spec.meta.locale,
      theme: spec.meta.theme,
      ...(spec.meta.industry ? { industry: spec.meta.industry } : {}),
      ...(spec.meta.audience ? { audience: spec.meta.audience } : {}),
      ...(spec.meta.brand_name ? { brand_name: spec.meta.brand_name } : {}),
      ...(spec.meta.tagline ? { tagline: spec.meta.tagline } : {}),
    },
    design: {
      archetype: spec.design.archetype,
      ...(spec.design.rationale ? { rationale: spec.design.rationale } : {}),
      tokens: spec.design.tokens,
    },
    pages,
    seo: {
      sitemap: spec.seo.sitemap,
      robots: spec.seo.robots,
      ...(spec.seo.default_og_image_slot ? { default_og_image_slot: spec.seo.default_og_image_slot } : {}),
      ...(spec.seo.organization
        ? {
            organization: {
              ...(spec.seo.organization.name ? { name: spec.seo.organization.name } : {}),
              ...(spec.seo.organization.url ? { url: spec.seo.organization.url } : {}),
              ...(spec.seo.organization.logo_slot ? { logo_slot: spec.seo.organization.logo_slot } : {}),
            },
          }
        : {}),
    },
    assets,
    build: {
      trailing_slash: spec.build.trailing_slash,
      minify: spec.build.minify,
      ...(spec.build.redirects && spec.build.redirects.length > 0 ? { redirects: spec.build.redirects } : {}),
      ...(spec.build.headers && spec.build.headers.length > 0 ? { headers: spec.build.headers } : {}),
      ...(spec.build.integrations && spec.build.integrations.length > 0 ? { integrations: spec.build.integrations } : {}),
    },
    ...(spec.compliance
      ? {
          compliance: {
            ...(spec.compliance.max_js_kb !== undefined ? { max_js_kb: spec.compliance.max_js_kb } : {}),
            ...(spec.compliance.contrast_min !== undefined ? { contrast_min: spec.compliance.contrast_min } : {}),
          },
        }
      : {}),
  };

  return sortKeysRecursively(canonical) as SiteSpec;
}

export const MAX_SPEC_BYTES = 1024 * 1024;

/** NFR-A19: refuse to propagate a model-driven output amplification. */
export function assertSpecSize(spec: SiteSpec): number {
  const bytes = Buffer.byteLength(canonicalize(spec), "utf8");
  return bytes;
}
