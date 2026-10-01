/**
 * Deterministic spec synthesis (FR-A16, FR-A20).
 *
 * This is the component's safety net and it is deliberately model-free. If the
 * provider is down, rate limited, content filtered, or returns unsalvageable
 * JSON after two repairs, this produces a complete, valid, buildable site so
 * that a batch delivers 100 directories rather than 96.
 *
 * Two properties make the degradation acceptable:
 *   - archetype and palette are seeded from `promptHash`, so degraded sites
 *     are visually distinct from one another (FR-A20);
 *   - copy is composed from the extracted intent rather than from templates
 *     keyed only on section name, so the page still reflects the prompt.
 *
 * The same synthesizer backs the `deterministic` LLM provider, which is how
 * the pipeline is exercised end to end without network access.
 */

import { slugify, type BlockType } from "@pg/spec-schema";
import type { AssetSlot, ContentBlock, PageSpec, SiteSpec } from "./types.js";
import { buildDesignTokens } from "./design.js";
import { seededRandom } from "./design.js";
import type { CompileRequest, Intent, SiteSpec as SpecType } from "./types.js";

const SECTION_PAGES: Record<string, { path: string; title: string; archetype: PageSpec["archetype"]; blocks: BlockType[] }> = {
  story: { path: "/about", title: "Our story", archetype: "about", blocks: ["prose", "timeline", "team"] },
  process: { path: "/process", title: "How it works", archetype: "custom", blocks: ["timeline", "faq"] },
  shop: { path: "/shop", title: "Shop", archetype: "custom", blocks: ["gallery", "comparison", "cta"] },
  subscription: { path: "/subscription", title: "Subscription", archetype: "pricing", blocks: ["pricing_table", "faq"] },
  visit: { path: "/visit", title: "Visit us", archetype: "contact", blocks: ["prose", "contact_form"] },
  features: { path: "/features", title: "Features", archetype: "custom", blocks: ["feature_grid", "comparison"] },
  pricing: { path: "/pricing", title: "Pricing", archetype: "pricing", blocks: ["pricing_table", "faq", "cta"] },
  security: { path: "/security", title: "Security", archetype: "custom", blocks: ["prose", "faq"] },
  docs: { path: "/docs", title: "Documentation", archetype: "custom", blocks: ["prose", "faq"] },
  contact: { path: "/contact", title: "Contact", archetype: "contact", blocks: ["contact_form", "prose"] },
  work: { path: "/work", title: "Selected work", archetype: "custom", blocks: ["gallery", "testimonial"] },
  services: { path: "/services", title: "Services", archetype: "custom", blocks: ["feature_grid", "faq"] },
  team: { path: "/team", title: "Team", archetype: "about", blocks: ["team", "prose"] },
  appointment: { path: "/appointment", title: "Appointments", archetype: "contact", blocks: ["contact_form", "faq"] },
  faq: { path: "/faq", title: "Frequently asked questions", archetype: "faq", blocks: ["faq", "cta"] },
  shipping: { path: "/shipping", title: "Shipping and returns", archetype: "legal", blocks: ["prose", "faq"] },
  returns: { path: "/returns", title: "Returns policy", archetype: "legal", blocks: ["prose"] },
  curriculum: { path: "/curriculum", title: "Curriculum", archetype: "custom", blocks: ["feature_grid", "timeline"] },
  instructors: { path: "/instructors", title: "Instructors", archetype: "about", blocks: ["team"] },
  enrolment: { path: "/enrol", title: "Enrol", archetype: "contact", blocks: ["contact_form", "faq"] },
  rooms: { path: "/rooms", title: "Rooms", archetype: "custom", blocks: ["gallery", "feature_grid"] },
  dining: { path: "/dining", title: "Dining", archetype: "custom", blocks: ["prose", "gallery"] },
  location: { path: "/location", title: "Location", archetype: "contact", blocks: ["prose", "contact_form"] },
  offers: { path: "/offers", title: "Offers", archetype: "custom", blocks: ["feature_grid", "faq"] },
  mission: { path: "/mission", title: "Our mission", archetype: "about", blocks: ["prose", "stat_row"] },
  programmes: { path: "/programmes", title: "Programmes", archetype: "custom", blocks: ["feature_grid", "prose"] },
  impact: { path: "/impact", title: "Impact", archetype: "custom", blocks: ["stat_row", "prose"] },
  donate: { path: "/donate", title: "Donate", archetype: "custom", blocks: ["cta", "faq"] },
  about: { path: "/about", title: "About", archetype: "about", blocks: ["prose", "team", "timeline"] },
  capabilities: { path: "/capabilities", title: "Capabilities", archetype: "custom", blocks: ["feature_grid", "comparison"] },
  quality: { path: "/quality", title: "Quality", archetype: "custom", blocks: ["prose", "faq"] },
  industries: { path: "/industries", title: "Industries we serve", archetype: "custom", blocks: ["feature_grid", "faq"] },
  leadership: { path: "/leadership", title: "Leadership", archetype: "about", blocks: ["team", "prose"] },
  writing: { path: "/writing", title: "Writing", archetype: "blog_index", blocks: ["gallery", "prose"] },
};

