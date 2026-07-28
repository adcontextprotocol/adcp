import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { IncrementResponse, Options } from 'express-rate-limit';
import { parseRetryAfterSeconds, createAgentReadRateLimiter, createBrandBulkDomainRateLimiter } from '../../src/middleware/rate-limit.js';
import type { WeightedIncrementStore } from '../../src/middleware/pg-rate-limit-store.js';

/**
 * Tests for the retryAfter fallback field we surface on the 429 body
 * from `agentReadRateLimiter` (#2804/#2939). Reverse proxies sometimes
 * strip non-standard response headers; the dashboard client falls back
 * to the JSON body when the `Retry-After` header is missing.
 */

describe('parseRetryAfterSeconds', () => {
  it('accepts positive integers', () => {
    expect(parseRetryAfterSeconds(30)).toBe(30);
    expect(parseRetryAfterSeconds('15')).toBe(15);
  });

  it('rejects zero — the client treats a zero countdown as "no hint" rather than a degenerate tick', () => {
    expect(parseRetryAfterSeconds(0)).toBeUndefined();
    expect(parseRetryAfterSeconds('0')).toBeUndefined();
  });

  it('rejects negatives and non-finite numbers', () => {
    expect(parseRetryAfterSeconds(-5)).toBeUndefined();
    expect(parseRetryAfterSeconds(Number.NaN)).toBeUndefined();
    expect(parseRetryAfterSeconds(Infinity)).toBeUndefined();
  });

  it('rejects non-numeric strings', () => {
    expect(parseRetryAfterSeconds('soon')).toBeUndefined();
    expect(parseRetryAfterSeconds('')).toBeUndefined();
  });

  it('returns undefined for unexpected shapes (array, undefined)', () => {
    expect(parseRetryAfterSeconds(undefined)).toBeUndefined();
    expect(parseRetryAfterSeconds(['30', '60'])).toBeUndefined();
  });
});

describe('agentReadRateLimiter 429 body', () => {
  // Exercise the actual middleware through a tiny express app so the
  // assertion lives at the same layer production depends on. Use an
  // isolated limiter instance rather than the production singleton so
  // parallel test files cannot reset or mutate this counter.
  function buildApp() {
    const app = express();
    const limiter = createAgentReadRateLimiter({ max: 3 });
    app.use((req, _res, next) => {
      (req as any).user = { id: RATE_LIMIT_TEST_USER_ID };
      next();
    });
    app.get('/ping', limiter, (_req, res) => res.status(200).json({ ok: true }));
    return app;
  }

  const RATE_LIMIT_TEST_USER_ID = 'rate-limit-retry-after-test-user';

  it('includes `retryAfter` (seconds) in the body matching the Retry-After header', async () => {
    const app = buildApp();
    // Race past the configured cap. Same user so the limiter keys identically.
    // Serial rather than parallel — express-rate-limit's in-flight
    // tracking is more deterministic, and the assertion is about the
    // 429 body shape, not concurrent behavior.
    let last: Awaited<ReturnType<typeof request>>;
    for (let i = 0; i < 4; i++) {
      last = await request(app).get('/ping');
    }
    expect(last!.status).toBe(429);
    expect(last!.body.error).toBe('Too many requests');
    expect(typeof last!.body.retryAfter).toBe('number');
    expect(last!.body.retryAfter).toBeGreaterThan(0);

    // Unconditional cross-check: the body's `retryAfter` must equal
    // the `Retry-After` header's delta-seconds. If the header is
    // malformed or missing, this assertion fails loudly rather than
    // silently skipping — either outcome would be a bug the test
    // needs to catch.
    const headerSeconds = parseInt(last!.headers['retry-after'] ?? '', 10);
    expect(Number.isFinite(headerSeconds)).toBe(true);
    expect(headerSeconds).toBeGreaterThan(0);
    expect(last!.body.retryAfter).toBe(headerSeconds);
  }, 30_000);
});

describe('brand bulk domain rate limiter', () => {
  /**
   * Records every weighted increment so the test can assert the limiter spends
   * a request's whole domain count in one atomic operation. A loop of single
   * increments would let concurrent requests interleave and each read a total
   * below what they collectively spent.
   */
  class RecordingWeightedStore implements WeightedIncrementStore {
    readonly increments: Array<{ key: string; weight: number }> = [];
    private windowMs = 60_000;
    private hits = new Map<string, number>();

    init(options: Options): void {
      this.windowMs = options.windowMs;
    }

    async increment(key: string): Promise<IncrementResponse> {
      return this.incrementBy(key, 1);
    }

    async incrementBy(key: string, weight: number): Promise<IncrementResponse> {
      this.increments.push({ key, weight });
      const totalHits = (this.hits.get(key) ?? 0) + weight;
      this.hits.set(key, totalHits);
      return { totalHits, resetTime: new Date(Date.now() + this.windowMs) };
    }

    async decrement(key: string): Promise<void> {
      this.hits.set(key, Math.max((this.hits.get(key) ?? 0) - 1, 0));
    }

    async resetKey(key: string): Promise<void> {
      this.hits.delete(key);
    }
  }

  function buildApp(store: WeightedIncrementStore) {
    const app = express();
    app.use(express.json());
    app.post('/resolve', createBrandBulkDomainRateLimiter({
      maxDomains: 3,
      store,
    }), (_req, res) => res.json({ ok: true }));
    return app;
  }

  it('charges each request by unique domain count', async () => {
    const store = new RecordingWeightedStore();
    const app = buildApp(store);

    const first = await request(app)
      .post('/resolve')
      .send({ domains: ['one.example', 'one.example', 'two.example'] });
    const second = await request(app)
      .post('/resolve')
      .send({ domains: ['three.example', 'four.example'] });

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
    expect(second.body.message).toContain('domain limit exceeded');
  });

  it('spends the whole request weight in one store operation', async () => {
    const store = new RecordingWeightedStore();

    await request(buildApp(store))
      .post('/resolve')
      .send({ domains: ['one.example', 'two.example', 'one.example'] });

    expect(store.increments).toHaveLength(1);
    expect(store.increments[0].weight).toBe(2);
  });

  it('keys all request sizes to the same counter', async () => {
    const store = new RecordingWeightedStore();
    const app = buildApp(store);

    await request(app).post('/resolve').send({ domains: ['one.example'] });
    await request(app).post('/resolve').send({ domains: ['two.example', 'three.example'] });

    expect(new Set(store.increments.map((entry) => entry.key)).size).toBe(1);
  });
});
