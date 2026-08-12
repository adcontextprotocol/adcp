import { afterEach, describe, expect, it, vi } from 'vitest';

describe('db client checkout and health checks', () => {
  afterEach(() => {
    vi.doUnmock('pg');
    vi.resetModules();
  });

  function mockPg() {
    const poolConnect = vi.fn();
    const poolQuery = vi.fn();
    const poolEnd = vi.fn().mockResolvedValue(undefined);
    const poolOn = vi.fn();
    const clientConnect = vi.fn().mockResolvedValue(undefined);
    const clientQuery = vi.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] });
    const clientEnd = vi.fn().mockResolvedValue(undefined);
    const poolInstances: Array<{ query: typeof poolQuery; end: typeof poolEnd; on: typeof poolOn }> = [];
    const clientInstances: Array<{ connect: typeof clientConnect; query: typeof clientQuery; end: typeof clientEnd }> = [];

    class MockPool {
      query = poolQuery;
      end = poolEnd;
      on = poolOn;

      constructor() {
        poolInstances.push(this);
      }

      connect() {
        return poolConnect();
      }
    }

    class MockClient {
      connect = clientConnect;
      query = clientQuery;
      end = clientEnd;

      constructor() {
        clientInstances.push(this);
      }
    }

    vi.doMock('pg', () => ({
      Pool: MockPool,
      Client: MockClient,
    }));

    return {
      poolConnect,
      poolQuery,
      poolEnd,
      clientConnect,
      clientQuery,
      clientEnd,
      poolInstances,
      clientInstances,
    };
  }

  it('retries pool client checkout once for pg-pool connection timeout errors', async () => {
    const pg = mockPg();
    const fakeClient = { query: vi.fn(), release: vi.fn() };
    pg.poolConnect
      .mockRejectedValueOnce(new Error('timeout exceeded when trying to connect'))
      .mockResolvedValueOnce(fakeClient);

    const db = await import('../../src/db/client.js');
    db.initializeDatabase({ connectionString: 'postgresql://localhost/test' });

    await expect(db.getClient()).resolves.toBe(fakeClient);
    expect(pg.poolConnect).toHaveBeenCalledTimes(2);

    await db.closeDatabase();
  });

  it('runs health checks on a one-off client instead of the application pool', async () => {
    const pg = mockPg();
    pg.poolQuery.mockRejectedValue(new Error('pool should not be used by healthCheck'));

    const db = await import('../../src/db/client.js');
    db.initializeDatabase({ connectionString: 'postgresql://localhost/test' });

    await db.healthCheck(5000);

    expect(pg.poolInstances).toHaveLength(1);
    expect(pg.poolQuery).not.toHaveBeenCalled();
    expect(pg.clientInstances).toHaveLength(1);
    expect(pg.clientConnect).toHaveBeenCalledTimes(1);
    expect(pg.clientQuery).toHaveBeenCalledWith('SELECT 1');
    expect(pg.clientEnd).toHaveBeenCalledTimes(1);

    await db.closeDatabase();
  });

  it('opens dedicated session work outside the application pool', async () => {
    const pg = mockPg();

    const db = await import('../../src/db/client.js');
    db.initializeDatabase({ connectionString: 'postgresql://localhost/test' });

    const client = await db.getDedicatedClient();

    expect(pg.poolConnect).not.toHaveBeenCalled();
    expect(pg.clientInstances).toHaveLength(1);
    expect(pg.clientConnect).toHaveBeenCalledTimes(1);

    await client.end();
    expect(pg.clientEnd).toHaveBeenCalledTimes(1);
    await db.closeDatabase();
  });

  it('applies transaction-local deadlines and releases the client', async () => {
    const pg = mockPg();
    const release = vi.fn();
    const query = vi.fn().mockResolvedValue({ rows: [{ value: 1 }] });
    pg.poolConnect.mockResolvedValue({ query, release });

    const db = await import('../../src/db/client.js');
    db.initializeDatabase({ connectionString: 'postgresql://localhost/test' });

    await expect(db.queryWithTimeout('SELECT $1 AS value', [1], 5_000))
      .resolves.toEqual({ rows: [{ value: 1 }] });
    expect(query.mock.calls[0]).toEqual(['BEGIN READ ONLY']);
    const statementTimeout = Number.parseInt(query.mock.calls[1][1][0], 10);
    expect(statementTimeout).toBeGreaterThan(0);
    expect(statementTimeout).toBeLessThanOrEqual(5_000);
    expect(query.mock.calls[2]).toEqual([
      "SELECT set_config('lock_timeout', $1, true)",
      ['2000ms'],
    ]);
    expect(query.mock.calls[3]).toEqual(['SELECT $1 AS value', [1]]);
    expect(query.mock.calls[4]).toEqual(['COMMIT']);
    expect(release).toHaveBeenCalledTimes(1);

    await db.closeDatabase();
  });

  it('rolls back and releases the client after a timed query fails', async () => {
    const pg = mockPg();
    const release = vi.fn();
    const timeoutError = Object.assign(new Error('statement timeout'), { code: '57014' });
    const query = vi.fn().mockImplementation(async (text: string) => {
      if (text === 'SELECT pg_sleep(10)') throw timeoutError;
      return { rows: [] };
    });
    pg.poolConnect.mockResolvedValue({ query, release });

    const db = await import('../../src/db/client.js');
    db.initializeDatabase({ connectionString: 'postgresql://localhost/test' });

    await expect(db.queryWithTimeout('SELECT pg_sleep(10)', undefined, 5_000))
      .rejects.toBe(timeoutError);
    expect(query).toHaveBeenLastCalledWith('ROLLBACK');
    expect(query).not.toHaveBeenCalledWith('COMMIT');
    expect(release).toHaveBeenCalledTimes(1);

    await db.closeDatabase();
  });

  it('propagates a request deadline into ordinary query calls', async () => {
    const pg = mockPg();
    const release = vi.fn();
    const query = vi.fn().mockResolvedValue({ rows: [] });
    pg.poolConnect.mockResolvedValue({ query, release });

    const db = await import('../../src/db/client.js');
    db.initializeDatabase({ connectionString: 'postgresql://localhost/test' });

    await db.withDatabaseDeadline(Date.now() + 1_000, () => db.query('SELECT 1'));

    expect(pg.poolQuery).not.toHaveBeenCalled();
    const statementTimeout = query.mock.calls.find(
      ([text]) => text === "SELECT set_config('statement_timeout', $1, true)",
    )?.[1]?.[0];
    expect(Number.parseInt(statementTimeout, 10)).toBeGreaterThan(0);
    expect(Number.parseInt(statementTimeout, 10)).toBeLessThanOrEqual(1_000);
    expect(query).toHaveBeenCalledWith('SELECT 1', undefined);
    expect(release).toHaveBeenCalledTimes(1);

    await db.closeDatabase();
  });

  it('uses a writable transaction for deadline-bounded worker writes', async () => {
    const pg = mockPg();
    const release = vi.fn();
    const query = vi.fn().mockResolvedValue({ rows: [] });
    pg.poolConnect.mockResolvedValue({ query, release });

    const db = await import('../../src/db/client.js');
    db.initializeDatabase({ connectionString: 'postgresql://localhost/test' });

    await db.withDatabaseDeadline(
      Date.now() + 1_000,
      () => db.query('UPDATE jobs SET status = $1', ['complete']),
      { readOnly: false },
    );

    expect(query.mock.calls[0]).toEqual(['BEGIN']);
    expect(query).toHaveBeenCalledWith(
      'UPDATE jobs SET status = $1',
      ['complete'],
    );
    expect(query).toHaveBeenCalledWith('COMMIT');
    expect(release).toHaveBeenCalledTimes(1);

    await db.closeDatabase();
  });
});
