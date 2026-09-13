/** Real request authorization must observe journal state even without an epoch bump. */
import { createHmac, randomUUID } from 'node:crypto';
import express, { type Express, type Request, type Response } from 'express';
import cookieParser from 'cookie-parser';
import supertest from 'supertest';
import { generateKeyPair, SignJWT } from 'jose';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const providerMocks = vi.hoisted(() => ({ authenticate: vi.fn(), getUser: vi.fn(), updateUser: vi.fn() }));
vi.hoisted(() => {
  process.env.DEV_USER_EMAIL = '';
  process.env.DEV_USER_ID = '';
  process.env.WORKOS_API_KEY = 'sk_email_mutation_test';
  process.env.WORKOS_CLIENT_ID = 'client_email_mutation_test';
  process.env.WORKOS_COOKIE_PASSWORD = 'email-mutation-cookie-password-32-bytes-minimum';
});
vi.mock('@workos-inc/node', () => ({
  WorkOS: vi.fn(function WorkOS() {
    return { userManagement: {
      loadSealedSession: ({ sessionData }: { sessionData: string }) => ({
        authenticate: () => providerMocks.authenticate(sessionData),
        refresh: async () => ({ authenticated: false }),
      }),
      getUser: providerMocks.getUser,
      updateUser: providerMocks.updateUser,
    } };
  }),
}));
// Isolate configuration email authority from unrelated group and ban decisions.
vi.mock('../../src/addie/mcp/admin-tools.js', () => ({ isWebUserAAOAdmin: async () => false }));
vi.mock('../../src/db/bans-db.js', () => ({ bansDb: { checkPlatformBan: async () => ({ banned: false }) } }));

const USER_ID = 'user_email_mutation_auth';
const OTHER_USER_ID = 'user_email_mutation_auth_conflict';
const ADMIN_EMAIL = 'email-mutation-admin@pinnacle.example';
const ORDINARY_EMAIL = 'email-mutation-member@pinnacle.example';
const oldAdminEmails = process.env.ADMIN_EMAILS;
type AuthModule = typeof import('../../src/middleware/auth.js');
type DatabaseModule = typeof import('../../src/db/client.js');
type JwtModule = typeof import('../../src/auth/workos-jwt.js');
type MutationModule = typeof import('../../src/services/email-mutation.js');
type Replica = { app: Express; auth: AuthModule; database: DatabaseModule; jwt: JwtModule; pool: Pool };
type Authentication = 'cookie' | 'bearer';

