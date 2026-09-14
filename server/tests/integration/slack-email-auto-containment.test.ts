import express from 'express';
import request from 'supertest';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(), constructEvent: vi.fn(), createMembership: vi.fn(), updateMembership: vi.fn(),
  deleteMembership: vi.fn(), listMemberships: vi.fn(), getUserChannels: vi.fn(), getSlackUsers: vi.fn(),
  unifiedCache: vi.fn(), memberCache: vi.fn(), adminCache: vi.fn(), webAdminCache: vi.fn(),
  welcome: vi.fn(), marketing: vi.fn(), prospect: vi.fn(), linkResults: [] as unknown[],
  beforeLink: undefined as undefined | (() => Promise<void>),
  afterLink: undefined as undefined | (() => Promise<void>),
}));
vi.hoisted(() => {
  process.env.WORKOS_WEBHOOK_SECRET = 'test-slack-containment-secret';
  delete process.env.ANTHROPIC_API_KEY;
});
vi.mock('../../src/auth/workos-client.js', () => ({ getWorkos: () => ({
  webhooks: { constructEvent: mocks.constructEvent },
  userManagement: { getUser: mocks.getUser, createOrganizationMembership: mocks.createMembership,
    updateOrganizationMembership: mocks.updateMembership, deleteOrganizationMembership: mocks.deleteMembership,
    listOrganizationMemberships: mocks.listMemberships },
}) }));
vi.mock('../../src/slack/client.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/slack/client.js')>(),
  isSlackConfigured: () => true, getSlackUsers: mocks.getSlackUsers, getUserChannels: mocks.getUserChannels,
}));
vi.mock('../../src/cache/unified-users.js', () => ({ invalidateUnifiedUsersCache: mocks.unifiedCache }));
vi.mock('../../src/addie/index.js', () => ({ invalidateMemberContextCache: mocks.memberCache }));
vi.mock('../../src/addie/mcp/admin-tools.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/addie/mcp/admin-tools.js')>(),
  invalidateAdminStatusCache: mocks.adminCache, invalidateWebAdminStatusCache: mocks.webAdminCache,
}));
vi.mock('../../src/notifications/welcome-social-posts.js', () => ({ sendWelcomeSocialPosts: mocks.welcome }));
vi.mock('../../src/notifications/marketing-optin-dm.js', () => ({ sendMarketingOptInDM: mocks.marketing }));
vi.mock('../../src/services/prospect-triage.js', () => ({
  triageAndCreateProspect: mocks.prospect, triageAndNotify: mocks.prospect,
}));
vi.mock('../../src/middleware/auth.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/middleware/auth.js')>(),
  requireGlobalAdmin: [(req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as express.Request & { user: { id: string } }).user = { id: 'user_containment_admin' };
    next();
  }],
}));
vi.mock('../../src/slack/sync.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/slack/sync.js')>();
  return { ...actual, tryAutoLinkWebsiteUserToSlack: async (...args: Parameters<typeof actual.tryAutoLinkWebsiteUserToSlack>) => {
    await mocks.beforeLink?.();
    const result = await actual.tryAutoLinkWebsiteUserToSlack(...args);
    mocks.linkResults.push(result);
    await mocks.afterLink?.();
    return result;
  } };
});

import { initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { SlackDatabase } from '../../src/db/slack-db.js';
import { WorkingGroupDatabase } from '../../src/db/working-group-db.js';
import { USER_CASCADE_SNAPSHOT_INVENTORY, USER_SET_NULL_SNAPSHOT_INVENTORY } from '../../src/db/identity-db.js';
import { bumpAuthorizationEpochs } from '../../src/db/authorization-epoch-db.js';
import { getSlackAdminStatusCache } from '../../src/addie/admin-status-cache.js';
import { isSlackUserAAOAdmin } from '../../src/addie/mcp/admin-tools.js';
import { autoLinkUnmappedSlackUsers, tryAutoLinkWebsiteUserToSlack } from '../../src/slack/sync.js';
import { handleTeamJoin } from '../../src/slack/events.js';
import { createAdminSlackRouter } from '../../src/routes/admin/slack.js';
import { createWorkOSWebhooksRouter } from '../../src/routes/workos-webhooks.js';
import { SlackEmailAutoLinkContainedError } from '../../src/slack/email-auto-containment.js';

const USER = 'user_slack_containment_sam';
const SLACK = 'U_SLACK_CONTAINMENT_SAM';
const ORG = 'org_slack_containment_pinnacle';
const EMAIL = 'sam.containment@gmail.com';
const GROUP = 'slack-containment-chapter';
const TABLES = [
  'slack_user_mappings', 'users', 'identities', 'identity_workos_users', 'authorization_epochs',
  'organization_memberships', 'organizations', 'organization_domains', 'working_groups',
  'working_group_memberships', 'working_group_leaders', 'working_group_topic_subscriptions',
  'registry_audit_log', 'user_email_preferences', 'user_email_aliases', 'person_relationships',
  ...USER_CASCADE_SNAPSHOT_INVENTORY.map(spec => spec.table),
  ...USER_SET_NULL_SNAPSHOT_INVENTORY.map(spec => spec.table),
] as const;

// Whole rows, including timestamps and metadata, serialized by PostgreSQL.
// The local fixture database is isolated; no production connection is used.
describe.skipIf(!process.env.DATABASE_URL)('Slack email identity containment (PostgreSQL)', () => {
  let pool: Pool;
  const slackDb = new SlackDatabase();
  const wgDb = new WorkingGroupDatabase();
  let groupId: string;

  beforeAll(async () => {
    pool = initializeDatabase({ connectionString: process.env.DATABASE_URL! });
    await runMigrations();
  }, 120_000);
  afterAll(async () => { await cleanup(); await closeDatabase(); });
  beforeEach(async () => {
    await cleanup();
    vi.clearAllMocks();
    mocks.linkResults = [];
    mocks.beforeLink = undefined;
    mocks.afterLink = undefined;
    getSlackAdminStatusCache().clear();
    mocks.constructEvent.mockResolvedValue(undefined);
    mocks.getUser.mockResolvedValue({ id: USER, email: EMAIL, firstName: null, lastName: null,
      emailVerified: true, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' });
  });

  async function cleanup() {
    if (!pool) return;
    await pool.query('DELETE FROM slack_user_mappings WHERE slack_user_id = $1', [SLACK]);
    await pool.query('DELETE FROM working_group_leaders WHERE user_id = $1', [USER]);
    await pool.query('DELETE FROM working_group_memberships WHERE workos_user_id = $1', [USER]);
    await pool.query('DELETE FROM working_group_topic_subscriptions WHERE workos_user_id = $1', [USER]);
    await pool.query('DELETE FROM organization_memberships WHERE workos_user_id = $1', [USER]);
    await pool.query('DELETE FROM users WHERE workos_user_id = $1', [USER]);
    await pool.query('DELETE FROM organizations WHERE workos_organization_id = $1', [ORG]);
    await pool.query('DELETE FROM working_groups WHERE slug = $1', [GROUP]);
  }
  async function seed(admin: boolean) {
    await pool.query(`INSERT INTO organizations (workos_organization_id, name) VALUES ($1, 'Pinnacle Agency')`, [ORG]);
    await pool.query(`INSERT INTO users (workos_user_id, email, email_verified) VALUES ($1, $2, true)`, [USER, EMAIL]);
    await pool.query(`INSERT INTO organization_memberships (workos_user_id, workos_organization_id, email, role)
      VALUES ($1, $2, $3, 'member')`, [USER, ORG, EMAIL]);
    await pool.query(`INSERT INTO slack_user_mappings (slack_user_id, slack_email, slack_real_name, pending_marketing_opt_in)
      VALUES ($1, $2, 'Sam Adeyemi', true)`, [SLACK, EMAIL]);
    groupId = (await pool.query(`INSERT INTO working_groups (name, slug, slack_channel_id)
      VALUES ('Pinnacle chapter', $1, 'C_CONTAINMENT') RETURNING id`, [GROUP])).rows[0].id;
    await pool.query(`INSERT INTO working_group_leaders (working_group_id, user_id) VALUES ($1, $2)`, [groupId, USER]);
    await pool.query(`INSERT INTO working_group_memberships (working_group_id, workos_user_id, status)
      VALUES ($1, $2, 'active')`, [groupId, USER]);
    await pool.query(`INSERT INTO working_group_topic_subscriptions (working_group_id, workos_user_id, topic_slugs)
      VALUES ($1, $2, ARRAY['containment'])`, [groupId, USER]);
    if (admin) await pool.query(`INSERT INTO working_group_memberships (working_group_id, workos_user_id, status)
      SELECT id, $1, 'active' FROM working_groups WHERE slug = 'aao-admin'`, [USER]);
    await bumpAuthorizationEpochs(pool, [USER]);
  }
  async function snapshot() {
    return Object.fromEntries(await Promise.all([...new Set(TABLES)].map(async table => [table,
      (await pool.query(`SELECT row_to_json(t)::text AS bytes FROM "${table}" t ORDER BY row_to_json(t)::text`)).rows,
    ])));
  }
  async function assertAuthorityAbsent() {
    getSlackAdminStatusCache().clear();
    expect(await isSlackUserAAOAdmin(SLACK)).toBe(false);
    expect(await wgDb.getCommitteesLedByUser(SLACK)).toEqual([]);
  }
  function assertNoDownstreamCalls(allowWebhookCache = false) {
    for (const spy of [mocks.createMembership, mocks.updateMembership, mocks.deleteMembership,
      mocks.listMemberships, mocks.getUserChannels, mocks.getSlackUsers, mocks.memberCache,
      mocks.adminCache, mocks.webAdminCache, mocks.welcome, mocks.marketing, mocks.prospect]) {
      expect(spy).not.toHaveBeenCalled();
    }
    if (!allowWebhookCache) expect(mocks.unifiedCache).not.toHaveBeenCalled();
  }

  it.each([true, false])('keeps all rows byte-for-byte stable for active admin=%s across every linking service and bulk API', async (admin) => {
    await seed(admin);
    const before = await snapshot();
    const app = express().use(express.json()).use('/api/admin/slack', createAdminSlackRouter());
    for (let i = 0; i < 3; i++) {
      await expect(slackDb.mapUser({ slack_user_id: SLACK, workos_user_id: USER, mapping_source: 'email_auto' }))
        .rejects.toBeInstanceOf(SlackEmailAutoLinkContainedError);
      expect(await tryAutoLinkWebsiteUserToSlack(USER, EMAIL)).toEqual({ linked: false, reason: 'slack_email_auto_linking_disabled' });
      expect(await handleTeamJoin({ type: 'team_join', user: { id: SLACK, name: 'sam', is_bot: false,
        deleted: false, profile: { email: EMAIL, real_name: 'Changed Slack name' } } })).toBe('contained');
      expect(await autoLinkUnmappedSlackUsers()).toEqual({ linked: 0, chapters_joined: 0,
        organizations_assigned: 0, pending_org_prospects_set: 0, contained: 1, errors: 0 });
      const response = await request(app).post('/api/admin/slack/auto-link-suggested');
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ linked: 0, contained: 1, errors: [] });
      expect(await snapshot()).toEqual(before);
      await assertAuthorityAbsent();
    }
    assertNoDownstreamCalls();
  });

  it.each([true, false])('contains inside caller-owned transactions without changing admin=%s rows or epochs', async (admin) => {
    await seed(admin);
    const before = await snapshot();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await expect(slackDb.mapUser({ slack_user_id: SLACK, workos_user_id: USER, mapping_source: 'email_auto' }, client))
        .rejects.toMatchObject({ code: 'slack_email_auto_linking_disabled' });
      await client.query('COMMIT');
    } finally { client.release(); }
    expect(await snapshot()).toEqual(before);
  });

  it.each(['manual_admin', 'user_claimed', 'email_auto'] as const)('preserves historical %s mappings and existing admin authority', async (source) => {
    await seed(true);
    await pool.query(`UPDATE slack_user_mappings SET workos_user_id = $1, mapping_status = 'mapped', mapping_source = $2
      WHERE slack_user_id = $3`, [USER, source, SLACK]);
    const before = await snapshot();
    for (let i = 0; i < 2; i++) {
      await expect(slackDb.mapUser({ slack_user_id: SLACK, workos_user_id: USER, mapping_source: 'email_auto' }))
        .rejects.toBeInstanceOf(SlackEmailAutoLinkContainedError);
      expect(await tryAutoLinkWebsiteUserToSlack(USER, EMAIL)).toEqual({ linked: false, reason: 'already_linked' });
      expect((await autoLinkUnmappedSlackUsers()).linked).toBe(0);
    }
    expect(await snapshot()).toEqual(before);
    expect(await isSlackUserAAOAdmin(SLACK)).toBe(true);
    assertNoDownstreamCalls();
  });

  it.each(['user.created', 'organization_membership.created'])('contains real %s webhook attempts for both targets without link side effects', async (event) => {
    const app = express().use('/api/webhooks', createWorkOSWebhooksRouter());
    for (const admin of [true, false]) {
      await cleanup();
      await seed(admin);
      let before: Awaited<ReturnType<typeof snapshot>>;
      // Signed provider upsert precedes auto-link. Compare every full row around
      // the actual linking branch, so provider lifecycle work is not mistaken
      // for an email-derived authority write.
      mocks.beforeLink = async () => { before = await snapshot(); };
      mocks.afterLink = async () => { expect(await snapshot()).toEqual(before); };
      for (let i = 0; i < 2; i++) {
        const data = event === 'user.created'
          ? { id: USER, email: EMAIL, first_name: null, last_name: null, email_verified: true,
            created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' }
          : { id: 'om_containment', user_id: USER, organization_id: ORG, status: 'active', role: { slug: 'member' } };
        const response = await request(app).post('/api/webhooks/workos')
          .set('WorkOS-Signature', 'test-signature').send({ id: 'event_containment', event, data });
        expect(response.status).toBe(200);
        expect(mocks.linkResults.at(-1)).toEqual({ linked: false, reason: 'slack_email_auto_linking_disabled' });
        expect(await snapshot()).toEqual(before!);
        expect((await pool.query('SELECT first_name, last_name FROM users WHERE workos_user_id = $1', [USER])).rows)
          .toEqual([{ first_name: null, last_name: null }]);
        await assertAuthorityAbsent();
      }
    }
    expect(mocks.linkResults).toHaveLength(4);
    assertNoDownstreamCalls(true);
  });

  it('contains a new matching Slack join before inserting a discovery row', async () => {
    await seed(true);
    await pool.query('DELETE FROM slack_user_mappings WHERE slack_user_id = $1', [SLACK]);
    const before = await snapshot();
    expect(await handleTeamJoin({ type: 'team_join', user: { id: SLACK, name: 'sam', is_bot: false,
      deleted: false, profile: { email: EMAIL, real_name: 'Sam Adeyemi' } } })).toBe('contained');
    expect(await snapshot()).toEqual(before);
    assertNoDownstreamCalls();
  });

  it('keeps populated standalone profile sync separate from identity establishment', async () => {
    await seed(true);
    mocks.getSlackUsers.mockResolvedValue([{ id: SLACK, name: 'sam', is_bot: false, deleted: false,
      profile: { email: EMAIL, real_name: 'Updated Slack profile' } }]);
    const before = await snapshot();
    const app = express().use('/api/admin/slack', createAdminSlackRouter());
    const response = await request(app).post('/api/admin/slack/sync');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ total_synced: 1, updated_users: 1, auto_mapped: 0, errors: [] });
    const after = await snapshot();
    // Profile ingestion intentionally refreshes only Slack discovery fields.
    expect(after.slack_user_mappings).not.toEqual(before.slack_user_mappings);
    delete after.slack_user_mappings;
    delete before.slack_user_mappings;
    expect(after).toEqual(before);
    expect(await slackDb.getBySlackUserId(SLACK)).toMatchObject({ workos_user_id: null, mapping_status: 'unmapped' });
    await assertAuthorityAbsent();
    for (const spy of [mocks.createMembership, mocks.updateMembership, mocks.deleteMembership,
      mocks.listMemberships, mocks.getUserChannels]) expect(spy).not.toHaveBeenCalled();
  });

  it('preserves explicit manual admin linking through the API, including name and leadership authority', async () => {
    await seed(true);
    mocks.getUserChannels.mockResolvedValue([]);
    const app = express().use(express.json()).use('/api/admin/slack', createAdminSlackRouter());
    const response = await request(app).post(`/api/admin/slack/users/${SLACK}/link`).send({ workos_user_id: USER });
    expect(response.status).toBe(200);
    expect(response.body.mapping).toMatchObject({ workos_user_id: USER, mapping_source: 'manual_admin', mapped_by_user_id: 'user_containment_admin' });
    expect((await pool.query('SELECT first_name, last_name FROM users WHERE workos_user_id = $1', [USER])).rows)
      .toEqual([{ first_name: 'Sam', last_name: 'Adeyemi' }]);
    expect(await isSlackUserAAOAdmin(SLACK)).toBe(true);
    expect(await wgDb.getCommitteesLedByUser(SLACK)).toEqual([expect.objectContaining({ id: groupId })]);
  });
});
