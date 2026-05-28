import { describe, it, expect, vi, beforeEach } from 'vitest';

// query() is used to resolve the membership org; mock it before importing
// the unit under test so the import-time singleton doesn't open a real pool.
vi.mock('../../src/db/client.js', () => ({
  query: vi.fn(),
}));

import { query } from '../../src/db/client.js';
import { runBadgeFanOut } from '../../src/services/badge-issuance.js';
import { SUPPORTED_BADGE_VERSIONS } from '../../src/services/adcp-taxonomy.js';
import type {
  AgentVerificationBadge,
  BadgeRole,
  ComplianceDatabase,
  StoryboardStatus,
} from '../../src/db/compliance-db.js';

const queryMock = vi.mocked(query);

function badge(role: BadgeRole, status: AgentVerificationBadge['status'] = 'active', adcpVersion = '3.0'): AgentVerificationBadge {
  return {
    agent_url: 'https://example.com/mcp',
    role,
    adcp_version: adcpVersion,
    verified_at: new Date(Date.now() - 86_400_000),
    verified_protocol_version: null,
    verified_specialisms: ['sales-broadcast-tv'],
    verification_modes: ['spec'],
    verification_token: null,
    token_expires_at: null,
    membership_org_id: 'org_test',
    status,
    revoked_at: null,
    revocation_reason: null,
    created_at: new Date(),
    updated_at: new Date(),
  };
}

function status(id: string, s: StoryboardStatus) {
  return { storyboard_id: id, status: s, last_tested_at: new Date(), last_passed_at: s === 'passing' ? new Date() : null, last_failed_at: s === 'passing' ? null : new Date(), steps_passed: s === 'passing' ? 5 : 0, steps_total: 5, triggered_by: 'owner_test' };
}

function makeDb(opts: {
  existingBadges?: AgentVerificationBadge[];
  latestStatuses?: ReturnType<typeof status>[];
}): ComplianceDatabase {
  const upserts: any[] = [];
  const degrades: any[] = [];
  const revokes: any[] = [];
  return {
    getBadgesForAgent: vi.fn().mockResolvedValue(opts.existingBadges ?? []),
    getStoryboardStatuses: vi.fn().mockResolvedValue(opts.latestStatuses ?? []),
    upsertBadge: vi.fn().mockImplementation((b: any) => { upserts.push(b); return Promise.resolve({ ...badge(b.role), ...b }); }),
    degradeBadge: vi.fn().mockImplementation((...args: any[]) => { degrades.push(args); return Promise.resolve(undefined); }),
    revokeBadge: vi.fn().mockImplementation((...args: any[]) => { revokes.push(args); return Promise.resolve(undefined); }),
    _upserts: upserts,
    _degrades: degrades,
    _revokes: revokes,
  } as unknown as ComplianceDatabase;
}

describe('runBadgeFanOut', () => {
  beforeEach(() => queryMock.mockReset());

  it('no-ops when the agent declared no specialisms', async () => {
    const db = makeDb({});
    const result = await runBadgeFanOut({
      complianceDb: db,
      agentUrl: 'https://example.com/mcp',
      declaredSpecialisms: [],
    });
    expect(result.issued).toHaveLength(0);
    expect(result.revoked).toHaveLength(0);
    expect(db.getStoryboardStatuses).not.toHaveBeenCalled();
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('reads ALL latest storyboard statuses from the canonical table — not just what one partial run touched', async () => {
    // Agent declared two specialisms across two roles. The OTHER storyboard
    // is still passing on disk; this run only retested the broadcast-tv
    // storyboard. We must read the full set so we don't degrade the
    // creative-ad-server badge as a side effect.
    queryMock.mockResolvedValueOnce({ rows: [{ workos_organization_id: 'org_member' }], rowCount: 1, command: 'SELECT', oid: 0, fields: [] } as never);

    const db = makeDb({
      latestStatuses: [
        status('sales_broadcast_tv', 'passing'),
        status('creative_ad_server', 'passing'),
      ],
    });

    await runBadgeFanOut({
      complianceDb: db,
      agentUrl: 'https://example.com/mcp',
      declaredSpecialisms: ['sales-broadcast-tv', 'creative-ad-server'],
    });

    expect(db.getStoryboardStatuses).toHaveBeenCalledWith('https://example.com/mcp');
    // Both roles should be issued at every public badge version — no revoke
    // of the role we didn't retest.
    expect(db.upsertBadge).toHaveBeenCalledTimes(2 * SUPPORTED_BADGE_VERSIONS.length);
    expect(db.revokeBadge).not.toHaveBeenCalled();
  });

  it('scopes storyboard reads to runId when full-suite callers provide one', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ workos_organization_id: 'org_member' }], rowCount: 1, command: 'SELECT', oid: 0, fields: [] } as never);

    const db = makeDb({
      latestStatuses: [status('sales_broadcast_tv', 'passing')],
    });

    await runBadgeFanOut({
      complianceDb: db,
      agentUrl: 'https://example.com/mcp',
      declaredSpecialisms: ['sales-broadcast-tv'],
      runId: 'run-full-suite',
    });

    expect(db.getStoryboardStatuses).toHaveBeenCalledWith('https://example.com/mcp', { runId: 'run-full-suite' });
  });

  it('passes undefined membershipOrgId when the org lookup returns no row, causing all badges to revoke', async () => {
    queryMock.mockResolvedValueOnce({ rows: [], rowCount: 0, command: 'SELECT', oid: 0, fields: [] } as never);

    const db = makeDb({
      existingBadges: [badge('media-buy')],
      latestStatuses: [status('sales_broadcast_tv', 'passing')],
    });

    const result = await runBadgeFanOut({
      complianceDb: db,
      agentUrl: 'https://example.com/mcp',
      declaredSpecialisms: ['sales-broadcast-tv'],
    });

    expect(result.revoked).toHaveLength(1);
    expect(result.revoked[0].reason).toBe('Membership lapsed');
  });

  it('aggregates results across supported AdCP versions', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ workos_organization_id: 'org_member' }], rowCount: 1, command: 'SELECT', oid: 0, fields: [] } as never);

    const db = makeDb({
      latestStatuses: [status('sales_broadcast_tv', 'passing')],
    });

    const result = await runBadgeFanOut({
      complianceDb: db,
      agentUrl: 'https://example.com/mcp',
      declaredSpecialisms: ['sales-broadcast-tv'],
    });

    expect(result.issued.map(i => i.adcp_version)).toEqual([...SUPPORTED_BADGE_VERSIONS]);
    expect((db.upsertBadge as ReturnType<typeof vi.fn>).mock.calls.map(call => call[0].adcp_version))
      .toEqual([...SUPPORTED_BADGE_VERSIONS]);
  });
});
