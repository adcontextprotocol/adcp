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
});
