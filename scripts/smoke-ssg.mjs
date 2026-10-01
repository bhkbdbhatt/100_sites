/**
 * Component C smoke test: compile a spec, build it, assert every gate.
 *
 * Verifies FR-C10 (exact page set), C12 (bundle), C13 (build time), C14 (LCP/CLS),
 * C15 (a11y), C16 (security), C17 (no path escape), C23 (determinism: identical
 * spec -> identical artifact hash) and the degradation ladder.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const { createCompiler } = await import("../packages/spec-compiler/dist/index.js");
const { assertSiteSpec } = await import("../packages/spec-schema/dist/index.js");
const { buildSite } = await import("../packages/ssg-adapter-astro/dist/adapter.js");
const { capabilities, matchCapabilities, renderPlaceholderSvg, securityGate } = await import(
  "../packages/ssg-adapter-astro/dist/index.js"
);

let failures = 0;
function check(label, condition, detail = "") {
  const mark = condition ? "ok  " : "FAIL";
  if (!condition) failures += 1;
  console.log(`${mark} ${label}${detail ? " - " + detail : ""}`);
}

const PROMPT =
  "Northwind Coffee Roasters, a specialty coffee roastery in Portland. " +
  "Warm editorial tone. Homepage with hero, features, a three-tier pricing table for wholesale, " +
  "an FAQ, testimonials, and a contact page with a form.";

const staging = await mkdtemp(join(tmpdir(), "hundred-c-"));
let build = null;
try {
  // --- compile ------------------------------------------------------------
  const compiler = createCompiler({ provider: "deterministic" });
  const compiled = await compiler.compile({ site_id: "northwind-coffee", prompt: PROMPT });
  check("compile succeeded", compiled.status !== "failed", compiled.spec ? "" : compiled.error?.detail);
  const spec = assertSiteSpec(compiled.spec, "smoke", "/compile");

  // --- capabilities -------------------------------------------------------
  const caps = capabilities();
  const report = matchCapabilities(spec, caps);
  check("capability match has no blockers", report.blocking.length === 0, report.blocking.join("; "));
  check("adapter covers every block the compiler emitted", report.unsupported_blocks.length === 0,
    report.unsupported_blocks.join(", "));

  // --- determinism of the placeholder (FR-C8 tier 3) ---------------------
  const svgA = renderPlaceholderSvg({ slotId: "hero", role: "hero", aspectRatio: "16:9", alt: "Coffee" });
  const svgB = renderPlaceholderSvg({ slotId: "hero", role: "hero", aspectRatio: "16:9", alt: "Coffee" });
  check("placeholder SVG is deterministic", svgA === svgB);
  const svgC = renderPlaceholderSvg({ slotId: "other", role: "hero", aspectRatio: "16:9", alt: "Coffee" });
  check("placeholder SVG varies per slot", svgA !== svgC);

  // --- build --------------------------------------------------------------
  const workdir = join(staging, "northwind-coffee");
  const t0 = Date.now();
  build = await buildSite({
    site_id: "northwind-coffee",
    spec,
    spec_hash: compiled.meta.spec_hash,
    template: "astro-nano",
    workdir,
    network: { offline: true },
    assets: { resolver: "placeholder" },
    budgets: { hard: true },
  });
  const wallMs = Date.now() - t0;
  const result = build.result;

  check("status is built or built_degraded", result.status !== "failed", result.status);
  check("spec_hash round-trips", result.spec_hash === compiled.meta.spec_hash);
  check("artifact hash present", typeof result.artifact_hash === "string" && result.artifact_hash.startsWith("sha256:"));

  // FR-C10: exactly the pages the spec declares, no more, no less. 404.html is
  // host infrastructure, not a spec page, so it is excluded from the comparison.
  const htmlFiles = result.files.map((f) => f.path).filter((p) => p.endsWith(".html") && p !== "404.html").sort();
  const expected = spec.pages.map((p) => (p.path === "/" ? "index.html" : p.path.replace(/^\//, "") + ".html")).sort();
  check("emitted exactly the declared pages", JSON.stringify(htmlFiles) === JSON.stringify(expected),
    `${htmlFiles.length} emitted vs ${expected.length} declared`);
  check("emitted a 404 fallback", result.files.some((f) => f.path === "404.html"));
  check("emitted sitemap and robots",
    result.files.some((f) => f.path === "sitemap.xml") && result.files.some((f) => f.path === "robots.txt"));

  // NFR-C9 / compliance: zero JS.
  check("zero JavaScript emitted", result.metrics.js_bytes === 0, `${result.metrics.js_bytes} bytes`);
  check("stylesheet emitted", result.metrics.css_bytes > 0);

  // FR-C12 bundle budget.
  check("bundle gate passed", result.gate["bundle"] === "pass", `${result.metrics.largest_bundle_kb} kB`);
  check("build time gate passed", result.gate["build_time"] === "pass", `${wallMs} ms wall`);
  check("LCP gate passed", result.gate["lcp"] === "pass");
  check("CLS gate passed", result.gate["cls"] === "pass");

  // FR-C15 / FR-C16.
  check("a11y gate passed", result.gate["a11y"] === "pass");
  check("security gate passed", result.gate["security"] === "pass");

  // FR-A9 mandates a canonical URL, and absolute canonicals are legal input,
  // so the hermeticity gate must exempt <link rel="canonical"> while still
  // rejecting genuinely loaded third-party subresources.
  const gatePage = (html) => [{ path: "/", html }];
  const gateAccepts = (html) => {
    try {
      securityGate(gatePage(html), join(workdir, "dist"));
      return true;
    } catch {
      return false;
    }
  };
  check("security gate allows an absolute canonical", gateAccepts(
    '<html lang="en"><head><link rel="canonical" href="https://example.com/services"></head><body></body></html>'));
  check("security gate allows rel before href on canonical", gateAccepts(
    '<html lang="en"><head><link href="https://example.com/" rel="canonical"></head><body></body></html>'));
  check("security gate rejects an external script", !gateAccepts(
    '<html lang="en"><body><script src="https://cdn.example.com/a.js"></script></body></html>'));
  check("security gate rejects an external stylesheet", !gateAccepts(
    '<html lang="en"><head><link rel="stylesheet" href="https://cdn.example.com/a.css"></head><body></body></html>'));
  check("security gate rejects an external image", !gateAccepts(
    '<html lang="en"><body><img src="https://cdn.example.com/a.png" alt="a"></body></html>'));
  check("spec fidelity gate passed", ["pass", "warn"].includes(result.gate["spec_fidelity"] ?? "pass"),
    result.gate["spec_fidelity"]);

  // Content assertions on the emitted home page.
  const home = await readFile(join(workdir, "dist", "index.html"), "utf8");
  check("home page has exactly one h1", (home.match(/<h1\b/g) ?? []).length === 1);
  check("home page has a lang attribute", /<html lang="[a-z]{2}/.test(home));
  check("home page has a skip link", home.includes('href="#main"'));
  check("home page has a main landmark", home.includes("<main id=\"main\">"));
  check("home page declares a description", /<meta name="description"/.test(home));
  check("home page links the stylesheet", home.includes('href="/css/main.css"'));
  // Image assertions run across every page, not just home: whichever page
  // happens to carry the hero slot is where the images land.
  const allImgs = [];
  for (const page of build.pages) allImgs.push(...(page.html.match(/<img\b[^>]*>/g) ?? []));
  check("spec declared assets and they resolved to files",
    spec.assets.length > 0 && build.assets.size === spec.assets.length,
    `${spec.assets.length} slots, ${build.assets.size} resolved`);
  check("every image has alt text", allImgs.every((tag) => /\balt="[^"]+"/.test(tag)), `${allImgs.length} images`);
  check("every image has width and height",
    allImgs.every((tag) => /\bwidth="\d+"/.test(tag) && /\bheight="\d+"/.test(tag)));
  check("no image src points at a remote host",
    allImgs.every((tag) => /src="\/assets\//.test(tag)));
  check("no inline event handlers", !/\son[a-z]+="/.test(home));
  check("no external references", !/(?:src|href)="https?:\/\//.test(home));
  check("no javascript: urls", !/javascript:/i.test(home));

  // --- determinism (FR-C23) ----------------------------------------------
  const workdir2 = join(staging, "northwind-coffee-2");
  const rebuild = await buildSite({
    site_id: "northwind-coffee",
    spec,
    spec_hash: compiled.meta.spec_hash,
    template: "astro-nano",
    workdir: workdir2,
    network: { offline: true },
    assets: { resolver: "placeholder" },
    budgets: { hard: true },
  });
  check("rebuild is byte-identical (same artifact hash)",
    rebuild.result.artifact_hash === result.artifact_hash,
    `${rebuild.result.artifact_hash?.slice(0, 18)} vs ${result.artifact_hash?.slice(0, 18)}`);

  // --- path escape refusal (FR-C17) --------------------------------------
  let escaped = false;
  try {
    await buildSite({
      site_id: "escape",
      spec: { ...spec, pages: [{ ...spec.pages[0], path: "/../../escape" }] },
      workdir: join(staging, "escape"),
      network: { offline: true },
    });
  } catch (error) {
    escaped = String(error?.message ?? "").includes("E_C_") || String(error?.message ?? "").includes("pattern");
  }
  check("spec with a traversing page path is rejected", escaped);

  // --- degradation ladder -------------------------------------------------
  const degradedReport = matchCapabilities(
    { ...spec, pages: [{ ...spec.pages[0], blocks: [{ id: "b1", type: "pricing_table", props: { plans: [{ name: "A", price: "$1", features: ["x"] }] } }] }] },
    { ...caps, blocks: caps.blocks.filter((b) => b !== "pricing_table") },
  );
  check("pricing_table degrades to feature_grid", degradedReport.degradations[0]?.to === "feature_grid",
    degradedReport.degradations[0]?.from + " -> " + degradedReport.degradations[0]?.to);

  console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: component C smoke, ${failures} failure(s)`);
} catch (error) {
  failures += 1;
  console.error("smoke threw:", error);
} finally {
  await rm(staging, { recursive: true, force: true });
}

process.exit(failures === 0 ? 0 : 1);
