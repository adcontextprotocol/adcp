import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/db/client.js', () => ({
  query: vi.fn(),
}));

import { query } from '../../src/db/client.js';
import { resolveAlert } from '../../src/db/network-health-db.js';

const mockedQuery = vi.mocked(query);

describe('network-health alert resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('atomically binds the update to organization and alert ID', async () => {
    mockedQuery.mockResolvedValueOnce({
      rows: [{ id: 'alert_1' }],
      rowCount: 1,
      command: 'UPDATE',
      oid: 0,
      fields: [],
    });

    await expect(resolveAlert('org_target', 'alert_1')).resolves.toBe(true);

    const [sql, params] = mockedQuery.mock.calls[0];
    expect(sql).toContain('SET resolved_at = COALESCE(resolved_at, NOW())');
    expect(sql).toContain('WHERE org_id = $1 AND id = $2');
    expect(sql).toContain('RETURNING id');
    expect(params).toEqual(['org_target', 'alert_1']);
  });

  it('returns false for a missing alert or organization mismatch', async () => {
    mockedQuery.mockResolvedValueOnce({
      rows: [],
      rowCount: 0,
      command: 'UPDATE',
      oid: 0,
      fields: [],
    });

    await expect(resolveAlert('org_other', 'alert_1')).resolves.toBe(false);
  });
});