const HOME_BLOCKS: Record<Intent["conversionGoal"], BlockType[]> = {
  signup: ["hero", "feature_grid", "logo_wall", "testimonial", "newsletter_signup", "faq"],
  purchase: ["hero", "feature_grid", "gallery", "pricing_table", "testimonial", "cta"],
  contact: ["hero", "stat_row", "feature_grid", "testimonial", "contact_form", "faq"],
  download: ["hero", "feature_grid", "comparison", "cta", "faq"],
  inform: ["hero", "feature_grid", "prose", "gallery", "newsletter_signup"],
};

interface Copy {
  headline: string;
  subheadline: string;
  ctaPrimary: string;
  ctaSecondary: string;
  sectionPitch: string;
}

const CTA_BY_GOAL: Record<Intent["conversionGoal"], [string, string]> = {
  signup: ["Get started", "See how it works"],
  purchase: ["Browse the range", "Talk to us"],
  contact: ["Get in touch", "Book a call"],
  download: ["Get the guide", "See what's inside"],
  inform: ["Subscribe", "Read more"],
};

const FEATURE_SEEDS: Record<string, Array<[string, string]>> = {
  coffee: [
    ["Sourced transparently", "Every lot names its farm, altitude and price paid, published on the bag."],
    ["Roasted to order", "Dispatched within 48 hours of roasting so nothing sits on a shelf."],
    ["Dialled in for you", "Grind and recipe guidance for the brewer you actually own."],
  ],
  saas: [
    ["Set up in minutes", "Connect a source and the first report is building before your coffee cools."],
    ["Built for teams", "Shared views, review queues and an audit trail that survives an audit."],
    ["No lock-in", "Export everything as CSV or JSON. Your data is yours, in full, at any time."],
  ],
  agency: [
    ["Brand systems, not logos", "We build the rules that keep a brand coherent as the team grows."],
    ["Strategy before craft", "Positioning and audience work precedes the first visual."],
    ["Built to hand over", "Every engagement ends with files, guidelines and a working session."],
  ],
  health: [
    ["Continuity of care", "See the same clinician, with your history carried forward."],
    ["Evidence-led", "Every recommendation is grounded in current guidance."],
    ["Convenient by design", "Evening and weekend appointments, plus telehealth."],
  ],
  ecommerce: [
    ["Small-batch production", "Limited runs, restocked when the run sells through."],
    ["Materials chosen to last", "Repairable construction and replaceable parts."],
    ["Thirty-day returns", "Unused and in original packaging, no forms to fill in."],
  ],
  manufacturing: [
    ["Certified to ISO 9001", "Documented processes, audited annually."],
    ["Batch traceable", "Every unit carries a batch record back to raw material."],
    ["Prototype to production", "The same team carries a part from first article to volume."],
  ],
  education: [
    ["Self-paced by default", "Start when you are ready, finish on your own schedule."],
    ["Project-based", "Every module ends in something you can show someone."],
    ["Mentor feedback", "A working practitioner reviews your capstone."],
  ],
  hospitality: [
    ["Seasonal kitchen", "The menu follows what is good that week, not what is cheap."],
    ["Walkable location", "Two minutes from the station, most rooms overlook the river."],
    ["Flexible arrival", "Early check-in and late check-out on request."],
  ],
  nonprofit: [
    ["Transparent by default", "Full accounts published every quarter."],
    ["Community-led", "Programmes designed with the people they serve."],
    ["Low overhead", "At least nine tenths of every pound reaches programmes."],
  ],
  portfolio: [
    ["Selected work", "A small set of projects, described honestly."],
    ["Available for commissions", "Currently booking for the coming quarter."],
    ["Recent", "Everything here was made in the last three years."],
  ],
};

