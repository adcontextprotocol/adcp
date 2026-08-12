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

describe('ComplianceDatabase.getRecentSupportedVersions', () => {
  const db = new ComplianceDatabase();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns string versions from the most recent profile inside the default seven-day window', async () => {
    mockedQuery.mockResolvedValueOnce({
      rows: [{ supported_versions: ['3.1', null, '', '3.0'] }],
      rowCount: 1,
    } as never);

    await expect(db.getRecentSupportedVersions('https://agent.example/mcp'))
      .resolves.toEqual(['3.1', '3.0']);
    expect(mockedQuery).toHaveBeenCalledWith(
      expect.stringContaining("jsonb_typeof(agent_profile_json->'adcp_supported_versions') = 'array'"),
      ['https://agent.example/mcp', 168],
    );
  });

  it('returns an empty list when no recent stored profile exists', async () => {
    mockedQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

    await expect(db.getRecentSupportedVersions('https://agent.example/mcp')).resolves.toEqual([]);
  });

  it('rejects an invalid recency window before querying', async () => {
    await expect(db.getRecentSupportedVersions('https://agent.example/mcp', 0))
      .rejects.toThrow('maxAgeHours must be a positive integer');
    expect(mockedQuery).not.toHaveBeenCalled();
  });
});
