/**
 * The adapter's self-description (FR-C2) and the matching algorithm the
 * orchestrator runs before dispatch (section 5.2).
 *
 * The adapter is the only component that knows what it can render, so it is
 * the only component allowed to answer that question. Everything downstream -
 * capability matching, degradation, the `BuildRequest` the orchestrator
 * constructs - is derived from `capabilities()`.
 */

import { BLOCK_DEGRADATION, CONVERSION_CRITICAL, isBlockType, type AdapterCapabilities, type BlockType } from "@pg/spec-schema";
import type { SiteSpec } from "@pg/spec-compiler";

export const ADAPTER_NAME = "@pg/ssg-adapter-astro";
export const ADAPTER_VERSION = "1.0.0";
export const TEMPLATE_NAME = "astro-nano";
export const TEMPLATE_VERSION = "1.4.2";
export const TEMPLATE_RANGE = "^1.4.0";
export const SUPPORTED_SSG = "astro@^5.7.0";

/**
 * The block registry. A type present here has a renderer in `render/blocks.ts`;
 * removing one here is what makes the orchestrator start degrading rather than
 * failing, which is the correct single-point change.
 */
export const SUPPORTED_BLOCKS: BlockType[] = [
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
];

export function capabilities(driver: "astro" | "static" = "static"): AdapterCapabilities {
  return {
    adapter: ADAPTER_NAME,
    version: ADAPTER_VERSION,
    template: { name: TEMPLATE_NAME, version: TEMPLATE_VERSION, range: TEMPLATE_RANGE },
    ssg: { name: "astro", version: "5.7.1", driver },
    blocks: [...SUPPORTED_BLOCKS],
    pageArchetypes: ["landing", "pricing", "about", "contact", "faq", "legal", "blog_index", "blog_post", "custom"],
    features: {
      view_transitions: false,
      rss: true,
      i18n: false,
      cms: false,
      analytics: false,
      newsletter: false,
      zero_js: true,
      local_search: true,
    },
    max_pages: 40,
    max_blocks_per_page: 24,
    asset_resolvers: ["local", "remote", "placeholder"],
    budget_defaults: {
      max_bundle_kb: 180,
      max_pages: 40,
      max_build_ms: 45_000,
      max_lcp_ms: 2500,
      max_cls: 0.1,
    },
  };
}

export interface Degradation {
  page_path: string;
  block_id: string;
  from: string;
  to: string;
  reason: string;
}

export interface CapabilityMatchReport {
  adapter: string;
  template_range: string;
  /** Block types the spec uses that this adapter cannot render directly. */
  unsupported_blocks: string[];
  stripped_integrations: string[];
  degradations: Degradation[];
  requested_pages: number;
  /** Non-empty only when the job genuinely cannot proceed. */
  blocking: string[];
}

/** Every block type the spec references, in document order. */
export function usedBlockTypes(spec: SiteSpec): BlockType[] {
  const out: BlockType[] = [];
  for (const page of spec.pages ?? []) {
    for (const block of page.blocks ?? []) {
      if (isBlockType(block.type) && !out.includes(block.type)) out.push(block.type);
    }
  }
  return out;
}

/**
 * Pure function: (spec, capabilities) -> what has to change.
 *
 * The degradation ladder never drops a block outright. The worst case is
 * `prose`, so the page still carries its content and the site still has the
 * section a visitor was looking for - which is the difference between a
 * degraded site and a broken one.
 */
export function matchCapabilities(spec: SiteSpec, caps: AdapterCapabilities): CapabilityMatchReport {
  const supported = new Set<BlockType>(caps.blocks);
  const degradations: Degradation[] = [];
  const unsupported = new Set<string>();
  const blocking: string[] = [];

  for (const page of spec.pages ?? []) {
    for (const block of page.blocks ?? []) {
      if (!isBlockType(block.type)) continue;
      if (supported.has(block.type)) continue;
      const to = BLOCK_DEGRADATION[block.type] ?? "prose";
      unsupported.add(block.type);
      if (!supported.has(to)) {
        // Even the fallback is unavailable: this is the one case that is
        // genuinely unbuildable, so it blocks rather than degrades.
        blocking.push(
          `block '${block.type}' on ${page.path} has no renderer and no available fallback ('${to}')`,
        );
        continue;
      }
      if (CONVERSION_CRITICAL.has(block.type)) {
        // Substituted, not dropped - but the orchestrator is told it happened.
        degradations.push({
          page_path: page.path,
          block_id: block.id,
          from: block.type,
          to,
          reason: "conversion-critical block substituted; verify the section still reads correctly",
        });
      } else {
        degradations.push({
          page_path: page.path,
          block_id: block.id,
          from: block.type,
          to,
          reason: "no renderer for this block type",
        });
      }
    }
  }

  const strippedIntegrations: string[] = [];
  for (const integration of spec.build?.integrations ?? []) {
    const featureKey = integration as keyof AdapterCapabilities["features"];
    if (!(featureKey in caps.features) || caps.features[featureKey] === false) {
      strippedIntegrations.push(integration);
    }
  }
  if ((spec.compliance?.max_js_kb ?? 0) > 0 && !caps.features.zero_js) {
    strippedIntegrations.push("external_js");
  }

  if ((spec.pages?.length ?? 0) > caps.max_pages) {
    blocking.push(`spec declares ${spec.pages.length} pages; adapter supports at most ${caps.max_pages}`);
  }

  return {
    adapter: caps.adapter,
    template_range: caps.template.range,
    unsupported_blocks: [...unsupported].sort(),
    stripped_integrations: strippedIntegrations.sort(),
    degradations,
    requested_pages: spec.pages?.length ?? 0,
    blocking,
  };
}