const DEFAULT_FEATURES: Array<[string, string]> = [
  ["Built for the job", "Designed around the work you actually do, not the demo."],
  ["Fast by default", "Small surface area, no background jobs unless you ask for them."],
  ["Open where it counts", "Your data stays readable and portable."],
];

export interface SynthesisResult {
  spec: SiteSpec;
  /** Claims the synthesizer could not ground; surfaced as W_A_CLAIM_UNVERIFIED. */
  unverifiedClaims: Array<{ pointer: string; text: string }>;
  truncated: boolean;
}

function featuresFor(intent: Intent): Array<[string, string]> {
  return FEATURE_SEEDS[intent.industry] ?? DEFAULT_FEATURES;
}

function copyFor(intent: Intent): Copy {
  const [ctaPrimary, ctaSecondary] = CTA_BY_GOAL[intent.conversionGoal];
  const topKeyword = intent.keywords[0] ?? intent.industry;
  const secondKeyword = intent.keywords[1] ?? intent.tone;
  return {
    headline: `${intent.brandName}, built around ${topKeyword}`,
    subheadline: `${intent.tagline}. Working with ${intent.audience} who need ${secondKeyword} without the usual friction.`,
    ctaPrimary,
    ctaSecondary,
    sectionPitch: `How ${intent.brandName} handles ${intent.sections[0] ?? "the essentials"}, and what it costs you.`,
  };
}

function block(id: string, type: BlockType, props: Record<string, unknown>, unverified = false): ContentBlock {
  return { id, type, props, unverified };
}

/**
 * Slots are named by role, not by position. A positional counter silently
 * renumbers everything the moment a slot is added, and every `image_slot`
 * reference in the copy becomes wrong - which is exactly the class of bug that
 * ships as a broken hero image and nobody notices.
 */
function assetsFor(intent: Intent): AssetSlot[] {
  const slots: AssetSlot[] = [];
  const queries = intent.keywords.length > 0 ? intent.keywords : [intent.industry];
  const perRole = new Map<string, number>();

  const add = (role: AssetSlot["role"], aspect: AssetSlot["aspect_ratio"], altBase: string, query: string) => {
    const n = (perRole.get(role) ?? 0) + 1;
    perRole.set(role, n);
    slots.push({
      slot_id: n === 1 ? `a-${role}` : `a-${role}-${n}`,
      role,
      alt: altBase,
      aspect_ratio: aspect,
      source_query: query.slice(0, 200),
    });
  };

  add("hero", "16:9", `${intent.brandName} -${queries[0]}`, `${queries[0]} ${intent.industry} ${intent.tone}`);
  add("logo", "1:1", `${intent.brandName} logo`, `${intent.brandName} wordmark`);
  add("og", "16:9", `${intent.brandName}`, `${intent.brandName}${intent.industry}`);

  const features = featuresFor(intent);
  for (let i = 0; i < Math.min(4, features.length); i += 1) {
    add("feature", "4:3", features[i]![0], `${features[i]![0]}${queries[i % queries.length]}`);
  }
  add("background", "3:2", `Abstract texture for ${intent.brandName}`, `${intent.tone} abstract texture`);
  return slots;
}

