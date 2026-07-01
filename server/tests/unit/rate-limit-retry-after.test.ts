import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { parseRetryAfterSeconds, createAgentReadRateLimiter } from '../../src/middleware/rate-limit.js';

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
