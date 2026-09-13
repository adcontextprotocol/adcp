/**
 * Automatic promotion containment: historical multi-credential bindings must
 * not change primary routing when a provider deletes a credential. Ordinary
 * deletion remains valid and must not silently promote a surviving credential.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

vi.mock('../../src/addie/error-notifier.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/addie/error-notifier.js')>()),
  notifySystemError: vi.fn(),
}));

import { initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import {
  getIdentityRecoveryQuarantine,
  IDENTITY_RECOVERY_STATE,
  promoteSecondaryIfPrimaryDeleted,
} from '../../src/db/identity-db.js';
import { deleteIdentityCredential } from '../../src/services/identity-credential-deletion.js';
import { bumpAuthorizationEpochs, getAuthorizationFingerprint } from '../../src/db/authorization-epoch-db.js';
import { notifySystemError } from '../../src/addie/error-notifier.js';
import { isSlackUserAAOAdmin } from '../../src/addie/mcp/admin-tools.js';
import {
  getUnifiedUsersCache,
  setUnifiedUsersCache,
} from '../../src/cache/unified-users.js';
import type { Pool } from 'pg';

const TEST_USER_PREFIX = 'user_wh_deleted_test_';
const TEST_SLACK_PREFIX = 'slack_wh_deleted_test_';
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
    await pool.query(
      `DELETE FROM registry_audit_log
        WHERE action IN ('identity_primary_deletion_quarantined', 'identity_credential_deleted')
          AND workos_user_id LIKE $1`,
      [`${TEST_USER_PREFIX}%`],
    );
    await pool.query(`DELETE FROM organization_memberships WHERE workos_user_id LIKE $1`, [`${TEST_USER_PREFIX}%`]);
    await pool.query(`DELETE FROM working_group_memberships WHERE workos_user_id LIKE $1`, [`${TEST_USER_PREFIX}%`]);
    await pool.query(`DELETE FROM working_group_leaders WHERE user_id LIKE $1`, [`${TEST_USER_PREFIX}%`]);
    await pool.query(`DELETE FROM slack_user_mappings WHERE slack_user_id LIKE $1`, [`${TEST_SLACK_PREFIX}%`]);
    await pool.query(`DELETE FROM users WHERE workos_user_id LIKE $1`, [`${TEST_USER_PREFIX}%`]);
    await pool.query(`DELETE FROM organizations WHERE workos_organization_id = $1`, [TEST_ORG]);
    vi.mocked(notifySystemError).mockClear();
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
       UNION ALL SELECT id, $2, 'active' FROM working_groups WHERE slug = 'aao-admin'
       UNION ALL SELECT id, $3, 'inactive' FROM working_groups WHERE slug = 'aao-admin'`,
      [primary, bystander, secondary],
    );
    await pool.query(
      `INSERT INTO working_group_leaders (working_group_id, user_id)
       SELECT id, $1 FROM working_groups WHERE slug = 'aao-admin'
       UNION ALL SELECT id, $2 FROM working_groups WHERE slug = 'aao-admin'`,
      [primary, bystander],
    );
    const slackUserId = `${TEST_SLACK_PREFIX}primary`;
    await pool.query(
      `INSERT INTO slack_user_mappings (
         slack_user_id, slack_email, workos_user_id, mapping_status, mapping_source, mapped_at
       ) VALUES ($1, 'jordan-revoke@pinnacle.example', $2, 'mapped', 'manual_admin', NOW())`,
      [slackUserId, primary],
    );
    await bumpAuthorizationEpochs(pool, [primary, secondary, bystander]);
    return { primary, secondary, bystander, identityId, slackUserId };
  }

  async function survivorAuthority(ids: string[]) {
    const tables = [
      ['users', 'workos_user_id'],
      ['identity_workos_users', 'workos_user_id'],
      ['organization_memberships', 'workos_user_id'],
      ['working_group_memberships', 'workos_user_id'],
      ['working_group_leaders', 'user_id'],
      ['slack_user_mappings', 'workos_user_id'],
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

  async function fullBeforeGraph(identityId: string, ids: string[]) {
    const queries = {
      identity: [`SELECT to_jsonb(i) AS row FROM identities i WHERE id = $1`, [identityId]],
      identity_workos_users: [
        `SELECT to_jsonb(iwu) AS row FROM identity_workos_users iwu
          WHERE iwu.identity_id = $1 ORDER BY iwu.workos_user_id`,
        [identityId],
      ],
      users: [
        `SELECT to_jsonb(u) AS row FROM users u
          WHERE u.workos_user_id = ANY($1) ORDER BY u.workos_user_id`,
        [ids],
      ],
      organization_memberships: [
        `SELECT to_jsonb(om) AS row FROM organization_memberships om
          WHERE om.workos_user_id = ANY($1)
          ORDER BY om.workos_user_id, om.workos_organization_id`,
        [ids],
      ],
      working_group_memberships: [
        `SELECT to_jsonb(wgm) AS row FROM working_group_memberships wgm
          WHERE wgm.workos_user_id = ANY($1)
          ORDER BY wgm.workos_user_id, wgm.working_group_id`,
        [ids],
      ],
      working_group_leaders: [
        `SELECT to_jsonb(wgl) AS row FROM working_group_leaders wgl
          WHERE wgl.user_id = ANY($1) ORDER BY wgl.user_id, wgl.working_group_id`,
        [ids],
      ],
      slack_user_mappings: [
        `SELECT to_jsonb(sm) AS row FROM slack_user_mappings sm
          WHERE sm.workos_user_id = ANY($1)
          ORDER BY sm.workos_user_id, sm.slack_user_id`,
        [ids],
      ],
      authorization_epochs: [
        `SELECT to_jsonb(ae) AS row FROM authorization_epochs ae
          WHERE ae.workos_user_id = ANY($1) ORDER BY ae.workos_user_id`,
        [ids],
      ],
    } as const;
    const entries = await Promise.all(Object.entries(queries).map(async ([key, [sql, params]]) => {
      const query = await pool.query(sql, params);
      return [key, key === 'identity' ? query.rows[0].row : query.rows.map(({ row }) => row)];
    }));
    return Object.fromEntries(entries);
  }

  it('serializes webhook-vs-backfill deletion, revokes caches, and records the exact recovery graph once', async () => {
    const { primary, secondary, bystander, identityId, slackUserId } = await seedDeletionAuthority();
    const survivors = [secondary, bystander];
    const allCredentials = [primary, secondary, bystander].sort();
    const authorityBefore = await survivorAuthority(survivors);
    const beforeGraph = await fullBeforeGraph(identityId, allCredentials);
    const fingerprintsBefore = await Promise.all(survivors.map((id) => getAuthorizationFingerprint([id])));
    expect(await isSlackUserAAOAdmin(slackUserId)).toBe(true);
    setUnifiedUsersCache(new Map([[TEST_ORG, [{ id: primary, email: 'jordan-revoke@pinnacle.example', firstName: 'Jordan', lastName: 'Test' }]]]));
    expect(getUnifiedUsersCache()).not.toBeNull();
    // Alert transport is post-commit and best-effort. Its exact failure path
    // must preserve durable quarantine, revocation, and cache invalidation.
    vi.mocked(notifySystemError).mockImplementation(() => {
      throw new Error('injected operator alert transport failure');
    });

    const results = await Promise.all([
      deleteIdentityCredential(primary, 'workos_webhook'),
      deleteIdentityCredential(primary, 'sync_users_backfill'),
    ]);

    expect(results.filter(({ deleted }) => deleted)).toHaveLength(1);
    expect(results.flatMap(({ affectedUserIds }) => affectedUserIds)).toEqual(
      expect.arrayContaining([primary, secondary, bystander]),
    );
    expect(getUnifiedUsersCache()).toBeNull();
    expect(await survivorAuthority(survivors)).toEqual(authorityBefore);
    for (const [index, id] of survivors.entries()) {
      expect(await getAuthorizationFingerprint([id])).not.toBe(fingerprintsBefore[index]);
    }
    expect((await pool.query(`SELECT 1 FROM users WHERE workos_user_id = $1`, [primary])).rows).toEqual([]);
    expect((await pool.query(`SELECT 1 FROM organization_memberships WHERE workos_user_id = $1`, [primary])).rows).toEqual([]);
    expect((await pool.query(
      `SELECT workos_user_id FROM identity_workos_users WHERE identity_id = $1 AND is_primary = TRUE`, [identityId],
    )).rows).toEqual([]);

    const auditRows = await pool.query(
      `SELECT id, details FROM registry_audit_log
        WHERE action = 'identity_primary_deletion_quarantined'
          AND resource_type = 'identity_recovery'
          AND resource_id = $1`,
      [identityId],
    );
    expect(auditRows.rows).toHaveLength(1);
    const durable = await getIdentityRecoveryQuarantine(identityId);
    expect(durable).toEqual({
      audit_id: auditRows.rows[0].id,
      identity_id: identityId,
      deleted_workos_user_id: primary,
      deletion_source: expect.stringMatching(/^(workos_webhook|sync_users_backfill)$/),
      actor: {
        type: 'workos_provider',
        source: expect.stringMatching(/^(workos_webhook|sync_users_backfill)$/),
        workos_user_id: primary,
      },
      recovery_state: IDENTITY_RECOVERY_STATE,
      before_graph: beforeGraph,
    });
    expect(notifySystemError).toHaveBeenCalledTimes(1);
    expect(notifySystemError).toHaveBeenCalledWith({
      source: `identity-primary-deletion-quarantine:${identityId}`,
      errorMessage: [
        `Primary credential ${primary} was deleted without promotion.`,
        `Identity ${identityId} is quarantined.`,
        `recovery_state=${IDENTITY_RECOVERY_STATE}.`,
        `audit_id=${auditRows.rows[0].id}.`,
      ].join(' '),
    });
    expect((await pool.query(
      `SELECT status FROM working_group_memberships WHERE workos_user_id = $1`,
      [primary],
    )).rows).toEqual([{ status: 'inactive' }]);
    expect((await pool.query(
      `SELECT 1 FROM working_group_leaders WHERE user_id = $1`,
      [primary],
    )).rows).toEqual([]);
    expect((await pool.query(
      `SELECT workos_user_id, mapping_status FROM slack_user_mappings WHERE slack_user_id = $1`,
      [slackUserId],
    )).rows).toEqual([{ workos_user_id: null, mapping_status: 'unmapped' }]);
    expect(await isSlackUserAAOAdmin(slackUserId)).toBe(false);

    const fingerprintAfter = await getAuthorizationFingerprint(survivors);
    await deleteIdentityCredential(primary, 'workos_webhook');
    expect(await getAuthorizationFingerprint(survivors)).toBe(fingerprintAfter);
    expect(await survivorAuthority(survivors)).toEqual(authorityBefore);
    expect((await pool.query(
      `SELECT 1 FROM registry_audit_log
        WHERE action = 'identity_primary_deletion_quarantined' AND resource_id = $1`,
      [identityId],
    )).rows).toHaveLength(1);
    expect(notifySystemError).toHaveBeenCalledTimes(1);
  });

  it('deletes a non-primary credential without quarantining or changing the primary', async () => {
    const { primary, secondary, identityId } = await seedDeletionAuthority();

    const deletion = await deleteIdentityCredential(secondary, 'workos_webhook');

    expect(deletion).toMatchObject({ deleted: true, quarantine: null });
    expect(await getIdentityRecoveryQuarantine(identityId)).toBeNull();
    expect((await pool.query(
      `SELECT workos_user_id FROM identity_workos_users
        WHERE identity_id = $1 AND is_primary = TRUE`,
      [identityId],
    )).rows).toEqual([{ workos_user_id: primary }]);
    expect(notifySystemError).not.toHaveBeenCalled();
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
      await expect(deleteIdentityCredential(primary, 'workos_webhook')).rejects.toThrow();
      expect(await survivorAuthority(credentials)).toEqual(before);
      expect(await getAuthorizationFingerprint(credentials)).toBe(fingerprintBefore);
      expect(await getIdentityRecoveryQuarantine((await pool.query<{ identity_id: string }>(
        `SELECT identity_id FROM identity_workos_users WHERE workos_user_id = $1`,
        [primary],
      )).rows[0].identity_id)).toBeNull();
      expect(notifySystemError).not.toHaveBeenCalled();
    } finally {
      await pool.query(`DROP TABLE identity_containment_delete_guard`);
    }
  });

  it('rolls back deletion and epochs when the durable quarantine audit write fails', async () => {
    const { primary, secondary, bystander, identityId } = await seedDeletionAuthority();
    const credentials = [primary, secondary, bystander];
    const before = await survivorAuthority(credentials);
    const fingerprintBefore = await getAuthorizationFingerprint(credentials);
    await pool.query(`
      CREATE OR REPLACE FUNCTION reject_identity_quarantine_audit() RETURNS trigger AS $$
      BEGIN
        IF NEW.action = 'identity_primary_deletion_quarantined' THEN
          RAISE EXCEPTION 'injected quarantine audit failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER reject_identity_quarantine_audit
        BEFORE INSERT ON registry_audit_log
        FOR EACH ROW EXECUTE FUNCTION reject_identity_quarantine_audit();
    `);
    try {
      await expect(deleteIdentityCredential(primary, 'sync_users_backfill'))
        .rejects.toThrow('injected quarantine audit failure');
      expect(await survivorAuthority(credentials)).toEqual(before);
      expect(await getAuthorizationFingerprint(credentials)).toBe(fingerprintBefore);
      expect(await getIdentityRecoveryQuarantine(identityId)).toBeNull();
      expect(notifySystemError).not.toHaveBeenCalled();
    } finally {
      await pool.query(`DROP TRIGGER reject_identity_quarantine_audit ON registry_audit_log`);
      await pool.query(`DROP FUNCTION reject_identity_quarantine_audit()`);
    }
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
