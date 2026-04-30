import { describe, it, expect, vi, beforeEach } from 'vitest';
import { processAgentBadges } from '../../src/services/badge-issuance.js';
import type {
  AgentVerificationBadge,
  BadgeRole,
  ComplianceDatabase,
  StoryboardStatusEntry,
} from '../../src/db/compliance-db.js';

function makeBadge(
  role: BadgeRole,
  status: AgentVerificationBadge['status'] = 'active',
  updatedAgo = 0,
  modes: string[] = ['spec'],
  adcpVersion = '3.0',
): AgentVerificationBadge {
  return {
    agent_url: 'https://example.com/mcp',
    role,
    adcp_version: adcpVersion,
    verified_at: new Date(Date.now() - 86_400_000),
    verified_protocol_version: null,
    verified_specialisms: ['sales-broadcast-tv'],
    verification_modes: modes,
    verification_token: null,
    token_expires_at: null,
    membership_org_id: 'org_test',
    status,
    revoked_at: null,
    revocation_reason: null,
    created_at: new Date(),
    updated_at: new Date(Date.now() - updatedAgo),
  };
}

function makeStatus(id: string, status: StoryboardStatusEntry['status']): StoryboardStatusEntry {
  return { storyboard_id: id, status, steps_passed: status === 'passing' ? 5 : 0, steps_total: 5 };
}

function makeMockDb(existingBadges: AgentVerificationBadge[]): ComplianceDatabase {
  return {
    getBadgesForAgent: vi.fn().mockResolvedValue(existingBadges),
    upsertBadge: vi.fn().mockImplementation((b) => Promise.resolve({ ...makeBadge(b.role), ...b })),
    degradeBadge: vi.fn().mockResolvedValue(undefined),
    revokeBadge: vi.fn().mockResolvedValue(undefined),
  } as unknown as ComplianceDatabase;
}

