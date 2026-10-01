/**
 * The block registry (FR-C6, FR-C7).
 *
 * Every renderer is a pure function from parsed props to an HTML string. There
 * is no dynamic dispatch on a string from the spec, no innerHTML, and no path
 * from spec data to raw markup: all interpolation goes through escapeHtml and
 * safeUrl in html.ts.
 *
 * A type missing from this map is not a build failure - renderBlock falls back
 * to prose and the caller records W_C_BLOCK_DOWNGRADED. The registry is also
 * the adapter advertised capability list, so this file and capabilities.ts
 * must agree; assertRegistryConsistency checks it at load.
 */

import { parseBlockProps, type BlockType } from "@pg/spec-schema";
import type { ContentBlock } from "@pg/spec-compiler";
import { attrs, blockClass, escapeHtml, renderMarkdown, safeUrl } from "../html.js";
import type { ResolvedAsset } from "../assets/resolver.js";
import { SUPPORTED_BLOCKS } from "../capabilities.js";

export interface RenderContext {
  /** Resolved assets by slot id. A missing slot renders a labelled figure. */
  assets: Map<string, ResolvedAsset>;
  /** Injected so the smoke assertions can report "no external requests". */
  externalRequests: number;
  locale: string;
}

type Renderer = (props: Record<string, unknown>, context: RenderContext) => string;

const str = (props: Record<string, unknown>, key: string, fallback = ""): string => {
  const value = props[key];
  return typeof value === "string" ? value : fallback;
};

const arr = <T = Record<string, unknown>>(props: Record<string, unknown>, key: string): T[] => {
  const value = props[key];
  return Array.isArray(value) ? (value as T[]) : [];
};

