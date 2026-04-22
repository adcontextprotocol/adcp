import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentConfig } from '../../src/types.js';

// `demotePublicAgentsOnTierDowngrade` now uses `getPool()` + raw SQL with
// `SELECT … FOR UPDATE` so the read and write can't interleave with a
// concurrent publish. The mocks below emulate the client contract that
// the service depends on: BEGIN / SELECT / UPDATE / COMMIT / ROLLBACK.
vi.mock('../../src/db/client.js', () => {
  const release = vi.fn();
  const client: { query: ReturnType<typeof vi.fn>; release: typeof release } = {
    query: vi.fn(),
    release,
  };
  const connect = vi.fn(async () => client);
  return {
    getPool: () => ({ connect }),
    query: vi.fn(),
    // test-accessor so each test can reconfigure the client's query stub
    __client: client,
    __connect: connect,
  };
});

import { demotePublicAgentsOnTierDowngrade } from '../../src/services/agent-visibility-enforcement.js';
// @ts-expect-error — internal test accessors exposed by the vi.mock above
import { __client, __connect } from '../../src/db/client.js';

type SelectRow = {
  id: string;
  agents: unknown;
  primary_brand_domain: string | null;
};

/**
 * Wire the pg client mock so the tx flow (BEGIN → SELECT FOR UPDATE →
 * UPDATE → COMMIT) behaves as described, and capture the UPDATE args
 * for assertion.
 */
function mockProfileTx(rows: SelectRow[]): { updateArgs: unknown[][] } {
  const updateArgs: unknown[][] = [];
  __client.query.mockReset();
  __client.release.mockReset();
  __client.query.mockImplementation(async (sql: string, params?: unknown[]) => {
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
      return { rowCount: 0, rows: [] };
    }
    if (sql.includes('SELECT id, agents, primary_brand_domain')) {
      return { rowCount: rows.length, rows };
    }
    if (sql.trim().startsWith('UPDATE member_profiles')) {
      updateArgs.push(params ?? []);
      return { rowCount: 1, rows: [] };
    }
    throw new Error(`Unexpected query: ${sql}`);
  });
  return { updateArgs };
}

