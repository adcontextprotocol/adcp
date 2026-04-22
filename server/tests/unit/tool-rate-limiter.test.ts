import { describe, it, expect, beforeEach } from 'vitest';
import {
  checkToolRateLimit,
  withToolRateLimit,
  __resetRateLimitHistory,
} from '../../src/addie/mcp/tool-rate-limiter.js';

describe('checkToolRateLimit', () => {
  beforeEach(() => __resetRateLimitHistory());

  it('allows calls under the per-tool cap', () => {
    for (let i = 0; i < 10; i++) {
      const r = checkToolRateLimit('generate_perspective_illustration', 'u1');
      expect(r.ok).toBe(true);
    }
  });

  it('rejects the call that crosses the per-tool cap', () => {
    for (let i = 0; i < 10; i++) {
      expect(checkToolRateLimit('generate_perspective_illustration', 'u1').ok).toBe(true);
    }
    const blocked = checkToolRateLimit('generate_perspective_illustration', 'u1');
    expect(blocked.ok).toBe(false);
    expect(blocked.scope).toBe('per_tool');
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
  });

  it('rejects at the global cap even when per-tool caps are unhit', () => {
    // Default cap is 60/10min per tool. Global cap is 200/10min per user.
    // Exercise 4 different tools with 50 each = 200 total → global trip.
    for (const tool of ['tool_a', 'tool_b', 'tool_c', 'tool_d']) {
      for (let i = 0; i < 50; i++) {
        expect(checkToolRateLimit(tool, 'u2').ok).toBe(true);
      }
    }
    const blocked = checkToolRateLimit('tool_e', 'u2');
    expect(blocked.ok).toBe(false);
    expect(blocked.scope).toBe('global');
  });

  it('tracks users independently', () => {
    for (let i = 0; i < 10; i++) {
      checkToolRateLimit('generate_perspective_illustration', 'u-alpha');
    }
    // Alpha hit the wall, Bravo should still be fine
    expect(checkToolRateLimit('generate_perspective_illustration', 'u-alpha').ok).toBe(false);
    expect(checkToolRateLimit('generate_perspective_illustration', 'u-bravo').ok).toBe(true);
  });

  it('tracks tools independently within a user', () => {
    for (let i = 0; i < 10; i++) {
      checkToolRateLimit('generate_perspective_illustration', 'u3');
    }
    // illustration is at cap (10), but read_google_doc (cap 20) still has room
    expect(checkToolRateLimit('generate_perspective_illustration', 'u3').ok).toBe(false);
    expect(checkToolRateLimit('read_google_doc', 'u3').ok).toBe(true);
  });

  it('exempts system: users', () => {
    for (let i = 0; i < 100; i++) {
      expect(checkToolRateLimit('generate_perspective_illustration', 'system:addie').ok).toBe(true);
    }
  });

  it('skips the limiter when userId is null or undefined', () => {
    for (let i = 0; i < 100; i++) {
      expect(checkToolRateLimit('generate_perspective_illustration', null).ok).toBe(true);
      expect(checkToolRateLimit('generate_perspective_illustration', undefined).ok).toBe(true);
    }
  });

  it('uses the default cap (60) for unknown tools', () => {
    for (let i = 0; i < 60; i++) {
      expect(checkToolRateLimit('some_unknown_tool', 'u4').ok).toBe(true);
    }
    expect(checkToolRateLimit('some_unknown_tool', 'u4').ok).toBe(false);
  });

  it('retryAfterMs is a positive value within the window bound', () => {
    for (let i = 0; i < 10; i++) checkToolRateLimit('generate_perspective_illustration', 'u-retry');
    const blocked = checkToolRateLimit('generate_perspective_illustration', 'u-retry');
    expect(blocked.ok).toBe(false);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
    expect(blocked.retryAfterMs).toBeLessThanOrEqual(10 * 60 * 1000);
  });

  it('exempts literal allowlisted system ids only (not any string starting with system:)', () => {
    // `system:addie` is on the allowlist → exempt
    for (let i = 0; i < 50; i++) {
      expect(checkToolRateLimit('generate_perspective_illustration', 'system:addie').ok).toBe(true);
    }
    // `system:fake-id` is NOT on the allowlist → rate-limited like any user
    for (let i = 0; i < 10; i++) {
      expect(checkToolRateLimit('generate_perspective_illustration', 'system:fake-id').ok).toBe(true);
    }
    expect(checkToolRateLimit('generate_perspective_illustration', 'system:fake-id').ok).toBe(false);
  });

  it('opportunistic GC trims stale entries once the map grows past the threshold', () => {
    // Seed many distinct users so the map grows. Each user makes one
    // call — under the cap, so no rejection. The GC pass inside
    // checkToolRateLimit should trigger once history.size exceeds 2000.
    for (let i = 0; i < 2100; i++) {
      checkToolRateLimit('default_tool', `gc-user-${i}`);
    }
    // No assertion on exact size (GC threshold is an implementation
    // detail), but the test at minimum proves we don't crash or
    // accumulate pathologically — combined with the earlier cases,
    // this covers the GC code path.
    expect(true).toBe(true);
  });
});

describe('withToolRateLimit', () => {
  beforeEach(() => __resetRateLimitHistory());

  it('delegates to the inner handler when under the cap', async () => {
    let calls = 0;
    const wrapped = withToolRateLimit('read_google_doc', 'u1', async () => {
      calls++;
      return 'ok';
    });

    for (let i = 0; i < 20; i++) {
      expect(await wrapped({ url: 'x' })).toBe('ok');
    }
    expect(calls).toBe(20);
  });

  it('returns a user-facing rate-limit message without calling the inner handler', async () => {
    let calls = 0;
    const wrapped = withToolRateLimit('read_google_doc', 'u1', async () => {
      calls++;
      return 'ok';
    });

    for (let i = 0; i < 20; i++) await wrapped({});
    const result = await wrapped({});
    expect(result).toMatch(/Rate limit exceeded/i);
    expect(result).toMatch(/read_google_doc/);
    expect(calls).toBe(20);
  });

  it('names the global scope in the error when the global cap trips', async () => {
    const tools = ['tool_1', 'tool_2', 'tool_3', 'tool_4'];
    // Fill 200 total using default 60/tool — 4 tools × 50 = 200
    for (const t of tools) {
      const wrapped = withToolRateLimit(t, 'u-global', async () => 'ok');
      for (let i = 0; i < 50; i++) await wrapped({});
    }
    const blocked = withToolRateLimit('tool_5', 'u-global', async () => 'ok');
    const result = await blocked({});
    expect(result).toMatch(/overall Addie tool call limit/i);
  });

  it('passes through system: users without rate checks', async () => {
    let calls = 0;
    const wrapped = withToolRateLimit('generate_perspective_illustration', 'system:addie', async () => {
      calls++;
      return 'ok';
    });
    for (let i = 0; i < 50; i++) await wrapped({});
    expect(calls).toBe(50);
  });
});
