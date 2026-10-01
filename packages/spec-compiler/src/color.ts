/**
 * Color engine.
 *
 * Every palette the compiler emits must clear WCAG 2.2 AA: 4.5:1 for body
 * text, 3:1 for large text and UI boundaries (FR-A5, NFR: compliance
 * .contrast_min). The generator therefore never *asserts* a ratio - it proves
 * it, and the proof is what `assertContrast` re-checks before a spec is
 * allowed out of the compiler.
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const round = (value: number) => clamp(Math.round(value), 0, 255);

export function parseHex(hex: string): Rgb {
  const normalized = hex.trim().replace(/^#/, "");
  const full =
    normalized.length === 3
      ? normalized
          .split("")
          .map((c) => c + c)
          .join("")
      : normalized;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) {
    throw new Error(`not a hex colour: ${hex}`);
  }
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  };
}

export function toHex({ r, g, b }: Rgb): string {
  return "#" + [r, g, b].map((c) => round(c).toString(16).padStart(2, "0")).join("");
}

export function luminance({ r, g, b }: Rgb): number {
  const channel = (raw: number) => {
    const value = raw / 255;
    return value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrastRatio(foreground: string, background: string): number {
  const a = luminance(parseHex(foreground));
  const b = luminance(parseHex(background));
  const [lighter, darker] = a > b ? [a, b] : [b, a];
  return (lighter + 0.05) / (darker + 0.05);
}

export function mix(a: string, b: string, weight: number): string {
  const ca = parseHex(a);
  const cb = parseHex(b);
  return toHex({
    r: ca.r * (1 - weight) + cb.r * weight,
    g: ca.g * (1 - weight) + cb.g * weight,
    b: ca.b * (1 - weight) + cb.b * weight,
  });
}

export function withLightness(hex: string, targetLuminance: number): string {
  const rgb = parseHex(hex);
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 24; i += 1) {
    const mid = (lo + hi) / 2;
    const candidate = mix("#000000", toHex(rgb), mid);
    const candidateLuminance = luminance(parseHex(candidate));
    if (candidateLuminance < targetLuminance) lo = mid;
    else hi = mid;
  }
  return mix("#000000", toHex(rgb), (lo + hi) / 2);
}

export function rotateHue(hex: string, degrees: number): string {
  const { r, g, b } = parseHex(hex);
  const [hue, sat, light] = rgbToHsl({ r, g, b });
  return toHex(hslToRgb({ h: (hue + degrees + 360) % 360, s: sat, l: light }));
}

export function rgbToHsl({ r, g, b }: Rgb): [number, number, number] {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) * 60;
  else if (max === gn) h = ((bn - rn) / d + 2) * 60;
  else h = ((rn - gn) / d + 4) * 60;
  return [h, s, l];
}

export function hslToRgb({ h, s, l }: { h: number; s: number; l: number }): Rgb {
  if (s === 0) {
    const value = round(l * 255);
    return { r: value, g: value, b: value };
  }
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r1, g1, b1] =
    h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return { r: round((r1 + m) * 255), g: round((g1 + m) * 255), b: round((b1 + m) * 255) };
}

export function hslToHex(h: number, s: number, l: number): string {
  return toHex(hslToRgb({ h, s, l }));
}

/**
 * Move `fg` toward black or white - whichever direction increases contrast -
 * until it clears `target`. Returns the original colour if it already clears.
 * This is the primitive every guarantee in the palette is built from.
 */
export function ensureContrast(fg: string, bg: string, target: number): string {
  if (contrastRatio(fg, bg) >= target) return fg;
  const toward = luminance(parseHex(bg)) > 0.4 ? "#000000" : "#ffffff";
  const away = toward === "#000000" ? "#ffffff" : "#000000";
  let best = fg;
  let bestRatio = contrastRatio(fg, bg);
  for (let step = 1; step <= 20; step += 1) {
    const weight = step / 20;
    for (const direction of [toward, away]) {
      const candidate = mix(bg, direction, weight);
      const ratio = contrastRatio(candidate, bg);
      if (ratio > bestRatio) {
        bestRatio = ratio;
        best = candidate;
      }
      if (ratio >= target) return candidate;
    }
  }
  return best;
}

/** Picks whichever of two candidates (usually black / white) reads better on `bg`. */
export function bestForeground(bg: string, candidates: [string, string] = ["#0b0b0f", "#ffffff"]): string {
  const [a, b] = candidates;
  return contrastRatio(a, bg) >= contrastRatio(b, bg) ? a : b;
}

export interface ContrastReport {
  pair: string;
  ratio: number;
  required: number;
  pass: boolean;
}

/** Re-verifies the guarantees the generator claims. Used as a compiler gate. */
export function assertContrast(
  pairs: Array<{ pair: string; fg: string; bg: string; required: number }>,
  minimum = 4.5,
): ContrastReport[] {
  return pairs.map(({ pair, fg, bg, required }) => {
    const requiredRatio = Math.max(required, minimum);
    const ratio = Math.round(contrastRatio(fg, bg) * 100) / 100;
    return { pair, ratio, required: requiredRatio, pass: ratio >= requiredRatio };
  });
}
