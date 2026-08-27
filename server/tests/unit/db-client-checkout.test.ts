import { afterEach, describe, expect, it, vi } from 'vitest';

describe('db client checkout and health checks', () => {
  afterEach(() => {
    vi.useRealTimers();
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
    const clientOn = vi.fn();
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
      on = clientOn;

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
      clientOn,
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

  it('reuses a dedicated health client instead of the application pool', async () => {
    const pg = mockPg();
    pg.poolQuery.mockRejectedValue(new Error('pool should not be used by healthCheck'));

    const db = await import('../../src/db/client.js');
    db.initializeDatabase({ connectionString: 'postgresql://localhost/test' });

    await db.healthCheck(5000);
    await db.healthCheck(5000);

    expect(pg.poolInstances).toHaveLength(1);
    expect(pg.poolQuery).not.toHaveBeenCalled();
    expect(pg.clientInstances).toHaveLength(1);
    expect(pg.clientConnect).toHaveBeenCalledTimes(1);
    expect(pg.clientQuery).toHaveBeenCalledTimes(2);
    expect(pg.clientQuery).toHaveBeenNthCalledWith(1, 'SELECT 1');
    expect(pg.clientQuery).toHaveBeenNthCalledWith(2, 'SELECT 1');
    expect(pg.clientEnd).not.toHaveBeenCalled();

    await db.closeDatabase();
    expect(pg.clientEnd).toHaveBeenCalledTimes(1);
  });

  it('shares one in-flight query across concurrent health checks', async () => {
    const pg = mockPg();
    let resolveQuery!: (value: { rows: Array<{ '?column?': number }> }) => void;
    pg.clientQuery.mockReturnValue(new Promise((resolve) => {
      resolveQuery = resolve;
    }));

    const db = await import('../../src/db/client.js');
    db.initializeDatabase({ connectionString: 'postgresql://localhost/test' });

    const first = db.healthCheck(5000);
    const second = db.healthCheck(5000);
    await vi.waitFor(() => expect(pg.clientQuery).toHaveBeenCalledTimes(1));

    resolveQuery({ rows: [{ '?column?': 1 }] });
    await Promise.all([first, second]);

    expect(pg.clientInstances).toHaveLength(1);
    expect(pg.clientConnect).toHaveBeenCalledTimes(1);
    expect(pg.clientQuery).toHaveBeenCalledTimes(1);

    await db.closeDatabase();
  });

  it('discards a failed health connection and reconnects on the next probe', async () => {
    const pg = mockPg();
    const failure = new Error('health query failed');
    pg.clientQuery
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });

    const db = await import('../../src/db/client.js');
    db.initializeDatabase({ connectionString: 'postgresql://localhost/test' });

    await expect(db.healthCheck(5000)).rejects.toBe(failure);
    expect(pg.clientEnd).toHaveBeenCalledTimes(1);

    await expect(db.healthCheck(5000)).resolves.toBeUndefined();
    expect(pg.clientInstances).toHaveLength(2);
    expect(pg.clientConnect).toHaveBeenCalledTimes(2);
    expect(pg.clientQuery).toHaveBeenCalledTimes(2);

    await db.closeDatabase();
    expect(pg.clientEnd).toHaveBeenCalledTimes(2);
  });

  it('retries a stale health connection once within the original probe deadline', async () => {
    const pg = mockPg();
    pg.clientQuery
      .mockRejectedValueOnce(new Error('Connection terminated unexpectedly'))
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });

    const db = await import('../../src/db/client.js');
    db.initializeDatabase({ connectionString: 'postgresql://localhost/test' });

    await expect(db.healthCheck(5000)).resolves.toBeUndefined();
    expect(pg.clientInstances).toHaveLength(2);
    expect(pg.clientConnect).toHaveBeenCalledTimes(2);
    expect(pg.clientQuery).toHaveBeenCalledTimes(2);
    expect(pg.clientEnd).toHaveBeenCalledTimes(1);

    await db.closeDatabase();
    expect(pg.clientEnd).toHaveBeenCalledTimes(2);
  });

  it('does not grant a stale-connection retry a fresh probe timeout', async () => {
    vi.useFakeTimers();
    const pg = mockPg();
    pg.clientQuery
      .mockImplementationOnce(() => new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Connection terminated unexpectedly')), 40);
      }))
      .mockReturnValueOnce(new Promise(() => undefined));

    const db = await import('../../src/db/client.js');
    db.initializeDatabase({ connectionString: 'postgresql://localhost/test' });

    const rejection = expect(db.healthCheck(50)).rejects.toThrow('health check query timed out');
    await vi.advanceTimersByTimeAsync(50);
    await rejection;

    expect(pg.clientInstances).toHaveLength(2);
    expect(pg.clientQuery).toHaveBeenCalledTimes(2);
    expect(pg.clientEnd).toHaveBeenCalledTimes(2);
    await db.closeDatabase();
  });

  it('evicts an idle failed connection without letting its handler clear a replacement', async () => {
    const pg = mockPg();
    const db = await import('../../src/db/client.js');
    db.initializeDatabase({ connectionString: 'postgresql://localhost/test' });

    await db.healthCheck(5000);
    const firstErrorHandler = pg.clientOn.mock.calls[0][1] as (error: Error) => void;
    firstErrorHandler(new Error('idle connection closed'));

    await db.healthCheck(5000);
    expect(pg.clientInstances).toHaveLength(2);
    firstErrorHandler(new Error('late stale-client error'));
    await db.healthCheck(5000);

    expect(pg.clientInstances).toHaveLength(2);
    expect(pg.clientConnect).toHaveBeenCalledTimes(2);
    expect(pg.clientQuery).toHaveBeenCalledTimes(3);
    expect(pg.clientEnd).toHaveBeenCalledTimes(1);
    await db.closeDatabase();
    expect(pg.clientEnd).toHaveBeenCalledTimes(2);
  });

  it('times out a hung health query and evicts its connection', async () => {
    vi.useFakeTimers();
    const pg = mockPg();
    pg.clientQuery.mockReturnValue(new Promise(() => undefined));

    const db = await import('../../src/db/client.js');
    db.initializeDatabase({ connectionString: 'postgresql://localhost/test' });

    const rejection = expect(db.healthCheck(50)).rejects.toThrow('health check query timed out');
    await vi.advanceTimersByTimeAsync(50);
    await rejection;
    expect(pg.clientEnd).toHaveBeenCalledTimes(1);

    await db.closeDatabase();
  });

  it('recovers on the next probe after a health connection cannot be established', async () => {
    const pg = mockPg();
    const failure = new Error('initial connect failed');
    pg.clientConnect.mockRejectedValueOnce(failure).mockResolvedValueOnce(undefined);

    const db = await import('../../src/db/client.js');
    db.initializeDatabase({ connectionString: 'postgresql://localhost/test' });

    await expect(db.healthCheck(5000)).rejects.toBe(failure);
    expect(pg.clientEnd).toHaveBeenCalledTimes(1);
    await expect(db.healthCheck(5000)).resolves.toBeUndefined();

    expect(pg.clientInstances).toHaveLength(2);
    expect(pg.clientConnect).toHaveBeenCalledTimes(2);
    expect(pg.clientQuery).toHaveBeenCalledTimes(1);
    await db.closeDatabase();
    expect(pg.clientEnd).toHaveBeenCalledTimes(2);
  });

  it('waits for an in-flight health check before closing its client and pool', async () => {
    const pg = mockPg();
    let resolveQuery!: (value: { rows: Array<{ '?column?': number }> }) => void;
    pg.clientQuery.mockReturnValue(new Promise((resolve) => {
      resolveQuery = resolve;
    }));

    const db = await import('../../src/db/client.js');
    db.initializeDatabase({ connectionString: 'postgresql://localhost/test' });

    const check = db.healthCheck(5000);
    await vi.waitFor(() => expect(pg.clientQuery).toHaveBeenCalledTimes(1));
    const close = db.closeDatabase();
    await Promise.resolve();
    expect(pg.clientEnd).not.toHaveBeenCalled();
    expect(pg.poolEnd).not.toHaveBeenCalled();

    resolveQuery({ rows: [{ '?column?': 1 }] });
    await Promise.all([check, close]);
    expect(pg.clientEnd).toHaveBeenCalledTimes(1);
    expect(pg.poolEnd).toHaveBeenCalledTimes(1);
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
