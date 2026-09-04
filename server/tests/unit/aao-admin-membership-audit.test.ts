import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  clientQuery: vi.fn(),
  release: vi.fn(),
}));

vi.mock('../../src/db/client.js', () => ({
  query: vi.fn(),
  getPool: () => ({
    connect: vi.fn().mockResolvedValue({ query: mocks.clientQuery, release: mocks.release }),
  }),
}));

vi.mock('../../src/addie/services/journey-computation.js', () => ({
  computeJourneyStage: vi.fn(),
}));

import { WorkingGroupDatabase } from '../../src/db/working-group-db.js';

function queryResult(rows: unknown[] = [], rowCount = rows.length) {
  return { rows, rowCount };
}

describe('AAO site-admin membership audit transaction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.clientQuery.mockImplementation((sql: string) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return Promise.resolve(queryResult());
      if (sql.includes('SELECT id FROM working_groups')) return Promise.resolve(queryResult([{ id: 'wg_aao_admin' }]));
      if (sql.includes('FROM slack_user_mappings')) return Promise.resolve(queryResult([{ workos_user_id: 'user_canonical' }]));
      if (sql.includes('INSERT INTO working_group_memberships')) {
        return Promise.resolve(queryResult([{ workos_user_id: 'user_canonical', working_group_id: 'wg_aao_admin' }]));
      }
      if (sql.includes('DELETE FROM working_group_memberships')) return Promise.resolve(queryResult([{ workos_user_id: 'user_canonical' }]));
      if (sql.includes('INSERT INTO aao_admin_access_events')) return Promise.resolve(queryResult());
      throw new Error(`Unexpected SQL: ${sql}`);
    });
  });

  it('commits the membership grant and immutable audit event together', async () => {
    const membership = await new WorkingGroupDatabase().grantAAOAdminMembership({
      targetUserId: 'slack_alias',
      actorUserId: 'admin_1',
      actorAuthorizationMechanism: 'break_glass_admin_email',
      reason: 'Temporary incident coverage',
    });

    expect(membership.workos_user_id).toBe('user_canonical');
    const auditCall = mocks.clientQuery.mock.calls.find(([sql]) => sql.includes('INSERT INTO aao_admin_access_events'));
    expect(auditCall?.[1]).toEqual([
      'admin_1',
      'user_canonical',
      'break_glass_admin_email',
      'Temporary incident coverage',
    ]);
    expect(mocks.clientQuery.mock.calls.map(([sql]) => sql)).toContain('COMMIT');
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it('records the revocation in the same transaction as the active-membership delete', async () => {
    const revokedUserId = await new WorkingGroupDatabase().revokeAAOAdminMembership({
      targetUserId: 'slack_alias',
      actorUserId: 'admin_1',
      actorAuthorizationMechanism: 'aao_admin_working_group',
      reason: 'Offboarding',
    });

    expect(revokedUserId).toBe('user_canonical');
    const calls = mocks.clientQuery.mock.calls.map(([sql]) => sql as string);
    expect(calls.findIndex((sql) => sql.includes('DELETE FROM working_group_memberships')))
      .toBeLessThan(calls.findIndex((sql) => sql.includes('INSERT INTO aao_admin_access_events')));
    expect(calls[calls.length - 1]).toBe('COMMIT');
  });

  it('rolls the membership write back when the audit insert fails', async () => {
    mocks.clientQuery.mockImplementation((sql: string) => {
      if (sql.includes('INSERT INTO aao_admin_access_events')) return Promise.reject(new Error('audit storage unavailable'));
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return Promise.resolve(queryResult());
      if (sql.includes('SELECT id FROM working_groups')) return Promise.resolve(queryResult([{ id: 'wg_aao_admin' }]));
      if (sql.includes('FROM slack_user_mappings')) return Promise.resolve(queryResult());
      if (sql.includes('INSERT INTO working_group_memberships')) return Promise.resolve(queryResult([{ workos_user_id: 'user_target' }]));
      throw new Error(`Unexpected SQL: ${sql}`);
    });

    await expect(new WorkingGroupDatabase().grantAAOAdminMembership({
      targetUserId: 'user_target',
      actorUserId: 'admin_1',
      actorAuthorizationMechanism: 'aao_admin_working_group',
      reason: 'Coverage rotation',
    })).rejects.toThrow('audit storage unavailable');

    expect(mocks.clientQuery.mock.calls.map(([sql]) => sql)).toContain('ROLLBACK');
    expect(mocks.clientQuery.mock.calls.map(([sql]) => sql)).not.toContain('COMMIT');
  });

  it('rolls an active-membership delete back when its revoke audit insert fails', async () => {
    mocks.clientQuery.mockImplementation((sql: string) => {
      if (sql.includes('INSERT INTO aao_admin_access_events')) return Promise.reject(new Error('audit storage unavailable'));
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return Promise.resolve(queryResult());
      if (sql.includes('SELECT id FROM working_groups')) return Promise.resolve(queryResult([{ id: 'wg_aao_admin' }]));
      if (sql.includes('FROM slack_user_mappings')) return Promise.resolve(queryResult());
      if (sql.includes('DELETE FROM working_group_memberships')) return Promise.resolve(queryResult([{ workos_user_id: 'user_target' }]));
      throw new Error(`Unexpected SQL: ${sql}`);
    });

    await expect(new WorkingGroupDatabase().revokeAAOAdminMembership({
      targetUserId: 'user_target',
      actorUserId: 'admin_1',
      actorAuthorizationMechanism: 'aao_admin_working_group',
      reason: 'Offboarding',
    })).rejects.toThrow('audit storage unavailable');

    const calls = mocks.clientQuery.mock.calls.map(([sql]) => sql as string);
    expect(calls).toContain('ROLLBACK');
    expect(calls).not.toContain('COMMIT');
  });
});
