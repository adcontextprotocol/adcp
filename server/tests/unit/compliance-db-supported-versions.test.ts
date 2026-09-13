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
import { query } from '../../src/db/client.js';

const mockedQuery = vi.mocked(query);

describe('ComplianceDatabase.getLastKnownSupportedVersions', () => {
  const db = new ComplianceDatabase();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns string versions from the most recent authoritative public profile without expiring the recovery hint', async () => {
    mockedQuery.mockResolvedValueOnce({
      rows: [{ supported_versions: ['3.1', null, '', '3.0'] }],
      rowCount: 1,
    } as never);

    await expect(db.getLastKnownSupportedVersions('https://agent.example/mcp'))
      .resolves.toEqual(['3.1', '3.0']);
    expect(mockedQuery).toHaveBeenCalledWith(
      expect.stringContaining("jsonb_typeof(agent_profile_json->'adcp_supported_versions') = 'array'"),
      ['https://agent.example/mcp'],
    );
    expect(mockedQuery.mock.calls[0]?.[0]).toContain('dry_run = FALSE AND is_authoritative = TRUE');
    expect(mockedQuery.mock.calls[0]?.[0]).not.toContain('make_interval');
  });

  it('reads declared specialisms only from authoritative public profiles', async () => {
    mockedQuery.mockResolvedValueOnce({
      rows: [{ agent_profile_json: { specialisms: ['signals-audience-activation'] } }], rowCount: 1,
    } as never);
    await expect(db.getLatestDeclaredSpecialisms('https://agent.example/mcp'))
      .resolves.toEqual(['signals-audience-activation']);
    expect(mockedQuery).toHaveBeenCalledWith(
      expect.stringContaining('dry_run = FALSE AND is_authoritative = TRUE'),
      ['https://agent.example/mcp'],
    );
  });

  it('returns an empty list when no stored profile exists', async () => {
    mockedQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

    await expect(db.getLastKnownSupportedVersions('https://agent.example/mcp')).resolves.toEqual([]);
  });

  it('defers an inconclusive check only while its future heartbeat lock is still held', async () => {
    mockedQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

    await expect(db.deferComplianceCheckAfterInconclusiveTarget('https://agent.example/mcp'))
      .resolves.toBe(true);

    expect(mockedQuery).toHaveBeenCalledWith(
      expect.stringMatching(/SET next_compliance_check_at = NOW\(\)[\s\S]*next_compliance_check_at > NOW\(\)/),
      ['https://agent.example/mcp'],
    );
  });

  it('preserves a concurrent completed run when the heartbeat lock is no longer current', async () => {
    mockedQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

    await expect(db.deferComplianceCheckAfterInconclusiveTarget('https://agent.example/mcp'))
      .resolves.toBe(false);
  });
});
