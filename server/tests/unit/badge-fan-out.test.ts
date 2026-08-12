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
  optedOut?: boolean;
  requalificationRequired?: boolean;
}): ComplianceDatabase {
  const upserts: any[] = [];
  const degrades: any[] = [];
  const revokes: any[] = [];
  return {
    getRegistryMetadata: vi.fn().mockResolvedValue(
      opts.optedOut || opts.requalificationRequired
        ? {
            compliance_opt_out: opts.optedOut ?? false,
            badge_requalification_required: opts.requalificationRequired ?? false,
            badge_requalification_generation: '7',
          }
        : null,
    ),
    getBadgesForAgent: vi.fn().mockResolvedValue(opts.existingBadges ?? []),
    getStoryboardStatuses: vi.fn().mockResolvedValue(opts.latestStatuses ?? []),
    upsertBadge: vi.fn().mockImplementation((b: any) => { upserts.push(b); return Promise.resolve({ ...badge(b.role), ...b }); }),
    degradeBadge: vi.fn().mockImplementation((...args: any[]) => { degrades.push(args); return Promise.resolve(true); }),
    revokeBadge: vi.fn().mockImplementation((...args: any[]) => { revokes.push(args); return Promise.resolve(true); }),
    revokeAllBadges: vi.fn().mockResolvedValue(
      (opts.existingBadges ?? []).map(({ role, adcp_version }) => ({ role, adcp_version })),
    ),
    revokeAllBadgesIfOptedOut: vi.fn().mockResolvedValue(
      (opts.existingBadges ?? []).map(({ role, adcp_version }) => ({ role, adcp_version })),
    ),
    prepareBadgeRequalification: vi.fn().mockResolvedValue('8'),
    completeBadgeRequalification: vi.fn().mockResolvedValue(true),
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

  it('revokes every active badge and blocks issuance while compliance is opted out', async () => {
    const db = makeDb({
      optedOut: true,
      existingBadges: [
        badge('media-buy', 'active', '3.0'),
        badge('creative', 'degraded', '3.1'),
      ],
      latestStatuses: [status('sales_broadcast_tv', 'passing')],
    });

    const result = await runBadgeFanOut({
      complianceDb: db,
      agentUrl: 'https://example.com/mcp',
      declaredSpecialisms: ['sales-broadcast-tv'],
      adcpVersions: ['3.0', '3.1'],
    });

    expect(db.revokeAllBadgesIfOptedOut).toHaveBeenCalledWith(
      'https://example.com/mcp',
      'Compliance monitoring opted out',
    );
    expect(result.revoked).toEqual([
      { role: 'media-buy', adcp_version: '3.0', reason: 'Compliance monitoring opted out' },
      { role: 'creative', adcp_version: '3.1', reason: 'Compliance monitoring opted out' },
    ]);
    expect(db.upsertBadge).not.toHaveBeenCalled();
    expect(db.getStoryboardStatuses).not.toHaveBeenCalled();
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('blocks partial storyboard fan-out after re-enable until a full-suite run completes', async () => {
    const db = makeDb({
      requalificationRequired: true,
      latestStatuses: [status('sales_broadcast_tv', 'passing')],
    });

    const result = await runBadgeFanOut({
      complianceDb: db,
      agentUrl: 'https://example.com/mcp',
      declaredSpecialisms: ['sales-broadcast-tv'],
    });

    expect(result).toEqual({ issued: [], revoked: [], degraded: [], unchanged: [] });
    expect(db.getStoryboardStatuses).not.toHaveBeenCalled();
    expect(db.upsertBadge).not.toHaveBeenCalled();
    expect(db.completeBadgeRequalification).not.toHaveBeenCalled();
  });

  it('opens the requalification gate only after fresh full-suite badge processing succeeds', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ workos_organization_id: 'org_member' }], rowCount: 1, command: 'SELECT', oid: 0, fields: [] } as never);
    const db = makeDb({
      requalificationRequired: true,
      latestStatuses: [status('sales_broadcast_tv', 'passing')],
    });

    await runBadgeFanOut({
      complianceDb: db,
      agentUrl: 'https://example.com/mcp',
      declaredSpecialisms: ['sales-broadcast-tv'],
      runId: 'fresh-full-suite',
    });

    expect(db.getStoryboardStatuses).toHaveBeenCalledWith(
      'https://example.com/mcp',
      { runId: 'fresh-full-suite' },
    );
    expect(db.upsertBadge).toHaveBeenCalled();
    expect(db.prepareBadgeRequalification).toHaveBeenCalledWith('https://example.com/mcp', '7');
    expect(db.completeBadgeRequalification).toHaveBeenCalledWith('https://example.com/mcp', '8');
  });

  it('keeps the gate closed when a fresh full-suite run earns no badge', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ workos_organization_id: 'org_member' }], rowCount: 1, command: 'SELECT', oid: 0, fields: [] } as never);
    const db = makeDb({
      requalificationRequired: true,
      latestStatuses: [status('sales_broadcast_tv', 'failing')],
    });

    await runBadgeFanOut({
      complianceDb: db,
      agentUrl: 'https://example.com/mcp',
      declaredSpecialisms: ['sales-broadcast-tv'],
      runId: 'fresh-failing-full-suite',
    });

    expect(db.upsertBadge).not.toHaveBeenCalled();
    expect(db.completeBadgeRequalification).not.toHaveBeenCalled();
  });

  it('keeps the gate closed when the full-suite run has no eligible membership', async () => {
    queryMock.mockResolvedValueOnce({ rows: [], rowCount: 0, command: 'SELECT', oid: 0, fields: [] } as never);
    const db = makeDb({
      requalificationRequired: true,
      latestStatuses: [status('sales_broadcast_tv', 'passing')],
    });

    await runBadgeFanOut({
      complianceDb: db,
      agentUrl: 'https://example.com/mcp',
      declaredSpecialisms: ['sales-broadcast-tv'],
      runId: 'fresh-full-suite-without-membership',
    });

    expect(db.completeBadgeRequalification).not.toHaveBeenCalled();
  });

  it('abandons a stale full-suite run when a newer transition supersedes its generation', async () => {
    const db = makeDb({ requalificationRequired: true });
    vi.mocked(db.prepareBadgeRequalification).mockResolvedValue(null);

    await runBadgeFanOut({
      complianceDb: db,
      agentUrl: 'https://example.com/mcp',
      declaredSpecialisms: ['sales-broadcast-tv'],
      runId: 'stale-full-suite',
    });

    expect(db.upsertBadge).not.toHaveBeenCalled();
    expect(db.completeBadgeRequalification).not.toHaveBeenCalled();
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('no-ops when the selected compliance target has no public badge version', async () => {
    const db = makeDb({});
    const result = await runBadgeFanOut({
      complianceDb: db,
      agentUrl: 'https://example.com/mcp',
      declaredSpecialisms: ['sales-broadcast-tv'],
      adcpVersions: [],
    });
    expect(result.issued).toHaveLength(0);
    expect(result.revoked).toHaveLength(0);
    expect(db.getStoryboardStatuses).not.toHaveBeenCalled();
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('full-suite runId path still processes badges when the authoritative run wrote zero storyboard rows', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ workos_organization_id: 'org_member' }], rowCount: 1, command: 'SELECT', oid: 0, fields: [] } as never);

    const db = makeDb({
      existingBadges: [badge('media-buy')],
      latestStatuses: [],
    });

    const result = await runBadgeFanOut({
      complianceDb: db,
      agentUrl: 'https://example.com/mcp',
      declaredSpecialisms: ['sales-broadcast-tv'],
      runId: 'run-zero-storyboards',
    });

    expect(db.getStoryboardStatuses).toHaveBeenCalledWith('https://example.com/mcp', { runId: 'run-zero-storyboards' });
    expect(result.degraded.map(d => d.role)).toContain('media-buy');
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
    // Both roles should be issued at the target public badge version — no
    // revoke of the role we didn't retest.
    expect(db.upsertBadge).toHaveBeenCalledTimes(2);
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

  it('revokes previously issued badges for versions no longer publicly badge-eligible', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ workos_organization_id: 'org_member' }], rowCount: 1, command: 'SELECT', oid: 0, fields: [] } as never);

    const db = makeDb({
      existingBadges: [badge('media-buy', 'active', '4.0')],
      latestStatuses: [status('sales_broadcast_tv', 'passing')],
    });

    const result = await runBadgeFanOut({
      complianceDb: db,
      agentUrl: 'https://example.com/mcp',
      declaredSpecialisms: ['sales-broadcast-tv'],
      adcpVersions: ['3.0'],
    });

    expect(result.revoked).toEqual([
      {
        role: 'media-buy',
        reason: 'AdCP 4.0 public badge issuance is not currently enabled',
        adcp_version: '4.0',
      },
    ]);
    expect(db.revokeBadge).toHaveBeenCalledWith(
      'https://example.com/mcp',
      'media-buy',
      '4.0',
      'AdCP 4.0 public badge issuance is not currently enabled',
      '0',
    );
  });

  it('revokes previously issued public badges for versions the agent no longer advertises', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ workos_organization_id: 'org_member' }], rowCount: 1, command: 'SELECT', oid: 0, fields: [] } as never);

    const db = makeDb({
      existingBadges: [badge('media-buy', 'active', '3.1')],
      latestStatuses: [status('sales_broadcast_tv', 'passing')],
    });

    const result = await runBadgeFanOut({
      complianceDb: db,
      agentUrl: 'https://example.com/mcp',
      declaredSpecialisms: ['sales-broadcast-tv'],
      adcpVersions: ['3.0'],
      supportedVersions: ['3.0'],
    });

    expect(result.revoked).toEqual([
      {
        role: 'media-buy',
        reason: 'Agent no longer advertises AdCP 3.1 support',
        adcp_version: '3.1',
      },
    ]);
    expect(db.revokeBadge).toHaveBeenCalledWith(
      'https://example.com/mcp',
      'media-buy',
      '3.1',
      'Agent no longer advertises AdCP 3.1 support',
      '0',
    );
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
      adcpVersions: SUPPORTED_BADGE_VERSIONS,
    });

    expect(result.issued.map(i => i.adcp_version)).toEqual([...SUPPORTED_BADGE_VERSIONS]);
    expect((db.upsertBadge as ReturnType<typeof vi.fn>).mock.calls.map(call => call[0].adcp_version))
      .toEqual([...SUPPORTED_BADGE_VERSIONS]);
  });
});
