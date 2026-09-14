import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock('../../src/db/client.js', () => ({ getPool: () => ({ connect: mocks.connect }) }));

import { CredentialDetachConflict, detachCredential, type DetachCredentialInput } from '../../src/db/credential-detach-db.js';

const input: DetachCredentialInput = {
  hostUserId: 'user_host', credentialId: 'user_target',
  expectedIdentityId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', expectedAuthorizationEpoch: '7',
  actorUserId: 'user_actor', actorCredentialId: 'user_actor',
  actorIdentityId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
};
const result = (rows: unknown[], rowCount: number | null = rows.length) => ({ rows, rowCount });
type Fault = (params: unknown[]) => unknown;

function clientWithFault(fragment = '', fault?: Fault) {
  let auditId: unknown;
  const client = {
    release: vi.fn(),
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      if (fault && sql.includes(fragment)) return fault(params);
      if (['BEGIN', 'COMMIT', 'ROLLBACK', 'SET CONSTRAINTS ALL IMMEDIATE'].includes(sql)) return result([]);
      if (sql.includes('pg_try_advisory_lock')) return result([{ acquired: true }]);
      if (sql.includes('pg_try_advisory_xact_lock')) return result([{ acquired: true }]);
      if (sql.includes('pg_advisory_unlock')) return result([{ unlocked: true }]);
      if (sql.includes('FROM admin_credential_bind_operations')) return result([]);
      if (sql.includes('AS blocked')) return result([{ blocked: false }]);
      if (sql.includes('SELECT id FROM identities')) return result([
        { id: input.actorIdentityId }, { id: input.expectedIdentityId },
      ]);
      if (sql.includes('FROM identity_workos_users')) return result([
        { workos_user_id: input.actorCredentialId, identity_id: input.actorIdentityId, is_primary: true },
        { workos_user_id: input.hostUserId, identity_id: input.expectedIdentityId, is_primary: true },
        { workos_user_id: input.credentialId, identity_id: input.expectedIdentityId, is_primary: false },
      ]);
      if (sql.includes('SELECT workos_user_id FROM users')) return result(
        (params[0] as string[]).map((workos_user_id) => ({ workos_user_id })),
      );
      if (sql.includes('SELECT workos_user_id, epoch::text FROM authorization_epochs')) return sql.includes('FOR UPDATE')
        ? result([{ workos_user_id: input.credentialId, epoch: '7' }])
        : result([{ workos_user_id: input.hostUserId, epoch: '1' }, { workos_user_id: input.credentialId, epoch: '8' }]);
      if (sql.includes('INSERT INTO identities')) return result([{ id: params[0] }]);
      if (sql.includes('UPDATE identity_workos_users')) return result([
        { workos_user_id: input.credentialId, identity_id: params[0], is_primary: true },
      ]);
      if (sql.includes('INSERT INTO authorization_epochs')) return result([
        { workos_user_id: input.hostUserId, epoch: '1' }, { workos_user_id: input.credentialId, epoch: '8' },
      ]);
      if (sql.includes('INSERT INTO registry_audit_log')) {
        auditId = params[0];
        return result([{ id: auditId }]);
      }
      if (sql.includes('FROM registry_audit_log')) return result([{ id: auditId, matches: true }]);
      throw new Error(`Unexpected SQL: ${sql}`);
    }),
  };
  mocks.connect.mockResolvedValue(client);
  return client;
}

function expectRollback(client: ReturnType<typeof clientWithFault>) {
  expect(client.query).toHaveBeenCalledWith('ROLLBACK');
  expect(client.query).not.toHaveBeenCalledWith('COMMIT');
  // A failed or uncertain session unlock cannot be returned to the pool.
  expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
}

