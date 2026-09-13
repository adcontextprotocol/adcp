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
  tryAutoLinkWebsiteUserToSlack: vi.fn(),
  coordinateDeletionCallers: false,
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

vi.mock('../../src/slack/sync.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/slack/sync.js')>()),
  tryAutoLinkWebsiteUserToSlack: mocks.tryAutoLinkWebsiteUserToSlack,
}));

vi.mock('../../src/services/identity-credential-deletion.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/identity-credential-deletion.js')>();
  return {
    ...actual,
    deleteIdentityCredential: async (
      workosUserId: string,
      source: 'workos_webhook' | 'sync_users_backfill',
    ) => {
      if (mocks.coordinateDeletionCallers && workosUserId === 'user_wh_backfill_race_primary') {
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
process.env.WORKOS_PROVIDER_PREFETCH_TIMEOUT_MS = '100';

const { initializeDatabase, closeDatabase } = await import('../../src/db/client.js');
const { runMigrations } = await import('../../src/db/migrate.js');
const { getAuthorizationFingerprint } = await import('../../src/db/authorization-epoch-db.js');
const {
  getIdentityRecoveryQuarantine,
  IDENTITY_DELETION_SNAPSHOT_POLICY,
  IDENTITY_RECOVERY_STATE,
  withActiveCredentialEventMutation,
  withCredentialCreationEventMutation,
  upsertWorkosUserInCredentialEvent,
} = await import('../../src/db/identity-db.js');
const {
  createWorkOSWebhooksRouter,
  backfillUsers,
  shouldAbortBackfillDeletion,
} = await import('../../src/routes/workos-webhooks.js');
const { getUnifiedUsersCache, setUnifiedUsersCache } = await import('../../src/cache/unified-users.js');
const { isSlackUserAAOAdmin } = await import('../../src/addie/mcp/admin-tools.js');
const { deleteIdentityCredential } = await import('../../src/services/identity-credential-deletion.js');
const { SlackDatabase } = await import('../../src/db/slack-db.js');
const { WorkingGroupDatabase } = await import('../../src/db/working-group-db.js');
const { MeetingsDatabase } = await import('../../src/db/meetings-db.js');
const {
  setMembershipRole,
  upsertOrganizationMembership,
} = await import('../../src/db/membership-db.js');

const PREFIX = 'user_wh_backfill_race_';
const PRIMARY = `${PREFIX}primary`;
const SECONDARY = `${PREFIX}secondary`;
const BYSTANDER = `${PREFIX}bystander`;
const ORG = 'org_wh_backfill_race_pinnacle';
const SLACK = 'slack_wh_backfill_race_primary';
const CHAPTER_SLUG = 'wh-backfill-race-chapter';

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
    mocks.coordinateDeletionCallers = false;
    mocks.tryAutoLinkWebsiteUserToSlack.mockResolvedValue({ linked: false, reason: 'no_slack_user' });
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
    await pool.query(
      `DELETE FROM working_group_memberships WHERE workos_user_id LIKE $1 OR workos_user_id = $2`,
      [`${PREFIX}%`, SLACK],
    );
    await pool.query(
      `DELETE FROM working_group_leaders WHERE user_id LIKE $1 OR user_id = $2`,
      [`${PREFIX}%`, SLACK],
    );
    await pool.query(
      `DELETE FROM working_group_topic_subscriptions
        WHERE workos_user_id LIKE $1 OR workos_user_id = $2`,
      [`${PREFIX}%`, SLACK],
    );
    await pool.query(`DELETE FROM slack_user_mappings WHERE slack_user_id = $1`, [SLACK]);
    await pool.query(`DELETE FROM invitation_seat_types WHERE workos_invitation_id LIKE 'invite_wh_%'`);
    await pool.query(`DELETE FROM organization_memberships WHERE workos_user_id LIKE $1`, [`${PREFIX}%`]);
    await pool.query(`DELETE FROM users WHERE workos_user_id LIKE $1`, [`${PREFIX}%`]);
    await pool.query(`DELETE FROM working_groups WHERE slug = $1`, [CHAPTER_SLUG]);
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

  function signedWebhook(app: express.Express, event: string, data: Record<string, unknown>) {
    return request(app)
      .post('/api/webhooks/workos')
      .set('Content-Type', 'application/json')
      .set('WorkOS-Signature', 'valid-test-signature')
      .send({ id: `event_${event}_${Date.now()}`, event, data, created_at: new Date().toISOString() });
  }

  async function within<T>(promise: Promise<T>, timeoutMs = 5_000): Promise<T> {
    let timeout: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error(`race did not settle within ${timeoutMs}ms`)), timeoutMs);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  it('fails closed before a suspicious backfill deletion batch can write tombstones', () => {
    expect(shouldAbortBackfillDeletion(1_000, 101)).toBe(true);
    expect(shouldAbortBackfillDeletion(40, 11)).toBe(true);
    expect(shouldAbortBackfillDeletion(40, 10)).toBe(false);
    expect(shouldAbortBackfillDeletion(1_000, 25)).toBe(false);
  });

  it('bounds concurrent guarded writers below deletion-reserved pool capacity', async () => {
    let activeCallbacks = 0;
    let maxActiveCallbacks = 0;

    const results = await within(Promise.all(
      Array.from({ length: 10 }, async (_, index) => withCredentialCreationEventMutation(
        `${PREFIX}pool_capacity_${index}`,
        async (client) => {
          await upsertWorkosUserInCredentialEvent(client, {
            id: `${PREFIX}pool_capacity_${index}`,
            email: `pool-${index}@race.test`,
            firstName: 'Pool',
            lastName: 'Capacity',
            emailVerified: true,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }, 'provider_authoritative');
          activeCallbacks++;
          maxActiveCallbacks = Math.max(maxActiveCallbacks, activeCallbacks);
          try {
            await client.query(`SELECT pg_sleep(0.025)`);
          } finally {
            activeCallbacks--;
          }
        },
      )),
    ), 3_000);

    expect(results).toHaveLength(10);
    expect(results.every((result) => result.applied)).toBe(true);
    expect(maxActiveCallbacks).toBeGreaterThan(1);
    // One connection stays reserved so confirmed deletion can always enter.
    expect(maxActiveCallbacks).toBeLessThanOrEqual(7);
  });

  it('never replays a callback that has started after a retryable database error', async () => {
    let callbackCalls = 0;
    const retryableAfterMutation = Object.assign(new Error('injected callback deadlock'), { code: '40P01' });

    await expect(withCredentialCreationEventMutation(
      `${PREFIX}no_partial_replay`,
      async (client) => {
        await upsertWorkosUserInCredentialEvent(client, {
          id: `${PREFIX}no_partial_replay`,
          email: 'no-partial-replay@race.test',
          firstName: 'No',
          lastName: 'Replay',
          emailVerified: true,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }, 'provider_authoritative');
        callbackCalls++;
        throw retryableAfterMutation;
      },
    )).rejects.toBe(retryableAfterMutation);

    expect(callbackCalls).toBe(1);
    expect((await pool.query(
      `SELECT 1 FROM users WHERE workos_user_id = $1`,
      [`${PREFIX}no_partial_replay`],
    )).rows).toEqual([]);
  });

  it('preserves the distinct provider-authoritative and login-preserving name policies', async () => {
    const userId = `${PREFIX}name_policy`;
    const timestamp = new Date().toISOString();
    const created = await withCredentialCreationEventMutation(userId, (client) =>
      upsertWorkosUserInCredentialEvent(client, {
        id: userId,
        email: 'name-policy@race.test',
        firstName: 'Original',
        lastName: 'Local',
        emailVerified: true,
        createdAt: timestamp,
        updatedAt: timestamp,
      }, 'provider_authoritative'),
    );
    expect(created.applied).toBe(true);

    const login = await withActiveCredentialEventMutation(userId, (client) =>
      upsertWorkosUserInCredentialEvent(client, {
        id: userId,
        email: 'name-policy@race.test',
        firstName: 'Login',
        lastName: 'Provider',
        emailVerified: true,
        createdAt: timestamp,
        updatedAt: timestamp,
      }, 'preserve_existing'),
    );
    expect(login.applied).toBe(true);
    expect((await pool.query(
      `SELECT first_name, last_name FROM users WHERE workos_user_id = $1`,
      [userId],
    )).rows).toEqual([{ first_name: 'Original', last_name: 'Local' }]);

    mocks.constructEvent.mockResolvedValue(undefined);
    const app = express();
    app.use('/api/webhooks', createWorkOSWebhooksRouter());
    const webhook = await signedWebhook(app, 'user.updated', {
      id: userId,
      email: 'name-policy@race.test',
      first_name: 'Webhook',
      last_name: 'Authoritative',
      email_verified: true,
      created_at: timestamp,
      updated_at: timestamp,
    });
    expect(webhook.status).toBe(200);
    expect((await pool.query(
      `SELECT first_name, last_name FROM users WHERE workos_user_id = $1`,
      [userId],
    )).rows).toEqual([{ first_name: 'Webhook', last_name: 'Authoritative' }]);
  });

  it('durably tombstones a signed deletion received before first local creation', async () => {
    const deletedBeforeCreate = `${PREFIX}deleted_before_create`;
    mocks.constructEvent.mockResolvedValue(undefined);
    const app = express();
    app.use('/api/webhooks', createWorkOSWebhooksRouter());

    const deletion = await signedWebhook(app, 'user.deleted', { id: deletedBeforeCreate });
    expect(deletion.status).toBe(200);
    const audits = await pool.query<{ id: string; action: string; details: Record<string, unknown> }>(
      `SELECT id, action, details FROM registry_audit_log
        WHERE workos_user_id = $1
        ORDER BY created_at, id`,
      [deletedBeforeCreate],
    );
    expect(audits.rows).toHaveLength(1);
    expect(audits.rows[0].action).toBe('identity_credential_deleted');
    expect(audits.rows[0].details).toMatchObject({
      deleted_workos_user_id: deletedBeforeCreate,
      deletion_source: 'workos_webhook',
      before_graph: {
        users: [],
        identity_workos_users: [],
      },
    });

    const replayCache = new Map([[ORG, [{
      id: deletedBeforeCreate,
      email: 'must-remain-cached@race.test',
      firstName: 'Replay',
      lastName: 'Sentinel',
    }]]]);
    setUnifiedUsersCache(replayCache);
    mocks.invalidateSessionsForUsers.mockClear();
    mocks.notifySystemError.mockClear();
    const sameSourceReplay = await signedWebhook(app, 'user.deleted', { id: deletedBeforeCreate });
    expect(sameSourceReplay.status).toBe(200);
    const differentSourceReplay = await deleteIdentityCredential(
      deletedBeforeCreate,
      'sync_users_backfill',
    );
    expect(differentSourceReplay).toMatchObject({
      deleted: false,
      affectedUserIds: [deletedBeforeCreate],
      affectedSlackUserIds: [],
      quarantine: null,
      replay: {
        audit_id: audits.rows[0].id,
        kind: 'different_source',
        original_deletion_source: 'workos_webhook',
        requested_deletion_source: 'sync_users_backfill',
      },
    });
    expect((await pool.query(
      `SELECT id, action, details FROM registry_audit_log
        WHERE workos_user_id = $1
        ORDER BY created_at, id`,
      [deletedBeforeCreate],
    )).rows).toEqual(audits.rows);
    expect((await pool.query(
      `SELECT 1 FROM authorization_epochs WHERE workos_user_id = $1`,
      [deletedBeforeCreate],
    )).rows).toEqual([]);
    expect(getUnifiedUsersCache()).toBe(replayCache);
    expect(mocks.invalidateSessionsForUsers).not.toHaveBeenCalled();
    expect(mocks.notifySystemError).not.toHaveBeenCalled();

    const staleCreate = await signedWebhook(app, 'user.created', {
      id: deletedBeforeCreate,
      email: 'deleted-before-create@race.test',
      first_name: 'Deleted',
      last_name: 'BeforeCreate',
      email_verified: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    expect(staleCreate.status).toBe(200);
    expect((await pool.query(
      `SELECT 1 FROM users WHERE workos_user_id = $1`,
      [deletedBeforeCreate],
    )).rows).toEqual([]);
    expect((await pool.query(
      `SELECT 1 FROM identity_workos_users WHERE workos_user_id = $1`,
      [deletedBeforeCreate],
    )).rows).toEqual([]);
    expect(mocks.tryAutoLinkWebsiteUserToSlack).not.toHaveBeenCalled();
  });

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
    mocks.coordinateDeletionCallers = true;

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
      snapshot_policy: IDENTITY_DELETION_SNAPSHOT_POLICY,
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
        `Credential ${PRIMARY} was deleted without promotion.`,
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

  it('lets deletion finish while post-commit work waits and fences stale Slack/chapter writes', async () => {
    await seedIdentity();
    const chapter = await pool.query<{ id: string }>(
      `INSERT INTO working_groups (name, slug) VALUES ('Race chapter', $1) RETURNING id`,
      [CHAPTER_SLUG],
    );
    await pool.query(
      `UPDATE slack_user_mappings
          SET workos_user_id = NULL, mapping_status = 'unmapped', mapping_source = NULL
        WHERE slack_user_id = $1`,
      [SLACK],
    );
    mocks.constructEvent.mockResolvedValue(undefined);
    let releaseSideEffects!: () => void;
    let sideEffectsEntered!: () => void;
    const entered = new Promise<void>((resolve) => { sideEffectsEntered = resolve; });
    const release = new Promise<void>((resolve) => { releaseSideEffects = resolve; });
    mocks.tryAutoLinkWebsiteUserToSlack.mockImplementation(async () => {
      sideEffectsEntered();
      await release;
      const mapping = await new SlackDatabase().mapUser({
        slack_user_id: SLACK,
        workos_user_id: PRIMARY,
        mapping_source: 'email_auto',
      });
      if (mapping) {
        await new WorkingGroupDatabase().addMembership({
          working_group_id: chapter.rows[0].id,
          workos_user_id: PRIMARY,
        });
      }
      return { linked: Boolean(mapping), slack_user_id: SLACK, workos_user_id: PRIMARY, chapters_joined: 0 };
    });

    const app = express();
    app.use('/api/webhooks', createWorkOSWebhooksRouter());
    const staleUserEvent = Promise.resolve(signedWebhook(app, 'user.created', {
      id: PRIMARY,
      email: 'jordan-race@gmail.com',
      first_name: 'Jordan',
      last_name: 'Race',
      email_verified: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }));
    await entered;
    let deletionSettled = false;
    const deletion = deleteIdentityCredential(PRIMARY, 'workos_webhook')
      .finally(() => { deletionSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const deletionWasBlocked = !deletionSettled;
    releaseSideEffects();
    const [eventResponse, deletionResult] = await within(Promise.all([staleUserEvent, deletion]));

    expect(deletionWasBlocked).toBe(false);
    expect(eventResponse.status).toBe(200);
    expect(deletionResult.deleted).toBe(true);
    expect((await pool.query(`SELECT 1 FROM users WHERE workos_user_id = $1`, [PRIMARY])).rows).toEqual([]);
    expect((await pool.query(
      `SELECT 1 FROM organization_memberships WHERE workos_user_id = $1`, [PRIMARY],
    )).rows).toEqual([]);
    expect((await pool.query(
      `SELECT status FROM working_group_memberships
        WHERE workos_user_id = $1 AND working_group_id = $2`,
      [PRIMARY, chapter.rows[0].id],
    )).rows).toEqual([]);
    expect((await pool.query(
      `SELECT workos_user_id, mapping_status FROM slack_user_mappings WHERE slack_user_id = $1`, [SLACK],
    )).rows).toEqual([{ workos_user_id: null, mapping_status: 'unmapped' }]);
    const replay = await signedWebhook(app, 'user.created', {
      id: PRIMARY,
      email: 'jordan-race@gmail.com',
      first_name: 'Jordan',
      last_name: 'Race',
      email_verified: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    expect(replay.status).toBe(200);
    expect(mocks.tryAutoLinkWebsiteUserToSlack).toHaveBeenCalledTimes(1);
    expect((await pool.query(`SELECT 1 FROM users WHERE workos_user_id = $1`, [PRIMARY])).rows).toEqual([]);
    expect((await pool.query(
      `SELECT 1 FROM working_group_memberships
        WHERE workos_user_id = $1 AND working_group_id = $2 AND status = 'active'`,
      [PRIMARY, chapter.rows[0].id],
    )).rows).toEqual([]);
  });

  it('commits signed membership locally before post-commit work and lets deletion revoke it immediately', async () => {
    await seedIdentity();
    await pool.query(
      `DELETE FROM organization_memberships WHERE workos_user_id = $1 AND workos_organization_id = $2`,
      [PRIMARY, ORG],
    );
    await pool.query(
      `INSERT INTO invitation_seat_types (
         workos_invitation_id, workos_organization_id, email, seat_type
       ) VALUES ('invite_wh_membership_race', $1, 'jordan-race@pinnacle.example', 'community_only')`,
      [ORG],
    );
    mocks.constructEvent.mockResolvedValue(undefined);
    mocks.getUser.mockResolvedValue({
      id: PRIMARY,
      email: 'jordan-race@pinnacle.example',
      firstName: 'Jordan',
      lastName: 'Race',
      emailVerified: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    let releasePostWrite!: () => void;
    let postWriteEntered!: () => void;
    const entered = new Promise<void>((resolve) => { postWriteEntered = resolve; });
    const release = new Promise<void>((resolve) => { releasePostWrite = resolve; });
    mocks.tryAutoLinkWebsiteUserToSlack.mockImplementation(async () => {
      postWriteEntered();
      await release;
      return { linked: false, reason: 'already_linked' };
    });

    const app = express();
    app.use('/api/webhooks', createWorkOSWebhooksRouter());
    const staleMembershipEvent = Promise.resolve(signedWebhook(app, 'organization_membership.created', {
      id: 'om_race_restore',
      user_id: PRIMARY,
      organization_id: ORG,
      status: 'active',
      role: { slug: 'admin' },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }));
    await entered;
    const membershipWhileLocked = (await pool.query(
      `SELECT role FROM organization_memberships
        WHERE workos_user_id = $1 AND workos_organization_id = $2`,
      [PRIMARY, ORG],
    )).rows;
    let deletionSettled = false;
    const deletion = deleteIdentityCredential(PRIMARY, 'workos_webhook')
      .finally(() => { deletionSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const deletionWasBlocked = !deletionSettled;
    releasePostWrite();
    const [eventResponse, deletionResult] = await within(Promise.all([staleMembershipEvent, deletion]));

    expect(deletionWasBlocked).toBe(false);
    expect(membershipWhileLocked).toEqual([{ role: 'admin' }]);
    expect(eventResponse.status).toBe(200);
    expect(deletionResult.deleted).toBe(true);
    expect((await pool.query(
      `SELECT 1 FROM organization_memberships WHERE workos_user_id = $1`, [PRIMARY],
    )).rows).toEqual([]);
    expect((await pool.query(
      `SELECT workos_user_id, mapping_status FROM slack_user_mappings WHERE slack_user_id = $1`, [SLACK],
    )).rows).toEqual([{ workos_user_id: null, mapping_status: 'unmapped' }]);
    expect((await pool.query(
      `SELECT 1 FROM working_group_memberships WHERE workos_user_id = $1 AND status = 'active'`, [PRIMARY],
    )).rows).toEqual([]);
    const replay = await signedWebhook(app, 'organization_membership.created', {
      id: 'om_race_restore_replay',
      user_id: PRIMARY,
      organization_id: ORG,
      status: 'active',
      role: { slug: 'admin' },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    expect(replay.status).toBe(200);
    expect(mocks.tryAutoLinkWebsiteUserToSlack).toHaveBeenCalledTimes(1);
    expect((await pool.query(
      `SELECT 1 FROM organization_memberships WHERE workos_user_id = $1`, [PRIMARY],
    )).rows).toEqual([]);
  });

  it('serializes a distinct Slack/WG/leader/topic authority writer with deletion and leaves no alias authority', async () => {
    await seedIdentity();
    const chapter = await pool.query<{ id: string }>(
      `INSERT INTO working_groups (name, slug) VALUES ('Authority writer race', $1) RETURNING id`,
      [CHAPTER_SLUG],
    );
    await pool.query(
      `UPDATE slack_user_mappings
          SET workos_user_id = NULL, mapping_status = 'unmapped', mapping_source = NULL
        WHERE slack_user_id = $1`,
      [SLACK],
    );
    let writerEntered!: () => void;
    let releaseWriter!: () => void;
    const entered = new Promise<void>((resolve) => { writerEntered = resolve; });
    const release = new Promise<void>((resolve) => { releaseWriter = resolve; });

    const writer = withActiveCredentialEventMutation(PRIMARY, async (client) => {
      await new SlackDatabase().mapUser({
        slack_user_id: SLACK,
        workos_user_id: PRIMARY,
        mapping_source: 'email_auto',
      }, client);
      await new WorkingGroupDatabase().addLeader(chapter.rows[0].id, PRIMARY, client);
      await client.query(
        `INSERT INTO working_group_memberships (working_group_id, workos_user_id, status)
         VALUES ($1, $2, 'active')`,
        [chapter.rows[0].id, SLACK],
      );
      await client.query(
        `INSERT INTO working_group_leaders (working_group_id, user_id)
         VALUES ($1, $2)`,
        [chapter.rows[0].id, SLACK],
      );
      await client.query(
        `INSERT INTO working_group_topic_subscriptions (working_group_id, workos_user_id, topic_slugs)
         VALUES ($1, $2, ARRAY['race-topic'])`,
        [chapter.rows[0].id, SLACK],
      );
      writerEntered();
      await release;
    });
    await entered;

    let deletionSettled = false;
    const deletion = deleteIdentityCredential(PRIMARY, 'workos_webhook')
      .finally(() => { deletionSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(deletionSettled).toBe(false);
    releaseWriter();
    const [writerResult, deletionResult] = await within(Promise.all([writer, deletion]));

    expect(writerResult.applied).toBe(true);
    expect(deletionResult.deleted).toBe(true);
    expect((await pool.query(
      `SELECT workos_user_id, mapping_status FROM slack_user_mappings WHERE slack_user_id = $1`,
      [SLACK],
    )).rows).toEqual([{ workos_user_id: null, mapping_status: 'unmapped' }]);
    expect((await pool.query(
      `SELECT 1 FROM working_group_memberships
        WHERE working_group_id = $1 AND workos_user_id = ANY($2) AND status = 'active'`,
      [chapter.rows[0].id, [PRIMARY, SLACK]],
    )).rows).toEqual([]);
    expect((await pool.query(
      `SELECT 1 FROM working_group_leaders
        WHERE working_group_id = $1 AND user_id = ANY($2)`,
      [chapter.rows[0].id, [PRIMARY, SLACK]],
    )).rows).toEqual([]);
    expect((await pool.query(
      `SELECT 1 FROM working_group_topic_subscriptions
        WHERE working_group_id = $1 AND workos_user_id = ANY($2)`,
      [chapter.rows[0].id, [PRIMARY, SLACK]],
    )).rows).toEqual([]);
    expect(await isSlackUserAAOAdmin(SLACK)).toBe(false);
  });

  it('rejects every authority-writer fence after the credential is durably deleted', async () => {
    await seedIdentity();
    const chapter = await pool.query<{ id: string }>(
      `INSERT INTO working_groups (name, slug) VALUES ('Deleted writer fence', $1) RETURNING id`,
      [CHAPTER_SLUG],
    );
    expect((await deleteIdentityCredential(PRIMARY, 'workos_webhook')).deleted).toBe(true);

    const workingGroups = new WorkingGroupDatabase();
    await expect(workingGroups.grantAAOAdminMembership({
      targetUserId: PRIMARY,
      actorUserId: BYSTANDER,
      actorAuthorizationMechanism: 'aao_admin_working_group',
      reason: 'must remain deleted',
    })).rejects.toThrow('Cannot grant AAO admin authority to an inactive credential');
    await expect(workingGroups.addMembership({
      working_group_id: chapter.rows[0].id,
      workos_user_id: PRIMARY,
    })).rejects.toThrow('Cannot add working-group authority to an inactive credential');
    await expect(workingGroups.addLeader(
      chapter.rows[0].id,
      PRIMARY,
    )).rejects.toThrow('Cannot assign leadership to an inactive credential');
    await expect(upsertOrganizationMembership({
      user_id: PRIMARY,
      organization_id: ORG,
      membership_id: 'om_deleted_writer_fence',
      email: 'deleted-writer@race.test',
      first_name: 'Deleted',
      last_name: 'Writer',
      role: 'admin',
      seat_type: 'community_only',
      has_explicit_seat_type: true,
    })).rejects.toThrow('Cannot write organization authority for an inactive credential');
    await expect(setMembershipRole(
      PRIMARY,
      ORG,
      'admin',
    )).rejects.toThrow('Cannot update organization authority for an inactive credential');
    await expect(new MeetingsDatabase().updateTopicSubscription({
      working_group_id: chapter.rows[0].id,
      workos_user_id: PRIMARY,
      topic_slugs: ['must-remain-deleted'],
    })).rejects.toThrow('Cannot update topic subscriptions for an inactive credential');

    expect((await pool.query(
      `SELECT 1 FROM working_group_memberships
        WHERE working_group_id = $1 AND workos_user_id = $2 AND status = 'active'`,
      [chapter.rows[0].id, PRIMARY],
    )).rows).toEqual([]);
    expect((await pool.query(
      `SELECT 1 FROM working_group_leaders WHERE working_group_id = $1 AND user_id = $2`,
      [chapter.rows[0].id, PRIMARY],
    )).rows).toEqual([]);
    expect((await pool.query(
      `SELECT 1 FROM working_group_topic_subscriptions
        WHERE working_group_id = $1 AND workos_user_id = $2`,
      [chapter.rows[0].id, PRIMARY],
    )).rows).toEqual([]);
    expect((await pool.query(
      `SELECT 1 FROM organization_memberships WHERE workos_user_id = $1`,
      [PRIMARY],
    )).rows).toEqual([]);
    expect((await pool.query(
      `SELECT 1 FROM aao_admin_access_events
        WHERE target_user_id = $1 AND event_type = 'granted'`,
      [PRIMARY],
    )).rows).toEqual([]);
  });

  it('does not hold the credential lock while membership provider prefetch is hung', async () => {
    await seedIdentity();
    mocks.constructEvent.mockResolvedValue(undefined);
    let providerEntered!: () => void;
    const entered = new Promise<void>((resolve) => { providerEntered = resolve; });
    mocks.getUser.mockImplementation(async () => {
      providerEntered();
      return new Promise(() => undefined);
    });
    const app = express();
    app.use('/api/webhooks', createWorkOSWebhooksRouter());
    const started = Date.now();
    const event = Promise.resolve(signedWebhook(app, 'organization_membership.created', {
      id: 'om_hung_provider',
      user_id: PRIMARY,
      organization_id: ORG,
      status: 'active',
      role: { slug: 'admin' },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }));
    await entered;

    const deletion = await within(deleteIdentityCredential(PRIMARY, 'workos_webhook'), 1_000);
    const eventResponse = await within(event, 1_000);

    expect(deletion.deleted).toBe(true);
    expect(eventResponse.status).toBe(500);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect((await pool.query(`SELECT 1 FROM users WHERE workos_user_id = $1`, [PRIMARY])).rows)
      .toEqual([]);
  });

  it('fails a signed stale writer closed after bounded credential-lock retries', async () => {
    await seedIdentity();
    mocks.constructEvent.mockResolvedValue(undefined);
    const lockHolder = await pool.connect();
    await lockHolder.query('BEGIN');
    await lockHolder.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 6827))`, [PRIMARY]);
    try {
      const app = express();
      app.use('/api/webhooks', createWorkOSWebhooksRouter());
      const started = Date.now();
      const response = await within(signedWebhook(app, 'user.updated', {
        id: PRIMARY,
        email: 'stale-update@pinnacle.example',
        first_name: 'Stale',
        last_name: 'Update',
        email_verified: true,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }), 5_000);
      expect(response.status).toBe(500);
      expect(Date.now() - started).toBeLessThan(4_000);
      expect((await pool.query<{ email: string }>(
        `SELECT email FROM users WHERE workos_user_id = $1`, [PRIMARY],
      )).rows).toEqual([{ email: 'jordan-race@pinnacle.example' }]);
      expect(mocks.tryAutoLinkWebsiteUserToSlack).not.toHaveBeenCalled();
    } finally {
      await lockHolder.query('ROLLBACK');
      lockHolder.release();
    }
  });
});
