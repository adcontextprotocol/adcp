import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { generateKeyPair, SignJWT } from 'jose';
import type { Pool } from 'pg';

const state = vi.hoisted(() => {
  process.env.ADMIN_API_KEY = 'deletion-test-static-key';
  process.env.ADMIN_EMAILS = 'sam@deletion.example.test';
  return {
    members: [] as any[], users: new Map<string, any>(), sessions: new Map<string, any>(),
    calls: [] as string[], platformAdmin: false,
  };
});
vi.mock('@workos-inc/node', () => ({ WorkOS: class {
  authorization = { listOrganizationRoles: vi.fn(async () => { state.calls.push('roles'); return { data: [{ slug: 'owner', name: 'Owner' }, { slug: 'admin', name: 'Admin' }, { slug: 'member', name: 'Member' }] }; }) };
  organizations = { deleteOrganization: vi.fn(async (id: string) => { state.calls.push(`delete:${id}`); }) };
  apiKeys = { createValidation: vi.fn(async () => { state.calls.push('api_key'); throw new Error('Unexpected API key validation'); }) };
  userManagement = {
    loadSealedSession: ({ sessionData }: any) => {
      state.calls.push('session');
      return { authenticate: async () => state.sessions.get(sessionData) ?? { authenticated: false }, refresh: async () => ({ authenticated: false }) };
    },
    listOrganizationMemberships: vi.fn(async ({ userId, organizationId }: any) => {
      state.calls.push(`memberships:${userId}`);
      return { data: structuredClone(state.members.filter(m => (!userId || m.userId === userId) && (!organizationId || m.organizationId === organizationId))) };
    }),
    getUser: vi.fn(async (id: string) => { state.calls.push(`user:${id}`); return state.users.get(id); }),
  };
} }));
vi.mock('../../src/addie/mcp/admin-tools.js', () => ({ isWebUserAAOAdmin: vi.fn(async () => state.platformAdmin) }));
// HTTPServer supplies the production cookie/CSRF/organization route ordering. Keep unrelated
// route graphs inert so this focused harness does not initialize Addie indexes or agent tenants.
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
import * as stripeClient from '../../src/billing/stripe-client.js';
import * as auth from '../../src/middleware/auth.js';
import * as orgFilters from '../../src/db/org-filters.js';
import * as addie from '../../src/addie/index.js';
import * as notifications from '../../src/services/organization-membership-notifications.js';
import * as slack from '../../src/slack/org-group-dm.js';
import { OrganizationDatabase } from '../../src/db/organization-db.js';

const org = 'org_deletion_test';
const otherOrg = 'org_deletion_other';
const A = 'user_deletion_a';
const B = 'user_deletion_b';
const CSRF = 'd'.repeat(64);
const unavailable = { error: 'organization_deletion_unavailable', message: 'Organization deletion is temporarily unavailable.' };
const paths = [`/api/organizations/${org}`, `/api/admin/accounts/${org}`];
let pool: Pool;
let app: Parameters<typeof request>[0];
let signingKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
let sequence = 0;