describe('processAgentBadges — membership gating', () => {
  beforeEach(() => vi.clearAllMocks());

  it('revokes all existing badges when membership is lapsed (no membershipOrgId)', async () => {
    const existing = [makeBadge('media-buy'), makeBadge('creative')];
    const db = makeMockDb(existing);

    const result = await processAgentBadges(
      db,
      'https://example.com/mcp',
      ['sales-broadcast-tv'],
      [makeStatus('sales_broadcast_tv', 'passing')],
      true,
      undefined, // membership lapsed
    );

    expect(result.revoked).toHaveLength(2);
    expect(result.revoked.map(r => r.role).sort()).toEqual(['creative', 'media-buy']);
    expect(result.revoked.every(r => r.reason === 'Membership lapsed')).toBe(true);
    expect(result.issued).toHaveLength(0);
    expect(db.revokeBadge).toHaveBeenCalledTimes(2);
    expect(db.upsertBadge).not.toHaveBeenCalled();
  });

  it('does not issue new badges when membership is lapsed', async () => {
    const db = makeMockDb([]); // no existing badges

    const result = await processAgentBadges(
      db,
      'https://example.com/mcp',
      ['sales-broadcast-tv'],
      [makeStatus('sales_broadcast_tv', 'passing')],
      true,
      undefined,
    );

    expect(result.issued).toHaveLength(0);
    expect(result.revoked).toHaveLength(0);
    expect(db.upsertBadge).not.toHaveBeenCalled();
  });

  it('issues a badge when declared specialism passes and membership is active', async () => {
    const db = makeMockDb([]);

    const result = await processAgentBadges(
      db,
      'https://example.com/mcp',
      ['sales-broadcast-tv'],
      [makeStatus('sales_broadcast_tv', 'passing')],
      true,
      'org_test',
    );

    expect(result.issued).toHaveLength(1);
    expect(result.issued[0].role).toBe('media-buy');
    expect(result.issued[0].specialisms).toEqual(['sales-broadcast-tv']);
    expect(db.upsertBadge).toHaveBeenCalledTimes(1);
    // New badges issue with verification_modes: ['spec'] by default
    const upsertCall = (db.upsertBadge as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(upsertCall.verification_modes).toEqual(['spec']);
  });

  it('preserves an existing live mode when re-asserting spec', async () => {
    // Simulate an agent that earned (Spec + Live) earlier; storyboards still
    // pass — the upsert must not strip 'live' off the badge.
    const existing = [makeBadge('media-buy', 'active', 0, ['spec', 'live'])];
    const db = makeMockDb(existing);

    await processAgentBadges(
      db,
      'https://example.com/mcp',
      ['sales-broadcast-tv'],
      [makeStatus('sales_broadcast_tv', 'passing')],
      true,
      'org_test',
    );

    const upsertCall = (db.upsertBadge as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(upsertCall.verification_modes.sort()).toEqual(['live', 'spec']);
  });

  it('degrades an active badge when a declared specialism starts failing', async () => {
    const existing = [makeBadge('media-buy', 'active')];
    const db = makeMockDb(existing);

    const result = await processAgentBadges(
      db,
      'https://example.com/mcp',
      ['sales-broadcast-tv'],
      [makeStatus('sales_broadcast_tv', 'failing')],
      false,
      'org_test',
    );

    expect(result.degraded).toHaveLength(1);
    expect(result.degraded[0].role).toBe('media-buy');
    expect(db.degradeBadge).toHaveBeenCalledTimes(1);
  });

  it('revokes a degraded badge after 48-hour grace period', async () => {
    const existing = [makeBadge('media-buy', 'degraded', 49 * 60 * 60 * 1000)];
    const db = makeMockDb(existing);

    const result = await processAgentBadges(
      db,
      'https://example.com/mcp',
      ['sales-broadcast-tv'],
      [makeStatus('sales_broadcast_tv', 'failing')],
      false,
      'org_test',
    );

    expect(result.revoked).toHaveLength(1);
    expect(result.revoked[0].role).toBe('media-buy');
    expect(result.revoked[0].reason).toMatch(/Failing specialisms/);
  });

  it('keeps a degraded badge unchanged within the 48-hour grace period', async () => {
    const existing = [makeBadge('media-buy', 'degraded', 10 * 60 * 60 * 1000)];
    const db = makeMockDb(existing);

    const result = await processAgentBadges(
      db,
      'https://example.com/mcp',
      ['sales-broadcast-tv'],
      [makeStatus('sales_broadcast_tv', 'failing')],
      false,
      'org_test',
    );

    expect(result.unchanged).toHaveLength(1);
    expect(result.revoked).toHaveLength(0);
  });
});

describe('processAgentBadges — per-AdCP-version isolation (#3524 stage 1)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('only touches badges at the AdCP version under test', async () => {
    // Agent holds badges at both 3.0 and 3.1. A 3.0 run with a failing
    // specialism must NOT touch the 3.1 badge.
    const existing = [
      makeBadge('media-buy', 'active', 0, ['spec'], '3.0'),
      makeBadge('media-buy', 'active', 0, ['spec'], '3.1'),
    ];
    const db = makeMockDb(existing);

    await processAgentBadges(
      db,
      'https://example.com/mcp',
      ['sales-broadcast-tv'],
      [makeStatus('sales_broadcast_tv', 'failing')],
      false,
      'org_test',
      '3.0',
    );

    // Only the 3.0 badge should be touched. Confirm by checking that
    // every degradeBadge call was scoped to '3.0' and 3.1 was never
    // a target.
    const degradeCalls = (db.degradeBadge as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(degradeCalls).toHaveLength(1);
    expect(degradeCalls[0][2]).toBe('3.0');
  });

  it('passes the AdCP version to upsertBadge on issuance', async () => {
    const db = makeMockDb([]);

    await processAgentBadges(
      db,
      'https://example.com/mcp',
      ['sales-broadcast-tv'],
      [makeStatus('sales_broadcast_tv', 'passing')],
      true,
      'org_test',
      '3.1',
    );

    const upsertCalls = (db.upsertBadge as unknown as { mock: { calls: Array<[Record<string, unknown>]> } }).mock.calls;
    expect(upsertCalls).toHaveLength(1);
    expect(upsertCalls[0][0]).toMatchObject({ adcp_version: '3.1' });
  });

  it('defaults to DEFAULT_BADGE_ADCP_VERSION when not passed (Stage 1 backward compat)', async () => {
    const db = makeMockDb([]);

    await processAgentBadges(
      db,
      'https://example.com/mcp',
      ['sales-broadcast-tv'],
      [makeStatus('sales_broadcast_tv', 'passing')],
      true,
      'org_test',
      // adcpVersion omitted — defaults to '3.0'
    );

    const upsertCalls = (db.upsertBadge as unknown as { mock: { calls: Array<[Record<string, unknown>]> } }).mock.calls;
    expect(upsertCalls[0][0]).toMatchObject({ adcp_version: '3.0' });
  });

  it('membership lapse only revokes badges at the version under test', async () => {
    const existing = [
      makeBadge('media-buy', 'active', 0, ['spec'], '3.0'),
      makeBadge('media-buy', 'active', 0, ['spec'], '3.1'),
    ];
    const db = makeMockDb(existing);

    await processAgentBadges(
      db,
      'https://example.com/mcp',
      ['sales-broadcast-tv'],
      [makeStatus('sales_broadcast_tv', 'passing')],
      true,
      undefined, // membership lapsed
      '3.0',
    );

    // Only 3.0 should be revoked under this run; 3.1 stays untouched.
    // Stage 2 will issue a separate per-version run for 3.1.
    const revokeCalls = (db.revokeBadge as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(revokeCalls).toHaveLength(1);
    expect(revokeCalls[0][2]).toBe('3.0');
  });
});
