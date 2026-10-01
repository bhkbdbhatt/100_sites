/**
 * The seven cross-component contracts, as JSON Schema 2020-12.
 *
 * `SpecEnvelope` is deliberately a wrapper rather than a bare `SiteSpec`: the
 * orchestrator refuses a spec that has not been hash-bound and provenance
 * stamped by the compiler (section 5.1), so the envelope *is* the handshake.
 */

import {
  ARTIFACT_HASH,
  ASSET_SLOT,
  BATCH_ID,
  BUILD_DIRECTIVES,
  COMPLIANCE,
  DESIGN_TOKENS,
  DIALECT,
  DIAGNOSTIC,
  LOCALE,
  PAGE,
  SCHEMA_BASE,
  SITE_ID,
  SPEC_HASH,
  SPEC_VERSION,
} from "./common.js";
import { BLOCK_TYPES, INTEGRATIONS, PAGE_ARCHETYPES } from "../blocks.js";

export const SPEC_VERSION_ID = "1.0.0";

export const siteSpecSchema = {
$schema: DIALECT,
$id: `${SCHEMA_BASE}/site-spec/1.0.0.json`,
  title: "SiteSpec",
  description:
    "Complete, self-contained description of one static website. Emitted by @pg/spec-compiler, consumed by @pg/ssg-adapter-astro. Contains no executable content.",
  type: "object",
  additionalProperties: false,
  required: ["meta", "design", "pages", "seo", "assets", "build"],
  properties: {
    meta: {
      type: "object",
      additionalProperties: false,
      required: ["title", "description", "locale", "theme"],
      properties: {
        title: { type: "string", minLength: 1, maxLength: 140 },
        description: { type: "string", minLength: 1, maxLength: 320 },
        locale: LOCALE,
        theme: { type: "string", enum: ["light", "dark", "auto"] },
        industry: { type: "string", maxLength: 120 },
        audience: { type: "string", maxLength: 200 },
        brand_name: { type: "string", maxLength: 120 },
        tagline: { type: "string", maxLength: 200 },
      },
    },
    design: {
      type: "object",
      additionalProperties: false,
      required: ["archetype", "tokens"],
      properties: {
        archetype: { type: "string", maxLength: 40 },
        rationale: { type: "string", maxLength: 400 },
        tokens: DESIGN_TOKENS,
      },
    },
    pages: {
      type: "array",
      minItems: 1,
      maxItems: 40,
      items: PAGE,
    },
    seo: {
      type: "object",
      additionalProperties: false,
      required: ["sitemap", "robots"],
      properties: {
        sitemap: { type: "boolean", default: true },
        robots: { type: "string", maxLength: 400, default: "index,follow" },
        default_og_image_slot: { type: "string", maxLength: 64 },
        organization: {
          type: "object",
          additionalProperties: false,
          properties: {
            name: { type: "string", maxLength: 140 },
            url: { type: "string", maxLength: 300 },
            logo_slot: { type: "string", maxLength: 64 },
          },
        },
      },
    },
    assets: { type: "array", maxItems: 120, items: ASSET_SLOT },
    build: BUILD_DIRECTIVES,
    compliance: COMPLIANCE,
  },
} as const;

export const specEnvelopeSchema = {
$schema: DIALECT,
$id: `${SCHEMA_BASE}/spec-envelope/1.0.0.json`,
  title: "SpecEnvelope",
  description: "A hash-bound, provenance-stamped SiteSpec. The only shape component B accepts from component A.",
  type: "object",
  additionalProperties: false,
  required: ["spec", "meta"],
  properties: {
    spec: { $ref: `${SCHEMA_BASE}/site-spec/1.0.0.json` },
    meta: {
      type: "object",
      additionalProperties: false,
      required: ["spec_version", "spec_hash", "compiler_version", "degraded"],
      properties: {
        spec_version: SPEC_VERSION,
        spec_hash: SPEC_HASH,
        compiler_version: { type: "string", maxLength: 40 },
        prompt_hash: { type: "string", maxLength: 80 },
        model_id: { type: "string", maxLength: 80 },
        model_tier: { type: "string", enum: ["fast", "standard", "premium"] },
        token_usage: {
          type: "object",
          additionalProperties: false,
          properties: {
            input: { type: "integer", minimum: 0 },
            output: { type: "integer", minimum: 0 },
          },
        },
        cost_usd: { type: "number", minimum: 0 },
        latency_ms: { type: "integer", minimum: 0 },
        repair_attempts: { type: "integer", minimum: 0, maximum: 2 },
        redactions: { type: "integer", minimum: 0 },
        cache: { type: "string", enum: ["hit", "miss", "bypass"] },
        degraded: { type: "boolean" },
        fallback_depth: { type: "integer", minimum: 0, maximum: 4, default: 0 },
        warnings: { type: "array", maxItems: 50, items: DIAGNOSTIC },
      },
    },
  },
} as const;

