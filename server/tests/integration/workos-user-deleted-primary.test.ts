/**
 * Automatic promotion containment: historical multi-credential bindings must
 * not change primary routing when a provider deletes a credential. Ordinary
 * deletion remains valid and must not silently promote a surviving credential.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { deleteIdentityCredential, promoteSecondaryIfPrimaryDeleted } from '../../src/db/identity-db.js';
import { bumpAuthorizationEpochs, getAuthorizationFingerprint } from '../../src/db/authorization-epoch-db.js';
import type { Pool } from 'pg';

const { notifySystemError, identityLogger } = vi.hoisted(() => ({
  notifySystemError: vi.fn(),
  identityLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../src/addie/error-notifier.js', () => ({ notifySystemError }));
vi.mock('../../src/logger.js', () => ({ createLogger: () => identityLogger }));

const TEST_USER_PREFIX = 'user_wh_deleted_test_';
const TEST_ORG = 'org_wh_deleted_test_pinnacle';

describe('user.deleted: automatic promotion containment (#6827)', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString:
        process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:5432/adcp_test',
    });
    await runMigrations();
  }, 60000);

  afterAll(async () => {
    await cleanup();
    await closeDatabase();
  });

  beforeEach(async () => {
    await cleanup();
    vi.clearAllMocks();
    notifySystemError.mockReset();
  });

  async function cleanup() {
    await pool.query(`DELETE FROM organization_memberships WHERE workos_user_id LIKE $1`, [`${TEST_USER_PREFIX}%`]);
    await pool.query(`DELETE FROM working_group_memberships WHERE workos_user_id LIKE $1`, [`${TEST_USER_PREFIX}%`]);
    await pool.query(`DELETE FROM working_group_leaders WHERE user_id LIKE $1`, [`${TEST_USER_PREFIX}%`]);
    await pool.query(`DELETE FROM users WHERE workos_user_id LIKE $1`, [`${TEST_USER_PREFIX}%`]);
    await pool.query(`DELETE FROM organizations WHERE workos_organization_id = $1`, [TEST_ORG]);
  }

  async function insertUser(suffix: string, email: string): Promise<string> {
    const userId = `${TEST_USER_PREFIX}${suffix}`;
    await pool.query(
      `INSERT INTO users (workos_user_id, email, first_name, last_name, email_verified,
                          workos_created_at, workos_updated_at, created_at, updated_at)
       VALUES ($1, $2, 'Test', 'User', true, NOW(), NOW(), NOW(), NOW())`,
      [userId, email]
    );
    return userId;
  }

  /**
   * Bind `secondaryUserId` as a non-primary credential on the same identity
   * as `primaryUserId`, mirroring what `mergeUsers` does when a secondary
   * sign-in email is linked. We do this directly rather than calling
   * mergeUsers so the test stays focused on the deletion path.
   */
  async function bindAsSecondary(
    primaryUserId: string,
    secondaryUserId: string,
    boundAtOffsetSeconds: number,
  ): Promise<string> {
    const identityResult = await pool.query<{ identity_id: string }>(
      `SELECT identity_id FROM identity_workos_users WHERE workos_user_id = $1`,
      [primaryUserId]
    );
    const identityId = identityResult.rows[0].identity_id;

    // Drop the secondary's singleton identity and re-point its binding
    // (mirrors the mergeUsers fixup in user-merge-db.ts).
    const oldIdentity = await pool.query<{ identity_id: string }>(
      `SELECT identity_id FROM identity_workos_users WHERE workos_user_id = $1`,
      [secondaryUserId]
    );
    await pool.query(
      `UPDATE identity_workos_users
          SET identity_id = $1,
              is_primary = FALSE,
              bound_at = NOW() + ($3 || ' seconds')::interval
        WHERE workos_user_id = $2`,
      [identityId, secondaryUserId, String(boundAtOffsetSeconds)]
    );
    if (oldIdentity.rows[0]?.identity_id && oldIdentity.rows[0].identity_id !== identityId) {
      await pool.query(`DELETE FROM identities WHERE id = $1`, [oldIdentity.rows[0].identity_id]);
    }
    return identityId;
  }

  it('refuses to choose among historical secondary credentials without changing bindings', async () => {
    const primary = await insertUser('primary', 'jordan@pinnacle.example');
    const olderSecondary = await insertUser('older', 'sam@pinnacle.example');
    const newerSecondary = await insertUser('newer', 'maya@pinnacle.example');
    const identityId = await bindAsSecondary(primary, olderSecondary, 1);
    await bindAsSecondary(primary, newerSecondary, 2);
    const before = await pool.query(
      `SELECT * FROM identity_workos_users WHERE identity_id = $1 ORDER BY workos_user_id`, [identityId],
    );

    await expect(promoteSecondaryIfPrimaryDeleted(primary)).rejects.toMatchObject({
      code: 'identity_mutation_disabled',
    });

    const after = await pool.query(
      `SELECT * FROM identity_workos_users WHERE identity_id = $1 ORDER BY workos_user_id`, [identityId],
    );
    expect(after.rows).toEqual(before.rows);
  });

  it.each(['primary', 'secondary'])('refuses %s promotion calls, including replays', async (target) => {
    const primary = await insertUser('replay_primary', 'jordan-replay@pinnacle.example');
    const secondary = await insertUser('replay_secondary', 'sam-replay@pinnacle.example');
    const identityId = await bindAsSecondary(primary, secondary, 1);
    const before = await pool.query(
      `SELECT * FROM identity_workos_users WHERE identity_id = $1 ORDER BY workos_user_id`, [identityId],
    );
    const userId = target === 'primary' ? primary : secondary;
    for (const result of await Promise.allSettled(Array.from({ length: 8 }, () => promoteSecondaryIfPrimaryDeleted(userId)))) {
      expect(result.status).toBe('rejected');
      if (result.status === 'rejected') expect(result.reason).toMatchObject({ code: 'identity_mutation_disabled' });
    }
    await expect(promoteSecondaryIfPrimaryDeleted(userId)).rejects.toMatchObject({ code: 'identity_mutation_disabled' });
    const after = await pool.query(
      `SELECT * FROM identity_workos_users WHERE identity_id = $1 ORDER BY workos_user_id`, [identityId],
    );
    expect(after.rows).toEqual(before.rows);
  });

  it('allows ordinary deletion without promoting a historical secondary', async () => {
    const primary = await insertUser('cascade_primary', 'jordan-cascade@pinnacle.example');
    const secondary = await insertUser('cascade_secondary', 'sam-cascade@pinnacle.example');
    const identityId = await bindAsSecondary(primary, secondary, 1);
    await pool.query(`DELETE FROM users WHERE workos_user_id = $1`, [primary]);

    const survivors = await pool.query<{ workos_user_id: string; is_primary: boolean }>(
      `SELECT workos_user_id, is_primary FROM identity_workos_users WHERE identity_id = $1`, [identityId],
    );
    expect(survivors.rows).toEqual([{ workos_user_id: secondary, is_primary: false }]);
  });

  async function seedDeletionAuthority() {
    const primary = await insertUser('revoke_primary', 'jordan-revoke@pinnacle.example');
    const secondary = await insertUser('revoke_secondary', 'sam-revoke@pinnacle.example');
    const bystander = await insertUser('revoke_bystander', 'maya-revoke@pinnacle.example');
    const identityId = await bindAsSecondary(primary, secondary, 1);
    await bindAsSecondary(primary, bystander, 2);
    await pool.query(
      `INSERT INTO organizations (workos_organization_id, name) VALUES ($1, 'Pinnacle Agency')`, [TEST_ORG],
    );
    await pool.query(
      `INSERT INTO organization_memberships (workos_user_id, workos_organization_id, email, role)
       VALUES ($1, $4, 'jordan-revoke@pinnacle.example', 'owner'),
              ($2, $4, 'sam-revoke@pinnacle.example', 'member'),
              ($3, $4, 'maya-revoke@pinnacle.example', 'admin')`, [primary, secondary, bystander, TEST_ORG],
    );
    await pool.query(
      `UPDATE users SET primary_organization_id = $1 WHERE workos_user_id = ANY($2)`,
      [TEST_ORG, [primary, secondary, bystander]],
    );
    await pool.query(
      `INSERT INTO working_group_memberships (working_group_id, workos_user_id, status)
       SELECT id, $1, 'active' FROM working_groups WHERE slug = 'aao-admin'
       UNION ALL SELECT id, $2, 'inactive' FROM working_groups WHERE slug = 'aao-admin'`, [bystander, secondary],
    );
    await pool.query(
      `INSERT INTO working_group_leaders (working_group_id, user_id)
       SELECT id, $1 FROM working_groups WHERE slug = 'aao-admin'`, [bystander],
    );
    await bumpAuthorizationEpochs(pool, [primary, secondary, bystander]);
    return { primary, secondary, bystander, identityId };
  }

  async function survivorAuthority(ids: string[]) {
    const tables = [
      ['users', 'workos_user_id'],
      ['identity_workos_users', 'workos_user_id'],
      ['organization_memberships', 'workos_user_id'],
      ['working_group_memberships', 'workos_user_id'],
      ['working_group_leaders', 'user_id'],
    ];
    const state: Record<string, unknown> = {};
    for (const [table, column] of tables) {
      const result = await pool.query(
        `SELECT row_to_json(row) AS row FROM (SELECT * FROM ${table} WHERE ${column} = ANY($1)) row
         ORDER BY row_to_json(row)::text`, [ids],
      );
      state[table] = result.rows.map(({ row }) => row);
    }
    return state;
  }

  it('atomically revokes former sibling caches without promoting or changing their authority', async () => {
    const { primary, secondary, bystander, identityId } = await seedDeletionAuthority();
    const survivors = [secondary, bystander];
    const authorityBefore = await survivorAuthority(survivors);
    const fingerprintsBefore = await Promise.all(survivors.map((id) => getAuthorizationFingerprint([id])));

    const results = await Promise.all([deleteIdentityCredential(primary), deleteIdentityCredential(primary)]);

    expect(results.flat()).toEqual(expect.arrayContaining([primary, secondary, bystander]));
    expect(await survivorAuthority(survivors)).toEqual(authorityBefore);
    for (const [index, id] of survivors.entries()) {
      expect(await getAuthorizationFingerprint([id])).not.toBe(fingerprintsBefore[index]);
    }
    expect((await pool.query(`SELECT 1 FROM users WHERE workos_user_id = $1`, [primary])).rows).toEqual([]);
    expect((await pool.query(`SELECT 1 FROM organization_memberships WHERE workos_user_id = $1`, [primary])).rows).toEqual([]);
    expect((await pool.query(
      `SELECT workos_user_id FROM identity_workos_users WHERE identity_id = $1 AND is_primary = TRUE`, [identityId],
    )).rows).toEqual([]);

    expect(notifySystemError).toHaveBeenCalledOnce();
    expect(identityLogger.warn).toHaveBeenCalledOnce();
    expect(identityLogger.warn.mock.calls[0][0]).toEqual({
      deletedUserId: primary,
      identityId,
      survivingCredentialCount: 2,
    });
    expect(notifySystemError).toHaveBeenCalledWith({
      source: 'identity-primary-missing',
      errorMessage: expect.stringContaining(identityId),
    });
    expect(JSON.stringify(notifySystemError.mock.calls)).not.toContain('@');

    const fingerprintAfter = await getAuthorizationFingerprint(survivors);
    await deleteIdentityCredential(primary);
    expect(await getAuthorizationFingerprint(survivors)).toBe(fingerprintAfter);
    expect(await survivorAuthority(survivors)).toEqual(authorityBefore);
    expect(notifySystemError).toHaveBeenCalledOnce();
    expect(identityLogger.warn).toHaveBeenCalledOnce();
  });

  it('rolls back epoch changes and deletion together when the database refuses deletion', async () => {
    const { primary, secondary, bystander } = await seedDeletionAuthority();
    const credentials = [primary, secondary, bystander];
    const before = await survivorAuthority(credentials);
    const fingerprintBefore = await getAuthorizationFingerprint(credentials);
    // A test-only referencing row forces a failure after the epoch bump.
    await pool.query(
      `CREATE TABLE identity_containment_delete_guard (
         workos_user_id TEXT REFERENCES users(workos_user_id) ON DELETE RESTRICT
       )`,
    );
    try {
      await pool.query(`INSERT INTO identity_containment_delete_guard VALUES ($1)`, [primary]);
      await expect(deleteIdentityCredential(primary)).rejects.toThrow();
      expect(await survivorAuthority(credentials)).toEqual(before);
      expect(await getAuthorizationFingerprint(credentials)).toBe(fingerprintBefore);
      expect(notifySystemError).not.toHaveBeenCalled();
      expect(identityLogger.warn).not.toHaveBeenCalled();
    } finally {
      await pool.query(`DROP TABLE identity_containment_delete_guard`);
    }
  });

  it('signals only after commit and connection release, with committed deletion visible to another connection', async () => {
    const { primary, secondary, bystander, identityId } = await seedDeletionAuthority();
    const observer = await pool.connect();
    try {
      // Keep an independent connection for visibility checks and leave another
      // idle connection for deletion, so release ordering is observable.
      await pool.query('SELECT 1');
      const idleBeforeDeletion = pool.idleCount;
      expect(idleBeforeDeletion).toBeGreaterThan(0);
      let idleAtSignal = -1;
      let stateAtSignal: Promise<{ rows: unknown[] }> | undefined;
      notifySystemError.mockImplementation(() => {
        idleAtSignal = pool.idleCount;
        stateAtSignal = observer.query(
          `SELECT
             EXISTS (SELECT 1 FROM users WHERE workos_user_id = $1) AS deleted_user_exists,
             EXISTS (SELECT 1 FROM organization_memberships WHERE workos_user_id = $1) AS deleted_membership_exists,
             (SELECT COUNT(*)::int FROM identity_workos_users WHERE identity_id = $2) AS survivors,
             (SELECT COUNT(*)::int FROM identity_workos_users WHERE identity_id = $2 AND is_primary) AS primaries,
             (SELECT MIN(epoch)::int FROM authorization_epochs WHERE workos_user_id = ANY($3)) AS survivor_epoch`,
          [primary, identityId, [secondary, bystander]],
        );
      });

      await deleteIdentityCredential(primary);

      expect(notifySystemError).toHaveBeenCalledOnce();
      expect(idleAtSignal).toBe(idleBeforeDeletion);
      expect((await stateAtSignal)?.rows).toEqual([{
        deleted_user_exists: false,
        deleted_membership_exists: false,
        survivors: 2,
        primaries: 0,
        survivor_epoch: 2,
      }]);
    } finally {
      observer.release();
    }
  });

  it.each([true, false])('does not signal when deleting the last binding (is_primary=%s) or replaying it', async (isPrimary) => {
    const userId = await insertUser('signal_singleton', 'jordan-singleton@pinnacle.example');
    if (!isPrimary) {
      await pool.query(`UPDATE identity_workos_users SET is_primary = FALSE WHERE workos_user_id = $1`, [userId]);
    }

    expect(await deleteIdentityCredential(userId)).toEqual([userId]);
    expect(await deleteIdentityCredential(userId)).toEqual([userId]);

    expect(notifySystemError).not.toHaveBeenCalled();
    expect(identityLogger.warn).not.toHaveBeenCalled();
  });

  it('does not signal secondary deletion while the original primary survives', async () => {
    const { primary, secondary, bystander } = await seedDeletionAuthority();
    const before = await survivorAuthority([primary, bystander]);

    await deleteIdentityCredential(secondary);

    expect(await survivorAuthority([primary, bystander])).toEqual(before);
    expect(notifySystemError).not.toHaveBeenCalled();
    expect(identityLogger.warn).not.toHaveBeenCalled();
  });

  it('signals an existing identity without a primary when another credential is deleted', async () => {
    const { primary, secondary, bystander, identityId } = await seedDeletionAuthority();
    // Historical invalid state is an input, never permission to choose a primary.
    await pool.query(`UPDATE identity_workos_users SET is_primary = FALSE WHERE workos_user_id = $1`, [primary]);
    const before = await survivorAuthority([primary, bystander]);

    await deleteIdentityCredential(secondary);

    expect(await survivorAuthority([primary, bystander])).toEqual(before);
    expect(notifySystemError).toHaveBeenCalledWith({
      source: 'identity-primary-missing',
      errorMessage: expect.stringContaining(identityId),
    });
    expect(identityLogger.warn.mock.calls[0][0]).toEqual({
      deletedUserId: secondary,
      identityId,
      survivingCredentialCount: 2,
    });
  });

  it('returns cache invalidation IDs and preserves committed revocation if notifying throws', async () => {
    const { primary, secondary, bystander } = await seedDeletionAuthority();
    const before = await survivorAuthority([secondary, bystander]);
    const notificationFailure = new Error('Notification transport unavailable');
    notifySystemError.mockImplementation(() => { throw notificationFailure; });

    await expect(deleteIdentityCredential(primary)).resolves.toEqual(expect.arrayContaining([primary, secondary, bystander]));

    expect((await pool.query(`SELECT 1 FROM users WHERE workos_user_id = $1`, [primary])).rows).toEqual([]);
    expect(await survivorAuthority([secondary, bystander])).toEqual(before);
    expect(await getAuthorizationFingerprint([secondary])).toBe(`${secondary}:2`);
    expect(await getAuthorizationFingerprint([bystander])).toBe(`${bystander}:2`);
    expect(identityLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: notificationFailure }),
      expect.any(String),
    );
  });

  it('deletes an account with accumulated community data', async () => {
    const userId = await insertUser('community', 'community@test.example');
    await pool.query(
      `INSERT INTO community_points (workos_user_id, action, points)
       VALUES ($1, 'test_activity', 1)`,
      [userId],
    );

    await expect(
      pool.query(`DELETE FROM users WHERE workos_user_id = $1`, [userId]),
    ).resolves.toMatchObject({ rowCount: 1 });

    const points = await pool.query(
      `SELECT 1 FROM community_points WHERE workos_user_id = $1`,
      [userId],
    );
    expect(points.rows).toHaveLength(0);
  });

  it('has no restrictive foreign keys pointing directly at users', async () => {
    const restrictive = await pool.query<{ table_name: string; constraint_name: string }>(
      `SELECT conrelid::regclass::text AS table_name, conname AS constraint_name
         FROM pg_constraint
        WHERE contype = 'f'
          AND confrelid = 'users'::regclass
          AND confdeltype IN ('a', 'r')
        ORDER BY conrelid::regclass::text, conname`,
    );

    expect(restrictive.rows).toEqual([]);
  });
});
