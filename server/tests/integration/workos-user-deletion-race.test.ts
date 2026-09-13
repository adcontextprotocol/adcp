import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';

const mocks = vi.hoisted(() => ({
  constructEvent: vi.fn(),
  getUser: vi.fn(),
  listUsers: vi.fn(),
  invalidateSessionsForUsers: vi.fn(),
  notifySystemError: vi.fn(),
  deletionEntrants: [] as Array<{ workosUserId: string; source: string }>,
  deletionWaiters: [] as Array<() => void>,
}));

vi.mock('../../src/auth/workos-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/auth/workos-client.js')>()),
  getWorkos: () => ({
    webhooks: { constructEvent: mocks.constructEvent },
    userManagement: {
      getUser: mocks.getUser,
      listUsers: mocks.listUsers,
    },
  }),
}));

vi.mock('../../src/middleware/auth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/middleware/auth.js')>()),
  invalidateSessionsForUsers: mocks.invalidateSessionsForUsers,
}));

vi.mock('../../src/addie/error-notifier.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/addie/error-notifier.js')>()),
  notifySystemError: mocks.notifySystemError,
}));

vi.mock('../../src/services/identity-credential-deletion.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/identity-credential-deletion.js')>();
  return {
    ...actual,
    deleteIdentityCredential: async (
      workosUserId: string,
      source: 'workos_webhook' | 'sync_users_backfill',
    ) => {
      if (workosUserId === 'user_wh_backfill_race_primary') {
        mocks.deletionEntrants.push({ workosUserId, source });
        await new Promise<void>((resolve) => {
          mocks.deletionWaiters.push(resolve);
          if (mocks.deletionWaiters.length === 2) {
            for (const release of mocks.deletionWaiters.splice(0)) release();
          }
        });
      }
      return actual.deleteIdentityCredential(workosUserId, source);
    },
  };
});

process.env.WORKOS_WEBHOOK_SECRET = 'test_workos_webhook_secret';

const { initializeDatabase, closeDatabase } = await import('../../src/db/client.js');
const { runMigrations } = await import('../../src/db/migrate.js');
const { getAuthorizationFingerprint } = await import('../../src/db/authorization-epoch-db.js');
const { getIdentityRecoveryQuarantine, IDENTITY_RECOVERY_STATE } = await import('../../src/db/identity-db.js');
const { createWorkOSWebhooksRouter, backfillUsers } = await import('../../src/routes/workos-webhooks.js');
const { getUnifiedUsersCache, setUnifiedUsersCache } = await import('../../src/cache/unified-users.js');
const { isSlackUserAAOAdmin } = await import('../../src/addie/mcp/admin-tools.js');

const PREFIX = 'user_wh_backfill_race_';
const PRIMARY = `${PREFIX}primary`;
const SECONDARY = `${PREFIX}secondary`;
const BYSTANDER = `${PREFIX}bystander`;
const ORG = 'org_wh_backfill_race_pinnacle';
const SLACK = 'slack_wh_backfill_race_primary';