/** Applies the report to a spec, producing the document actually rendered. */
export function applyDegradations(spec: SiteSpec, report: CapabilityMatchReport): SiteSpec {
  const out = structuredClone(spec);
  for (const degradation of report.degradations) {
    const page = out.pages.find((candidate) => candidate.path === degradation.page_path);
    if (!page) continue;
    const block = page.blocks.find((candidate) => candidate.id === degradation.block_id);
    if (!block) continue;
    block.type = degradation.to as BlockType;
    block.props = degradeProps(block.type as BlockType, block.props, degradation.to as BlockType);
  }
  if (report.stripped_integrations.length > 0) {
    out.build.integrations = (out.build.integrations ?? []).filter(
      (integration) => !report.stripped_integrations.includes(integration),
    );
  }
  return out;
}

/**
 * Prop reshaping for a substitution. Each entry preserves the *content* the
 * user generated rather than discarding it: a pricing table that becomes a
 * feature grid still shows the plans.
 */
function degradeProps(original: BlockType, props: Record<string, unknown>, target: BlockType): Record<string, unknown> {
  if (original === target) return props;
  switch (`${original}->${target}`) {
    case "pricing_table->feature_grid": {
      const plans = (props["plans"] as Array<Record<string, unknown>> | undefined) ?? [];
      return {
        headline: props["headline"] ?? "Plans",
        body: props["body"] ?? "",
        columns: Math.min(4, Math.max(2, plans.length)),
        items: plans.map((plan) => ({
          title: `${String(plan["name"] ?? "Plan")}${plan["price"] ? ` — ${String(plan["price"])}` : ""}`,
          body: [String(plan["summary"] ?? ""), ...((plan["features"] as string[] | undefined) ?? [])]
            .filter(Boolean)
            .join(" · "),
        })),
      };
    }
    case "gallery->feature_grid":
      return {
        headline: props["headline"] ?? "Gallery",
        body: props["body"] ?? "",
        columns: 3,
        items: ((props["slots"] as string[] | undefined) ?? []).map((slot, index) => ({
          title: `Image ${index + 1}`,
          body: slot,
        })),
      };
    case "logo_wall->gallery":
      return {
        headline: props["headline"] ?? "Partners",
        body: props["body"] ?? "",
        columns: 3,
        slots: ((props["logos"] as Array<{ slot?: string }> | undefined) ?? []).map((logo) => logo.slot ?? ""),
      };
    case "newsletter_signup->cta":
      return {
        headline: props["headline"] ?? "Subscribe",
        body: props["body"] ?? "",
        primary_label: props["submit_label"] ?? "Subscribe",
        primary_href: "/#subscribe",
        secondary_label: props["consent_note"] ?? undefined,
        secondary_href: "/privacy",
      };
    case "comparison->feature_grid":
      return {
        headline: props["headline"] ?? "Comparison",
        body: props["body"] ?? "",
        columns: 2,
        items: ((props["rows"] as Array<{ label: string; values: string[] }> | undefined) ?? []).map((row) => ({
          title: row.label,
          body: row.values.join(" vs "),
        })),
      };
    default:
      // Generic path: keep the prose-ish fields, drop the structured ones.
      return {
        headline: props["headline"] ?? String(props["label"] ?? "Details"),
        body: [props["body"], props["summary"], props["quote"], props["question"]]
          .filter((value): value is string => typeof value === "string" && value.length > 0)
          .join("\n\n"),
      };
  }
}