export const compileRequestSchema = {
$schema: DIALECT,
$id: `${SCHEMA_BASE}/compile-request/1.0.0.json`,
  title: "CompileRequest",
  type: "object",
  additionalProperties: false,
  required: ["site_id", "prompt"],
  properties: {
    site_id: SITE_ID,
    prompt: { type: "string", minLength: 8, maxLength: 4000 },
    context: {
      type: "object",
      additionalProperties: false,
      properties: {
        brand: {
          type: "object",
          additionalProperties: false,
          properties: {
            name: { type: "string", maxLength: 120 },
            tagline: { type: "string", maxLength: 200 },
            colors: { type: "array", maxItems: 8, items: { type: "string", maxLength: 9 } },
            logo_slot: { type: "string", maxLength: 64 },
          },
        },
        audience: { type: "string", maxLength: 300 },
        locale: LOCALE,
        keywords: { type: "array", maxItems: 25, items: { type: "string", maxLength: 60 } },
        references: { type: "array", maxItems: 5, items: { type: "string", maxLength: 300 } },
      },
    },
    constraints: {
      type: "object",
      additionalProperties: false,
      properties: {
        template: { type: "string", maxLength: 60 },
        ssg_target: { type: "string", enum: ["astro", "zola", "eleventy"], default: "astro" },
        max_pages: { type: "integer", minimum: 1, maximum: 40, default: 12 },
        required_sections: { type: "array", maxItems: 20, items: { type: "string", maxLength: 40 } },
        banned_sections: { type: "array", maxItems: 20, items: { type: "string", maxLength: 40 } },
        banned_components: { type: "array", maxItems: 20, items: { type: "string", maxLength: 40 } },
        allow_external_js: { type: "boolean", default: false },
        integrations: { type: "array", maxItems: 10, items: { type: "string", enum: [...INTEGRATIONS] } },
      },
    },
    compile_options: {
      type: "object",
      additionalProperties: false,
      properties: {
        schema_version: SPEC_VERSION,
        model_tier: { type: "string", enum: ["fast", "standard", "premium"], default: "standard" },
        seed: { type: "integer", minimum: 0, default: 0 },
        max_output_tokens: { type: "integer", minimum: 1024, maximum: 16384, default: 8192 },
        max_repair_attempts: { type: "integer", minimum: 0, maximum: 2, default: 2 },
        allow_fallback: { type: "boolean", default: true },
        budget_usd: { type: "number", minimum: 0, default: 0.25 },
        provider: { type: "string", enum: ["openai-compatible", "deterministic"], default: "openai-compatible" },
      },
    },
  },
} as const;

