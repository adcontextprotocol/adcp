import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));

vi.mock('../../src/db/client.js', () => ({
  query: mockQuery,
}));

import { setSetting, getSettingAuditHistory } from '../../src/db/system-settings-db.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('setSetting', () => {
  it('executes the writable CTE with correct parameters', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await setSetting('editorial_slack_channel', { channel_id: 'C123', channel_name: 'editorial' }, 'user_abc');

    expect(mockQuery).toHaveBeenCalledOnce();
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('system_settings_audit');
    expect(sql).toContain('ON CONFLICT');
    expect(sql).toContain('LEFT JOIN old ON true');
    expect(params[0]).toBe('editorial_slack_channel');
    expect(params[1]).toBe(JSON.stringify({ channel_id: 'C123', channel_name: 'editorial' }));
    expect(params[2]).toBe('user_abc');
  });

  it('passes null changed_by when updatedBy is omitted', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await setSetting('prospect_triage_enabled', { enabled: true });

    const [, params] = mockQuery.mock.calls[0];
    expect(params[2]).toBeNull();
  });
});

describe('getSettingAuditHistory', () => {
  it('returns audit rows ordered by changed_at DESC', async () => {
    const rows = [
      { id: 'uuid-1', key: 'billing_slack_channel', old_value: null, new_value: { channel_id: 'C1', channel_name: 'billing' }, changed_by: 'user_abc', changed_at: new Date('2026-04-24T03:00:00Z') },
    ];
    mockQuery.mockResolvedValueOnce({ rows });

    const result = await getSettingAuditHistory();
    expect(result).toEqual(rows);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('ORDER BY changed_at DESC');
    expect(params[0]).toBe(50);
  });

  it('clamps limit to 200', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await getSettingAuditHistory(9999);

    const [, params] = mockQuery.mock.calls[0];
    expect(params[0]).toBe(200);
  });

  it('clamps limit to 1 at minimum', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await getSettingAuditHistory(0);

    const [, params] = mockQuery.mock.calls[0];
    expect(params[0]).toBe(1);
  });
});
