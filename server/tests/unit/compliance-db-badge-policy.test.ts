import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/db/client.js', () => ({
  query: vi.fn(),
  getClient: vi.fn(),
}));

vi.mock('../../src/db/encryption.js', () => ({
  decrypt: vi.fn(),
  encrypt: vi.fn(),
  deriveKey: vi.fn(),
}));

import { ComplianceDatabase } from '../../src/db/compliance-db.js';
import { getClient, query } from '../../src/db/client.js';

const mockedQuery = vi.mocked(query);
const mockedGetClient = vi.mocked(getClient);

function mockClient(results: Array<{ rows?: unknown[]; rowCount?: number }> = []) {
  const client = {
    query: vi.fn(),
    release: vi.fn(),
  };
  for (const result of results) {
    client.query.mockResolvedValueOnce({ rows: [], rowCount: 0, ...result });
  }
  mockedGetClient.mockResolvedValue(client as never);
  return client;
}

describe('ComplianceDatabase badge opt-out policy', () => {
  const db = new ComplianceDatabase();

  beforeEach(() => {
    vi.clearAllMocks();
    mockedQuery.mockResolvedValue({ rows: [], rowCount: 0 } as never);
  });

  it('suppresses opted-out agents from every active badge read helper', async () => {
    await db.getBadgesForAgent('https://agent.example/mcp');
    await db.getActiveBadge('https://agent.example/mcp', 'media-buy', '3.1');
    await db.getHighestVersionActiveBadge('https://agent.example/mcp', 'media-buy');
    await db.bulkGetActiveBadges(['https://agent.example/mcp']);
    await db.getVerifiedAgentsByRole('media-buy');

    expect(mockedQuery).toHaveBeenCalledTimes(5);
    for (const [sql] of mockedQuery.mock.calls) {
      expect(sql).toContain('LEFT JOIN agent_registry_metadata');
      expect(sql).toContain('COALESCE(m.compliance_opt_out, FALSE) = FALSE');
      expect(sql).toContain('COALESCE(m.badge_requalification_required, FALSE) = FALSE');
    }
  });

  it('serializes the final badge write and fails closed against the latest opt-out state', async () => {
    const client = mockClient([
      {}, // BEGIN
      {}, // advisory lock
      { rows: [] }, // guarded upsert sees opted-out metadata
      {}, // COMMIT
    ]);

    await expect(db.upsertBadge({
      agent_url: 'https://agent.example/mcp',
      role: 'media-buy',
      adcp_version: '3.1',
      verified_specialisms: ['sales-broadcast-tv'],
    })).resolves.toBeNull();

    expect(client.query.mock.calls.map(([sql]) => sql)).toEqual([
      'BEGIN',
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      expect.stringMatching(/WHERE NOT EXISTS \([\s\S]*compliance_opt_out = TRUE/),
      'COMMIT',
    ]);
    expect(client.query).toHaveBeenCalledWith(
      expect.stringMatching(/WHERE NOT EXISTS \([\s\S]*compliance_opt_out = TRUE/),
      [
        'https://agent.example/mcp',
        'media-buy',
        '3.1',
        ['sales-broadcast-tv'],
        ['spec'],
        null,
        null,
        null,
        null,
        null,
        false,
      ],
    );
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('atomically opts out, revokes every badge, and leaves requalification required', async () => {
    const client = mockClient([
      {}, // BEGIN
      {}, // advisory lock
      { rows: [{ compliance_opt_out: false, badge_requalification_required: false }] },
      { rows: [{ agent_url: 'https://agent.example/mcp', compliance_opt_out: true, badge_requalification_required: true }] },
      { rows: [{ role: 'media-buy', adcp_version: '3.1' }], rowCount: 1 },
      {}, // COMMIT
    ]);

    await expect(db.setComplianceOptOut('https://agent.example/mcp', true)).resolves.toMatchObject({
      metadata: { compliance_opt_out: true, badge_requalification_required: true },
      revoked: [{ role: 'media-buy', adcp_version: '3.1' }],
    });

    expect(client.query.mock.calls.map(([sql]) => sql)).toEqual([
      'BEGIN',
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      expect.stringContaining('FOR UPDATE'),
      expect.stringContaining('badge_requalification_required'),
      expect.stringMatching(/UPDATE agent_verification_badges[\s\S]*status IN \('active', 'degraded'\)/),
      'COMMIT',
    ]);
  });

  it('revokes defensively before re-enable commits and keeps the public gate closed', async () => {
    const client = mockClient([
      {},
      {},
      { rows: [{ compliance_opt_out: true, badge_requalification_required: true }] },
      { rows: [{ agent_url: 'https://agent.example/mcp', compliance_opt_out: false, badge_requalification_required: true }] },
      { rows: [], rowCount: 0 },
      {},
    ]);

    await expect(db.setComplianceOptOut('https://agent.example/mcp', false)).resolves.toMatchObject({
      metadata: { compliance_opt_out: false, badge_requalification_required: true },
    });

    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE agent_verification_badges'),
      ['https://agent.example/mcp', 'Compliance monitoring re-enabled; fresh qualifying run required'],
    );
  });

  it('rolls back both metadata and badge revocation when the transition fails', async () => {
    const client = mockClient([
      {},
      {},
      { rows: [{ compliance_opt_out: false, badge_requalification_required: false }] },
      { rows: [{ compliance_opt_out: true, badge_requalification_required: true }] },
    ]);
    client.query
      .mockRejectedValueOnce(new Error('revocation failed'))
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await expect(db.setComplianceOptOut('https://agent.example/mcp', true))
      .rejects.toThrow('revocation failed');

    expect(client.query).toHaveBeenLastCalledWith('ROLLBACK');
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('revokes all active and degraded versions in one transition', async () => {
    mockedQuery.mockResolvedValueOnce({
      rows: [
        { role: 'media-buy', adcp_version: '3.0' },
        { role: 'media-buy', adcp_version: '3.1' },
      ],
      rowCount: 2,
    } as never);

    await expect(db.revokeAllBadges(
      'https://agent.example/mcp',
      'Compliance monitoring opted out',
    )).resolves.toEqual([
      { role: 'media-buy', adcp_version: '3.0' },
      { role: 'media-buy', adcp_version: '3.1' },
    ]);

    expect(mockedQuery).toHaveBeenCalledWith(
      expect.stringMatching(/status IN \('active', 'degraded'\)[\s\S]*RETURNING role, adcp_version/),
      ['https://agent.example/mcp', 'Compliance monitoring opted out'],
    );
  });

  it('reports a generation-guarded revocation no-op so callers cannot notify stale changes', async () => {
    const client = mockClient([
      {},
      {},
      { rowCount: 0 },
      {},
    ]);

    await expect(db.revokeBadge(
      'https://agent.example/mcp',
      'media-buy',
      '3.1',
      'Compliance failed',
      '7',
    )).resolves.toBe(false);

    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining('badge_requalification_generation'),
      ['https://agent.example/mcp', 'media-buy', '3.1', 'Compliance failed', '7'],
    );
  });

  it('reports a generation-guarded degradation only when the row changed', async () => {
    mockClient([
      {},
      {},
      { rowCount: 1 },
      {},
    ]);

    await expect(db.degradeBadge(
      'https://agent.example/mcp',
      'media-buy',
      '3.1',
      '7',
    )).resolves.toBe(true);
  });
});
