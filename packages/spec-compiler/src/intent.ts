/**
 * Intent extraction (FR-A4).
 *
 * Runs before the model is consulted and does three jobs:
 *   1. narrows the prompt to a normalized brief that the model prompt can be
 *      built from, rather than re-deriving structure from raw prose;
 *   2. produces a seed, so `(prompt, constraints)` fully determines the output
 *      hash (FR-A14, NFR-A9);
 *   3. is the *only* content path available to the fallback synthesizer
 *      (FR-A16), which is why it must never depend on the network.
 */

import { slugify, blake3Hex, type DesignArchetype } from "@pg/spec-schema";
import { sanitizePrompt } from "@pg/redaction";
import { seededRandom } from "./design.js";
import type { CompileRequest, Intent } from "./types.js";

interface DomainRule {
  industry: string;
  keywords: string[];
  archetype: DesignArchetype;
  sections: string[];
  vocabulary: string[];
}

const DOMAINS: DomainRule[] = [
  {
    industry: "coffee",
    keywords: ["coffee", "roastery", "roaster", "espresso", "cafe", "café", "beans", "brew", "barista"],
    archetype: "editorial",
    sections: ["story", "process", "shop", "subscription", "visit"],
    vocabulary: ["single origin", "roasted weekly", "cupping", "sourcing", "grind"],
  },
  {
    industry: "saas",
    keywords: ["saas", "dashboard", "platform", "api", "developer tool", "b2b", "workflow", "automation", "analytics"],
    archetype: "saas",
    sections: ["features", "pricing", "security", "docs", "contact"],
    vocabulary: ["onboard in minutes", "single source of truth", "no code required", "audit trail"],
  },
  {
    industry: "agency",
    keywords: ["agency", "studio", "creative", "design", "branding", "consulting", "marketing"],
    archetype: "studio",
    sections: ["work", "services", "process", "team", "contact"],
    vocabulary: ["brand system", "creative direction", "campaign", "engagement"],
  },
  {
    industry: "health",
    keywords: ["clinic", "dental", "medical", "health", "wellness", "therapy", "practice", "patient", "yoga", "fitness"],
    archetype: "wellness",
    sections: ["services", "team", "appointment", "faq", "contact"],
    vocabulary: ["evidence-led", "personalised", "preventative", "continuity of care"],
  },
  {
    industry: "ecommerce",
    keywords: ["shop", "store", "ecommerce", "e-commerce", "product", "merchandise", "boutique", "retail", "furniture", "apparel"],
    archetype: "commerce",
    sections: ["shop", "story", "shipping", "returns", "contact"],
    vocabulary: ["small batch", "made to last", "free returns", "carbon neutral delivery"],
  },
  {
    industry: "manufacturing",
    keywords: ["manufacturing", "industrial", "factory", "machinery", "precision", "components", "fabrication", "supply chain"],
    archetype: "industrial",
    sections: ["capabilities", "quality", "industries", "leadership", "contact"],
    vocabulary: ["tolerance", "certified", "batch traceable", "on-time delivery"],
  },
  {
    industry: "education",
    keywords: ["course", "school", "academy", "learning", "training", "curriculum", "students", "tutor"],
    archetype: "minimal",
    sections: ["curriculum", "instructors", "enrolment", "faq", "contact"],
    vocabulary: ["self-paced", "mentor-led", "project based", "certificate"],
  },
  {
    industry: "hospitality",
    keywords: ["hotel", "restaurant", "bistro", "inn", "resort", "accommodation", "booking", "hospitality"],
    archetype: "editorial",
    sections: ["rooms", "dining", "location", "offers", "contact"],
    vocabulary: ["seasonal", "locally sourced", "walkable", "late checkout"],
  },
  {
    industry: "nonprofit",
    keywords: ["nonprofit", "non-profit", "charity", "donate", "foundation", "volunteer", "community", "fundraising"],
    archetype: "minimal",
    sections: ["mission", "programmes", "impact", "donate", "contact"],
    vocabulary: ["every dollar", "community led", "transparency", "volunteer led"],
  },
  {
    industry: "portfolio",
    keywords: ["portfolio", "personal site", "resume", "cv", "my work", "photographer", "writer", "freelance"],
    archetype: "studio",
    sections: ["work", "about", "writing", "contact"],
    vocabulary: ["selected work", "available for commissions", "recent", "collaborate"],
  },
];

const TONE_RULES: Array<{ tone: string; keywords: string[] }> = [
  { tone: "playful", keywords: ["playful", "fun", "friendly", "casual", "witty", "humorous", "bright"] },
  { tone: "premium", keywords: ["premium", "luxury", "exclusive", "refined", "elegant", "high-end", "bespoke"] },
  { tone: "technical", keywords: ["technical", "engineering", "developer", "api", "precise", "rigorous", "protocol"] },
  { tone: "warm", keywords: ["warm", "human", "personal", "empathetic", "community", "caring"] },
  { tone: "bold", keywords: ["bold", "disruptive", "unapologetic", "punchy", "loud", "energetic"] },
  { tone: "calm", keywords: ["calm", "quiet", "minimal", "understated", "serene", "simple"] },
  { tone: "authoritative", keywords: ["authoritative", "trusted", "expert", "professional", "institutional", "leading"] },
];

