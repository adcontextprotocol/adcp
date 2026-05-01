/**
 * In-memory TTL cache + per-host token-bucket rate limiter for the AAO
 * agent resolver.
 *
 * Two responsibilities:
 *
 * 1. Cache the brand.json and capabilities responses for short windows so a
 *    burst of resolve requests for the same agent does not amplify into
 *    upstream traffic. JWKS responses are NOT cached here — those are
 *    proxied byte-for-byte with the upstream `Cache-Control` propagated.
 *
 * 2. Rate limit upstream fetches per eTLD+1 host so a hot caller cannot
 *    exhaust an operator's quota. Pure token bucket — refill at a steady
 *    rate, deny when the bucket is empty. Per spec §"SSRF and rate-limit
 *    hardening" the per-caller-IP cap (enforced upstream by the route's
 *    rate-limiter middleware) MUST be lower than the per-host cap; this
 *    module only enforces the per-host side.
 *
 * The cache uses the project pattern from `services/brandfetch.ts` rather
 * than `lru-cache` so we keep the `Map`+timestamp-based expiry surface
 * uniform across the codebase. Bounded by `maxEntries` to prevent unbounded
 * growth from caller-controlled keys.
 */
export interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export class TtlCache<T> {
  private readonly store = new Map<string, CacheEntry<T>>();
  private readonly defaultTtlMs: number;
  private readonly maxEntries: number;

  constructor(opts: { defaultTtlMs: number; maxEntries?: number }) {
    this.defaultTtlMs = opts.defaultTtlMs;
    this.maxEntries = opts.maxEntries ?? 5000;
  }

  get(key: string, now = Date.now()): T | undefined {
    const hit = this.store.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt <= now) {
      this.store.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key: string, value: T, ttlMs?: number, now = Date.now()): void {
    if (this.store.size >= this.maxEntries && !this.store.has(key)) {
      // Evict oldest insertion when at capacity. Map iteration is insertion
      // order. Cheap and predictable; we don't need true LRU here.
      const oldest = this.store.keys().next();
      if (!oldest.done) this.store.delete(oldest.value);
    }
    this.store.set(key, {
      value,
      expiresAt: now + (ttlMs ?? this.defaultTtlMs),
    });
  }

  delete(key: string): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }

  size(): number {
    return this.store.size;
  }
}

/**
 * Token-bucket rate limiter. Simple, deterministic, easy to test.
 *
 * `capacity` tokens, refills at `refillPerSecond` tokens/second. Each
 * `consume(key)` either takes one token (returns true) or denies (returns
 * false). Time is injectable so tests don't need real timers.
 */
export class TokenBucketRateLimiter {
  private readonly buckets = new Map<
    string,
    { tokens: number; lastRefill: number }
  >();
  private readonly capacity: number;
  private readonly refillPerSecond: number;
  private readonly now: () => number;
  private readonly maxBuckets: number;

  constructor(opts: {
    capacity: number;
    refillPerSecond: number;
    now?: () => number;
    maxBuckets?: number;
  }) {
    this.capacity = opts.capacity;
    this.refillPerSecond = opts.refillPerSecond;
    this.now = opts.now ?? (() => Date.now());
    this.maxBuckets = opts.maxBuckets ?? 10000;
  }

  consume(key: string): boolean {
    const now = this.now();
    let bucket = this.buckets.get(key);
    if (!bucket) {
      if (this.buckets.size >= this.maxBuckets) {
        const oldest = this.buckets.keys().next();
        if (!oldest.done) this.buckets.delete(oldest.value);
      }
      bucket = { tokens: this.capacity, lastRefill: now };
      this.buckets.set(key, bucket);
    } else {
      const elapsedMs = now - bucket.lastRefill;
      if (elapsedMs > 0) {
        const refill = (elapsedMs / 1000) * this.refillPerSecond;
        bucket.tokens = Math.min(this.capacity, bucket.tokens + refill);
        bucket.lastRefill = now;
      }
    }
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return true;
    }
    return false;
  }

  /** Test helper: reset all buckets. */
  reset(): void {
    this.buckets.clear();
  }
}
