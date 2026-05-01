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

vi.mock('../../src/middleware/auth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/middleware/auth.js')>()),
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = {
      id: 'user_test_admin_link',
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

const HOST_USER_ID = 'user_test_link_host';
const TARGET_USER_ID = 'user_test_link_target';

describe('admin link / unlink credential', () => {
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
    mockGetUser.mockReset();
    await pool.query(
      `INSERT INTO users (workos_user_id, email, first_name, last_name, email_verified,
                          workos_created_at, workos_updated_at, created_at, updated_at)
       VALUES ($1, 'host@test.example', 'Host', 'User', true, NOW(), NOW(), NOW(), NOW())`,
      [HOST_USER_ID]
    );
  });

  async function cleanup() {
    await pool.query(`DELETE FROM users WHERE workos_user_id IN ($1, $2)`, [HOST_USER_ID, TARGET_USER_ID]);
  }

  describe('POST /credentials (bind existing)', () => {
    it('binds an existing WorkOS user (already in local users) under host\'s identity', async () => {
      // Insert the target locally so the trigger creates its singleton identity
      await pool.query(
        `INSERT INTO users (workos_user_id, email, first_name, last_name, email_verified,
                            workos_created_at, workos_updated_at, created_at, updated_at)
         VALUES ($1, 'target@test.example', 'Target', 'User', true, NOW(), NOW(), NOW(), NOW())`,
        [TARGET_USER_ID]
      );

      const response = await request(app)
        .post(`/api/admin/users/${HOST_USER_ID}/credentials`)
        .send({ workos_user_id: TARGET_USER_ID })
        .expect(201);

      expect(response.body).toMatchObject({
        linked: true,
        existing_user_id: HOST_USER_ID,
        bound_workos_user_id: TARGET_USER_ID,
      });

      // Both bound to one identity; target is non-primary.
      const result = await pool.query(
        `SELECT iwu.workos_user_id, iwu.is_primary, iwu.identity_id
           FROM identity_workos_users iwu
          WHERE iwu.workos_user_id IN ($1, $2)
          ORDER BY iwu.is_primary DESC`,
        [HOST_USER_ID, TARGET_USER_ID]
      );
      expect(result.rows).toHaveLength(2);
      expect(result.rows[0].workos_user_id).toBe(HOST_USER_ID);
      expect(result.rows[0].is_primary).toBe(true);
      expect(result.rows[1].workos_user_id).toBe(TARGET_USER_ID);
      expect(result.rows[1].is_primary).toBe(false);
      expect(result.rows[0].identity_id).toBe(result.rows[1].identity_id);
    });

    it('fetches the WorkOS user and upserts when not in local users yet', async () => {
      mockGetUser.mockResolvedValueOnce({
        id: TARGET_USER_ID,
        email: 'fetched@test.example',
        firstName: 'Fetched',
        lastName: 'User',
        emailVerified: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      await request(app)
        .post(`/api/admin/users/${HOST_USER_ID}/credentials`)
        .send({ workos_user_id: TARGET_USER_ID })
        .expect(201);

      expect(mockGetUser).toHaveBeenCalledWith(TARGET_USER_ID);

      const local = await pool.query(`SELECT email FROM users WHERE workos_user_id = $1`, [TARGET_USER_ID]);
      expect(local.rows[0].email).toBe('fetched@test.example');
    });

    it('400s on missing or malformed workos_user_id', async () => {
      await request(app)
        .post(`/api/admin/users/${HOST_USER_ID}/credentials`)
        .send({})
        .expect(400);

      await request(app)
        .post(`/api/admin/users/${HOST_USER_ID}/credentials`)
        .send({ workos_user_id: 'not-a-workos-id' })
        .expect(400);
    });

    it('400s on self-bind', async () => {
      await request(app)
        .post(`/api/admin/users/${HOST_USER_ID}/credentials`)
        .send({ workos_user_id: HOST_USER_ID })
        .expect(400);
    });

    it('idempotent: returns linked: true with no change when already bound', async () => {
      await pool.query(
        `INSERT INTO users (workos_user_id, email, first_name, last_name, email_verified,
                            workos_created_at, workos_updated_at, created_at, updated_at)
         VALUES ($1, 'target@test.example', 'Target', 'User', true, NOW(), NOW(), NOW(), NOW())`,
        [TARGET_USER_ID]
      );
      await request(app)
        .post(`/api/admin/users/${HOST_USER_ID}/credentials`)
        .send({ workos_user_id: TARGET_USER_ID })
        .expect(201);

      // Second call is a no-op.
      const response = await request(app)
        .post(`/api/admin/users/${HOST_USER_ID}/credentials`)
        .send({ workos_user_id: TARGET_USER_ID })
        .expect(200);
      expect(response.body.linked).toBe(true);
    });

    it('404s when host user does not exist', async () => {
      await request(app)
        .post(`/api/admin/users/user_does_not_exist/credentials`)
        .send({ workos_user_id: TARGET_USER_ID })
        .expect(404);
    });

    it('404s when WorkOS getUser returns 404 for the credential id', async () => {
      const err: any = new Error('Not found');
      err.status = 404;
      mockGetUser.mockRejectedValueOnce(err);

      const response = await request(app)
        .post(`/api/admin/users/${HOST_USER_ID}/credentials`)
        .send({ workos_user_id: TARGET_USER_ID })
        .expect(404);
      expect(response.body.error).toMatch(/not found/i);
    });
  });

  describe('GET /credentials', () => {
    it('lists bound credentials for the host\'s identity', async () => {
      await pool.query(
        `INSERT INTO users (workos_user_id, email, first_name, last_name, email_verified,
                            workos_created_at, workos_updated_at, created_at, updated_at)
         VALUES ($1, 'target@test.example', 'Target', 'User', true, NOW(), NOW(), NOW(), NOW())`,
        [TARGET_USER_ID]
      );
      await request(app)
        .post(`/api/admin/users/${HOST_USER_ID}/credentials`)
        .send({ workos_user_id: TARGET_USER_ID })
        .expect(201);

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
      await request(app)
        .post(`/api/admin/users/${HOST_USER_ID}/credentials`)
        .send({ workos_user_id: TARGET_USER_ID })
        .expect(201);
    });

    it('unbinds a non-primary credential and gives it a fresh singleton identity', async () => {
      const beforeIdentity = await pool.query<{ identity_id: string }>(
        `SELECT identity_id FROM identity_workos_users WHERE workos_user_id = $1`,
        [HOST_USER_ID]
      );
      const hostIdentity = beforeIdentity.rows[0].identity_id;

      const response = await request(app)
        .delete(`/api/admin/users/${HOST_USER_ID}/credentials/${TARGET_USER_ID}`)
        .expect(200);
      expect(response.body.removed).toBe(true);

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