const CONVERSION_RULES: Array<{ goal: Intent["conversionGoal"]; keywords: string[] }> = [
  { goal: "purchase", keywords: ["buy", "shop", "store", "order", "checkout", "cart", "purchase", "ecommerce", "products"] },
  { goal: "signup", keywords: ["sign up", "signup", "subscribe", "newsletter", "waitlist", "join", "membership", "trial", "demo"] },
  { goal: "download", keywords: ["download", "ebook", "guide", "template", "whitepaper", "report", "checklist"] },
  { goal: "contact", keywords: ["contact", "call", "enquire", "enquiry", "quote", "appointment", "book", "consultation", "get in touch"] },
  { goal: "inform", keywords: ["blog", "news", "article", "inform", "learn", "read", "documentation", "guide"] },
];

const MAX_PROMPT = 4000;

function countMatches(haystack: string, needles: readonly string[]): number {
  let count = 0;
  for (const needle of needles) {
    if (haystack.includes(needle)) count += 1;
  }
  return count;
}

function pickBest<T extends { keywords: string[] }>(haystack: string, rules: readonly T[]): T | null {
  let best: { rule: T; score: number } | null = null;
  for (const rule of rules) {
    const score = countMatches(haystack, rule.keywords);
    if (score > 0 && (best === null || score > best.score)) best = { rule, score };
  }
  return best?.rule ?? null;
}

/**
 * Leading instruction to strip before the brand name is read off the front of
 * the prompt: "build me a website for Acme Roofing" -> "Acme Roofing".
 */
const LEAD_IN =
  /^(?:please\s+)?(?:i\s+(?:need|want|require)\s+)?(?:can\s+you\s+)?(?:build|create|make|design|generate|set\s+up|launch|start|develop|draft|write|produce|put\s+together)\s+(?:me\s+)?(?:a|an|the)?\s*(?:website|web\s?site|site|webpage|page|landing\s+page|online\s+presence|business\s+site)?\s*(?:for|about|on|of|called|named)?\s+/i;

/** Words that look like a name but are just the noun the prompt is about. */
const GENERIC_HEADS = new Set([
  "website",
  "websites",
  "site",
  "sites",
  "page",
  "pages",
  "landing",
  "homepage",
  "business",
  "company",
  "online",
]);