export const buildRequestSchema = {
$schema: DIALECT,
$id: `${SCHEMA_BASE}/build-request/1.0.0.json`,
  title: "BuildRequest",
  type: "object",
  additionalProperties: false,
  required: ["site_id", "spec", "template", "workdir"],
  properties: {
    site_id: SITE_ID,
    spec: { $ref: `${SCHEMA_BASE}/site-spec/1.0.0.json` },
    spec_hash: SPEC_HASH,
    template: { type: "string", minLength: 3, maxLength: 60 },
    workdir: { type: "string", minLength: 1, maxLength: 400 },
    build: {
      type: "object",
      additionalProperties: false,
      properties: {
        mode: { type: "string", enum: ["build", "dev", "preview"], default: "build" },
        out_dir: { type: "string", default: "dist" },
        trailing_slash: { type: "string", enum: ["always", "never", "ignore"], default: "never" },
        minify: { type: "boolean", default: true },
        inline_stylesheets: { type: "string", enum: ["always", "never", "auto"], default: "auto" },
        memory_mb: { type: "integer", minimum: 64, maximum: 8192, default: 384 },
        timeout_ms: { type: "integer", minimum: 1000, maximum: 900000, default: 90000 },
      },
    },
    budgets: {
      type: "object",
      additionalProperties: false,
      description: "Hard ceilings for a single build. `hard: true` fails the build rather than warning.",
      properties: {
        max_bundle_kb: { type: "integer", minimum: 1, maximum: 4096, default: 180 },
        max_pages: { type: "integer", minimum: 1, maximum: 500, default: 40 },
        max_build_ms: { type: "integer", minimum: 1000, maximum: 900000, default: 45000 },
        max_lcp_ms: { type: "integer", minimum: 200, maximum: 60000, default: 2500 },
        max_cls: { type: "number", minimum: 0, maximum: 1, default: 0.1 },
        hard: { type: "boolean", default: true },
      },
    },
    network: {
      type: "object",
      additionalProperties: false,
      properties: {
        offline: { type: "boolean", default: false },
        allowlist: { type: "array", maxItems: 50, items: { type: "string", maxLength: 200 } },
        max_concurrency: { type: "integer", minimum: 1, maximum: 128, default: 16 },
      },
    },
    assets: {
      type: "object",
      additionalProperties: false,
      properties: {
        resolver: { type: "string", enum: ["auto", "local", "remote", "placeholder"], default: "auto" },
        local: { type: "object", additionalProperties: { type: "string", maxLength: 400 } },
        max_bytes_per_image: { type: "integer", minimum: 1024, maximum: 8388608, default: 250000 },
        formats: {
          type: "array",
          maxItems: 4,
          items: { type: "string", enum: ["avif", "webp", "jpeg", "png", "svg"] },
        },
      },
    },
    capability_report: {
      type: "object",
      additionalProperties: false,
      properties: {
        adapter: { type: "string", maxLength: 60 },
        template_range: { type: "string", maxLength: 60 },
        unsupported_blocks: { type: "array", items: { type: "string" }, maxItems: 20 },
        stripped_integrations: { type: "array", items: { type: "string" }, maxItems: 10 },
        degradations: { type: "array", maxItems: 60, items: { type: "object" } },
        requested_pages: { type: "integer", minimum: 0 },
      },
    },
  },
} as const;