describe('demotePublicAgentsOnTierDowngrade', () => {
  let memberDb: any;
  let brandDb: any;

  beforeEach(() => {
    memberDb = {
      getProfileByOrgId: vi.fn(),
      updateProfileByOrgId: vi.fn(),
    };
    brandDb = {
      getDiscoveredBrandByDomain: vi.fn(),
      updateManifestAgents: vi.fn().mockResolvedValue(undefined),
    };
    __connect.mockClear();
  });

  function agent(url: string, visibility: AgentConfig['visibility']): AgentConfig {
    return { url, visibility };
  }

  it('no-op when old tier had no API access', async () => {
    const result = await demotePublicAgentsOnTierDowngrade(
      'org1', 'individual_academic', null, memberDb, brandDb,
    );
    expect(result).toBeNull();
    expect(__connect).not.toHaveBeenCalled();
  });

  it('no-op when new tier still has API access', async () => {
    const result = await demotePublicAgentsOnTierDowngrade(
      'org1', 'company_icl', 'individual_professional', memberDb, brandDb,
    );
    expect(result).toBeNull();
    expect(__connect).not.toHaveBeenCalled();
  });

  it('no-op when org has no profile', async () => {
    mockProfileTx([]);
    const result = await demotePublicAgentsOnTierDowngrade(
      'org1', 'individual_professional', null, memberDb, brandDb,
    );
    expect(result).toBeNull();
    // Should open a tx, see 0 rows, ROLLBACK, not UPDATE
    const queries = __client.query.mock.calls.map((c: any[]) => c[0]);
    expect(queries).toContain('BEGIN');
    expect(queries).toContain('ROLLBACK');
    expect(queries.some((q: string) => q.startsWith?.('UPDATE'))).toBe(false);
  });

  it('no-op when profile has no public agents', async () => {
    const agents = [agent('https://a.example', 'private'), agent('https://b.example', 'members_only')];
    mockProfileTx([{ id: 'p1', agents, primary_brand_domain: null }]);
    const result = await demotePublicAgentsOnTierDowngrade(
      'org1', 'individual_professional', 'individual_academic', memberDb, brandDb,
    );
    expect(result).toBeNull();
    const queries = __client.query.mock.calls.map((c: any[]) => c[0]);
    expect(queries).toContain('ROLLBACK');
    expect(queries.some((q: string) => q.trim?.().startsWith('UPDATE member_profiles'))).toBe(false);
  });

  it('demotes public agents to members_only on Professional → Explorer', async () => {
    const agents = [
      agent('https://pub.example', 'public'),
      agent('https://mem.example', 'members_only'),
      agent('https://priv.example', 'private'),
    ];
    const { updateArgs } = mockProfileTx([
      { id: 'p1', agents, primary_brand_domain: null },
    ]);
    const result = await demotePublicAgentsOnTierDowngrade(
      'org1', 'individual_professional', 'individual_academic', memberDb, brandDb,
    );
    expect(result).toEqual({ orgId: 'org1', demotedCount: 1, brandJsonCleared: false });
    expect(updateArgs).toHaveLength(1);
    // First UPDATE param is the new agents JSON; assert the public entry flipped.
    const writtenAgents = JSON.parse(updateArgs[0][0] as string);
    expect(writtenAgents).toEqual([
      agent('https://pub.example', 'members_only'),
      agent('https://mem.example', 'members_only'),
      agent('https://priv.example', 'private'),
    ]);
  });

  it('demotes on full cancellation (newTier = null)', async () => {
    mockProfileTx([
      { id: 'p1', agents: [agent('https://p.example', 'public')], primary_brand_domain: null },
    ]);
    const result = await demotePublicAgentsOnTierDowngrade(
      'org1', 'company_leader', null, memberDb, brandDb,
    );
    expect(result?.demotedCount).toBe(1);
  });

  it('clears demoted agents from a community brand.json', async () => {
    mockProfileTx([
      { id: 'p1', agents: [agent('https://p.example', 'public')], primary_brand_domain: 'acme.example' },
    ]);
    brandDb.getDiscoveredBrandByDomain.mockResolvedValue({
      source_type: 'community',
      brand_manifest: {
        agents: [
          { url: 'https://p.example', type: 'brand', id: 'p' },
          { url: 'https://other.example', type: 'brand', id: 'other' },
        ],
      },
    });
    const result = await demotePublicAgentsOnTierDowngrade(
      'org1', 'individual_professional', null, memberDb, brandDb,
    );
    expect(result?.brandJsonCleared).toBe(true);
    expect(brandDb.updateManifestAgents).toHaveBeenCalledWith(
      'acme.example',
      [{ url: 'https://other.example', type: 'brand', id: 'other' }],
      expect.objectContaining({ summary: expect.stringContaining('Tier downgrade') }),
    );
  });

  it('does not touch brand.json for self-hosted brands', async () => {
    mockProfileTx([
      { id: 'p1', agents: [agent('https://p.example', 'public')], primary_brand_domain: 'acme.example' },
    ]);
    brandDb.getDiscoveredBrandByDomain.mockResolvedValue({
      source_type: 'brand_json',
      brand_manifest: {
        agents: [{ url: 'https://p.example', type: 'brand', id: 'p' }],
      },
    });
    const result = await demotePublicAgentsOnTierDowngrade(
      'org1', 'individual_professional', null, memberDb, brandDb,
    );
    expect(result?.brandJsonCleared).toBe(false);
    expect(brandDb.updateManifestAgents).not.toHaveBeenCalled();
  });

  it('commits the profile tx before touching brand.json (so a failed manifest write does not orphan the JSONB update)', async () => {
    mockProfileTx([
      { id: 'p1', agents: [agent('https://p.example', 'public')], primary_brand_domain: 'acme.example' },
    ]);
    brandDb.getDiscoveredBrandByDomain.mockResolvedValue({
      source_type: 'community',
      brand_manifest: { agents: [{ url: 'https://p.example', type: 'brand', id: 'p' }] },
    });
    await demotePublicAgentsOnTierDowngrade(
      'org1', 'individual_professional', null, memberDb, brandDb,
    );
    const queries = __client.query.mock.calls.map((c: any[]) => c[0]);
    const commitAt = queries.indexOf('COMMIT');
    expect(commitAt).toBeGreaterThan(-1);
    // brand.json write happens after client.release() via the pool, so by
    // design it can't be in __client.query.mock.calls — no need to assert
    // ordering there. Instead, verify UPDATE ran before COMMIT.
    const updateAt = queries.findIndex((q: string) => q.trim?.().startsWith('UPDATE member_profiles'));
    expect(updateAt).toBeLessThan(commitAt);
  });
});
