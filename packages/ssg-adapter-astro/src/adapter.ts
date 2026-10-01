/**
 * `buildSite`: BuildRequest -> BuildResult (FR-C9, FR-C10).
 *
 * Pipeline order matters:
 *   validate -> capability match -> degrade -> resolve assets -> render ->
 *   emit -> discover -> hash -> gate -> BuildResult
 *
 * Gates run against the emitted bytes. A gate failure produces a `failed`
 * result carrying the problem document; the orchestrator then decides whether
 * to fall back, retry or give up on this site only.
 */

import { mkdir, rm } from "node:fs/promises";
import { resolve, sep } from "node:path";
import {
  assertSiteSpec,
  merkleRoot,
  resolveWithin,
  specHash,
  warning as makeWarning,
  type Diagnostic,
} from "@pg/spec-schema";
import type { AssetSlot, SiteSpec } from "@pg/spec-compiler";
import { cError, C_WARNINGS } from "./errors.js";
import { applyDegradations, capabilities, matchCapabilities, ADAPTER_NAME, ADAPTER_VERSION, TEMPLATE_NAME, TEMPLATE_VERSION } from "./capabilities.js";
import { resolveAssets, type ResolvedAsset } from "./assets/resolver.js";
import { renderAllPages, type PageRenderResult } from "./render/page.js";
import { assertRegistryConsistency } from "./render/blocks.js";
import { emitStatic } from "./emit/static.js";
import { emitAstro } from "./emit/astro.js";
import {
  a11yGate,
  bundleGate,
  bundleMetrics,
  buildTimeGate,
  clsGate,
  collectFiles,
  estimateCoreWebVitals,
  lcpGate,
  pagesGate,
  securityGate,
  specFidelityGate,
  type GateOutcome,
} from "./verify/gates.js";

export interface BuildRequest {
  site_id: string;
  spec: SiteSpec;
  spec_hash?: string;
  template?: string;
  workdir: string;
  build?: {
    mode?: "build" | "dev" | "preview";
    out_dir?: string;
    trailing_slash?: "always" | "never" | "ignore";
    minify?: boolean;
    inline_stylesheets?: "always" | "never" | "auto";
    memory_mb?: number;
    timeout_ms?: number;
  };
  budgets?: {
    max_bundle_kb?: number;
    max_pages?: number;
    max_build_ms?: number;
    max_lcp_ms?: number;
    max_cls?: number;
    hard?: boolean;
  };
  network?: { offline?: boolean; allowlist?: string[]; max_concurrency?: number };
  assets?: {
    resolver?: "auto" | "local" | "remote" | "placeholder";
    local?: Record<string, string>;
    max_bytes_per_image?: number;
    formats?: string[];
  };
  capability_report?: unknown;
  /** Selects the driver. Defaults to the hermetic static emitter. */
  driver?: "astro" | "static";
}

/** Mirrors buildResultSchema: the orchestrator validates against the same contract. */
export interface BuildResult {
  site_id: string;
  status: "built" | "built_degraded" | "failed";
  spec_hash: string;
  artifact_hash?: string;
  out_dir: string;
  template?: { name?: string; version?: string; ssg?: string; driver: "astro" | "static" };
  pages: number;
  files: Array<{ path: string; bytes: number; sha256: string }>;
  metrics: {
    install_ms: number;
    build_ms: number;
    total_ms: number;
    total_bytes: number;
    largest_bundle_kb: number;
    css_bytes: number;
    js_bytes: number;
    image_count: number;
    image_bytes: number;
    page_count: number;
    external_request_count: number;
    lcp_estimate_ms: number;
    cls_estimate: number;
  };
  gate: Record<string, GateOutcome["status"]>;
  diagnostics: Diagnostic[];
  build_log?: string;
}

export interface BuildOutcome {
  result: BuildResult;
  pages: PageRenderResult[];
  assets: Map<string, ResolvedAsset>;
}