function homeBlocks(intent: Intent, copy: Copy): ContentBlock[] {
  const features = featuresFor(intent);
  const blocks: ContentBlock[] = [
    block("hero", "hero", {
      headline: copy.headline,
      subheadline: copy.subheadline,
      eyebrow: intent.industry,
      primary_label: copy.ctaPrimary,
      primary_href: goalHref(intent.conversionGoal),
      secondary_label: copy.ctaSecondary,
      secondary_href: "/about",
      image_slot: "a-hero",
      layout: "split",
      align: "left",
    }),
    block("value", "feature_grid", {
      headline: "What you get",
      body: copy.sectionPitch,
      columns: 3,
      items: features.map(([title, body]) => ({ title, body })),
    }),
  ];

  switch (intent.conversionGoal) {
    case "signup":
      blocks.push(
        block("proof", "logo_wall", {
          headline: "Trusted by teams at",
          logos: ["Northwind", "Acme", "Blue Harbor", "Field & Co", "Meridian", "Lantern"]
            .slice(0, 4)
            .map((name) => ({ name })),
        }),
        block("voices", "testimonial", {
          headline: "What people say",
          items: [
            {
              quote: `We expected another tool to fight with.${intent.brandName} was the first thing the whole team adopted without a mandate.`,
              author: "R. Ellery",
              role: "Operations lead",
            },
            {
              quote: "The part that won us over was the documentation. We had working answers before our first support ticket.",
              author: "M. Adeyemi",
              role: "Technical writer",
            },
          ],
        }),
        block("join", "newsletter_signup", {
          headline: `Get ${intent.industry} notes, monthly`,
          body: "One short email. Unsubscribe in a click.",
          consent_note: "We store your address to send this and nothing else.",
        }),
      );
      break;
    case "purchase":
      blocks.push(
        block("range", "gallery", {
          headline: "The range",
          body: "A short, deliberate selection rather than an endless one.",
          columns: 3,
          slots: ["a-feature", "a-feature-2", "a-feature-3"].slice(0, Math.max(2, Math.min(3, features.length))),
        }),
        block("plans", "pricing_table", {
          headline: "Straightforward pricing",
          body: "What you pay depends on volume, not on which features you are allowed to see.",
          currency: "USD",
          period: "month",
          highlight_index: 1,
          plans: [
            { name: "Starter", price: "0", price_note: "forever", summary: "Enough to try it properly.", features: ["Core features", "Community support"], cta_label: "Start free" },
            { name: "Standard", price: "29", price_note: "per month", summary: "For a team that has outgrown one person.", features: ["Everything in Starter", "Priority support", "Shared workspaces"], cta_label: "Choose Standard", highlighted: true },
            { name: "Partner", price: "99", price_note: "per month", summary: "For organisations with procurement involved.", features: ["Everything in Standard", "Audit log", "Named contact"], cta_label: "Talk to us" },
          ],
        }, true),
        block("voices", "testimonial", {
          headline: "From our customers",
          items: [{ quote: `Switched to ${intent.brandName} and stopped thinking about the tooling.`, author: "A. Quiroga", role: "Founder" }],
        }),
      );
      break;
    case "contact":
      blocks.push(
        block("numbers", "stat_row", {
          headline: "By the numbers",
          items: [
            { value: "10+", label: "years in practice" },
            { value: "48h", label: "typical reply time" },
            { value: "1", label: "point of contact" },
          ],
        }, true),
        block("voices", "testimonial", {
          headline: "Clients say",
          items: [{ quote: "Straight answers, no sales theatre. That is the whole review.", author: "J. Whitfield", role: "Operations manager" }],
        }),
      );
      break;
    case "download":
      blocks.push(
        block("versus", "comparison", {
          headline: `${intent.brandName} against the usual approach`,
          body: "No claim here is unique to us except the last column.",
          columns: [{ name: "Usual approach" }, { name: intent.brandName, highlight: true }],
          rows: [
            { label: "Time to first result", values: ["Days of setup", "Minutes"] },
            { label: "Data portability", values: ["Export on request", "Always available"] },
            { label: "Support", values: ["Ticket queue", "Named contact"] },
          ],
        }),
      );
      break;
    case "inform":
      blocks.push(
        block("journal", "gallery", { headline: "Recent writing", body: "Short pieces, updated as facts change.", columns: 3, slots: ["a-feature", "a-feature-2", "a-feature-3"] }),
      );
      break;
  }

  blocks.push(
    block("questions", "faq", {
      headline: "Questions we get asked",
      items: [
        { question: `How quickly can we get started with ${intent.brandName}?`, answer: "Most teams are running within a day. The first step is a short call to understand what you are trying to do; after that it is configuration, not procurement." },
        { question: "What happens if we outgrow the plan we start on?", answer: "You move up a tier and keep everything already set up. Nothing is rebuilt and no data is migrated." },
        { question: "Can we leave?", answer: "Yes. Everything you put in can be exported in standard formats, and we will help you take it with you." },
      ],
    }),
  );

  if (intent.conversionGoal !== "signup" && intent.conversionGoal !== "inform") {
    blocks.splice(blocks.length - 1, 0, block("act", "cta", {
      headline: copy.headline,
      body: copy.subheadline,
      primary_label: copy.ctaPrimary,
      primary_href: goalHref(intent.conversionGoal),
      secondary_label: copy.ctaSecondary,
      secondary_href: "/about",
    }));
  }

  return blocks;
}

