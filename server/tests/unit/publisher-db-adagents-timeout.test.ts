import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/db/client.js', () => ({
  getClient: vi.fn(),
  query: vi.fn(),
}));

import { getClient } from '../../src/db/client.js';
import { PublisherDatabase } from '../../src/db/publisher-db.js';

const mockedGetClient = vi.mocked(getClient);
const emptyResult = { rows: [], rowCount: 0, command: '', oid: 0, fields: [] };

describe('PublisherDatabase adagents cache transaction deadlines', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sets transaction-local lock and statement deadlines before taking the publisher lock', async () => {
    const query = vi.fn().mockResolvedValue(emptyResult);
    const release = vi.fn();
    mockedGetClient.mockResolvedValue({ query, release } as never);

    const db = new PublisherDatabase();
    await db.upsertAdagentsCache({
      domain: 'publisher.example',
      manifest: { authorized_agents: [], properties: [], collections: [] },
    });

    const calls = query.mock.calls.map(([text, params]) => [text, params]);
    expect(calls.slice(0, 4)).toEqual([
      ['BEGIN', undefined],
      ["SELECT set_config('lock_timeout', $1, true)", ['5000ms']],
      ["SELECT set_config('statement_timeout', $1, true)", ['30000ms']],
      ['SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', ['publisher.example']],
    ]);
    expect(query).toHaveBeenCalledWith('COMMIT');
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('rolls back and releases after advisory-lock timeout', async () => {
    const lockError = Object.assign(new Error('canceling statement due to lock timeout'), {
      code: '55P03',
    });
    const query = vi.fn().mockImplementation(async (text: string) => {
      if (text.startsWith('SELECT pg_advisory_xact_lock')) throw lockError;
      return emptyResult;
    });
    const release = vi.fn();
    mockedGetClient.mockResolvedValue({ query, release } as never);

    const db = new PublisherDatabase();
    await expect(db.upsertAdagentsCache({
      domain: 'publisher.example',
      manifest: { authorized_agents: [] },
    })).rejects.toBe(lockError);

    expect(query).toHaveBeenCalledWith('ROLLBACK');
    expect(query).not.toHaveBeenCalledWith('COMMIT');
    expect(release).toHaveBeenCalledTimes(1);
  });
});