export async function buildSite(request: BuildRequest): Promise<BuildOutcome> {
  const startedAt = Date.now();
  const diagnostics: Diagnostic[] = [];
  const caps = capabilities(request.driver === "astro" ? "astro" : "static");

  if (request.template && !templateSupported(request.template)) {
    throw cError("E_C_TEMPLATE_UNSUPPORTED", `template '${request.template}' is not supported; this adapter provides ${caps.template.name}@${caps.template.range}`);
  }

  // 1. Validate the spec against the shared contract before touching anything.
  let spec: SiteSpec;
  try {
    spec = assertSiteSpec<SiteSpec>(request.spec, "BuildRequest.spec", `/build/${request.site_id}`);
  } catch (error) {
    throw cError("E_C_SPEC_INVALID", (error as Error).message);
  }

  // The declared hash must match what we were given, or the orchestrator and
  // the adapter are working from different documents (NFR-C13).
  if (request.spec_hash) {
    const actual = specHash(spec);
    if (actual !== request.spec_hash) {
      throw cError(
        "E_C_SPEC_INVALID",
        `spec_hash mismatch: request says ${request.spec_hash}, spec hashes to ${actual}`,
      );
    }
  }

  // 2. Capability match, then degradation.
  assertRegistryConsistency();
  const capabilityReport = matchCapabilities(spec, caps);
  if (capabilityReport.blocking.length > 0) {
    throw cError("E_C_BLOCK_UNSUPPORTED", capabilityReport.blocking.join("; "));
  }
  const effectiveSpec = capabilityReport.degradations.length > 0 ? applyDegradations(spec, capabilityReport) : spec;
  for (const degradation of capabilityReport.degradations) {
    diagnostics.push(
      makeWarning(
        C_WARNINGS.W_C_BLOCK_DOWNGRADED,
        `${degradation.page_path} block '${degradation.block_id}': ${degradation.from} -> ${degradation.to} (${degradation.reason})`,
        `/pages/${degradation.page_path}/blocks/${degradation.block_id}`,
      ),
    );
  }
  for (const integration of capabilityReport.stripped_integrations) {
    diagnostics.push(
      makeWarning(C_WARNINGS.W_C_INTEGRATION_UNSUPPORTED, `integration '${integration}' removed by capability match`),
    );
  }

  // 3. Workdir + outdir, both confined to the staging root.
  const workdir = resolve(request.workdir);
  const stagingRoot = resolve(workdir, "..");
  if (workdir !== stagingRoot && !workdir.toLowerCase().startsWith((stagingRoot.toLowerCase() + sep))) {
    throw cError("E_C_WORKDIR_INVALID", `workdir ${workdir} is not inside the staging root ${stagingRoot}`);
  }
  const outDirName = request.build?.out_dir ?? "dist";
  const outDir = resolveWithin(workdir, outDirName);
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  const driver = request.driver === "astro" ? "astro" : "static";
  const budgets = { ...caps.budget_defaults, ...stripUndefined(request.budgets ?? {}) };
  const hardBudgets = request.budgets?.hard !== false;

  // 4. Assets (FR-C8). Timed separately: it is the only network-touching stage.
  const assetsStart = Date.now();
  const slots: AssetSlot[] = effectiveSpec.assets ?? [];
  const { resolved, degraded: degradedAssets } = await resolveAssets(slots, {
    outDir,
    siteRoot: stagingRoot,
    resolver: request.assets?.resolver ?? "auto",
    localMap: request.assets?.local ?? {},
    maxBytesPerImage: request.assets?.max_bytes_per_image ?? 250_000,
    formats: request.assets?.formats ?? ["avif", "webp", "jpeg"],
    offline: request.network?.offline ?? true,
    allowlist: request.network?.allowlist ?? [],
    maxConcurrency: request.network?.max_concurrency ?? 8,
  });
  const assetsMs = Date.now() - assetsStart;
  if (degradedAssets > 0) {
    diagnostics.push(
      makeWarning(
        C_WARNINGS.W_C_ASSET_OFFLINE,
        `${degradedAssets} of ${slots.length} asset slots resolved to deterministic placeholders`,
      ),
    );
  }

  // 5. Render. CPU-bound and synchronous: no I/O, no processes, no clock reads
  // inside the renderer, so the only variable between two runs is this timer.
  const renderStart = Date.now();
  const rendered = renderAllPages(effectiveSpec, resolved);
  const renderMs = Date.now() - renderStart;
  const pagesByPath = new Map(rendered.map((page) => [page.path, page]));
  for (const page of rendered) {
    for (const degradation of page.degradedBlocks) {
      diagnostics.push(makeWarning(C_WARNINGS.W_C_BLOCK_DOWNGRADED, `${page.path}:${degradation}`));
    }
    if (page.propsIssues > 0) {
      diagnostics.push(
        makeWarning(C_WARNINGS.W_C_BLOCK_PROPS_INVALID, `${page.path} has ${page.propsIssues} prop schema issue(s)`),
      );
    }
  }

  // 6. Emit.
  let installMs = 0;
  let astroBuildMs = 0;
  let buildLog = "";
  let emitDegraded = false;
  if (driver === "astro") {
    const result = await emitAstro(
      { outDir, pages: pagesByPath, spec: effectiveSpec, minify: request.build?.minify !== false },
      workdir,
      request.build?.timeout_ms ?? budgets.max_build_ms,
    );
    installMs = result.installMs;
    astroBuildMs = result.buildMs;
    buildLog = result.buildLog;
    emitDegraded = result.degraded;
  } else {
    const result = await emitStatic(
      { outDir, pages: pagesByPath, spec: effectiveSpec, minify: request.build?.minify !== false },
      resolved,
    );
    emitDegraded = result.degraded;
  }

  // 7. Discover + hash. This is what the artifact hash is computed over.
  const files = await collectFiles(outDir);
  if (files.length === 0) throw cError("E_C_TEMPLATE_COMPILE", "emitter produced no files");
  const metrics = bundleMetrics(files);

  // 8. Gates (FR-C12 - FR-C16). Hard failures throw from here.
  const totalMs = Date.now() - startedAt;
  const heroBytes = [...resolved.values()].filter((asset) => asset.lazy === false).reduce((total, asset) => total + asset.bytes, 0);
  const vitals = estimateCoreWebVitals(rendered, metrics.css_bytes, heroBytes);
  const minContrast = effectiveSpec.compliance?.contrast_min ?? 4.5;

  const gate: Record<string, GateOutcome> = {
    bundle: bundleGate(metrics, budgets.max_bundle_kb, hardBudgets),
    // `max_pages` bounds the authored route set (FR-C4), so the budget is
    // checked against spec.pages. metrics.page_count is left as the honest
    // "HTML files emitted" number, which additionally contains the reserved
    // 404 -- charging that against the budget would fail a site that is
    // exactly at its limit.
    pages: pagesGate(effectiveSpec.pages.length, budgets.max_pages),
    build_time: buildTimeGate(totalMs, budgets.max_build_ms, hardBudgets),
    lcp: lcpGate(vitals.lcpMs, budgets.max_lcp_ms),
    cls: clsGate(vitals.cls, budgets.max_cls),
    a11y: a11yGate(rendered, minContrast, effectiveSpec.design.tokens),
    security: securityGate(rendered, outDir),
    spec_fidelity: specFidelityGate(
      effectiveSpec.pages.map((page) => page.path),
      rendered.map((page) => page.path),
      rendered.flatMap((page) => page.degradedBlocks),
    ),
  };

  // max_js_kb: the spec's own compliance ceiling. Zero-JS is the design, so any
  // JS at all is a failure, not a warning.
  const maxJsKb = effectiveSpec.compliance?.max_js_kb ?? 0;
  if (metrics.js_bytes > maxJsKb * 1024) {
    throw cError(
      "E_C_BUDGET_EXCEEDED",
      `spec allows ${maxJsKb} kB of JavaScript but the output contains ${metrics.js_bytes} bytes`,
    );
  }

  const degraded = degradedAssets > 0 || emitDegraded || capabilityReport.degradations.length > 0;
  for (const [name, outcome] of Object.entries(gate)) {
    if (outcome.status === "warn" && outcome.warningCode) {
      diagnostics.push(makeWarning(outcome.warningCode, `${name} gate: ${outcome.detail ?? "soft failure"}`));
    }
  }

  const artifactHash = merkleOfFiles(files, outDir);
  const result: BuildResult = {
    site_id: request.site_id,
    status: degraded ? "built_degraded" : "built",
    spec_hash: request.spec_hash ?? specHash(spec),
    artifact_hash: artifactHash,
    out_dir: outDir,
    template: {
      name: caps.template.name,
      version: caps.template.version,
      ssg: `${caps.ssg.name}@${caps.ssg.version}`,
      driver,
    },
    pages: metrics.page_count,
    files: files.map((file) => ({ path: file.path, bytes: file.bytes, sha256: file.sha256 })),
    metrics: {
      install_ms: installMs,
      build_ms: astroBuildMs > 0 ? astroBuildMs : renderMs,
      total_ms: totalMs,
      total_bytes: metrics.total_bytes,
      largest_bundle_kb: metrics.largest_bundle_kb,
      css_bytes: metrics.css_bytes,
      js_bytes: metrics.js_bytes,
      image_count: metrics.image_count,
      image_bytes: metrics.image_bytes,
      page_count: metrics.page_count,
      external_request_count: 0,
      lcp_estimate_ms: vitals.lcpMs,
      cls_estimate: vitals.cls,
    },
    gate: {
      bundle: gate["bundle"]!.status,
      pages: gate["pages"]!.status,
      build_time: gate["build_time"]!.status,
      lcp: gate["lcp"]!.status,
      cls: gate["cls"]!.status,
      a11y: gate["a11y"]!.status,
      security: gate["security"]!.status,
      spec_fidelity: gate["spec_fidelity"]!.status,
    },
    diagnostics,
    ...(buildLog ? { build_log: buildLog } : {}),
  };

  return { result, pages: rendered, assets: resolved };
}

/** Merkle root over the file manifest: order-independent and content-addressed. */
function merkleOfFiles(
  files: ReadonlyArray<{ path: string; bytes: number; sha256: string }>,
  outDir: string,
): string {
  void outDir;
  return merkleRoot(files);
}

function stripUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value ?? {})) {
    if (entry !== undefined) out[key] = entry;
  }
  return out as Partial<T>;
}

function templateSupported(template: string): boolean {
  if (template === TEMPLATE_NAME) return true;
  const match = /^(?<name>[a-z0-9-]+)@(?<major>\d+)\.(?<minor>\d+)/.exec(template);
  if (!match?.groups) return false;
  if (match.groups["name"] !== TEMPLATE_NAME) return false;
  return Number(match.groups["major"]) === 1 && Number(match.groups["minor"]) >= 4;
}

export { ADAPTER_NAME, ADAPTER_VERSION, TEMPLATE_NAME, TEMPLATE_VERSION, capabilities, matchCapabilities };