describe('member email mutation authorization across independent replicas', () => {
  let replicaA: Replica;
  let replicaB: Replica;
  let mutations: MutationModule;
  let signingKeys: Awaited<ReturnType<typeof generateKeyPair>>;
  let provider: { id: string; email: string; emailVerified: boolean };
  const cookieClaims = new Map<string, { email: string; emailVerified: boolean }>();
  const extraReplicas: Replica[] = [];
  let fixtureIdentities: string[] = [];
  const connectionString = process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:5432/adcp_test';

  async function createReplica(): Promise<Replica> {
    // Reset the module registry, retaining both imported instances. Each has its
    // own provider caches and primary pool, like independent application nodes.
    vi.resetModules();
    const database = await import('../../src/db/client.js');
    const pool = database.initializeDatabase({ connectionString });
    const jwt = await import('../../src/auth/workos-jwt.js');
    jwt.__setJWKSForTesting(async () => signingKeys.publicKey);
    const auth = await import('../../src/middleware/auth.js');
    auth.stopAuthTimers();
    const app = express();
    app.use(cookieParser());
    const respond = (req: Request, res: Response) => res.json({
      user_id: req.user?.id,
      authenticated_user_id: req.user?.authorizationSnapshot?.authenticatedUserId,
      email: req.user?.email,
      verified: req.user?.emailVerified,
      epoch: req.user?.authorizationSnapshot?.authorizationEpoch,
      pending: req.user?.authorizationSnapshot?.credential.emailMutationPending,
      mechanism: req.adminAccessMechanism,
    });
    app.get('/api/admin/check', auth.requireAuth, auth.requireAdmin, respond);
    app.get('/api/member/check', auth.requireAuth, respond);
    return { app, auth, database, jwt, pool };
  }
  async function token(authentication: Authentication, email = ADMIN_EMAIL, verified = true): Promise<string> {
    if (authentication === 'cookie') {
      const sealed = `sealed-email-${randomUUID()}`;
      cookieClaims.set(sealed, { email, emailVerified: verified });
      return sealed;
    }
    // JWT signature verification remains real; only the remote JWKS transport
    // is replaced by a local public key, separately on each replica.
    return new SignJWT({ email, azp: process.env.WORKOS_CLIENT_ID })
      .setProtectedHeader({ alg: 'RS256' }).setSubject(USER_ID).setJti(randomUUID())
      .setIssuedAt().setExpirationTime('1h').sign(signingKeys.privateKey);
  }
  function request(replica: Replica, authentication: Authentication, credential: string, admin = true) {
    const req = supertest(replica.app).get(admin ? '/api/admin/check' : '/api/member/check').set('Accept', 'application/json');
    return authentication === 'cookie' ? req.set('Cookie', `wos-session=${credential}`) : req.set('Authorization', `Bearer ${credential}`);
  }
  async function epoch() {
    return (await replicaB.pool.query('SELECT COALESCE((SELECT epoch FROM authorization_epochs WHERE workos_user_id=$1),0)::text AS epoch', [USER_ID])).rows[0].epoch;
  }
  async function journal() {
    return (await replicaB.pool.query('SELECT * FROM email_mutations WHERE workos_user_id=$1', [USER_ID])).rows;
  }
  const mutate = (operationId = randomUUID()) => mutations.setPrimaryEmail({ userId: USER_ID, email: ORDINARY_EMAIL, operationId });
  async function cleanup() {
    await replicaB.pool.query('DELETE FROM email_mutations WHERE workos_user_id=ANY($1)', [[USER_ID, OTHER_USER_ID]]);
    await replicaB.pool.query('DELETE FROM person_relationships WHERE workos_user_id=ANY($1)', [[USER_ID, OTHER_USER_ID]]);
    const bindings = await replicaB.pool.query('SELECT identity_id FROM identity_workos_users WHERE workos_user_id=ANY($1)', [[USER_ID, OTHER_USER_ID]]);
    await replicaB.pool.query('DELETE FROM users WHERE workos_user_id=ANY($1)', [[USER_ID, OTHER_USER_ID]]);
    await replicaB.pool.query('DELETE FROM identities WHERE id=ANY($1)', [[...fixtureIdentities, ...bindings.rows.map(row => row.identity_id)]]);
    fixtureIdentities = [];
  }
  beforeAll(async () => {
    process.env.ADMIN_EMAILS = ADMIN_EMAIL;
    signingKeys = await generateKeyPair('RS256');
    replicaA = await createReplica();
    const { runMigrations } = await import('../../src/db/migrate.js');
    await runMigrations();
    replicaB = await createReplica();
    mutations = await import('../../src/services/email-mutation.js');
    expect(replicaA.auth.requireAuth).not.toBe(replicaB.auth.requireAuth);
    expect(replicaA.pool).not.toBe(replicaB.pool);
  }, 60_000);
  beforeEach(async () => {
    vi.restoreAllMocks();
    await cleanup();
    replicaA.auth.invalidateSessionsForUsers([USER_ID]);
    replicaB.auth.invalidateSessionsForUsers([USER_ID]);
    replicaA.jwt.__setJWKSForTesting(async () => signingKeys.publicKey);
    replicaB.jwt.__setJWKSForTesting(async () => signingKeys.publicKey);
    cookieClaims.clear();
    await replicaB.pool.query('INSERT INTO users(workos_user_id,email,email_verified,workos_created_at,workos_updated_at) VALUES($1,$2,true,NOW(),NOW())', [USER_ID, ADMIN_EMAIL]);
    await replicaB.pool.query('INSERT INTO user_email_aliases(workos_user_id,email) VALUES($1,$2)', [USER_ID, ORDINARY_EMAIL]);
    fixtureIdentities = (await replicaB.pool.query('SELECT identity_id FROM identity_workos_users WHERE workos_user_id=$1', [USER_ID])).rows.map(row => row.identity_id);
    provider = { id: USER_ID, email: ADMIN_EMAIL, emailVerified: true };
    providerMocks.authenticate.mockReset().mockImplementation(async (sealed: string) => ({
      authenticated: true, user: { id: USER_ID, ...cookieClaims.get(sealed), createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }, accessToken: 'test-access-token',
    }));
    providerMocks.getUser.mockReset().mockImplementation(async () => ({ ...provider }));
    providerMocks.updateUser.mockReset().mockImplementation(async ({ userId, email, emailVerified }) => {
      provider = { id: userId, email, emailVerified }; return { ...provider };
    });
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    if (replicaB) await cleanup();
    for (const replica of [replicaA, replicaB, ...extraReplicas].filter(Boolean)) {
      replica.auth.stopAuthTimers();
      await replica.database.closeDatabase();
    }
    if (oldAdminEmails === undefined) delete process.env.ADMIN_EMAILS;
    else process.env.ADMIN_EMAILS = oldAdminEmails;
  });

  describe.each(['cookie', 'bearer'] as const)('%s authentication', authentication => {
    it('revokes old admin claims after a successful email change on another replica, including cold recaching', async () => {
      const oldToken = await token(authentication);
      expect((await request(replicaA, authentication, oldToken)).status).toBe(200);
      await mutate();
      expect(await epoch()).toBe('1');
      for (const replica of [replicaA, replicaB]) {
        for (const credential of [oldToken, await token(authentication)]) {
          expect((await request(replica, authentication, credential)).status).toBe(403);
          expect((await request(replica, authentication, credential, false)).body).toMatchObject({ email: ORDINARY_EMAIL, verified: true, epoch: '1', pending: false });
        }
      }
      expect(providerMocks.updateUser).toHaveBeenCalledOnce();
    });
    it.each([USER_ID, OTHER_USER_ID])('denies pending provider-success crash authority with primary identity %s and unchanged epoch', async primaryId => {
      await replicaB.pool.query('INSERT INTO users(workos_user_id,email,email_verified,workos_created_at,workos_updated_at) VALUES($1,$2,true,NOW(),NOW())', [OTHER_USER_ID, 'unrelated-email-auth@pinnacle.example']);
      fixtureIdentities = (await replicaB.pool.query('SELECT identity_id FROM identity_workos_users WHERE workos_user_id=ANY($1)', [[USER_ID, OTHER_USER_ID]])).rows.map(row => row.identity_id);
      const secondaryId = primaryId === USER_ID ? OTHER_USER_ID : USER_ID;
      await replicaB.pool.query('UPDATE identity_workos_users SET identity_id=(SELECT identity_id FROM identity_workos_users WHERE workos_user_id=$1),is_primary=false WHERE workos_user_id=$2', [primaryId, secondaryId]);
      const oldToken = await token(authentication);
      const positiveControl = await request(replicaA, authentication, oldToken);
      expect(positiveControl.status).toBe(200);
      expect(positiveControl.body).toMatchObject({ user_id: primaryId, authenticated_user_id: USER_ID, pending: false });
      // Exact durable state left by a process exit after WorkOS success but
      // before local terminal/recordFailure transactions. No recovery is run.
      const id = randomUUID();
      await replicaB.pool.query(`INSERT INTO email_mutations
        (id,workos_user_id,actor_user_id,payload_hash,old_email,old_email_verified,new_email,expected_email_version,state,result_status,result_body)
        VALUES($1,$2,$2,$3,$4,true,$5,0,'pending',409,$6)`, [id, USER_ID,
        createHmac('sha256', 'adcp:member-primary-email:idempotency:v1').update(JSON.stringify([USER_ID, ORDINARY_EMAIL])).digest('hex'),
        ADMIN_EMAIL, ORDINARY_EMAIL, { operation_id: id, reconciliation_required: true }]);
      await providerMocks.updateUser({ userId: USER_ID, email: ORDINARY_EMAIL, emailVerified: true });
      expect(await epoch()).toBe('0');
      expect((await journal())[0]).toMatchObject({ state: 'pending', epoch_after: null, applied_email_version: null });
      for (const replica of [replicaA, replicaB]) {
        for (const credential of [oldToken, await token(authentication)]) {
          expect((await request(replica, authentication, credential)).status).toBe(403);
          expect((await request(replica, authentication, credential, false)).body).toMatchObject({ email: ADMIN_EMAIL, epoch: '0', pending: true });
        }
      }
      expect(providerMocks.getUser).not.toHaveBeenCalled();
      expect(providerMocks.updateUser).toHaveBeenCalledOnce();
    });
    it('denies reconciliation authority after an ambiguous provider write, including delayed completion', async () => {
      const oldToken = await token(authentication);
      expect((await request(replicaA, authentication, oldToken)).status).toBe(200);
      providerMocks.updateUser.mockImplementationOnce(async () => { throw Object.assign(new Error('provider timeout'), { status: 408 }); });
      await expect(mutate()).rejects.toMatchObject({ body: { reconciliation_required: true } });
      // Completion of the original provider request cannot clear the journal.
      provider = { id: USER_ID, email: ORDINARY_EMAIL, emailVerified: true };
      expect((await journal())[0]).toMatchObject({ state: 'reconciliation_required', epoch_after: '1' });
      for (const replica of [replicaA, replicaB]) {
        for (const credential of [oldToken, await token(authentication)]) {
          expect((await request(replica, authentication, credential)).status).toBe(403);
        }
      }
      expect(providerMocks.updateUser).toHaveBeenCalledOnce();
    });
    it('restores verified local admin authority only after known provider compensation commits', async () => {
      const oldToken = await token(authentication);
      expect((await request(replicaA, authentication, oldToken)).status).toBe(200);
      await replicaB.pool.query('INSERT INTO person_relationships(workos_user_id,email) VALUES($1,$2)', [USER_ID, ADMIN_EMAIL]);
      await replicaB.pool.query('INSERT INTO person_relationships(workos_user_id,email) VALUES($1,$2)', [OTHER_USER_ID, ORDINARY_EMAIL]);
      await expect(mutate()).rejects.toMatchObject({ body: { reconciliation_required: false } });
      expect((await journal())[0]).toMatchObject({ state: 'compensated', epoch_after: '2' });
      expect(provider).toEqual({ id: USER_ID, email: ADMIN_EMAIL, emailVerified: true });
      for (const replica of [replicaA, replicaB]) {
        for (const credential of [oldToken, await token(authentication, ORDINARY_EMAIL)]) {
          const response = await request(replica, authentication, credential);
          expect(response.status).toBe(200);
          expect(response.body).toMatchObject({ email: ADMIN_EMAIL, verified: true, epoch: '2', pending: false, mechanism: 'break_glass_admin_email' });
        }
      }
      expect(providerMocks.updateUser).toHaveBeenCalledTimes(2);
    });
    it('keeps baseline read outages reconciliation-required and blocks old admin claims on every replica', async () => {
      const oldToken = await token(authentication);
      expect((await request(replicaA, authentication, oldToken)).status).toBe(200);
      providerMocks.getUser.mockRejectedValueOnce(new Error('private provider diagnostic'));
      const id = randomUUID();
      await expect(mutate(id)).rejects.toMatchObject({ status: 409, body: { reconciliation_required: true } });
      await expect(mutate(id)).rejects.toMatchObject({ status: 409, body: { reconciliation_required: true } });
      expect((await journal())[0]).toMatchObject({ state: 'reconciliation_required', failure_code: 'provider_read_failed', applied_email_version: null });
      for (const replica of [replicaA, replicaB]) {
        expect((await request(replica, authentication, oldToken)).status).toBe(403);
        expect((await request(replica, authentication, await token(authentication))).status).toBe(403);
      }
      expect(providerMocks.getUser).toHaveBeenCalledOnce();
      expect(providerMocks.updateUser).not.toHaveBeenCalled();
    });
    it('fails closed on a primary snapshot outage for warm and cold provider credentials', async () => {
      const unavailable = await createReplica();
      extraReplicas.push(unavailable);
      const oldToken = await token(authentication);
      expect((await request(unavailable, authentication, oldToken)).status).toBe(200);
      // Close only this replica's real database pool; cached provider proof
      // remains present and cannot substitute for its unavailable authority DB.
      await unavailable.database.closeDatabase();
      for (const credential of [oldToken, await token(authentication)]) {
        const response = await request(unavailable, authentication, credential);
        expect(response.status).toBe(503);
        expect(response.body).toEqual({ error: 'Authorization service temporarily unavailable' });
      }
    });
    it('cannot recover old admin authority through a provider authentication outage after local success', async () => {
      const oldToken = await token(authentication);
      expect((await request(replicaA, authentication, oldToken)).status).toBe(200);
      await mutate();
      if (authentication === 'cookie') providerMocks.authenticate.mockRejectedValue(Object.assign(new Error('provider unavailable'), { status: 503 }));
      else for (const replica of [replicaA, replicaB]) replica.jwt.__setJWKSForTesting(async () => { throw Object.assign(new Error('provider unavailable'), { status: 503 }); });
      expect((await request(replicaA, authentication, oldToken)).status).toBe(403);
      for (const replica of [replicaA, replicaB]) {
        const response = await request(replica, authentication, await token(authentication));
        expect(response.status).toBe(503);
        expect(response.body).not.toHaveProperty('mechanism');
      }
    });
  });
});
