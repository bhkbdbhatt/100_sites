/**
 * Public surface of the SSG adapter (FR-C1, FR-C2, FR-C3).
 *
 * The orchestrator consumes exactly four things from this package:
 *   capabilities()            - what this adapter can render (FR-C2)
 *   buildSite()               - in-process build, for tests and small batches
 *   runBuildChild()           - isolated build, one process per site (FR-C3)
 *   ADAPTER_CAPABILITIES_JSON - the machine-readable descriptor on disk
 */

export {
  ADAPTER_NAME,
  ADAPTER_VERSION,
  TEMPLATE_NAME,
  TEMPLATE_VERSION,
  TEMPLATE_RANGE,
  SUPPORTED_BLOCKS,
  capabilities,
  matchCapabilities,
  applyDegradations,
  usedBlockTypes,
} from "./capabilities.js";
export type { CapabilityMatchReport, Degradation } from "./capabilities.js";

export { buildSite } from "./adapter.js";
export type { BuildRequest, BuildResult, BuildOutcome } from "./adapter.js";

export { runBuildChild } from "./runner.js";

export { C_ERRORS, C_WARNINGS, cError } from "./errors.js";

export { renderAllPages, renderPage } from "./render/page.js";
export type { PageRenderResult } from "./render/page.js";
export { renderBlock, assertRegistryConsistency, blockRegistry } from "./render/blocks.js";
export { baseCss } from "./css/tokens.js";

export { renderPlaceholderSvg, aspectDimensions } from "./assets/placeholder.js";
export { resolveAssets } from "./assets/resolver.js";
export type { ResolvedAsset, ResolverTier } from "./assets/resolver.js";

export {
  a11yGate,
  bundleGate,
  bundleMetrics,
  buildTimeGate,
  clsGate,
  collectFiles,
  contrastSummary,
  estimateCoreWebVitals,
  lcpGate,
  pagesGate,
  securityGate,
  specFidelityGate,
} from "./verify/gates.js";
export type { BundleMetrics, GateOutcome } from "./verify/gates.js";

export { emitStatic } from "./emit/static.js";
export { emitAstro, resolveAstroBin } from "./emit/astro.js";
export { outputPathFor } from "./emit/shared.js";

import { ADAPTER_NAME, ADAPTER_VERSION, capabilities } from "./capabilities.js";
import { canonicalize } from "@pg/spec-schema";

/** The on-disk descriptor the orchestrator reads once per template version. */
export const ADAPTER_CAPABILITIES_JSON: string = canonicalize({
  ...capabilities(),
  adapter: ADAPTER_NAME,
  version: ADAPTER_VERSION,
});