const num = (props: Record<string, unknown>, key: string, fallback: number): number => {
  const value = props[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
};

function img(context: RenderContext, slotId: string, className: string, sizes?: string): string {
  const asset = context.assets.get(slotId);
  if (!asset) {
    return `<div ${attrs({ class: className + " img-missing", role: "img", "aria-label": "Image pending" })}></div>`;
  }
  return [
    "<img",
    attrs({
      src: "/" + asset.path,
      alt: asset.alt,
      width: asset.width,
      height: asset.height,
      class: className,
      loading: asset.lazy ? "lazy" : "eager",
      decoding: asset.lazy ? "async" : "sync",
      fetchpriority: asset.lazy ? "auto" : "high",
      ...(sizes ? { sizes } : {}),
    }),
    ">",
  ].join("");
}

function button(label: string, href: string, variant: "primary" | "secondary" | "ghost"): string {
  return `<a ${attrs({ class: `btn btn-${variant}`, href: safeUrl(href) })}>${escapeHtml(label)}</a>`;
}

function actionRow(props: Record<string, unknown>): string {
  const parts: string[] = [];
  const primaryLabel = str(props, "primary_label");
  if (primaryLabel) parts.push(button(primaryLabel, str(props, "primary_href", "#"), "primary"));
  const secondaryLabel = str(props, "secondary_label");
  if (secondaryLabel) parts.push(button(secondaryLabel, str(props, "secondary_href", "#"), "secondary"));
  if (parts.length === 0) return "";
  return `<div class="actions">${parts.join("")}</div>`;
}

const hero: Renderer = (props, context) => {
  const layout = str(props, "layout", "split");
  const align = str(props, "align", "left");
  const eyebrow = str(props, "eyebrow");
  const headline = str(props, "headline");
  const subheadline = str(props, "subheadline");
  const slot = str(props, "image_slot");
  const media = slot ? img(context, slot, "hero-media", "(min-width: 60rem) 50vw, 100vw") : "";
  // The page title is already emitted as the page's single h1, so the hero
  // repeats it as a paragraph rather than emitting a second h1.
  return [
    `<section ${attrs({ class: `block hero hero-${layout} align-${align}`, "aria-labelledby": "page-title" })}>`,
    `<div class="hero-copy">`,
    eyebrow ? `<p class="eyebrow">${escapeHtml(eyebrow)}</p>` : "",
    headline ? `<p class="hero-headline">${escapeHtml(headline)}</p>` : "",
    subheadline ? `<p class="lede">${escapeHtml(subheadline)}</p>` : "",
    actionRow(props),
    `</div>`,
    media ? `<div class="hero-visual">${media}</div>` : "",
    `</section>`,
  ].join("");
};

const featureGrid: Renderer = (props, context) => {
  void context;
  const items = arr(props, "items");
  const columns = Math.max(2, Math.min(4, num(props, "columns", 3)));
  return [
    `<section class="block features"${attrs({ "data-columns": columns })}>`,
    str(props, "headline") ? `<h2>${escapeHtml(str(props, "headline"))}</h2>` : "",
    str(props, "body") ? `<p class="lede">${escapeHtml(str(props, "body"))}</p>` : "",
    `<ul class="feature-list"${attrs({ style: `--cols:${columns}` })}>`,
    ...items.map((item) =>
      [
        "<li>",
        `<h3>${escapeHtml(String(item["title"] ?? ""))}</h3>`,
        item["body"] ? `<p>${escapeHtml(String(item["body"]))}</p>` : "",
        "</li>",
      ].join(""),
    ),
    `</ul>`,
    `</section>`,
  ].join("");
};

const pricingTable: Renderer = (props, context) => {
  void context;
  const plans = arr<Record<string, unknown>>(props, "plans");
  const currency = str(props, "currency", "USD");
  const period = str(props, "period", "month");
  return [
    `<section class="block pricing">`,
    str(props, "headline") ? `<h2>${escapeHtml(str(props, "headline"))}</h2>` : "",
    str(props, "body") ? `<p class="lede">${escapeHtml(str(props, "body"))}</p>` : "",
    `<div class="plan-grid"${attrs({ style: `--cols:${Math.min(4, Math.max(2, plans.length))}` })}>`,
    ...plans.map((plan) => {
      const features = Array.isArray(plan["features"]) ? (plan["features"] as string[]) : [];
      return [
        `<article class="plan${plan["highlighted"] ? " plan-featured" : ""}">`,
        `<h3>${escapeHtml(String(plan["name"] ?? ""))}</h3>`,
        `<p class="price"><span class="amount">${escapeHtml(String(plan["price"] ?? ""))}</span> <span class="currency">${escapeHtml(currency)}</span>`,
        plan["price_note"] ? `<span class="per"> /${escapeHtml(String(plan["price_note"]))} ${escapeHtml(period)}</span>` : "",
        `</p>`,
        plan["summary"] ? `<p class="plan-summary">${escapeHtml(String(plan["summary"]))}</p>` : "",
        features.length > 0
          ? `<ul class="plan-features">${features.map((f) => `<li>${escapeHtml(f)}</li>`).join("")}</ul>`
          : "",
        plan["cta_label"]
          ? button(String(plan["cta_label"]), String(plan["cta_href"] ?? "#contact"), plan["highlighted"] ? "primary" : "ghost")
          : "",
        `</article>`,
      ].join("");
    }),
    `</div>`,
    `</section>`,
  ].join("");
};

const faq: Renderer = (props) => {
  const items = arr<Record<string, unknown>>(props, "items");
  const entries = items
    .map(
      (item, index) =>
        `<details class="faq-item"${attrs({ open: index === 0 ? true : undefined })}>` +
        `<summary><span>${escapeHtml(String(item["question"] ?? ""))}</span></summary>` +
        `<div class="faq-answer">${renderMarkdown(String(item["answer"] ?? ""))}</div>` +
        `</details>`,
    )
    .join("");
  return [
    `<section class="block faq">`,
    str(props, "headline") ? `<h2>${escapeHtml(str(props, "headline"))}</h2>` : "",
    entries,
    `</section>`,
  ].join("");
};

const cta: Renderer = (props, context) => {
  void context;
  return [
    `<section class="block cta">`,
    str(props, "headline") ? `<h2>${escapeHtml(str(props, "headline"))}</h2>` : "",
    str(props, "body") ? `<p class="lede">${escapeHtml(str(props, "body"))}</p>` : "",
    actionRow(props),
    `</section>`,
  ].join("");
};

const statRow: Renderer = (props, context) => {
  void context;
  const items = arr<Record<string, unknown>>(props, "items");
  return [
    `<section class="block stats">`,
    str(props, "headline") ? `<h2>${escapeHtml(str(props, "headline"))}</h2>` : "",
    `<dl class="stat-list">`,
    ...items.map((item) =>
      [
        "<div class=\"stat\">",
        `<dt class="stat-value">${escapeHtml(String(item["value"] ?? ""))}</dt>`,
        `<dd class="stat-label">${escapeHtml(String(item["label"] ?? ""))}${item["note"] ? ` <span class="stat-note">${escapeHtml(String(item["note"]))}</span>` : ""}</dd>`,
        "</div>",
      ].join(""),
    ),
    `</dl>`,
    `</section>`,
  ].join("");
};

const testimonial: Renderer = (props, context) => {
  const items = arr<Record<string, unknown>>(props, "items");
  return [
    `<section class="block testimonials">`,
    str(props, "headline") ? `<h2>${escapeHtml(str(props, "headline"))}</h2>` : "",
    `<ul class="quote-list">`,
    ...items.map((item) => {
      const avatar = str(item, "avatar_slot");
      return [
        "<li>",
        avatar ? img(context, avatar, "avatar", "3rem") : "",
        `<blockquote><p>${escapeHtml(String(item["quote"] ?? ""))}</p></blockquote>`,
        `<p class="attribution"><strong>${escapeHtml(String(item["author"] ?? ""))}</strong>`,
        item["role"] ? ` <span class="role">${escapeHtml(String(item["role"]))}</span>` : "",
        item["company"] ? ` <span class="company">${escapeHtml(String(item["company"]))}</span>` : "",
        `</p>`,
        "</li>",
      ].join("");
    }),
    `</ul>`,
    `</section>`,
  ].join("");
};

const gallery: Renderer = (props, context) => {
  const slots = arr<string>(props, "slots");
  const columns = Math.max(2, Math.min(4, num(props, "columns", 3)));
  return [
    `<section class="block gallery">`,
    str(props, "headline") ? `<h2>${escapeHtml(str(props, "headline"))}</h2>` : "",
    str(props, "body") ? `<p class="lede">${escapeHtml(str(props, "body"))}</p>` : "",
    `<ul class="gallery-grid"${attrs({ style: `--cols:${columns}` })}>`,
    ...slots
      .filter((slot) => typeof slot === "string" && slot.length > 0)
      .map((slot) => `<li>${img(context, slot, "gallery-media", "(min-width: 48rem) 33vw, 50vw")}</li>`),
    `</ul>`,
    `</section>`,
  ].join("");
};

const prose: Renderer = (props) => [
  `<section class="block prose">`,
  str(props, "headline") ? `<h2>${escapeHtml(str(props, "headline"))}</h2>` : "",
  `<div class="prose-body${num(props, "drop_cap", 0) ? " has-drop-cap" : ""}">${renderMarkdown(str(props, "body"))}</div>`,
  `</section>`,
].join("");

const logoWall: Renderer = (props, context) => {
  const logos = arr<Record<string, unknown>>(props, "logos");
  return [
    `<section class="block logo-wall">`,
    str(props, "headline") ? `<h2 class="visually-hidden">${escapeHtml(str(props, "headline"))}</h2>` : "",
    str(props, "body") ? `<p class="lede">${escapeHtml(str(props, "body"))}</p>` : "",
    `<ul class="logo-list">`,
    ...logos.map((logo) => {
      const slot = str(logo, "slot");
      return `<li>${slot ? img(context, slot, "logo", "8rem") : `<span class="logo-wordmark">${escapeHtml(String(logo["name"] ?? ""))}</span>`}</li>`;
    }),
    `</ul>`,
    `</section>`,
  ].join("");
};

const team: Renderer = (props, context) => {
  const members = arr<Record<string, unknown>>(props, "members");
  return [
    `<section class="block team">`,
    str(props, "headline") ? `<h2>${escapeHtml(str(props, "headline"))}</h2>` : "",
    `<ul class="team-grid"${attrs({ style: `--cols:${Math.min(4, Math.max(2, members.length))}` })}>`,
    ...members.map((member) => {
      const slot = str(member, "slot");
      return [
        "<li>",
        slot ? img(context, slot, "portrait", "12rem") : `<span class="portrait-placeholder" aria-hidden="true">${escapeHtml(String(member["name"] ?? "?").slice(0, 1))}</span>`,
        `<h3>${escapeHtml(String(member["name"] ?? ""))}</h3>`,
        `<p class="role">${escapeHtml(String(member["role"] ?? ""))}</p>`,
        member["bio"] ? `<p class="bio">${escapeHtml(String(member["bio"]))}</p>` : "",
        "</li>",
      ].join("");
    }),
    `</ul>`,
    `</section>`,
  ].join("");
};

/**
 * A static-site form. No action, no method, no JavaScript: the fieldset is
 * labelled and the note explains that submission is not wired up, because a
 * form that silently discards input is worse than one that says so.
 */
const contactForm: Renderer = (props, context) => {
  const fields = arr<Record<string, unknown>>(props, "fields");
  return [
    `<section class="block contact">`,
    `<h2>${escapeHtml(str(props, "headline", "Contact"))}</h2>`,
    str(props, "body") ? `<p class="lede">${escapeHtml(str(props, "body"))}</p>` : "",
    `<form class="static-form" method="post" action="#">`,
    `<fieldset>`,
    `<legend class="visually-hidden">${escapeHtml(str(props, "headline", "Contact form"))}</legend>`,
    ...fields.map((field, index) => {
      const name = String(field["name"] ?? `field_${index}`);
      const label = String(field["label"] ?? name);
      const type = String(field["type"] ?? "text");
      const id = `f-${name}`;
      if (type === "textarea") {
        return [
          `<div class="field">`,
          `<label ${attrs({ for: id })}>${escapeHtml(label)}${field["required"] ? ` <span class="req" aria-hidden="true">*</span>` : ""}</label>`,
          `<textarea ${attrs({ id, name, rows: 5, required: field["required"] === true })}></textarea>`,
          `</div>`,
        ].join("");
      }
      if (type === "select") {
        const choices = Array.isArray(field["options"]) ? (field["options"] as string[]) : [];
        return [
          `<div class="field">`,
          `<label ${attrs({ for: id })}>${escapeHtml(label)}</label>`,
          `<select ${attrs({ id, name, required: field["required"] === true })}>`,
          choices.map((choice) => `<option value="${escapeHtml(choice)}">${escapeHtml(choice)}</option>`).join(""),
          `</select>`,
          `</div>`,
        ].join("");
      }
      return [
        `<div class="field">`,
        `<label ${attrs({ for: id })}>${escapeHtml(label)}${field["required"] ? ` <span class="req" aria-hidden="true">*</span>` : ""}</label>`,
        `<input ${attrs({ id, name, type, autocomplete: type === "email" ? "email" : type === "tel" ? "tel" : "on" })}>`,
        `</div>`,
      ].join("");
    }),
    `<button type="submit" class="btn btn-primary">${escapeHtml(str(props, "submit_label", "Send"))}</button>`,
    `<p class="form-note">${escapeHtml(str(props, "action_note", "This static form is a demonstration and does not submit anywhere."))}</p>`,
    `</fieldset>`,
    `</form>`,
    `</section>`,
  ].join("");
};

const timeline: Renderer = (props) => {
  const entries = arr<Record<string, unknown>>(props, "entries");
  return [
    `<section class="block timeline">`,
    str(props, "headline") ? `<h2>${escapeHtml(str(props, "headline"))}</h2>` : "",
    `<ol class="timeline-list">`,
    ...entries.map(
      (entry) =>
        [
          "<li>",
          entry["period"] ? `<p class="period">${escapeHtml(String(entry["period"]))}</p>` : "",
          `<h3>${escapeHtml(String(entry["title"] ?? ""))}</h3>`,
          entry["body"] ? `<p>${escapeHtml(String(entry["body"]))}</p>` : "",
          "</li>",
        ].join(""),
    ),
    `</ol>`,
    `</section>`,
  ].join("");
};

const comparison: Renderer = (props) => {
  const columns = arr<Record<string, unknown>>(props, "columns");
  const rows = arr<Record<string, unknown>>(props, "rows");
  return [
    `<section class="block comparison">`,
    str(props, "headline") ? `<h2>${escapeHtml(str(props, "headline"))}</h2>` : "",
    str(props, "body") ? `<p class="lede">${escapeHtml(str(props, "body"))}</p>` : "",
    `<div class="table-scroll"><table>`,
    `<caption class="visually-hidden">${escapeHtml(str(props, "headline", "Comparison"))}</caption>`,
    `<thead><tr><th scope="col">Feature</th>${columns
      .map((column) => `<th scope="col"${attrs({ class: column["highlight"] ? "is-highlight" : undefined })}>${escapeHtml(String(column["name"] ?? ""))}</th>`)
      .join("")}</tr></thead>`,
    `<tbody>`,
    ...rows.map((row) => {
      const values = Array.isArray(row["values"]) ? (row["values"] as string[]) : [];
      return [
        "<tr>",
        `<th scope="row">${escapeHtml(String(row["label"] ?? ""))}</th>`,
        ...values.map((value) => `<td>${escapeHtml(value)}</td>`).join(""),
        "</tr>",
      ].join("");
    }),
    `</tbody>`,
    `</table></div>`,
    `</section>`,
  ].join("");
};

const newsletterSignup: Renderer = (props) => [
  `<section class="block newsletter" id="subscribe">`,
  `<h2>${escapeHtml(str(props, "headline", "Subscribe"))}</h2>`,
  str(props, "body") ? `<p class="lede">${escapeHtml(str(props, "body"))}</p>` : "",
  `<form class="static-form inline-form" method="post" action="#">`,
  `<label class="visually-hidden" for="nl-email">${escapeHtml(str(props, "headline", "Email"))}</label>`,
  `<input ${attrs({ id: "nl-email", name: "email", type: "email", placeholder: str(props, "placeholder", "you@example.com"), autocomplete: "email" })}>`,
  `<button type="submit" class="btn btn-primary">${escapeHtml(str(props, "submit_label", "Subscribe"))}</button>`,
  `</form>`,
  str(props, "consent_note") ? `<p class="form-note">${escapeHtml(str(props, "consent_note"))}</p>` : "",
  `</section>`,
].join("");

const REGISTRY: Record<BlockType, Renderer> = {
  hero,
  feature_grid: featureGrid,
  pricing_table: pricingTable,
  faq,
  cta,
  stat_row: statRow,
  testimonial,
  gallery,
  prose,
  logo_wall: logoWall,
  team,
  contact_form: contactForm,
  timeline,
  comparison,
  newsletter_signup: newsletterSignup,
};

export interface RenderOutcome {
  html: string;
  effectiveType: BlockType;
  propsIssues: number;
}

const HEADING_PATTERN = /<h[1-6][^>]*>/g;
const H1_PATTERN = /<h1[^>]*>/g;

export function renderBlock(block: ContentBlock, context: RenderContext): RenderOutcome {
  const type = block.type as BlockType;
  const parsed = parseBlockProps(type, block.props ?? {});
  const known = Object.hasOwn(REGISTRY, type);
  const effectiveType: BlockType = known ? type : "prose";
  const body = known
    ? (REGISTRY[type] as Renderer)(parsed.props, context)
    : (REGISTRY.prose as Renderer)(
        { headline: parsed.props["headline"], body: String(parsed.props["body"] ?? "Content unavailable.") },
        context,
      );
  return { html: body, effectiveType, propsIssues: parsed.issues.length };
}

/** The renderer the capabilities table advertises must actually exist. */
export function assertRegistryConsistency(): void {
  const advertised: ReadonlySet<string> = new Set(SUPPORTED_BLOCKS);
  const implemented: ReadonlySet<string> = new Set(Object.keys(REGISTRY));
  const missing = [...advertised].filter((type) => !implemented.has(type));
  if (missing.length > 0) {
    throw new Error(`capabilities advertise blocks with no renderer: ${missing.join(", ")}`);
  }
  const unadvertised = [...implemented].filter((type) => !advertised.has(type));
  if (unadvertised.length > 0) {
    throw new Error(`renderers exist for blocks not advertised in capabilities: ${unadvertised.join(", ")}`);
  }
}

export const blockRegistry = REGISTRY;
export { HEADING_PATTERN, H1_PATTERN };
export type { Renderer };
export { blockClass };
