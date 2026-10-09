import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getClientWithDeadline: vi.fn(),
  query: vi.fn(),
  recordEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/db/client.js', () => ({
  query: mocks.query,
  getClient: vi.fn(),
  getClientWithDeadline: mocks.getClientWithDeadline,
}));
vi.mock('../../src/db/person-events-db.js', () => ({ recordEvent: mocks.recordEvent }));

import { resolvePersonId } from '../../src/db/relationship-db.js';

describe('relationship identity transaction deadlines', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sets short transaction-local deadlines and rolls back a FOR UPDATE lock timeout', async () => {
    const release = vi.fn();
    const lockError = Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' });
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('FOR UPDATE')) throw lockError;
        return { rows: [] };
      }),
      release,
    };
    mocks.getClientWithDeadline.mockResolvedValue(client);

    await expect(resolvePersonId({ workos_user_id: 'user-1' })).rejects.toBe(lockError);

    expect(mocks.getClientWithDeadline).toHaveBeenCalledWith(2_000);
    expect(client.query).toHaveBeenNthCalledWith(1, 'BEGIN');
    expect(client.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("set_config('lock_timeout'"),
      ['1500ms', '4000ms', '5000ms'],
    );
    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
    expect(client.query).not.toHaveBeenCalledWith('COMMIT');
    expect(release).toHaveBeenCalledOnce();
  });
});