export const buildResultSchema = {
$schema: DIALECT,
$id: `${SCHEMA_BASE}/build-result/1.0.0.json`,
  title: "BuildResult",
  type: "object",
  additionalProperties: false,
  required: ["site_id", "status", "spec_hash", "out_dir", "files", "pages", "metrics", "gate"],
  properties: {
    site_id: SITE_ID,
    status: { type: "string", enum: ["built", "built_degraded", "failed"] },
    spec_hash: SPEC_HASH,
    artifact_hash: ARTIFACT_HASH,
    out_dir: { type: "string", maxLength: 400 },
    template: {
      type: "object",
      additionalProperties: false,
      properties: {
        name: { type: "string", maxLength: 60 },
        version: { type: "string", maxLength: 40 },
        ssg: { type: "string", maxLength: 40 },
        driver: { type: "string", enum: ["astro", "static"] },
      },
    },
    pages: { type: "integer", minimum: 0 },
    files: {
      type: "array",
      maxItems: 20000,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "bytes", "sha256"],
        properties: {
          path: { type: "string", maxLength: 400 },
          bytes: { type: "integer", minimum: 0 },
          sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
        },
      },
    },
    metrics: {
      type: "object",
      additionalProperties: false,
      required: ["install_ms", "build_ms", "total_ms", "total_bytes", "largest_bundle_kb", "js_bytes", "page_count"],
      properties: {
        install_ms: { type: "integer", minimum: 0 },
        build_ms: { type: "integer", minimum: 0 },
        assets_ms: { type: "integer", minimum: 0 },
        total_ms: { type: "integer", minimum: 0 },
        total_bytes: { type: "integer", minimum: 0 },
        largest_bundle_kb: { type: "number", minimum: 0 },
        css_bytes: { type: "integer", minimum: 0 },
        js_bytes: { type: "integer", minimum: 0 },
        image_count: { type: "integer", minimum: 0 },
        image_bytes: { type: "integer", minimum: 0 },
        page_count: { type: "integer", minimum: 0 },
        external_request_count: { type: "integer", minimum: 0 },
        lcp_estimate_ms: { type: "number", minimum: 0 },
        cls_estimate: { type: "number", minimum: 0 },
      },
    },
    gate: {
      type: "object",
      additionalProperties: false,
      properties: {
        bundle: { type: "string", enum: ["pass", "warn", "fail", "skip"] },
        pages: { type: "string", enum: ["pass", "warn", "fail", "skip"] },
        build_time: { type: "string", enum: ["pass", "warn", "fail", "skip"] },
        lcp: { type: "string", enum: ["pass", "warn", "fail", "skip"] },
        cls: { type: "string", enum: ["pass", "warn", "fail", "skip"] },
        a11y: { type: "string", enum: ["pass", "warn", "fail", "skip"] },
        security: { type: "string", enum: ["pass", "warn", "fail", "skip"] },
        spec_fidelity: { type: "string", enum: ["pass", "warn", "fail", "skip"] },
      },
    },
    diagnostics: { type: "array", maxItems: 200, items: DIAGNOSTIC },
    build_log: { type: "string", maxLength: 400 },
  },
} as const;

const SITE_RESULT = {
  type: "object",
  additionalProperties: false,
  required: ["site_id", "status", "stages", "attempts", "fallback_depth"],
  properties: {
    site_id: SITE_ID,
    status: { type: "string", enum: ["built", "built_degraded", "deduplicated", "failed", "skipped"] },
    degraded: { type: "boolean" },
    spec_hash: SPEC_HASH,
    artifact_hash: ARTIFACT_HASH,
    stages: {
      type: "object",
      additionalProperties: false,
      properties: {
        compile_ms: { type: "integer", minimum: 0 },
        install_ms: { type: "integer", minimum: 0 },
        build_ms: { type: "integer", minimum: 0 },
        assets_ms: { type: "integer", minimum: 0 },
        publish_ms: { type: "integer", minimum: 0 },
      },
    },
    attempts: { type: "integer", minimum: 0 },
    fallback_depth: { type: "integer", minimum: 0, maximum: 4 },
    pages: { type: "integer", minimum: 0 },
    total_bytes: { type: "integer", minimum: 0 },
    largest_bundle_kb: { type: "number", minimum: 0 },
    external_js_kb: { type: "number", minimum: 0 },
    cost_usd: { type: "number", minimum: 0 },
    warnings: { type: "array", maxItems: 50, items: { type: "string", maxLength: 300 } },
    error: { type: ["object", "null"] },
  },
} as const;

