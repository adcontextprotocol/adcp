import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { Pool } from 'pg';

const state = vi.hoisted(() => {
  process.env.ADMIN_API_KEY = 'membership-race-static-key';
  return {
    members: new Map<string, any>(), invitations: new Map<string, any>(), users: new Map<string, any>(), sessions: new Map<string, any>(),
    reads: [] as string[], writes: [] as string[], notifications: [] as string[], apiKeyValidations: 0,
    beforeRead: undefined as undefined | (() => Promise<void>),
    afterWrite: undefined as undefined | (() => Promise<void>),
    rejectWrite: undefined as unknown,
    outage: false,
    afterTargetRead: undefined as undefined | (() => Promise<void>),
    rejectActions: new Map<string, unknown>(),
  };
});
vi.mock('@workos-inc/node', () => {
  async function read(name: string) {
    state.reads.push(name);
    if (state.outage) throw new Error('source unavailable');
    if (state.beforeRead) { const hook = state.beforeRead; state.beforeRead = undefined; await hook(); }
  }
  async function write(name: string, action: () => unknown) {
    state.writes.push(name);
    if (state.rejectWrite) throw state.rejectWrite;
    if (state.rejectActions.has(name)) throw state.rejectActions.get(name);
    const value = action();
    if (state.afterWrite) { const hook = state.afterWrite; state.afterWrite = undefined; await hook(); }
    return structuredClone(value);
  }
  return { WorkOS: class {
    apiKeys = { createValidation: async () => { state.apiKeyValidations++; return { apiKey: { id: 'key_test', name: 'test', owner: { id: 'org_mutation_race_test' }, permissions: ['admin'] } }; } };
    userManagement = {
      loadSealedSession: ({ sessionData }: any) => ({ authenticate: async () => state.sessions.get(sessionData) ?? { authenticated: false }, refresh: async () => ({ authenticated: false }) }),
      listOrganizationMemberships: async ({ userId, organizationId, statuses }: any) => {
        await read('list_memberships');
        return { data: structuredClone([...state.members.values()].filter(m => (!userId || m.userId === userId) && (!organizationId || m.organizationId === organizationId) && (!statuses || statuses.includes(m.status)))) };
      },
      getOrganizationMembership: async (id: string) => {
        await read('get_membership');
        if (!state.members.has(id)) throw Object.assign(new Error('not found'), { status: 404 });
        const snapshot = structuredClone(state.members.get(id));
        if (id.includes('target') && state.afterTargetRead) { const hook = state.afterTargetRead; state.afterTargetRead = undefined; await hook(); }
        return snapshot;
      },
      createOrganizationMembership: async ({ userId, organizationId, roleSlug }: any) => write('create_membership', () => {
        if ([...state.members.values()].some(m => m.userId === userId && m.organizationId === organizationId)) throw Object.assign(new Error('exists'), { code: 'organization_membership_already_exists' });
        const m = { id: `om_${userId}`, userId, organizationId, status: 'active', role: { slug: roleSlug } }; state.members.set(m.id, m); return m;
      }),
      updateOrganizationMembership: async (id: string, { roleSlug }: any) => write('update_membership', () => { const m = state.members.get(id); m.role.slug = roleSlug; return m; }),
      deleteOrganizationMembership: async (id: string) => write('delete_membership', () => { state.members.delete(id); }),
      listUsers: async ({ email }: any) => { await read('list_users'); return { data: structuredClone([...state.users.values()].filter(u => u.email === email)) }; },
      getUser: async (id: string) => { await read('get_user'); return structuredClone(state.users.get(id)); },
      sendInvitation: async ({ email, organizationId, inviterUserId, roleSlug }: any) => write('send_invitation', () => {
        const invitation = { id: `inv_${state.invitations.size + 1}`, email, organizationId, inviterUserId, roleSlug, state: 'pending', expiresAt: new Date(Date.now() + 86400000).toISOString(), acceptInvitationUrl: 'https://membership-race.example.test/accept' };
        state.invitations.set(invitation.id, invitation); return invitation;
      }),
      getInvitation: async (id: string) => { await read('get_invitation'); return structuredClone(state.invitations.get(id)); },
      revokeInvitation: async (id: string) => write('revoke_invitation', () => { state.invitations.get(id).state = 'revoked'; }),
    };
  } };
});
vi.mock('../../src/services/organization-membership-notifications.js', () => ({
  notifyMembershipSeats: async () => { state.notifications.push('seats'); },
  notifyMembershipSeatRequest: async () => { state.notifications.push('seat_request'); },
}));
vi.mock('../../src/slack/org-group-dm.js', () => ({
  notifyMemberSeatChanged: async () => { state.notifications.push('member_seat'); },
}));
vi.mock('../../src/addie/mcp/admin-tools.js', () => ({ isWebUserAAOAdmin: vi.fn().mockResolvedValue(false) }));
vi.mock('../../src/middleware/rate-limit.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/middleware/rate-limit.js')>()),
  invitationRateLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  orgCreationRateLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../../src/middleware/organization-authorization-observer.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/middleware/organization-authorization-observer.js')>()),
  observeLinkedCredentialOrganizationAuthorization: vi.fn(),
}));
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

import { initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { __setJWKSForTesting } from '../../src/auth/workos-jwt.js';
import { stopAuthTimers } from '../../src/middleware/auth.js';
import { JoinRequestDatabase } from '../../src/db/join-request-db.js';

const org = 'org_mutation_race_test';
const otherOrg = 'org_mutation_race_other';
const A = 'user_mutation_race_a';
const B = 'user_mutation_race_b';
const target = 'user_mutation_race_target';
const newcomer = 'user_mutation_race_new';
let pool: Pool;
let signingKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
let verificationKey: Awaited<ReturnType<typeof generateKeyPair>>['publicKey'];
let sequence = 0;
let joinId: string;
let seatId: string;
let identityId: string;
let app: Parameters<typeof request>[0];
const CSRF_TOKEN = 'b'.repeat(64);

async function token(actor = A, selected: string | undefined = org) {
  return new SignJWT({ client_id: 'client_mock_id', ...(selected ? { org_id: selected } : {}) }).setProtectedHeader({ alg: 'RS256' }).setSubject(actor).setIssuedAt().setJti(String(++sequence)).setExpirationTime('5m').sign(signingKey);
}
async function cookie(actor = A, selected: string | undefined = org) {
  const value = `session_${++sequence}`;
  state.sessions.set(value, { authenticated: true, user: state.users.get(actor), accessToken: await token(actor, selected) });
  return `wos-session=${value}; csrf-token=${CSRF_TOKEN}`;
}
async function member(userId: string, role = 'owner', organizationId = org) {
  const id = `om_${userId}`;
  state.members.set(id, { id, userId, organizationId, status: 'active', role: { slug: role } });
  await pool.query(`INSERT INTO organization_memberships (workos_user_id, workos_organization_id, workos_membership_id, email, role, seat_type)
    VALUES ($1,$2,$3,$4,$5,'community_only') ON CONFLICT (workos_user_id,workos_organization_id) DO UPDATE SET role=$5, workos_membership_id=$3`, [userId, organizationId, id, `${userId}@membership-race.example.test`, role]);
}
async function removeActor(userId = A) {
  state.members.delete(`om_${userId}`);
  await pool.query('DELETE FROM organization_memberships WHERE workos_user_id=$1 AND workos_organization_id=$2', [userId, org]);
}
async function noEffects() {
  expect(state.writes).toEqual([]);
  expect(state.notifications).toEqual([]);
  expect((await pool.query('SELECT id FROM registry_audit_log WHERE workos_organization_id=$1', [org])).rowCount).toBe(0);
}
function barrier() {
  let reached!: () => void;
  let release!: () => void;
  const arrived = new Promise<void>(resolve => { reached = resolve; });
  const resumed = new Promise<void>(resolve => { release = resolve; });
  return { arrived, release, hook: async () => { reached(); await resumed; } };
}
async function waitForDatabaseLock(options: { pid?: number; queryFragment?: string }): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = await pool.query(
      `SELECT 1 FROM pg_stat_activity
       WHERE datname = current_database()
         AND pid <> pg_backend_pid()
         AND wait_event_type = 'Lock'
         AND ($1::int IS NULL OR pid = $1)
         AND ($2::text IS NULL OR query ILIKE '%' || $2 || '%')`,
      [options.pid ?? null, options.queryFragment ?? null],
    );
    if (result.rowCount) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for blocked database query: ${JSON.stringify(options)}`);
}
type Family = { name: string; method: 'post' | 'patch' | 'delete'; path: () => string; body?: () => object };
const families: Family[] = [
  { name: 'join approve', method: 'post', path: () => `/join-requests/${joinId}/approve` },
  { name: 'join reject', method: 'post', path: () => `/join-requests/${joinId}/reject` },
  { name: 'domain add', method: 'post', path: () => '/domain-users/add', body: () => ({ email: `${newcomer}@membership-race.example.test` }) },
  { name: 'invite', method: 'post', path: () => '/invitations', body: () => ({ email: 'invitee@membership-race.example.test' }) },
  { name: 'revoke invite', method: 'delete', path: () => '/invitations/inv_existing' },
  { name: 'resend invite', method: 'post', path: () => '/invitations/inv_existing/resend' },
  { name: 'by email create', method: 'post', path: () => '/members/by-email', body: () => ({ email: `${newcomer}@membership-race.example.test` }) },
  { name: 'role and seat', method: 'patch', path: () => `/members/om_${target}`, body: () => ({ role: 'admin', seat_type: 'contributor' }) },
  { name: 'remove member', method: 'delete', path: () => `/members/om_${target}` },
  { name: 'request seat', method: 'post', path: () => '/seat-requests', body: () => ({ resource_type: 'working_group', resource_id: 'new_request' }) },
  { name: 'approve seat', method: 'post', path: () => `/seat-requests/${seatId}/approve` },
  { name: 'deny seat', method: 'post', path: () => `/seat-requests/${seatId}/deny` },
];
function call(family: Family, authCookie: string) {
  return request(app)[family.method](`/api/organizations/${org}${family.path()}`)
    .set('Cookie', authCookie).set('X-CSRF-Token', CSRF_TOKEN).send(family.body?.() ?? {});
}

beforeAll(async () => {
  pool = initializeDatabase({ connectionString: process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:55432/adcp_mutation_race_test', maxPoolSize: 12 });
  await runMigrations();
  const { HTTPServer } = await import('../../src/http.js');
  app = (new HTTPServer({ backgroundServices: 'refresh-only' }) as unknown as { app: Parameters<typeof request>[0] }).app;
  const keys = await generateKeyPair('RS256');
  signingKey = keys.privateKey;
  verificationKey = keys.publicKey;
  __setJWKSForTesting(async () => verificationKey);
}, 60000);
afterAll(async () => { stopAuthTimers(); __setJWKSForTesting(null); await closeDatabase(); });
beforeEach(async () => {
  state.members.clear(); state.invitations.clear(); state.users.clear(); state.sessions.clear(); state.reads = []; state.writes = []; state.notifications = []; state.apiKeyValidations = 0;
  state.beforeRead = undefined; state.afterWrite = undefined; state.rejectWrite = undefined; state.outage = false; state.afterTargetRead = undefined; state.rejectActions.clear();
  await pool.query('DROP TRIGGER IF EXISTS membership_race_audit ON registry_audit_log');
  await pool.query('DROP TRIGGER IF EXISTS membership_race_update ON organization_memberships');
  await pool.query('DELETE FROM bans WHERE entity_id = ANY($1)', [[A, B, org, otherOrg]]);
  await pool.query('DELETE FROM registry_audit_log WHERE workos_organization_id = ANY($1)', [[org, otherOrg]]);
  await pool.query('DELETE FROM organization_join_requests WHERE workos_organization_id = $1', [org]);
  await pool.query('DELETE FROM invitation_seat_types WHERE workos_organization_id = $1', [org]);
  await pool.query('DELETE FROM seat_upgrade_requests WHERE workos_organization_id = $1', [org]);
  await pool.query('DELETE FROM organization_memberships WHERE workos_organization_id = ANY($1)', [[org, otherOrg]]);
  await pool.query('DELETE FROM organizations WHERE workos_organization_id = ANY($1)', [[org, otherOrg]]);
  await pool.query('DELETE FROM users WHERE workos_user_id = ANY($1)', [[A, B, target, newcomer]]);
  for (const id of [org, otherOrg]) await pool.query("INSERT INTO organizations (workos_organization_id,name,is_personal,membership_tier,subscription_status) VALUES ($1,'Pinnacle Agency',false,'company_standard','active')", [id]);
  for (const id of [A, B, target, newcomer]) {
    const user = { id, email: `${id}@membership-race.example.test`, firstName: 'Sam', lastName: 'Adeyemi', emailVerified: true, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() };
    state.users.set(id, user);
    await pool.query('INSERT INTO users (workos_user_id,email,first_name,primary_organization_id) VALUES ($1,$2,$3,$4)', [id,user.email,'Sam',org]);
  }
  identityId = (await pool.query('SELECT identity_id FROM identity_workos_users WHERE workos_user_id=$1', [B])).rows[0].identity_id;
  await pool.query('UPDATE identity_workos_users SET identity_id=$1, is_primary=false WHERE workos_user_id=$2', [identityId,A]);
  await member(A); await member(target,'member');
  joinId = (await pool.query('INSERT INTO organization_join_requests (workos_user_id,user_email,workos_organization_id) VALUES ($1,$2,$3) RETURNING id', [newcomer,`${newcomer}@membership-race.example.test`,org])).rows[0].id;
  seatId = (await pool.query("INSERT INTO seat_upgrade_requests (workos_organization_id,workos_user_id,resource_type,resource_id) VALUES ($1,$2,'working_group','existing') RETURNING id", [org,target])).rows[0].id;
  await pool.query("INSERT INTO organization_domains (workos_organization_id,domain,verified) VALUES ($1,'membership-race.example.test',true) ON CONFLICT DO NOTHING", [org]);
  await pool.query("INSERT INTO slack_user_mappings (slack_user_id,slack_email,workos_user_id) VALUES ('U_MEMBERSHIP_RACE_TEST',$1,$2) ON CONFLICT (slack_user_id) DO UPDATE SET slack_email=$1,workos_user_id=$2", [`${newcomer}@membership-race.example.test`,newcomer]);
  state.invitations.set('inv_existing', { id:'inv_existing',organizationId:org,email:'existing@membership-race.example.test',state:'pending',expiresAt:new Date(Date.now()+86400000).toISOString() });
});

async function suppressAudit() {
  await pool.query('CREATE OR REPLACE FUNCTION membership_race_audit_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$');
  await pool.query("CREATE TRIGGER membership_race_audit BEFORE INSERT ON registry_audit_log FOR EACH ROW WHEN (NEW.workos_organization_id = 'org_mutation_race_test') EXECUTE FUNCTION membership_race_audit_fn()");
}
async function localTarget() {
  return (await pool.query('SELECT role,seat_type FROM organization_memberships WHERE workos_user_id=$1 AND workos_organization_id=$2', [target, org])).rows[0];
}
function staticRole(userId: string, role: string) {
  return request(app).post(`/api/organizations/${org}/members/by-email`)
    .set('Authorization', 'Bearer membership-race-static-key').send({ email: `${userId}@membership-race.example.test`, role });
}

// These barriers exercise changes committed during awaited provider reads.
// WorkOS does not atomically compare actor and target state with the write:
// a target can still change between its read and the final actor read, or
// either can change after the final read. These tests do not claim provider
// CAS/atomicity; detected post-write changes require honest reconciliation.
describe('independent mounted management race and residual-state attacks', () => {
  it('production CSRF middleware rejects a mismatched cookie token before any provider or audit effect', async () => {
    const response = await request(app).post(`/api/organizations/${org}/invitations`)
      .set('Cookie', await cookie()).set('X-CSRF-Token', 'c'.repeat(64))
      .send({ email: 'invitee@membership-race.example.test' });
    expect(response.status).toBe(403);
    expect(response.body.error).toBe('CSRF validation failed');
    expect(state.reads).toEqual([]);
    await noEffects();
  });

  it('join approval holds the pending row until commit, then cancellation loses and replay makes no provider call', async () => {
    const gate = barrier();
    state.afterWrite = gate.hook;
    const approval = call(families[0], await cookie()).then(response => response);
    await gate.arrived;

    const cancellation = new JoinRequestDatabase().cancelRequest(joinId, newcomer);
    await waitForDatabaseLock({ queryFragment: 'UPDATE organization_join_requests' });
    gate.release();

    expect((await approval).status).toBe(200);
    expect(await cancellation).toBeNull();
    expect((await pool.query('SELECT status FROM organization_join_requests WHERE id=$1', [joinId])).rows[0].status).toBe('approved');
    expect(state.writes).toEqual(['create_membership']);

    const beforeReplay = [...state.writes];
    expect((await call(families[0], await cookie())).status).toBe(409);
    expect(state.writes).toEqual(beforeReplay);
    expect((await pool.query('SELECT id FROM registry_audit_log WHERE workos_organization_id=$1', [org])).rowCount).toBe(1);
  });

  it('requester cancellation holding the row lock wins before approval and prevents every provider call', async () => {
    const canceller = await pool.connect();
    try {
      await canceller.query('BEGIN');
      const cancelled = await canceller.query(
        "UPDATE organization_join_requests SET status='cancelled', updated_at=NOW() WHERE id=$1 AND workos_user_id=$2 AND status='pending' RETURNING id",
        [joinId, newcomer],
      );
      expect(cancelled.rowCount).toBe(1);

      const approval = call(families[0], await cookie()).then(response => response);
      await waitForDatabaseLock({ queryFragment: 'SELECT * FROM organization_join_requests' });
      expect(state.writes).toEqual([]);
      await canceller.query('COMMIT');

      expect((await approval).status).toBe(409);
      expect((await pool.query('SELECT status FROM organization_join_requests WHERE id=$1', [joinId])).rows[0].status).toBe('cancelled');
      await noEffects();
    } finally {
      await canceller.query('ROLLBACK').catch(() => {});
      canceller.release();
    }
  });

  it('JWT verification source outage returns authorization_unavailable before provider reads or writes', async () => {
    const bearer = await token();
    __setJWKSForTesting(async () => { throw Object.assign(new Error('JWKS unavailable'), { code: 'ECONNRESET' }); });
    try {
      const response = await request(app).post(`/api/organizations/${org}/invitations`)
        .set('Authorization', `Bearer ${bearer}`).send({ email: 'invitee@membership-race.example.test' });
      expect(response.status).toBe(503);
      expect(response.body.error).toBe('authorization_unavailable');
      expect(state.reads).toEqual([]);
      await noEffects();
    } finally {
      __setJWKSForTesting(async () => verificationKey);
    }
  });

  it('warm cookie JWT source outage returns authorization_unavailable before provider reads, writes, or audit', async () => {
    const auth = await cookie();
    __setJWKSForTesting(async () => { throw Object.assign(new Error('JWKS unavailable'), { code: 'ECONNRESET' }); });
    try {
      const response = await request(app).post(`/api/organizations/${org}/invitations`)
        .set('Cookie', auth).set('X-CSRF-Token', CSRF_TOKEN).send({ email: 'invitee@membership-race.example.test' });
      expect(response.status).toBe(503);
      expect(response.body.error).toBe('authorization_unavailable');
      expect(state.reads).toEqual([]);
      await noEffects();
    } finally {
      __setJWKSForTesting(async () => verificationKey);
    }
  });

  it('unsupported JWT algorithm remains 401 and makes no provider or audit call', async () => {
    const payload = Buffer.from(JSON.stringify({ sub: A, client_id: 'client_mock_id', org_id: org })).toString('base64url');
    const bearer = `${Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')}.${payload}.unsupported`;
    const response = await request(app).post(`/api/organizations/${org}/invitations`)
      .set('Authorization', `Bearer ${bearer}`).send({ email: 'invitee@membership-race.example.test' });
    expect(response.status).toBe(401);
    expect(state.reads).toEqual([]);
    await noEffects();
  });

  it('malformed JWT with an API-key-like prefix remains local 401 and makes no provider or audit call', async () => {
    const response = await request(app).post(`/api/organizations/${org}/invitations`)
      .set('Authorization', 'Bearer sk_.e30.eA').send({ email: 'invitee@membership-race.example.test' });
    expect(response.status).toBe(401);
    expect(response.body.error).not.toBe('authorization_unavailable');
    expect(state.apiKeyValidations).toBe(0);
    expect(state.reads).toEqual([]);
    await noEffects();
  });

  it('unknown kid from a healthy JWKS remains 401 and makes no provider or audit call', async () => {
    const jwk = { ...await exportJWK(verificationKey), alg: 'RS256', kid: 'known-key' };
    __setJWKSForTesting(createLocalJWKSet({ keys: [jwk] }));
    try {
      const bearer = await new SignJWT({ client_id: 'client_mock_id', org_id: org })
        .setProtectedHeader({ alg: 'RS256', kid: 'unknown-key' })
        .setSubject(A)
        .setIssuedAt()
        .setJti(String(++sequence))
        .setExpirationTime('5m')
        .sign(signingKey);
      const response = await request(app).post(`/api/organizations/${org}/invitations`)
        .set('Authorization', `Bearer ${bearer}`).send({ email: 'invitee@membership-race.example.test' });
      expect(response.status).toBe(401);
      expect(state.reads).toEqual([]);
      await noEffects();
    } finally {
      __setJWKSForTesting(async () => verificationKey);
    }
  });

  it('bearer user-source outage returns authorization_unavailable before provider reads or writes', async () => {
    const bearer = await token();
    await pool.query('ALTER TABLE users RENAME TO membership_race_users_unavailable');
    try {
      const response = await request(app).post(`/api/organizations/${org}/invitations`)
        .set('Authorization', `Bearer ${bearer}`).send({ email: 'invitee@membership-race.example.test' });
      expect(response.status).toBe(503);
      expect(response.body.error).toBe('authorization_unavailable');
      expect(state.reads).toEqual([]);
      expect(state.writes).toEqual([]);
    } finally {
      await pool.query('ALTER TABLE membership_race_users_unavailable RENAME TO users');
    }
    await noEffects();
  });

  it('invalid bearer signature remains 401 and makes no provider call', async () => {
    const unrelated = await generateKeyPair('RS256');
    const bearer = await new SignJWT({ client_id: 'client_mock_id', org_id: org })
      .setProtectedHeader({ alg: 'RS256' }).setSubject(A).setIssuedAt().setExpirationTime('5m').sign(unrelated.privateKey);
    const response = await request(app).post(`/api/organizations/${org}/invitations`)
      .set('Authorization', `Bearer ${bearer}`).send({ email: 'invitee@membership-race.example.test' });
    expect(response.status).toBe(401);
    expect(state.reads).toEqual([]);
    await noEffects();
  });

  for (const role of ['owner', 'admin']) it(`target promotion to ${role} before deletion is terminal`, async () => {
    await member(A, 'admin');
    const gate = barrier();
    // The first subsequent authority read finishes readProvider(target). The
    // second happens after targetMember has checked the local mirror, leaving
    // a proved target snapshot that must be invalidated before the mutation.
    state.afterTargetRead = async () => { state.beforeRead = async () => { state.beforeRead = gate.hook; }; };
    const pending = call(families[8], await cookie()).then(r => r);
    await gate.arrived;
    await member(target, role);
    gate.release();
    const response = await pending;
    expect(response.status).toBeGreaterThanOrEqual(400);
    await noEffects();
    expect(state.members.get(`om_${target}`).role.slug).toBe(role);
    expect((await localTarget()).role).toBe(role);
  });

  for (const familyIndex of [7, 10]) it(`${families[familyIndex].name}: target inactivity during provider read blocks seat grant`, async () => {
    const gate = barrier();
    // The first subsequent authority read finishes readProvider(target). The
    // second happens after targetMember has checked the local mirror, leaving
    // a proved target snapshot that must be invalidated before the mutation.
    state.afterTargetRead = async () => { state.beforeRead = async () => { state.beforeRead = gate.hook; }; };
    const auth = await cookie();
    const pending = (familyIndex === 7
      ? request(app).patch(`/api/organizations/${org}/members/om_${target}`).set('Cookie', auth).set('X-CSRF-Token', CSRF_TOKEN).send({ seat_type: 'contributor' })
      : call(families[familyIndex], auth)).then(r => r);
    await gate.arrived;
    state.members.get(`om_${target}`).status = 'inactive';
    gate.release();
    const response = await pending;
    expect(response.status).toBeGreaterThanOrEqual(400);
    await noEffects();
    expect((await localTarget()).seat_type).toBe('community_only');
    expect((await pool.query('SELECT status FROM seat_upgrade_requests WHERE id=$1', [seatId])).rows[0].status).toBe('pending');
  });

  for (const familyIndex of [7, 8, 10]) it(`${families[familyIndex].name}: provider-only actor revoke during target revalidation is terminal`, async () => {
    const gate = barrier();
    // The first target read establishes its binding. The second is the
    // mutation fence's awaited target revalidation, after its actor preflight.
    state.afterTargetRead = async () => { state.afterTargetRead = gate.hook; };
    const auth = await cookie();
    const pending = (familyIndex === 7
      ? request(app).patch(`/api/organizations/${org}/members/om_${target}`).set('Cookie', auth).set('X-CSRF-Token', CSRF_TOKEN).send({ seat_type: 'contributor' })
      : call(families[familyIndex], auth)).then(r => r);
    await gate.arrived;
    state.members.delete(`om_${A}`);
    // Model a delayed webhook: provider authority is gone, but every local
    // membership/epoch/identity value remains identical to the initial stamp.
    expect((await pool.query('SELECT role FROM organization_memberships WHERE workos_user_id=$1 AND workos_organization_id=$2', [A, org])).rows[0].role).toBe('owner');
    gate.release();
    expect((await pending).status).toBe(403);
    await noEffects();
    expect(state.members.has(`om_${target}`)).toBe(true);
    expect(await localTarget()).toMatchObject({ role: 'member', seat_type: 'community_only' });
    expect((await pool.query('SELECT status FROM seat_upgrade_requests WHERE id=$1', [seatId])).rows[0].status).toBe('pending');
  });

  it('provider-only actor revoke during the required seat audit fence rolls back the preceding local UPDATE', async () => {
    const gate = barrier();
    let targetReads = 0;
    const duringTargetRead = async () => {
      targetReads++;
      // Initial binding, local-phase fence, membership UPDATE fence, then
      // required audit fence. The fourth read follows the local seat UPDATE.
      if (targetReads === 4) await gate.hook();
      else state.afterTargetRead = duringTargetRead;
    };
    state.afterTargetRead = duringTargetRead;
    const pending = request(app).patch(`/api/organizations/${org}/members/om_${target}`)
      .set('Cookie', await cookie()).set('X-CSRF-Token', CSRF_TOKEN).send({ seat_type: 'contributor' }).then(r => r);
    await gate.arrived;
    state.members.delete(`om_${A}`);
    gate.release();
    expect((await pending).status).toBe(403);
    expect(targetReads).toBe(4);
    await noEffects();
    expect(await localTarget()).toMatchObject({ role: 'member', seat_type: 'community_only' });
  });

  it('last owner cannot be demoted by the static management adapter', async () => {
    const response = await staticRole(A, 'member');
    expect(response.status).toBe(409);
    await noEffects();
    expect(state.members.get(`om_${A}`).role.slug).toBe('owner');
  });

  it('an owner absent from the exact local mirror cannot justify demoting the last usable owner', async () => {
    state.members.set(`om_${B}`, { id: `om_${B}`, userId: B, organizationId: org, status: 'active', role: { slug: 'owner' } });
    const response = await staticRole(A, 'member');
    expect(response.status).toBeGreaterThanOrEqual(400);
    await noEffects();
    expect(state.members.get(`om_${A}`).role.slug).toBe('owner');
    expect((await pool.query("SELECT workos_user_id FROM organization_memberships WHERE workos_organization_id=$1 AND role='owner'", [org])).rowCount).toBe(1);
  });

  for (const source of ['provider', 'local']) it(`remaining owner ${source} revoke during demotion preflight prevents every write`, async () => {
    await member(target, 'owner');
    const gate = barrier();
    // Bind the demotion target first. Pause its next read inside the write
    // preflight, before the separately bound surviving owner is revalidated.
    state.afterTargetRead = async () => { state.afterTargetRead = gate.hook; };
    const pending = staticRole(target, 'member').then(r => r);
    await gate.arrived;
    if (source === 'provider') state.members.delete(`om_${A}`);
    else await pool.query('DELETE FROM organization_memberships WHERE workos_user_id=$1 AND workos_organization_id=$2', [A, org]);
    gate.release();
    const response = await pending;
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.body.reconciliation_required).toBeUndefined();
    await noEffects();
    expect(state.members.get(`om_${target}`).role.slug).toBe('owner');
    expect((await localTarget()).role).toBe('owner');
  });

  async function otherOrgContributor(userId: string) {
    const id = `om_other_${userId}`;
    state.members.set(id, { id, userId, organizationId: otherOrg, status: 'active', role: { slug: 'owner' } });
    await pool.query("INSERT INTO organization_memberships (workos_user_id,workos_organization_id,workos_membership_id,email,role,seat_type) VALUES ($1,$2,$3,$4,'owner','contributor')", [userId, otherOrg, id, `${userId}@membership-race.example.test`]);
  }

  it('same exact credential contributor entitlement in another org prevents a redundant seat request', async () => {
    await member(A, 'member');
    await otherOrgContributor(A);
    const response = await call(families[9], await cookie());
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('invalid_request');
    await noEffects();
    expect((await pool.query('SELECT id FROM seat_upgrade_requests WHERE workos_user_id=$1 AND workos_organization_id=$2', [A, org])).rowCount).toBe(0);
  });

  it('canonical sibling contributor entitlement does not suppress an exact actor seat request', async () => {
    await member(A, 'member');
    await otherOrgContributor(B);
    const response = await call(families[9], await cookie());
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect((await pool.query('SELECT workos_user_id FROM seat_upgrade_requests WHERE id=$1', [response.body.id])).rows[0].workos_user_id).toBe(A);
    expect(state.writes).toEqual([]);
  });

  it('other-org owner and contributor entitlement never supplies selected-org management authority', async () => {
    await removeActor();
    await otherOrgContributor(A);
    expect((await call(families[3], await cookie())).status).toBe(403);
    expect(state.reads).toEqual([]);
    await noEffects();
  });

  it('concurrent static owner demotions preserve one owner and honest audit', async () => {
    await member(target, 'owner');
    const gate = barrier(); state.afterWrite = gate.hook;
    const first = staticRole(A, 'member').then(r => r);
    await gate.arrived;
    const second = staticRole(target, 'member').then(r => r);
    gate.release();
    const responses = await Promise.all([first, second]);
    expect(responses.map(r => r.status).sort()).toEqual([200, 409]);
    expect([...state.members.values()].filter(m => m.role.slug === 'owner')).toHaveLength(1);
    expect((await pool.query("SELECT workos_user_id FROM organization_memberships WHERE workos_organization_id=$1 AND role='owner'", [org])).rowCount).toBe(1);
    expect((await pool.query('SELECT id FROM registry_audit_log WHERE workos_organization_id=$1', [org])).rowCount).toBe(1);
  });

  it('conflicting role writes serialize and audit the actual preceding role', async () => {
    const gate = barrier(); state.afterWrite = gate.hook;
    const auth = await cookie();
    const first = request(app).patch(`/api/organizations/${org}/members/om_${target}`).set('Cookie', auth).set('X-CSRF-Token', CSRF_TOKEN).send({ role: 'admin' }).then(r => r);
    await gate.arrived;
    const second = request(app).patch(`/api/organizations/${org}/members/om_${target}`).set('Cookie', auth).set('X-CSRF-Token', CSRF_TOKEN).send({ role: 'owner' }).then(r => r);
    gate.release();
    const responses = await Promise.all([first, second]);
    expect(responses.map(r => r.status)).toEqual([200, 200]);
    expect((await localTarget()).role).toBe('owner');
    expect(state.members.get(`om_${target}`).role.slug).toBe('owner');
    const audit = await pool.query('SELECT details FROM registry_audit_log WHERE workos_organization_id=$1 ORDER BY created_at,id', [org]);
    expect(audit.rows.map(row => [row.details.old_role, row.details.new_role])).toEqual([['member', 'admin'], ['admin', 'owner']]);
  });

  it('conflicting seat request decisions cannot overwrite the winner', async () => {
    const gate = barrier();
    // The first subsequent authority read finishes readProvider(target). The
    // second happens after targetMember has checked the local mirror, leaving
    // a proved target snapshot that must be invalidated before the mutation.
    state.afterTargetRead = async () => { state.beforeRead = async () => { state.beforeRead = gate.hook; }; };
    const auth = await cookie();
    const approve = call(families[10], auth).then(r => r);
    await gate.arrived;
    const deny = call(families[11], auth).then(r => r);
    gate.release();
    const responses = await Promise.all([approve, deny]);
    expect(responses.map(r => r.status)).toEqual([200, 409]);
    expect((await pool.query('SELECT status FROM seat_upgrade_requests WHERE id=$1', [seatId])).rows[0].status).toBe('approved');
    expect((await localTarget()).seat_type).toBe('contributor');
    expect((await pool.query('SELECT id FROM registry_audit_log WHERE workos_organization_id=$1', [org])).rowCount).toBe(1);
  });

  it('status input is rejected without role or provider side effects', async () => {
    const response = await request(app).patch(`/api/organizations/${org}/members/om_${target}`)
      .set('Cookie', await cookie()).set('X-CSRF-Token', CSRF_TOKEN).send({ role: 'admin', status: 'inactive' });
    expect(response.status).toBe(400);
    await noEffects();
    expect((await localTarget()).role).toBe('member');
  });

  for (const familyIndex of [0, 2, 3, 4, 5, 6, 7, 8]) {
    const family = families[familyIndex];
    it(`${family.name}: suppressed required audit aborts every local row and reports provider residual`, async () => {
      await suppressAudit();
      const response = await call(family, await cookie());
      expect(response.status, JSON.stringify(response.body)).toBe(503);
      expect(response.body.reconciliation_required).toBe(true);
      expect(state.notifications).toEqual([]);
      expect(response.body.operation_id).toEqual(expect.any(String));
      expect((await pool.query('SELECT id FROM registry_audit_log WHERE workos_organization_id=$1', [org])).rowCount).toBe(0);
      expect((await pool.query('SELECT status FROM organization_join_requests WHERE id=$1', [joinId])).rows[0].status).toBe('pending');
      expect((await localTarget())).toMatchObject({ role: 'member', seat_type: 'community_only' });
      expect((await pool.query('SELECT id FROM organization_memberships WHERE workos_organization_id=$1 AND workos_user_id=$2', [org, newcomer])).rowCount).toBe(0);
      expect((await pool.query('SELECT * FROM invitation_seat_types WHERE workos_organization_id=$1', [org])).rowCount).toBe(0);
      if ([0, 2, 6].includes(familyIndex)) expect(state.members.has(`om_${newcomer}`)).toBe(false);
      if (familyIndex === 7) expect(state.members.get(`om_${target}`).role.slug).toBe('admin');
      if (familyIndex === 8) expect(state.members.has(`om_${target}`)).toBe(false);
      if ([4, 5].includes(familyIndex)) expect(state.invitations.get('inv_existing').state).toBe('revoked');
    });
  }

  for (const familyIndex of [0, 2, 3, 6]) it(`${families[familyIndex].name}: failed compensation keeps explicit reconciliation and real residual`, async () => {
    await suppressAudit();
    const invitation = familyIndex === 3;
    state.rejectActions.set(invitation ? 'revoke_invitation' : 'delete_membership', Object.assign(new Error('compensation unavailable'), { code: 'ETIMEDOUT' }));
    const response = await call(families[familyIndex], await cookie());
    expect(response.status).toBe(503);
    expect(response.body.reconciliation_required).toBe(true);
      expect(state.notifications).toEqual([]);
    expect((await pool.query('SELECT id FROM registry_audit_log WHERE workos_organization_id=$1', [org])).rowCount).toBe(0);
    if (invitation) expect([...state.invitations.values()].some(inv => inv.email === 'invitee@membership-race.example.test' && inv.state === 'pending')).toBe(true);
    else expect(state.members.get(`om_${newcomer}`).status).toBe('active');
    expect((await pool.query('SELECT id FROM organization_memberships WHERE workos_organization_id=$1 AND workos_user_id=$2', [org, newcomer])).rowCount).toBe(0);
  });

  for (const familyIndex of [0, 3, 8]) it(`${families[familyIndex].name}: applied write with lost acknowledgement preserves actual unknown residual`, async () => {
    state.afterWrite = async () => { throw Object.assign(new Error('acknowledgement lost after write'), { code: 'ECONNRESET' }); };
    const response = await call(families[familyIndex], await cookie());
    expect(response.status).toBe(503);
    expect(response.body.reconciliation_required).toBe(true);
      expect(state.notifications).toEqual([]);
    expect(state.writes).toHaveLength(1);
    expect((await pool.query('SELECT id FROM registry_audit_log WHERE workos_organization_id=$1', [org])).rowCount).toBe(0);
    expect((await localTarget()).role).toBe('member');
    if (familyIndex === 0) expect(state.members.has(`om_${newcomer}`)).toBe(true);
    if (familyIndex === 3) expect([...state.invitations.values()].some(inv => inv.email === 'invitee@membership-race.example.test' && inv.state === 'pending')).toBe(true);
    if (familyIndex === 8) expect(state.members.has(`om_${target}`)).toBe(false);
  });

  it('epoch bump during target revalidation blocks the already prepared provider deletion', async () => {
    const gate = barrier();
    state.afterTargetRead = async () => { state.afterTargetRead = gate.hook; };
    const pending = call(families[8], await cookie()).then(r => r);
    await gate.arrived;
    await pool.query('INSERT INTO authorization_epochs (workos_user_id,epoch) VALUES ($1,1) ON CONFLICT (workos_user_id) DO UPDATE SET epoch=authorization_epochs.epoch+1', [A]);
    gate.release();
    expect((await pending).status).toBe(403);
    await noEffects();
    expect(state.members.has(`om_${target}`)).toBe(true);
  });

  for (const familyIndex of [0, 3, 4, 7, 8]) it(`${families[familyIndex].name}: unknown upstream write outcome never reports rollback or success`, async () => {
    state.rejectWrite = Object.assign(new Error('network acknowledgement lost'), { code: 'ETIMEDOUT' });
    const response = await call(families[familyIndex], await cookie());
    expect(response.status).toBe(503);
    expect(response.body.reconciliation_required).toBe(true);
      expect(state.notifications).toEqual([]);
    expect(state.writes).toHaveLength(1);
    expect((await pool.query('SELECT id FROM registry_audit_log WHERE workos_organization_id=$1', [org])).rowCount).toBe(0);
  });

  for (const familyIndex of [0, 3, 4, 7, 8]) it(`${families[familyIndex].name}: definitive provider rejection reports no local success`, async () => {
    const providerSecret = 'provider bearer sk_live_never_serialize';
    state.rejectWrite = Object.assign(new Error(providerSecret), { status: 422 });
    const response = await call(families[familyIndex], await cookie());
    expect(response.status).toBe(409);
    expect(response.body).toEqual({ error: 'membership_state_conflict' });
    expect(JSON.stringify(response.body)).not.toContain(providerSecret);
    expect(response.body.reconciliation_required).toBeUndefined();
    expect(state.writes).toHaveLength(1);
    expect((await pool.query('SELECT id FROM registry_audit_log WHERE workos_organization_id=$1', [org])).rowCount).toBe(0);
  });

  for (const source of ['bans', 'authorization_epochs', 'identity_workos_users', 'organization_memberships']) it(`${source}: required SQL source outage is terminal 503 before every provider call`, async () => {
    const auth = await cookie();
    await pool.query(`ALTER TABLE ${source} RENAME TO membership_race_unavailable`);
    try {
      const response = await call(families[3], auth);
      expect(response.status, JSON.stringify(response.body)).toBe(503);
      expect(response.body).toEqual({ error: 'authorization_unavailable' });
      expect(state.reads).toEqual([]);
      await noEffects();
    } finally {
      await pool.query(`ALTER TABLE membership_race_unavailable RENAME TO ${source}`);
    }
  });

  it('replaying approved join request never repeats provider mutation', async () => {
    const auth = await cookie();
    expect((await call(families[0], auth)).status).toBe(200);
    const before = [...state.writes];
    expect((await call(families[0], auth)).status).toBe(409);
    expect(state.writes).toEqual(before);
    expect((await pool.query('SELECT id FROM registry_audit_log WHERE workos_organization_id=$1', [org])).rowCount).toBe(1);
  });
});