function goalHref(goal: Intent["conversionGoal"]): string {
  switch (goal) {
    case "purchase": return "/shop";
    case "contact": return "/contact";
    case "download": return "/contact";
    case "inform": return "/writing";
    case "signup": return "/#join";
  }
}

function sectionBlocks(intent: Intent, blockTypes: BlockType[]): ContentBlock[] {
  const copy = copyFor(intent);
  const features = featuresFor(intent);
  const out: ContentBlock[] = [];
  let index = 0;
  for (const type of blockTypes) {
    index += 1;
    const id = `${type}-${index}`;
    switch (type) {
      case "prose":
        out.push(block(id, "prose", {
          headline: copy.sectionPitch,
          body: `${intent.brandName} exists because ${intent.audience} were being asked to choose between something fast and something careful, and nobody offered both. We built the careful version that is fast.\n\nEverything on this page is a decision we made deliberately, and we would rather explain the reasoning than the features. If something here does not fit how you work, say so and we will tell you honestly whether we are the right fit.`,
        }));
        break;
      case "feature_grid":
        out.push(block(id, "feature_grid", {
          headline: "What matters here",
          columns: 3,
          items: features.map(([title, body]) => ({ title, body })),
        }));
        break;
      case "pricing_table":
        out.push(block(id, "pricing_table", {
          headline: "Pricing",
          body: "Billed monthly. Cancel whenever you like.",
          plans: [
            { name: "Starter", price: "0", price_note: "forever", summary: "To try it.", features: ["Core features"], cta_label: "Start free" },
            { name: "Standard", price: "29", price_note: "per month", summary: "For a working team.", features: ["Everything in Starter", "Priority support"], cta_label: "Choose Standard", highlighted: true },
            { name: "Partner", price: "99", price_note: "per month", summary: "With procurement involved.", features: ["Everything in Standard", "Named contact"], cta_label: "Talk to us" },
          ],
        }, true));
        break;
      case "faq":
        out.push(block(id, "faq", {
          headline: "Common questions",
          items: [
            { question: "Is there a contract?", answer: "No. Monthly billing, cancel from the dashboard, and your data stays exportable either way." },
            { question: "Do you offer discounts?", answer: "Annual billing is discounted, and registered non-profits and educational institutions get a further reduction. Ask and we will apply it." },
          ],
        }));
        break;
      case "contact_form":
        out.push(block(id, "contact_form", {
          headline: "Talk to us",
          body: "Tell us what you are working on. We reply with a real answer, usually within two working days.",
          fields: [
            { name: "name", label: "Your name", type: "text", required: true },
            { name: "email", label: "Email", type: "email", required: true },
            { name: "topic", label: "What is this about?", type: "select", options: ["A new project", "Support", "Partnerships", "Something else"] },
            { name: "message", label: "Message", type: "textarea", required: true },
          ],
          submit_label: "Send message",
          action_note: "This form is a static demonstration and does not submit anywhere.",
        }));
        break;
      case "timeline":
        out.push(block(id, "timeline", {
          headline: "How we work",
          entries: [
            { period: "Week 1", title: "Understand", body: "We map what you do today and where it hurts. No proposals yet." },
            { period: "Weeks 2-3", title: "Build", body: "The smallest version that solves the problem, in production." },
            { period: "Week 4", title: "Hand over", body: "Documentation, a working session, and a plan for what comes next." },
          ],
        }));
        break;
      case "team":
        out.push(block(id, "team", {
          headline: "The people you will work with",
          members: [
            { name: "A. Okonkwo", role: "Founder", bio: "Sets direction, still reads every support thread." },
            { name: "S. Lindqvist", role: "Delivery", bio: "Turns the plan into something that ships on the date we promised." },
            { name: "M. Ferreira", role: "Design", bio: "Responsible for the parts people notice, and the parts they do not." },
          ],
        }));
        break;
      case "testimonial":
        out.push(block(id, "testimonial", {
          headline: "In their words",
          items: [{ quote: `The clearest process we have been through.${intent.brandName} told us what would not work before we paid for it.`, author: "L. Bergström", role: "Programme lead" }],
        }));
        break;
      case "gallery":
        out.push(block(id, "gallery", { headline: "A look around", body: "", columns: 3, slots: ["a-feature", "a-feature-2", "a-feature-3"] }));
        break;
      case "logo_wall":
        out.push(block(id, "logo_wall", { headline: "Working with", logos: ["Northwind", "Acme", "Blue Harbor", "Field & Co"].map((name) => ({ name })) }));
        break;
      case "stat_row":
        out.push(block(id, "stat_row", {
          headline: "Where we are today",
          items: [
            { value: "10+", label: "years" },
            { value: "48h", label: "median reply" },
            { value: "3", label: "core commitments" },
          ],
        }, true));
        break;
      case "comparison":
        out.push(block(id, "comparison", {
          headline: "Where this fits",
          columns: [{ name: "Alternative" }, { name: intent.brandName, highlight: true }],
          rows: [
            { label: "Setup time", values: ["Weeks", "Days"] },
            { label: "Ongoing effort", values: ["Manual", "Automated"] },
          ],
        }));
        break;
      case "cta":
        out.push(block(id, "cta", {
          headline: copy.headline,
          body: copy.subheadline,
          primary_label: copy.ctaPrimary,
          primary_href: goalHref(intent.conversionGoal),
        }));
        break;
      default:
        out.push(block(id, "prose", { body: copy.sectionPitch }));
    }
  }
  return out;
}

