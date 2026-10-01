/**
 * Design token synthesis (FR-A5).
 *
 * Deterministic in `(archetype, seed)`: the same site always gets the same
 * palette and type scale, which is what makes `spec_hash` stable across a
 * cache hit and a fresh compile. Contrast is *proved*, not hoped for - see
 * `verifyDesignTokens`.
 */

import { DESIGN_ARCHETYPES, type DesignArchetype } from "@pg/spec-schema";
import type { ColorRole, DesignTokens } from "./types.js";
import { assertContrast, bestForeground, contrastRatio, ensureContrast, hslToHex, mix, rotateHue } from "./color.js";

interface ArchetypeRecipe {
  hue: number;
  /** Accent saturation, 0-1. */
  saturation: number;
  /** Base hue saturation for neutrals, 0-1. Tinted neutrals read as designed. */
  neutralSaturation: number;
  backgroundLightness: number;
  dark: boolean;
  scale: number[];
  weight: number;
  fonts: { heading: string; body: string };
  space: number[];
  radius: { sm: number; md: number; lg: number; pill: number };
}

const RECIPES: Record<DesignArchetype, ArchetypeRecipe> = {
  editorial: {
    hue: 28, saturation: 0.42, neutralSaturation: 0.06, backgroundLightness: 0.97, dark: false,
    scale: [1.5, 1.25, 1.05, 0.95, 0.875], weight: 600,
    fonts: { heading: "Georgia, 'Iowan Old Style', 'Times New Roman', serif", body: "Georgia, 'Iowan Old Style', serif" },
    space: [0, 0.5, 1, 2, 3, 5, 8], radius: { sm: 0, md: 2, lg: 4, pill: 999 },
  },
  commerce: {
    hue: 152, saturation: 0.62, neutralSaturation: 0.04, backgroundLightness: 0.99, dark: false,
    scale: [1.75, 1.3, 1.05, 0.95, 0.875], weight: 700,
    fonts: { heading: "'Inter', system-ui, sans-serif", body: "'Inter', system-ui, sans-serif" },
    space: [0, 0.5, 1, 1.5, 3, 5, 7], radius: { sm: 4, md: 8, lg: 16, pill: 999 },
  },
  saas: {
    hue: 224, saturation: 0.68, neutralSaturation: 0.05, backgroundLightness: 0.98, dark: false,
    scale: [1.875, 1.375, 1.0625, 0.9375, 0.8125], weight: 650,
    fonts: { heading: "'Inter', system-ui, sans-serif", body: "'Inter', system-ui, sans-serif" },
    space: [0, 0.5, 1, 1.5, 2.5, 4, 6], radius: { sm: 6, md: 10, lg: 16, pill: 999 },
  },
  studio: {
    hue: 268, saturation: 0.55, neutralSaturation: 0.07, backgroundLightness: 0.96, dark: false,
    scale: [2, 1.5, 1.125, 0.9375, 0.8125], weight: 600,
    fonts: { heading: "'Space Grotesk', 'Inter', sans-serif", body: "'Inter', system-ui, sans-serif" },
    space: [0, 0.75, 1.5, 2.5, 4, 6.5, 9], radius: { sm: 2, md: 6, lg: 28, pill: 999 },
  },
  wellness: {
    hue: 96, saturation: 0.34, neutralSaturation: 0.08, backgroundLightness: 0.98, dark: false,
    scale: [1.625, 1.3125, 1.0625, 0.9375, 0.875], weight: 500,
    fonts: { heading: "'Fraunces', Georgia, serif", body: "'Inter', system-ui, sans-serif" },
    space: [0, 0.75, 1.5, 2.5, 4, 6, 9], radius: { sm: 8, md: 16, lg: 32, pill: 999 },
  },
  industrial: {
    hue: 205, saturation: 0.5, neutralSaturation: 0.03, backgroundLightness: 0.93, dark: false,
    scale: [1.875, 1.375, 1.0625, 0.9375, 0.8125], weight: 700,
    fonts: { heading: "'Archivo', 'Inter', system-ui, sans-serif", body: "'Inter', system-ui, sans-serif" },
    space: [0, 0.5, 1, 2, 3.5, 5, 8], radius: { sm: 0, md: 2, lg: 4, pill: 2 },
  },
  minimal: {
    hue: 0, saturation: 0, neutralSaturation: 0, backgroundLightness: 1, dark: false,
    scale: [1.75, 1.25, 1, 0.9375, 0.875], weight: 500,
    fonts: { heading: "'Inter', system-ui, sans-serif", body: "'Inter', system-ui, sans-serif" },
    space: [0, 0.5, 1, 2, 3, 5, 7], radius: { sm: 0, md: 0, lg: 0, pill: 0 },
  },
  bold: {
    hue: 348, saturation: 0.78, neutralSaturation: 0.04, backgroundLightness: 0.11, dark: true,
    scale: [2.25, 1.5, 1.125, 0.9375, 0.8125], weight: 800,
    fonts: { heading: "'Archivo Black', 'Inter', system-ui, sans-serif", body: "'Inter', system-ui, sans-serif" },
    space: [0, 0.5, 1, 2, 3.5, 6, 9], radius: { sm: 4, md: 12, lg: 24, pill: 999 },
  },
};

