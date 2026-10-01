/**
 * The block vocabulary is the contract between the compiler (which decides
 * *what* to render) and the adapter (which decides *how*). Both sides import
 * this module so a block can never be emitted that the adapter cannot name.
 */

export const BLOCK_TYPES = [
  "hero",
  "feature_grid",
  "pricing_table",
  "faq",
  "cta",
  "stat_row",
  "testimonial",
  "gallery",
  "prose",
  "logo_wall",
  "team",
  "contact_form",
  "timeline",
  "comparison",
  "newsletter_signup",
] as const;

export type BlockType = (typeof BLOCK_TYPES)[number];

export function isBlockType(value: unknown): value is BlockType {
  return typeof value === "string" && (BLOCK_TYPES as readonly string[]).includes(value);
}

export const PAGE_ARCHETYPES = [
  "landing",
  "pricing",
  "about",
  "contact",
  "faq",
  "legal",
  "blog_index",
  "blog_post",
  "custom",
] as const;

export type PageArchetype = (typeof PAGE_ARCHETYPES)[number];

export const ASSET_ROLES = [
  "hero",
  "feature",
  "portrait",
  "product",
  "background",
  "logo",
  "og",
] as const;

export type AssetRole = (typeof ASSET_ROLES)[number];

export const ASPECT_RATIOS = ["1:1", "4:3", "3:2", "16:9", "3:4", "2:3"] as const;

export type AspectRatio = (typeof ASPECT_RATIOS)[number];

export const INTEGRATIONS = ["rss", "analytics", "newsletter", "cms", "i18n"] as const;

export type Integration = (typeof INTEGRATIONS)[number];

/**
 * Degradation ladder for blocks an adapter does not implement (section 5.2).
 * A block is never simply dropped: the conversion goal survives the substitution,
 * which is why the worst case is `prose` and not "missing section".
 */
export const BLOCK_DEGRADATION: Readonly<Record<BlockType, BlockType>> = Object.freeze({
  hero: "prose",
  feature_grid: "prose",
  pricing_table: "feature_grid",
  faq: "prose",
  cta: "prose",
  stat_row: "prose",
  testimonial: "prose",
  gallery: "feature_grid",
  prose: "prose",
  logo_wall: "gallery",
  team: "prose",
  contact_form: "prose",
  timeline: "prose",
  comparison: "feature_grid",
  newsletter_signup: "cta",
});

/** Blocks that must never silently disappear: dropping one loses the conversion. */
export const CONVERSION_CRITICAL: ReadonlySet<BlockType> = new Set<BlockType>([
  "hero",
  "cta",
  "newsletter_signup",
  "contact_form",
  "pricing_table",
]);

/** Design archetypes the template ships. The compiler picks one; the CSS validates all. */
export const DESIGN_ARCHETYPES = [
  "editorial",
  "commerce",
  "saas",
  "studio",
  "wellness",
  "industrial",
  "minimal",
  "bold",
] as const;

export type DesignArchetype = (typeof DESIGN_ARCHETYPES)[number];

export function isDesignArchetype(value: unknown): value is DesignArchetype {
  return typeof value === "string" && (DESIGN_ARCHETYPES as readonly string[]).includes(value);
}

/**
 * Machine-readable description of what an adapter can render. The orchestrator
 * calls this once per template version (FR-C2) and caches it for the batch.
 */
export interface AdapterCapabilities {
  adapter: string;
  version: string;
  template: { name: string; version: string; range: string };
  ssg: { name: string; version: string; driver: "astro" | "static" };
  blocks: BlockType[];
  pageArchetypes: PageArchetype[];
  features: {
    view_transitions: boolean;
    rss: boolean;
    i18n: boolean;
    cms: boolean;
    analytics: boolean;
    newsletter: boolean;
    zero_js: boolean;
    local_search: boolean;
  };
  max_pages: number;
  max_blocks_per_page: number;
  asset_resolvers: Array<"local" | "remote" | "placeholder">;
  budget_defaults: {
    max_bundle_kb: number;
    max_pages: number;
    max_build_ms: number;
    max_lcp_ms: number;
    max_cls: number;
  };
}
