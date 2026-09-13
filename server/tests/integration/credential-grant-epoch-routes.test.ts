import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import type { Pool } from 'pg';
import type { WorkOS } from '@workos-inc/node';
import { initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';

vi.hoisted(() => {
  process.env.WORKOS_API_KEY ??= 'sk_test';
  process.env.WORKOS_CLIENT_ID ??= 'client_test';
  process.env.WORKOS_COOKIE_PASSWORD ??= 'placeholder-cookie-password-32-bytes-min';
});

vi.mock('../../src/middleware/auth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/middleware/auth.js')>();
  return {
    ...actual,
    requireAuth: (req: Request, _res: Response, next: NextFunction) => {
      const credential = req.header('x-test-authenticated-credential')!;
      req.user = {
        id: req.header('x-test-canonical-user') || credential,
        authWorkosUserId: credential,
        email: `${credential}@example.test`,
        emailVerified: true,
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      };
      next();
    },
  };
});

const { createOrganizationsRouter } = await import('../../src/routes/organizations.js');
const { stopAuthTimers } = await import('../../src/middleware/auth.js');
const { WorkingGroupDatabase } = await import('../../src/db/working-group-db.js');

const ORG_ID = 'org_credential_epoch_routes';
const ACTOR = 'user_credential_epoch_actor';
const CANONICAL = 'user_credential_epoch_canonical';
const TARGET = 'user_credential_epoch_target';
const NEXT_TARGET = 'user_credential_epoch_next';
const ABSENT_TARGET = 'user_credential_epoch_absent';
const USERS = [ACTOR, CANONICAL, TARGET, NEXT_TARGET];