function seoTitle(value: string, brand: string, max = 60): string {
  // A home page titled with the brand alone must not become "Brand | Brand".
  if (value.trim().toLowerCase() === brand.trim().toLowerCase()) return brand.slice(0, max);
  const withBrand = `${value} | ${brand}`;
  if (withBrand.length <= max) return withBrand;
  const room = max - brand.length - 3;
  return room > 8 ? `${value.slice(0, room).trimEnd()} | ${brand}` : brand;
}

function seoDescription(value: string, max = 155): string {
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (trimmed.length <= max) return trimmed;
  const cut = trimmed.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut) + "…";
}

function jsonLdFor(intent: Intent, canonicalBase: string): Array<Record<string, unknown>> {
  return [
    {
      "@context": "https://schema.org",
      "@type": "Organization",
      name: intent.brandName,
      description: seoDescription(intent.tagline),
      url: canonicalBase,
    },
    {
      "@context": "https://schema.org",
      "@type": "WebSite",
      name: intent.brandName,
      url: canonicalBase,
      inLanguage: intent.locale,
    },
  ];
}

function markUnverified(spec: SiteSpec): Array<{ pointer: string; text: string }> {
  const claims: Array<{ pointer: string; text: string }> = [];
  spec.pages.forEach((page, pageIndex) => {
    page.blocks.forEach((blk, blockIndex) => {
      if (!blk.unverified) return;
      claims.push({
        pointer: `/pages/${pageIndex}/blocks/${blockIndex}`,
        text: `${page.path}#${blk.id}: ungrounded numeric claim`,
      });
    });
  });
  return claims;
}

/**
 * Build a complete, valid SiteSpec from an intent alone. No network, no clock,
 * no randomness beyond the seeded PRNG, so the result is reproducible.
 */
