/**
 * CSS tokens rendered deterministically from design tokens (NFR-C20). No
 * custom properties that depend on time or randomness. The stylesheet is
 * self-contained, zero JavaScript.
 */

import type { DesignTokens } from "@pg/spec-compiler";
import { escapeHtml } from "../html.js";

function clampScale(value: number): string {
  const v = Math.max(0.8, Math.min(4, value));
  return v.toFixed(3);
}

function px(value: number): string {
  return Math.round(value * 16) + "px";
}

function rem(value: number): string {
  return value.toFixed(3) + "rem";
}

function toCssVars(tokens: DesignTokens): string {
  const color = tokens.color;
  const type = tokens.type;
  const space = tokens.space;
  const radius = tokens.radius;
  return [
    ":root {",
    `--bg: ${color.bg};`,
    `--surface: ${color.surface};`,
    `--text: ${color.text};`,
    `--muted: ${color.muted};`,
    `--accent: ${color.accent};`,
    `--accent-fg: ${color.accent_fg};`,
    `--border: ${color.border};`,
    ...(color.dark_bg ? [`--bg-dark: ${color.dark_bg};`] : []),
    ...(color.dark_surface ? [`--surface-dark: ${color.dark_surface};`] : []),
    ...(color.dark_text ? [`--text-dark: ${color.dark_text};`] : []),
    ...(color.dark_muted ? [`--muted-dark: ${color.dark_muted};`] : []),
    ...(color.dark_accent ? [`--accent-dark: ${color.dark_accent};`] : []),
    ...(color.dark_border ? [`--border-dark: ${color.dark_border};`] : []),
    ...(type.font_heading ? [`--font-heading: ${escapeCssVar(type.font_heading)};`] : []),
    ...(type.font_body ? [`--font-body: ${escapeCssVar(type.font_body)};`] : []),
    `--h1: ${clampScale(type.scale?.[6] ?? 3.0)}rem;`,
    `--h2: ${clampScale(type.scale?.[5] ?? 2.4)}rem;`,
    `--h3: ${clampScale(type.scale?.[4] ?? 1.8)}rem;`,
    `--h4: ${clampScale(type.scale?.[3] ?? 1.4)}rem;`,
    `--h5: ${clampScale(type.scale?.[2] ?? 1.2)}rem;`,
    `--p: ${clampScale(type.scale?.[1] ?? 1.0)}rem;`,
    `--small: ${clampScale(type.scale?.[0] ?? 0.9)}rem;`,
    `--lh:1.6;`,
    `--lh-heading:1.12;`,
    `--space-0: ${rem(space[0] ?? 0)};`,
    `--space-1: ${rem(space[1] ?? 0.25)};`,
    `--space-2: ${rem(space[2] ?? 0.5)};`,
    `--space-3: ${rem(space[3] ?? 1)};`,
    `--space-4: ${rem(space[4] ?? 1.5)};`,
    `--space-5: ${rem(space[5] ?? 2)};`,
    `--space-6: ${rem(space[6] ?? 3)};`,
    `--radius-sm: ${px(radius.sm ?? 8)};`,
    `--radius-md: ${px(radius.md ?? 12)};`,
    `--radius-lg: ${px(radius.lg ?? 16)};`,
    `--radius-pill: ${px(radius.pill ?? 999)};`,
    "}",
  ].join("\n");
}

