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
    expect(release).toHaveBeenCalledWith();

    await db.closeDatabase();
  });

  const deadlinePhases = [
    { label: 'BEGIN', index: 0 },
    { label: 'statement_timeout set_config', index: 1 },
    { label: 'lock_timeout set_config', index: 2 },
    { label: 'authorization SELECT', index: 3 },
    { label: 'COMMIT', index: 4 },
  ] as const;

  const uncertainBehaviors = ['hung', 'rejected', 'late-resolving'] as const;

  it.each(deadlinePhases.flatMap(phase => uncertainBehaviors.map(behavior => ({
    ...phase,
    behavior,
  }))))(
    'destroys the client when $label is $behavior',
    async ({ index, behavior }) => {
      vi.useFakeTimers();
      const pg = mockPg();
      const release = vi.fn();
      let settleLate: (() => void) | undefined;
      const targetError = new Error('ambiguous client operation failure');
      const query = vi.fn().mockImplementation((text: string) => {
        const callIndex = query.mock.calls.length - 1;
        if (callIndex === index) {
          if (behavior === 'rejected') return Promise.reject(targetError);
          return new Promise((resolve) => {
            if (behavior === 'late-resolving') {
              settleLate = () => resolve({ rows: [{ principal: 'late-principal', epoch: 'late-epoch' }] });
            }
          });
        }
        return Promise.resolve({
          rows: text === 'SELECT authorization_snapshot' ? [{ principal: 'accepted-principal' }] : [],
        });
      });
      pg.poolConnect.mockResolvedValue({ query, release });

      const db = await import('../../src/db/client.js');
      db.initializeDatabase({ connectionString: 'postgresql://localhost/test' });

      const pending = db.queryWithTimeout('SELECT authorization_snapshot', undefined, 50);
      const rejection = behavior === 'rejected'
        ? expect(pending).rejects.toBe(targetError)
        : expect(pending).rejects.toBeInstanceOf(db.DatabaseQueryDeadlineExceededError);
      await vi.advanceTimersByTimeAsync(0);
      expect(query).toHaveBeenCalledTimes(index + 1);
      if (behavior !== 'rejected') await vi.advanceTimersByTimeAsync(50);
      await rejection;

      expect(release).toHaveBeenCalledTimes(1);
      expect(release).toHaveBeenCalledWith(true);
      expect(query).toHaveBeenCalledTimes(index + 1);

      settleLate?.();
      await Promise.resolve();
      await Promise.resolve();
      expect(query).toHaveBeenCalledTimes(index + 1);
      expect(release).toHaveBeenCalledTimes(1);

      await db.closeDatabase();
    },
  );

  it('destroys a client after a lost COMMIT acknowledgement', async () => {
    const pg = mockPg();
    const release = vi.fn();
    let committed = false;
    const lostAcknowledgement = Object.assign(new Error('connection reset after commit'), {
      code: 'ECONNRESET',
    });
    const query = vi.fn().mockImplementation(async (text: string) => {
      if (text === 'COMMIT') {
        committed = true;
        throw lostAcknowledgement;
      }
      return { rows: [] };
    });
    pg.poolConnect.mockResolvedValue({ query, release });

    const db = await import('../../src/db/client.js');
    db.initializeDatabase({ connectionString: 'postgresql://localhost/test' });

    await expect(db.queryWithTimeout('SELECT authorization_snapshot', undefined, 5_000))
      .rejects.toBe(lostAcknowledgement);
    expect(committed).toBe(true);
    expect(query).not.toHaveBeenCalledWith('ROLLBACK');
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith(true);

    await db.closeDatabase();
  });

  it.each(uncertainBehaviors)(
    'bounds a $behavior ROLLBACK and destroys the uncertain client',
    async (behavior) => {
      vi.useFakeTimers();
      const pg = mockPg();
      const release = vi.fn();
      let settleLate: (() => void) | undefined;
      const statementError = Object.assign(new Error('definite statement rejection'), { code: '42P01' });
      const rollbackError = new Error('rollback acknowledgement unavailable');
      const query = vi.fn().mockImplementation((text: string) => {
        if (text === 'SELECT authorization_snapshot') return Promise.reject(statementError);
        if (text === 'ROLLBACK') {
          if (behavior === 'rejected') return Promise.reject(rollbackError);
          return new Promise((resolve) => {
            if (behavior === 'late-resolving') settleLate = () => resolve({ rows: [] });
          });
        }
        return Promise.resolve({ rows: [] });
      });
      pg.poolConnect.mockResolvedValue({ query, release });

      const db = await import('../../src/db/client.js');
      db.initializeDatabase({ connectionString: 'postgresql://localhost/test' });

      const pending = db.queryWithTimeout('SELECT authorization_snapshot', undefined, 50);
      const rejection = expect(pending).rejects.toBe(statementError);
      await vi.advanceTimersByTimeAsync(0);
      expect(query).toHaveBeenLastCalledWith('ROLLBACK');
      if (behavior !== 'rejected') await vi.advanceTimersByTimeAsync(50);
      await rejection;

      expect(release).toHaveBeenCalledTimes(1);
      expect(release).toHaveBeenCalledWith(true);
      settleLate?.();
      await Promise.resolve();
      await Promise.resolve();
      expect(release).toHaveBeenCalledTimes(1);

      await db.closeDatabase();
    },
  );

  it('reuses a client only after a definite statement failure and confirmed rollback', async () => {
    const pg = mockPg();
    const release = vi.fn();
    const statementError = Object.assign(new Error('relation does not exist'), { code: '42P01' });
    const query = vi.fn().mockImplementation(async (text: string) => {
      if (text === 'SELECT authorization_snapshot') throw statementError;
      return { rows: [] };
    });
    pg.poolConnect.mockResolvedValue({ query, release });

    const db = await import('../../src/db/client.js');
    db.initializeDatabase({ connectionString: 'postgresql://localhost/test' });

    await expect(db.queryWithTimeout('SELECT authorization_snapshot', undefined, 5_000))
      .rejects.toBe(statementError);
    expect(query).toHaveBeenLastCalledWith('ROLLBACK');
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith();

    await db.closeDatabase();
  });

  it('does not starve an eight-client pool across nine timed-out attempts', async () => {
    vi.useFakeTimers();
    const pg = mockPg();
    let checkedOut = 0;
    let maximumCheckedOut = 0;
    const releases: Array<ReturnType<typeof vi.fn>> = [];
    pg.poolConnect.mockImplementation(() => {
      if (checkedOut >= 8) return new Promise(() => undefined);
      checkedOut += 1;
      maximumCheckedOut = Math.max(maximumCheckedOut, checkedOut);
      const release = vi.fn(() => {
        checkedOut -= 1;
      });
      releases.push(release);
      return Promise.resolve({ query: vi.fn(() => new Promise(() => undefined)), release });
    });

    const db = await import('../../src/db/client.js');
    db.initializeDatabase({ connectionString: 'postgresql://localhost/test', maxPoolSize: 8 });

    for (let attempt = 0; attempt < 9; attempt++) {
      const pending = db.queryWithTimeout('SELECT authorization_snapshot', undefined, 10);
      const rejection = expect(pending).rejects.toBeInstanceOf(db.DatabaseQueryDeadlineExceededError);
      await vi.advanceTimersByTimeAsync(10);
      await rejection;
    }

    expect(pg.poolConnect).toHaveBeenCalledTimes(9);
    expect(releases).toHaveLength(9);
    expect(releases.every(release => release.mock.calls.length === 1
      && release.mock.calls[0]?.[0] === true)).toBe(true);
    expect(checkedOut).toBe(0);
    expect(maximumCheckedOut).toBe(1);

    await db.closeDatabase();
  });

  it('does not accept a principal or epoch from a late authorization result', async () => {
    vi.useFakeTimers();
    const pg = mockPg();
    const lateRelease = vi.fn();
    const freshRelease = vi.fn();
    let resolveLate!: (value: { rows: Array<Record<string, unknown>> }) => void;
    const snapshotRow = (suffix: string, epoch: string) => ({
      in_recovery: false, terminal_marker: false, primary_count: '1',
      authenticated_user_id: `user_${suffix}`,
      canonical_user_id: `canonical_${suffix}`,
      identity_id: `identity_${suffix}`,
      authorization_epoch: epoch,
      email: `${suffix}@example.test`,
      email_verified: true,
      first_name: suffix,
      last_name: 'Snapshot',
      grant_id: null,
      grant_organization_id: null,
      grant_role: null,
      grant_effective_from: null,
      grant_effective_until: null,
    });
    const lateQuery = vi.fn().mockImplementation((text: string) => {
      if (text.includes('pg_catalog.pg_is_in_recovery')) {
        return new Promise((resolve) => {
          resolveLate = resolve;
        });
      }
      return Promise.resolve({ rows: [] });
    });
    const freshQuery = vi.fn().mockImplementation((text: string) => Promise.resolve({
      rows: text.includes('pg_catalog.pg_is_in_recovery') ? [snapshotRow('fresh', '22')] : [],
    }));
    pg.poolConnect
      .mockResolvedValueOnce({ query: lateQuery, release: lateRelease })
      .mockResolvedValueOnce({ query: freshQuery, release: freshRelease });

    const db = await import('../../src/db/client.js');
    const snapshots = await import('../../src/db/user-authorization-snapshot-db.js');
    db.initializeDatabase({ connectionString: 'postgresql://localhost/test' });

    const lateAttempt = snapshots.loadAuthorizationSnapshot('user_late', 'org_snapshot');
    const unavailable = expect(lateAttempt).rejects.toMatchObject({
      name: 'AuthorizationSnapshotUnavailableError',
      retryable: true,
    });
    await vi.advanceTimersByTimeAsync(2_000);
    await unavailable;
    expect(lateRelease).toHaveBeenCalledTimes(1);
    expect(lateRelease).toHaveBeenCalledWith(true);

    resolveLate({ rows: [snapshotRow('late', '999')] });
    await Promise.resolve();
    await Promise.resolve();

    await expect(snapshots.loadAuthorizationSnapshot('user_fresh', 'org_snapshot'))
      .resolves.toMatchObject({
        authenticatedUserId: 'user_fresh',
        canonicalUserId: 'canonical_fresh',
        identityId: 'identity_fresh',
        authorizationEpoch: '22',
      });
    expect(lateRelease).toHaveBeenCalledTimes(1);
    expect(freshRelease).toHaveBeenCalledTimes(1);
    expect(freshRelease).toHaveBeenCalledWith();

    await db.closeDatabase();
  });

  it('fails an exhausted snapshot pool at the absolute deadline and releases a late client', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const pg = mockPg();
    let deliverClient!: (client: { query: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> }) => void;
    pg.poolConnect.mockReturnValue(new Promise((resolve) => {
      deliverClient = resolve;
    }));

    const db = await import('../../src/db/client.js');
    const snapshots = await import('../../src/db/user-authorization-snapshot-db.js');
    db.initializeDatabase({ connectionString: 'postgresql://localhost/test' });

    const pending = snapshots.loadAuthorizationSnapshot('user_exhausted_pool', 'org_exhausted_pool');
    const rejection = expect(pending).rejects.toBeInstanceOf(
      snapshots.AuthorizationSnapshotUnavailableError,
    );
    await vi.advanceTimersByTimeAsync(1_999);
    expect(pg.poolConnect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await rejection;

    const lateClient = { query: vi.fn(), release: vi.fn() };
    deliverClient(lateClient);
    await Promise.resolve();
    await Promise.resolve();
    expect(lateClient.query).not.toHaveBeenCalled();
    expect(lateClient.release).toHaveBeenCalledTimes(1);
    expect(pg.poolConnect).toHaveBeenCalledTimes(1);

    await db.closeDatabase();
  });

  it('retries one transient snapshot checkout with only the remaining absolute budget', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const pg = mockPg();
    const release = vi.fn();
    const query = vi.fn().mockImplementation(async (text: string) => {
      if (text.includes('pg_catalog.pg_is_in_recovery')) {
        return {
          rows: [{
            in_recovery: false, terminal_marker: false, primary_count: '1',
            authenticated_user_id: 'user_retry_checkout',
            canonical_user_id: 'user_retry_checkout',
            identity_id: 'fd3043f7-cb4f-43c7-9b81-22ac97576150',
            authorization_epoch: '11',
            email: 'sam@pinnacle.example',
            email_verified: true,
            first_name: 'Sam',
            last_name: 'Adeyemi',
            grant_id: null,
            grant_organization_id: null,
            grant_role: null,
            grant_effective_from: null,
            grant_effective_until: null,
          }],
        };
      }
      return { rows: [] };
    });
    pg.poolConnect
      .mockImplementationOnce(async () => {
        vi.setSystemTime(Date.now() + 700);
        throw Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
      })
      .mockResolvedValueOnce({ query, release });

    const db = await import('../../src/db/client.js');
    const snapshots = await import('../../src/db/user-authorization-snapshot-db.js');
    db.initializeDatabase({ connectionString: 'postgresql://localhost/test' });

    await expect(snapshots.loadAuthorizationSnapshot('user_retry_checkout', 'org_retry_checkout'))
      .resolves.toMatchObject({
        authenticatedUserId: 'user_retry_checkout',
        selectedOrganizationId: 'org_retry_checkout',
        authorizationEpoch: '11',
      });

    expect(pg.poolConnect).toHaveBeenCalledTimes(2);
    expect(query).toHaveBeenCalledWith(
      "SELECT set_config('statement_timeout', $1, true)",
      ['1300ms'],
    );
    expect(release).toHaveBeenCalledTimes(1);

    await db.closeDatabase();
  });

  it('does not multiply snapshot retries inside pool checkout', async () => {
    const pg = mockPg();
    const unexpectedClient = { query: vi.fn(), release: vi.fn() };
    pg.poolConnect
      .mockRejectedValueOnce(Object.assign(new Error('first reset'), { code: 'ECONNRESET' }))
      .mockRejectedValueOnce(Object.assign(new Error('second reset'), { code: 'ECONNRESET' }))
      .mockResolvedValueOnce(unexpectedClient);

    const db = await import('../../src/db/client.js');
    const snapshots = await import('../../src/db/user-authorization-snapshot-db.js');
    db.initializeDatabase({ connectionString: 'postgresql://localhost/test' });

    await expect(snapshots.loadAuthorizationSnapshot('user_two_attempts', 'org_two_attempts'))
      .rejects.toBeInstanceOf(snapshots.AuthorizationSnapshotUnavailableError);
    expect(pg.poolConnect).toHaveBeenCalledTimes(2);
    expect(unexpectedClient.query).not.toHaveBeenCalled();
    expect(unexpectedClient.release).not.toHaveBeenCalled();

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
