# Architecture

How HUNDRED turns many prompts into many published sites, and why it is built this way.

The authoritative contract is [`PLUGIN_REQUIREMENTS_SPEC.md`](PLUGIN_REQUIREMENTS_SPEC.md). This document explains the implementation behind it. Where the two disagree, the spec wins.

---

## Contents

- [Design constraints](#design-constraints)
- [Package graph](#package-graph)
- [Data flow](#data-flow)
- [Shared contracts (`spec-schema`)](#shared-contracts-spec-schema)
- [Plugin A — `spec-compiler`](#plugin-a--spec-compiler)
- [Plugin C — `ssg-adapter-astro`](#plugin-c--ssg-adapter-astro)
- [Plugin B — `batch-orchestrator`](#plugin-b--batch-orchestrator)
- [Cross-cutting concerns](#cross-cutting-concerns)
- [Determinism](#determinism)
- [Error model](#error-model)
- [Testing strategy](#testing-strategy)
- [Extension points](#extension-points)
- [Trade-offs](#trade-offs)

---

## Design constraints

Four constraints shaped every decision. They are the reason the system looks the way it does.

**One model call.** The compiler emits a schema-valid, canonicalised `SiteSpec` from a single prompt within one model call plus at most two structured-repair retries, inside a 30 s p99. If the model path cannot converge, the compiler falls back to a deterministic rule-based synthesizer and marks the result `degraded: true` rather than failing. There is no loop-until-valid behaviour.

**Hermetic and byte-identical.** The same `spec_hash` must produce a byte-identical `dist/`. No clock, no randomness, no network-dependent output. This is what makes content-addressed deduplication sound: if output were not deterministic, identical inputs could not be recognised as identical artifacts.

**Zero JavaScript by default.** Sites ship 0 kB of client-side JS and no third-party subresources. Performance, accessibility and security budgets are hard gates: a site that violates one fails with a typed diagnostic rather than shipping.

**Bounded.** Deadlines, cost ceilings, per-site timeouts, memory ceilings and performance budgets are enforced, not advisory. A site that violates a budget takes down that site, never the batch.

## Package graph

Three plugins, three shared libraries. Plugins depend on the shared libraries; they do not depend on each other.

```
                    ┌──────────────┐
                    │ spec-schema  │  RFC 8785 JSON, BLAKE3, JSON Schema,
                    │              │  RFC 9457 problem details
                    └──────┬───────┘
              ┌────────────┼────────────┐
              │            │            │
      ┌───────▼──────┐ ┌───▼────────┐ ┌─▼────────────────┐
      │  redaction   │ │ telemetry  │ │  (no plugin deps) │
      └───────┬──────┘ └───┬────────┘ └─┬────────────────┘
              │            │            │
      ┌───────▼────────────▼────────────▼─────┐
      │          spec-compiler  (A)           │
      └──────────────────┬────────────────────┘
                         │  SiteSpec + spec_hash
      ┌──────────────────▼────────────────────┐
      │       ssg-adapter-astro  (C)          │
      └──────────────────┬────────────────────┘
                         │  BuildResult + artifact_hash
      ┌──────────────────▼────────────────────┐
      │       batch-orchestrator  (B)         │  ── also owns the CLI
      └───────────────────────────────────────┘
```

`spec-batch`'s control flow is A and C per site, driven by B across sites. B consumes both; neither A nor C knows B exists.

| Package | Version | Role |
|---|---|---|
| `spec-schema` | 1.0.0 | Single source of truth for all cross-component contracts |
| `redaction` | 0.3.0 | PII/secret redaction and prompt-injection neutralisation |
| `telemetry` | 0.4.0 | Spans, counters, histograms; pluggable, non-blocking sink |
| `spec-compiler` | 1.0.0 | Plugin A — prompt → `SiteSpec` |
| `ssg-adapter-astro` | 1.0.0 | Plugin C — `SiteSpec` → static site, budget gates |
| `batch-orchestrator` | 1.0.0 | Plugin B — many prompts → many published sites, plus the CLI |

## Data flow

```
prompt (string)
  │
  ├─► sanitizePrompt ─────► PII/secret redaction (FR-A2)
  │                        injection neutralisation (FR-A3)
  │                        length guard → E_A_PROMPT_TOO_LONG
  │
  ├─► compile ───────────► one model call
  │                          └─ invalid? ─► structured repair (≤2 retries)
  │                                          └─ still invalid? ─► deterministic
  │                                                                 synthesizer,
  │                                                                 degraded: true
  │
  ├─► assertSiteSpec ────► JSON Schema 2020-12 validation
  ├─► canonicalize ──────► stable keys, sorted pages, normalised slugs (FR-A13)
  ├─► specHash ──────────► BLAKE3-256 over RFC 8785 JSON, provenance excluded (FR-A14)
  │
  │   ══ per site, bounded by the scheduler ══
  │
  ├─► buildSite ─────────► emit pages → discover files → hash → gate
  │                          │                │          │
  │                          │                │          └─ budget gates → throw typed
  │                          │                │             diagnostic on violation
  │                          │                └─ Merkle root → artifact_hash
  │                          └─ hero + lazy assets, concurrency-capped
  │
  └─► publish ───────────► atomic: write to a CAS slot, then swap into place
                             identical artifact_hash ─► deduplicated, no rebuild
```

Two hashes, doing different jobs:

- **`spec_hash`** — identity of *intent*. BLAKE3-256 over the RFC 8785 canonical form of the spec, excluding provenance and timestamps. Equal `spec_hash` means the request was the same.
- **`artifact_hash`** — identity of *bytes*. Merkle root over the emitted file manifest. Equal `artifact_hash` means the output was the same.

Deduplication keys on `artifact_hash`, not `spec_hash`, because two different specs can legitimately render to identical bytes. Keying on the wrong one would either miss real duplicates or collapse sites that differ.

## Shared contracts (`spec-schema`)

Everything that crosses a component boundary is defined once, here:

- **RFC 8785 canonical JSON.** A strict canonicalizer: sorted object keys, no `undefined` members, no array holes, no non-finite numbers. A non-canonical serializer would break the byte-identity guarantee, so this is a hardened implementation rather than `JSON.stringify` with sorted keys.
- **BLAKE3-256 hashing** — `specHash()` and `merkleRoot()`, via `@noble/hashes`.
- **JSON Schema 2020-12 definitions** — the `SiteSpec` shape both the compiler emits and the adapter accepts, plus `BuildResult`, which the orchestrator validates against the *same* contract.
- **RFC 9457 problem details** — every typed error is a problem document with a stable code.
- **A version-tolerant reader** — accepts near-miss contract versions instead of hard-failing on an otherwise valid document.

## Plugin A — `spec-compiler`

Prompt in, `SiteSpec` out.

**Sanitisation.** `sanitizePrompt` redacts PII and secrets before egress and neutralises prompt-injection attempts. This runs before anything touches a provider, so an injected instruction never reaches a model.

**Budgets, enforced up front.** An empty prompt is `E_A_PROMPT_EMPTY`; one over `MAX_PROMPT_CHARS` (4000) is `E_A_PROMPT_TOO_LONG`. Earlier versions silently truncated over-long prompts and warned — that is now a hard rejection, because a truncated prompt produces a site that quietly fails to match what was asked for, and a warning nobody reads is not a guarantee.

**The single-call contract.** One model call, at most two structured-repair retries when the response fails schema validation, then the deterministic rule-based synthesizer. The synthesizer emits `degraded: true` rather than throwing. A site built from the fallback is a real, valid site; it is marked so downstream reporting can tell the difference.

**Canonicalisation.** Stable key ordering, pages sorted by path, slugs lowercased, ASCII-folded, hyphen-separated, capped at 64 characters with reserved segments removed, block IDs de-duplicated. Deterministic input ordering is what makes `spec_hash` reproducible.

## Plugin C — `ssg-adapter-astro`

Spec in, static site out.

**Exact page set.** The adapter renders exactly the pages the spec declares — no more, no fewer — and `specFidelityGate` fails the build if the counts disagree. The page gate is checked against `effectiveSpec.pages.length`, *not* `metrics.page_count`: the emitter always writes a reserved `404.html`, which is an artifact but not a declared page, and budgeting it against the declared count would fail every site that reserves a 404.

**Hermetic static driver.** `driver: "static"` is the default and needs no toolchain, no network and no install step. The Astro driver exists for real Astro builds. Both go through the same gates.

**Assets.** A three-tier ladder: `local` (a file inside the site root), `remote` (allowlisted HTTPS only), `placeholder` (a deterministic SVG). Tiers degrade in that order.

Local assets are confined with `relative()` and `isAbsolute()` against the resolved site root, not a string prefix. A prefix check is not containment: with site root `…/site`, the path `…/site-backup/secret.png` passes `startsWith(siteRoot)` while being outside the root. Paths are also rejected if `localMap` contains a URL — a URL there is a remote-tier request in disguise, not a local file.

The worker pool is sized defensively. A non-finite `maxConcurrency` would otherwise reach `Array.from({ length: NaN })`, producing zero workers and a silently empty result — a pipeline that appears to succeed while resolving no assets at all.

Remote URLs are constructed as real HTTPS URLs from allowlist entries and carry `q`/`w` parameters. Offline runs short-circuit to placeholders and are marked `built_degraded` with `W_C_ASSET_OFFLINE`, because the degradation is real and should be visible in the report.

**Gates.** Run against the emitted bytes, not against intentions:

| Gate | Checks |
|---|---|
| `bundleGate` | Total and largest bundle within budget |
| `pagesGate` | Declared page count within budget |
| `buildTimeGate` | Build wall time within budget |
| `lcpGate` / `clsGate` | Static Core Web Vitals estimates from the largest above-the-fold image and blocking CSS |
| `a11yGate` | Landmarks, heading structure, labels, contrast |
| `securityGate` | No executable content, no third-party subresources, no leaked absolute paths |
| `specFidelityGate` | Emitted page set matches the declared page set |

`securityGate` scans for `src=`/`href=` pointing at `http(s)://`, but exempts `<link rel="canonical">`. FR-A9 requires a canonical URL and real multi-domain SEO setups use an absolute origin there; that is declarative metadata, not a subresource the page loads, and failing a build over it would be a false positive. External `<script>`, `<link rel="stylesheet">` and `<img src>` are still rejected, and the exemption is covered by regression tests in both directions.

**Determinism.** No timestamps, no randomness, no network-dependent output in emitted bytes. `metrics` carries `install_ms`, `build_ms`, `total_ms`, `total_bytes`, `largest_bundle_kb`, `js_bytes`, `css_bytes`, `image_count`, `image_bytes`, `page_count`, `external_request_count`, `lcp_estimate_ms` and `cls_estimate_ms`.

## Plugin B — `batch-orchestrator`

Prompts in, published sites out, plus the `specbatch` CLI.

**Two-lane concurrency.** Compiling and building are separate lanes with independent semaphores (`max_parallel_compiles`, `max_parallel_builds`) because they have different bottlenecks: compiling is CPU-bound, building is I/O-bound. Coupling them into one pool would let a slow build throttle compilation.

The token bucket refills from a single injected clock, read once at construction and again after each wait. Mixing an injected clock with a real one produces tokens that appear to refill but never do — the bucket then grants unlimited concurrency and the concurrency cap silently stops existing.

**Deadline and timeout semantics.** `deadline_ms` is a batch-wide wall-clock budget; `site_timeout_ms` is per site. Sites that cannot finish within the remaining deadline are **skipped, not failed** — a deadline is a budget decision, not a defect. Retryability is computed from the error, and deadline and skipped outcomes are deliberately non-retryable: retrying cannot un-pass a deadline.

**Retry and backoff.** `max_attempts` with `retry_backoff_ms`, applied only to retryable codes (`E_B_BUILD_FAILED` is; `E_B_DEADLINE_EXCEEDED` is not). A circuit breaker opens after sustained failures so a broken dependency is not hammered.

**Journal and resume.** Every state transition is journalled to `journal/` in the output root. `--resume` replays the journal and continues unfinished sites. `E_B_STATE_CORRUPT` fires if the journal cannot be trusted, rather than silently producing a partial batch.

**Publication.** The adapter returns `artifact_hash`; the orchestrator publishes into the content-addressed store at `cas/sha256-<hex>/`. If the artifact already exists the site is recorded as deduplicated and no rebuild happens. A second identical run of the bundled fixture delivers 100/100 with `W_B_DEDUPLICATED` and near-zero build cost.

Site directories under `sites/<site_id>/` are published from the store. On platforms where that is a directory junction or symlink, `readdir` reports the entry as a symbolic link rather than a directory, so tooling that enumerates the output should walk `cas/` directly.

**Path safety.** Site IDs become directory names, so they are validated against traversal (`E_B_PATH_ESCAPE`) before anything touches the filesystem.

**Reporting.** Every run writes `.result.json`, `.sites.csv` and `.report.md`. The JSON is the contract; the CSV and Markdown are derived views. `specbatch report <result.json> --out DIR` regenerates the derived reports from a stored result without re-running the batch.

## Cross-cutting concerns

**Redaction** (`redaction`) sits at the egress boundary. `redact`, `neutralizeInjection` and `sanitizePrompt` strip PII and secrets and defuse injection attempts before a prompt leaves the process.

**Telemetry** (`telemetry`) is a structured span/counter/histogram layer with a pluggable sink and zero mandatory dependencies. `noopLogger` and `MemorySink` mean instrumentation can be omitted entirely, and a slow sink can never block the pipeline. It observes; it does not gate.

## Determinism

Determinism is a chain, and each link is load-bearing:

1. Canonical JSON (RFC 8785) — stable key order, no ambiguity.
2. BLAKE3-256 over that canonical form, excluding provenance and timestamps — a stable identity for the same request.
3. A hermetic emitter with no clock, no randomness and no network in the output bytes.
4. A Merkle root over the emitted files — a stable identity for the output.
5. Content-addressed storage keyed on that root — identical output is stored once.

Break any link and deduplication becomes unsound: two "identical" artifacts that differ by a timestamp would be stored twice, and a rebuilt site would churn the store on every run.

## Error model

Every failure carries a stable code and RFC 9457 problem details. Nothing fails silently — this is why gate violations and resolver failures surface as typed diagnostics rather than as a short output tree.

- **Component A:** `E_A_PROMPT_EMPTY`, `E_A_PROMPT_TOO_LONG`, `E_A_PROMPT_UNSAFE`, `E_A_CONTENT_FILTERED`, `E_A_PROVIDER_ERROR`, `E_A_RATE_LIMITED`, `E_A_LLM_TIMEOUT`, `E_A_SCHEMA_INVALID`, `E_A_REPAIR_EXHAUSTED`, `E_A_SPEC_TOO_LARGE`, `E_A_BUDGET_EXCEEDED`
- **Component B:** `E_B_BATCH_INVALID`, `E_B_COMPILE_FAILED`, `E_B_BUILD_FAILED`, `E_B_PUBLISH_FAILED`, `E_B_TEMPLATE_UNAVAILABLE`, `E_B_PROVIDER_UNAVAILABLE`, `E_B_RATE_LIMITED`, `E_B_DEADLINE_EXCEEDED`, `E_B_CANCELLED`, `E_B_BUDGET_EXCEEDED`, `E_B_CONCURRENCY_INVALID`, `E_B_PATH_ESCAPE`, `E_B_STATE_CORRUPT`
- **Component C:** `E_C_SPEC_INVALID`, `E_C_TEMPLATE_UNSUPPORTED`, `E_C_TEMPLATE_COMPILE`, `E_C_BLOCK_UNSUPPORTED`, `E_C_BUDGET_EXCEEDED`, `E_C_A11Y_FAILED`, `E_C_SECURITY_VIOLATION`, `E_C_PATH_ESCAPE`, `E_C_WORKDIR_INVALID`, `E_C_TIMEOUT`, `E_C_OUT_OF_MEMORY`, `E_C_MODULE_RESOLVE`, `E_C_STORE_UNAVAILABLE`

Warnings (`W_A_*`, `W_B_*`, `W_C_*`) mark degradation that was survived rather than a failure — for example `W_C_ASSET_OFFLINE` and `W_B_DEDUPLICATED`.

## Testing strategy

Smoke suites double as the acceptance tests, driven by `npm run smoke`:

| Suite | Covers |
|---|---|
| `scripts/smoke-foundation.mjs` | Canonical JSON, BLAKE3 hashing, schema validation, problem details, redaction |
| `scripts/smoke-compiler.mjs` | Spec validity, determinism, budget enforcement, injection resistance |
| `scripts/smoke-ssg.mjs` | Every gate, page fidelity, determinism (identical spec → identical artifact hash), the degradation ladder, asset-path confinement, security-gate exemptions |
| `scripts/smoke-batch.mjs` | 79 checks over concurrency, deadlines, retryability, circuit breaker, deduplication, journal/resume, reporting |

`scripts/run-100.mjs` is the end-to-end acceptance run. It exits non-zero unless every requested site was delivered, so it is usable directly as a release gate.

Supporting tooling: `scripts/lint.mjs` (project lint rules), `scripts/normalize-whitespace.mjs`, `scripts/audit-interpolations.mjs` (detects stripped `${...}` interpolations), `scripts/repair-interpolations.mjs` and `scripts/fix-interpolation-spacing.mjs` (repair tools).

## Extension points

- **Model provider** — the compiler talks to a provider interface. Swap in a hosted model; if it cannot converge within the repair budget the deterministic synthesizer takes over and the result is marked `degraded`.
- **Asset tier** — a new tier slots into the existing ladder. It must be allowlist-constrained and confined to the site root.
- **SSG driver** — `driver: "static"` and `driver: "astro"` both implement the same contract. A new engine implements the same interface and inherits every gate.
- **Template** — templates declare capabilities; requesting an unsupported one fails with `E_C_TEMPLATE_UNSUPPORTED` naming what *is* available, rather than failing later with a confusing rendering error.
- **Telemetry sink** — any object implementing the sink interface; `noopLogger` disables it.
- **Storage backend** — the CAS is behind the store interface, so an alternative artifact store can be substituted.

## Trade-offs

**A deterministic fallback rather than a hard failure.** When the model path cannot converge, the compiler synthesizes a valid spec and marks it `degraded` instead of failing the site. The trade is explicit quality against guaranteed delivery: you always get a real site, and the report tells you which ones used the fallback. Failing instead would be simpler but would make the pipeline's output depend on model availability.

**Rejections instead of truncation.** Over-long prompts fail with `E_A_PROMPT_TOO_LONG` rather than being silently truncated. Silent truncation produces a site that does not match the request and nobody notices; a rejection is visible and actionable.

**A canonical-URL exemption in the security gate.** A literal reading of "no external references" would reject absolute canonicals. That reading is wrong for the requirement's purpose — hermeticity is about not loading third-party subresources — so the gate exempts `<link rel="canonical">` while still rejecting external scripts, stylesheets and images. Both directions are tested.

**Smoke suites instead of a unit-test framework.** The contracts between components are the interesting surface, and they are exercised end to end against real emitted bytes. The cost is less granular failure reporting; the benefit is that every guarantee in this document is checked against the actual artifact rather than a mock.

**An in-repo TypeScript build with `dist/`.** Plugins run as compiled JavaScript so the CLI and scripts can import them directly. This means `npm run build` is a prerequisite for anything that runs the pipeline — a real ergonomic cost, paid for by removing an entire class of loader and transpilation problems.