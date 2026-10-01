/**
 * Deterministic SVG placeholder (FR-C8 tier 3).
 *
 * This is what guarantees the "hermetic" half of the single most important
 * constraint: with no network, a build still produces complete markup, and two
 * builds of the same spec produce byte-identical bytes. The derivation is a
 * BLAKE3 of the slot identity, so nothing depends on a clock, a random source,
 * or the host.
 */

import { blake3Hex } from "@pg/spec-schema";
import type { AssetRole } from "@pg/spec-schema";
import type { AspectRatio } from "@pg/spec-schema";

const DIMENSIONS: Record<AspectRatio, [number, number]> = {
  "1:1": [800, 800],
  "4:3": [800, 600],
  "3:2": [900, 600],
  "16:9": [1280, 720],
  "3:4": [600, 800],
  "2:3": [600, 900],
};

function hsl(h: number, s: number, l: number): string {
  return `hsl(${Math.round(h)}${Math.round(s)}% ${Math.round(l)}%)`;
}

/** A short, stable word-pair label so a placeholder is never a grey void. */
function labelFor(seedHex: string): string {
  const adjectives = [
    "amber", "quiet", "north", "clear", "deep", "open", "still", "warm", "far", "soft",
    "high", "slow", "bright", "low", "wide", "calm",
  ];
  const nouns = [
    "harbour", "meadow", "foundry", "atrium", "kitchen", "terrace", "archive", "studio",
    "market", "garden", "workshop", "landing", "depot", "field",
  ];
  const a = adjectives[Number.parseInt(seedHex.slice(0, 3), 16) % adjectives.length]!;
  const b = nouns[Number.parseInt(seedHex.slice(3, 6), 16) % nouns.length]!;
  return `${a}${b}`;
}

export interface PlaceholderOptions {
  slotId: string;
  role: AssetRole;
  aspectRatio: AspectRatio;
  /** Displayed to a screen reader in place of a real image. */
  alt: string;
}

export function renderPlaceholderSvg(options: PlaceholderOptions): string {
  const [width, height] = aspectDimensions(options.aspectRatio);
  const seed = blake3Hex(`${options.slotId}|${options.role}|${options.aspectRatio}`);
  const hue = Number.parseInt(seed.slice(0, 4), 16) % 360;
  const hue2 = (hue + 24 + (Number.parseInt(seed.slice(4, 6), 16) % 60)) % 360;
  const label = labelFor(seed);

  const idBase = seed.slice(0, 8);
  const isCompact = width <= 640;
  const titleSize = Math.round(width / (isCompact ? 12 : 18));
  const labelSize = Math.round(width / (isCompact ? 18 : 30));
  const cx = width / 2;
  const cy = height / 2;

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0${width} ${height}" role="img" aria-labelledby="t-${idBase}">`,
    `<title id="t-${idBase}">${escapeXml(options.alt)}</title>`,
    `<defs>`,
    `<linearGradient id="g-${idBase}" x1="0" y1="0" x2="1" y2="1">`,
    `<stop offset="0" stop-color="${hsl(hue, 34, 78)}"/>`,
    `<stop offset="1" stop-color="${hsl(hue2, 30, 58)}"/>`,
    `</linearGradient>`,
    `<pattern id="p-${idBase}" width="24" height="24" patternUnits="userSpaceOnUse">`,
    `<path d="M0 24 L24 0" stroke="${hsl(hue, 26, 32)}" stroke-opacity="0.10" stroke-width="2"/>`,
    `</pattern>`,
    `</defs>`,
    `<rect width="${width}" height="${height}" fill="url(#g-${idBase})"/>`,
    `<rect width="${width}" height="${height}" fill="url(#p-${idBase})"/>`,
    `<circle cx="${cx}" cy="${cy}" r="${Math.round(Math.min(width, height) / 2 - 12)}" fill="none" stroke="${hsl(hue, 30, 30)}" stroke-opacity="0.22" stroke-width="2"/>`,
    `<text x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="middle" font-family="Georgia, serif" font-size="${titleSize}" fill="${hsl(hue, 34, 24)}" fill-opacity="0.72">${escapeXml(label)}</text>`,
    `<text x="${cx}" y="${cy + titleSize * 1.3}" text-anchor="middle" dominant-baseline="middle" font-family="system-ui, sans-serif" font-size="${labelSize}" fill="${hsl(hue, 30, 28)}" fill-opacity="0.5">${width}×${height}</text>`,
    `</svg>`,
  ].join("");
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function aspectDimensions(ratio: AspectRatio): [number, number] {
  return DIMENSIONS[ratio] ?? [800, 600];
}