export const batchJobSchema = {
$schema: DIALECT,
$id: `${SCHEMA_BASE}/batch-job/1.0.0.json`,
  title: "BatchJob",
  type: "object",
  additionalProperties: false,
  required: ["batch_id", "template", "prompts"],
  properties: {
    batch_id: BATCH_ID,
    tenant: { type: "string", maxLength: 60, default: "default" },
    template: { type: "string", minLength: 3, maxLength: 60 },
    defaults: {
      type: "object",
      description:
        "Per-site overrides merged under each prompt's own constraints. A prompt may only narrow these, never widen them.",
      additionalProperties: false,
      properties: {
        template: { type: "string", maxLength: 60 },
        ssg_target: { type: "string", enum: ["astro", "zola", "eleventy"] },
        max_pages: { type: "integer", minimum: 1, maximum: 40 },
        required_sections: { type: "array", maxItems: 20, items: { type: "string", maxLength: 40 } },
        banned_sections: { type: "array", maxItems: 20, items: { type: "string", maxLength: 40 } },
        integrations: { type: "array", maxItems: 10, items: { type: "string", enum: [...INTEGRATIONS] } },
      },
    },
    build: {
      type: "object",
      additionalProperties: false,
      description: "Per-batch overrides applied to every build dispatched to component C.",
      properties: {
        ssg: { type: "string", enum: ["astro", "static"], default: "static" },
        asset_resolver: { type: "string", enum: ["auto", "local", "remote", "placeholder"], default: "auto" },
        budgets: { $ref: `${SCHEMA_BASE}/build-request/1.0.0.json#/properties/budgets` },
      },
    },
    network: {
      type: "object",
      additionalProperties: false,
      properties: {
        offline: { type: "boolean", default: true },
        allowlist: { type: "array", maxItems: 50, items: { type: "string", maxLength: 200 } },
      },
    },
    prompts: {
      type: "array",
      minItems: 1,
      maxItems: 500,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["site_id", "prompt"],
        properties: {
          site_id: SITE_ID,
          prompt: { type: "string", minLength: 8, maxLength: 4000 },
          context: { type: "object" },
          constraints: {
            type: "object",
            description: "Per-site overrides merged over batch defaults. May only narrow, never widen.",
          },
        },
      },
    },
    policies: {
      type: "object",
      additionalProperties: false,
      properties: {
        max_attempts: { type: "integer", minimum: 1, maximum: 5, default: 3 },
        retry_backoff_ms: {
          type: "array",
          maxItems: 5,
          items: { type: "integer", minimum: 0, maximum: 120000 },
          default: [1000, 5000, 15000],
        },
        site_timeout_ms: { type: "integer", minimum: 5000, maximum: 900000, default: 120000 },
        deadline_ms: { type: "integer", minimum: 10000, maximum: 86400000, default: 5400000 },
        fail_policy: { type: "string", enum: ["continue", "halt"], default: "continue" },
        fallback_enabled: { type: "boolean", default: true },
        stale_after_ms: { type: "integer", minimum: 1000, maximum: 900000, default: 60000 },
        breaker_threshold: { type: "number", minimum: 0.01, maximum: 1, default: 0.2 },
        breaker_window_ms: { type: "integer", minimum: 1000, maximum: 900000, default: 60000 },
      },
    },
    concurrency: {
      type: "object",
      additionalProperties: false,
      properties: {
        max_parallel_builds: { type: "integer", minimum: 1, maximum: 64, default: 12 },
        max_parallel_compiles: { type: "integer", minimum: 1, maximum: 32, default: 8 },
        max_queue_depth: { type: "integer", minimum: 1, maximum: 2000, default: 48 },
        per_build_memory_mb: { type: "integer", minimum: 64, maximum: 8192, default: 384 },
      },
    },
    output: {
      type: "object",
      additionalProperties: false,
      properties: {
        dest: { type: "string", maxLength: 400, default: "out" },
        per_site_dir: { type: "string", maxLength: 100, default: "{site_id}" },
        archive: { type: "boolean", default: true },
        archive_format: { type: "string", enum: ["zip", "tar.gz"], default: "zip" },
        artifact_store: { type: "string", maxLength: 400, default: "blobs/sha256" },
        staging: { type: "string", maxLength: 400, default: "staging" },
        work: { type: "string", maxLength: 400, default: ".work" },
        report_formats: {
          type: "array",
          maxItems: 6,
          items: { type: "string", enum: ["csv", "json", "markdown", "timeline", "gantt"] },
        },
        keep_workdir: { type: "boolean", default: false },
        network_allowlist: { type: "array", maxItems: 50, items: { type: "string", maxLength: 200 } },
      },
    },
    liveness: {
      type: "object",
      additionalProperties: false,
      properties: {
        provider: { type: "string", enum: ["openai-compatible", "deterministic"], default: "openai-compatible" },
        model_id: { type: "string", maxLength: 80 },
        base_url: { type: "string", maxLength: 300 },
        api_key_env: { type: "string", maxLength: 80, default: "HUNDRED_LLM_API_KEY" },
        max_concurrent_requests: { type: "integer", minimum: 1, maximum: 64, default: 8 },
        requests_per_minute: { type: "integer", minimum: 1, maximum: 100000, default: 300 },
        max_tokens_per_minute: { type: "integer", minimum: 1000, maximum: 100000000, default: 2000000 },
        request_timeout_ms: { type: "integer", minimum: 1000, maximum: 300000, default: 60000 },
        max_cost_usd: { type: "number", minimum: 0, default: 25 },
      },
    },
  },
} as const;