describe('WorkOS webhook vs sync-users deletion', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString:
        process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:5432/adcp_test',
    });
    await runMigrations();
  }, 60_000);

  afterAll(async () => {
    await cleanup();
    await closeDatabase();
  });

  beforeEach(async () => {
    await cleanup();
    vi.clearAllMocks();
    mocks.deletionEntrants.length = 0;
    mocks.deletionWaiters.length = 0;
  });

  async function cleanup() {
    await pool.query(`DROP TRIGGER IF EXISTS delay_racing_user_delete ON users`);
    await pool.query(`DROP FUNCTION IF EXISTS delay_racing_user_delete()`);
    await pool.query(
      `DELETE FROM registry_audit_log
        WHERE action IN ('identity_primary_deletion_quarantined', 'identity_credential_deleted')
          AND workos_user_id LIKE $1`,
      [`${PREFIX}%`],
    );
    await pool.query(`DELETE FROM working_group_memberships WHERE workos_user_id LIKE $1`, [`${PREFIX}%`]);
    await pool.query(`DELETE FROM working_group_leaders WHERE user_id LIKE $1`, [`${PREFIX}%`]);
    await pool.query(`DELETE FROM slack_user_mappings WHERE slack_user_id = $1`, [SLACK]);
    await pool.query(`DELETE FROM organization_memberships WHERE workos_user_id LIKE $1`, [`${PREFIX}%`]);
    await pool.query(`DELETE FROM users WHERE workos_user_id LIKE $1`, [`${PREFIX}%`]);
    await pool.query(`DELETE FROM organizations WHERE workos_organization_id = $1`, [ORG]);
  }

  async function seedIdentity() {
    await pool.query(
      `INSERT INTO organizations (workos_organization_id, name) VALUES ($1, 'Pinnacle Agency')`,
      [ORG],
    );
    for (const [id, email] of [
      [PRIMARY, 'jordan-race@pinnacle.example'],
      [SECONDARY, 'sam-race@pinnacle.example'],
      [BYSTANDER, 'maya-race@pinnacle.example'],
    ]) {
      await pool.query(
        `INSERT INTO users (
           workos_user_id, email, first_name, last_name, email_verified,
           workos_created_at, workos_updated_at, created_at, updated_at,
           primary_organization_id
         ) VALUES ($1, $2, 'Test', 'User', TRUE, NOW(), NOW(), NOW(), NOW(), $3)`,
        [id, email, ORG],
      );
      await pool.query(
        `INSERT INTO organization_memberships (
           workos_user_id, workos_organization_id, email, role
         ) VALUES ($1, $2, $3, 'member')`,
        [id, ORG, email],
      );
    }

    const identities = await pool.query<{ workos_user_id: string; identity_id: string }>(
      `SELECT workos_user_id, identity_id FROM identity_workos_users
        WHERE workos_user_id = ANY($1)`,
      [[PRIMARY, SECONDARY, BYSTANDER]],
    );
    const byUser = new Map(identities.rows.map((row) => [row.workos_user_id, row.identity_id]));
    const identityId = byUser.get(PRIMARY)!;
    await pool.query(
      `UPDATE identity_workos_users
          SET identity_id = $1, is_primary = FALSE
        WHERE workos_user_id = ANY($2)`,
      [identityId, [SECONDARY, BYSTANDER]],
    );
    await pool.query(`DELETE FROM identities WHERE id = ANY($1)`, [
      [byUser.get(SECONDARY), byUser.get(BYSTANDER)],
    ]);
    await pool.query(
      `INSERT INTO working_group_memberships (working_group_id, workos_user_id, status)
       SELECT id, $1, 'active' FROM working_groups WHERE slug = 'aao-admin'`,
      [PRIMARY],
    );
    await pool.query(
      `INSERT INTO working_group_leaders (working_group_id, user_id)
       SELECT id, $1 FROM working_groups WHERE slug = 'aao-admin'`,
      [PRIMARY],
    );
    await pool.query(
      `INSERT INTO slack_user_mappings (
         slack_user_id, slack_email, workos_user_id, mapping_status, mapping_source, mapped_at
       ) VALUES ($1, 'jordan-race@pinnacle.example', $2, 'mapped', 'manual_admin', NOW())`,
      [SLACK, PRIMARY],
    );
    return identityId;
  }

  it('serializes both real callers and invalidates cached authority exactly through the helper', async () => {
    const identityId = await seedIdentity();
    expect((await pool.query<{ workos_user_id: string }>(
      `SELECT workos_user_id FROM users WHERE workos_user_id LIKE $1 ORDER BY workos_user_id`,
      [`${PREFIX}%`],
    )).rows.map((row) => row.workos_user_id)).toEqual([BYSTANDER, PRIMARY, SECONDARY].sort());
    expect(await isSlackUserAAOAdmin(SLACK)).toBe(true);
    const survivorFingerprintsBefore = await Promise.all(
      [SECONDARY, BYSTANDER].map((id) => getAuthorizationFingerprint([id])),
    );
    setUnifiedUsersCache(new Map([[ORG, [{
      id: PRIMARY,
      email: 'jordan-race@pinnacle.example',
      firstName: 'Jordan',
      lastName: 'Test',
    }]]]));

    mocks.listUsers.mockImplementation(async (input: { organizationId?: string }) => ({
      data: input.organizationId
        ? []
        : [
            {
              id: SECONDARY,
              email: 'sam-race@pinnacle.example',
              firstName: 'Sam',
              lastName: 'Test',
              emailVerified: true,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
            {
              id: BYSTANDER,
              email: 'maya-race@pinnacle.example',
              firstName: 'Maya',
              lastName: 'Test',
              emailVerified: true,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          ],
    }));
    mocks.getUser.mockImplementation(async (workosUserId: string) => {
      if (workosUserId === PRIMARY) {
        throw Object.assign(new Error('not found'), { status: 404 });
      }
      return { id: workosUserId };
    });
    mocks.constructEvent.mockResolvedValue(undefined);

    // Keep the winning transaction open briefly so the other real caller
    // reaches the identity lock and exercises PostgreSQL serialization.
    await pool.query(`
      CREATE FUNCTION delay_racing_user_delete() RETURNS trigger AS $$
      BEGIN
        IF OLD.workos_user_id = '${PRIMARY}' THEN
          PERFORM pg_sleep(0.15);
        END IF;
        RETURN OLD;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER delay_racing_user_delete
        BEFORE DELETE ON users
        FOR EACH ROW EXECUTE FUNCTION delay_racing_user_delete();
    `);

    const app = express();
    app.use('/api/webhooks', createWorkOSWebhooksRouter());
    const webhookEvent = {
      id: 'event_wh_backfill_race',
      event: 'user.deleted',
      data: { id: PRIMARY },
      created_at: new Date().toISOString(),
    };

    const [webhookResponse, backfill] = await Promise.all([
      request(app)
        .post('/api/webhooks/workos')
        .set('Content-Type', 'application/json')
        .set('WorkOS-Signature', 'valid-test-signature')
        .send(webhookEvent),
      backfillUsers(),
    ]);

    expect(webhookResponse.status).toBe(200);
    expect(mocks.deletionEntrants).toEqual(expect.arrayContaining([
      { workosUserId: PRIMARY, source: 'workos_webhook' },
      { workosUserId: PRIMARY, source: 'sync_users_backfill' },
    ]));
    expect(mocks.deletionEntrants).toHaveLength(2);
    expect(backfill.usersRemoved + backfill.usersSkipped).toBeGreaterThanOrEqual(1);
    expect((await pool.query(`SELECT 1 FROM users WHERE workos_user_id = $1`, [PRIMARY])).rows).toEqual([]);
    expect((await pool.query(
      `SELECT 1 FROM organization_memberships WHERE workos_user_id = $1`,
      [PRIMARY],
    )).rows).toEqual([]);
    expect((await pool.query(
      `SELECT workos_user_id FROM identity_workos_users
        WHERE identity_id = $1 AND is_primary = TRUE`,
      [identityId],
    )).rows).toEqual([]);
    expect(await getIdentityRecoveryQuarantine(identityId)).toMatchObject({
      identity_id: identityId,
      deleted_workos_user_id: PRIMARY,
      deletion_source: expect.stringMatching(/^(workos_webhook|sync_users_backfill)$/),
      recovery_state: IDENTITY_RECOVERY_STATE,
    });
    const quarantineAudits = (await pool.query<{ id: string }>(
      `SELECT id FROM registry_audit_log
        WHERE action = 'identity_primary_deletion_quarantined' AND resource_id = $1`,
      [identityId],
    )).rows;
    expect(quarantineAudits).toHaveLength(1);
    for (const [index, id] of [SECONDARY, BYSTANDER].entries()) {
      expect(await getAuthorizationFingerprint([id])).not.toBe(survivorFingerprintsBefore[index]);
    }
    expect(mocks.invalidateSessionsForUsers).toHaveBeenCalledWith(
      expect.arrayContaining([PRIMARY, SECONDARY, BYSTANDER]),
    );
    expect(getUnifiedUsersCache()).toBeNull();
    expect(mocks.notifySystemError).toHaveBeenCalledTimes(1);
    expect(mocks.notifySystemError).toHaveBeenCalledWith({
      source: `identity-primary-deletion-quarantine:${identityId}`,
      errorMessage: [
        `Primary credential ${PRIMARY} was deleted without promotion.`,
        `Identity ${identityId} is quarantined.`,
        `recovery_state=${IDENTITY_RECOVERY_STATE}.`,
        `audit_id=${quarantineAudits[0].id}.`,
      ].join(' '),
    });
    expect((await pool.query(
      `SELECT status FROM working_group_memberships WHERE workos_user_id = $1`,
      [PRIMARY],
    )).rows).toEqual([{ status: 'inactive' }]);
    expect((await pool.query(
      `SELECT 1 FROM working_group_leaders WHERE user_id = $1`,
      [PRIMARY],
    )).rows).toEqual([]);
    expect((await pool.query(
      `SELECT workos_user_id, mapping_status FROM slack_user_mappings WHERE slack_user_id = $1`,
      [SLACK],
    )).rows).toEqual([{ workos_user_id: null, mapping_status: 'unmapped' }]);
    expect(await isSlackUserAAOAdmin(SLACK)).toBe(false);

    // A stale listUsers page after the signed deletion must not resurrect the
    // users row, automatic identity binding, or any authority.
    mocks.listUsers.mockImplementation(async (input: { organizationId?: string }) => ({
      data: input.organizationId
        ? []
        : [
            {
              id: PRIMARY,
              email: 'jordan-race@pinnacle.example',
              firstName: 'Jordan',
              lastName: 'Test',
              emailVerified: true,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
            {
              id: SECONDARY,
              email: 'sam-race@pinnacle.example',
              firstName: 'Sam',
              lastName: 'Test',
              emailVerified: true,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
            {
              id: BYSTANDER,
              email: 'maya-race@pinnacle.example',
              firstName: 'Maya',
              lastName: 'Test',
              emailVerified: true,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          ],
    }));
    const staleReplay = await backfillUsers();
    expect(staleReplay.usersSkipped).toBeGreaterThanOrEqual(1);
    expect((await pool.query(`SELECT 1 FROM users WHERE workos_user_id = $1`, [PRIMARY])).rows).toEqual([]);
    expect((await pool.query(
      `SELECT 1 FROM identity_workos_users WHERE workos_user_id = $1`,
      [PRIMARY],
    )).rows).toEqual([]);
    expect((await pool.query(
      `SELECT 1 FROM organization_memberships WHERE workos_user_id = $1`,
      [PRIMARY],
    )).rows).toEqual([]);
    expect(await isSlackUserAAOAdmin(SLACK)).toBe(false);
  });
});
