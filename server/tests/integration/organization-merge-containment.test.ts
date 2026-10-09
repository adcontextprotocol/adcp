import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { generateKeyPair, SignJWT } from 'jose';
import type { Pool } from 'pg';

const state = vi.hoisted(() => {
  process.env.ADMIN_API_KEY = 'merge-test-static-key';
  process.env.ADMIN_EMAILS = 'sam@merge.example.test';
  return {
    users: new Map<string, any>(),
    sessions: new Map<string, any>(),
    calls: [] as string[],
    platformAdmin: false,
  };
});

// Every provider mutation the merge sequence performed is recorded. None may fire.
vi.mock('@workos-inc/node', () => ({ WorkOS: class {
  organizations = {
    deleteOrganization: vi.fn(async (id: string) => { state.calls.push(`org_delete:${id}`); }),
  };
  apiKeys = { createValidation: vi.fn(async () => { state.calls.push('api_key'); throw new Error('Unexpected API key validation'); }) };
  authorization = { listOrganizationRoles: vi.fn(async () => { state.calls.push('roles'); return { data: [] }; }) };
  userManagement = {
    loadSealedSession: ({ sessionData }: any) => {
      state.calls.push('session');
      return {
        authenticate: async () => state.sessions.get(sessionData) ?? { authenticated: false },
        refresh: async () => ({ authenticated: false }),
      };
    },
    createOrganizationMembership: vi.fn(async ({ organizationId }: any) => { state.calls.push(`membership_create:${organizationId}`); }),
    listOrganizationMemberships: vi.fn(async ({ organizationId }: any) => { state.calls.push(`memberships:${organizationId}`); return { data: [] }; }),
    getUser: vi.fn(async (id: string) => { state.calls.push(`user:${id}`); return state.users.get(id); }),
  };
} }));
vi.mock('../../src/addie/mcp/admin-tools.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/addie/mcp/admin-tools.js')>()),
  isWebUserAAOAdmin: vi.fn(async () => state.platformAdmin),
}));
// Keep unrelated route graphs inert so this harness does not initialize Addie
// indexes or agent tenants. HTTPServer still supplies the real parser/cookie/
// CSRF/admin-router ordering the contained route sits behind.
vi.mock('../../src/routes/addie-admin.js', async () => {
  const express = (await import('express')).default;
  return { createAddieAdminRouter: () => ({ pageRouter: express.Router(), apiRouter: express.Router() }) };
});
vi.mock('../../src/routes/addie-chat.js', async () => {
  const express = (await import('express')).default;
  return { createAddieChatRouter: () => ({ pageRouter: express.Router(), apiRouter: express.Router() }), isWebChatReady: () => false };
});
vi.mock('../../src/routes/slack.js', async () => {
  const express = (await import('express')).default;
  return { createSlackRouter: () => ({ aaobotRouter: express.Router(), addieRouter: express.Router() }) };
});
vi.mock('../../src/routes/registry-api.js', async () => {
  const express = (await import('express')).default;
  return { createRegistryApiRouters: () => ({ router: express.Router(), v1AgentsRouter: express.Router(), complianceRefreshQueue: null }) };
});
vi.mock('../../src/training-agent/index.js', async () => {
  const express = (await import('express')).default;
  return { createTrainingAgentRouter: () => express.Router() };
});
vi.mock('../../src/creative-agent/index.js', async () => {
  const express = (await import('express')).default;
  return { createCreativeAgentRouter: () => express.Router() };
});
vi.mock('../../src/addie/index.js', () => ({
  sendAccountLinkedMessage: vi.fn(),
  invalidateMemberContextCache: vi.fn(),
  isAddieBoltReady: () => false,
}));
vi.mock('../../src/addie/jobs/scheduler.js', () => ({
  jobScheduler: { startAll: vi.fn(), stop: vi.fn(), stopAll: vi.fn() },
}));
vi.mock('../../src/addie/jobs/job-definitions.js', () => ({
  registerAllJobs: vi.fn(),
  JOB_NAMES: { GEO_MONITOR: 'geo-monitor', GEO_SNAPSHOT: 'geo-snapshot', GEO_CONTENT_PLANNER: 'geo-content-planner' },
}));
vi.mock('../../src/services/organization-membership-notifications.js', () => ({ notifyMembershipSeats: vi.fn(), notifyMembershipSeatRequest: vi.fn() }));
vi.mock('../../src/slack/org-group-dm.js', () => ({ notifyMemberSeatChanged: vi.fn() }));

import { initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { __setJWKSForTesting } from '../../src/auth/workos-jwt.js';
import { stopAuthTimers, invalidateBanCache } from '../../src/middleware/auth.js';
import { mergeOrganizations } from '../../src/db/org-merge-db.js';
import {
  ORGANIZATION_MERGE_UNAVAILABLE_ERROR,
  ORGANIZATION_MERGE_UNAVAILABLE_MESSAGE,
  OrganizationMergeUnavailableError,
} from '../../src/db/org-merge-containment.js';
import { createAdminToolHandlers } from '../../src/addie/mcp/admin-tools.js';
import type { MemberContext } from '../../src/addie/member-context.js';
import type { WorkOS } from '@workos-inc/node';

const primary = 'org_merge_contained_primary';
const secondary = 'org_merge_contained_secondary';
const third = 'org_merge_contained_third';
const A = 'user_merge_a';
const B = 'user_merge_b';
const CSRF = 'm'.repeat(64);
const unavailable = {
  error: ORGANIZATION_MERGE_UNAVAILABLE_ERROR,
  message: ORGANIZATION_MERGE_UNAVAILABLE_MESSAGE,
};
let pool: Pool;
let app: Parameters<typeof request>[0];
let signingKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
let sequence = 0;

async function token(actor = A) {
  return new SignJWT({ client_id: 'client_mock_id' })
    .setProtectedHeader({ alg: 'RS256' }).setSubject(actor).setIssuedAt()
    .setJti(String(++sequence)).setExpirationTime('5m').sign(signingKey);
}
async function cookie(actor = A) {
  const id = `merge_session_${++sequence}`;
  state.sessions.set(id, { authenticated: true, user: state.users.get(actor), accessToken: await token(actor) });
  return `wos-session=${id}; csrf-token=${CSRF}`;
}

/**
 * Full rows across everything organization merge used to rewrite. Comparing the
 * whole set before/after catches a moved row, a dropped duplicate, a re-encrypted
 * token, an audit entry and a cross-organization effect alike.
 */
async function snapshot() {
  const result: Record<string, unknown> = {};
  for (const table of ['organizations','users','identity_workos_users','organization_memberships','organization_domains',
    'organization_credential_grants','organization_join_requests','working_group_memberships','member_profiles',
    'agent_contexts','brands','org_activities','org_stakeholders','registry_audit_log','revenue_events',
    'subscription_line_items','authorization_epochs']) {
    result[table] = (await pool.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
  }
  return result;
}

/** Make A a platform admin; asserts the seeded working group actually exists. */
async function makePlatformAdmin() {
  state.platformAdmin = true;
  const inserted = await pool.query(`INSERT INTO working_group_memberships (working_group_id,workos_user_id,status)
    SELECT id,$1,'active' FROM working_groups WHERE slug='aao-admin'`, [A]);
  expect(inserted.rowCount, 'aao-admin working group fixture must exist').toBe(1);
}

async function expectNoEffects(before: Record<string, unknown>) {
  expect(await snapshot()).toEqual(before);
  expect(state.calls.filter(c => c.startsWith('org_delete:') || c.startsWith('membership_create:'))).toEqual([]);
}

beforeAll(async () => {
  const connectionString = process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:55432/adcp_test';
  const url = new URL(connectionString);
  if (!['localhost','127.0.0.1','[::1]'].includes(url.hostname) || !url.pathname.endsWith('_test')) {
    throw new Error('Merge containment regressions require a disposable loopback *_test database');
  }
  pool = initializeDatabase({ connectionString });
  await runMigrations();
  const { HTTPServer } = await import('../../src/http.js');
  app = (new HTTPServer({ backgroundServices: 'refresh-only' }) as unknown as { app: Parameters<typeof request>[0] }).app;
  const keys = await generateKeyPair('RS256'); signingKey = keys.privateKey;
  __setJWKSForTesting(async () => keys.publicKey);
}, 60000);

async function cleanFixtures() {
  const orgs = [primary, secondary, third];
  const actors = [A, B];
  // organization_memberships has no foreign key to organizations or users, and
  // identities outlive the cascade from users, so both need explicit cleanup.
  const identities = (await pool.query(
    'SELECT identity_id FROM identity_workos_users WHERE workos_user_id = ANY($1)', [actors]
  )).rows.map(row => row.identity_id);
  await pool.query('DELETE FROM agent_contexts WHERE organization_id = ANY($1)', [orgs]);
  await pool.query('DELETE FROM brands WHERE workos_organization_id = ANY($1)', [orgs]);
  await pool.query('DELETE FROM member_profiles WHERE workos_organization_id = ANY($1)', [orgs]);
  await pool.query('DELETE FROM registry_audit_log WHERE workos_organization_id = ANY($1)', [orgs]);
  await pool.query('DELETE FROM working_group_memberships WHERE workos_user_id = ANY($1)', [actors]);
  await pool.query('DELETE FROM organization_memberships WHERE workos_user_id = ANY($1) OR workos_organization_id = ANY($2)', [actors, orgs]);
  await pool.query('DELETE FROM organizations WHERE workos_organization_id = ANY($1)', [orgs]);
  await pool.query('DELETE FROM users WHERE workos_user_id = ANY($1)', [actors]);
  if (identities.length) await pool.query('DELETE FROM identities WHERE id = ANY($1)', [identities]);
}

afterAll(async () => { if (pool) await cleanFixtures(); stopAuthTimers(); __setJWKSForTesting(null); await closeDatabase(); });

beforeEach(async () => {
  vi.clearAllMocks();
  state.calls = []; state.users.clear(); state.sessions.clear(); state.platformAdmin = false;
  for (const id of [A, B]) invalidateBanCache('user', id);
  await cleanFixtures();

  for (const id of [primary, secondary, third]) {
    await pool.query(
      "INSERT INTO organizations (workos_organization_id,name,is_personal) VALUES ($1,$2,false)",
      [id, id === primary ? 'Pinnacle Agency' : id === secondary ? 'Pinnacle Media' : 'Nova Brands']
    );
  }
  for (const id of [A, B]) {
    const user = {
      id,
      email: id === A ? 'sam@merge.example.test' : 'alex@merge.example.test',
      firstName: 'Sam', lastName: 'Adeyemi', emailVerified: true,
      createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
    };
    state.users.set(id, user);
    await pool.query('INSERT INTO users (workos_user_id,email,first_name,primary_organization_id) VALUES ($1,$2,$3,$4)',
      [id, user.email, 'Sam', secondary]);
  }
  // Rows the merge sequence used to move, re-encrypt or delete.
  await pool.query(`INSERT INTO organization_memberships (workos_user_id,workos_organization_id,workos_membership_id,email,role)
    VALUES ($1,$2,$3,$4,'owner')`, [B, secondary, 'om_merge_b', 'alex@merge.example.test']);
  await pool.query("INSERT INTO organization_domains (workos_organization_id,domain,verified) VALUES ($1,'merge.example.test',true)", [secondary]);
  await pool.query("INSERT INTO member_profiles (workos_organization_id,display_name,slug) VALUES ($1,'Pinnacle Media','pinnacle-media-merge')", [secondary]);
});

describe('mounted organization merge containment', () => {
  it('POST /api/admin/cleanup/merge requires authentication', async () => {
    const before = await snapshot();
    const response = await request(app).post('/api/admin/cleanup/merge')
      .set('Cookie', `csrf-token=${CSRF}`).set('X-CSRF-Token', CSRF)
      .send({ primary_org_id: primary, secondary_org_id: secondary });

    // Unlike the contained deletion routes, merge keeps its admin gating: the
    // refusal is never reachable anonymously.
    expect(response.status, JSON.stringify(response.body)).toBe(401);
    expect(response.body.error).not.toBe(ORGANIZATION_MERGE_UNAVAILABLE_ERROR);
    await expectNoEffects(before);
  });

  it('POST /api/admin/cleanup/merge rejects a non-admin authenticated caller', async () => {
    const before = await snapshot();
    const response = await request(app).post('/api/admin/cleanup/merge')
      .set('Cookie', await cookie(B)).set('X-CSRF-Token', CSRF)
      .send({ primary_org_id: primary, secondary_org_id: secondary });

    expect([401, 403]).toContain(response.status);
    expect(response.body.error).not.toBe(ORGANIZATION_MERGE_UNAVAILABLE_ERROR);
    await expectNoEffects(before);
  });

  it('CSRF rejection still precedes the contained route', async () => {
    const before = await snapshot();
    const response = await request(app).post('/api/admin/cleanup/merge')
      .set('Cookie', await cookie()).send({ primary_org_id: primary, secondary_org_id: secondary });

    expect(response.status).toBe(403);
    expect(response.body.error).toBe('CSRF validation failed');
    await expectNoEffects(before);
  });

  for (const body of [
    {},
    { primary_org_id: primary },
    { primary_org_id: primary, secondary_org_id: secondary },
    { primary_org_id: primary, secondary_org_id: primary },
    { primary_org_id: primary, secondary_org_id: secondary, stripe_customer_resolution: 'keep_primary' },
    { primary_org_id: primary, secondary_org_id: secondary, stripe_customer_resolution: 'not_a_resolution' },
    { primary_org_id: secondary, secondary_org_id: primary, force: true },
    { primary_org_id: 'org_merge_missing', secondary_org_id: 'org_merge_also_missing' },
  ]) {
    it(`platform admin gets the stable refusal for ${JSON.stringify(body)} with no effects`, async () => {
      await makePlatformAdmin();

      const before = await snapshot();
      state.calls = [];
      const response = await request(app).post('/api/admin/cleanup/merge')
        .set('Cookie', await cookie()).set('X-CSRF-Token', CSRF).send(body);

      expect(response.status, JSON.stringify(response.body)).toBe(503);
      expect(response.body).toEqual(unavailable);
      expect(response.body).not.toHaveProperty('details');
      await expectNoEffects(before);
    });
  }

  it('the static admin key reaches the refusal but cannot execute a merge', async () => {
    const before = await snapshot();
    const response = await request(app).post('/api/admin/cleanup/merge')
      .set('Authorization', 'Bearer merge-test-static-key')
      .send({ primary_org_id: primary, secondary_org_id: secondary });

    // Pinned rather than "one of several": the static admin key authenticates
    // and authorizes, so it is admitted by requireGlobalAdmin and then refused
    // by the containment. Either half changing should fail this test.
    expect(response.status, JSON.stringify(response.body)).toBe(503);
    expect(response.body).toEqual(unavailable);
    await expectNoEffects(before);
  });

  it('GET /api/admin/cleanup/preview-merge stays available and read-only', async () => {
    await makePlatformAdmin();

    const before = await snapshot();
    const response = await request(app)
      .get(`/api/admin/cleanup/preview-merge?primary=${primary}&secondary=${secondary}`)
      .set('Cookie', await cookie());

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.primary_org.id).toBe(primary);
    expect(response.body.secondary_org.id).toBe(secondary);
    // Preview genuinely reports the rows a merge would move...
    const tables = response.body.estimated_changes.map((c: { table_name: string }) => c.table_name);
    expect(tables).toContain('organization_memberships');
    expect(tables).toContain('member_profiles');
    // ...and changes nothing while doing it.
    await expectNoEffects(before);
  });

  it('preview-merge still requires authentication', async () => {
    const response = await request(app)
      .get(`/api/admin/cleanup/preview-merge?primary=${primary}&secondary=${secondary}`);
    expect(response.status).toBe(401);
  });

  it('a direct service call refuses against real fixtures', async () => {
    const before = await snapshot();
    const provider = {
      organizations: { deleteOrganization: vi.fn(async () => { state.calls.push('org_delete:direct'); }) },
      userManagement: { createOrganizationMembership: vi.fn(async () => { state.calls.push('membership_create:direct'); }) },
    } as unknown as WorkOS;

    await expect(mergeOrganizations(primary, secondary, A, provider))
      .rejects.toThrow(OrganizationMergeUnavailableError);

    expect(provider.organizations.deleteOrganization).not.toHaveBeenCalled();
    await expectNoEffects(before);
  });

  it('the Addie tool refuses execution against real fixtures', async () => {
    const before = await snapshot();
    const handlers = createAdminToolHandlers({
      is_mapped: true, is_member: false, slack_linked: true, organization: null,
      workos_user: { workos_user_id: A, email: 'sam@merge.example.test', first_name: 'Sam', last_name: 'Adeyemi' },
    } as unknown as MemberContext);

    const response = await handlers.get('merge_organizations')!({
      primary_org_id: primary, secondary_org_id: secondary, preview: false,
    });

    expect(response).toContain(ORGANIZATION_MERGE_UNAVAILABLE_ERROR);
    expect(response).not.toContain('Merge Complete');
    await expectNoEffects(before);
    // The execution path does not even read provider memberships.
    expect(state.calls.filter(c => c.startsWith('memberships:'))).toEqual([]);
  });

  it('the Addie tool still previews against real fixtures without effects', async () => {
    const before = await snapshot();
    const handlers = createAdminToolHandlers({
      is_mapped: true, is_member: false, slack_linked: true, organization: null,
      workos_user: { workos_user_id: A, email: 'sam@merge.example.test', first_name: 'Sam', last_name: 'Adeyemi' },
    } as unknown as MemberContext);

    const response = await handlers.get('merge_organizations')!({
      primary_org_id: primary, secondary_org_id: secondary, preview: true,
    });

    expect(response).toContain('Merge Preview');
    expect(response).toContain('organization_memberships');
    expect(response).not.toContain('To execute the merge');
    await expectNoEffects(before);
  });

  it('leaves the third organization untouched throughout', async () => {
    await makePlatformAdmin();

    const before = await snapshot();
    for (const body of [
      { primary_org_id: primary, secondary_org_id: third },
      { primary_org_id: third, secondary_org_id: secondary },
    ]) {
      const response = await request(app).post('/api/admin/cleanup/merge')
        .set('Cookie', await cookie()).set('X-CSRF-Token', CSRF).send(body);
      expect(response.status).toBe(503);
    }
    await expectNoEffects(before);
  });
});
