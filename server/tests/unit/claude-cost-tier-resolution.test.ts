import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * #2945 follow-up — `resolveUserTierForScopeKey` does a single-row
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
const { resolveUserTierForScopeKey } = await import('../../src/addie/claude-cost-tracker.js');

beforeEach(() => {
  queryMock.mockReset();
});

describe('resolveUserTierForScopeKey', () => {
  it('returns member_free without hitting the DB for non-WorkOS scope keys', async () => {
    // Anything that's not a bare WorkOS id (user_...) can't resolve a
    // subscription at call time — slack:, email:, mcp:, tavus:ip:,
    // anon: all skip the lookup and stay at member_free.
    for (const key of ['slack:U12345', 'email:abc123', 'mcp:sub-1', 'tavus:ip:10.0.0.1', 'anon:hashedip']) {
      const tier = await resolveUserTierForScopeKey(key);
      expect(tier).toBe('member_free');
    }
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('returns member_paid when the WorkOS user has an active, non-canceled subscription', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ exists: 1 }] });
    const tier = await resolveUserTierForScopeKey('user_01H2ABC');
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
    const tier = await resolveUserTierForScopeKey('user_01H2ABC');
    expect(tier).toBe('member_free');
  });

  it('returns member_free when the DB query throws — fail-closed to the conservative tier', async () => {
    // DB outage mid-conversation must not accidentally grant the
    // $25/day ceiling to unverified callers. Fail-closed to
    // member_free means legitimate members briefly see the lower cap
    // during an outage but no-one gets an unearned bump.
    queryMock.mockRejectedValueOnce(new Error('Connection refused'));
    const tier = await resolveUserTierForScopeKey('user_01H2ABC');
    expect(tier).toBe('member_free');
  });
});