/** Leading noun phrase: "Acme Roofing, a roofer in Leeds" -> "Acme Roofing". */
function leadingNounPhrase(prompt: string): string | undefined {
  const withoutLeadIn = prompt.replace(LEAD_IN, "");
  // The brand is whatever sits before the first descriptor or clause break.
  const head = withoutLeadIn.split(/[,;:]| - | \u2014 | \u2013 | \(|\[/)[0]?.trim() ?? "";
  const words = head.split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 5) return undefined;
  if (GENERIC_HEADS.has(words[0]!.toLowerCase())) return undefined;
  // A proper name is capitalised. "a yoga studio" is a description, not a name.
  if (!/^[A-Z0-9]/.test(head)) return undefined;
  if (!/^[\p{L}\p{N}][\p{L}\p{N} &'.-]*$/u.test(head)) return undefined;
  return head;
}

/** Brand name: an explicit hint, else a quoted or leading proper name, else the site id. */
function inferBrandName(prompt: string, siteId: string, hinted?: string): string {
  if (hinted && hinted.trim().length > 0) return hinted.trim().slice(0, 120);
  const quoted = /["'\u201c\u2018]([^"'\u201c\u201d\u2018\u2019]{2,60})["'\u201c\u201d\u2018\u2019]/.exec(prompt);
  if (quoted?.[1]) return titleCase(quoted[1]);
  const named = /\b(?:called|named)\s+([A-Z][\w&'\-]*(?:\s+[A-Z][\w&'\-]*){0,3})/.exec(prompt);
  if (named?.[1]) return titleCase(named[1]);
  const forMatch = /\bfor\s+(?:an?\s+|the\s+)?([A-Z][\w&'\-]*(?:\s+[A-Z][\w&'\-]*){0,3})/.exec(prompt);
  if (forMatch?.[1]) return titleCase(forMatch[1]);
  const leading = leadingNounPhrase(prompt);
  if (leading) return titleCase(leading);
  return titleCase(siteId.split("-").join(" "));
}

function titleCase(value: string): string {
  const small = new Set(["and", "of", "the", "for", "to", "a", "an", "in", "on", "at", "by"]);
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((word, index) =>
      index > 0 && small.has(word.toLowerCase())
        ? word.toLowerCase()
        : word.charAt(0).toUpperCase() + word.slice(1),
    )
    .join(" ");
}

function inferTagline(prompt: string, brand: string, vocabulary: readonly string[]): string {
  const existing = /\b(?:tagline|slogan)\s*[:\-]\s*["']?([^"'\n.]{6,120})/.exec(prompt);
  if (existing?.[1]) return existing[1].trim();
  const seed = blake3Hex(brand + prompt).slice(0, 8);
  const deterministic = Number.parseInt(seed, 16) % vocabulary.length;
  return `${brand}: ${vocabulary[deterministic] ?? "built with care"}`;
}

function inferAudience(prompt: string, hinted?: string): string {
  if (hinted && hinted.trim().length > 0) return hinted.trim().slice(0, 200);
  const patterns = [
    /\b(?:for|aimed at|target(?:ing)?|serving)\s+([a-z][^.,;\n]{4,90})/i,
    /\b(?:who are|that helps|designed for)\s+([a-z][^.,;\n]{4,90})/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(prompt);
    if (match?.[1]) return match[1].trim().replace(/\s+/g, " ").slice(0, 200);
  }
  return "people evaluating this for themselves";
}

/** Keywords: content words that survive stop-word removal, length-gated. */
const STOP_WORDS = new Set(
  ("a an the and or but if then for of to in on at by with from as is are was were be been being this that these those " +
    "it its we our you your they their i me my he she his her not no so such than too very can will just should now " +
    "site website page make create build need want like also into over under about after before more most other some any")
    .split(" "),
);

function extractKeywords(prompt: string, limit: number): string[] {
  const counts = new Map<string, number>();
  for (const token of prompt.toLowerCase().match(/[a-z][a-z0-9'-]{2,}/g) ?? []) {
    if (STOP_WORDS.has(token) || token.length < 3) continue;
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, limit)
    .map(([word]) => word);
}

function inferLocale(explicit: string | undefined): string {
  if (explicit && /^[a-z]{2}(-[A-Za-z]{2,4})?$/.test(explicit)) return explicit;
  return "en-US";
}

/**
 * The full brief. Deterministic: same prompt + same constraints => same intent.
 */
export function extractIntent(request: CompileRequest): Intent {
  const sanitized = sanitizePrompt(request.prompt.slice(0, MAX_PROMPT));
  const prompt = sanitized.text;
  const lowered = prompt.toLowerCase();
  const seed = request.compile_options?.seed ?? Number.parseInt(blake3Hex(prompt).slice(0, 8), 16);

  const domain = pickBest(lowered, DOMAINS) ?? DOMAINS[1]!;
  const tone = pickBest(lowered, TONE_RULES)?.tone ?? "authoritative";
  const conversionGoal = pickBest(lowered, CONVERSION_RULES)?.goal ?? "signup";
  const brandName = inferBrandName(prompt, request.site_id, request.context?.brand?.name);
  const explicitArchetype = /\b(?:style|look and feel|aesthetic|vibe)\s*[:\-]?\s*(minimal|editorial|modern|playful|bold|elegant|luxury|technical|friendly|serious)/i.exec(
    prompt,
  )?.[1];

  const sections = mergeSections(
    domain.sections,
    request.constraints?.required_sections ?? [],
    request.constraints?.banned_sections ?? [],
  );

  const random = seededRandom(seed);
  // Prefer the domain's default archetype; the explicit style hint is a
  // stronger signal than the domain when it is present.
  const archetype = normalizeStyleHint(explicitArchetype) ?? domain.archetype;
  void random;

  return {
    siteId: request.site_id,
    brandName,
    tagline: inferTagline(prompt, brandName, domain.vocabulary),
    industry: domain.industry,
    audience: inferAudience(prompt, request.context?.audience),
    tone,
    locale: inferLocale(request.context?.locale),
    keywords: (request.context?.keywords ?? []).concat(extractKeywords(prompt, 12)).slice(0, 25),
    archetype,
    conversionGoal,
    sections,
    seed,
    sanitizedPrompt: prompt,
    redactions: sanitized.redacted.total,
    injectionFindings: sanitized.injection.findings.length,
    promptHash: blake3Hex(prompt).slice(0, 32),
  };
}

function normalizeStyleHint(hint: string | undefined): DesignArchetype | null {
  if (!hint) return null;
  const map: Record<string, DesignArchetype> = {
    minimal: "minimal",
    editorial: "editorial",
    modern: "saas",
    playful: "studio",
    bold: "bold",
    elegant: "editorial",
    luxury: "editorial",
    technical: "industrial",
    friendly: "wellness",
    serious: "industrial",
  };
  return map[hint.toLowerCase()] ?? null;
}

function mergeSections(
  defaults: readonly string[],
  required: readonly string[],
  banned: readonly string[],
): string[] {
  const bannedSet = new Set(banned.map((s) => s.toLowerCase()));
  const out: string[] = [];
  for (const section of [...required, ...defaults]) {
    const key = section.toLowerCase();
    if (bannedSet.has(key)) continue;
    if (out.includes(key)) continue;
    out.push(key);
  }
  return out.slice(0, 8);
}

export { DOMAINS as INTENT_DOMAINS, slugify };