async function token(actor = A, selected: string | null = org) {
  return new SignJWT({ client_id: 'client_mock_id', ...(selected ? { org_id: selected } : {}) })
    .setProtectedHeader({ alg: 'RS256' }).setSubject(actor).setIssuedAt().setJti(String(++sequence)).setExpirationTime('5m').sign(signingKey);
}
async function cookie(actor = A, selected: string | null = org) {
  const id = `deletion_session_${++sequence}`;
  state.sessions.set(id, { authenticated: true, user: state.users.get(actor), accessToken: await token(actor, selected) });
  return `wos-session=${id}; csrf-token=${CSRF}`;
}
async function member(userId: string, role = 'owner', organizationId = org) {
  const id = `om_${userId}_${organizationId}`;
  state.members = state.members.filter(m => m.id !== id);
  state.members.push({ id, userId, organizationId, status: 'active', role: { slug: role } });
  await pool.query(`INSERT INTO organization_memberships (workos_user_id,workos_organization_id,workos_membership_id,email,role)
    VALUES ($1,$2,$3,$4,$5) ON CONFLICT (workos_user_id,workos_organization_id) DO UPDATE SET role=$5`, [userId,organizationId,id,state.users.get(userId).email,role]);
}
async function snapshot() {
  const result: Record<string, unknown> = {};
  // Full rows catch cascades, grants/provenance rewrites, audit and unrelated changes.
  for (const table of ['organizations','users','identity_workos_users','organization_memberships','organization_domains',
    'organization_credential_grants','organization_join_requests','invitation_seat_types','seat_upgrade_requests',
    'registry_audit_log','revenue_events','working_group_memberships','authorization_epochs']) {
    result[table] = (await pool.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
  }
  return result;
}
async function assertContained(path: string, headers: Record<string, string>, body: unknown = { confirmation: 'Pinnacle Agency' }) {
  const before = await snapshot();
  const providerBefore = structuredClone(state.members);
  state.calls = [];
  const querySpy = vi.spyOn(pool, 'query');
  const connectSpy = vi.spyOn(pool, 'connect');
  const auditSpy = vi.spyOn(OrganizationDatabase.prototype, 'recordAuditLog');
  const billingSpy = vi.spyOn(OrganizationDatabase.prototype, 'getSubscriptionInfo');
  const stripeSpy = vi.spyOn(stripeClient, 'getStripeSubscriptionInfo');
  const cacheSpies = [vi.spyOn(auth, 'invalidateSessionCache'), vi.spyOn(orgFilters, 'invalidateMembershipCache')];
  let response;
  try {
    response = await request(app).delete(path).set(headers).send(body as object);
    // Include the real response-finish observer; do not mock it inert.
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(response.status, JSON.stringify({ body: response.body, providerCalls: state.calls })).toBe(503);
    expect(response.body).toEqual(unavailable);
    expect(state.calls).toEqual([]);
    expect(querySpy).not.toHaveBeenCalled();
    expect(connectSpy).not.toHaveBeenCalled();
    expect(auditSpy).not.toHaveBeenCalled();
    expect(billingSpy).not.toHaveBeenCalled();
    expect(stripeSpy).not.toHaveBeenCalled();
    for (const spy of cacheSpies) expect(spy).not.toHaveBeenCalled();
    for (const spy of [addie.sendAccountLinkedMessage, addie.invalidateMemberContextCache,
      notifications.notifyMembershipSeats, notifications.notifyMembershipSeatRequest, slack.notifyMemberSeatChanged]) expect(spy).not.toHaveBeenCalled();
  } finally {
    querySpy.mockRestore(); connectSpy.mockRestore(); auditSpy.mockRestore(); billingSpy.mockRestore(); stripeSpy.mockRestore();
    for (const spy of cacheSpies) spy.mockRestore();
  }
  expect(await snapshot()).toEqual(before);
  expect(state.members).toEqual(providerBefore);
  return response;
}
beforeAll(async () => {
  const connectionString = process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:55432/adcp_test';
  const url = new URL(connectionString);
  if (!['localhost','127.0.0.1','[::1]'].includes(url.hostname) || !url.pathname.endsWith('_test')) {
    throw new Error('Deletion regressions require a disposable loopback *_test database');
  }
  pool = initializeDatabase({ connectionString });
  await runMigrations();
  const { HTTPServer } = await import('../../src/http.js');
  app = (new HTTPServer({ backgroundServices: 'refresh-only' }) as unknown as { app: Parameters<typeof request>[0] }).app;
  const keys = await generateKeyPair('RS256'); signingKey = keys.privateKey;
  __setJWKSForTesting(async () => keys.publicKey);
}, 60000);
async function cleanFixtures() {
  // organization_memberships has no foreign key to organizations or users, and
  // identities outlive the cascade from users, so both need explicit cleanup.
  // Without it the local owner/admin rows from one case bleed into the next —
  // the grant-only and anonymous cases would silently run with a leftover
  // membership — and rows leak into the shared test database.
  const identities = (await pool.query(
    'SELECT identity_id FROM identity_workos_users WHERE workos_user_id = ANY($1)', [[A,B]]
  )).rows.map(row => row.identity_id);
  await pool.query('DELETE FROM registry_audit_log WHERE workos_organization_id = ANY($1)', [[org,otherOrg]]);
  await pool.query('DELETE FROM working_group_memberships WHERE workos_user_id = ANY($1)', [[A,B]]);
  await pool.query('DELETE FROM organization_memberships WHERE workos_user_id = ANY($1) OR workos_organization_id = ANY($2)', [[A,B],[org,otherOrg]]);
  await pool.query('DELETE FROM organizations WHERE workos_organization_id = ANY($1)', [[org,otherOrg]]);
  await pool.query('DELETE FROM users WHERE workos_user_id = ANY($1)', [[A,B]]);
  if (identities.length) await pool.query('DELETE FROM identities WHERE id = ANY($1)', [identities]);
}
afterAll(async () => { if (pool) await cleanFixtures(); stopAuthTimers(); __setJWKSForTesting(null); await closeDatabase(); });
beforeEach(async () => {
  vi.clearAllMocks(); state.calls = []; state.members = []; state.users.clear(); state.sessions.clear(); state.platformAdmin = false;
  for (const id of [A,B]) invalidateBanCache('user',id);
  await cleanFixtures();
  for (const id of [org,otherOrg]) await pool.query("INSERT INTO organizations (workos_organization_id,name,is_personal) VALUES ($1,'Pinnacle Agency',false)", [id]);
  for (const id of [A,B]) {
    const user = { id, email: id === A ? 'sam@deletion.example.test' : 'alex@deletion.example.test', firstName: 'Sam', lastName: 'Adeyemi', emailVerified: true, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() };
    state.users.set(id,user);
    await pool.query('INSERT INTO users (workos_user_id,email,first_name,primary_organization_id) VALUES ($1,$2,$3,$4)', [id,user.email,'Sam',org]);
  }
  // Re-linking A onto B's identity orphans the identity the insert trigger just
  // made for A, so drop it here; cleanFixtures only sees the surviving link.
  const identity = (await pool.query('SELECT identity_id FROM identity_workos_users WHERE workos_user_id=$1',[B])).rows[0].identity_id;
  const orphaned = (await pool.query('SELECT identity_id FROM identity_workos_users WHERE workos_user_id=$1',[A])).rows[0].identity_id;
  await pool.query('UPDATE identity_workos_users SET identity_id=$1,is_primary=false WHERE workos_user_id=$2',[identity,A]);
  if (orphaned !== identity) await pool.query('DELETE FROM identities WHERE id=$1',[orphaned]);
  await pool.query("INSERT INTO organization_domains (workos_organization_id,domain,verified) VALUES ($1,'deletion.example.test',true)",[org]);
});

describe('mounted organization deletion lifecycle containment', () => {
  for (const path of paths) {
    for (const [actor,sibling] of [[A,B],[B,A]]) it(`${path}: linked ${actor} cannot borrow sibling owner`, async () => {
      // Make the sibling canonical in both directions, not just linked.
      await pool.query('UPDATE identity_workos_users SET is_primary=false WHERE workos_user_id = ANY($1)',[[A,B]]);
      await pool.query('UPDATE identity_workos_users SET is_primary=true WHERE workos_user_id=$1',[sibling]);
      await member(sibling);
      await assertContained(path, { Cookie: await cookie(actor), 'X-CSRF-Token': CSRF, 'X-Organization-Id': org });
    });
    for (const role of ['owner','admin','member']) it(`${path}: exact ${role} cannot bypass`, async () => {
      await member(A,role);
      await assertContained(path, { Cookie: await cookie(), 'X-CSRF-Token': CSRF, 'X-Organization-Id': org });
    });
    it(`${path}: platform admin cannot bypass`, async () => {
      state.platformAdmin = true;
      const platform = await pool.query(`INSERT INTO working_group_memberships (working_group_id,workos_user_id,status)
        SELECT id,$1,'active' FROM working_groups WHERE slug='aao-admin'`,[A]);
      expect(platform.rowCount).toBe(1);
      await assertContained(path, { Cookie: await cookie(), 'X-CSRF-Token': CSRF });
    });
    it(`${path}: grant-only, email/domain and primary organization cannot bypass`, async () => {
      await pool.query("INSERT INTO organization_credential_grants (workos_organization_id,workos_user_id,role,granted_by_workos_user_id) VALUES ($1,$2,'owner',$3)",[org,A,B]);
      await assertContained(path, { Cookie: await cookie(), 'X-CSRF-Token': CSRF });
    });
    for (const bearer of ['deletion-test-static-key','sk_workos_tenant_key','invalid']) it(`${path}: ${bearer} cannot bypass or trigger credential validation`, async () => {
      await assertContained(path, { Authorization: `Bearer ${bearer}` });
    });
    for (const selected of [org,otherOrg,null]) it(`${path}: JWT selected ${selected} and conflicting selectors do not select a deletion`, async () => {
      await member(A); await member(B,'owner',otherOrg);
      await assertContained(`${path}?org=${otherOrg}&organization_id=${otherOrg}`, {
        Authorization: `Bearer ${await token(A,selected)}`, 'X-Organization-Id': otherOrg,
      }, { confirmation: 'Pinnacle Agency', organization_id: otherOrg, organizationId: [org,otherOrg], orgId: otherOrg, force: true });
    });
    for (const status of [null,'active','past_due','trialing','canceled']) it(`${path}: subscription ${status} cannot bypass or trigger Stripe`, async () => {
      await member(A);
      await pool.query("UPDATE organizations SET subscription_status=$1,stripe_customer_id='cus_deletion_spy' WHERE workos_organization_id=$2",[status,org]);
      await assertContained(path, { Cookie: await cookie(), 'X-CSRF-Token': CSRF });
    });
    it(`${path}: unknown organization and absent confirmation return the same contract`, async () => {
      await assertContained(path.replace(org,'org_deletion_missing'), { Authorization: `Bearer ${await token()}` }, {});
    });
    it(`${path}: replay and concurrent requests stay effect-free`, async () => {
      await member(A);
      const headers = { Authorization: `Bearer ${await token()}` };
      const before = await snapshot();
      const responses = await Promise.all(Array.from({length: 4}, () => request(app).delete(path).set(headers).send({ confirmation: 'Pinnacle Agency' })));
      for (const response of responses) { expect(response.status).toBe(503); expect(response.body).toEqual(unavailable); }
      expect(state.calls).toEqual([]); expect(await snapshot()).toEqual(before);
      await assertContained(path,headers);
    });
    it(`${path}: cookie CSRF rejection still precedes route handling`, async () => {
      const before = await snapshot();
      const response = await request(app).delete(path).set('Cookie',await cookie()).send({ confirmation: 'Pinnacle Agency' });
      expect(response.status).toBe(403); expect(response.body.error).toBe('CSRF validation failed');
      expect(state.calls).toEqual([]); expect(await snapshot()).toEqual(before);
    });
    it(`${path}: anonymous callers with valid CSRF get no organization information`, async () => {
      await assertContained(path, { Cookie: `csrf-token=${CSRF}`, 'X-CSRF-Token': CSRF });
    });
  }
  for (const path of ['/api/organizations', '/api/admin/accounts', `/api/organizations/${org}/unmounted-deletion-path`, `/api/admin/accounts/${org}/unmounted-deletion-path`]) {
    it(`unmounted DELETE ${path} stays 404`, async () => {
      const response = await request(app).delete(path).set('Cookie',`csrf-token=${CSRF}`).set('X-CSRF-Token',CSRF).send({});
      expect(response.status,JSON.stringify(response.body)).toBe(404);
      expect(response.body.error).not.toBe(unavailable.error);
      expect(state.calls).toEqual([]);
    });
  }
  for (const path of [`/api/organizations/${org}/roles`, `/api/organizations/${org}/domains`, `/api/admin/accounts/${org}/payments`]) {
    it(`neighboring GET ${path} still requires authentication`, async () => {
      const response = await request(app).get(path);
      expect(response.status,JSON.stringify(response.body)).toBe(401);
      expect(response.body.error).not.toBe(unavailable.error);
    });
  }
  // Both neighbours share the contained prefix and need an extra path segment, so they
  // prove the containment route match was not broadened over sibling mutations.
  for (const path of [`/api/organizations/${org}/members/om_protected`,
    `/api/admin/accounts/${org}/agents/${encodeURIComponent('https://agent.deletion.example.test')}`]) {
    it(`neighboring DELETE ${path} still requires authentication`, async () => {
      const response = await request(app).delete(path).set('Cookie',`csrf-token=${CSRF}`).set('X-CSRF-Token',CSRF).send({});
      expect(response.status,JSON.stringify(response.body)).toBe(401);
      expect(response.body.error).not.toBe(unavailable.error);
    });
  }
  it('read-only organization roles remain available through real authentication', async () => {
    await member(A); await member(B);
    const response = await request(app).get(`/api/organizations/${org}/roles`).set('Cookie',await cookie());
    expect(response.status,JSON.stringify(response.body)).toBe(200);
    expect(response.body.roles.length).toBeGreaterThan(0);
    expect(state.calls).toContain('session');
    expect(state.calls.some(c => c.startsWith('delete:'))).toBe(false);
  });
});
