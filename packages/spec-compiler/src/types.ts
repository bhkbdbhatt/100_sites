/** Component A wire types. The JSON Schema in @pg/spec-schema is the contract; these mirror it for the compiler's own use. */

import type { AspectRatio, AssetRole, BlockType, Diagnostic, Integration, PageArchetype } from "@pg/spec-schema";

export interface CompileRequest {
  site_id: string;
  prompt: string;
  context?: {
    brand?: { name?: string; tagline?: string; colors?: string[]; logo_slot?: string };
    audience?: string;
    locale?: string;
    keywords?: string[];
    references?: string[];
  };
  constraints?: {
    template?: string;
    ssg_target?: "astro" | "zola" | "eleventy";
    max_pages?: number;
    required_sections?: string[];
    banned_sections?: string[];
    banned_components?: string[];
    allow_external_js?: boolean;
    integrations?: Integration[];
  };
  compile_options?: {
    schema_version?: "1.0.0";
    model_tier?: "fast" | "standard" | "premium";
    seed?: number;
    max_output_tokens?: number;
    max_repair_attempts?: number;
    allow_fallback?: boolean;
    budget_usd?: number;
    provider?: "openai-compatible" | "deterministic";
  };
}

export interface SpecMeta {
  title: string;
  description: string;
  locale: string;
  theme: "light" | "dark" | "auto";
  industry?: string;
  audience?: string;
  brand_name?: string;
  tagline?: string;
}

export interface ColorRole {
  bg: string;
  surface: string;
  text: string;
  muted: string;
  accent: string;
  accent_fg: string;
  border: string;
  dark_bg?: string;
  dark_surface?: string;
  dark_text?: string;
  dark_muted?: string;
  dark_accent?: string;
  dark_border?: string;
}

export interface DesignTokens {
  color: ColorRole;
  type: {
    font_heading?: string;
    font_body?: string;
    scale: number[];
    weight_heading?: number;
    line_height?: number;
  };
  space: number[];
  radius: { sm?: number; md?: number; lg?: number; pill?: number };
}

export interface ContentBlock {
  id: string;
  type: BlockType;
  props: Record<string, unknown>;
  locale?: string;
  unverified?: boolean;
}

export interface PageSpec {
  path: string;
  title: string;
  archetype: PageArchetype;
  purpose?: string;
  blocks: ContentBlock[];
  seo: {
    title: string;
    description: string;
    canonical?: string;
    noindex?: boolean;
    og_image_slot?: string;
    jsonld?: Array<Record<string, unknown>>;
  };
}

export interface AssetSlot {
  slot_id: string;
  role: AssetRole;
  alt: string;
  aspect_ratio: AspectRatio;
  source_query: string;
  dominant_hint?: string;
}

export interface SiteSpec {
  meta: SpecMeta;
  design: { archetype: string; rationale?: string; tokens: DesignTokens };
  pages: PageSpec[];
  seo: {
    sitemap: boolean;
    robots: string;
    default_og_image_slot?: string;
    organization?: { name?: string; url?: string; logo_slot?: string };
  };
  assets: AssetSlot[];
  build: {
    trailing_slash: "always" | "never" | "ignore";
    minify: boolean;
    redirects?: Array<{ from: string; to: string; status?: number }>;
    headers?: Array<{ name: string; value: string }>;
    integrations?: Integration[];
  };
  compliance?: { max_js_kb?: number; contrast_min?: number };
}

export interface SpecProvenance {
  spec_version: "1.0.0";
  spec_hash: string;
  compiler_version: string;
  prompt_hash?: string;
  model_id?: string;
  model_tier?: "fast" | "standard" | "premium";
  token_usage?: { input: number; output: number };
  cost_usd?: number;
  latency_ms?: number;
  repair_attempts?: number;
  redactions?: number;
  cache?: "hit" | "miss" | "bypass";
  degraded: boolean;
  fallback_depth?: number;
  warnings?: Diagnostic[];
}

export interface SpecEnvelope {
  spec: SiteSpec;
  meta: SpecProvenance;
}

/** Structured intent, extracted before the model is consulted (FR-A4). */
export interface Intent {
  siteId: string;
  brandName: string;
  tagline: string;
  industry: string;
  audience: string;
  tone: string;
  locale: string;
  keywords: string[];
  archetype: string;
  conversionGoal: "signup" | "purchase" | "contact" | "download" | "inform";
  sections: string[];
  seed: number;
  sanitizedPrompt: string;
  redactions: number;
  injectionFindings: number;
  promptHash: string;
}

export const COMPILER_VERSION = "1.0.0";