/** Small deterministic PRNG so a seed reproduces a palette exactly. */
export function seededRandom(seed: number): () => number {
  let state = (seed >>> 0) || 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };
}

function isDesignArchetype(value: string): value is DesignArchetype {
  return (DESIGN_ARCHETYPES as readonly string[]).includes(value);
}

export function buildDesignTokens(archetype: string, seed: number): DesignTokens {
  const resolved: DesignArchetype = isDesignArchetype(archetype) ? archetype : "saas";
  const recipe = RECIPES[resolved];
  const random = seededRandom(seed);
  // A small deterministic hue jitter keeps two same-archetype sites from
  // looking like copies without ever making the palette feel arbitrary.
  const hue = (recipe.hue + (random() - 0.5) * 24 + 360) % 360;

  const color = buildColorRole(hue, recipe, seed);
  const tokens: DesignTokens = {
    color,
    type: {
      font_heading: recipe.fonts.heading,
      font_body: recipe.fonts.body,
      scale: recipe.scale,
      weight_heading: recipe.weight,
      line_height: 1.55,
    },
    space: recipe.space,
    radius: recipe.radius,
  };
  const verified = verifyDesignTokens(tokens);
  return verified.pass ? verified.tokens : tokens;
}

function buildColorRole(hue: number, recipe: ArchetypeRecipe, seed: number): ColorRole {
  const n = recipe.neutralSaturation;
  const dark = recipe.dark;
  const bg = dark ? hslToHex(hue, n * 0.6, 0.11) : hslToHex(hue, n, recipe.backgroundLightness);
  const surface = dark ? hslToHex(hue, n * 0.6, 0.16) : hslToHex(hue, n * 0.8, Math.min(1, recipe.backgroundLightness - 0.04));
  const borderRaw = dark ? hslToHex(hue, n * 0.5, 0.28) : hslToHex(hue, n, 0.86);

  const accentBase = hslToHex(hue, recipe.saturation, dark ? 0.62 : 0.44);
  const accentLight = rotateHue(accentBase, 0);
  const accent = dark ? accentLight : darkenForContrast(accentLight, bg, 4.5);

  // Foregrounds are proven, not selected. `ensureContrast` walks lightness
  // until the ratio clears; if it cannot, the darkest/lightest extreme wins.
  const text = ensureContrast(dark ? "#f5f5f7" : "#14141a", bg, 7);
  const muted = ensureContrast(mix(text, bg, 0.32), bg, 4.5);
  const accentFg = bestForeground(accent, ["#ffffff", "#0b0b0f"]);
  const border = ensureContrast(borderRaw, bg, 1.0);
  void seed;

  return {
    bg,
    surface,
    text,
    muted,
    accent,
    accent_fg: accentFg,
    border,
    dark_bg: dark ? bg : hslToHex(hue, n * 0.6, 0.1),
    dark_surface: dark ? surface : hslToHex(hue, n * 0.6, 0.15),
    dark_text: dark ? text : ensureContrast("#f2f2f5", hslToHex(hue, n * 0.6, 0.1), 7),
    dark_muted: dark ? muted : ensureContrast("#b8b8c2", hslToHex(hue, n * 0.6, 0.1), 4.5),
    dark_accent: dark ? accent : darkenForContrast(accentBase, hslToHex(hue, n * 0.6, 0.1), 4.5),
    dark_border: dark ? border : hslToHex(hue, n * 0.5, 0.3),
  };
}

