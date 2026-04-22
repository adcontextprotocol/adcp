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
): AgentVerificationBadge {
  return {
    agent_url: 'https://example.com/mcp',
    role,
    verified_at: new Date(Date.now() - 86_400_000),
    verified_protocol_version: null,
    verified_specialisms: ['sales-broadcast-tv'],
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
