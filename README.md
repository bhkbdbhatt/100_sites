# HUNDRED

Turn a batch of plain-language prompts into a batch of complete, static, production-ready websites.

One prompt in, one schema-valid spec out, one hermetic static site published — repeated for hundreds of sites in a single command, with deduplication, bounded concurrency, deadlines, retries and machine-readable reporting.

```bash
npm install
npm run build
npm run batch:100          # compiles and builds all 100 sites in examples/batch-100.yaml
```

Measured on a clean checkout of the bundled fixture (8-core laptop, fully offline):

| | |
|---|---|
| Sites delivered | **100 / 100** (0 failed, 0 skipped) |
| Pages emitted | 794 |
| Total output | 3.81 MB |
| Client-side JavaScript | **0 kB** |
| Model cost | **$0.0000** |
| Wall clock | ~10–13 s |
| Throughput | 61–77 pages/s |

---

## Contents

- [What it does](#what-it-does)
- [Requirements](#requirements)
- [Install and build](#install-and-build)
- [Usage](#usage)
  - [The 100-site demonstration](#the-100-site-demonstration)
  - [The `specbatch` CLI](#the-specbatch-cli)
  - [Generating a batch manifest](#generating-a-batch-manifest)
  - [Writing your own manifest](#writing-your-own-manifest)
- [Scaling past 100 sites](#scaling-past-100-sites)
- [Output layout](#output-layout)
- [Verifying an installation](#verifying-an-installation)
- [Repository layout](#repository-layout)
- [Guarantees](#guarantees)
- [Licence](#licence)

---

## What it does

HUNDRED is three cooperating plugins plus three shared libraries. The authoritative contract for all of them is [`PLUGIN_REQUIREMENTS_SPEC.md`](PLUGIN_REQUIREMENTS_SPEC.md).

```
prompt
  │
  ├─ redaction ────────────► PII / secret redaction, prompt-injection neutralisation
  │
  ├─ spec-compiler ────────► SiteSpec  (JSON Schema 2020-12, canonicalised, BLAKE3 spec_hash)
  │
  └─ batch-orchestrator ──► queue, bounded concurrency, deadline, retry, cost ceiling
        │
        └─ ssg-adapter-astro ─► static site + budget gates + artifact_hash
              │
              └─ content-addressed store ─► atomically published site directory
```

- **Prompt → spec.** A prompt is sanitised, then compiled into a `SiteSpec`: pages, blocks, design tokens, SEO payload, asset slots. The spec is canonicalised (stable key order, sorted pages, normalised slugs) and hashed with BLAKE3-256 over RFC 8785 canonical JSON.
- **Spec → site.** The adapter renders exactly the pages the spec declares — no more, no fewer — enforces performance, accessibility and security budgets, and emits **0 kB of JavaScript by default**.
- **Site → store.** The output tree is hashed into a Merkle root. Identical output is stored once; a second identical site is deduplicated instead of rebuilt.

The 100 sites are genuinely distinct: the bundled fixture varies industry, audience, tone and required sections so that pricing tables, FAQs, contact forms, testimonials and galleries all get exercised.

## Requirements

- **Node.js ≥ 22.11.0** (`engines` in `package.json`)
- npm (the repository uses npm workspaces; `pnpm-workspace.yaml` is included for convenience)
- **No API key and no network access are required.** The default provider is the deterministic rule-based synthesizer and the default asset resolver is `placeholder`, so the pipeline runs fully hermetically. Point it at a model provider to use one — the fallback keeps working when a provider cannot converge.

## Install and build

```bash
npm install
npm run build          # tsc --build across all six packages
```

Everything runs from compiled JavaScript in each package's `dist/`, so `build` must run before any script that imports the pipeline.

## Usage

### The 100-site demonstration

```bash
npm run batch:100                          # -> out/100
node scripts/run-100.mjs --out .work/100   # same run, with a metrics summary and reports
```

`scripts/run-100.mjs` validates the manifest, runs the batch, prints a summary table, writes the three reports, lists every failure and degradation, and **exits non-zero unless every requested site was delivered**.

```bash
node scripts/run-100.mjs --help          # flags: --manifest, --out, --keep-workdir
```

### The `specbatch` CLI

```bash
npm run batch -- <command> [args]
# or, equivalently:
node packages/batch-orchestrator/dist/cli.js <command> [args]
```

```
specbatch run <batch.yaml> [--out DIR] [--deadline MINUTES] [--resume] [--dry-run]
specbatch validate <batch.yaml>
specbatch report <result.json> [--out DIR]

  --out DIR             output root (overrides the manifest's output.dest)
  --deadline MINUTES    wall-clock budget for the whole batch
  --resume              continue from the journal in the output root
  --dry-run             resolve and report the plan without building
  --json                machine-readable progress on stdout
```

Examples:

```bash
# Check a manifest without building anything.
npm run batch -- validate examples/batch-100.yaml

# Build with a 10-minute wall-clock budget into a custom root.
npm run batch -- run examples/batch-100.yaml --out out/demo --deadline 10

# Stop a long run with Ctrl-C and pick it back up later.
npm run batch -- run examples/batch-100.yaml --out out/demo --resume

# Re-emit reports from a previous run's result JSON.
npm run batch -- report out/demo/reports/batch-100-2026.result.json --out out/demo/reports-again
```

### Generating a batch manifest

The fixture generator takes a site count and writes a manifest to stdout:

```bash
node scripts/gen-batch.mjs 250 > examples/batch-250.yaml
npm run gen:batch -- 250 > examples/batch-250.yaml
```

### Writing your own manifest

```yaml
batch_id: my-batch          # used as the report filename prefix
tenant: default
template: astro-nano

policies:
  max_attempts: 3
  retry_backoff_ms: [500, 2000, 8000]
  site_timeout_ms: 120000
  deadline_ms: 5400000
  fail_policy: continue    # continue | halt
  fallback_enabled: true

concurrency:
  max_parallel_builds: 8
  max_parallel_compiles: 8
  per_build_memory_mb: 384

output:
  dest: out/my-batch
  artifact_store: cas     # cas | plain

liveness:
  provider: deterministic
  max_cost_usd: 25

build:
  ssg: static
  asset_resolver: placeholder

prompts:
  - site_id: dental
    prompt: >-
      Family Dental, a dental practice for families in the area.
      Calm and reassuring tone. Include pricing, faq and contact sections.
    constraints:
      template: astro-nano
      max_pages: 6
      required_sections: ["pricing", "faq", "contact"]
```

`npm run batch -- validate <file>` checks a manifest before you spend anything on it.

## Scaling past 100 sites

100 is a demonstration size, not a limit. The batch orchestrator is built around a work queue, so the same command handles 10 sites or 10,000.

**Batch size is just a number.** The generator takes any count, and the manifest has no upper bound on `prompts`. Site identity is derived from the prompt and its constraints, so nothing about the pipeline assumes 100.

**Work is bounded, not serial.** `concurrency.max_parallel_builds` and `max_parallel_compiles` cap in-flight work independently, because compiling is CPU-bound and building is I/O-bound. Both lanes have their own semaphore and token bucket, so one slow site cannot starve the rest.

**Every site is isolated.** Each build gets its own work directory and a per-build memory ceiling. A site that crashes, times out or blows a budget produces a typed diagnostic for that site only.

**Failures degrade, they do not cascade.** With `fail_policy: continue` the batch keeps going; a site that cannot be completed within `site_timeout_ms` is skipped rather than failed once `deadline_ms` is spent. Retries use exponential backoff and only for retryable errors — retrying can never un-pass a deadline, so deadline and skipped outcomes are never marked retryable. A circuit breaker opens after sustained failures to stop hammering a broken dependency.

**Work is deduplicated.** Sites that compile and render to the same artifact hash are stored once in the content-addressed store. Re-running an unchanged batch costs no rebuilds and reports `W_B_DEDUPLICATED`; running the bundled fixture twice delivers 100/100 both times.

**Runs are resumable and cost-capped.** `--resume` continues from the journal in the output root, so an interrupted batch picks up where it stopped. `liveness.max_cost_usd` is a hard ceiling, checked as the batch runs.

**Budgets are enforced per site, not per batch.** The adapter gates each build on bundle size, page count, build time, LCP and CLS, and fails that site with a typed diagnostic if it violates a budget. This keeps output quality uniform as volume grows instead of degrading at the tail.

**Reports are machine-readable.** Every run emits `.result.json`, `.sites.csv` and `.report.md`, so results can be diffed across runs and aggregated into dashboards.

The practical scaling limits are the ones you would expect: wall-clock time, the cost ceiling, and the machine's cores and memory. Concurrency is a knob, not a hard limit.

## Output layout

```
out/my-batch/
  reports/
    my-batch.result.json      full machine-readable result
    my-batch.sites.csv        one row per site
    my-batch.report.md        human-readable summary
  sites/<site_id>/            published site
  cas/sha256-<hex>/           content-addressed artifact store
  journal/                    state journal used by --resume
  cache/                      compilation cache, keyed by request
  .work/work/                 per-site build scratch space
```

Site directories are published from the content store; on platforms where that is a directory junction or symlink, enumerate `cas/` directly rather than relying on `readdir` reporting them as directories.

## Verifying an installation

```bash
npm run build       # compile every package
npm run smoke       # foundation + compiler + SSG + 79-check batch suite
npm run lint        # project lint rules
npm run typecheck   # tsc --build, type checking only
```

`npm run smoke` is the full end-to-end check: it compiles specs, builds a site, asserts every budget gate, and then exercises the orchestrator's concurrency, deadline, retry, circuit-breaker and deduplication behaviour.

## Repository layout

```
packages/
  spec-schema/          shared contracts: RFC 8785 canonical JSON, BLAKE3 hashing,
                        JSON Schema 2020-12 definitions, RFC 9457 problem details
  redaction/            prompt sanitisation: PII/secret redaction, injection neutralisation
  telemetry/            structured spans, counters, histograms; pluggable sink
  spec-compiler/        plugin A — prompt -> SiteSpec
  ssg-adapter-astro/    plugin C — SiteSpec -> static site, budget gates
  batch-orchestrator/   plugin B — many prompts -> many published sites, plus the CLI
scripts/                build, lint, smoke suites, batch fixture generator, 100-site runner
examples/               batch manifests
PLUGIN_REQUIREMENTS_SPEC.md   the authoritative contract
Architecture.md              how the pieces fit together
```

See [Architecture.md](Architecture.md) for the data flow, contracts and design decisions.

## Guarantees

- **Deterministic.** The same `spec_hash` produces a byte-identical `dist/`. No clock, no randomness, no network-dependent output.
- **Hermetic.** 0 kB of client-side JavaScript by default, no third-party subresources, no absolute filesystem paths in output.
- **Typed failures.** Every failure carries a stable error code and RFC 9457 problem details. Nothing fails silently.
- **Bounded.** Deadlines, cost ceilings, per-site timeouts, memory ceilings and performance budgets are all enforced, not advisory.
- **Reproducible.** Canonical JSON plus BLAKE3-256 plus content-addressed publication means identical input yields identical output, and identical output is stored once.

## Licence

[MIT](LICENSE) © 2026 HUNDRED contributors.