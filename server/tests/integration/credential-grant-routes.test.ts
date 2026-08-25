import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import type { Pool } from 'pg';
import type { WorkOS } from '@workos-inc/node';
import { initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';

vi.mock('../../src/middleware/auth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/middleware/auth.js')>();
  return {
    ...actual,
    requireAuth: (req: Request, _res: Response, next: NextFunction) => {
      const authenticatedCredentialId = req.header('x-test-authenticated-credential')!;
      req.user = {
        id: req.header('x-test-canonical-user') || authenticatedCredentialId,
        authWorkosUserId: authenticatedCredentialId,
        email: `${authenticatedCredentialId}@example.test`,
        emailVerified: true,
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      };
      next();
    },
  };
});

const { createOrganizationsRouter } = await import('../../src/routes/organizations.js');
const { attachStateEmptyCredential } = await import('../../src/db/user-merge-db.js');
const { stopAuthTimers } = await import('../../src/middleware/auth.js');

const ORG_ID = 'org_credential_grant_routes';
const ACTOR = 'user_credential_grant_actor';
const CANONICAL = 'user_credential_grant_canonical';
const TARGET = 'user_credential_grant_target';
const USERS = [ACTOR, CANONICAL, TARGET];

describe('credential grant routes', () => {
  let pool: Pool;
  const roleSequences = new Map<string, Array<'member' | 'admin' | 'owner' | null>>();
  const stableRoles = new Map<string, 'member' | 'admin' | 'owner'>();
  const workos = {
    userManagement: {
      listOrganizationMemberships: vi.fn(async ({ userId, organizationId }: {
        userId: string;
        organizationId: string;
      }) => {
        const sequence = roleSequences.get(userId);
        const role = sequence?.length ? sequence.shift() : stableRoles.get(userId) ?? null;
        return {
          data: role ? [{
            id: `om_${userId}`,
            userId,
            organizationId,
            status: 'active',
            role: { slug: role },
          }] : [],
        };
      }),
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
  }, 60000);

  beforeEach(async () => {
    stableRoles.clear();
    roleSequences.clear();
    workos.userManagement.listOrganizationMemberships.mockClear();
    await cleanup();
    await pool.query(
      `INSERT INTO users (workos_user_id, email, first_name, last_name, email_verified,
                          workos_created_at, workos_updated_at, created_at, updated_at)
       VALUES ($1, 'grant-actor@example.test', 'Grant', 'Actor', true, NOW(), NOW(), NOW(), NOW()),
              ($2, 'grant-canonical@example.test', 'Grant', 'Canonical', true, NOW(), NOW(), NOW(), NOW()),
              ($3, 'grant-target@example.test', 'Grant', 'Target', true, NOW(), NOW(), NOW(), NOW())`,
      USERS,
    );
    await pool.query(
      `INSERT INTO organizations (workos_organization_id, name, created_at, updated_at)
       VALUES ($1, 'Credential Grant Route Org', NOW(), NOW())`,
      [ORG_ID],
    );
  });

  afterAll(async () => {
    await cleanup();
    stopAuthTimers();
    await closeDatabase();
  });

  async function cleanup(): Promise<void> {
    if (!pool) return;
    await pool.query(`DELETE FROM organization_credential_grants WHERE workos_organization_id = $1`, [ORG_ID]);
    await pool.query(`DELETE FROM registry_audit_log WHERE workos_organization_id = $1`, [ORG_ID]);
    await pool.query(`DELETE FROM users WHERE workos_user_id = ANY($1)`, [USERS]);
    await pool.query(`DELETE FROM organizations WHERE workos_organization_id = $1`, [ORG_ID]);
  }

  function asCredential(authenticated: string, canonical = authenticated) {
    return {
      'x-test-authenticated-credential': authenticated,
      'x-test-canonical-user': canonical,
    };
  }

  it('creates, deduplicates, revokes, and recreates an exact-credential grant', async () => {
    stableRoles.set(ACTOR, 'admin');
    const payload = { workos_user_id: TARGET, role: 'member', reason: 'route test' };

    const created = await request(app)
      .post(`/api/organizations/${ORG_ID}/credential-grants`)
      .set(asCredential(ACTOR))
      .send(payload);
    expect(created.status).toBe(201);

    const duplicate = await request(app)
      .post(`/api/organizations/${ORG_ID}/credential-grants`)
      .set(asCredential(ACTOR))
      .send(payload);
    expect(duplicate.status).toBe(409);

    const revoked = await request(app)
      .delete(`/api/organizations/${ORG_ID}/credential-grants/${created.body.grant_id}`)
      .set(asCredential(ACTOR));
    expect(revoked.status).toBe(200);

    const stored = await pool.query(
      `SELECT granted_by_workos_user_id, revoked_by_workos_user_id, revoked_at
         FROM organization_credential_grants WHERE id = $1`,
      [created.body.grant_id],
    );
    expect(stored.rows[0]).toMatchObject({
      granted_by_workos_user_id: ACTOR,
      revoked_by_workos_user_id: ACTOR,
    });
    expect(stored.rows[0].revoked_at).toBeTruthy();

    const recreated = await request(app)
      .post(`/api/organizations/${ORG_ID}/credential-grants`)
      .set(asCredential(ACTOR))
      .send(payload);
    expect(recreated.status).toBe(201);
  });

  it('rejects a linked credential that only the canonical credential could authorize', async () => {
    stableRoles.set(CANONICAL, 'admin');
    await attachStateEmptyCredential(CANONICAL, ACTOR, CANONICAL);

    const response = await request(app)
      .post(`/api/organizations/${ORG_ID}/credential-grants`)
      .set(asCredential(ACTOR, CANONICAL))
      .send({ workos_user_id: TARGET, role: 'member' });

    expect(response.status).toBe(403);
    expect(workos.userManagement.listOrganizationMemberships).toHaveBeenCalledWith(
      expect.objectContaining({ userId: ACTOR, organizationId: ORG_ID }),
    );
  });

  it('fails closed when the exact actor loses its role before commit', async () => {
    roleSequences.set(ACTOR, ['admin', null]);
    const response = await request(app)
      .post(`/api/organizations/${ORG_ID}/credential-grants`)
      .set(asCredential(ACTOR))
      .send({ workos_user_id: TARGET, role: 'member' });

    expect(response.status).toBe(403);
    const grants = await pool.query(
      `SELECT 1 FROM organization_credential_grants WHERE workos_organization_id = $1`,
      [ORG_ID],
    );
    expect(grants.rowCount).toBe(0);
  });

  it('rejects expired grants before authorization or mutation', async () => {
    stableRoles.set(ACTOR, 'admin');
    const response = await request(app)
      .post(`/api/organizations/${ORG_ID}/credential-grants`)
      .set(asCredential(ACTOR))
      .send({
        workos_user_id: TARGET,
        role: 'member',
        effective_until: new Date(Date.now() - 60_000).toISOString(),
      });
    expect(response.status).toBe(400);
    expect(workos.userManagement.listOrganizationMemberships).not.toHaveBeenCalled();
  });
});
