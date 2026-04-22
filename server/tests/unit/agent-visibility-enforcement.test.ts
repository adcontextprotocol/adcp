import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentConfig } from '../../src/types.js';

/**
 * `demotePublicAgentsOnTierDowngrade` uses `getPool()` + raw SQL with
 * `SELECT … FOR UPDATE` so the read and write can't interleave with a
 * concurrent publish. The mocks below emulate the client contract that
 * the service depends on: BEGIN / SELECT / UPDATE / COMMIT / ROLLBACK.
 */
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

type RecordedQuery = { sql: string; params: unknown[] };

/**
 * Wire the pg client mock so the tx flow (BEGIN → SELECT FOR UPDATE →
 * UPDATE → COMMIT) behaves as described. Records all queries so tests
 * can assert the exact SQL + params, not just that *some* UPDATE ran.
 */
function mockProfileTx(rows: SelectRow[]): { recorded: RecordedQuery[]; updateArgs: unknown[][] } {
  const recorded: RecordedQuery[] = [];
  const updateArgs: unknown[][] = [];
  __client.query.mockReset();
  __client.release.mockReset();
  __client.query.mockImplementation(async (sql: string, params?: unknown[]) => {
    recorded.push({ sql, params: params ?? [] });
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
  return { recorded, updateArgs };
}

describe('demotePublicAgentsOnTierDowngrade', () => {
  let brandDb: any;

  beforeEach(() => {
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
      'org1', 'individual_academic', null, brandDb,
    );
    expect(result).toBeNull();
    expect(__connect).not.toHaveBeenCalled();
  });

  it('no-op when new tier still has API access', async () => {
    const result = await demotePublicAgentsOnTierDowngrade(
      'org1', 'company_icl', 'individual_professional', brandDb,
    );
    expect(result).toBeNull();
    expect(__connect).not.toHaveBeenCalled();
  });

  it('locks the profile row with SELECT FOR UPDATE on the supplied orgId', async () => {
    // Mechanism test — regressions that drop FOR UPDATE or pass the
    // wrong org param are the exact thing this PR's transactional
    // rewrite is meant to prevent.
    const { recorded } = mockProfileTx([
      { id: 'p1', agents: [agent('https://a', 'public')], primary_brand_domain: null },
    ]);
    await demotePublicAgentsOnTierDowngrade('org-target', 'individual_professional', null, brandDb);
    const selectProfile = recorded.find(r => r.sql.includes('SELECT id, agents, primary_brand_domain'));
    expect(selectProfile, 'should issue a SELECT for the profile row').toBeTruthy();
    expect(selectProfile!.sql).toMatch(/FOR UPDATE/);
    expect(selectProfile!.params[0]).toBe('org-target');
  });

  it('no-op when org has no profile', async () => {
    const { recorded } = mockProfileTx([]);
    const result = await demotePublicAgentsOnTierDowngrade(
      'org1', 'individual_professional', null, brandDb,
    );
    expect(result).toBeNull();
    const sqls = recorded.map(r => r.sql);
    expect(sqls).toContain('BEGIN');
    expect(sqls).toContain('ROLLBACK');
    expect(sqls.some(q => q.trim().startsWith('UPDATE'))).toBe(false);
  });

  it('no-op when profile has no public agents', async () => {
    const agents = [agent('https://a.example', 'private'), agent('https://b.example', 'members_only')];
    const { recorded } = mockProfileTx([{ id: 'p1', agents, primary_brand_domain: null }]);
    const result = await demotePublicAgentsOnTierDowngrade(
      'org1', 'individual_professional', 'individual_academic', brandDb,
    );
    expect(result).toBeNull();
    const sqls = recorded.map(r => r.sql);
    expect(sqls).toContain('ROLLBACK');
    expect(sqls.some(q => q.trim().startsWith('UPDATE member_profiles'))).toBe(false);
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
      'org1', 'individual_professional', 'individual_academic', brandDb,
    );
    expect(result).toEqual({ orgId: 'org1', demotedCount: 1, brandJsonCleared: false });
    expect(updateArgs).toHaveLength(1);
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
      'org1', 'company_leader', null, brandDb,
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
      'org1', 'individual_professional', null, brandDb,
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
      'org1', 'individual_professional', null, brandDb,
    );
    expect(result?.brandJsonCleared).toBe(false);
    expect(brandDb.updateManifestAgents).not.toHaveBeenCalled();
  });

  it('commits the profile tx before touching brand.json (so a failed manifest write does not orphan the JSONB update)', async () => {
    const { recorded } = mockProfileTx([
      { id: 'p1', agents: [agent('https://p.example', 'public')], primary_brand_domain: 'acme.example' },
    ]);
    brandDb.getDiscoveredBrandByDomain.mockResolvedValue({
      source_type: 'community',
      brand_manifest: { agents: [{ url: 'https://p.example', type: 'brand', id: 'p' }] },
    });
    await demotePublicAgentsOnTierDowngrade(
      'org1', 'individual_professional', null, brandDb,
    );
    const sqls = recorded.map(r => r.sql);
    const commitAt = sqls.indexOf('COMMIT');
    expect(commitAt).toBeGreaterThan(-1);
    const updateAt = sqls.findIndex(q => q.trim().startsWith('UPDATE member_profiles'));
    expect(updateAt).toBeLessThan(commitAt);
  });
});