describe('credential detach transaction integrity', () => {
  beforeEach(() => vi.clearAllMocks());

  it('orders identity locks deterministically and verifies every unlock before commit', async () => {
    const client = clientWithFault();
    const detached = await detachCredential(input);
    expect(detached.affectedCredentialIds).toEqual([input.hostUserId, input.credentialId]);
    const calls = client.query.mock.calls;
    const locks = calls.filter(([sql]) => sql.includes('pg_try_advisory_lock'));
    const unlocks = calls.filter(([sql]) => sql.includes('pg_advisory_unlock'));
    expect(locks.map(([, params]) => params)).toEqual([
      [`identity-binding:${input.actorIdentityId}`], [`identity-binding:${input.expectedIdentityId}`],
    ]);
    expect(unlocks.map(([, params]) => params)).toEqual(locks.map(([, params]) => params).reverse());
    const lifecycleLocks = calls.filter(([sql]) => sql.includes('pg_try_advisory_xact_lock'));
    expect(lifecycleLocks.map(([, params]) => params)).toEqual([
      [input.actorCredentialId], [input.hostUserId], [input.credentialId],
    ]);
    expect(calls.indexOf(lifecycleLocks[0])).toBeGreaterThan(calls.findIndex(([sql]) => sql.includes('FROM identity_workos_users')));
    expect(calls.indexOf(lifecycleLocks.at(-1)!)).toBeLessThan(calls.findIndex(([sql]) => sql.includes('FROM users')));
    expect(calls.at(-1)?.[0]).toBe('COMMIT');
    expect(calls.indexOf(unlocks.at(-1)!)).toBeLessThan(calls.findIndex(([sql]) => sql === 'COMMIT'));
    expect(client.release).toHaveBeenCalledExactlyOnceWith(false);
  });

  const invalidAuditResults: [string, Fault][] = [
    ['rowCount 0 and no row (suppressed INSERT)', () => result([])],
    ['rowCount 0 despite a returned row', ([id]) => result([{ id }], 0)],
    ['rowCount greater than one', ([id]) => result([{ id }, { id }], 2)],
    ['rowCount greater than one despite one returned row', ([id]) => result([{ id }], 2)],
    ['NULL rowCount', ([id]) => result([{ id }], null)],
    ['rowCount 1 with no row', () => result([], 1)],
    ['NULL returned row', () => result([null])],
    ['NULL returned id', () => result([{ id: null }])],
    ['missing returned id', () => result([{}])],
    ['different returned id', () => result([{ id: 'wrong-id' }])],
    ['thrown INSERT error', () => { throw new Error('injected audit failure'); }],
  ];
  it.each(invalidAuditResults)('rolls back and discards the connection for audit %s', async (_name, fault) => {
    const client = clientWithFault('INSERT INTO registry_audit_log', fault);
    await expect(detachCredential(input)).rejects.toThrow();
    expectRollback(client);
  });

  it.each(['pg_try_advisory_lock', 'pg_try_advisory_xact_lock', 'pg_advisory_unlock'])('rejects every invalid %s outcome', async (operation) => {
    const column = operation === 'pg_advisory_unlock' ? 'unlocked' : 'acquired';
    for (const badResult of [result([{ [column]: false }]), result([{ [column]: null }]),
      result([]), result([{ [column]: true }], 0), result([{ [column]: true }], null),
      result([{ [column]: true }, { [column]: true }], 2)]) {
      const client = clientWithFault(operation, () => badResult);
      await expect(detachCredential(input)).rejects.toThrow();
      expectRollback(client);
    }
    const client = clientWithFault(operation, () => { throw new Error('injected lock failure'); });
    await expect(detachCredential(input)).rejects.toThrow('injected lock failure');
    expectRollback(client);
  });

  it.each([result([]), result([{ id: 'duplicate' }, { id: 'duplicate' }]), result([{ id: null }])])(
    'rejects an audit removed or duplicated after INSERT: %j', async (stored) => {
      const client = clientWithFault("WHERE details->>'operation_id'", () => stored);
      await expect(detachCredential(input)).rejects.toThrow();
      expectRollback(client);
    },
  );

  it('keeps the original failure and destroys the connection when rollback also fails', async () => {
    const client = clientWithFault('INSERT INTO registry_audit_log', () => { throw new Error('audit unavailable'); });
    const query = client.query.getMockImplementation()!;
    client.query.mockImplementation(async (sql, params) => {
      if (sql === 'ROLLBACK') throw new Error('connection lost');
      return query(sql, params);
    });
    await expect(detachCredential(input)).rejects.toThrow('audit unavailable');
    expectRollback(client);
  });

  it('maps NOWAIT contention to a conflict and rolls back', async () => {
    const client = clientWithFault('SELECT id FROM identities', () => {
      throw Object.assign(new Error('could not obtain lock'), { code: '55P03' });
    });
    await expect(detachCredential(input)).rejects.toBeInstanceOf(CredentialDetachConflict);
    expectRollback(client);
  });

  it('requires every affected authorization epoch to advance', async () => {
    const client = clientWithFault('INSERT INTO authorization_epochs', () => result([
      { workos_user_id: input.credentialId, epoch: '8' },
    ]));
    await expect(detachCredential(input)).rejects.toThrow('authorization epochs');
    expectRollback(client);
    expect(client.query.mock.calls.some(([sql]) => sql.includes('INSERT INTO registry_audit_log'))).toBe(false);
  });

  it.each([result([{ blocked: true }]), result([{ blocked: null }]), result([{}]), result([]),
    result([{ blocked: false }], 0), result([{ blocked: false }], null),
    result([{ blocked: false }, { blocked: false }], 2)])('fails closed on unavailable/terminal lifecycle evidence: %j', async (marker) => {
    const client = clientWithFault('AS blocked', () => marker);
    await expect(detachCredential(input)).rejects.toThrow();
    expectRollback(client);
    expect(client.query.mock.calls.some(([sql]) => sql.includes('UPDATE identity_workos_users'))).toBe(false);
  });

  it('rechecks lifecycle evidence after deferred triggers and rolls back late quarantine', async () => {
    let checks = 0;
    const client = clientWithFault('AS blocked', () => result([{ blocked: ++checks > 1 }]));
    await expect(detachCredential(input)).rejects.toBeInstanceOf(CredentialDetachConflict);
    expectRollback(client);
    expect(client.query.mock.calls.some(([sql]) => sql.includes('INSERT INTO registry_audit_log'))).toBe(true);
  });

  it.each([result([], null), result([], 1), result([{ id: 'operation', provider_user_id: input.credentialId, status: 'reconciliation_required' }]),
    result([{ id: 'operation', provider_user_id: 'unexpected', status: 'committed' }])])(
    'fails closed on uncertain operation evidence: %j', async (operations) => {
      const client = clientWithFault('FROM admin_credential_bind_operations', () => operations);
      await expect(detachCredential(input)).rejects.toThrow();
      expectRollback(client);
    },
  );

  it('fails closed when the canonical actor user row is missing', async () => {
    const client = clientWithFault('SELECT workos_user_id FROM users', () => result([
      { workos_user_id: input.hostUserId }, { workos_user_id: input.credentialId },
    ]));
    await expect(detachCredential(input)).rejects.toBeInstanceOf(CredentialDetachConflict);
    expectRollback(client);
  });
});
