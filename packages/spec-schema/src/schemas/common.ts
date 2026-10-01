/**
 * Shared JSON Schema 2020-12 fragments. All contracts are `additionalProperties:
 * false` at the root; the version-tolerant *reader* used by component B is
 * derived from these by relaxing that flag (see validate.ts).
 */

import { BLOCK_TYPES, PAGE_ARCHETYPES, ASSET_ROLES, ASPECT_RATIOS, INTEGRATIONS, DESIGN_ARCHETYPES } from "../blocks.js";

export const DIALECT = "https://json-schema.org/draft/2020-12/schema";

export const SCHEMA_BASE = "https://schemas.hundred.local";

export const SITE_ID = {
  type: "string",
  pattern: "^[a-z0-9](?:[a-z0-9-]{0,60}[a-z0-9])?$",
  minLength: 1,
  maxLength: 62,
} as const;

export const BATCH_ID = {
  type: "string",
  pattern: "^[a-z0-9][a-z0-9_-]{2,63}$",
} as const;

export const LOCALE = { type: "string", minLength: 2, maxLength: 35 } as const;

export const SPEC_VERSION = { type: "string", enum: ["1.0.0"] } as const;

export const SPEC_HASH = {
  type: "string",
  pattern: "^blake3:[0-9a-f]{64}$",
} as const;

export const ARTIFACT_HASH = {
  type: "string",
  pattern: "^sha256:[0-9a-f]{64}$",
} as const;

export const DIAGNOSTIC = {
  type: "object",
  additionalProperties: false,
  required: ["code", "severity", "message"],
  properties: {
    code: { type: "string", minLength: 3, maxLength: 64 },
    severity: { type: "string", enum: ["error", "warning"] },
    message: { type: "string", maxLength: 2000 },
    pointer: { type: "string", maxLength: 400 },
    source: { type: "string", enum: ["A", "B", "C", "SCHEMA"] },
  },
} as const;

export const SEO = {
  type: "object",
  additionalProperties: false,
  required: ["title", "description"],
  properties: {
    title: { type: "string", minLength: 1, maxLength: 70 },
    description: { type: "string", minLength: 1, maxLength: 200 },
    canonical: { type: "string", maxLength: 300 },
    noindex: { type: "boolean", default: false },
    og_image_slot: { type: "string", maxLength: 64 },
    jsonld: { type: "array", maxItems: 20, items: { type: "object" } },
  },
} as const;

export const CONTENT_BLOCK = {
  type: "object",
  additionalProperties: false,
  required: ["id", "type"],
  properties: {
    id: { type: "string", pattern: "^[a-z0-9_-]{1,40}$" },
    type: { type: "string", enum: [...BLOCK_TYPES] },
    props: {
      type: "object",
      description:
        "Block-typed payload. Rendered only through the adapter's allow-listed block registry; raw HTML is not a valid value and is rejected at validation time.",
      maxProperties: 60,
    },
    locale: LOCALE,
    unverified: { type: "boolean", default: false },
  },
} as const;

export const PAGE = {
  type: "object",
  additionalProperties: false,
  required: ["path", "title", "archetype", "blocks", "seo"],
  properties: {
    path: {
      type: "string",
      pattern: "^(?:/[a-z0-9][a-z0-9-]{0,62}){0,4}/?$",
      maxLength: 300,
      description: "Canonical leading-slash path. '/' is the home page.",
    },
    title: { type: "string", minLength: 1, maxLength: 140 },
    archetype: { type: "string", enum: [...PAGE_ARCHETYPES] },
    purpose: { type: "string", maxLength: 400 },
    blocks: { type: "array", minItems: 1, maxItems: 24, items: CONTENT_BLOCK },
    seo: SEO,
  },
} as const;

export const ASSET_SLOT = {
  type: "object",
  additionalProperties: false,
  required: ["slot_id", "role", "alt", "aspect_ratio", "source_query"],
  properties: {
    slot_id: { type: "string", pattern: "^[a-z0-9_-]{1,40}$" },
    role: { type: "string", enum: [...ASSET_ROLES] },
    alt: { type: "string", minLength: 1, maxLength: 240 },
    aspect_ratio: { type: "string", enum: [...ASPECT_RATIOS] },
    source_query: { type: "string", minLength: 1, maxLength: 200 },
    dominant_hint: { type: "string", maxLength: 80 },
  },
} as const;

export const HEX = {
  type: "string",
  pattern: "^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$",
} as const;

export const DESIGN_TOKENS = {
  type: "object",
  additionalProperties: false,
  required: ["color", "type", "space", "radius"],
  properties: {
    color: {
      type: "object",
      additionalProperties: false,
      required: ["bg", "surface", "text", "muted", "accent", "accent_fg", "border"],
      properties: {
        bg: HEX,
        surface: HEX,
        text: HEX,
        muted: HEX,
        accent: HEX,
        accent_fg: HEX,
        border: HEX,
        dark_bg: HEX,
        dark_surface: HEX,
        dark_text: HEX,
        dark_muted: HEX,
        dark_accent: HEX,
        dark_border: HEX,
      },
    },
    type: {
      type: "object",
      additionalProperties: false,
      properties: {
        font_heading: { type: "string", maxLength: 80 },
        font_body: { type: "string", maxLength: 80 },
        scale: {
          type: "array",
          minItems: 5,
          maxItems: 9,
          items: { type: "number", minimum: 0.8, maximum: 4 },
        },
        weight_heading: { type: "integer", minimum: 400, maximum: 900 },
        line_height: { type: "number", minimum: 1, maximum: 2 },
      },
    },
    space: {
      type: "array",
      minItems: 5,
      maxItems: 12,
      items: { type: "number", minimum: 0, maximum: 12 },
    },
    radius: {
      type: "object",
      additionalProperties: false,
      properties: {
        sm: { type: "number", minimum: 0, maximum: 32 },
        md: { type: "number", minimum: 0, maximum: 48 },
        lg: { type: "number", minimum: 0, maximum: 96 },
        pill: { type: "number", minimum: 0, maximum: 999 },
      },
    },
  },
} as const;

export const BUILD_DIRECTIVES = {
  type: "object",
  additionalProperties: false,
  required: ["trailing_slash", "minify"],
  properties: {
    trailing_slash: { type: "string", enum: ["always", "never", "ignore"] },
    minify: { type: "boolean" },
    redirects: {
      type: "array",
      maxItems: 50,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["from", "to"],
        properties: {
          from: { type: "string", maxLength: 300 },
          to: { type: "string", maxLength: 300 },
          status: { type: "integer", minimum: 300, maximum: 399, default: 301 },
        },
      },
    },
    headers: {
      type: "array",
      maxItems: 50,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "value"],
        properties: {
          name: { type: "string", maxLength: 80 },
          value: { type: "string", maxLength: 400 },
        },
      },
    },
    integrations: { type: "array", maxItems: 10, items: { type: "string", enum: [...INTEGRATIONS] } },
  },
} as const;

export const COMPLIANCE = {
  type: "object",
  additionalProperties: false,
  properties: {
    max_js_kb: { type: "number", minimum: 0, maximum: 64, default: 0 },
    contrast_min: { type: "number", minimum: 1, maximum: 7, default: 4.5 },
  },
} as const;

export const ARCHETYPE_ENUM = [...DESIGN_ARCHETYPES] as string[];
