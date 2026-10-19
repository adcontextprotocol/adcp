/**
 * #8322 — badge issuance resolves the owning organization through the agent's
 * registry identity, not through one spelling of its URL.
 *
 * `runBadgeFanOut` is handed the folded key (`/mcp`) by every caller, while
 * the owner's member profile may hold `/mcp/`. When the org lookup missed,
 * `membershipOrgId` came back undefined and `processAgentBadges` revoked
 * every badge the agent had — the owner lost their verification for a
 * trailing slash. Both assertions here fail if the fold is removed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db/client.js', () => ({
  query: vi.fn(),
}));

import { query } from '../../src/db/client.js';
import { runBadgeFanOut } from '../../src/services/badge-issuance.js';
import type { ComplianceDatabase } from '../../src/db/compliance-db.js';

const queryMock = vi.mocked(query);

/** The folded registry identity key every per-agent surface uses (#7830). */
const FOLDED_URL = 'https://badge-owner.example.com/mcp';
/** What the owner's member profile holds. */
const STORED_SPELLING = 'https://badge-owner.example.com/mcp/';

function makeDb(): ComplianceDatabase {
  const upserts: any[] = [];
  return {
    getRegistryMetadata: vi.fn().mockResolvedValue(null),
    getBadgesForAgent: vi.fn().mockResolvedValue([]),
    getStoryboardStatuses: vi.fn().mockResolvedValue([{
      storyboard_id: 'sales_broadcast_tv',
      status: 'passing',
      steps_passed: 5,
      steps_total: 5,
    }]),
    upsertBadge: vi.fn().mockImplementation((b: any) => {
      upserts.push(b);
      return Promise.resolve({ ...b, status: 'active' });
    }),
    degradeBadge: vi.fn().mockResolvedValue(true),
    revokeBadge: vi.fn().mockResolvedValue(true),
    revokeAllBadges: vi.fn().mockResolvedValue([]),
    revokeAllBadgesIfOptedOut: vi.fn().mockResolvedValue([]),
    _upserts: upserts,
  } as unknown as ComplianceDatabase;
}

/** Every agent URL a JSONB containment payload asked about. */
function containmentUrls(params: unknown): string[] {
  if (!Array.isArray(params)) return [];
  const urls: string[] = [];
  for (const param of params) {
    if (typeof param !== 'string') continue;
    try {
      const parsed = JSON.parse(param);
      if (!Array.isArray(parsed)) continue;
      for (const entry of parsed) {
        if (entry && typeof entry.url === 'string') urls.push(entry.url);
      }
    } catch {
      // Not a JSONB payload (tier / status arrays bind as text[]).
    }
  }
  return urls;
}

describe('badge issuance owner lookup (#8322)', () => {
  beforeEach(() => queryMock.mockReset());

  it('asks for every spelling of the agent identity when resolving the owner org', async () => {
    queryMock.mockResolvedValue({ rows: [], rowCount: 0 } as never);

    await runBadgeFanOut({
      complianceDb: makeDb(),
      agentUrl: FOLDED_URL,
      declaredSpecialisms: ['sales-broadcast-tv'],
      adcpVersions: ['3.0'],
    });

    const orgCall = queryMock.mock.calls.find(([sql]) =>
      typeof sql === 'string' && sql.includes('o.membership_tier'));
    expect(orgCall).toBeDefined();
    expect(containmentUrls(orgCall![1])).toEqual([FOLDED_URL, STORED_SPELLING]);
    // The tier and subscription gating still binds after the fold.
    expect(orgCall![0]).toContain('o.subscription_status = ANY($4::text[])');
  });

  it('issues badges for an owner whose profile holds the trailing-slash spelling', async () => {
    // Postgres answers the containment OR from the stored `/mcp/` row.
    queryMock.mockResolvedValue({
      rows: [{ workos_organization_id: 'org_slash_owner' }],
      rowCount: 1,
    } as never);
    const db = makeDb();

    const result = await runBadgeFanOut({
      complianceDb: db,
      agentUrl: FOLDED_URL,
      declaredSpecialisms: ['sales-broadcast-tv'],
      adcpVersions: ['3.0'],
    });

    expect(result.revoked).toHaveLength(0);
    expect(result.issued.length).toBeGreaterThan(0);
    expect((db as any)._upserts[0].membership_org_id).toBe('org_slash_owner');
  });
});
