/**
 * The block prop contract.
 *
 * `blocks[].props` in the JSON Schema is deliberately an open object: block
 * shapes are numerous, version independently, and a rigid schema would make
 * every adapter release a breaking spec change. The cost of openness is that
 * *someone* must own the shape - that is this module.
 *
 * Both directions use it:
 *   - component A asks the model for exactly these shapes, and validates the
 *     answer, so a hallucinated key becomes a repairable validation error
 *     rather than an empty render;
 *   - component C parses props through `parseBlockProps`, which drops unknown
 *     keys, fills defaults, and reports issues, so a renderer can never be
 *     handed a surprise.
 */

import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import { BLOCK_TYPES, type BlockType } from "./blocks.js";

const ajv = new Ajv2020({ allErrors: true, strict: false, allowUnionTypes: true });

const STR = { type: "string" } as const;
const REQ_STR = (max: number) => ({ type: "string", minLength: 1, maxLength: max });

const str = (max: number) => ({ type: "string", maxLength: max });
const reqStr = (max: number) => ({ type: "string", minLength: 1, maxLength: max });
const strArray = (max: number, maxItems = 24) => ({
  type: "array",
  maxItems,
  items: { type: "string", minLength: 1, maxLength: max },
});

function object(properties: Record<string, unknown>, required: string[] = []) {
  return { type: "object", additionalProperties: false, required, properties } as const;
}

function variant(properties: Record<string, unknown>, required: string[] = []) {
  return { anyOf: [object(properties, required), { type: "null" }] } as const;
}

const CTA = object(
  {
    headline: REQ_STR(120),
    body: str(320),
    primary_label: reqStr(40),
    primary_href: reqStr(200),
    secondary_label: str(40),
    secondary_href: str(200),
    align: { type: "string", enum: ["left", "center"], default: "center" },
  },
  ["headline", "primary_label", "primary_href"],
);

const ITEM = object({
  title: reqStr(90),
  body: str(320),
  icon: { type: "string", maxLength: 40 },
});

const BLOCK_PROP_SCHEMAS = {
  hero: object(
    {
      headline: reqStr(140),
      subheadline: str(320),
      eyebrow: str(60),
      primary_label: str(40),
      primary_href: str(200),
      secondary_label: str(40),
      secondary_href: str(200),
      image_slot: str(64),
      layout: { type: "string", enum: ["split", "stacked", "centered"], default: "split" },
      align: { type: "string", enum: ["left", "center"], default: "left" },
    },
    ["headline", "subheadline"],
  ),
  feature_grid: object(
    {
      headline: str(140),
      body: str(320),
      columns: { type: "integer", minimum: 2, maximum: 4, default: 3 },
      items: { type: "array", minItems: 2, maxItems: 12, items: ITEM },
    },
    ["items"],
  ),
  pricing_table: object(
    {
      headline: str(140),
      body: str(320),
      currency: { type: "string", maxLength: 8, default: "USD" },
      period: { type: "string", maxLength: 20, default: "month" },
      highlight_index: { type: "integer", minimum: 0, maximum: 5, default: 1 },
      plans: {
        type: "array",
        minItems: 2,
        maxItems: 4,
        items: object(
          {
            name: reqStr(40),
            price: reqStr(20),
            price_note: str(60),
            summary: str(240),
            features: strArray(120, 10),
            cta_label: str(40),
            cta_href: str(200),
            highlighted: { type: "boolean", default: false },
          },
          ["name", "price"],
        ),
      },
    },
    ["plans"],
  ),
  faq: object(
    {
      headline: str(140),
      items: {
        type: "array",
        minItems: 2,
        maxItems: 12,
        items: object({ question: reqStr(160), answer: reqStr(600) }, ["question", "answer"]),
      },
    },
    ["items"],
  ),
  cta: CTA,
  stat_row: object(
    {
      headline: str(140),
      items: {
        type: "array",
        minItems: 2,
        maxItems: 6,
        items: object(
          { value: reqStr(20), label: reqStr(80), note: str(140) },
          ["value", "label"],
        ),
      },
    },
    ["items"],
  ),
  testimonial: object(
    {
      headline: str(140),
      items: {
        type: "array",
        minItems: 1,
        maxItems: 6,
        items: object(
          {
            quote: reqStr(600),
            author: reqStr(80),
            role: str(120),
            company: str(80),
            avatar_slot: str(64),
          },
          ["quote", "author"],
        ),
      },
    },
    ["items"],
  ),
  gallery: object(
    {
      headline: str(140),
      body: str(320),
      columns: { type: "integer", minimum: 2, maximum: 4, default: 3 },
      slots: { type: "array", maxItems: 12, items: { type: "string", maxLength: 64 } },
    },
    ["slots"],
  ),
  prose: object(
    {
      headline: str(140),
      body: reqStr(6000),
      drop_cap: { type: "boolean", default: false },
    },
    ["body"],
  ),
  logo_wall: object(
    {
      headline: str(140),
      body: str(240),
      logos: {
        type: "array",
        minItems: 2,
        maxItems: 16,
        items: object({ name: reqStr(60), slot: str(64) }, ["name"]),
      },
    },
    ["logos"],
  ),
  team: object(
    {
      headline: str(140),
      members: {
        type: "array",
        minItems: 1,
        maxItems: 12,
        items: object(
          { name: reqStr(80), role: reqStr(80), bio: str(320), slot: str(64) },
          ["name", "role"],
        ),
      },
    },
    ["members"],
  ),
  contact_form: object(
    {
      headline: reqStr(140),
      body: str(320),
      fields: {
        type: "array",
        minItems: 1,
        maxItems: 8,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["name", "type"],
          properties: {
            name: { type: "string", pattern: "^[a-z][a-z0-9_]{0,30}$" },
            label: reqStr(60),
            type: { type: "string", enum: ["text", "email", "tel", "textarea", "select"] },
            required: { type: "boolean", default: false },
            options: strArray(60, 20),
          },
        },
      },
      submit_label: { type: "string", maxLength: 40, default: "Send message" },
      action_note: str(200),
    },
    ["headline", "fields"],
  ),
  timeline: object(
    {
      headline: str(140),
      entries: {
        type: "array",
        minItems: 2,
        maxItems: 12,
        items: object(
          { period: reqStr(40), title: reqStr(120), body: str(400) },
          ["period", "title"],
        ),
      },
    },
    ["entries"],
  ),
  comparison: object(
    {
      headline: reqStr(140),
      body: str(320),
      columns: {
        type: "array",
        minItems: 2,
        maxItems: 4,
        items: object({ name: reqStr(60), highlight: { type: "boolean", default: false } }, ["name"]),
      },
      rows: {
        type: "array",
        minItems: 1,
        maxItems: 20,
        items: object(
          {
            label: reqStr(80),
            values: { type: "array", minItems: 2, maxItems: 4, items: str(120) },
          },
          ["label", "values"],
        ),
      },
    },
    ["columns", "rows"],
  ),
  newsletter_signup: object(
    {
      headline: reqStr(140),
      body: str(320),
      placeholder: { type: "string", maxLength: 60, default: "you@example.com" },
      submit_label: { type: "string", maxLength: 40, default: "Subscribe" },
      consent_note: str(240),
    },
    ["headline"],
  ),
} as const;

