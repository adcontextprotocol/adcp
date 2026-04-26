import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
    // Burn just over the anonymous budget ($3 in current config) with one
    // big Opus charge. Opus input is $15/M-token, so to push past $3 we
    // need >200,000 input tokens (200_000 × 15 = 3,000,000 micros = $3.00).
    // Use 200,001 to land just above the cap.
    const tokensToExceedCap = Math.ceil((DAILY_BUDGET_USD.anonymous * 1_000_000) / 15) + 1;
    await recordCost('u-cap', 'claude-opus-4-7', { input_tokens: tokensToExceedCap, output_tokens: 0 });
    const result = await checkCostCap('u-cap', 'anonymous');
    expect(result.ok).toBe(false);
    expect(result.remainingUsd).toBe(0);
    expect(result.spentCents).toBeGreaterThanOrEqual(DAILY_BUDGET_USD.anonymous * 100);
    expect(result.retryAfterMs).toBeGreaterThan(0);
    expect(result.tier).toBe('anonymous');
  });

  it('tracks users independently', async () => {
    const tokensToExceedCap = Math.ceil((DAILY_BUDGET_USD.anonymous * 1_000_000) / 15) + 1;
    await recordCost('u-heavy', 'claude-opus-4-7', { input_tokens: tokensToExceedCap, output_tokens: 0 });
    expect((await checkCostCap('u-heavy', 'anonymous')).ok).toBe(false);
    expect((await checkCostCap('u-light', 'anonymous')).ok).toBe(true);
  });

  it('applies different budgets per tier — paying members get more headroom', async () => {
    // Burn an amount that exceeds anonymous + member_free but stays under
    // member_paid. member_free is $5, anonymous is $3, member_paid is $25.
    // Sonnet input is $3/M-token; 2_000_000 tokens = $6 — over both lower
    // tiers, well under member_paid.
    await recordCost('u-tier', 'claude-sonnet-4-6', { input_tokens: 2_000_000, output_tokens: 0 });
    expect((await checkCostCap('u-tier', 'anonymous')).ok).toBe(false);
    expect((await checkCostCap('u-tier', 'member_free')).ok).toBe(false);
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

describe('rolling 24h window semantics', () => {
  // Meat of the "rolling daily budget" invariant — charges older than
  // 24h fall out of the sum. Uses fake timers so we can fast-forward
  // through the window without a real DB TTL.
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-22T12:00:00Z'));
    __setCostTrackerStore(__createInMemoryCostStore());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('expires charges older than 24h so the cap resets on their anniversary', async () => {
    // Record a big charge that exhausts the anonymous cap at T0.
    // Opus is $15/M-token input, so 200_001 tokens = just over $3.
    const tokensToExceedCap = Math.ceil((DAILY_BUDGET_USD.anonymous * 1_000_000) / 15) + 1;
    await recordCost('u-roll', 'claude-opus-4-7', { input_tokens: tokensToExceedCap, output_tokens: 0 });
    expect((await checkCostCap('u-roll', 'anonymous')).ok).toBe(false);

    // At T+23h the charge is still in-window — still blocked.
    vi.advanceTimersByTime(23 * 60 * 60 * 1000);
    expect((await checkCostCap('u-roll', 'anonymous')).ok).toBe(false);

    // At T+24h+1ms the original charge has aged out. The cap has
    // fresh headroom and the user is allowed again.
    vi.advanceTimersByTime(60 * 60 * 1000 + 1);
    const result = await checkCostCap('u-roll', 'anonymous');
    expect(result.ok).toBe(true);
    expect(result.spentCents).toBe(0);
  });

  it('retryAfterMs counts down as individual charges age out (not fixed to a daily boundary)', async () => {
    // Three separate charges 30 min apart. When the cap trips on
    // the third, `retryAfterMs` reflects the OLDEST charge's
    // remaining time — not a fixed midnight or similar boundary.
    // Each charge ~$1 (a third of the anonymous cap), so all three
    // together push past $3.
    const perChargeTokens = Math.ceil((DAILY_BUDGET_USD.anonymous * 1_000_000) / 15 / 3) + 1;
    await recordCost('u-slide', 'claude-opus-4-7', { input_tokens: perChargeTokens, output_tokens: 0 });
    vi.advanceTimersByTime(30 * 60 * 1000);
    await recordCost('u-slide', 'claude-opus-4-7', { input_tokens: perChargeTokens, output_tokens: 0 });
    vi.advanceTimersByTime(30 * 60 * 1000);
    await recordCost('u-slide', 'claude-opus-4-7', { input_tokens: perChargeTokens, output_tokens: 0 });

    const result = await checkCostCap('u-slide', 'anonymous');
    expect(result.ok).toBe(false);
    // Oldest charge is ~60 min old → retry in ~23h.
    const retryHours = (result.retryAfterMs ?? 0) / 3_600_000;
    expect(retryHours).toBeGreaterThan(22.9);
    expect(retryHours).toBeLessThan(23.1);
  });
});

describe('scope-key shape independence', () => {
  // Different identity schemes (WorkOS user IDs, Slack namespaced,
  // anonymous IP-hashed) must key independently — charging one
  // shouldn't exhaust another's budget.
  beforeEach(() => __setCostTrackerStore(__createInMemoryCostStore()));

  it('keys Slack, WorkOS, and anonymous scopes as distinct users', async () => {
    // Burn a WorkOS-style user's budget. Need >cap × $1M-tokens / $15-per-M
    // to exceed the anonymous cap with one Opus charge.
    const tokensToExceedCap = Math.ceil((DAILY_BUDGET_USD.anonymous * 1_000_000) / 15) + 1;
    await recordCost('user_01H9ABCDEFG', 'claude-opus-4-7', { input_tokens: tokensToExceedCap, output_tokens: 0 });
    expect((await checkCostCap('user_01H9ABCDEFG', 'anonymous')).ok).toBe(false);

    // A Slack-namespaced caller on the same underlying Slack user
    // is a separate key — their budget is untouched.
    expect((await checkCostCap('slack:U07ABCDEF', 'anonymous')).ok).toBe(true);

    // Anonymous IP-hashed scope is its own key too.
    expect((await checkCostCap('anon:abc123hash', 'anonymous')).ok).toBe(true);
  });

  it('keeps system users exempt even when a non-system caller with the same prefix is blocked', async () => {
    // A would-be spoofer that happens to have a `system:` prefix
    // but isn't on the literal allowlist gets limited like anyone
    // else (matches the tool-rate-limiter's literal-allowlist rule).
    const tokensToExceedCap = Math.ceil((DAILY_BUDGET_USD.anonymous * 1_000_000) / 15) + 1;
    await recordCost('system:fake', 'claude-opus-4-7', { input_tokens: tokensToExceedCap, output_tokens: 0 });
    expect((await checkCostCap('system:fake', 'anonymous')).ok).toBe(false);

    // The real system user is still exempt and runs uncapped.
    for (let i = 0; i < 100; i++) {
      expect((await checkCostCap('system:addie', 'anonymous')).ok).toBe(true);
    }
  });
});

describe('guards against bad usage inputs (claude-pricing)', () => {
  // costUsdMicros is the pricing helper, but its guards matter here
  // because a malformed upstream `usage` shouldn't poison the
  // per-user running total or disable the cap for everyone else.
  beforeEach(() => __setCostTrackerStore(__createInMemoryCostStore()));

  it('records zero for a NaN/negative/Infinity usage field rather than poisoning the total', async () => {
    await recordCost('u-bad', 'claude-sonnet-4-6', {
      input_tokens: Number.NaN,
      output_tokens: -100,
      cache_read_input_tokens: Infinity,
    });
    const result = await checkCostCap('u-bad', 'member_paid');
    expect(result.ok).toBe(true);
    expect(result.spentCents).toBe(0);
  });
});
