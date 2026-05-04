/**
 * Admin "promote credential to primary" integration test.
 *
 * Exercises POST /api/admin/users/:userId/credentials/:credentialId/promote.
 * The new primary should:
 *   - hold all app-state previously on the old primary (org_memberships, etc.)
 *   - have is_primary = TRUE; the old primary, FALSE
 *   - record an audit row
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
  const mockUserManagement = { getUser: vi.fn(), createUser: vi.fn(), deleteUser: vi.fn() };
  const mockWorkos = { userManagement: mockUserManagement };
  return { workos: mockWorkos, getWorkos: () => mockWorkos };
});

vi.mock('../../src/middleware/auth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/middleware/auth.js')>()),
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = {
      id: 'user_test_admin_promote',
      email: 'admin@test.local',
      emailVerified: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    next();
  },
  requireAdmin: (_req: any, _res: any, next: any) => next(),
  optionalAuth: (_req: any, _res: any, next: any) => next(),
}));

vi.mock('../../src/middleware/csrf.js', () => ({
  csrfProtection: (_req: any, _res: any, next: any) => next(),
}));

import { initializeDatabase, closeDatabase, getPool } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { HTTPServer } from '../../src/http.js';

const HOST_USER_ID = 'user_test_promote_host';
const TARGET_USER_ID = 'user_test_promote_target';
const HOST_ORG_ID = 'org_test_promote_host';
const TARGET_ORG_ID = 'org_test_promote_target';

describe('admin promote credential to primary', () => {
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
    // Insert two users; trigger creates a singleton identity for each
    await pool.query(
      `INSERT INTO users (workos_user_id, email, first_name, last_name, email_verified,
                          workos_created_at, workos_updated_at, created_at, updated_at)
       VALUES ($1, 'host@test.example', 'Host', 'User', true, NOW(), NOW(), NOW(), NOW()),
              ($2, 'target@test.example', 'Target', 'User', true, NOW(), NOW(), NOW(), NOW())`,
      [HOST_USER_ID, TARGET_USER_ID]
    );
    await pool.query(
      `INSERT INTO organizations (workos_organization_id, name, created_at, updated_at)
       VALUES ($1, 'Host Org', NOW(), NOW()),
              ($2, 'Target Org', NOW(), NOW())
       ON CONFLICT (workos_organization_id) DO NOTHING`,
      [HOST_ORG_ID, TARGET_ORG_ID]
    );
  });

  async function cleanup() {
    await pool.query(
      `DELETE FROM organization_memberships WHERE workos_organization_id IN ($1, $2)`,
      [HOST_ORG_ID, TARGET_ORG_ID]
    );
    await pool.query(
      `DELETE FROM organizations WHERE workos_organization_id IN ($1, $2)`,
      [HOST_ORG_ID, TARGET_ORG_ID]
    );
    await pool.query(
      `DELETE FROM users WHERE workos_user_id IN ($1, $2)`,
      [HOST_USER_ID, TARGET_USER_ID]
    );
  }

  /**
   * Replicates the Ahmed shape: a host with one org, a bound target with
   * its own org, target gets promoted to primary; both orgs end up on
   * target's workos_user_id.
   */
  async function setupBoundPair() {
    // Host has Host Org
    await pool.query(
      `INSERT INTO organization_memberships (workos_user_id, workos_organization_id, email, role, created_at, updated_at)
       VALUES ($1, $2, 'host@test.example', 'admin', NOW(), NOW())`,
      [HOST_USER_ID, HOST_ORG_ID]
    );
    // Target has Target Org
    await pool.query(
      `INSERT INTO organization_memberships (workos_user_id, workos_organization_id, email, role, created_at, updated_at)
       VALUES ($1, $2, 'target@test.example', 'admin', NOW(), NOW())`,
      [TARGET_USER_ID, TARGET_ORG_ID]
    );
    // Bind target as non-primary under host's identity (mergeUsers does this);
    // mergeUsers also moves target's data to host, so we set it up by hand
    // post-bind to keep target_org membership on the target's workos_user_id.
    await request(app)
      .post(`/api/admin/users/${HOST_USER_ID}/credentials`)
      .send({ workos_user_id: TARGET_USER_ID, consolidate: true })
      .expect(201);
    // After bind, target_org_membership was moved to HOST_USER_ID. Move it
    // back to TARGET_USER_ID to simulate the post-resync Ahmed state where
    // an org membership lands on the non-primary credential (because WorkOS
    // org_membership webhook routed it to that user_id).
    await pool.query(
      `UPDATE organization_memberships SET workos_user_id = $1
        WHERE workos_organization_id = $2`,
      [TARGET_USER_ID, TARGET_ORG_ID]
    );
  }

  it('promotes the target credential and moves the old primary\'s app-state forward', async () => {
    await setupBoundPair();

    const response = await request(app)
      .post(`/api/admin/users/${HOST_USER_ID}/credentials/${TARGET_USER_ID}/promote`)
      .expect(200);

    expect(response.body).toMatchObject({
      promoted: true,
      previous_primary_id: HOST_USER_ID,
      new_primary_id: TARGET_USER_ID,
    });

    // is_primary swapped
    const bindings = await pool.query<{ workos_user_id: string; is_primary: boolean }>(
      `SELECT workos_user_id, is_primary FROM identity_workos_users
        WHERE workos_user_id IN ($1, $2)
        ORDER BY is_primary DESC`,
      [HOST_USER_ID, TARGET_USER_ID]
    );
    expect(bindings.rows).toHaveLength(2);
    expect(bindings.rows.find(r => r.workos_user_id === TARGET_USER_ID)?.is_primary).toBe(true);
    expect(bindings.rows.find(r => r.workos_user_id === HOST_USER_ID)?.is_primary).toBe(false);

    // Both orgs now on TARGET_USER_ID (host's app-state moved forward;
    // target's stayed since it was already there)
    const memberships = await pool.query<{ workos_user_id: string }>(
      `SELECT workos_user_id FROM organization_memberships
        WHERE workos_organization_id IN ($1, $2)
        ORDER BY workos_organization_id`,
      [HOST_ORG_ID, TARGET_ORG_ID]
    );
    expect(memberships.rows).toHaveLength(2);
    expect(memberships.rows.every(r => r.workos_user_id === TARGET_USER_ID)).toBe(true);
  });

  it('writes a promote_credential_to_primary audit row', async () => {
    await setupBoundPair();
    await request(app)
      .post(`/api/admin/users/${HOST_USER_ID}/credentials/${TARGET_USER_ID}/promote`)
      .expect(200);

    const audit = await pool.query<{ details: any }>(
      `SELECT details FROM registry_audit_log
        WHERE action = 'promote_credential_to_primary' AND resource_id = $1
        ORDER BY created_at DESC LIMIT 1`,
      [TARGET_USER_ID]
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].details).toMatchObject({
      previous_primary_id: HOST_USER_ID,
      new_primary_id: TARGET_USER_ID,
    });
  });

  it('is idempotent: promoting an already-primary credential returns 200 with no change', async () => {
    // Promote target so it's the primary
    await setupBoundPair();
    await request(app)
      .post(`/api/admin/users/${HOST_USER_ID}/credentials/${TARGET_USER_ID}/promote`)
      .expect(200);

    // Calling again on the same credential should be a no-op
    const response = await request(app)
      .post(`/api/admin/users/${HOST_USER_ID}/credentials/${TARGET_USER_ID}/promote`)
      .expect(200);
    expect(response.body.promoted).toBe(true);
    expect(response.body.message).toMatch(/already primary/i);

    // Bindings unchanged
    const bindings = await pool.query<{ workos_user_id: string; is_primary: boolean }>(
      `SELECT workos_user_id, is_primary FROM identity_workos_users
        WHERE workos_user_id IN ($1, $2)`,
      [HOST_USER_ID, TARGET_USER_ID]
    );
    expect(bindings.rows.find(r => r.workos_user_id === TARGET_USER_ID)?.is_primary).toBe(true);
  });

  it('400s when the credentialId in the URL matches the host id', async () => {
    const response = await request(app)
      .post(`/api/admin/users/${HOST_USER_ID}/credentials/${HOST_USER_ID}/promote`)
      .expect(400);
    expect(response.body.error).toMatch(/must differ/i);
  });

  it('404s when the credential is not bound to the host\'s identity', async () => {
    // Target is its own singleton identity, not bound to host
    const response = await request(app)
      .post(`/api/admin/users/${HOST_USER_ID}/credentials/${TARGET_USER_ID}/promote`)
      .expect(404);
    expect(response.body.error).toMatch(/not bound/i);
  });

  it('repairs an orphan-no-primary state by setting the target as primary directly', async () => {
    await setupBoundPair();
    // Manually break the primary so the identity has no current primary
    await pool.query(
      `UPDATE identity_workos_users SET is_primary = FALSE WHERE workos_user_id = $1`,
      [HOST_USER_ID]
    );

    const response = await request(app)
      .post(`/api/admin/users/${HOST_USER_ID}/credentials/${TARGET_USER_ID}/promote`)
      .expect(200);
    expect(response.body.message).toMatch(/no current primary|invariant repaired/i);

    const bindings = await pool.query<{ workos_user_id: string; is_primary: boolean }>(
      `SELECT workos_user_id, is_primary FROM identity_workos_users
        WHERE workos_user_id IN ($1, $2)`,
      [HOST_USER_ID, TARGET_USER_ID]
    );
    expect(bindings.rows.find(r => r.workos_user_id === TARGET_USER_ID)?.is_primary).toBe(true);
  });
});
