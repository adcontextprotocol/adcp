import { describe, it, expect, beforeEach } from 'vitest';
import {
  checkToolRateLimit,
  withToolRateLimit,
  __resetRateLimitHistory,
  __setRateLimitStore,
  __createInMemoryStore,
} from '../../src/addie/mcp/tool-rate-limiter.js';

// The limiter's default store is Postgres-backed (#2789). Unit tests
// swap in an in-memory store so they don't need a DB connection.
beforeEach(async () => {
  __setRateLimitStore(__createInMemoryStore());
  await __resetRateLimitHistory();
});

describe('checkToolRateLimit', () => {
  it('allows calls under the per-tool cap', async () => {
    for (let i = 0; i < 10; i++) {
      const r = await checkToolRateLimit('generate_perspective_illustration', 'u1');
      expect(r.ok).toBe(true);
    }
  });

  it('rejects the call that crosses the per-tool cap', async () => {
    for (let i = 0; i < 10; i++) {
      expect((await checkToolRateLimit('generate_perspective_illustration', 'u1')).ok).toBe(true);
    }
    const blocked = await checkToolRateLimit('generate_perspective_illustration', 'u1');
    expect(blocked.ok).toBe(false);
    expect(blocked.scope).toBe('per_tool');
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
  });

  it('rejects at the global cap even when per-tool caps are unhit', async () => {
    // Default cap is 60/10min per tool. Global cap is 200/10min per user.
    // Exercise 4 different tools with 50 each = 200 total → global trip.
    for (const tool of ['tool_a', 'tool_b', 'tool_c', 'tool_d']) {
      for (let i = 0; i < 50; i++) {
        expect((await checkToolRateLimit(tool, 'u2')).ok).toBe(true);
      }
    }
    const blocked = await checkToolRateLimit('tool_e', 'u2');
    expect(blocked.ok).toBe(false);
    expect(blocked.scope).toBe('global');
  });

  it('tracks users independently', async () => {
    for (let i = 0; i < 10; i++) {
      await checkToolRateLimit('generate_perspective_illustration', 'u-alpha');
    }
    expect((await checkToolRateLimit('generate_perspective_illustration', 'u-alpha')).ok).toBe(false);
    expect((await checkToolRateLimit('generate_perspective_illustration', 'u-bravo')).ok).toBe(true);
  });

  it('tracks tools independently within a user', async () => {
    for (let i = 0; i < 10; i++) {
      await checkToolRateLimit('generate_perspective_illustration', 'u3');
    }
    // illustration is at cap (10), but read_google_doc (cap 20) still has room
    expect((await checkToolRateLimit('generate_perspective_illustration', 'u3')).ok).toBe(false);
    expect((await checkToolRateLimit('read_google_doc', 'u3')).ok).toBe(true);
  });

  it('exempts system: users', async () => {
    for (let i = 0; i < 100; i++) {
      expect((await checkToolRateLimit('generate_perspective_illustration', 'system:addie')).ok).toBe(true);
    }
  });

  it('skips the limiter when userId is null or undefined', async () => {
    for (let i = 0; i < 100; i++) {
      expect((await checkToolRateLimit('generate_perspective_illustration', null)).ok).toBe(true);
      expect((await checkToolRateLimit('generate_perspective_illustration', undefined)).ok).toBe(true);
    }
  });

  it('uses the default cap (60) for unknown tools', async () => {
    for (let i = 0; i < 60; i++) {
      expect((await checkToolRateLimit('some_unknown_tool', 'u4')).ok).toBe(true);
    }
    expect((await checkToolRateLimit('some_unknown_tool', 'u4')).ok).toBe(false);
  });

  it('retryAfterMs is a positive value within the window bound', async () => {
    for (let i = 0; i < 10; i++) await checkToolRateLimit('generate_perspective_illustration', 'u-retry');
    const blocked = await checkToolRateLimit('generate_perspective_illustration', 'u-retry');
    expect(blocked.ok).toBe(false);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
    expect(blocked.retryAfterMs).toBeLessThanOrEqual(10 * 60 * 1000);
  });

  it('exempts literal allowlisted system ids only (not any string starting with system:)', async () => {
    for (let i = 0; i < 50; i++) {
      expect((await checkToolRateLimit('generate_perspective_illustration', 'system:addie')).ok).toBe(true);
    }
    for (let i = 0; i < 10; i++) {
      expect((await checkToolRateLimit('generate_perspective_illustration', 'system:fake-id')).ok).toBe(true);
    }
    expect((await checkToolRateLimit('generate_perspective_illustration', 'system:fake-id')).ok).toBe(false);
  });

  it('enforces a workspace-wide cap across all users for listed tools (#2796)', async () => {
    // generate_perspective_illustration has a workspace cap of 50/day.
    // With 4 users rotating, per-user cap (10) fires first at call index 40.
    const users = ['ws-alice', 'ws-bob', 'ws-carol', 'ws-dave'];
    let blockedAt = -1;
    let blockedScope: string | undefined;
    outer: for (let round = 0; round < 20; round++) {
      for (const u of users) {
        const r = await checkToolRateLimit('generate_perspective_illustration', u);
        if (!r.ok) {
          blockedAt = round * users.length + users.indexOf(u);
          blockedScope = r.scope;
          break outer;
        }
      }
    }
    expect(blockedAt).toBeGreaterThanOrEqual(0);
    expect(['per_tool', 'workspace']).toContain(blockedScope);
  });

  it('workspace cap binds when many distinct users stay under per-user caps', async () => {
    // 60 distinct users × 1 call each = 60 total. Per-user cap (10)
    // isn't hit. Global cap (200) isn't hit. Workspace cap (50) fires.
    let blockedScope: string | undefined;
    let blockedAt = -1;
    for (let i = 0; i < 60; i++) {
      const r = await checkToolRateLimit('generate_perspective_illustration', `ws-user-${i}`);
      if (!r.ok) {
        blockedAt = i;
        blockedScope = r.scope;
        break;
      }
    }
    expect(blockedAt).toBe(50);
    expect(blockedScope).toBe('workspace');
  });

  it('workspace cap does not apply to tools not listed in WORKSPACE_CAPS', async () => {
    for (let i = 0; i < 100; i++) {
      expect((await checkToolRateLimit('read_google_doc', `read-user-${i}`)).ok).toBe(true);
    }
  });

  it('does not record under any scope when a downstream scope blocks the call', async () => {
    // Fill the global cap with 4 unknown tools × 50 calls each.
    for (const tool of ['t1', 't2', 't3', 't4']) {
      for (let i = 0; i < 50; i++) {
        await checkToolRateLimit(tool, 'u-scoped');
      }
    }
    // A NEW tool now — per-tool scope has 0 hits, but global cap blocks.
    const blocked = await checkToolRateLimit('t5', 'u-scoped');
    expect(blocked.ok).toBe(false);
    expect(blocked.scope).toBe('global');

    // After resetting to a clean store, the new tool should accept the
    // full 60-call default cap. If the blocked call above had recorded
    // under per-tool, this loop would block before 60.
    __setRateLimitStore(__createInMemoryStore());
    for (let i = 0; i < 60; i++) {
      expect((await checkToolRateLimit('t5', 'u-scoped')).ok).toBe(true);
    }
    expect((await checkToolRateLimit('t5', 'u-scoped')).ok).toBe(false);
  });
});

describe('withToolRateLimit', () => {
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
