/**
 * Primary-credential promotion remains disabled until every credential-owned
 * row can retain its authority and provenance. These tests protect that gate.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import type { Pool } from 'pg';

vi.hoisted(() => {
  process.env.WORKOS_API_KEY ??= 'sk_test_mock_key';
  process.env.WORKOS_CLIENT_ID ??= 'client_mock_id';
  process.env.WORKOS_COOKIE_PASSWORD ??= 'test-cookie-password-at-least-32-chars-long';
});

vi.mock('../../src/auth/workos-client.js', () => {
  const mockWorkos = { userManagement: { getUser: vi.fn() } };
  return { workos: mockWorkos, getWorkos: () => mockWorkos };
});

vi.mock('../../src/middleware/auth.js', async (importOriginal) => {
  const mockedRequireAuth = (req: any, _res: any, next: any) => {
    req.user = {
      id: 'user_test_admin_promote',
      email: 'admin@test.local',
      emailVerified: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    next();
  };
  const passThrough = (_req: any, _res: any, next: any) => next();
  return {
    ...(await importOriginal<typeof import('../../src/middleware/auth.js')>()),
    requireAuth: mockedRequireAuth,
    requireAdmin: passThrough,
    optionalAuth: passThrough,
    requireGlobalAdmin: [mockedRequireAuth, passThrough, passThrough],
  };
});

vi.mock('../../src/middleware/csrf.js', () => ({
  csrfProtection: (_req: any, _res: any, next: any) => next(),
}));

import { initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { attachStateEmptyCredential } from '../../src/db/user-merge-db.js';
import { HTTPServer } from '../../src/http.js';

const HOST_USER_ID = 'user_test_promote_host';
const TARGET_USER_ID = 'user_test_promote_target';
const HOST_ORG_ID = 'org_test_promote_host';
const TARGET_ORG_ID = 'org_test_promote_target';

describe('admin promote credential gate', () => {
  let server: HTTPServer;
  let app: any;
  let pool: Pool;

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString: process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:5432/adcp_test',
    });
    await runMigrations();
    server = new HTTPServer();
    await server.start(0);
    app = server.app;
  }, 60000);

  afterAll(async () => {
    await cleanup();
    await server?.stop();
    await closeDatabase();
  });

  beforeEach(async () => {
    await cleanup();
    await pool.query(
      `INSERT INTO users (workos_user_id, email, first_name, last_name, email_verified,
                          workos_created_at, workos_updated_at, created_at, updated_at)
       VALUES ($1, 'host@test.example', 'Host', 'User', true, NOW(), NOW(), NOW(), NOW()),
              ($2, 'target@test.example', 'Target', 'User', true, NOW(), NOW(), NOW(), NOW())`,
      [HOST_USER_ID, TARGET_USER_ID],
    );
    await attachStateEmptyCredential(HOST_USER_ID, TARGET_USER_ID, 'user_test_admin_promote');
    await pool.query(
      `INSERT INTO organizations (workos_organization_id, name, created_at, updated_at)
       VALUES ($1, 'Host Org', NOW(), NOW()), ($2, 'Target Org', NOW(), NOW())
       ON CONFLICT (workos_organization_id) DO NOTHING`,
      [HOST_ORG_ID, TARGET_ORG_ID],
    );
    await pool.query(
      `INSERT INTO organization_memberships
         (workos_user_id, workos_organization_id, email, role, created_at, updated_at)
       VALUES ($1, $2, 'host@test.example', 'admin', NOW(), NOW()),
              ($3, $4, 'target@test.example', 'member', NOW(), NOW())`,
      [HOST_USER_ID, HOST_ORG_ID, TARGET_USER_ID, TARGET_ORG_ID],
    );
  });

  async function cleanup() {
    await pool.query(
      `DELETE FROM organization_memberships WHERE workos_organization_id IN ($1, $2)`,
      [HOST_ORG_ID, TARGET_ORG_ID],
    );
    await pool.query(
      `DELETE FROM organizations WHERE workos_organization_id IN ($1, $2)`,
      [HOST_ORG_ID, TARGET_ORG_ID],
    );
    await pool.query(
      `DELETE FROM users WHERE workos_user_id IN ($1, $2)`,
      [HOST_USER_ID, TARGET_USER_ID],
    );
  }

  it('returns 409 and leaves bindings and memberships unchanged', async () => {
    const bindingsBefore = await pool.query(
      `SELECT workos_user_id, identity_id, is_primary
         FROM identity_workos_users
        WHERE workos_user_id IN ($1, $2)
        ORDER BY workos_user_id`,
      [HOST_USER_ID, TARGET_USER_ID],
    );
    const membershipsBefore = await pool.query(
      `SELECT workos_user_id, workos_organization_id, role
         FROM organization_memberships
        WHERE workos_user_id IN ($1, $2)
        ORDER BY workos_user_id`,
      [HOST_USER_ID, TARGET_USER_ID],
    );

    const response = await request(app)
      .post(`/api/admin/users/${HOST_USER_ID}/credentials/${TARGET_USER_ID}/promote`)
      .expect(409);

    expect(response.body.error).toBe('credential_promotion_disabled');
    const bindingsAfter = await pool.query(
      `SELECT workos_user_id, identity_id, is_primary
         FROM identity_workos_users
        WHERE workos_user_id IN ($1, $2)
        ORDER BY workos_user_id`,
      [HOST_USER_ID, TARGET_USER_ID],
    );
    const membershipsAfter = await pool.query(
      `SELECT workos_user_id, workos_organization_id, role
         FROM organization_memberships
        WHERE workos_user_id IN ($1, $2)
        ORDER BY workos_user_id`,
      [HOST_USER_ID, TARGET_USER_ID],
    );
    expect(bindingsAfter.rows).toEqual(bindingsBefore.rows);
    expect(membershipsAfter.rows).toEqual(membershipsBefore.rows);
  });

  it('400s when the credential id equals the host id', async () => {
    const response = await request(app)
      .post(`/api/admin/users/${HOST_USER_ID}/credentials/${HOST_USER_ID}/promote`)
      .expect(400);
    expect(response.body.error).toMatch(/must differ/i);
  });

  it('404s when the credential is not bound to the host identity', async () => {
    await pool.query(`DELETE FROM identity_workos_users WHERE workos_user_id = $1`, [TARGET_USER_ID]);
    const newIdentity = await pool.query<{ id: string }>(`INSERT INTO identities DEFAULT VALUES RETURNING id`);
    await pool.query(
      `INSERT INTO identity_workos_users (workos_user_id, identity_id, is_primary)
       VALUES ($1, $2, TRUE)`,
      [TARGET_USER_ID, newIdentity.rows[0].id],
    );

    await request(app)
      .post(`/api/admin/users/${HOST_USER_ID}/credentials/${TARGET_USER_ID}/promote`)
      .expect(404);
  });
});
