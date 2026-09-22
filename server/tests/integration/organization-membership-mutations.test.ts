import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express, { type Request, type Response } from 'express';
import request from 'supertest';
import { generateKeyPair, SignJWT } from 'jose';
import type { Pool } from 'pg';

const state = vi.hoisted(() => {
  process.env.ADMIN_API_KEY = 'membership-test-static-key';
  return {
    members: new Map<string, any>(), invitations: new Map<string, any>(), users: new Map<string, any>(), sessions: new Map<string, any>(),
    reads: [] as string[], writes: [] as string[], apiKeyValidations: 0,
    beforeRead: undefined as undefined | (() => Promise<void>),
    afterWrite: undefined as undefined | (() => Promise<void>),
    rejectWrite: undefined as unknown,
    outage: false, malformedAuthority: false, malformedTarget: false, malformedInventory: false, logs: [] as Array<Record<string, unknown>>, authorityRequests: [] as unknown[],
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
    const value = action();
    if (state.afterWrite) { const hook = state.afterWrite; state.afterWrite = undefined; await hook(); }
    return structuredClone(value);
  }
  return { WorkOS: class {
    apiKeys = { createValidation: async () => { state.apiKeyValidations++; return { apiKey: { id: 'key_test', name: 'test', owner: { type: 'organization', id: 'org_mutation_test' }, permissions: ['admin'] } }; } };
    userManagement = {
      loadSealedSession: ({ sessionData }: any) => ({ authenticate: async () => state.sessions.get(sessionData) ?? { authenticated: false }, refresh: async () => ({ authenticated: false }) }),
      listOrganizationMemberships: async ({ userId, organizationId, statuses }: any) => {
        state.authorityRequests.push({ userId, organizationId, statuses });
        await read('list_memberships');
        if (state.malformedAuthority || (state.malformedInventory && !userId)) return undefined;
        return { data: structuredClone([...state.members.values()].filter(m => (!userId || m.userId === userId) && (!organizationId || m.organizationId === organizationId) && (!statuses || statuses.includes(m.status)))) };
      },
      getOrganizationMembership: async (id: string) => { await read('get_membership'); if (state.malformedTarget) return undefined; if (!state.members.has(id)) throw Object.assign(new Error('not found'), { status: 404 }); return structuredClone(state.members.get(id)); },
      createOrganizationMembership: async ({ userId, organizationId, roleSlug }: any) => write('create_membership', () => {
        if ([...state.members.values()].some(m => m.userId === userId && m.organizationId === organizationId)) throw Object.assign(new Error('exists'), { code: 'organization_membership_already_exists' });
        const m = { id: `om_${userId}`, userId, organizationId, status: 'active', role: { slug: roleSlug } }; state.members.set(m.id, m); return m;
      }),
      updateOrganizationMembership: async (id: string, { roleSlug }: any) => write('update_membership', () => { const m = state.members.get(id); m.role.slug = roleSlug; return m; }),
      deleteOrganizationMembership: async (id: string) => write('delete_membership', () => { state.members.delete(id); }),
      listUsers: async ({ email }: any) => { await read('list_users'); return { data: structuredClone([...state.users.values()].filter(u => u.email === email)) }; },
      getUser: async (id: string) => { await read('get_user'); return structuredClone(state.users.get(id)); },
      sendInvitation: async ({ email, organizationId, inviterUserId, roleSlug }: any) => write('send_invitation', () => {
        const invitation = { id: `inv_${state.invitations.size + 1}`, email, organizationId, inviterUserId, roleSlug, state: 'pending', expiresAt: new Date(Date.now() + 86400000).toISOString(), acceptInvitationUrl: 'https://membership-mutation.example.test/accept' };
        state.invitations.set(invitation.id, invitation); return invitation;
      }),
      getInvitation: async (id: string) => { await read('get_invitation'); return structuredClone(state.invitations.get(id)); },
      revokeInvitation: async (id: string) => write('revoke_invitation', () => { state.invitations.get(id).state = 'revoked'; }),
    };
  } };
});
vi.mock('../../src/logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/logger.js')>();
  return { ...actual, createLogger: (context: string | Record<string, unknown>) => {
    const logger = actual.createLogger(context);
    if (context === 'organization-membership-mutation' || context === 'organization-membership-routes') {
      const error = logger.error.bind(logger);
      logger.error = ((fields: Record<string, unknown>, message: string) => {
        state.logs.push({ ...fields, message }); error(fields, message);
      }) as typeof logger.error;
    }
    return logger;
  } };
});
vi.mock('../../src/addie/mcp/admin-tools.js', () => ({ isWebUserAAOAdmin: vi.fn().mockResolvedValue(false) }));
vi.mock('../../src/middleware/rate-limit.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/middleware/rate-limit.js')>()),
  invitationRateLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  orgCreationRateLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
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
vi.mock('../../src/services/organization-membership-notifications.js', () => ({ notifyMembershipSeats: vi.fn(), notifyMembershipSeatRequest: vi.fn() }));
vi.mock('../../src/slack/org-group-dm.js', () => ({ notifyMemberSeatChanged: vi.fn() }));

import { initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { __setJWKSForTesting } from '../../src/auth/workos-jwt.js';
import { stopAuthTimers, invalidateBanCache, optionalAuth, requireAuth } from '../../src/middleware/auth.js';
import { MembershipMutationError, toPublicMembershipMutationError } from '../../src/services/organization-membership-mutation.js';
import { getOrganizationAuthorizationUserId } from '../../src/auth/organization-principal.js';

const org = 'org_mutation_test';
const otherOrg = 'org_mutation_other';
const A = 'user_mutation_a';
const B = 'user_mutation_b';
const target = 'user_mutation_target';
const newcomer = 'user_mutation_new';
let pool: Pool;
let signingKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
let verificationKey: Awaited<ReturnType<typeof generateKeyPair>>['publicKey'];
let sequence = 0;
let joinId: string;
let seatId: string;
let identityId: string;
let app: Parameters<typeof request>[0];
const authProbe = (req: Request, res: Response) => res.json({
  canonical_user_id: req.user?.id,
  credential_user_id: req.user ? getOrganizationAuthorizationUserId(req.user) : null,
});
const authProbeApp = express();
authProbeApp.get('/auth/optional-probe', optionalAuth, authProbe);
authProbeApp.get('/auth/required-probe', requireAuth, authProbe);
const CSRF_TOKEN = 'a'.repeat(64);

describe('membership mutation public error projection', () => {
  const cases = [
    [400, 'invalid_request'],
    [401, 'invalid_credential'],
    [403, 'access_denied'],
    [404, 'not_found'],
    [409, 'membership_state_conflict'],
    [503, 'authorization_unavailable'],
  ] as const;

  for (const [status, code] of cases) {
    it(`maps internal status ${status} to finite public code ${code} without detail`, () => {
      const secret = `provider-secret-${status}`;
      const projected = toPublicMembershipMutationError(new MembershipMutationError(status, secret));
      expect(projected).toEqual({ status, body: { error: code } });
      expect(JSON.stringify(projected)).not.toContain(secret);
    });
  }

  for (const [code, status, error] of [
    ['55P03', 409, 'membership_state_conflict'],
    ['40P01', 409, 'membership_state_conflict'],
    ['40001', 409, 'membership_state_conflict'],
    ['57014', 503, 'authorization_unavailable'],
  ] as const) it(`projects PostgreSQL ${code} as recoverable ${status}`, () => {
    expect(toPublicMembershipMutationError(Object.assign(new Error('private SQL detail'), { code })))
      .toEqual({ status, body: { error } });
  });
  it('maps unknown typed and untyped failures to internal_error without arbitrary detail', () => {
    for (const error of [new MembershipMutationError(418, 'database-secret'), new Error('provider-secret')]) {
      const projected = toPublicMembershipMutationError(error);
      expect(projected).toEqual({ status: 500, body: { error: 'internal_error' } });
      expect(JSON.stringify(projected)).not.toMatch(/database-secret|provider-secret/);
    }
  });
});

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
    VALUES ($1,$2,$3,$4,$5,'community_only') ON CONFLICT (workos_user_id,workos_organization_id) DO UPDATE SET role=$5, workos_membership_id=$3`, [userId, organizationId, id, `${userId}@membership-mutation.example.test`, role]);
}
async function platformAdmin(userId: string) {
  await pool.query(`INSERT INTO working_group_memberships (working_group_id,workos_user_id,status)
    SELECT id,$1,'active' FROM working_groups WHERE slug='aao-admin'
    ON CONFLICT (working_group_id,workos_user_id) DO UPDATE SET status='active'`, [userId]);
}
async function removeActor(userId = A) {
  state.members.delete(`om_${userId}`);
  await pool.query('DELETE FROM organization_memberships WHERE workos_user_id=$1 AND workos_organization_id=$2', [userId, org]);
}
async function noEffects() {
  expect(state.writes).toEqual([]);
  expect((await pool.query('SELECT id FROM registry_audit_log WHERE workos_organization_id=$1', [org])).rowCount).toBe(0);
}
async function managementState() {
  const tables = ['organization_memberships', 'organization_join_requests', 'invitation_seat_types', 'seat_upgrade_requests', 'registry_audit_log'];
  const result: Record<string, unknown> = {};
  for (const table of tables) result[table] = (await pool.query(
    `SELECT to_jsonb(t) AS row FROM ${table} t WHERE workos_organization_id=$1 ORDER BY to_jsonb(t)::text`, [org],
  )).rows;
  return result;
}
function barrier() {
  let reached!: () => void;
  let release!: () => void;
  const arrived = new Promise<void>(resolve => { reached = resolve; });
  const resumed = new Promise<void>(resolve => { release = resolve; });
  return { arrived, release, hook: async () => { reached(); await resumed; } };
}
async function waitForDatabaseLock(queryFragment: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = await pool.query(
      `SELECT 1 FROM pg_stat_activity
       WHERE datname = current_database() AND pid <> pg_backend_pid()
         AND wait_event_type = 'Lock' AND query ILIKE '%' || $1 || '%'`,
      [queryFragment],
    );
    if (result.rowCount) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for blocked database query containing ${queryFragment}`);
}
type Family = { name: string; method: 'post' | 'patch' | 'delete'; path: () => string; body?: () => object };
const families: Family[] = [
  { name: 'join approve', method: 'post', path: () => `/join-requests/${joinId}/approve` },
  { name: 'join reject', method: 'post', path: () => `/join-requests/${joinId}/reject` },
  { name: 'domain add', method: 'post', path: () => '/domain-users/add', body: () => ({ email: `${newcomer}@membership-mutation.example.test` }) },
  { name: 'invite', method: 'post', path: () => '/invitations', body: () => ({ email: 'invitee@membership-mutation.example.test' }) },
  { name: 'revoke invite', method: 'delete', path: () => '/invitations/inv_existing' },
  { name: 'resend invite', method: 'post', path: () => '/invitations/inv_existing/resend' },
  { name: 'by email create', method: 'post', path: () => '/members/by-email', body: () => ({ email: `${newcomer}@membership-mutation.example.test` }) },
  { name: 'role and seat', method: 'patch', path: () => `/members/om_${target}`, body: () => ({ role: 'admin', seat_type: 'contributor' }) },
  { name: 'remove member', method: 'delete', path: () => `/members/om_${target}` },
  { name: 'request seat', method: 'post', path: () => '/seat-requests', body: () => ({ resource_type: 'working_group', resource_id: 'new_request' }) },
  { name: 'approve seat', method: 'post', path: () => `/seat-requests/${seatId}/approve` },
  { name: 'deny seat', method: 'post', path: () => `/seat-requests/${seatId}/deny` },
];
function call(family: Family, authCookie: string) {
  return request(app)[family.method](`/api/organizations/${org}${family.path()}`)
    .set('X-Organization-Id', org).set('Cookie', authCookie).set('X-CSRF-Token', CSRF_TOKEN).send(family.body?.() ?? {});
}

