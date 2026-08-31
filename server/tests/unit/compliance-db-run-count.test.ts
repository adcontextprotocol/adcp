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

// adcp#6632 / adcp-client#2639 — the persisted per-agent
// storyboard_start_offset source for budget-limited heartbeat runs.
describe('ComplianceDatabase.countComplianceRuns', () => {
  const db = new ComplianceDatabase();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the per-agent run count', async () => {
    mockedQuery.mockResolvedValueOnce({ rows: [{ run_count: 7 }], rowCount: 1 } as never);
    await expect(db.countComplianceRuns('https://agent.example/mcp')).resolves.toBe(7);
    expect(mockedQuery).toHaveBeenCalledWith(
      expect.stringContaining('FROM agent_compliance_runs'),
      ['https://agent.example/mcp'],
    );
  });

  it('returns 0 for an agent with no recorded runs', async () => {
    mockedQuery.mockResolvedValueOnce({ rows: [{ run_count: 0 }], rowCount: 1 } as never);
    await expect(db.countComplianceRuns('https://new.example/mcp')).resolves.toBe(0);
  });

  it('coerces string counts and tolerates empty result sets', async () => {
    mockedQuery.mockResolvedValueOnce({ rows: [{ run_count: '12' }], rowCount: 1 } as never);
    await expect(db.countComplianceRuns('https://agent.example/mcp')).resolves.toBe(12);
    mockedQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    await expect(db.countComplianceRuns('https://agent.example/mcp')).resolves.toBe(0);
  });
});
