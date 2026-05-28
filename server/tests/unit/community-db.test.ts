import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../../src/db/client.js', () => ({
  query: vi.fn(),
}));

import { query } from '../../src/db/client.js';
import { CommunityDatabase } from '../../src/db/community-db.js';

const queryMock = vi.mocked(query);

describe('CommunityDatabase point awards', () => {
  beforeEach(() => {
    queryMock.mockReset();
  });

  it('returns missing_user for awardPoints when no users row exists', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ exists: false }], rowCount: 1 } as never);

    const result = await new CommunityDatabase().awardPoints(
      'user_missing',
      'wg_leadership',
      30,
      'wg_123',
      'working_group',
    );

    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain('SELECT EXISTS (SELECT 1 FROM users WHERE workos_user_id = $1)');
    expect(params).toEqual(['user_missing']);
    expect(result).toBe('missing_user');
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it('returns awarded when awardPoints inserts a row', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ exists: true }], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

    const result = await new CommunityDatabase().awardPoints(
      'user_present',
      'wg_leadership',
      30,
      'wg_123',
      'working_group',
    );

    const [insertSql, insertParams] = queryMock.mock.calls[1];
    expect(insertSql).toContain('ON CONFLICT (workos_user_id, action, reference_id)');
    expect(insertParams).toEqual(['user_present', 'wg_leadership', 30, 'wg_123', 'working_group']);
    expect(result).toBe('awarded');
  });

  it('returns false for daily visit when no user row exists', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ exists: false }], rowCount: 1 } as never);

    const awarded = await new CommunityDatabase().awardDailyVisit('user_missing');

    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain('SELECT EXISTS (SELECT 1 FROM users WHERE workos_user_id = $1)');
    expect(params[0]).toBe('user_missing');
    expect(awarded).toBe(false);
  });
});
