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

  it('records the skip reason and releases the heartbeat lock, leaving a later requeue due', async () => {
    mockedQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

    await expect(db.deferComplianceCheckAfterInconclusiveTarget('https://agent.example/mcp', 'pre_target_error'))
      .resolves.toBe(true);

    const [sql, params] = mockedQuery.mock.calls[0] ?? [];
    expect(params).toEqual(['https://agent.example/mcp', false, 'pre_target_error']);
    expect(sql).toMatch(/compliance_lock_until = NULL[\s\S]*last_heartbeat_attempt_at = NOW\(\)[\s\S]*last_heartbeat_skip_reason = \$3/);
    expect(sql).toMatch(/CASE WHEN COALESCE\(requeued_at > heartbeat_started_at, FALSE\)\s+THEN next_compliance_check_at/);
    expect(sql).not.toContain('last_heartbeat_success_at');
  });

  it('uses bounded exponential backoff after repeated target failures', async () => {
    mockedQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

    await expect(db.deferComplianceCheckAfterInconclusiveTarget(
      'https://agent.example/mcp', 'target_unconfirmed', { exponentialBackoff: true },
    )).resolves.toBe(true);

    expect(mockedQuery).toHaveBeenCalledWith(
      expect.stringContaining('LEAST(48, check_interval_hours * (1 << LEAST(compliance_inconclusive_streak, 3)))'),
      ['https://agent.example/mcp', true, 'target_unconfirmed'],
    );
  });

  it('reports false when the agent has no registry metadata row', async () => {
    mockedQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

    await expect(db.deferComplianceCheckAfterInconclusiveTarget('https://agent.example/mcp', 'execution_fence_lost'))
      .resolves.toBe(false);
  });
});