/** Accent must also read as a *link* colour: 4.5:1 against the page background. */
function darkenForContrast(candidate: string, bg: string, target: number): string {
  let best = candidate;
  let bestRatio = contrastRatio(candidate, bg);
  for (let step = 1; step <= 20; step += 1) {
    const weight = step / 20;
    for (const direction of ["#000000", "#ffffff"]) {
      const trial = mix(candidate, direction, weight);
      const ratio = contrastRatio(trial, bg);
      if (ratio > bestRatio) {
        bestRatio = ratio;
        best = trial;
      }
      if (ratio >= target) return trial;
    }
  }
  return best;
}

export interface TokenVerification {
  tokens: DesignTokens;
  reports: ReturnType<typeof assertContrast>;
  pass: boolean;
}

/**
 * The gate FR-A5 promises. Any palette that cannot clear every pair here is
 * rejected before it can reach a spec, rather than being discovered by a
 * human reading the rendered site.
 */
export function verifyDesignTokens(tokens: DesignTokens, minimum = 4.5): TokenVerification {
  const c = tokens.color;
  const darkBg = c.dark_bg ?? c.bg;
  const darkSurface = c.dark_surface ?? darkBg;
  const darkText = c.dark_text ?? "#ffffff";
  const darkMuted = c.dark_muted ?? darkText;
  const darkAccent = c.dark_accent ?? c.accent;

  const reports = assertContrast(
    [
      { pair: "text/bg", fg: c.text, bg: c.bg, required: 7 },
      { pair: "text/surface", fg: c.text, bg: c.surface, required: 7 },
      { pair: "muted/bg", fg: c.muted, bg: c.bg, required: 4.5 },
      { pair: "accent/bg", fg: c.accent, bg: c.bg, required: 4.5 },
      { pair: "accent_fg/accent", fg: c.accent_fg, bg: c.accent, required: 4.5 },
      { pair: "dark_text/dark_bg", fg: darkText, bg: darkBg, required: 7 },
      { pair: "dark_text/dark_surface", fg: darkText, bg: darkSurface, required: 7 },
      { pair: "dark_muted/dark_bg", fg: darkMuted, bg: darkBg, required: 4.5 },
      { pair: "dark_accent/dark_bg", fg: darkAccent, bg: darkBg, required: 4.5 },
    ],
    minimum,
  );

  const pass = reports.every((report) => report.pass);
  if (pass) return { tokens, reports, pass };

  // Repair rather than reject: darken/lighten the two offenders and re-prove.
  const repaired: DesignTokens = {
    ...tokens,
    color: {
      ...c,
      text: ensureContrast(c.text, c.bg, 7),
      muted: ensureContrast(c.muted, c.bg, 4.5),
      accent: darkenForContrast(c.accent, c.bg, 4.5),
      dark_text: ensureContrast(darkText, darkBg, 7),
      dark_muted: ensureContrast(darkMuted, darkBg, 4.5),
      dark_accent: darkenForContrast(darkAccent, darkBg, 4.5),
    },
  };
  const after = assertContrast(
    [
      { pair: "text/bg", fg: repaired.color.text, bg: repaired.color.bg, required: 7 },
      { pair: "text/surface", fg: repaired.color.text, bg: repaired.color.surface, required: 7 },
      { pair: "muted/bg", fg: repaired.color.muted, bg: repaired.color.bg, required: 4.5 },
      { pair: "accent/bg", fg: repaired.color.accent, bg: repaired.color.bg, required: 4.5 },
      { pair: "accent_fg/accent", fg: repaired.color.accent_fg, bg: repaired.color.accent, required: 4.5 },
      { pair: "dark_text/dark_bg", fg: repaired.color.dark_text!, bg: darkBg, required: 7 },
      { pair: "dark_text/dark_surface", fg: repaired.color.dark_text!, bg: darkSurface, required: 7 },
      { pair: "dark_muted/dark_bg", fg: repaired.color.dark_muted!, bg: darkBg, required: 4.5 },
      { pair: "dark_accent/dark_bg", fg: repaired.color.dark_accent!, bg: darkBg, required: 4.5 },
    ],
    minimum,
  );
  return { tokens: repaired, reports: after, pass: after.every((r) => r.pass) };
}

export const ARCHETYPE_RECIPES = RECIPES;
export { DESIGN_ARCHETYPES };