export function synthesizeSiteSpec(
  intent: Intent,
  request: CompileRequest,
  options: { maxPages?: number } = {},
): SynthesisResult {
  const constraints = request.constraints ?? {};
  const maxPages = Math.max(1, options.maxPages ?? constraints.max_pages ?? 12);
  const copy = copyFor(intent);
  const theme: SiteSpec["meta"]["theme"] = intent.archetype === "bold" ? "dark" : "light";

  const pages: PageSpec[] = [];
  const usedPaths = new Set<string>();

  // The tagline's first clause is usually the brand again, which would render
  // the h1 as "Brand - Brand"; fall back to the brand alone in that case.
  const taglineLead = intent.tagline.split(":")[0]!.trim();
  const homeTitle =
    taglineLead.length > 0 && taglineLead.toLowerCase() !== intent.brandName.toLowerCase()
      ? `${intent.brandName} -${taglineLead}`
      : intent.brandName;

  pages.push({
    path: "/",
    title: homeTitle,
    archetype: "landing",
    purpose: "Convert a first-time visitor into the site's primary action.",
    blocks: homeBlocks(intent, copy),
    seo: {
      title: seoTitle(intent.brandName, intent.brandName),
      description: seoDescription(copy.subheadline),
      canonical: "/",
      og_image_slot: "a-og",
      jsonld: jsonLdFor(intent, "https://example.com"),
    },
  });
  usedPaths.add("/");

  for (const section of intent.sections) {
    if (pages.length >= maxPages) break;
    const template = SECTION_PAGES[section];
    if (!template || usedPaths.has(template.path)) continue;
    const body = sectionBlocks(intent, template.blocks);
    pages.push({
      path: template.path,
      title: `${template.title} -${intent.brandName}`,
      archetype: template.archetype,
      purpose: `Answer the questions a visitor has on ${template.title.toLowerCase()}.`,
      blocks: body,
      seo: {
        title: seoTitle(template.title, intent.brandName),
        description: seoDescription(`${template.title} at ${intent.brandName}. ${copy.sectionPitch}`),
        canonical: template.path,
        og_image_slot: "a-og",
      },
    });
    usedPaths.add(template.path);
  }

  const alwaysInclude: Array<[string, string, PageSpec["archetype"]]> = [
    ["/faq", "FAQ", "faq"],
    ["/contact", "Contact", "contact"],
  ];
  for (const [path, title, archetype] of alwaysInclude) {
    if (pages.length >= maxPages || usedPaths.has(path)) continue;
    pages.push({
      path,
      title: `${title} -${intent.brandName}`,
      archetype,
      purpose: `Resolve the last open question for ${intent.audience}.`,
      blocks: sectionBlocks(intent, archetype === "faq" ? ["faq", "cta"] : ["contact_form", "prose"]),
      seo: {
        title: seoTitle(title, intent.brandName),
        description: seoDescription(`${title} for ${intent.brandName}. ${copy.subheadline}`),
        canonical: path,
      },
    });
    usedPaths.add(path);
  }

  if (pages.length > maxPages) pages.length = maxPages;
  const truncated = pages.length < maxPages && intent.sections.length > maxPages - 3;

  const assets = assetsFor(intent);
  const logoSlot = assets.find((asset) => asset.role === "logo")?.slot_id;
  const design = buildDesignTokens(intent.archetype, intent.seed);

  const spec: SiteSpec = {
    meta: {
      title: intent.brandName,
      description: seoDescription(copy.subheadline, 300),
      locale: intent.locale,
      theme,
      industry: intent.industry,
      audience: intent.audience,
      brand_name: intent.brandName,
      tagline: intent.tagline,
    },
    design: {
      archetype: intent.archetype,
      rationale: `Chosen for ${intent.tone} ${intent.industry} copy aimed at ${intent.audience}.`,
      tokens: design,
    },
    pages,
    seo: {
      sitemap: true,
      robots: "index,follow",
      default_og_image_slot: "a-og",
      organization: {
        name: intent.brandName,
        url: "https://example.com",
        ...(logoSlot ? { logo_slot: logoSlot } : {}),
      },
    },
    assets,
    build: {
      trailing_slash: "never",
      minify: true,
      integrations: (constraints.integrations ?? []).filter((i) => i !== "cms"),
      headers: [
        { name: "X-Content-Type-Options", value: "nosniff" },
        { name: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      ],
    },
    compliance: { max_js_kb: constraints.allow_external_js ? 64 : 0, contrast_min: 4.5 },
  } as SpecType;

  return { spec, unverifiedClaims: markUnverified(spec), truncated };
}