beforeAll(async () => {
  pool = initializeDatabase({ connectionString: process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:55432/adcp_test', maxPoolSize: 12 });
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
  for (const id of [A, B, target, newcomer]) invalidateBanCache('user', id);
  invalidateBanCache('apikey', 'key_test');
  state.members.clear(); state.invitations.clear(); state.users.clear(); state.sessions.clear(); state.reads = []; state.writes = []; state.apiKeyValidations = 0;
  state.beforeRead = undefined; state.afterWrite = undefined; state.rejectWrite = undefined; state.outage = false; state.malformedAuthority = false; state.malformedTarget = false; state.malformedInventory = false; state.logs = []; state.authorityRequests = [];
  await pool.query('DROP TRIGGER IF EXISTS membership_test_audit ON registry_audit_log');
  await pool.query('DROP TRIGGER IF EXISTS membership_test_update ON organization_memberships');
  await pool.query('DELETE FROM working_group_memberships WHERE workos_user_id = ANY($1)', [[A, B, target, newcomer]]);
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
    const user = { id, email: `${id}@membership-mutation.example.test`, firstName: 'Sam', lastName: 'Adeyemi', emailVerified: true, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() };
    state.users.set(id, user);
    await pool.query('INSERT INTO users (workos_user_id,email,first_name,primary_organization_id) VALUES ($1,$2,$3,$4)', [id,user.email,'Sam',org]);
  }
  identityId = (await pool.query('SELECT identity_id FROM identity_workos_users WHERE workos_user_id=$1', [B])).rows[0].identity_id;
  await pool.query('UPDATE identity_workos_users SET identity_id=$1, is_primary=false WHERE workos_user_id=$2', [identityId,A]);
  await member(A); await member(target,'member');
  joinId = (await pool.query('INSERT INTO organization_join_requests (workos_user_id,user_email,workos_organization_id) VALUES ($1,$2,$3) RETURNING id', [newcomer,`${newcomer}@membership-mutation.example.test`,org])).rows[0].id;
  seatId = (await pool.query("INSERT INTO seat_upgrade_requests (workos_organization_id,workos_user_id,resource_type,resource_id) VALUES ($1,$2,'working_group','existing') RETURNING id", [org,target])).rows[0].id;
  await pool.query("INSERT INTO organization_domains (workos_organization_id,domain,verified) VALUES ($1,'membership-mutation.example.test',true) ON CONFLICT DO NOTHING", [org]);
  await pool.query("INSERT INTO slack_user_mappings (slack_user_id,slack_email,workos_user_id) VALUES ('U_MEMBERSHIP_TEST',$1,$2) ON CONFLICT (slack_user_id) DO UPDATE SET slack_email=$1,workos_user_id=$2", [`${newcomer}@membership-mutation.example.test`,newcomer]);
  state.invitations.set('inv_existing', { id:'inv_existing',organizationId:org,email:'existing@membership-mutation.example.test',state:'pending',expiresAt:new Date(Date.now()+86400000).toISOString() });
});

describe('mounted real cookie/JWT organization membership mutation fence', () => {
  it('rejects a cookie mutation without the matching production CSRF header before auth or side effects', async () => {
    const response = await request(app).post(`/api/organizations/${org}/invitations`)
      .set('Cookie', await cookie()).send({ email: 'invitee@membership-mutation.example.test' });
    expect(response.status).toBe(403);
    expect(response.body.error).toBe('CSRF validation failed');
    expect(state.reads).toEqual([]);
    await noEffects();
  });

  it('accepts the matching production CSRF cookie and header before the mutation fence', async () => {
    const response = await call(families[3], await cookie());
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(state.writes).toContain('send_invitation');
  });

  for (const family of families) {
    it(`${family.name}: exact nonprimary owner succeeds with credential and person audit`, async () => {
      const response = await call(family, await cookie());
      expect(response.status, JSON.stringify(response.body)).toBeLessThan(300);
      const audit = await pool.query('SELECT workos_user_id,details FROM registry_audit_log WHERE workos_organization_id=$1', [org]);
      expect(audit.rowCount).toBeGreaterThan(0);
      for (const row of audit.rows) {
        expect(row.workos_user_id).toBe(A);
        expect(row.details).toMatchObject({ authenticated_workos_user_id:A,canonical_workos_user_id:B,identity_id:identityId,authority:'exact_membership' });
      }
    });
    for (const direction of ['nonprimary', 'primary']) {
      it(`${family.name}: ${direction} credential cannot borrow sibling owner`, async () => {
        await removeActor();
        const actor = direction === 'nonprimary' ? A : B;
        await member(direction === 'nonprimary' ? B : A);
        const response = await call(family, await cookie(actor));
        expect(response.status).toBe(403);
        expect(state.reads).toEqual([]);
        await noEffects();
      });
    }
    it(`${family.name}: pre-provider epoch bump aborts with no effects`, async () => {
      const gate = barrier(); state.beforeRead = gate.hook;
      const pending = call(family, await cookie()).then(r => r);
      await gate.arrived;
      await pool.query('INSERT INTO authorization_epochs (workos_user_id,epoch) VALUES ($1,1) ON CONFLICT (workos_user_id) DO UPDATE SET epoch=authorization_epochs.epoch+1',[A]);
      gate.release();
      expect((await pending).status).toBe(403);
      await noEffects();
    });
  }

  for (const role of ['owner','admin','member']) {
    it(`direct ${role} action policy`, async () => {
      await member(A,role);
      const response = await call(families[3],await cookie());
      expect(response.status).toBe(role === 'member' ? 403 : 200);
    });
  }
  for (const kind of ['active','revoked','expired','future','sibling']) {
    it(`denies ${kind} grant-only authority`, async () => {
      await removeActor();
      await pool.query(`INSERT INTO organization_credential_grants (workos_organization_id,workos_user_id,role,granted_by_workos_user_id,effective_from,effective_until,revoked_at,revoked_by_workos_user_id)
        VALUES ($1,$2,'owner',$3,$4,$5,$6,$7)`,[org,kind==='sibling'?B:A,B,kind==='future'?new Date(Date.now()+60000):new Date(Date.now()-120000),kind==='expired'?new Date(Date.now()-60000):null,kind==='revoked'?new Date():null,kind==='revoked'?B:null]);
      for (const family of [families[3], families[6]]) expect((await call(family,await cookie())).status).toBe(403); await noEffects(); expect(state.reads).toEqual([]);
    });
  }
  it('grant owner does not elevate a direct member', async () => {
    await member(A,'member');
    await pool.query("INSERT INTO organization_credential_grants (workos_organization_id,workos_user_id,role,granted_by_workos_user_id) VALUES ($1,$2,'owner',$3)",[org,A,B]);
    expect((await call(families[3],await cookie())).status).toBe(403); await noEffects();
  });
  for (const status of ['pending','inactive']) it(`denies provider ${status} actor`,async()=>{
    state.members.get(`om_${A}`).status=status;
    expect((await call(families[3],await cookie())).status).toBe(403); await noEffects();
  });
  it('OAuth JWT exact subject and selected organization succeed',async()=>{
    const response=await request(app).post(`/api/organizations/${org}/invitations`).set('Authorization',`Bearer ${await token()}`).send({email:'invitee@membership-mutation.example.test'});
    expect(response.status,JSON.stringify(response.body)).toBe(200);
  });
  it('warm OAuth cache cannot replace the authenticated credential with the canonical sibling', async () => {
    const bearer = await token();
    for (const email of ['first@membership-mutation.example.test', 'second@membership-mutation.example.test']) {
      const response = await request(app).post(`/api/organizations/${org}/invitations`).set('Authorization', `Bearer ${bearer}`).send({ email });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
    }
    expect([...state.invitations.values()].filter(inv => inv.inviterUserId === A)).toHaveLength(2);
  });
  for (const [credential, direction] of [[A, 'nonprimary-to-primary'], [B, 'primary-to-self']] as const) {
    for (const order of [['optional', 'required'], ['required', 'optional']] as const) {
      it(`${direction} bearer cache remains exact across ${order.join(' to ')} auth`, async () => {
        const bearer = await token(credential);
        for (const kind of order) {
          const response = await request(authProbeApp).get(`/auth/${kind}-probe`).set('Authorization', `Bearer ${bearer}`);
          expect(response.status, JSON.stringify(response.body)).toBe(200);
          expect(response.body).toEqual({ canonical_user_id: B, credential_user_id: credential });
        }
        if (credential === A) {
          const mutation = await request(app).post(`/api/organizations/${org}/invitations`)
            .set('Authorization', `Bearer ${bearer}`).send({ email: `${order[0]}@membership-mutation.example.test` });
          expect(mutation.status, JSON.stringify(mutation.body)).toBe(200);
          expect([...state.invitations.values()].at(-1)?.inviterUserId).toBe(A);
        }
      });
    }
  }
  it('optional bearer cache preserves exact credential ban enforcement', async () => {
    const bearer = await token(A);
    expect((await request(authProbeApp).get('/auth/optional-probe').set('Authorization', `Bearer ${bearer}`)).status).toBe(200);
    await pool.query("INSERT INTO bans (ban_type,entity_id,scope,banned_by_user_id,reason) VALUES ('user',$1,'platform',$2,'test')", [A, B]);
    invalidateBanCache('user', A);
    const response = await request(authProbeApp).get('/auth/required-probe').set('Authorization', `Bearer ${bearer}`);
    expect(response.status).toBe(403);
    expect(response.body.error).toBe('Account suspended');
  });
  it('epoch change refreshes authorization without discarding cached provider verification', async () => {
    const bearer = await token(A);
    expect((await request(authProbeApp).get('/auth/optional-probe').set('Authorization', `Bearer ${bearer}`)).status).toBe(200);
    await pool.query('INSERT INTO authorization_epochs (workos_user_id,epoch) VALUES ($1,1) ON CONFLICT (workos_user_id) DO UPDATE SET epoch=authorization_epochs.epoch+1', [A]);
    __setJWKSForTesting(async () => { throw Object.assign(new Error('JWKS unavailable'), { code: 'ECONNRESET' }); });
    try {
      const response = await request(authProbeApp).get('/auth/required-probe')
        .set('Accept', 'application/json').set('Authorization', `Bearer ${bearer}`);
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ canonical_user_id: B, credential_user_id: A });
    } finally {
      __setJWKSForTesting(async () => verificationKey);
    }
  });
  for (const change of ['epoch', 'binding-round-trip']) it(`${change} between authentication snapshot and route capture fails closed`, async () => {
    const originalConnect = pool.connect.bind(pool);
    let checkouts = 0;
    let mutated = false;
    const spy = vi.spyOn(pool, 'connect').mockImplementation((async (...args: any[]) => {
      if (typeof args[0] === 'function') return (originalConnect as any)(...args);
      const client = await originalConnect();
      if (++checkouts === 2) {
        mutated = true;
        if (change === 'epoch') await pool.query('INSERT INTO authorization_epochs (workos_user_id,epoch) VALUES ($1,1)', [A]);
        else {
          await pool.query('DELETE FROM identity_workos_users WHERE workos_user_id=$1', [A]);
          await pool.query('INSERT INTO identity_workos_users (workos_user_id,identity_id,is_primary) VALUES ($1,$2,false)', [A,identityId]);
        }
      }
      return client;
    }) as any);
    try {
      expect((await call(families[3], await cookie())).status).toBe(403);
      expect(mutated).toBe(true);
      expect(state.reads).toEqual([]);
      await noEffects();
    } finally { spy.mockRestore(); }
  });
  it('binding delete-and-reinsert after cached optional bearer authentication fails before every effect', async () => {
    const bearer = await token(A);
    const warm = await request(authProbeApp).get('/auth/optional-probe')
      .set('Authorization', `Bearer ${bearer}`);
    expect(warm.status).toBe(200);

    const originalConnect = pool.connect.bind(pool);
    let checkouts = 0;
    let mutated = false;
    const spy = vi.spyOn(pool, 'connect').mockImplementation((async (...args: any[]) => {
      if (typeof args[0] === 'function') return (originalConnect as any)(...args);
      const client = await originalConnect();
      if (++checkouts === 2) {
        mutated = true;
        await pool.query('DELETE FROM identity_workos_users WHERE workos_user_id = $1', [A]);
        await pool.query(
          'INSERT INTO identity_workos_users (workos_user_id, identity_id, is_primary) VALUES ($1, $2, false)',
          [A, identityId],
        );
      }
      return client;
    }) as any);
    try {
      const response = await request(app).post(`/api/organizations/${org}/invitations`)
        .set('Authorization', `Bearer ${bearer}`)
        .send({ email: 'cached-aba@membership-mutation.example.test' });
      expect(response.status).toBe(403);
      expect(mutated).toBe(true);
      expect(state.reads).toEqual([]);
      await noEffects();
    } finally {
      spy.mockRestore();
    }
  });
  for (const selector of ['header','query','query-org','body','token']) it(`denies conflicting ${selector} organization`,async()=>{
    let r=request(app).post(`/api/organizations/${org}/invitations`).set('Cookie',await cookie(A,selector==='token'?otherOrg:org)).set('X-CSRF-Token', CSRF_TOKEN);
    if(selector==='header')r=r.set('X-Organization-Id',otherOrg);
    if(selector==='query')r=r.query({organizationId:otherOrg});
    if(selector==='query-org')r=r.query({org:otherOrg});
    const response=await r.send({email:'invitee@membership-mutation.example.test',...(selector==='body'?{org_id:otherOrg}:{})});
    expect(response.status).toBe(403); await noEffects(); expect(state.reads).toEqual([]);
  });
  it('does not infer organization from primary or sole membership when path is absent',async()=>{
    expect((await request(app).post('/api/organizations/invitations').set('Cookie',await cookie()).set('X-CSRF-Token', CSRF_TOKEN).send({email:'invitee@membership-mutation.example.test'})).status).toBe(404); await noEffects();
  });
  for (const bearer of ['invalid','native-sealed-session','bearer invalid']) it(`explicit ${bearer} cannot use a valid cookie`,async()=>{
    const header=bearer.startsWith('bearer ')?bearer:`Bearer ${bearer}`;
    expect((await request(app).post(`/api/organizations/${org}/invitations`).set('Cookie',await cookie()).set('Authorization',header).send({email:'invitee@membership-mutation.example.test'})).status).toBe(401); await noEffects();
  });
  it('native sealed bearer is unsupported by base requireAuth',async()=>{
    expect((await request(app).post(`/api/organizations/${org}/invitations`).set('Authorization','Bearer native-sealed-session').send({email:'invitee@membership-mutation.example.test'})).status).toBe(401); await noEffects();
  });
  it('anonymous remains 401',async()=>{
    const response = await request(app).post(`/api/organizations/${org}/invitations`)
      .set('Cookie', `csrf-token=${CSRF_TOKEN}`).set('X-CSRF-Token', CSRF_TOKEN)
      .send({email:'invitee@membership-mutation.example.test'});
    expect(response.status).toBe(401); await noEffects();
  });
  it('organization API key cannot become an actor membership',async()=>{
    expect((await request(app).post(`/api/organizations/${org}/invitations`).set('Authorization','Bearer sk_membership_test').send({email:'invitee@membership-mutation.example.test'})).status).toBe(403); await noEffects();
  });
  for (const family of families) {
    for (const bearer of ['membership-test-static-key', 'sk_membership_test']) {
      it(`${family.name}: ${bearer.startsWith('sk_') ? 'organization API' : 'static admin'} key has no management authority`, async () => {
        const before = await managementState();
        const response = await request(app)[family.method](`/api/organizations/${org}${family.path()}`)
          .set('Authorization', `Bearer ${bearer}`).send(family.body?.() ?? {});
        expect(await managementState()).toEqual(before);
        expect(response.status).toBe(403);
        expect(state.reads).toEqual([]);
        await noEffects();
      });
    }
    it(`${family.name}: exact platform admin without selected-org membership is denied before provider reads`, async () => {
      await removeActor();
      await platformAdmin(A);
      const before = await managementState();
      const response = await call(family, await cookie());
      expect(response.status).toBe(403);
      expect(state.reads).toEqual([]);
      await noEffects();
      expect(await managementState()).toEqual(before);
      expect(state.logs).toContainEqual(expect.objectContaining({ actorId: A, orgId: org }));
    });
  }
  for (const role of ['admin', 'owner']) it(`platform admin with direct ${role} succeeds only as exact_membership`, async () => {
    await platformAdmin(A);
    await member(A, role);
    const response = await call(families[6], await cookie());
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const audit = (await pool.query('SELECT workos_user_id,details FROM registry_audit_log WHERE workos_organization_id=$1', [org])).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ workos_user_id: A, details: { authority: 'exact_membership', authenticated_workos_user_id: A, canonical_workos_user_id: B } });
    expect(state.authorityRequests).toContainEqual({ userId: A, organizationId: org, statuses: ['active'] });
  });
  it('platform admin cannot elevate its direct admin membership to owner', async () => {
    await platformAdmin(A);
    await member(A, 'admin');
    const response = await request(app).post(`/api/organizations/${org}/members/by-email`)
      .set('Cookie', await cookie()).set('X-CSRF-Token', CSRF_TOKEN)
      .send({ email: `${target}@membership-mutation.example.test`, role: 'owner' });
    expect(response.status).toBe(403);
    await noEffects();
  });
  for (const family of [families[3], families[6]]) it(`${family.name}: an unavailable authentication grant store fails closed before mutation`, async () => {
    await pool.query('ALTER TABLE organization_credential_grants RENAME TO membership_policy_grants_unavailable');
    try {
      const response = await call(family, await cookie());
      expect(response.status).toBe(503);
      expect(response.body).toEqual({ error: 'Authorization service temporarily unavailable' });
      expect(state.writes).toHaveLength(0);
    } finally { await pool.query('ALTER TABLE membership_policy_grants_unavailable RENAME TO organization_credential_grants'); }
  });
  for (const role of ['owner', 'invalid', 7, { slug: 'owner' }]) it(`reject ignores unused role ${JSON.stringify(role)}`, async () => {
    const response = await request(app).post(`/api/organizations/${org}/join-requests/${joinId}/reject`)
      .set('Cookie', await cookie()).set('X-CSRF-Token', CSRF_TOKEN).send({ role, reason: 'Declined' });
    expect(response.status).toBe(200);
    expect(state.writes).toEqual([]);
    const row = (await pool.query('SELECT status,handled_by_user_id FROM organization_join_requests WHERE id=$1', [joinId])).rows[0];
    expect(row).toEqual({ status: 'rejected', handled_by_user_id: A });
    const audit = (await pool.query('SELECT details FROM registry_audit_log WHERE workos_organization_id=$1', [org])).rows[0].details;
    expect(audit.role_assigned).toBeUndefined();
  });
  it('transaction connection uncertainty is a terminal 503 with zero effects', async () => {
    const original = pool.connect.bind(pool);
    let checkouts = 0;
    let failures = 0;
    const spy = vi.spyOn(pool, 'connect').mockImplementation(((...args: any[]) => {
      // Pool.query uses callback acquisition; fail only the explicit transaction
      // client so real authentication can finish against the healthy pool.
      if (typeof args[0] !== 'function' && ++checkouts === 2) {
        failures++;
        return Promise.reject(Object.assign(new Error('pool unavailable'), { code: 'ECONNRESET' }));
      }
      return (original as any)(...args);
    }) as any);
    try {
      const response = await call(families[6], await cookie());
      expect(response.status).toBe(503);
      expect(response.body).toEqual({ error: 'authorization_unavailable' });
      expect(failures).toBe(1);
      expect(state.reads).toEqual([]);
      await noEffects();
    } finally { spy.mockRestore(); }
  });
  for (const source of ['target', 'owner inventory']) it(`missing provider ${source} is 503 before effects`, async () => {
    await member(target, 'owner');
    state.malformedTarget = source === 'target';
    state.malformedInventory = source === 'owner inventory';
    const response = await call(families[7], await cookie());
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: 'authorization_unavailable' });
    await noEffects();
  });
  it('target revalidation outage is 503 before provider mutation', async () => {
    let targetReads = 0;
    const hook = async () => {
      if (state.reads.at(-1) === 'get_membership' && ++targetReads === 2) throw new Error('target source unavailable');
      state.beforeRead = hook;
    };
    state.beforeRead = hook;
    const response = await call(families[7], await cookie());
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: 'authorization_unavailable' });
    expect(targetReads).toBe(2);
    await noEffects();
  });
  it('by-email provider authority uncertainty is terminal 503', async () => {
    state.malformedAuthority = true;
    const response = await call(families[6], await cookie());
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: 'authorization_unavailable' });
    await noEffects();
  });
  it('invitation provider actor and residual log preserve the exact credential', async () => {
    state.afterWrite = async () => { await removeActor(); };
    const response = await call(families[3], await cookie());
    expect(response.status).toBe(503);
    expect(response.body.reconciliation_required).toBe(true);
    expect(state.invitations.get('inv_2').inviterUserId).toBe(A);
    expect(state.logs).toContainEqual(expect.objectContaining({ actorId: A, orgId: org, operationId: response.body.operation_id }));
    expect((await pool.query('SELECT id FROM registry_audit_log WHERE workos_organization_id=$1', [org])).rowCount).toBe(0);
  });

  for(const entity of [A,org])it(`fresh ${entity===A?'credential':'organization'} ban is terminal`,async()=>{
    await pool.query("INSERT INTO bans (ban_type,entity_id,scope,banned_by_user_id,reason) VALUES ($1,$2,'platform',$3,'test')",[entity===A?'user':'organization',entity,B]);
    expect((await call(families[3],await cookie())).status).toBe(403); await noEffects();
  });
  it('WorkOS authority outage is recoverable and never mutates',async()=>{
    state.outage=true;
    expect((await call(families[3],await cookie())).status).toBe(503); await noEffects();
  });
  for(const change of ['revoke','demote','detach'])it(`${change} during authority await aborts`,async()=>{
    const gate=barrier();state.beforeRead=gate.hook;
    const pending=call(families[3],await cookie()).then(r=>r);await gate.arrived;
    if(change==='revoke')await removeActor();
    if(change==='demote')await member(A,'member');
    if(change==='detach')await pool.query('DELETE FROM identity_workos_users WHERE workos_user_id=$1',[A]);
    gate.release();expect((await pending).status).toBe(403);await noEffects();
  });
  it('provider success then epoch revoke returns reconciliation and no local success',async()=>{
    const gate=barrier();state.afterWrite=gate.hook;
    const pending=call(families[3],await cookie()).then(r=>r);await gate.arrived;
    await pool.query('INSERT INTO authorization_epochs (workos_user_id,epoch) VALUES ($1,1)',[A]);
    gate.release();const response=await pending;
    expect(response.status).toBe(503);expect(response.body.reconciliation_required).toBe(true);
    expect((await pool.query('SELECT * FROM invitation_seat_types WHERE workos_organization_id=$1',[org])).rowCount).toBe(0);
    expect([...state.invitations.values()].some(inv=>inv.email==='invitee@membership-mutation.example.test'&&inv.state==='pending')).toBe(false);
  });
  for(const mode of ['exception','suppression'])for(const familyIndex of [1,3,7,9,10,11])it(`${families[familyIndex].name}: audit ${mode} aborts local success`,async()=>{
    const databaseSecret = 'database password=never-serialize';
    await pool.query(`CREATE OR REPLACE FUNCTION membership_test_audit_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${mode==='exception'?`RAISE EXCEPTION '${databaseSecret}';`:'RETURN NULL;'} END $$`);
    await pool.query("CREATE TRIGGER membership_test_audit BEFORE INSERT ON registry_audit_log FOR EACH ROW WHEN (NEW.workos_organization_id = 'org_mutation_test') EXECUTE FUNCTION membership_test_audit_fn()");
    const response=await call(families[familyIndex],await cookie());
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(response.body)).not.toContain(databaseSecret);
    expect((await pool.query('SELECT status FROM organization_join_requests WHERE id=$1',[joinId])).rows[0].status).toBe('pending');
    expect((await pool.query('SELECT status FROM seat_upgrade_requests WHERE id=$1',[seatId])).rows[0].status).toBe('pending');
    expect((await pool.query('SELECT role,seat_type FROM organization_memberships WHERE workos_user_id=$1 AND workos_organization_id=$2',[target,org])).rows[0]).toMatchObject({role:'member',seat_type:'community_only'});
  });
  it('suppressed membership UPDATE cannot report success',async()=>{
    await pool.query('CREATE OR REPLACE FUNCTION membership_test_update_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$');
    await pool.query("CREATE TRIGGER membership_test_update BEFORE UPDATE ON organization_memberships FOR EACH ROW WHEN (NEW.workos_organization_id = 'org_mutation_test') EXECUTE FUNCTION membership_test_update_fn()");
    const response=await call(families[7],await cookie());
    expect(response.status).toBe(503);expect(response.body.reconciliation_required).toBe(true);
  });
  it('two owners cannot demote each other concurrently',async()=>{
    await member(B);
    const gate=barrier();state.afterWrite=gate.hook;
    const first=request(app).patch(`/api/organizations/${org}/members/om_${B}`).set('Cookie',await cookie(A)).set('X-CSRF-Token', CSRF_TOKEN).send({role:'member'}).then(r=>r);
    await gate.arrived;
    const second=request(app).patch(`/api/organizations/${org}/members/om_${A}`).set('Cookie',await cookie(B)).set('X-CSRF-Token', CSRF_TOKEN).send({role:'member'}).then(r=>r);
    gate.release();const responses=await Promise.all([first,second]);
    expect(responses.map(r=>r.status).sort()).toEqual([200,403]);
    expect([...state.members.values()].filter(m=>m.role.slug==='owner')).toHaveLength(1);
  });
  it('admin cannot issue an owner invitation',async()=>{
    await member(A,'admin');
    const response=await request(app).post(`/api/organizations/${org}/invitations`).set('Cookie',await cookie()).set('X-CSRF-Token', CSRF_TOKEN).send({email:'invitee@membership-mutation.example.test',role:'owner'});
    expect(response.status).toBe(403);await noEffects();
  });
  it('expired invitation release is provider-confirmed, exact, audited, and does not call revoke', async () => {
    state.invitations.get('inv_existing').state = 'expired';
    state.invitations.get('inv_existing').expiresAt = new Date(Date.now() - 1000).toISOString();
    await pool.query(`INSERT INTO invitation_seat_types
      (workos_invitation_id,workos_organization_id,email,seat_type,source)
      VALUES ('inv_existing',$1,'existing@membership-mutation.example.test','community_only','invited')`, [org]);
    const response = await call(families[4], await cookie());
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(state.writes).toEqual([]);
    expect((await pool.query('SELECT 1 FROM invitation_seat_types WHERE workos_invitation_id=$1 AND workos_organization_id=$2', ['inv_existing', org])).rowCount).toBe(0);
    expect((await pool.query('SELECT action,details FROM registry_audit_log WHERE resource_id=$1', ['inv_existing'])).rows)
      .toEqual([expect.objectContaining({ action: 'invitation_reservation_released', details: expect.objectContaining({ provider_state: 'expired', expired: true }) })]);
  });
  it('expired invitation resend atomically replaces the exact seat reservation without revoke', async () => {
    state.invitations.get('inv_existing').state = 'expired';
    state.invitations.get('inv_existing').expiresAt = new Date(Date.now() - 1000).toISOString();
    await pool.query(`INSERT INTO invitation_seat_types
      (workos_invitation_id,workos_organization_id,email,seat_type,source)
      VALUES ('inv_existing',$1,'existing@membership-mutation.example.test','community_only','invited')`, [org]);
    const response = await call(families[5], await cookie());
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(state.writes).toEqual(['send_invitation']);
    expect((await pool.query(`SELECT workos_invitation_id,seat_type FROM invitation_seat_types
      WHERE workos_organization_id=$1`, [org])).rows)
      .toEqual([{ workos_invitation_id: response.body.invitation.id, seat_type: 'community_only' }]);
    expect((await pool.query('SELECT action FROM registry_audit_log WHERE resource_id=$1', [response.body.invitation.id])).rows)
      .toEqual([{ action: 'invitation_resent' }]);
  });
  it('accepted invitation cannot release or replace a seat reservation', async () => {
    state.invitations.get('inv_existing').state = 'accepted';
    await pool.query(`INSERT INTO invitation_seat_types
      (workos_invitation_id,workos_organization_id,email,seat_type,source)
      VALUES ('inv_existing',$1,'existing@membership-mutation.example.test','community_only','invited')`, [org]);
    for (const family of [families[4], families[5]]) {
      state.writes = [];
      const response = await call(family, await cookie());
      expect(response.status).toBe(409);
      expect(state.writes).toEqual([]);
      expect((await pool.query('SELECT 1 FROM invitation_seat_types WHERE workos_invitation_id=$1 AND workos_organization_id=$2', ['inv_existing', org])).rowCount).toBe(1);
      expect((await pool.query('SELECT 1 FROM registry_audit_log WHERE resource_id=$1', ['inv_existing'])).rowCount).toBe(0);
    }
  });
  it('expired resend keeps its seat reserved while a concurrent invitation waits', async () => {
    state.invitations.get('inv_existing').state = 'expired';
    state.invitations.get('inv_existing').expiresAt = new Date(Date.now() - 1000).toISOString();
    await pool.query("UPDATE organizations SET membership_tier=NULL,subscription_status=NULL WHERE workos_organization_id=$1", [org]);
    await pool.query("UPDATE organization_memberships SET seat_type='contributor' WHERE workos_organization_id=$1", [org]);
    await pool.query(`INSERT INTO invitation_seat_types
      (workos_invitation_id,workos_organization_id,email,seat_type,source)
      VALUES ('inv_existing',$1,'existing@membership-mutation.example.test','community_only','invited')`, [org]);
    const gate = barrier();
    state.afterWrite = gate.hook;
    const resend = call(families[5], await cookie()).then(response => response);
    await gate.arrived;
    const concurrent = request(app).post(`/api/organizations/${org}/invitations`).set('Cookie', await cookie()).set('X-CSRF-Token', CSRF_TOKEN)
      .send({ email: 'concurrent@membership-mutation.example.test', seat_type: 'community_only' }).then(response => response);
    await waitForDatabaseLock('pg_advisory_xact_lock');
    expect((await pool.query('SELECT workos_invitation_id FROM invitation_seat_types WHERE workos_organization_id=$1', [org])).rows)
      .toEqual([{ workos_invitation_id: 'inv_existing' }]);
    gate.release();
    expect((await resend).status).toBe(200);
    const denied = await concurrent;
    expect(denied.status).toBe(403);
    expect(denied.body.error).toBe('access_denied');
    expect(state.writes).toEqual(['send_invitation']);
    expect((await pool.query('SELECT COUNT(*)::int AS count FROM invitation_seat_types WHERE workos_organization_id=$1', [org])).rows[0].count).toBe(1);
  });
  it('expired reservation rowCount mismatch rolls back without audit or provider calls', async () => {
    state.invitations.get('inv_existing').state = 'expired';
    state.invitations.get('inv_existing').expiresAt = new Date(Date.now() - 1000).toISOString();
    await pool.query(`INSERT INTO invitation_seat_types
      (workos_invitation_id,workos_organization_id,email,seat_type,source)
      VALUES ('inv_existing',$1,'existing@membership-mutation.example.test','community_only','invited')`, [org]);
    await pool.query('CREATE OR REPLACE FUNCTION membership_test_stage_delete_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$');
    await pool.query("CREATE TRIGGER membership_test_stage_delete BEFORE DELETE ON invitation_seat_types FOR EACH ROW WHEN (OLD.workos_organization_id = 'org_mutation_test') EXECUTE FUNCTION membership_test_stage_delete_fn()");
    try {
      const response = await call(families[4], await cookie());
      expect(response.status).toBe(409);
      expect(state.writes).toEqual([]);
      expect((await pool.query('SELECT 1 FROM invitation_seat_types WHERE workos_invitation_id=$1', ['inv_existing'])).rowCount).toBe(1);
      expect((await pool.query('SELECT 1 FROM registry_audit_log WHERE resource_id=$1', ['inv_existing'])).rowCount).toBe(0);
    } finally {
      await pool.query('DROP TRIGGER membership_test_stage_delete ON invitation_seat_types');
      await pool.query('DROP FUNCTION membership_test_stage_delete_fn()');
    }
  });
  it('expired reservation release requires audit and rolls back when audit is suppressed', async () => {
    state.invitations.get('inv_existing').state = 'expired';
    state.invitations.get('inv_existing').expiresAt = new Date(Date.now() - 1000).toISOString();
    await pool.query(`INSERT INTO invitation_seat_types
      (workos_invitation_id,workos_organization_id,email,seat_type,source)
      VALUES ('inv_existing',$1,'existing@membership-mutation.example.test','community_only','invited')`, [org]);
    await pool.query('CREATE OR REPLACE FUNCTION membership_test_audit_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$');
    await pool.query("CREATE TRIGGER membership_test_audit BEFORE INSERT ON registry_audit_log FOR EACH ROW WHEN (NEW.workos_organization_id = 'org_mutation_test') EXECUTE FUNCTION membership_test_audit_fn()");
    const response = await call(families[4], await cookie());
    expect(response.status).toBe(409);
    expect(state.writes).toEqual([]);
    expect((await pool.query('SELECT 1 FROM invitation_seat_types WHERE workos_invitation_id=$1', ['inv_existing'])).rowCount).toBe(1);
    expect((await pool.query('SELECT 1 FROM registry_audit_log WHERE resource_id=$1', ['inv_existing'])).rowCount).toBe(0);
  });
  it('resend rejection preserves honest revoked upstream state',async()=>{
    state.afterWrite=async()=>{state.rejectWrite=Object.assign(new Error('reject'),{status:422});};
    const response=await call(families[5],await cookie());
    expect(response.status).toBe(503);expect(response.body.reconciliation_required).toBe(true);
    expect(state.invitations.get('inv_existing').state).toBe('revoked');
  });
  it('provider timeout has unknown outcome, never an invented rollback',async()=>{
    state.rejectWrite=Object.assign(new Error('timeout'),{code:'ETIMEDOUT'});
    const response=await call(families[3],await cookie());
    expect(response.status).toBe(503);expect(response.body.reconciliation_required).toBe(true);
    expect(state.writes).toEqual(['send_invitation']);
  });
});
