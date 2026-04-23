import { describe, it, expect, beforeEach } from 'vitest';
import {
  checkCostCap,
  recordCost,
  formatCapExceededMessage,
  resolveUserTier,
  DAILY_BUDGET_USD,
  __setCostTrackerStore,
  __createInMemoryCostStore,
} from '../../src/addie/claude-cost-tracker.js';

/**
 * #2790 — per-user daily USD budget at the claude-client boundary.
 * Unit tests swap in an in-memory store via the DI seam so no DB
 * connection is needed.
 */

beforeEach(() => {
  __setCostTrackerStore(__createInMemoryCostStore());
});

describe('checkCostCap', () => {
  it('skips the cap when userId is missing (anonymous, unauthenticated paths)', async () => {
    const result = await checkCostCap(undefined, 'member_paid');
    expect(result.ok).toBe(true);
  });

  it('exempts known system users', async () => {
    const result = await checkCostCap('system:addie', 'member_paid');
    expect(result.ok).toBe(true);
  });

  it('allows calls while under the tier budget', async () => {
    const result = await checkCostCap('u1', 'member_free');
    expect(result.ok).toBe(true);
    expect(result.remainingUsd).toBe(DAILY_BUDGET_USD.member_free);
    expect(result.spentCents).toBe(0);
  });

  it('blocks the call that crosses the daily budget', async () => {
    // Burn the anonymous budget ($1 = 1,000,000 micros) by recording
    // one big charge, then check.
    await recordCost('u-cap', 'claude-opus-4-7', { input_tokens: 66_667, output_tokens: 0 });
    // 66_667 × 15 = 1_000_005 micros — just over the $1 cap.
    const result = await checkCostCap('u-cap', 'anonymous');
    expect(result.ok).toBe(false);
    expect(result.remainingUsd).toBe(0);
    expect(result.spentCents).toBeGreaterThanOrEqual(100);
    expect(result.retryAfterMs).toBeGreaterThan(0);
    expect(result.tier).toBe('anonymous');
  });

  it('tracks users independently', async () => {
    await recordCost('u-heavy', 'claude-opus-4-7', { input_tokens: 66_667, output_tokens: 0 });
    expect((await checkCostCap('u-heavy', 'anonymous')).ok).toBe(false);
    expect((await checkCostCap('u-light', 'anonymous')).ok).toBe(true);
  });

  it('applies different budgets per tier — paying members get more headroom', async () => {
    // Burn ~$3 (well over anonymous/free caps, under member_paid's $25).
    await recordCost('u-tier', 'claude-sonnet-4-6', { input_tokens: 1_000_000, output_tokens: 0 });
    expect((await checkCostCap('u-tier', 'anonymous')).ok).toBe(false);
    expect((await checkCostCap('u-tier', 'member_free')).ok).toBe(true);
    expect((await checkCostCap('u-tier', 'member_paid')).ok).toBe(true);
  });

  it('aggregates multiple recorded calls into the running total', async () => {
    // 10× small Haiku calls (10 * 100 micros = 1000 micros = $0.001)
    for (let i = 0; i < 10; i++) {
      await recordCost('u-sum', 'claude-haiku-4-5', { input_tokens: 100, output_tokens: 0 });
    }
    const result = await checkCostCap('u-sum', 'member_free');
    expect(result.ok).toBe(true);
    expect(result.spentCents).toBe(0); // under 1 cent
  });
});

describe('recordCost', () => {
  it('is a no-op when userId is missing', async () => {
    await recordCost(undefined, 'claude-haiku-4-5', { input_tokens: 1000, output_tokens: 500 });
    expect((await checkCostCap('u-noop', 'member_free')).spentCents).toBe(0);
  });

  it('is a no-op for system users (they shouldn\'t count toward any per-user cap)', async () => {
    await recordCost('system:addie', 'claude-opus-4-7', { input_tokens: 100_000, output_tokens: 50_000 });
    // Any non-system user starts fresh.
    expect((await checkCostCap('u-fresh', 'anonymous')).spentCents).toBe(0);
  });

  it('accumulates cost across calls for a single user', async () => {
    await recordCost('u-accum', 'claude-haiku-4-5', { input_tokens: 10_000, output_tokens: 5000 });
    await recordCost('u-accum', 'claude-sonnet-4-6', { input_tokens: 10_000, output_tokens: 5000 });
    const result = await checkCostCap('u-accum', 'member_paid');
    // Haiku: 10_000*1 + 5000*5 = 35_000 micros
    // Sonnet: 10_000*3 + 5000*15 = 105_000 micros
    // Total = 140_000 micros = $0.14 = 14 cents
    expect(result.spentCents).toBe(14);
  });
});

describe('formatCapExceededMessage', () => {
  it('includes the tier cap, current spend, and reset time', () => {
    const msg = formatCapExceededMessage({
      ok: false,
      spentCents: 550,
      remainingUsd: 0,
      retryAfterMs: 45 * 60 * 1000, // 45 min
      tier: 'member_free',
    });
    expect(msg).toContain('5 USD'); // member_free cap
    expect(msg).toContain('$5.50'); // current spend
    expect(msg).toContain('45 minutes');
    expect(msg).toContain('Upgrade'); // CTA for non-paying
  });

  it('tells paying members to ping the team instead of upgrade', () => {
    const msg = formatCapExceededMessage({
      ok: false,
      spentCents: 2500,
      retryAfterMs: 60 * 60 * 1000,
      tier: 'member_paid',
    });
    expect(msg).toContain('AAO team');
    expect(msg).not.toContain('Upgrade');
  });
});

describe('resolveUserTier', () => {
  it('returns anonymous for unauthenticated paths', () => {
    expect(resolveUserTier({ isAnonymous: true })).toBe('anonymous');
  });

  it('returns member_paid for active subscribers', () => {
    expect(resolveUserTier({ hasActiveSubscription: true })).toBe('member_paid');
  });

  it('returns member_free when authenticated but no subscription', () => {
    expect(resolveUserTier({})).toBe('member_free');
    expect(resolveUserTier({ hasActiveSubscription: false })).toBe('member_free');
  });
});
