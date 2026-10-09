/**
 * Admin link-existing + unlink credential integration tests.
 *
 *   - GET    /api/admin/users/:userId/credentials       — list bindings
 *   - POST   /api/admin/users/:userId/credentials        — bind by workos_user_id
 *   - DELETE /api/admin/users/:userId/credentials/:credId — unbind (creates fresh
 *                                                         singleton identity for
 *                                                         the detached credential)
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import type { Pool } from 'pg';

vi.hoisted(() => {
  process.env.WORKOS_API_KEY ??= 'sk_test_mock_key';
  process.env.WORKOS_CLIENT_ID ??= 'client_mock_id';
  process.env.WORKOS_COOKIE_PASSWORD ??= 'test-cookie-password-at-least-32-chars-long';
});

const { mockGetUser } = vi.hoisted(() => ({ mockGetUser: vi.fn() }));

vi.mock('../../src/auth/workos-client.js', () => {
  const mockUserManagement = { getUser: mockGetUser };
  const mockWorkos = { userManagement: mockUserManagement };
  return { workos: mockWorkos, getWorkos: () => mockWorkos };
});

vi.mock('../../src/middleware/auth.js', async (importOriginal) => {
  const mockedRequireAuth = (req: any, _res: any, next: any) => {
    req.adminAccessMechanism = req.headers['x-test-admin-access-mechanism'] || undefined;
    req.user = {
      id: 'user_test_admin_link',
      authWorkosUserId: 'user_test_admin_link_credential',
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
    // The exported `requireGlobalAdmin` array snapshots its element
    // references at module-load time, so the per-export mocks above
    // don't propagate. Re-build the array here so admin/users routes
    // (`...requireGlobalAdmin`) reach the mocked handlers.
    requireGlobalAdmin: [mockedRequireAuth, passThrough, passThrough],
  };
});

vi.mock('../../src/middleware/csrf.js', () => ({
  csrfProtection: (_req: any, _res: any, next: any) => next(),
}));

import { initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import express from 'express';
import { createAdminUsersRouter } from '../../src/routes/admin/users.js';
import { stopAuthTimers } from '../../src/middleware/auth.js';

const HOST_USER_ID = 'user_test_link_host';
const TARGET_USER_ID = 'user_test_link_target';
const AUTHORITY_ORG_ID = 'org_test_unlink_authority';

describe('admin link / unlink credential', () => {
  let app: any;
  let pool: Pool;

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString: process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:5432/adcp_test',
    });
    await runMigrations();
    app = express();
    app.use(express.json());
    app.use('/api/admin/users', createAdminUsersRouter());
  }, 60000);

  afterAll(async () => {
    await cleanup();
    stopAuthTimers();
    await closeDatabase();
  });

  beforeEach(async () => {
    await cleanup();
    mockGetUser.mockReset();
    await pool.query(
      `INSERT INTO users (workos_user_id, email, first_name, last_name, email_verified,
                          workos_created_at, workos_updated_at, created_at, updated_at)
       VALUES ($1, 'host@test.example', 'Host', 'User', true, NOW(), NOW(), NOW(), NOW())`,
      [HOST_USER_ID]
    );
  });

  async function cleanup() {
    await pool.query(`DELETE FROM organization_memberships WHERE workos_organization_id = $1`, [AUTHORITY_ORG_ID]);
    await pool.query(`DELETE FROM organizations WHERE workos_organization_id = $1`, [AUTHORITY_ORG_ID]);
    await pool.query(`DELETE FROM users WHERE workos_user_id IN ($1, $2)`, [HOST_USER_ID, TARGET_USER_ID]);
  }

  describe('POST /credentials containment', () => {
    it.each([false, true])('refuses existing-account consolidation even with consolidate=%s', async (consolidate) => {
      await pool.query(
        `INSERT INTO users (workos_user_id, email, first_name, last_name, email_verified,
                            workos_created_at, workos_updated_at, created_at, updated_at)
         VALUES ($1, 'target@test.example', 'Target', 'User', true, NOW(), NOW(), NOW(), NOW())`,
        [TARGET_USER_ID],
      );
      const before = await pool.query(
        `SELECT * FROM identity_workos_users WHERE workos_user_id IN ($1, $2) ORDER BY workos_user_id`,
        [HOST_USER_ID, TARGET_USER_ID],
      );
      for (const accessMechanism of ['sso', 'static_admin_api_key']) {
        await request(app)
          .post(`/api/admin/users/${HOST_USER_ID}/credentials`)
          .set('X-Test-Admin-Access-Mechanism', accessMechanism)
          .send({ workos_user_id: TARGET_USER_ID, consolidate })
          .expect(409)
          .expect(({ body }) => expect(body.error).toBe('identity_mutation_disabled'));
      }
      expect((await pool.query(
        `SELECT * FROM identity_workos_users WHERE workos_user_id IN ($1, $2) ORDER BY workos_user_id`,
        [HOST_USER_ID, TARGET_USER_ID],
      )).rows).toEqual(before.rows);
      expect(mockGetUser).not.toHaveBeenCalled();
    });

    it('refuses before fetching or upserting a missing WorkOS credential', async () => {
      await request(app)
        .post(`/api/admin/users/${HOST_USER_ID}/credentials`)
        .send({ workos_user_id: TARGET_USER_ID, consolidate: true })
        .expect(409)
        .expect(({ body }) => expect(body.error).toBe('identity_mutation_disabled'));
      expect(mockGetUser).not.toHaveBeenCalled();
      expect((await pool.query(`SELECT 1 FROM users WHERE workos_user_id = $1`, [TARGET_USER_ID])).rows).toEqual([]);
    });
  });

  // Fixtures model existing bindings; the now-disabled merge route must never
  // be used to prepare read-only listing or binding-only revocation tests.
  async function bindExistingFixture() {
    await pool.query(
      `UPDATE identity_workos_users SET identity_id = (
         SELECT identity_id FROM identity_workos_users WHERE workos_user_id = $1
       ), is_primary = FALSE WHERE workos_user_id = $2`,
      [HOST_USER_ID, TARGET_USER_ID],
    );
  }

  describe('GET /credentials', () => {
    it('lists bound credentials for the host\'s identity', async () => {
      await pool.query(
        `INSERT INTO users (workos_user_id, email, first_name, last_name, email_verified,
                            workos_created_at, workos_updated_at, created_at, updated_at)
         VALUES ($1, 'target@test.example', 'Target', 'User', true, NOW(), NOW(), NOW(), NOW())`,
        [TARGET_USER_ID]
      );
      await bindExistingFixture();

      const response = await request(app)
        .get(`/api/admin/users/${HOST_USER_ID}/credentials`)
        .expect(200);

      expect(response.body.identity_id).toBeTruthy();
      expect(response.body.credentials).toHaveLength(2);
      const primary = response.body.credentials.find((c: any) => c.is_primary);
      const secondary = response.body.credentials.find((c: any) => !c.is_primary);
      expect(primary.workos_user_id).toBe(HOST_USER_ID);
      expect(primary.email).toBe('host@test.example');
      expect(secondary.workos_user_id).toBe(TARGET_USER_ID);
      expect(secondary.email).toBe('target@test.example');
    });

    it('404s when host user does not exist', async () => {
      await request(app)
        .get(`/api/admin/users/user_does_not_exist/credentials`)
        .expect(404);
    });
  });

  describe('DELETE /credentials/:credentialId', () => {
    beforeEach(async () => {
      await pool.query(
        `INSERT INTO users (workos_user_id, email, first_name, last_name, email_verified,
                            workos_created_at, workos_updated_at, created_at, updated_at)
         VALUES ($1, 'target@test.example', 'Target', 'User', true, NOW(), NOW(), NOW(), NOW())`,
        [TARGET_USER_ID]
      );
      await bindExistingFixture();
    });

    it("unbinds a non-primary credential without moving either credential's organization authority", async () => {
      await pool.query(
        `INSERT INTO organizations (workos_organization_id, name) VALUES ($1, 'Unlink authority fixture')`,
        [AUTHORITY_ORG_ID],
      );
      await pool.query(
        `INSERT INTO organization_memberships (workos_user_id, workos_organization_id, email, role)
         VALUES ($1, $3, 'host@test.example', 'admin'), ($2, $3, 'target@test.example', 'member')`,
        [HOST_USER_ID, TARGET_USER_ID, AUTHORITY_ORG_ID],
      );
      const authorityBefore = await pool.query(
        `SELECT * FROM organization_memberships WHERE workos_organization_id = $1 ORDER BY workos_user_id`,
        [AUTHORITY_ORG_ID],
      );
      const beforeIdentity = await pool.query<{ identity_id: string }>(
        `SELECT identity_id FROM identity_workos_users WHERE workos_user_id = $1`,
        [HOST_USER_ID]
      );
      const hostIdentity = beforeIdentity.rows[0].identity_id;

      const response = await request(app)
        .delete(`/api/admin/users/${HOST_USER_ID}/credentials/${TARGET_USER_ID}`)
        .expect(200);
      expect(response.body.removed).toBe(true);
      expect((await pool.query(
        `SELECT * FROM organization_memberships WHERE workos_organization_id = $1 ORDER BY workos_user_id`,
        [AUTHORITY_ORG_ID],
      )).rows).toEqual(authorityBefore.rows);

      const after = await pool.query<{ identity_id: string; is_primary: boolean }>(
        `SELECT identity_id, is_primary FROM identity_workos_users WHERE workos_user_id = $1`,
        [TARGET_USER_ID]
      );
      expect(after.rows).toHaveLength(1);
      expect(after.rows[0].identity_id).not.toBe(hostIdentity);
      expect(after.rows[0].is_primary).toBe(true);

      // Audit row recorded.
      const audit = await pool.query<{ details: any }>(
        `SELECT details FROM registry_audit_log
          WHERE action = 'unbind_credential' AND resource_id = $1
          ORDER BY created_at DESC LIMIT 1`,
        [TARGET_USER_ID]
      );
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0].details.host_user_id).toBe(HOST_USER_ID);
    });

    it('refuses to remove the primary credential', async () => {
      const response = await request(app)
        .delete(`/api/admin/users/${HOST_USER_ID}/credentials/${HOST_USER_ID}`)
        .expect(400); // self-id check fires before the primary check
      expect(response.body.error).toMatch(/canonical user/i);
    });

    it('refuses to remove a credential that primary-bound on another identity\'s scope', async () => {
      // Set TARGET's binding to is_primary = TRUE inside HOST's identity (corrupt
      // state, but verifies the guard) — easier: try to unbind via wrong host id.
      const otherUserId = 'user_test_link_other';
      await pool.query(
        `INSERT INTO users (workos_user_id, email, first_name, last_name, email_verified,
                            workos_created_at, workos_updated_at, created_at, updated_at)
         VALUES ($1, 'other@test.example', 'Other', 'User', true, NOW(), NOW(), NOW(), NOW())`,
        [otherUserId]
      );
      try {
        const response = await request(app)
          .delete(`/api/admin/users/${otherUserId}/credentials/${TARGET_USER_ID}`)
          .expect(404);
        expect(response.body.error).toMatch(/not bound/i);
      } finally {
        await pool.query(`DELETE FROM users WHERE workos_user_id = $1`, [otherUserId]);
      }
    });

    it('404s when the credential is not bound to this host', async () => {
      // Unbind first
      await request(app)
        .delete(`/api/admin/users/${HOST_USER_ID}/credentials/${TARGET_USER_ID}`)
        .expect(200);

      // Second call should 404 — credential is no longer bound here
      const response = await request(app)
        .delete(`/api/admin/users/${HOST_USER_ID}/credentials/${TARGET_USER_ID}`)
        .expect(404);
      expect(response.body.error).toMatch(/not bound/i);
    });
  });
});