function escapeCssVar(value: string): string {
  return value.replace(/[";]/g, "");
}

/** Deterministic, vendor-free base stylesheet. */
export function baseCss(tokens: DesignTokens): string {
  const vars = toCssVars(tokens);
  return [
    vars,
    `@media (prefers-color-scheme: dark){ :root{--bg:var(--bg-dark, var(--bg));--surface:var(--surface-dark,var(--surface));--text:var(--text-dark,var(--text));--muted:var(--muted-dark,var(--muted));--accent:var(--accent-dark,var(--accent));--border:var(--border-dark,var(--border));}}`,
    `*{box-sizing:border-box;margin:0;padding:0}html{font-size:100%;scroll-behavior:auto}body{font-family:var(--font-body, system-ui, -apple-system, sans-serif);background:var(--bg);color:var(--text);line-height:var(--lh);-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}main{display:flex;flex-direction:column;gap:var(--space-6)}img{max-width:100%;height:auto;display:block}a{color:var(--accent);text-decoration:none}a:hover,a:focus-visible{text-decoration:underline}h1,h2,h3,h4{font-family:var(--font-heading, Georgia, serif);line-height:var(--lh-heading);color:var(--text);margin-bottom:var(--space-2)}h1{font-size:var(--h1)}h2{font-size:var(--h2)}h3{font-size:var(--h3)}h4{font-size:var(--h4)}p,li,dd{font-size:var(--p);color:var(--text)}.lede{font-size:calc(var(--p)*1.125);color:var(--text);max-width:60ch}section{padding:var(--space-6) clamp(1rem,5vw,4rem)}.container{max-width:72rem;margin:0 auto;display:flex;flex-direction:column;gap:var(--space-4)}.visually-hidden{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}.eyebrow{text-transform:uppercase;letter-spacing:.08em;font-size:var(--small);color:var(--muted)}.block{display:flex;flex-direction:column;gap:var(--space-4);background:var(--bg)}.hero{flex-direction:column-reverse;gap:var(--space-5);align-items:center;text-align:center}@media(min-width:60rem){.hero{flex-direction:row;text-align:left;align-items:center}}.hero-copy{flex:1;display:flex;flex-direction:column;gap:var(--space-3)}.hero-visual{flex:1}.actions{display:flex;gap:var(--space-2);flex-wrap:wrap;justify-content:center}@media(min-width:60rem){.actions{justify-content:flex-start}}.btn{display:inline-flex;align-items:center;gap:var(--space-1);padding:.75rem 1.5rem;border-radius:var(--radius-pill);border:1px solid transparent;font-size:var(--p);font-weight:600;text-decoration:none;white-space:nowrap}.btn-primary{background:var(--accent);color:var(--accent-fg)}.btn-secondary{background:transparent;color:var(--text);border-color:var(--border)}.btn-ghost{background:var(--surface);color:var(--text);border-color:var(--border)}.feature-list{display:grid;gap:var(--space-3);grid-template-columns:repeat(auto-fit,minmax(16rem,1fr));list-style:none}.feature-list li{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-lg);padding:var(--space-4);display:flex;flex-direction:column;gap:var(--space-1)}.pricing .plan-grid{display:grid;gap:var(--space-3);grid-template-columns:repeat(auto-fit,minmax(16rem,1fr))}.plan{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-lg);padding:var(--space-4);display:flex;flex-direction:column;gap:var(--space-2)}.plan-featured{outline:2px solid var(--accent);outline-offset:2px}.price .amount{font-size:var(--h2);font-weight:700}.plan-features{list-style:none;display:flex;flex-direction:column;gap:.5rem;margin-top:var(--space-2)}.plan-features li::before{content:'\u2713';margin-right:.5rem;color:var(--accent)}.faq-item{border-bottom:1px solid var(--border);padding:var(--space-2) 0}.faq-item summary{cursor:pointer;font-weight:600;list-style:none}.faq-item summary::-webkit-details-marker{display:none}.faq-answer{margin-top:var(--space-2);color:var(--muted)}.stats .stat-list{display:grid;grid-template-columns:repeat(auto-fit,minmax(10rem,1fr));gap:var(--space-3);text-align:center}.stat{background:var(--surface);padding:var(--space-4);border-radius:var(--radius-md);border:1px solid var(--border)}.stat-value{font-size:var(--h2);font-weight:700}.testimonials .quote-list{list-style:none;display:grid;gap:var(--space-3);grid-template-columns:repeat(auto-fit,minmax(20rem,1fr))}.quote-list li{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-lg);padding:var(--space-4);display:flex;flex-direction:column;gap:var(--space-2)}.avatar{width:3rem;height:3rem;border-radius:50%;object-fit:cover}.gallery-grid{list-style:none;display:grid;gap:var(--space-2);grid-template-columns:repeat(var(--cols,3),1fr)}.logo-list{list-style:none;display:flex;flex-wrap:wrap;gap:var(--space-4);align-items:center;justify-content:center;filter:grayscale(100%)}.team-grid{list-style:none;display:grid;gap:var(--space-3);grid-template-columns:repeat(auto-fit,minmax(14rem,1fr))}.team-grid li{text-align:center;display:flex;flex-direction:column;align-items:center;gap:var(--space-1)}.portrait{width:8rem;height:8rem;border-radius:50%;object-fit:cover}.portrait-placeholder{width:8rem;height:8rem;border-radius:50%;display:flex;align-items:center;justify-content:center;background:var(--surface);border:1px solid var(--border);font-size:var(--h2)}.timeline-list{list-style:none;position:relative;padding-left:2rem;display:flex;flex-direction:column;gap:var(--space-3)}.timeline-list::before{content:'';position:absolute;left:.75rem;top:0;bottom:0;width:2px;background:var(--border)}.timeline-list li{position:relative;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-md);padding:var(--space-3)}.timeline-list li::before{content:'';position:absolute;left:-1.25rem;top:1.5rem;width:.75rem;height:.75rem;border-radius:50%;background:var(--accent);border:2px solid var(--bg)}.table-scroll{overflow-x:auto;border:1px solid var(--border);border-radius:var(--radius-md)}table{width:100%;border-collapse:collapse;background:var(--surface)}th,td{padding:.75rem 1rem;border-bottom:1px solid var(--border);text-align:left}thead th{background:var(--bg);font-weight:600}.is-highlight{background:rgba(0,0,0,.04)}.static-form{display:flex;flex-direction:column;gap:var(--space-3);max-width:40rem;background:var(--surface);padding:var(--space-4);border:1px solid var(--border);border-radius:var(--radius-lg)}.inline-form{flex-direction:row;align-items:center;gap:var(--space-2)}.field{display:flex;flex-direction:column;gap:.5rem}label{font-weight:600;font-size:var(--small)}input,textarea,select{padding:.75rem 1rem;border-radius:var(--radius-md);border:1px solid var(--border);background:var(--bg);color:var(--text);font-size:var(--p)}.form-note{font-size:var(--small);color:var(--muted)}.has-drop-cap p:first-of-type::first-letter{float:left;font-size:3rem;line-height:1;padding-right:.5rem;font-family:var(--font-heading)}.img-missing{min-height:12rem;background:repeating-linear-gradient(45deg,var(--surface),var(--surface) 10px,rgba(255,255,255,.05) 10px,rgba(255,255,255,.05) 20px);border:1px dashed var(--border);border-radius:var(--radius-md)}footer{padding:var(--space-4);text-align:center;color:var(--muted);font-size:var(--small);border-top:1px solid var(--border)}.site-header{display:flex;align-items:center;justify-content:space-between;padding:var(--space-2) clamp(1rem,5vw,4rem);border-bottom:1px solid var(--border);background:var(--surface)}.nav{display:flex;gap:var(--space-3);list-style:none}blockquote{border-left:4px solid var(--accent);padding-left:1rem;color:var(--text);font-style:italic}code{background:var(--surface);padding:.125rem .25rem;border-radius:.25rem;border:1px solid var(--border)}ul,ol{padding-left:1.25rem;display:flex;flex-direction:column;gap:.5rem}.prose-body>p{max-width:70ch}`,
  ].join("\n");
}
