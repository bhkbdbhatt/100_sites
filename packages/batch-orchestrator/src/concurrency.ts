/**
 * Concurrency primitives for the batch scheduler.
 *
 * Deliberately not async-aware: no `Mutex` class, no dependency. The scheduler
 * needs a semaphore (bounded in-flight work) and a rate limiter (bounded
 * request rate), and both are short enough that a wrong implementation would be
 * a correctness bug. These are ~40 lines each and fully exercised.
 */

/** Counting semaphore with FIFO waiters. */
export class Semaphore {
  private available: number;
  private readonly total: number;
  private readonly waiters: Array<() => void> = [];

  constructor(permits: number) {
    if (!Number.isInteger(permits) || permits < 1) {
      throw new RangeError(`semaphore permits must be a positive integer, got ${permits}`);
    }
    this.available = permits;
    this.total = permits;
  }

  /** Permits currently held. */
  get inUse(): number {
    return this.total - this.available;
  }

  async acquire(): Promise<() => void> {
    if (this.available > 0) {
      this.available -= 1;
      return this.releaseOnce();
    }
    await new Promise<void>((resolveWaiter) => this.waiters.push(resolveWaiter));
    return this.releaseOnce();
  }

  private releaseOnce(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) {
        // Hand the permit straight to the next waiter; `available` stays put.
        next();
      } else {
        this.available += 1;
      }
    };
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await task();
    } finally {
      release();
    }
  }
}

/**
 * Token-bucket rate limiter. `acquire()` resolves when a token is available;
 * callers that queue many requests get smooth pacing instead of a burst.
 */
export class TokenBucket {
  private tokens: number;
  private lastRefillMs: number;
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private readonly clock: () => number;

  constructor(options: { capacity: number; refillPerMs: number; now?: () => number }) {
    this.capacity = options.capacity;
    this.tokens = options.capacity;
    this.refillPerMs = options.refillPerMs;
    this.clock = options.now ?? (() => Date.now());
    this.lastRefillMs = this.clock();
  }

  private refill(now: number): void {
    const elapsed = Math.max(0, now - this.lastRefillMs);
    if (elapsed === 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerMs);
    this.lastRefillMs = now;
  }

  async acquire(now?: number): Promise<void> {
    let current = now ?? this.clock();
    for (;;) {
      this.refill(current);
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      // A bucket that never refills has no waiting time to offer. Retrying it
      // would spin, so the misconfiguration is reported instead.
      if (this.refillPerMs <= 0) {
        throw new RangeError("token bucket is empty and refillPerMs is 0, so no token can ever arrive");
      }
      const waitMs = Math.min(MAX_TIMER_MS, Math.max(1, Math.ceil((1 - this.tokens) / this.refillPerMs)));
      await delay(waitMs);
      current = this.clock();
    }
  }
}

/** `setTimeout` silently fires immediately past 2^31-1 ms, so waits are clamped. */
const MAX_TIMER_MS = 2_147_483_647;

/** Full-jitter exponential backoff (NFR-B5): waits spread out, no thundering herd. */
export function backoffDelay(attempt: number, options: { baseMs: number; maxMs: number; jitter: boolean }): number {
  const exponential = Math.min(options.maxMs, options.baseMs * 2 ** Math.max(0, attempt - 1));
  if (!options.jitter) return exponential;
  return Math.floor(Math.random() * exponential);
}

export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (!Number.isFinite(ms) || ms <= 0) return Promise.resolve();
  return new Promise((resolvePromise) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolvePromise();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolvePromise();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Circuit breaker (NFR-B6). Opens after `threshold` failures inside the
 * window, so a provider outage costs one failed attempt per job rather than a
 * full retry storm. `OPEN` is the only state that fails fast.
 */
export type BreakerState = "closed" | "open" | "half_open";

export class CircuitBreaker {
  private failures: number[] = [];
  private state: BreakerState = "closed";
  private openedAtMs = 0;
  private probeInFlight = false;

  /**
   * @param threshold Failure ratio (0-1) that opens the circuit, e.g. 0.2.
   * @param windowMs  Sliding window over which the ratio is measured.
   */
  constructor(
    private readonly threshold: number,
    private readonly windowMs: number,
    private readonly coolOffMs = 5000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  get current(): BreakerState {
    if (this.state === "open" && this.now() - this.openedAtMs >= this.coolOffMs) {
      this.state = "half_open";
      this.probeInFlight = false;
    }
    return this.state;
  }

  /** True when a call may proceed. A half-open circuit admits one probe at a time. */
  allow(): boolean {
    if (this.current === "open") return false;
    if (this.state === "half_open") {
      if (this.probeInFlight) return false;
      this.probeInFlight = true;
      return true;
    }
    return true;
  }

  recordSuccess(): void {
    this.failures = [];
    this.probeInFlight = false;
    this.state = "closed";
  }

  recordFailure(): void {
    const now = this.now();
    this.probeInFlight = false;
    this.failures = this.failures.filter((at) => now - at <= this.windowMs);
    this.failures.push(now);
    if (this.state === "half_open") {
      // A failed probe re-opens immediately, regardless of the ratio.
      this.state = "open";
      this.openedAtMs = now;
      return;
    }
    // Minimum sample of 3: one failure must not open the circuit.
    const sample = Math.max(3, this.failures.length);
    if (sample >= 3 && this.failures.length / sample >= this.threshold) {
      this.state = "open";
      this.openedAtMs = now;
    }
  }
}

/**
 * Runs `task` under the retry policy. Only retryable failures are retried; a
 * non-retryable problem (a bad prompt, a schema violation) fails immediately,
 * because retrying it just spends the deadline.
 */
export async function withRetry<T>(
  task: (attempt: number) => Promise<T>,
  options: {
    attempts: number;
    baseMs: number;
    maxMs: number;
    jitter: boolean;
    signal?: AbortSignal;
    isRetryable: (error: unknown) => boolean;
    onRetry?: (attempt: number, error: unknown, waitMs: number) => void;
  },
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    try {
      return await task(attempt);
    } catch (error) {
      lastError = error;
      if (attempt === options.attempts || !options.isRetryable(error)) throw error;
      const waitMs = backoffDelay(attempt, options);
      options.onRetry?.(attempt, error, waitMs);
      await delay(waitMs, options.signal);
    }
  }
  throw lastError;
}

/** A promise plus its resolvers, for deadline enforcement without timers leaking. */
export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Rejects with a deadline error if `promise` does not settle in `ms`. */
export async function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, rejectPromise) => {
    timer = setTimeout(() => rejectPromise(onTimeout()), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