export const batchResultSchema = {
$schema: DIALECT,
$id: `${SCHEMA_BASE}/batch-result/1.0.0.json`,
  title: "BatchResult",
  type: "object",
  additionalProperties: false,
  required: ["batch_id", "status", "wall_clock_ms", "totals", "sites"],
  properties: {
    batch_id: BATCH_ID,
    status: { type: "string", enum: ["succeeded", "partial", "failed", "cancelled"] },
    started_at: { type: "string", maxLength: 40 },
    finished_at: { type: "string", maxLength: 40 },
    wall_clock_ms: { type: "integer", minimum: 0 },
    deadline_ms: { type: "integer", minimum: 0 },
    headroom_ms: { type: "integer", minimum: 0 },
    totals: {
      type: "object",
      additionalProperties: false,
      required: ["requested", "succeeded", "degraded", "failed"],
      properties: {
        requested: { type: "integer", minimum: 0 },
        succeeded: { type: "integer", minimum: 0 },
        degraded: { type: "integer", minimum: 0 },
        failed: { type: "integer", minimum: 0 },
        deduplicated: { type: "integer", minimum: 0 },
        skipped: { type: "integer", minimum: 0 },
      },
    },
    sites: { type: "array", maxItems: 500, items: SITE_RESULT },
    artifacts: {
      type: "array",
      maxItems: 500,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["site_id", "path", "sha256", "bytes"],
        properties: {
          site_id: SITE_ID,
          path: { type: "string", maxLength: 400 },
          sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
          bytes: { type: "integer", minimum: 0 },
        },
      },
    },
    report: { type: "object" },
    budget: { type: "object" },
    ledger: {
      type: "object",
      additionalProperties: false,
      properties: {
        total_cost_usd: { type: "number", minimum: 0 },
        total_tokens: { type: "integer", minimum: 0 },
        llm_calls: { type: "integer", minimum: 0 },
        cache_hits: { type: "integer", minimum: 0 },
      },
    },
  },
} as const;

export const compileRequestPlaceholder = {
$schema: DIALECT,
$id: `${SCHEMA_BASE}/problem+json.json`,
  title: "ProblemDetails",
  type: "object",
  required: ["type", "title", "status", "code", "detail", "instance", "retryable"],
  properties: {
    type: { type: "string" },
    title: { type: "string" },
    status: { type: "integer" },
    code: { type: "string" },
    detail: { type: "string" },
    instance: { type: "string" },
    trace_id: { type: "string" },
    retryable: { type: "boolean" },
    degraded_possible: { type: "boolean" },
    errors: { type: "array", items: { type: "object" } },
  },
} as const;

export const allSchemas = {
  "compile-request/1.0.0.json": compileRequestSchema,
  "site-spec/1.0.0.json": siteSpecSchema,
  "spec-envelope/1.0.0.json": specEnvelopeSchema,
  "build-request/1.0.0.json": buildRequestSchema,
  "build-result/1.0.0.json": buildResultSchema,
  "batch-job/1.0.0.json": batchJobSchema,
  "batch-result/1.0.0.json": batchResultSchema,
  "problem+json.json": compileRequestPlaceholder,
} as const;

export const blockTypeEnum = [...BLOCK_TYPES] as string[];
export const pageArchetypeEnum = [...PAGE_ARCHETYPES] as string[];