export type BlockPropSchemaName = keyof typeof BLOCK_PROP_SCHEMAS;

const validators = new Map<BlockType, ValidateFunction>();

function validatorFor(type: BlockType): ValidateFunction {
  const existing = validators.get(type);
  if (existing) return existing;
  const schema = BLOCK_PROP_SCHEMAS[type];
  if (!schema) throw new Error(`no prop schema registered for block type ${type}`);
  const compiled = ajv.compile(schema as never);
  validators.set(type, compiled);
  return compiled;
}

export interface BlockPropIssue {
  pointer: string;
  keyword: string;
  message: string;
}

export interface ParsedBlockProps {
  props: Record<string, unknown>;
  issues: BlockPropIssue[];
  valid: boolean;
}

/**
 * Validate raw props for a block type. Unknown keys are reported as issues but
 * still returned, so a strict consumer can reject and a lenient renderer can
 * ignore. Defaults are *not* applied here; that is `withBlockDefaults`.
 */
export function parseBlockProps(type: BlockType, raw: unknown): ParsedBlockProps {
  const props = raw && typeof raw === "object" && !Array.isArray(raw) ? { ...(raw as Record<string, unknown>) } : {};
  const validate = validatorFor(type);
  const valid = validate(props);
  const issues: BlockPropIssue[] = valid
    ? []
    : (validate.errors ?? []).map((error) => ({
        pointer: (type + (error.instancePath === "" ? "" : error.instancePath)).replace(/\//g, "."),
        keyword: error.keyword,
        message: error.message ?? "invalid",
      }));
  return { props, issues, valid };
}

/** Compact schema rendering injected into the model prompt (NFR-A4: one call). */
export function describeBlockPropsForPrompt(): string {
  return BLOCK_TYPES.map((type) => {
    const schema = BLOCK_PROP_SCHEMAS[type];
    const props = (schema as { properties: Record<string, unknown> }).properties;
    const required = new Set((schema as { required?: readonly string[] }).required ?? []);
    const fields = Object.entries(props).map(([key, value]) => {
      const field = value as { type?: string; enum?: readonly string[]; default?: unknown };
      const typeName = Array.isArray(field.enum) ? field.enum.join("|") : (field.type ?? "any");
      const suffix = field.default !== undefined ? ` =${JSON.stringify(field.default)}` : "";
      return `${key}:${typeName}${suffix}${required.has(key) ? "!" : ""}`;
    });
    return `-${type} { ${fields.join(", ")} }`;
  }).join("\n");
}

export const BLOCK_PROP_SCHEMA_MAP = BLOCK_PROP_SCHEMAS;
