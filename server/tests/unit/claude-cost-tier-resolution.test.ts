import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * #2945 follow-up — `resolveUserTierFromDb` does a single-row
 * probe to the DB to decide whether a bare WorkOS id should get the
 * `member_paid` ($25/day) ceiling or stay at `member_free` ($5). The
 * DB query is mocked per test so we can drive each branch without a
 * Postgres connection.
 */

const queryMock = vi.fn();
vi.mock('../../src/db/client.js', () => ({
  query: (...args: unknown[]) => queryMock(...args),
  getPool: () => ({ query: queryMock }),
}));

// Import after the mock is installed so the module picks up the mocked
// `query` reference instead of the real db/client.
const { resolveUserTierFromDb, buildSlackCostScope, __clearTierCache } =
  await import('../../src/addie/claude-cost-tracker.js');

beforeEach(() => {
  queryMock.mockReset();
  // The helper memoizes results for 60s per userId. Clear between
  // tests so cached values from an earlier case don't leak into the
  // next one's expectations.
  __clearTierCache();
});

describe('resolveUserTierFromDb', () => {
  it('returns member_free without hitting the DB for non-WorkOS scope keys', async () => {
    // Anything that's not a bare WorkOS id (user_...) can't resolve a
    // subscription at call time — slack:, email:, mcp:, tavus:ip:,
    // anon: all skip the lookup and stay at member_free.
    for (const key of ['slack:U12345', 'email:abc123', 'mcp:sub-1', 'tavus:ip:10.0.0.1', 'anon:hashedip']) {
      const tier = await resolveUserTierFromDb(key);
      expect(tier).toBe('member_free');
    }
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('returns member_free without throwing when given null / undefined / empty string', async () => {
    // Signature is `string | null | undefined` — call sites use `??`
    // fallbacks so nullish never reaches here in practice, but the
    // exported helper must not TypeError on a stray null (a regression
    // would silently default everyone to member_free without logging).
    expect(await resolveUserTierFromDb(null)).toBe('member_free');
    expect(await resolveUserTierFromDb(undefined)).toBe('member_free');
    expect(await resolveUserTierFromDb('')).toBe('member_free');
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('returns member_paid when the WorkOS user has an active, non-canceled subscription', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ exists: 1 }] });
    const tier = await resolveUserTierFromDb('user_01H2ABC');
    expect(tier).toBe('member_paid');
    expect(queryMock).toHaveBeenCalledOnce();
    // The probe must filter on both active status AND not-canceled —
    // otherwise a canceled org would still read as paid until grace
    // period ends.
    const sql = queryMock.mock.calls[0][0] as string;
    expect(sql).toContain("subscription_status = 'active'");
    expect(sql).toContain('subscription_canceled_at IS NULL');
  });

  it('returns member_free when the WorkOS user has no active subscription (empty rows)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    const tier = await resolveUserTierFromDb('user_01H2ABC');
    expect(tier).toBe('member_free');
  });

  it('returns member_free when the DB query throws — fail-closed to the conservative tier', async () => {
    // DB outage mid-conversation must not accidentally grant the
    // $25/day ceiling to unverified callers. Fail-closed to
    // member_free means legitimate members briefly see the lower cap
    // during an outage but no-one gets an unearned bump.
    queryMock.mockRejectedValueOnce(new Error('Connection refused'));
    const tier = await resolveUserTierFromDb('user_01H2ABC');
    expect(tier).toBe('member_free');
  });

  it('memoizes results so repeated probes for the same user hit the DB once', async () => {
    // 60s in-process cache. A chat burst should not produce N DB
    // probes for the same user — one probe, cached tier, replayed.
    queryMock.mockResolvedValueOnce({ rows: [{ exists: 1 }] });
    expect(await resolveUserTierFromDb('user_01H2ABC')).toBe('member_paid');
    expect(await resolveUserTierFromDb('user_01H2ABC')).toBe('member_paid');
    expect(await resolveUserTierFromDb('user_01H2ABC')).toBe('member_paid');
    expect(queryMock).toHaveBeenCalledOnce();
  });

  it('does NOT cache error paths — next call retries the DB', async () => {
    // Transient DB failures shouldn't lock a paying member out of
    // member_paid for a full 60s. The first call fails → returns
    // member_free without caching; the second call retries.
    queryMock.mockRejectedValueOnce(new Error('Connection refused'));
    queryMock.mockResolvedValueOnce({ rows: [{ exists: 1 }] });
    expect(await resolveUserTierFromDb('user_01H2ABC')).toBe('member_free');
    expect(await resolveUserTierFromDb('user_01H2ABC')).toBe('member_paid');
    expect(queryMock).toHaveBeenCalledTimes(2);
  });

  it('memoizes per-user, not globally — different users get independent probes', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ exists: 1 }] });
    queryMock.mockResolvedValueOnce({ rows: [] });
    expect(await resolveUserTierFromDb('user_alice')).toBe('member_paid');
    expect(await resolveUserTierFromDb('user_bob')).toBe('member_free');
    expect(queryMock).toHaveBeenCalledTimes(2);
    // Second round: both cached, no further probes.
    expect(await resolveUserTierFromDb('user_alice')).toBe('member_paid');
    expect(await resolveUserTierFromDb('user_bob')).toBe('member_free');
    expect(queryMock).toHaveBeenCalledTimes(2);
  });
});

describe('buildSlackCostScope', () => {
  it('prefers the mapped WorkOS user id when memberContext carries one', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ exists: 1 }] });
    const scope = await buildSlackCostScope(
      { workos_user: { workos_user_id: 'user_01H2ABC' } },
      'U_slack',
    );
    expect(scope).toEqual({ userId: 'user_01H2ABC', tier: 'member_paid' });
  });

  it('falls back to slack:<id> at member_free when no WorkOS mapping exists', async () => {
    const scope = await buildSlackCostScope(null, 'U_unmapped');
    expect(scope).toEqual({ userId: 'slack:U_unmapped', tier: 'member_free' });
    // No DB probe — slack: scope keys skip the lookup.
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('falls back to slack:<id> when memberContext exists but workos_user is absent', async () => {
    // MemberContext.workos_user is optional — matches the case where
    // the caller found a memberContext but the Slack user isn't
    // mapped to a WorkOS identity yet.
    const scope = await buildSlackCostScope({ workos_user: undefined }, 'U_pending');
    expect(scope).toEqual({ userId: 'slack:U_pending', tier: 'member_free' });
  });
});
