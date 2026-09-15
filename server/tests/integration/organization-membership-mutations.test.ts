import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { generateKeyPair, SignJWT } from 'jose';
import type { Pool } from 'pg';

const state = vi.hoisted(() => {
  process.env.ADMIN_API_KEY = 'membership-test-static-key';
  return {
    members: new Map<string, any>(), invitations: new Map<string, any>(), users: new Map<string, any>(), sessions: new Map<string, any>(),
    reads: [] as string[], writes: [] as string[],
    beforeRead: undefined as undefined | (() => Promise<void>),
    afterWrite: undefined as undefined | (() => Promise<void>),
    rejectWrite: undefined as unknown,
    outage: false,
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
    apiKeys = { createValidation: async () => ({ apiKey: { id: 'key_test', name: 'test', owner: { id: 'org_mutation_test' }, permissions: ['admin'] } }) };
    userManagement = {
      loadSealedSession: ({ sessionData }: any) => ({ authenticate: async () => state.sessions.get(sessionData) ?? { authenticated: false }, refresh: async () => ({ authenticated: false }) }),
      listOrganizationMemberships: async ({ userId, organizationId, statuses }: any) => {
        await read('list_memberships');
        return { data: structuredClone([...state.members.values()].filter(m => (!userId || m.userId === userId) && (!organizationId || m.organizationId === organizationId) && (!statuses || statuses.includes(m.status)))) };
      },
      getOrganizationMembership: async (id: string) => { await read('get_membership'); if (!state.members.has(id)) throw Object.assign(new Error('not found'), { status: 404 }); return structuredClone(state.members.get(id)); },
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
vi.mock('../../src/addie/mcp/admin-tools.js', () => ({ isWebUserAAOAdmin: vi.fn().mockResolvedValue(false) }));
vi.mock('../../src/middleware/rate-limit.js', () => ({
  invitationRateLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  orgCreationRateLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../../src/services/organization-membership-notifications.js', () => ({ notifyMembershipSeats: vi.fn(), notifyMembershipSeatRequest: vi.fn() }));
vi.mock('../../src/slack/org-group-dm.js', () => ({ notifyMemberSeatChanged: vi.fn() }));

import { createOrganizationsRouter } from '../../src/routes/organizations.js';
import { initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { __setJWKSForTesting } from '../../src/auth/workos-jwt.js';
import { stopAuthTimers, invalidateBanCache } from '../../src/middleware/auth.js';

const org = 'org_mutation_test';
const otherOrg = 'org_mutation_other';
const A = 'user_mutation_a';
const B = 'user_mutation_b';
const target = 'user_mutation_target';
const newcomer = 'user_mutation_new';
let pool: Pool;
let signingKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
let sequence = 0;
let joinId: string;
let seatId: string;
let identityId: string;
const app = express();
app.use(express.json(), cookieParser());
app.use('/api/organizations', createOrganizationsRouter());

async function token(actor = A, selected: string | undefined = org) {
  return new SignJWT({ client_id: 'client_mock_id', ...(selected ? { org_id: selected } : {}) }).setProtectedHeader({ alg: 'RS256' }).setSubject(actor).setIssuedAt().setJti(String(++sequence)).setExpirationTime('5m').sign(signingKey);
}
async function cookie(actor = A, selected: string | undefined = org) {
  const value = `session_${++sequence}`;
  state.sessions.set(value, { authenticated: true, user: state.users.get(actor), accessToken: await token(actor, selected) });
  return `wos-session=${value}`;
}
async function member(userId: string, role = 'owner', organizationId = org) {
  const id = `om_${userId}`;
  state.members.set(id, { id, userId, organizationId, status: 'active', role: { slug: role } });
  await pool.query(`INSERT INTO organization_memberships (workos_user_id, workos_organization_id, workos_membership_id, email, role, seat_type)
    VALUES ($1,$2,$3,$4,$5,'community_only') ON CONFLICT (workos_user_id,workos_organization_id) DO UPDATE SET role=$5, workos_membership_id=$3`, [userId, organizationId, id, `${userId}@membership-mutation.example.test`, role]);
}
async function removeActor(userId = A) {
  state.members.delete(`om_${userId}`);
  await pool.query('DELETE FROM organization_memberships WHERE workos_user_id=$1 AND workos_organization_id=$2', [userId, org]);
}
async function noEffects() {
  expect(state.writes).toEqual([]);
  expect((await pool.query('SELECT id FROM registry_audit_log WHERE workos_organization_id=$1', [org])).rowCount).toBe(0);
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
  return request(app)[family.method](`/api/organizations/${org}${family.path()}`).set('Cookie', authCookie).send(family.body?.() ?? {});
}

beforeAll(async () => {
  pool = initializeDatabase({ connectionString: process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:55432/adcp_test', maxPoolSize: 12 });
  await runMigrations();
  const keys = await generateKeyPair('RS256');
  signingKey = keys.privateKey;
  __setJWKSForTesting(async () => keys.publicKey);
}, 60000);
afterAll(async () => { stopAuthTimers(); __setJWKSForTesting(null); await closeDatabase(); });
beforeEach(async () => {
  for (const id of [A, B, target, newcomer]) invalidateBanCache('user', id);
  invalidateBanCache('apikey', 'key_test');
  state.members.clear(); state.invitations.clear(); state.users.clear(); state.sessions.clear(); state.reads = []; state.writes = [];
  state.beforeRead = undefined; state.afterWrite = undefined; state.rejectWrite = undefined; state.outage = false;
  await pool.query('DROP TRIGGER IF EXISTS membership_test_audit ON registry_audit_log');
  await pool.query('DROP TRIGGER IF EXISTS membership_test_update ON organization_memberships');
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
  for (const family of families) {
    it(`${family.name}: exact nonprimary owner succeeds with credential and person audit`, async () => {
      const response = await call(family, await cookie());
      expect(response.status, JSON.stringify(response.body)).toBeLessThan(300);
      const audit = await pool.query('SELECT workos_user_id,details FROM registry_audit_log WHERE workos_organization_id=$1', [org]);
      expect(audit.rowCount).toBeGreaterThan(0);
      for (const row of audit.rows) {
        expect(row.workos_user_id).toBe(A);
        expect(row.details).toMatchObject({ authenticated_workos_user_id:A,canonical_workos_user_id:B,identity_id:identityId });
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
      expect((await call(families[3],await cookie())).status).toBe(403); await noEffects(); expect(state.reads).toEqual([]);
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
  for (const change of ['epoch', 'binding-round-trip']) it(`${change} between authentication stamp and route capture fails closed`, async () => {
    const original = pool.query.bind(pool);
    let armed = true;
    const spy = vi.spyOn(pool, 'query').mockImplementation((async (...args: any[]) => {
      const result = await (original as any)(...args);
      if (armed && typeof args[0] === 'string' && args[0].includes('string_agg')) {
        armed = false;
        if (change === 'epoch') await original('INSERT INTO authorization_epochs (workos_user_id,epoch) VALUES ($1,1)', [A]);
        else {
          await original('DELETE FROM identity_workos_users WHERE workos_user_id=$1', [A]);
          await original('INSERT INTO identity_workos_users (workos_user_id,identity_id,is_primary) VALUES ($1,$2,false)', [A,identityId]);
        }
      }
      return result;
    }) as any);
    try {
      expect((await call(families[3], await cookie())).status).toBe(403);
      expect(armed).toBe(false);
      expect(state.reads).toEqual([]);
      await noEffects();
    } finally { spy.mockRestore(); }
  });
  for (const selector of ['header','query','query-org','body','token']) it(`denies conflicting ${selector} organization`,async()=>{
    let r=request(app).post(`/api/organizations/${org}/invitations`).set('Cookie',await cookie(A,selector==='token'?otherOrg:org));
    if(selector==='header')r=r.set('X-Organization-Id',otherOrg);
    if(selector==='query')r=r.query({organizationId:otherOrg});
    if(selector==='query-org')r=r.query({org:otherOrg});
    const response=await r.send({email:'invitee@membership-mutation.example.test',...(selector==='body'?{org_id:otherOrg}:{})});
    expect(response.status).toBe(403); await noEffects(); expect(state.reads).toEqual([]);
  });
  it('does not infer organization from primary or sole membership when path is absent',async()=>{
    expect((await request(app).post('/api/organizations/invitations').set('Cookie',await cookie()).send({email:'invitee@membership-mutation.example.test'})).status).toBe(404); await noEffects();
  });
  for (const bearer of ['invalid','native-sealed-session','bearer invalid']) it(`explicit ${bearer} cannot use a valid cookie`,async()=>{
    const header=bearer.startsWith('bearer ')?bearer:`Bearer ${bearer}`;
    expect((await request(app).post(`/api/organizations/${org}/invitations`).set('Cookie',await cookie()).set('Authorization',header).send({email:'invitee@membership-mutation.example.test'})).status).toBe(401); await noEffects();
  });
  it('native sealed bearer is unsupported by base requireAuth',async()=>{
    expect((await request(app).post(`/api/organizations/${org}/invitations`).set('Authorization','Bearer native-sealed-session').send({email:'invitee@membership-mutation.example.test'})).status).toBe(401); await noEffects();
  });
  it('anonymous remains 401',async()=>{
    expect((await request(app).post(`/api/organizations/${org}/invitations`).send({email:'invitee@membership-mutation.example.test'})).status).toBe(401); await noEffects();
  });
  it('organization API key cannot become an actor membership',async()=>{
    expect((await request(app).post(`/api/organizations/${org}/invitations`).set('Authorization','Bearer sk_membership_test').send({email:'invitee@membership-mutation.example.test'})).status).toBe(403); await noEffects();
  });
  it('static administrative key retains explicit by-email management only',async()=>{
    await removeActor();
    const response=await request(app).post(`/api/organizations/${org}/members/by-email`).set('Authorization','Bearer membership-test-static-key').send({email:`${newcomer}@membership-mutation.example.test`});
    expect(response.status,JSON.stringify(response.body)).toBe(201);
    expect((await pool.query('SELECT workos_user_id,details FROM registry_audit_log WHERE workos_organization_id=$1',[org])).rows[0]).toMatchObject({workos_user_id:'admin_api_key',details:{authority:'static_admin_key',canonical_workos_user_id:null}});
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
    await pool.query(`CREATE OR REPLACE FUNCTION membership_test_audit_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${mode==='exception'?"RAISE EXCEPTION 'required audit failed';":'RETURN NULL;'} END $$`);
    await pool.query('CREATE TRIGGER membership_test_audit BEFORE INSERT ON registry_audit_log FOR EACH ROW EXECUTE FUNCTION membership_test_audit_fn()');
    const response=await call(families[familyIndex],await cookie());
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect((await pool.query('SELECT status FROM organization_join_requests WHERE id=$1',[joinId])).rows[0].status).toBe('pending');
    expect((await pool.query('SELECT status FROM seat_upgrade_requests WHERE id=$1',[seatId])).rows[0].status).toBe('pending');
    expect((await pool.query('SELECT role,seat_type FROM organization_memberships WHERE workos_user_id=$1 AND workos_organization_id=$2',[target,org])).rows[0]).toMatchObject({role:'member',seat_type:'community_only'});
  });
  it('suppressed membership UPDATE cannot report success',async()=>{
    await pool.query('CREATE OR REPLACE FUNCTION membership_test_update_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$');
    await pool.query('CREATE TRIGGER membership_test_update BEFORE UPDATE ON organization_memberships FOR EACH ROW EXECUTE FUNCTION membership_test_update_fn()');
    const response=await call(families[7],await cookie());
    expect(response.status).toBe(503);expect(response.body.reconciliation_required).toBe(true);
  });
  it('two owners cannot demote each other concurrently',async()=>{
    await member(B);
    const gate=barrier();state.afterWrite=gate.hook;
    const first=request(app).patch(`/api/organizations/${org}/members/om_${B}`).set('Cookie',await cookie(A)).send({role:'member'}).then(r=>r);
    await gate.arrived;
    const second=request(app).patch(`/api/organizations/${org}/members/om_${A}`).set('Cookie',await cookie(B)).send({role:'member'}).then(r=>r);
    gate.release();const responses=await Promise.all([first,second]);
    expect(responses.map(r=>r.status).sort()).toEqual([200,403]);
    expect([...state.members.values()].filter(m=>m.role.slug==='owner')).toHaveLength(1);
  });
  it('admin cannot issue an owner invitation',async()=>{
    await member(A,'admin');
    const response=await request(app).post(`/api/organizations/${org}/invitations`).set('Cookie',await cookie()).send({email:'invitee@membership-mutation.example.test',role:'owner'});
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
    const concurrent = request(app).post(`/api/organizations/${org}/invitations`).set('Cookie', await cookie())
      .send({ email: 'concurrent@membership-mutation.example.test', seat_type: 'community_only' }).then(response => response);
    await waitForDatabaseLock('pg_advisory_xact_lock');
    expect((await pool.query('SELECT workos_invitation_id FROM invitation_seat_types WHERE workos_organization_id=$1', [org])).rows)
      .toEqual([{ workos_invitation_id: 'inv_existing' }]);
    gate.release();
    expect((await resend).status).toBe(200);
    const denied = await concurrent;
    expect(denied.status).toBe(403);
    expect(denied.body.error).toBe('Seat limit reached');
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
    await pool.query('CREATE TRIGGER membership_test_stage_delete BEFORE DELETE ON invitation_seat_types FOR EACH ROW EXECUTE FUNCTION membership_test_stage_delete_fn()');
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
    await pool.query('CREATE TRIGGER membership_test_audit BEFORE INSERT ON registry_audit_log FOR EACH ROW EXECUTE FUNCTION membership_test_audit_fn()');
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