describe('exact credential grant epoch routes', () => {
  let pool: Pool;
  const roles = new Map<string, 'member' | 'admin' | 'owner'>();
  const workos = {
    userManagement: {
      listOrganizationMemberships: vi.fn(async ({ userId, organizationId }: {
        userId: string;
        organizationId: string;
      }) => ({
        data: roles.has(userId) ? [{
          id: `om_${userId}`,
          userId,
          organizationId,
          status: 'active',
          role: { slug: roles.get(userId) },
        }] : [],
      })),
    },
  } as unknown as WorkOS;
  const app = express();
  app.use(express.json());
  app.use('/api/organizations', createOrganizationsRouter(workos));

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString: process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:5432/adcp_test',
    });
    await runMigrations();
  }, 60_000);

  beforeEach(async () => {
    roles.clear();
    workos.userManagement.listOrganizationMemberships.mockReset();
    workos.userManagement.listOrganizationMemberships.mockImplementation(async ({ userId, organizationId }: {
      userId: string;
      organizationId: string;
    }) => ({
      data: roles.has(userId) ? [{
        id: `om_${userId}`,
        userId,
        organizationId,
        status: 'active',
        role: { slug: roles.get(userId) },
      }] : [],
    }));
    await cleanup();
    for (const [index, userId] of USERS.entries()) {
      await pool.query(
        `INSERT INTO users (workos_user_id, email, first_name, last_name, email_verified,
                            workos_created_at, workos_updated_at, created_at, updated_at)
         VALUES ($1, $2, 'Credential', 'Grant', true, NOW(), NOW(), NOW(), NOW())`,
        [userId, `credential-grant-${index}@example.test`],
      );
    }
    await pool.query(
      `INSERT INTO organizations (workos_organization_id, name, created_at, updated_at)
       VALUES ($1, 'Credential Epoch Route Org', NOW(), NOW())`,
      [ORG_ID],
    );
  });

  afterAll(async () => {
    await cleanup();
    stopAuthTimers();
    await closeDatabase();
  });

  async function cleanup() {
    if (!pool) return;
    await pool.query('DELETE FROM registry_audit_log WHERE workos_organization_id = $1', [ORG_ID]);
    await pool.query('DELETE FROM aao_admin_access_events WHERE target_user_id = $1', [ABSENT_TARGET]);
    await pool.query(
      `DELETE FROM working_group_memberships
        WHERE workos_user_id = $1
          AND working_group_id = (SELECT id FROM working_groups WHERE slug = 'aao-admin')`,
      [ABSENT_TARGET],
    );
    await pool.query('DELETE FROM organization_credential_grants WHERE workos_organization_id = $1', [ORG_ID]);
    await pool.query('DELETE FROM users WHERE workos_user_id = ANY($1)', [USERS]);
    await pool.query('DELETE FROM organizations WHERE workos_organization_id = $1', [ORG_ID]);
  }

  function asCredential(credential: string, canonical = credential) {
    return {
      'x-test-authenticated-credential': credential,
      'x-test-canonical-user': canonical,
    };
  }

  it('transactionally bumps only the target epoch on grant and revoke', async () => {
    roles.set(ACTOR, 'admin');
    const created = await request(app)
      .post(`/api/organizations/${ORG_ID}/credential-grants`)
      .set(asCredential(ACTOR))
      .send({ workos_user_id: TARGET, role: 'member', reason: 'Temporary access' });
    expect(created.status).toBe(201);

    const grantedEpochs = await pool.query(
      'SELECT workos_user_id, epoch::text FROM authorization_epochs WHERE workos_user_id = ANY($1)',
      [USERS],
    );
    expect(grantedEpochs.rows).toEqual(expect.arrayContaining([
      { workos_user_id: ACTOR, epoch: '0' },
      { workos_user_id: TARGET, epoch: '1' },
    ]));
    expect(grantedEpochs.rows).toHaveLength(2);

    const revoked = await request(app)
      .delete(`/api/organizations/${ORG_ID}/credential-grants/${created.body.grant_id}`)
      .set(asCredential(ACTOR));
    expect(revoked.status).toBe(200);
    await expect(pool.query(
      'SELECT epoch::text FROM authorization_epochs WHERE workos_user_id = $1',
      [TARGET],
    )).resolves.toMatchObject({ rows: [{ epoch: '2' }] });
  });

  it.each([
    ['rejects canonical-only privilege', 'admin', undefined, 403],
    ['preserves exact authenticated privilege', 'member', 'admin', 201],
  ] as const)('%s', async (_label, canonicalRole, credentialRole, status) => {
    roles.set(CANONICAL, canonicalRole);
    if (credentialRole) roles.set(ACTOR, credentialRole);

    const response = await request(app)
      .post(`/api/organizations/${ORG_ID}/credential-grants`)
      .set(asCredential(ACTOR, CANONICAL))
      .send({ workos_user_id: TARGET, role: 'member' });

    expect(response.status).toBe(status);
    expect(workos.userManagement.listOrganizationMemberships).toHaveBeenCalledWith(
      expect.objectContaining({ userId: ACTOR, organizationId: ORG_ID }),
    );
  });

  it('does not reuse grant authority across requests after revocation or expiry', async () => {
    roles.set(ACTOR, 'owner');
    const created = await request(app)
      .post(`/api/organizations/${ORG_ID}/credential-grants`)
      .set(asCredential(ACTOR))
      .send({ workos_user_id: TARGET, role: 'admin' });
    expect(created.status).toBe(201);

    const authorizedNextRequest = await request(app)
      .post(`/api/organizations/${ORG_ID}/credential-grants`)
      .set(asCredential(TARGET))
      .send({ workos_user_id: NEXT_TARGET, role: 'member' });
    expect(authorizedNextRequest.status).toBe(201);

    const revoked = await request(app)
      .delete(`/api/organizations/${ORG_ID}/credential-grants/${created.body.grant_id}`)
      .set(asCredential(ACTOR));
    expect(revoked.status).toBe(200);
    await pool.query(
      `UPDATE organization_credential_grants SET revoked_at = NOW(), revoked_by_workos_user_id = $1
        WHERE id = $2`,
      [ACTOR, authorizedNextRequest.body.grant_id],
    );

    const afterRevoke = await request(app)
      .post(`/api/organizations/${ORG_ID}/credential-grants`)
      .set(asCredential(TARGET))
      .send({ workos_user_id: NEXT_TARGET, role: 'member' });
    expect(afterRevoke.status).toBe(403);

    const expiring = await request(app)
      .post(`/api/organizations/${ORG_ID}/credential-grants`)
      .set(asCredential(ACTOR))
      .send({
        workos_user_id: TARGET,
        role: 'admin',
        effective_until: new Date(Date.now() + 60_000).toISOString(),
      });
    expect(expiring.status).toBe(201);
    await pool.query(
      `UPDATE organization_credential_grants
          SET effective_from = NOW() - INTERVAL '2 seconds',
              effective_until = NOW() - INTERVAL '1 second'
        WHERE id = $1`,
      [expiring.body.grant_id],
    );
    const afterExpiry = await request(app)
      .post(`/api/organizations/${ORG_ID}/credential-grants`)
      .set(asCredential(TARGET))
      .send({ workos_user_id: NEXT_TARGET, role: 'member' });
    expect(afterExpiry.status).toBe(403);
  });

  it('records authenticated credential and resolved person identity together', async () => {
    roles.set(ACTOR, 'admin');
    const identity = await pool.query<{ identity_id: string }>(
      'SELECT identity_id FROM identity_workos_users WHERE workos_user_id = $1',
      [ACTOR],
    );
    const created = await request(app)
      .post(`/api/organizations/${ORG_ID}/credential-grants`)
      .set(asCredential(ACTOR, CANONICAL))
      .send({ workos_user_id: TARGET, role: 'member' });
    expect(created.status).toBe(201);

    const audit = await pool.query(
      `SELECT workos_user_id, details FROM registry_audit_log
        WHERE workos_organization_id = $1 AND resource_id = $2`,
      [ORG_ID, created.body.grant_id],
    );
    expect(audit.rows[0]).toMatchObject({
      workos_user_id: ACTOR,
      details: {
        authenticated_credential_id: ACTOR,
        resolved_identity_id: identity.rows[0].identity_id,
        canonical_user_id: CANONICAL,
        target_credential_id: TARGET,
      },
    });

    const revoked = await request(app)
      .delete(`/api/organizations/${ORG_ID}/credential-grants/${created.body.grant_id}`)
      .set(asCredential(ACTOR, CANONICAL));
    expect(revoked.status).toBe(200);
    const revokeAudit = await pool.query(
      `SELECT workos_user_id, details FROM registry_audit_log
        WHERE workos_organization_id = $1
          AND resource_id = $2
          AND action = 'credential_grant_revoked'`,
      [ORG_ID, created.body.grant_id],
    );
    expect(revokeAudit.rows[0]).toMatchObject({
      workos_user_id: ACTOR,
      details: {
        authenticated_credential_id: ACTOR,
        resolved_identity_id: identity.rows[0].identity_id,
        canonical_user_id: CANONICAL,
        target_credential_id: TARGET,
      },
    });
  });

  it('serializes a local actor-grant revocation against the transactional authority recheck', async () => {
    roles.set(ACTOR, 'owner');
    const actorGrant = await request(app)
      .post(`/api/organizations/${ORG_ID}/credential-grants`)
      .set(asCredential(ACTOR))
      .send({ workos_user_id: TARGET, role: 'admin' });
    expect(actorGrant.status).toBe(201);

    let targetLookupCount = 0;
    let signalRecheck!: () => void;
    let releaseRecheck!: () => void;
    const recheckStarted = new Promise<void>((resolve) => { signalRecheck = resolve; });
    const recheckRelease = new Promise<void>((resolve) => { releaseRecheck = resolve; });
    workos.userManagement.listOrganizationMemberships.mockImplementation(async ({ userId, organizationId }) => {
      if (userId === TARGET && ++targetLookupCount === 2) {
        signalRecheck();
        await recheckRelease;
      }
      return { data: roles.has(userId) ? [{
        id: `om_${userId}`,
        userId,
        organizationId,
        status: 'active',
        role: { slug: roles.get(userId) },
      }] : [] };
    });

    const pendingGrant = request(app)
      .post(`/api/organizations/${ORG_ID}/credential-grants`)
      .set(asCredential(TARGET))
      .send({ workos_user_id: NEXT_TARGET, role: 'member' })
      .then((response) => response);
    await recheckStarted;

    const revoker = await pool.connect();
    let revocationSettled = false;
    const pendingRevocation = (async () => {
      await revoker.query('BEGIN');
      await revoker.query(
        `UPDATE organization_credential_grants
            SET revoked_at = NOW(), revoked_by_workos_user_id = $1, updated_at = NOW()
          WHERE id = $2`,
        [ACTOR, actorGrant.body.grant_id],
      );
      await revoker.query(
        `INSERT INTO authorization_epochs (workos_user_id, epoch)
         VALUES ($1, 1)
         ON CONFLICT (workos_user_id) DO UPDATE
           SET epoch = authorization_epochs.epoch + 1, updated_at = NOW()`,
        [TARGET],
      );
      await revoker.query('COMMIT');
    })().finally(() => {
      revocationSettled = true;
      revoker.release();
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(revocationSettled).toBe(false);
    releaseRecheck();
    expect((await pendingGrant).status).toBe(201);
    await pendingRevocation;
  });

  it('rejects actor authority that expires after the transaction begins but before its final recheck', async () => {
    roles.set(ACTOR, 'owner');
    const actorGrant = await request(app)
      .post(`/api/organizations/${ORG_ID}/credential-grants`)
      .set(asCredential(ACTOR))
      .send({
        workos_user_id: TARGET,
        role: 'admin',
        effective_until: new Date(Date.now() + 60_000).toISOString(),
      });
    expect(actorGrant.status).toBe(201);

    let targetLookupCount = 0;
    let signalRecheck!: () => void;
    let releaseRecheck!: () => void;
    const recheckStarted = new Promise<void>((resolve) => { signalRecheck = resolve; });
    const recheckRelease = new Promise<void>((resolve) => { releaseRecheck = resolve; });
    workos.userManagement.listOrganizationMemberships.mockImplementation(async ({ userId }) => {
      if (userId === TARGET && ++targetLookupCount === 2) {
        signalRecheck();
        await recheckRelease;
      }
      return { data: [] };
    });

    const pendingGrant = request(app)
      .post(`/api/organizations/${ORG_ID}/credential-grants`)
      .set(asCredential(TARGET))
      .send({ workos_user_id: NEXT_TARGET, role: 'member' })
      .then((response) => response);
    await recheckStarted;

    // The request transaction is already open and blocked in its final WorkOS
    // recheck. Move expiry past wall-clock now; transaction-stable NOW() would
    // still see the grant as valid at BEGIN.
    await pool.query(
      `UPDATE organization_credential_grants
          SET effective_until = clock_timestamp() - INTERVAL '1 millisecond'
        WHERE id = $1`,
      [actorGrant.body.grant_id],
    );
    releaseRecheck();

    expect((await pendingGrant).status).toBe(403);
    const inserted = await pool.query(
      `SELECT 1 FROM organization_credential_grants
        WHERE workos_organization_id = $1 AND workos_user_id = $2 AND revoked_at IS NULL`,
      [ORG_ID, NEXT_TARGET],
    );
    expect(inserted.rowCount).toBe(0);
  });

  it('rolls back an AAO-admin grant for a nonexistent exact credential', async () => {
    const workingGroupDb = new WorkingGroupDatabase();
    await expect(workingGroupDb.grantAAOAdminMembership({
      targetUserId: ABSENT_TARGET,
      actorUserId: ACTOR,
      actorAuthorizationMechanism: 'static_admin_api_key',
      reason: 'Must not create phantom authority',
    })).rejects.toThrow('AAO admin target credential not found');

    await expect(pool.query(
      `SELECT 1 FROM working_group_memberships
        WHERE workos_user_id = $1`,
      [ABSENT_TARGET],
    )).resolves.toMatchObject({ rowCount: 0 });
    await expect(pool.query(
      'SELECT 1 FROM authorization_epochs WHERE workos_user_id = $1',
      [ABSENT_TARGET],
    )).resolves.toMatchObject({ rowCount: 0 });
    await expect(pool.query(
      'SELECT 1 FROM aao_admin_access_events WHERE target_user_id = $1',
      [ABSENT_TARGET],
    )).resolves.toMatchObject({ rowCount: 0 });
  });
});
