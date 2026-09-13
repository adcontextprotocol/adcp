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
  IDENTITY_DELETION_SNAPSHOT_MAX_DETAILS_BYTES,
  IDENTITY_DELETION_SNAPSHOT_POLICY,
  IDENTITY_RECOVERY_STATE,
  promoteSecondaryIfPrimaryDeleted,
  USER_CASCADE_SNAPSHOT_INVENTORY,
  USER_SET_NULL_SNAPSHOT_INVENTORY,
} from '../../src/db/identity-db.js';
import { deleteIdentityCredential } from '../../src/services/identity-credential-deletion.js';
import {
  bumpAuthorizationEpochs,
  getAuthorizationFingerprint,
  readCredentialAuthorizationLifecycle,
} from '../../src/db/authorization-epoch-db.js';
import { notifySystemError } from '../../src/addie/error-notifier.js';
import { isSlackUserAAOAdmin } from '../../src/addie/mcp/admin-tools.js';
import { getSlackAdminStatusCache } from '../../src/addie/admin-status-cache.js';
import {
  getUnifiedUsersCache,
  setUnifiedUsersCache,
} from '../../src/cache/unified-users.js';
import type { Pool } from 'pg';

const TEST_USER_PREFIX = 'user_wh_deleted_test_';
const TEST_SLACK_PREFIX = 'slack_wh_deleted_test_';
const TEST_ORG = 'org_wh_deleted_test_pinnacle';
const TEST_ORG_PREFIX = 'org_wh_deleted_test_';

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
    await pool.query(`DELETE FROM aao_admin_access_events WHERE target_user_id LIKE $1`, [`${TEST_USER_PREFIX}%`]);
    await pool.query(
      `DELETE FROM registry_audit_log
        WHERE action IN ('identity_primary_deletion_quarantined', 'identity_credential_deleted')
          AND workos_user_id LIKE $1`,
      [`${TEST_USER_PREFIX}%`],
    );
    await pool.query(`DELETE FROM organization_memberships WHERE workos_user_id LIKE $1`, [`${TEST_USER_PREFIX}%`]);
    await pool.query(
      `DELETE FROM working_group_memberships
        WHERE workos_user_id LIKE $1 OR workos_user_id LIKE $2`,
      [`${TEST_USER_PREFIX}%`, `${TEST_SLACK_PREFIX}%`],
    );
    await pool.query(
      `DELETE FROM working_group_leaders WHERE user_id LIKE $1 OR user_id LIKE $2`,
      [`${TEST_USER_PREFIX}%`, `${TEST_SLACK_PREFIX}%`],
    );
    await pool.query(
      `DELETE FROM working_group_topic_subscriptions
        WHERE workos_user_id LIKE $1 OR workos_user_id LIKE $2`,
      [`${TEST_USER_PREFIX}%`, `${TEST_SLACK_PREFIX}%`],
    );
    await pool.query(`DELETE FROM slack_user_mappings WHERE slack_user_id LIKE $1`, [`${TEST_SLACK_PREFIX}%`]);
    await pool.query(`DELETE FROM users WHERE workos_user_id LIKE $1`, [`${TEST_USER_PREFIX}%`]);
    await pool.query(`DELETE FROM organizations WHERE workos_organization_id LIKE $1`, [`${TEST_ORG_PREFIX}%`]);
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
    const grantOrganizations = [TEST_ORG, `${TEST_ORG_PREFIX}revoked`, `${TEST_ORG_PREFIX}expired`, `${TEST_ORG_PREFIX}future`];
    await pool.query(
      `INSERT INTO organizations (workos_organization_id, name)
       SELECT id, 'Deletion snapshot ' || id FROM unnest($1::text[]) AS id`,
      [grantOrganizations],
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
    await pool.query(
      `INSERT INTO organization_credential_grants (
         workos_organization_id, workos_user_id, role,
         granted_by_workos_user_id, reason, effective_from, effective_until,
         revoked_at, revoked_by_workos_user_id
       ) VALUES
         ($1, $5, 'owner', 'approver_active', 'active deletion grant', NOW() - INTERVAL '1 day', NULL, NULL, NULL),
         ($2, $5, 'admin', 'approver_revoked', 'revoked deletion grant', NOW() - INTERVAL '3 days', NULL, NOW() - INTERVAL '1 day', 'revoker_1'),
         ($3, $5, 'member', 'approver_expired', 'expired deletion grant', NOW() - INTERVAL '3 days', NOW() - INTERVAL '1 day', NULL, NULL),
         ($4, $5, 'admin', 'approver_future', 'future deletion grant', NOW() + INTERVAL '1 day', NOW() + INTERVAL '3 days', NULL, NULL)`,
      [...grantOrganizations, primary],
    );
    const aaoAdminGroup = await pool.query<{ id: string }>(
      `SELECT id FROM working_groups WHERE slug = 'aao-admin'`,
    );
    await pool.query(
      `INSERT INTO aao_admin_access_events (
         event_type, actor_user_id, target_user_id, mechanism,
         actor_authorization_mechanism, reason
       ) VALUES ('granted', 'admin_seed', $1, 'aao_admin_working_group',
                 'static_admin_api_key', 'seed active authority before provider deletion')`,
      [primary],
    );
    return {
      primary,
      secondary,
      bystander,
      identityId,
      slackUserId,
      aaoAdminGroupId: aaoAdminGroup.rows[0].id,
    };
  }

  async function survivorAuthority(ids: string[]) {
    const tables = [
      ['users', 'workos_user_id'],
      ['identity_workos_users', 'workos_user_id'],
      ['organization_memberships', 'workos_user_id'],
      ['working_group_memberships', 'workos_user_id'],
      ['working_group_leaders', 'user_id'],
      ['working_group_topic_subscriptions', 'workos_user_id'],
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
      working_group_topic_subscriptions: [
        `SELECT to_jsonb(wgts) AS row FROM working_group_topic_subscriptions wgts
          WHERE wgts.workos_user_id = ANY($1)
          ORDER BY wgts.workos_user_id, wgts.working_group_id`,
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
    const snapshotInventory = async (
      specs: readonly { readonly table: string; readonly columns: readonly string[] }[],
    ) => Object.fromEntries(await Promise.all(specs.map(async ({ table, columns }) => {
      const predicates = columns.map((column) => `child."${column}" = ANY($1)`).join(' OR ');
      const rows = await pool.query(
        `SELECT to_jsonb(child) AS row FROM "${table}" child
          WHERE ${predicates} ORDER BY to_jsonb(child)::text`,
        [ids],
      );
      return [table, rows.rows.map(({ row }) => row)];
    })));
    const baseGraph = Object.fromEntries(entries);
    const cascadeRows = await snapshotInventory(USER_CASCADE_SNAPSHOT_INVENTORY);
    cascadeRows.identity_workos_users = baseGraph.identity_workos_users;
    cascadeRows.authorization_epochs = baseGraph.authorization_epochs;
    return {
      ...baseGraph,
      user_cascade_rows: cascadeRows,
      user_set_null_attributions: await snapshotInventory(USER_SET_NULL_SNAPSHOT_INVENTORY),
    };
  }

  it('serializes webhook-vs-backfill deletion, revokes caches, and records the exact recovery graph once', async () => {
    const { primary, secondary, bystander, identityId, slackUserId, aaoAdminGroupId } = await seedDeletionAuthority();
    const survivors = [secondary, bystander];
    const allCredentials = [primary, secondary, bystander].sort();
    const authorityBefore = await survivorAuthority(survivors);
    const beforeGraph = await fullBeforeGraph(identityId, allCredentials);
    const fingerprintsBefore = await Promise.all(survivors.map((id) => getAuthorizationFingerprint([id])));
    expect(await isSlackUserAAOAdmin(slackUserId)).toBe(true);
    expect(getSlackAdminStatusCache().has(slackUserId)).toBe(false);
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
    const conflictingConcurrentReplay = results.find(({ replay }) => replay !== null);
    expect(conflictingConcurrentReplay?.replay).toMatchObject({
      kind: 'different_source',
      requested_deletion_source: expect.stringMatching(/^(workos_webhook|sync_users_backfill)$/),
      original_deletion_source: expect.stringMatching(/^(workos_webhook|sync_users_backfill)$/),
    });
    expect(conflictingConcurrentReplay?.replay?.requested_deletion_source)
      .not.toBe(conflictingConcurrentReplay?.replay?.original_deletion_source);
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
      `SELECT id, action, details FROM registry_audit_log
        WHERE workos_user_id = $1
          AND action IN ('identity_primary_deletion_quarantined', 'identity_credential_deleted')
        ORDER BY created_at, id`,
      [primary],
    );
    expect(auditRows.rows).toHaveLength(1);
    expect(auditRows.rows[0].action).toBe('identity_primary_deletion_quarantined');
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
      snapshot_policy: IDENTITY_DELETION_SNAPSHOT_POLICY,
      before_graph: beforeGraph,
      aao_admin_revocations: [{
        event_type: 'revoked',
        target_user_id: primary,
        working_group_id: aaoAdminGroupId,
        mechanism: 'aao_admin_working_group',
        actor: {
          type: 'workos_provider',
          source: expect.stringMatching(/^(workos_webhook|sync_users_backfill)$/),
          workos_user_id: primary,
        },
        evidence_ledger: 'registry_audit_log',
        dedicated_ledger_limitation: 'provider_deletion_actor_not_representable',
      }],
    });
    expect(notifySystemError).toHaveBeenCalledTimes(1);
    expect(notifySystemError).toHaveBeenCalledWith({
      source: `identity-primary-deletion-quarantine:${identityId}`,
      errorMessage: [
        `Credential ${primary} was deleted without promotion.`,
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
    expect(beforeGraph.user_cascade_rows.organization_credential_grants).toHaveLength(4);
    expect(beforeGraph.user_cascade_rows.organization_credential_grants.map((row: any) => ({
      role: row.role,
      granted_by: row.granted_by_workos_user_id,
      reason: row.reason,
      effective_from: row.effective_from,
      effective_until: row.effective_until,
      revoked_at: row.revoked_at,
      revoked_by: row.revoked_by_workos_user_id,
    }))).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'owner', granted_by: 'approver_active', reason: 'active deletion grant', revoked_at: null }),
      expect.objectContaining({ role: 'admin', granted_by: 'approver_revoked', reason: 'revoked deletion grant', revoked_by: 'revoker_1' }),
      expect.objectContaining({ role: 'member', granted_by: 'approver_expired', reason: 'expired deletion grant' }),
      expect.objectContaining({ role: 'admin', granted_by: 'approver_future', reason: 'future deletion grant' }),
    ]));
    expect((await pool.query(
      `SELECT event_type FROM aao_admin_access_events WHERE target_user_id = $1 ORDER BY created_at`,
      [primary],
    )).rows).toEqual([{ event_type: 'granted' }]);

    const fingerprintAfter = await getAuthorizationFingerprint(survivors);
    const allAuditRowsBeforeReplay = (await pool.query(
      `SELECT * FROM registry_audit_log WHERE workos_user_id = $1 ORDER BY created_at, id`,
      [primary],
    )).rows;
    const epochRowsBeforeReplay = (await pool.query(
      `SELECT * FROM authorization_epochs WHERE workos_user_id = ANY($1) ORDER BY workos_user_id`,
      [allCredentials],
    )).rows;
    const replayCache = new Map([[TEST_ORG, [{
      id: primary,
      email: 'must-remain-cached@test.example',
      firstName: 'Replay',
      lastName: 'Sentinel',
    }]]]);
    setUnifiedUsersCache(replayCache);
    const originalSource = durable!.deletion_source;
    const sameSourceReplay = await deleteIdentityCredential(primary, originalSource);
    expect(sameSourceReplay).toMatchObject({
      deleted: false,
      affectedUserIds: allCredentials,
      affectedSlackUserIds: [slackUserId],
      quarantine: durable,
      replay: {
        audit_id: auditRows.rows[0].id,
        kind: 'same_source',
        original_deletion_source: originalSource,
        requested_deletion_source: originalSource,
      },
    });
    const conflictingSource = originalSource === 'workos_webhook'
      ? 'sync_users_backfill'
      : 'workos_webhook';
    const conflictingReplay = await deleteIdentityCredential(primary, conflictingSource);
    expect(conflictingReplay).toMatchObject({
      deleted: false,
      affectedUserIds: allCredentials,
      affectedSlackUserIds: [slackUserId],
      quarantine: durable,
      replay: {
        audit_id: auditRows.rows[0].id,
        kind: 'different_source',
        original_deletion_source: originalSource,
        requested_deletion_source: conflictingSource,
      },
    });
    expect(await getAuthorizationFingerprint(survivors)).toBe(fingerprintAfter);
    expect(await survivorAuthority(survivors)).toEqual(authorityBefore);
    expect((await pool.query(
      `SELECT * FROM registry_audit_log WHERE workos_user_id = $1 ORDER BY created_at, id`,
      [primary],
    )).rows).toEqual(allAuditRowsBeforeReplay);
    expect((await pool.query(
      `SELECT * FROM authorization_epochs WHERE workos_user_id = ANY($1) ORDER BY workos_user_id`,
      [allCredentials],
    )).rows).toEqual(epochRowsBeforeReplay);
    expect(getUnifiedUsersCache()).toBe(replayCache);
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
    const auditRowsAfterDeletion = (await pool.query(
      `SELECT * FROM registry_audit_log WHERE workos_user_id = $1 ORDER BY created_at, id`,
      [secondary],
    )).rows;
    const epochRowsAfterDeletion = (await pool.query(
      `SELECT * FROM authorization_epochs
        WHERE workos_user_id = ANY($1) ORDER BY workos_user_id`,
      [[primary, secondary]],
    )).rows;
    expect(auditRowsAfterDeletion).toHaveLength(1);
    const replay = await deleteIdentityCredential(secondary, 'workos_webhook');
    expect(replay).toMatchObject({
      deleted: false,
      quarantine: null,
      replay: {
        audit_id: auditRowsAfterDeletion[0].id,
        kind: 'same_source',
        original_deletion_source: 'workos_webhook',
        requested_deletion_source: 'workos_webhook',
      },
    });
    expect((await pool.query(
      `SELECT * FROM registry_audit_log WHERE workos_user_id = $1 ORDER BY created_at, id`,
      [secondary],
    )).rows).toEqual(auditRowsAfterDeletion);
    expect((await pool.query(
      `SELECT * FROM authorization_epochs
        WHERE workos_user_id = ANY($1) ORDER BY workos_user_id`,
      [[primary, secondary]],
    )).rows).toEqual(epochRowsAfterDeletion);
    expect(notifySystemError).not.toHaveBeenCalled();
  });

  it('snapshots and revokes Slack-keyed authority and topic subscriptions for the deleted credential', async () => {
    const { primary, identityId, slackUserId, aaoAdminGroupId } = await seedDeletionAuthority();
    await pool.query(
      `INSERT INTO working_group_memberships (working_group_id, workos_user_id, status)
       VALUES ($1, $2, 'active')`,
      [aaoAdminGroupId, slackUserId],
    );
    await pool.query(
      `INSERT INTO working_group_leaders (working_group_id, user_id)
       VALUES ($1, $2)`,
      [aaoAdminGroupId, slackUserId],
    );
    await pool.query(
      `INSERT INTO working_group_topic_subscriptions (working_group_id, workos_user_id, topic_slugs)
       VALUES ($1, $2, ARRAY['deleted-topic'])`,
      [aaoAdminGroupId, slackUserId],
    );

    await deleteIdentityCredential(primary, 'workos_webhook');

    expect((await pool.query(
      `SELECT status FROM working_group_memberships
        WHERE working_group_id = $1 AND workos_user_id = $2`,
      [aaoAdminGroupId, slackUserId],
    )).rows).toEqual([{ status: 'inactive' }]);
    expect((await pool.query(
      `SELECT 1 FROM working_group_leaders WHERE working_group_id = $1 AND user_id = $2`,
      [aaoAdminGroupId, slackUserId],
    )).rows).toEqual([]);
    expect((await pool.query(
      `SELECT 1 FROM working_group_topic_subscriptions
        WHERE working_group_id = $1 AND workos_user_id = $2`,
      [aaoAdminGroupId, slackUserId],
    )).rows).toEqual([]);
    expect(await isSlackUserAAOAdmin(slackUserId)).toBe(false);

    const quarantine = await getIdentityRecoveryQuarantine(identityId);
    expect(quarantine?.before_graph.working_group_memberships).toEqual(
      expect.arrayContaining([expect.objectContaining({
        workos_user_id: slackUserId,
        working_group_id: aaoAdminGroupId,
        status: 'active',
      })]),
    );
    expect(quarantine?.before_graph.working_group_leaders).toEqual(
      expect.arrayContaining([expect.objectContaining({ user_id: slackUserId })]),
    );
    expect(quarantine?.before_graph.working_group_topic_subscriptions).toEqual(
      expect.arrayContaining([expect.objectContaining({
        workos_user_id: slackUserId,
        topic_slugs: ['deleted-topic'],
      })]),
    );
    expect(quarantine?.aao_admin_revocations.filter(
      (row) => row.target_user_id === slackUserId,
    )).toHaveLength(1);
  });

  it('quarantines a corrupt zero-primary identity when deleting a secondary leaves survivors', async () => {
    const { primary, secondary, bystander, identityId } = await seedDeletionAuthority();
    const credentials = [primary, secondary, bystander].sort();
    await pool.query(
      `UPDATE identity_workos_users SET is_primary = FALSE WHERE identity_id = $1`,
      [identityId],
    );
    await expect(readCredentialAuthorizationLifecycle(secondary)).resolves.toEqual({
      status: 'terminal',
      reason: 'missing_primary',
    });
    const beforeGraph = await fullBeforeGraph(identityId, credentials);

    const deletion = await deleteIdentityCredential(secondary, 'workos_webhook');
    expect(deletion.deleted).toBe(true);
    const auditRows = await pool.query<{ id: string }>(
      `SELECT id FROM registry_audit_log
        WHERE action = 'identity_primary_deletion_quarantined' AND resource_id = $1`,
      [identityId],
    );
    expect(auditRows.rows).toHaveLength(1);
    expect(await getIdentityRecoveryQuarantine(identityId)).toEqual({
      audit_id: auditRows.rows[0].id,
      identity_id: identityId,
      deleted_workos_user_id: secondary,
      deletion_source: 'workos_webhook',
      actor: { type: 'workos_provider', source: 'workos_webhook', workos_user_id: secondary },
      recovery_state: IDENTITY_RECOVERY_STATE,
      snapshot_policy: IDENTITY_DELETION_SNAPSHOT_POLICY,
      before_graph: beforeGraph,
      aao_admin_revocations: [],
    });
    expect(notifySystemError).toHaveBeenCalledWith({
      source: `identity-primary-deletion-quarantine:${identityId}`,
      errorMessage: [
        `Credential ${secondary} was deleted without promotion.`,
        `Identity ${identityId} is quarantined.`,
        `recovery_state=${IDENTITY_RECOVERY_STATE}.`,
        `audit_id=${auditRows.rows[0].id}.`,
      ].join(' '),
    });
    expect((await pool.query(
      `SELECT workos_user_id FROM identity_workos_users
        WHERE identity_id = $1 AND is_primary = TRUE`,
      [identityId],
    )).rows).toEqual([]);
  });

  it.each(['quarantine-primary', 'non-primary', 'singleton', 'unbound'] as const)(
    'rolls back every side effect when DELETE RETURNING yields no row on the %s path',
    async (path) => {
      let target: string;
      let credentials: string[];
      if (path === 'quarantine-primary' || path === 'non-primary') {
        const seeded = await seedDeletionAuthority();
        target = path === 'quarantine-primary' ? seeded.primary : seeded.secondary;
        credentials = [seeded.primary, seeded.secondary, seeded.bystander];
      } else {
        target = await insertUser(`return_null_${path}`, `${path}@return-null.test`);
        credentials = [target];
        await pool.query(
          `INSERT INTO organizations (workos_organization_id, name)
           VALUES ($1, 'RETURN NULL test')`,
          [TEST_ORG],
        );
        await pool.query(
          `INSERT INTO organization_memberships (
             workos_user_id, workos_organization_id, email, role
           ) VALUES ($1, $2, $3, 'admin')`,
          [target, TEST_ORG, `${path}@return-null.test`],
        );
        if (path === 'unbound') {
          const binding = await pool.query<{ identity_id: string }>(
            `DELETE FROM identity_workos_users WHERE workos_user_id = $1 RETURNING identity_id`,
            [target],
          );
          await pool.query(`DELETE FROM identities WHERE id = $1`, [binding.rows[0].identity_id]);
        }
        await bumpAuthorizationEpochs(pool, [target]);
      }
      const slackUserId = `${TEST_SLACK_PREFIX}return_null_${path}`;
      await pool.query(
        `INSERT INTO slack_user_mappings (
           slack_user_id, slack_email, workos_user_id, mapping_status, mapping_source, mapped_at
         ) VALUES ($1, $2, $3, 'mapped', 'manual_admin', NOW())
         ON CONFLICT (slack_user_id) DO UPDATE
           SET workos_user_id = EXCLUDED.workos_user_id,
               mapping_status = 'mapped', mapping_source = 'manual_admin', mapped_at = NOW()`,
        [slackUserId, `${path}@return-null.test`, target],
      );
      const before = await survivorAuthority(credentials);
      const fingerprintBefore = await getAuthorizationFingerprint(credentials);
      await pool.query(`
        CREATE FUNCTION suppress_confirmed_user_delete() RETURNS trigger AS $$
        BEGIN
          IF OLD.workos_user_id = '${target}' THEN
            RETURN NULL;
          END IF;
          RETURN OLD;
        END;
        $$ LANGUAGE plpgsql;
        CREATE TRIGGER suppress_confirmed_user_delete
          BEFORE DELETE ON users
          FOR EACH ROW EXECUTE FUNCTION suppress_confirmed_user_delete();
      `);
      try {
        await expect(deleteIdentityCredential(target, 'workos_webhook'))
          .rejects.toThrow('Confirmed credential deletion did not delete exactly one locked user');
        expect(await survivorAuthority(credentials)).toEqual(before);
        expect(await getAuthorizationFingerprint(credentials)).toBe(fingerprintBefore);
        expect((await pool.query(
          `SELECT 1 FROM registry_audit_log
            WHERE workos_user_id = $1
              AND action IN ('identity_credential_deleted', 'identity_primary_deletion_quarantined')`,
          [target],
        )).rows).toEqual([]);
        expect(notifySystemError).not.toHaveBeenCalled();
      } finally {
        await pool.query(`DROP TRIGGER suppress_confirmed_user_delete ON users`);
        await pool.query(`DROP FUNCTION suppress_confirmed_user_delete()`);
      }
    },
  );

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
        IF NEW.workos_user_id = '${primary}'
           AND NEW.action = 'identity_primary_deletion_quarantined' THEN
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

  it.each(['insert', 'update'] as const)(
    'rolls back deletion when an authorization epoch %s trigger suppresses rows',
    async (operation) => {
      const { primary, secondary, bystander, identityId } = await seedDeletionAuthority();
      const credentials = [primary, secondary, bystander];
      if (operation === 'insert') {
        await pool.query(
          `DELETE FROM authorization_epochs WHERE workos_user_id = ANY($1)`,
          [credentials],
        );
      }
      const before = await survivorAuthority(credentials);
      const fingerprintBefore = await getAuthorizationFingerprint(credentials);
      const triggerOperation = operation.toUpperCase();
      await pool.query(`
        CREATE FUNCTION suppress_authorization_epoch_${operation}() RETURNS trigger AS $$
        BEGIN
          IF NEW.workos_user_id = '${primary}' THEN
            RETURN NULL;
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
        CREATE TRIGGER suppress_authorization_epoch_${operation}
          BEFORE ${triggerOperation} ON authorization_epochs
          FOR EACH ROW EXECUTE FUNCTION suppress_authorization_epoch_${operation}();
      `);
      try {
        await expect(deleteIdentityCredential(primary, 'workos_webhook'))
          .rejects.toThrow('did not bump every live authorization epoch');
        expect(await survivorAuthority(credentials)).toEqual(before);
        expect(await getAuthorizationFingerprint(credentials)).toBe(fingerprintBefore);
        expect(await getIdentityRecoveryQuarantine(identityId)).toBeNull();
        expect((await pool.query(
          `SELECT 1 FROM registry_audit_log
            WHERE workos_user_id = $1
              AND action IN ('identity_credential_deleted', 'identity_primary_deletion_quarantined')`,
          [primary],
        )).rows).toEqual([]);
        expect(notifySystemError).not.toHaveBeenCalled();
      } finally {
        await pool.query(
          `DROP TRIGGER suppress_authorization_epoch_${operation} ON authorization_epochs`,
        );
        await pool.query(`DROP FUNCTION suppress_authorization_epoch_${operation}()`);
      }
    },
  );

  it('rolls back deletion when the deletion-audit INSERT returns no row', async () => {
    const { primary, secondary, bystander, identityId } = await seedDeletionAuthority();
    const credentials = [primary, secondary, bystander];
    const before = await survivorAuthority(credentials);
    const fingerprintBefore = await getAuthorizationFingerprint(credentials);
    await pool.query(`
      CREATE FUNCTION suppress_identity_deletion_audit() RETURNS trigger AS $$
      BEGIN
        IF NEW.workos_user_id = '${primary}'
           AND NEW.action IN ('identity_credential_deleted', 'identity_primary_deletion_quarantined') THEN
          RETURN NULL;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER suppress_identity_deletion_audit
        BEFORE INSERT ON registry_audit_log
        FOR EACH ROW EXECUTE FUNCTION suppress_identity_deletion_audit();
    `);
    try {
      await expect(deleteIdentityCredential(primary, 'workos_webhook'))
        .rejects.toThrow('audit was not durably recorded');
      expect(await survivorAuthority(credentials)).toEqual(before);
      expect(await getAuthorizationFingerprint(credentials)).toBe(fingerprintBefore);
      expect(await getIdentityRecoveryQuarantine(identityId)).toBeNull();
      expect((await pool.query(
        `SELECT 1 FROM registry_audit_log
          WHERE workos_user_id = $1
            AND action IN ('identity_credential_deleted', 'identity_primary_deletion_quarantined')`,
        [primary],
      )).rows).toEqual([]);
      expect(notifySystemError).not.toHaveBeenCalled();
    } finally {
      await pool.query(`DROP TRIGGER suppress_identity_deletion_audit ON registry_audit_log`);
      await pool.query(`DROP FUNCTION suppress_identity_deletion_audit()`);
    }
  });

  it('retains row provenance without copying binary PII or email-link bearer secrets', async () => {
    const userId = await insertUser('binary_snapshot', 'binary-snapshot@test.example');
    const rawLinkToken = 'raw-email-link-token-must-not-enter-durable-audit';
    await pool.query(
      `INSERT INTO user_avatar_uploads (workos_user_id, image_data, content_type)
       VALUES ($1, $2, 'image/png')`,
      [userId, Buffer.alloc(64, 0xab)],
    );
    await pool.query(
      `INSERT INTO member_portraits (user_id, image_url, portrait_data, palette, status)
       VALUES ($1, 'https://example.test/portrait.png', $2, 'amber', 'approved')`,
      [userId, Buffer.alloc(96, 0xcd)],
    );
    await pool.query(
      `INSERT INTO email_link_tokens (
         token, primary_workos_user_id, target_email, status, expires_at
       ) VALUES ($1, $2, 'linked-target@test.example', 'pending', NOW() + INTERVAL '1 hour')`,
      [rawLinkToken, userId],
    );

    await expect(deleteIdentityCredential(userId, 'workos_webhook'))
      .resolves.toMatchObject({ deleted: true });
    const audit = await pool.query<{ details: any }>(
      `SELECT details FROM registry_audit_log
        WHERE workos_user_id = $1 AND action = 'identity_credential_deleted'`,
      [userId],
    );
    expect(audit.rows).toHaveLength(1);
    const avatar = audit.rows[0].details.before_graph.user_cascade_rows.user_avatar_uploads[0];
    expect(avatar).toMatchObject({
      workos_user_id: userId,
      content_type: 'image/png',
      image_data_redacted: true,
      image_data_byte_length: 64,
    });
    expect(avatar).not.toHaveProperty('image_data');
    const portrait = audit.rows[0].details.before_graph.user_cascade_rows.member_portraits[0];
    expect(portrait).toMatchObject({
      user_id: userId,
      image_url: 'https://example.test/portrait.png',
      portrait_data_redacted: true,
      portrait_data_byte_length: 96,
    });
    expect(portrait).not.toHaveProperty('portrait_data');
    const emailLinkToken =
      audit.rows[0].details.before_graph.user_cascade_rows.email_link_tokens[0];
    expect(emailLinkToken).toMatchObject({
      primary_workos_user_id: userId,
      target_email: 'linked-target@test.example',
      status: 'pending',
      token_redacted: true,
    });
    expect(emailLinkToken).not.toHaveProperty('token');
    expect(JSON.stringify(audit.rows[0].details)).not.toContain(rawLinkToken);
    expect(audit.rows[0].details.snapshot_policy).toEqual(IDENTITY_DELETION_SNAPSHOT_POLICY);
    expect(Buffer.byteLength(JSON.stringify(audit.rows[0].details), 'utf8'))
      .toBeLessThanOrEqual(IDENTITY_DELETION_SNAPSHOT_MAX_DETAILS_BYTES);
  });

  it('fails closed before deletion when the complete durable snapshot exceeds its byte bound', async () => {
    const userId = await insertUser('snapshot_bound', 'snapshot-bound@test.example');
    await pool.query(
      `INSERT INTO email_link_tokens (
         token, primary_workos_user_id, target_email, status, expires_at, merge_summary
       ) VALUES (
         'snapshot-bound-token', $1, 'bounded-target@test.example', 'pending',
         NOW() + INTERVAL '1 hour', jsonb_build_object('payload', repeat('x', $2))
       )`,
      [userId, IDENTITY_DELETION_SNAPSHOT_MAX_DETAILS_BYTES],
    );

    await expect(deleteIdentityCredential(userId, 'workos_webhook'))
      .rejects.toThrow('snapshot exceeds the fail-closed byte limit');
    expect((await pool.query(
      `SELECT 1 FROM users WHERE workos_user_id = $1`,
      [userId],
    )).rows).toHaveLength(1);
    expect((await pool.query(
      `SELECT 1 FROM email_link_tokens WHERE primary_workos_user_id = $1`,
      [userId],
    )).rows).toHaveLength(1);
    expect((await pool.query(
      `SELECT 1 FROM registry_audit_log WHERE workos_user_id = $1`,
      [userId],
    )).rows).toEqual([]);
  });

  it('rolls back deletion, audit, and authority when an AAO-admin deactivation returns no row', async () => {
    const { primary, secondary, bystander, identityId } = await seedDeletionAuthority();
    const credentials = [primary, secondary, bystander];
    const before = await survivorAuthority(credentials);
    const fingerprintBefore = await getAuthorizationFingerprint(credentials);
    await pool.query(`
      CREATE FUNCTION suppress_aao_admin_deactivation() RETURNS trigger AS $$
      BEGIN
        IF OLD.workos_user_id = '${primary}' AND NEW.status = 'inactive' THEN
          RETURN NULL;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER suppress_aao_admin_deactivation
        BEFORE UPDATE ON working_group_memberships
        FOR EACH ROW EXECUTE FUNCTION suppress_aao_admin_deactivation();
    `);
    try {
      await expect(deleteIdentityCredential(primary, 'workos_webhook'))
        .rejects.toThrow('did not deactivate every working-group membership');
      expect(await survivorAuthority(credentials)).toEqual(before);
      expect(await getAuthorizationFingerprint(credentials)).toBe(fingerprintBefore);
      expect(await getIdentityRecoveryQuarantine(identityId)).toBeNull();
      expect((await pool.query(
        `SELECT event_type FROM aao_admin_access_events WHERE target_user_id = $1`, [primary],
      )).rows).toEqual([{ event_type: 'granted' }]);
      expect(notifySystemError).not.toHaveBeenCalled();
    } finally {
      await pool.query(`DROP TRIGGER suppress_aao_admin_deactivation ON working_group_memberships`);
      await pool.query(`DROP FUNCTION suppress_aao_admin_deactivation()`);
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

  it('keeps the durable snapshot inventory synchronized with every users FK deletion action', async () => {
    const readInventory = async (deleteType: 'c' | 'n') => {
      const rows = await pool.query<{ table_name: string; column_name: string }>(
        `SELECT con.conrelid::regclass::text AS table_name, attr.attname AS column_name
           FROM pg_constraint con
           JOIN LATERAL unnest(con.conkey) AS key(attnum) ON TRUE
           JOIN pg_attribute attr
             ON attr.attrelid = con.conrelid AND attr.attnum = key.attnum
          WHERE con.contype = 'f'
            AND con.confrelid = 'users'::regclass
            AND con.confdeltype = $1
          ORDER BY table_name, column_name`,
        [deleteType],
      );
      const grouped = new Map<string, string[]>();
      for (const row of rows.rows) {
        grouped.set(row.table_name, [...(grouped.get(row.table_name) ?? []), row.column_name]);
      }
      return [...grouped].map(([table, columns]) => ({ table, columns: columns.sort() }));
    };
    const normalize = (specs: readonly { readonly table: string; readonly columns: readonly string[] }[]) =>
      specs.map(({ table, columns }) => ({ table, columns: [...columns].sort() }))
        .sort((a, b) => a.table.localeCompare(b.table));

    expect(await readInventory('c')).toEqual(normalize(USER_CASCADE_SNAPSHOT_INVENTORY));
    expect(await readInventory('n')).toEqual(normalize(USER_SET_NULL_SNAPSHOT_INVENTORY));
  });
});
