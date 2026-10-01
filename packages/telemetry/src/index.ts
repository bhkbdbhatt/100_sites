/**
 * Minimal structured telemetry.
 *
 * Design constraint from NFR-B18/NFR-A17: instrumentation must never be able
 * to fail a build. Every sink call is wrapped, every record is size-capped, and
 * the default sink is an in-memory ring buffer.
 */

export type SpanKind = "compile" | "hydrate" | "build" | "assets" | "verify" | "publish" | "sched";

export interface SpanRecord {
  name: string;
  kind: SpanKind | "internal";
  site_id?: string;
  batch_id?: string;
  started_at: number;
  duration_ms: number;
  attributes: Record<string, string | number | boolean>;
  error?: string;
}

export interface CounterRecord {
  name: string;
  value: number;
  attributes: Record<string, string | number | boolean>;
}

export interface HistogramRecord {
  name: string;
  count: number;
  sum: number;
  min: number;
  max: number;
  p50: number;
  p95: number;
  p99: number;
  attributes: Record<string, string | number | boolean>;
}

export interface TelemetrySink {
  span(record: SpanRecord): void;
  counter(record: CounterRecord): void;
  histogram(record: HistogramRecord): void;
}

const MAX_VALUE_LENGTH = 2000;

function capAttributes(
  attributes: Record<string, string | number | boolean>,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (typeof value === "string") {
      out[key] = value.length > MAX_VALUE_LENGTH ? value.slice(0, MAX_VALUE_LENGTH) + "…" : value;
    } else {
      out[key] = value;
    }
  }
  return out;
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index]!;
}

/** Bounded in-memory sink; the default when no OTLP collector is configured. */
export class MemorySink implements TelemetrySink {
  readonly spans: SpanRecord[] = [];
  readonly counters = new Map<string, CounterRecord>();
  readonly histograms = new Map<string, { samples: number[]; attributes: Record<string, string | number | boolean> }>();
  private readonly histogramsByAttribute = new Map<string, number[]>();

  constructor(private readonly maxSpans = 20_000) {}

  span(record: SpanRecord): void {
    if (this.spans.length < this.maxSpans) {
      this.spans.push({ ...record, attributes: capAttributes(record.attributes) });
    }
  }

  counter(record: CounterRecord): void {
    const key = record.name + "|" + JSON.stringify(record.attributes);
    const existing = this.counters.get(key);
    if (existing) existing.value += record.value;
    else this.counters.set(key, { ...record, attributes: capAttributes(record.attributes) });
  }

  histogram(record: HistogramRecord): void {
    const key = record.name + "|" + JSON.stringify(record.attributes);
    this.histograms.set(key, { samples: [], attributes: record.attributes });
  }

  observe(name: string, value: number, attributes: Record<string, string | number | boolean> = {}): void {
    const key = name + "|" + JSON.stringify(attributes);
    const bucket = this.histogramsByAttribute.get(key);
    if (bucket) bucket.push(value);
    else this.histogramsByAttribute.set(key, [value]);
  }

  histogramReport(): HistogramRecord[] {
    return [...this.histogramsByAttribute.entries()].map(([key, samples]) => {
      const sorted = [...samples].sort((a, b) => a - b);
      const name = key.slice(0, key.indexOf("|"));
      return {
        name,
        count: sorted.length,
        sum: sorted.reduce((a, b) => a + b, 0),
        min: sorted[0] ?? 0,
        max: sorted[sorted.length - 1] ?? 0,
        p50: percentile(sorted, 50),
        p95: percentile(sorted, 95),
        p99: percentile(sorted, 99),
        attributes: {},
      };
    });
  }

  reset(): void {
    this.spans.length = 0;
    this.counters.clear();
    this.histogramsByAttribute.clear();
  }
}

export interface MetricLoggerOptions {
  sink?: TelemetrySink;
  service: string;
  version: string;
  /** NDJSON sink for cross-process aggregation; errors here are swallowed. */
  stream?: { write(chunk: string): void };
}

/**
 * MetricLogger is the only telemetry surface used by the three plugins.
 * Instrumentation sites call `span(...)` and `observe(...)`; neither can throw
 * into the caller's control flow.
 */
export class MetricLogger {
  readonly memory: MemorySink;
  private readonly sink: TelemetrySink;

  constructor(private readonly options: MetricLoggerOptions) {
    this.memory = new MemorySink();
    this.sink = options.sink ?? this.memory;
  }

  async span<T>(
    kind: SpanKind | "internal",
    name: string,
    attributes: Record<string, string | number | boolean>,
    fn: () => Promise<T> | T,
  ): Promise<T> {
    const startedAt = Date.now();
    const started = performance.now();
    try {
      const result = await fn();
      this.record({
        name,
        kind,
        started_at: startedAt,
        duration_ms: Math.round(performance.now() - started),
        attributes: { ...attributes, ok: true },
      });
      return result;
    } catch (error) {
      this.record({
        name,
        kind,
        started_at: startedAt,
        duration_ms: Math.round(performance.now() - started),
        attributes: { ...attributes, ok: false },
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private record(record: SpanRecord): void {
    try {
      this.sink.span(record);
      this.options.stream?.write(
        JSON.stringify({
          service: this.options.service,
          version: this.options.version,
          kind: "span",
          name: record.name,
          span_kind: record.kind,
          duration_ms: record.duration_ms,
          ...record.attributes,
          ...(record.error ? { error: record.error } : {}),
        }) + "\n",
      );
    } catch {
      /* telemetry must never break the pipeline */
    }
  }

  count(name: string, value = 1, attributes: Record<string, string | number | boolean> = {}): void {
    try {
      this.sink.counter({ name, value, attributes });
    } catch {
      /* ignore */
    }
  }

  observe(name: string, value: number, attributes: Record<string, string | number | boolean> = {}): void {
    try {
      this.sink.histogram({ name, count: 1, sum: value, min: value, max: value, p50: value, p95: value, p99: value, attributes });
      this.memory.observe(name, value, attributes);
    } catch {
      /* ignore */
    }
  }

  timing<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
    return this.span("internal", name, {}, fn);
  }
}

export function noopLogger(service = "unknown", version = "0.0.0"): MetricLogger {
  return new MetricLogger({ service, version });
}
