# Local runtime

A decision aid for one question: **does anything in this repository need to be left running on my machine, or do I invoke it and let it exit?**

## Short answer

**Nothing. Zero long-running processes. No server, no watcher, no daemon, no database, no container.**

HUNDRED is a one-shot batch pipeline. Every entrypoint compiles, renders, publishes, writes its reports and returns a non-zero exit code on failure. There is no `npm run dev`, no `--watch`, no health endpoint and no port to open. If a terminal is sitting idle after a command, that command is finished, not waiting.

The only two commands that are ever "running" are:

```bash
npm run build      # tsc --build across all six packages; returns when compilation ends
npm run batch:100  # builds the 100-site fixture; returns when the last site is published
```

Both are bounded. `npm run build` is bounded by TypeScript. `npm run batch:100` is bounded by `policies.deadline_ms` and `concurrency.*` in the manifest. Neither survives its own terminal.

---

## How to classify what you are looking at

| You want to know | Answer | Where to check |
|---|---|---|
| Do I need to start a backend before using HUNDRED? | No | There is no server to start |
| Can I close the terminal after starting a build? | Yes | Nothing detaches; no background worker is spawned |
| Can two packages run at the same time? | Yes, and they must | `max_parallel_compiles` and `max_parallel_builds` are two independent lanes inside one process |
| Do I need to keep a database or queue running? | No | The queue is in-memory; durability comes from `journal/` on disk |
| Does the generated site need a server? | No | Output is static files. Serve it with anything, or open `index.html` |
| Do I need an API key or network? | No | Default provider is the deterministic synthesizer; default asset resolver is `placeholder` |
| Do I need to watch for changes? | No | Re-run the command. There is no watch mode by design (a watcher would break byte-identical output) |

---

## Package inventory

Every package below is a **library**. Two of them also expose a CLI bin, and both bins are one-shot commands.

| Package | Kind | Long-running? | What it does |
|---|---|---|---|
| `packages/spec-schema` | library | No | RFC 8785 canonical JSON, BLAKE3 hashing, JSON Schema 2020-12, RFC 9457 problem details |
| `packages/telemetry` | library | No | Spans, counters, histograms; pluggable sink that never blocks the pipeline |
| `packages/redaction` | library | No | PII/secret redaction and prompt-injection neutralisation |
| `packages/spec-compiler` | library + CLI (`speccompile`) | No | Plugin A: one prompt in, one canonicalised `SiteSpec` out |
| `packages/ssg-adapter-astro` | library | No | Plugin C: `SiteSpec` in, static site out, budget gates enforced |
| `packages/batch-orchestrator` | library + CLI (`specbatch`) | No | Plugin B: queue, concurrency, deadline, retry, atomic publication, plus the `specbatch` CLI |

The plugins are **not** separate processes. `batch-orchestrator/src/scheduler.ts` imports `createCompiler` from `@pg/spec-compiler` and `buildSite` from `@pg/ssg-adapter-astro` and calls them in-process. One `node` invocation runs the whole pipeline.

### Where the work actually happens

```
node packages/batch-orchestrator/dist/cli.js run examples/batch-100.yaml
   |
   +-- in-process: redaction -> spec-compiler -> ssg-adapter-astro  (per site, bounded lanes)
   |
   +-- on disk:    out/  (sites, cas/, journal/, cache/, reports/)
```

---

## How to verify this yourself

Three checks, no tooling assumptions:

```bash
# 1. There is no HTTP surface: no server is created anywhere in the source.
#    Expected: no matches.
Select-String -Path packages\*\src\*.ts -Pattern 'createServer','\.listen\('

# 2. Nothing detaches or forks a long-lived child.
#    Expected: no matches.
Select-String -Path packages\*\src\*.ts,scripts\*.mjs -Pattern 'child_process','spawn\(','setInterval'

# 3. The only bins are the two one-shot CLIs.
#    Expected: specbatch (batch-orchestrator), speccompile (spec-compiler)
Select-String -Path packages\*\package.json -Pattern '"bin"'
```

Then confirm the shape of a run's own output rather than trusting this document:

```bash
npm run batch -- run examples/batch-100.yaml --out out/demo
Get-Content out/demo/reports/batch-100.result.json | ConvertFrom-Json | Select-Object status, delivered
```

A completed run leaves files on disk and a terminal prompt. That is the whole "runtime" surface.

---

## When something *would* need to stay up

This repository does not implement any of these. They are listed so the absence is a decision, not an oversight.

- **A live model provider.** `spec-compiler/src/llm/openai-compatible.ts` calls a remote endpoint, but the endpoint belongs to someone else. You keep *your* provider running; you do not start one here. The default `deterministic` provider makes no network calls at all.
- **A remote asset resolver.** `ssg-adapter-astro/src/assets/resolver.ts` is the only other `fetch` in the codebase, and only on the `remote` path. The bundled manifest pins `asset_resolver: placeholder`, which stays offline.
- **Static file serving for preview.** Optional and external: `npx serve out/demo/sites`. HUNDRED itself never opens a port.
- **A telemetry collector.** `telemetry` accepts a pluggable sink, but the shipped default buffers and drops rather than pushing. Wiring an OTLP exporter is a change to the app, not a step in running it.

---

## If something *is* still running

There is no supported state in which that is expected. Treat it as a defect, not a configuration:

| Symptom | Likely cause | Where to look |
|---|---|---|
| A `node` process survives its command | A non-`retryable` await that never settles | `packages/batch-orchestrator/src/concurrency.ts` (semaphore / token bucket release) |
| A `node` process exits with no output | Unhandled rejection before the reporter attaches | `packages/batch-orchestrator/src/cli.ts` |
| A site build hangs past `site_timeout_ms` | Timeout not covering a resolver or provider call | `packages/ssg-adapter-astro/src/assets/resolver.ts` |
| Outbound traffic during a default run | A manifest set `asset_resolver: remote` or a non-deterministic provider | `examples/batch-100.yaml` (`liveness.provider`, `build.asset_resolver`) |

Report it with the manifest, the `.result.json` from `reports/`, and the exit code. All three are enough to reproduce without a running system.

---

## Related documents

- [README.md](README.md) - commands, output layout, guarantees
- [Architecture.md](Architecture.md) - package graph, data flow, design decisions
- [PLUGIN_REQUIREMENTS_SPEC.md](PLUGIN_REQUIREMENTS_SPEC.md) - the authoritative contract