import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { parseRetryAfterSeconds, agentReadRateLimiter } from '../../src/middleware/rate-limit.js';

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
  // assertion lives at the same layer production depends on. This is
  // cheap — the limiter uses a cached Postgres store by default, but
  // in tests we use a trivial in-memory store by monkey-patching the
  // store interface isn't exposed here. Instead we just overwhelm
  // the limiter by setting a very low max via the existing limiter
  // and checking that the 429 body carries retryAfter.
  //
  // The live limiter has max=240/min; we can't easily reach that in a
  // unit test. Instead, mount it on a dummy route and fire 241 reqs
  // so the 429 fires on the last one.
  function buildApp() {
    const app = express();
    app.get('/ping', agentReadRateLimiter, (_req, res) => res.status(200).json({ ok: true }));
    return app;
  }

  it('includes `retryAfter` (seconds) in the body when the header is set', async () => {
    const app = buildApp();
    // Race past the 240/min cap. Same IP so the limiter keys identically.
    // We do this serially because express-rate-limit's in-flight
    // tracking can be fiddly with parallel supertest calls and the
    // test point is the 429 body, not concurrent behavior.
    let last: Awaited<ReturnType<typeof request>>;
    for (let i = 0; i < 241; i++) {
      last = await request(app).get('/ping');
    }
    expect(last!.status).toBe(429);
    expect(last!.body.error).toBe('Too many requests');
    expect(typeof last!.body.retryAfter).toBe('number');
    expect(last!.body.retryAfter).toBeGreaterThan(0);
    // Header and body should agree.
    const headerSeconds = parseInt(last!.headers['retry-after'] ?? '', 10);
    if (Number.isFinite(headerSeconds) && headerSeconds > 0) {
      expect(last!.body.retryAfter).toBe(headerSeconds);
    }
  }, 30_000);
});
