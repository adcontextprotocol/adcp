/**
 * Admin "create + bind sign-in email" integration test (Phase 2b).
 *
 * Exercises POST /api/admin/users/:userId/linked-emails:
 *   - Creates a fresh WorkOS user for the new email (mocked).
 *   - Inserts into local users (trigger fires, creating a singleton identity).
 *   - mergeUsers re-points the new user's binding to the existing user's
 *     identity as is_primary = FALSE; drops the orphan singleton.
 *
 * After this, the existing user has two bound WorkOS users; the auth
 * middleware will id-swap a non-primary login to the canonical id.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

// WorkOS client is instantiated at module load in middleware/auth.ts.
// vi.mock and module imports both hoist above non-`vi.hoisted` statements,
// so env-var setup must use vi.hoisted to land before either runs.
vi.hoisted(() => {
  process.env.WORKOS_API_KEY ??= 'sk_test_mock_key';
  process.env.WORKOS_CLIENT_ID ??= 'client_mock_id';
  process.env.WORKOS_COOKIE_PASSWORD ??= 'test-cookie-password-at-least-32-chars-long';
});
import request from 'supertest';
import { initializeDatabase, closeDatabase, getPool } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import type { Pool } from 'pg';

// Mock auth middleware: synthetic admin user. Use importOriginal so that
// helpers like createRequireWorkingGroupLeader (used by other mounted
// routers) are still available — env vars are set via vi.hoisted above
// so the WorkOS constructor at module load doesn't blow up.
vi.mock('../../src/middleware/auth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/middleware/auth.js')>()),
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = {
      id: 'user_test_admin_bind',
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

const MOCK_NEW_WORKOS_USER_ID = 'user_test_bind_NEW_FROM_WORKOS';

// Hoist the mock fns so the vi.mock factory (also hoisted) can reference them.
const { mockCreateUser, mockDeleteUser } = vi.hoisted(() => ({
  mockCreateUser: vi.fn(),
  mockDeleteUser: vi.fn(),
}));

vi.mock('../../src/auth/workos-client.js', () => {
  const mockUserManagement = {
    createUser: mockCreateUser,
    deleteUser: mockDeleteUser,
  };
  const mockWorkos = { userManagement: mockUserManagement };
  return {
    workos: mockWorkos,
    getWorkos: () => mockWorkos,
  };
});

import { HTTPServer } from '../../src/http.js';

const EXISTING_USER_ID = 'user_test_bind_existing';

describe('POST /api/admin/users/:userId/linked-emails (admin bind)', () => {
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
       VALUES ($1, 'existing@test.example', 'Existing', 'User', true, NOW(), NOW(), NOW(), NOW())`,
      [EXISTING_USER_ID]
    );
    mockCreateUser.mockReset();
    mockDeleteUser.mockReset();
    mockCreateUser.mockImplementation(async ({ email, firstName, lastName }: any) => ({
      id: MOCK_NEW_WORKOS_USER_ID,
      email,
      firstName: firstName ?? null,
      lastName: lastName ?? null,
      emailVerified: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));
    mockDeleteUser.mockResolvedValue(undefined);
  });

  async function cleanup() {
    await pool.query(`DELETE FROM users WHERE workos_user_id IN ($1, $2)`, [
      EXISTING_USER_ID,
      MOCK_NEW_WORKOS_USER_ID,
    ]);
  }

  it('binds a new sign-in email to the existing user\'s identity', async () => {
    const response = await request(app)
      .post(`/api/admin/users/${EXISTING_USER_ID}/linked-emails`)
      .send({ email: 'newalias@test.example' })
      .expect(201);

    expect(response.body).toMatchObject({
      bound: true,
      existing_user_id: EXISTING_USER_ID,
      new_email: 'newalias@test.example',
      new_workos_user_id: MOCK_NEW_WORKOS_USER_ID,
    });

    // Both WorkOS users now bound to one identity. Existing is primary.
    const bindings = await pool.query<{ workos_user_id: string; identity_id: string; is_primary: boolean }>(
      `SELECT workos_user_id, identity_id, is_primary
         FROM identity_workos_users
        WHERE workos_user_id IN ($1, $2)
        ORDER BY is_primary DESC`,
      [EXISTING_USER_ID, MOCK_NEW_WORKOS_USER_ID]
    );

    expect(bindings.rows).toHaveLength(2);
    expect(bindings.rows[0].workos_user_id).toBe(EXISTING_USER_ID);
    expect(bindings.rows[0].is_primary).toBe(true);
    expect(bindings.rows[1].workos_user_id).toBe(MOCK_NEW_WORKOS_USER_ID);
    expect(bindings.rows[1].is_primary).toBe(false);
    expect(bindings.rows[0].identity_id).toBe(bindings.rows[1].identity_id);
  });

  it('400s on invalid email', async () => {
    const response = await request(app)
      .post(`/api/admin/users/${EXISTING_USER_ID}/linked-emails`)
      .send({ email: 'not-an-email' })
      .expect(400);
    expect(response.body.error).toMatch(/invalid email/i);
  });

  it('409s when the new email matches the user\'s current primary email', async () => {
    const response = await request(app)
      .post(`/api/admin/users/${EXISTING_USER_ID}/linked-emails`)
      .send({ email: 'existing@test.example' })
      .expect(409);
    expect(response.body.error).toMatch(/already.*primary/i);
  });

  it('409s when the new email already has an existing AAO account', async () => {
    await pool.query(
      `INSERT INTO users (workos_user_id, email, first_name, last_name, email_verified,
                          workos_created_at, workos_updated_at, created_at, updated_at)
       VALUES ('user_test_bind_other', 'taken@test.example', 'Other', 'User', true, NOW(), NOW(), NOW(), NOW())`
    );
    try {
      const response = await request(app)
        .post(`/api/admin/users/${EXISTING_USER_ID}/linked-emails`)
        .send({ email: 'taken@test.example' })
        .expect(409);
      expect(response.body.error).toMatch(/already.*account/i);
    } finally {
      await pool.query(`DELETE FROM users WHERE workos_user_id = 'user_test_bind_other'`);
    }
  });

  it('404s when the existing user does not exist', async () => {
    const response = await request(app)
      .post(`/api/admin/users/user_does_not_exist/linked-emails`)
      .send({ email: 'fresh@test.example' })
      .expect(404);
    expect(response.body.error).toMatch(/not found/i);
  });

  it('translates WorkOS 422 (email already in use upstream) to a 409', async () => {
    mockCreateUser.mockImplementationOnce(async () => {
      const err: any = new Error('Email already in use');
      err.status = 422;
      throw err;
    });

    const response = await request(app)
      .post(`/api/admin/users/${EXISTING_USER_ID}/linked-emails`)
      .send({ email: 'taken-upstream@test.example' })
      .expect(409);

    expect(response.body.error).toMatch(/already exists/i);
    // No local users row should have been created.
    const localCheck = await pool.query(
      `SELECT 1 FROM users WHERE LOWER(email) = 'taken-upstream@test.example'`
    );
    expect(localCheck.rows).toEqual([]);
  });

  it('rolls back the WorkOS user when local bind fails after createUser succeeded', async () => {
    // Pre-create the new WorkOS user id locally so the post-createUser INSERT
    // would succeed, but force mergeUsers to fail by deleting the trigger-
    // created identity binding for the existing user (Phase 1 trigger
    // guarantees normally — we break the invariant to simulate a partial
    // failure path).
    await pool.query(`DELETE FROM identity_workos_users WHERE workos_user_id = $1`, [EXISTING_USER_ID]);

    const response = await request(app)
      .post(`/api/admin/users/${EXISTING_USER_ID}/linked-emails`)
      .send({ email: 'rollback@test.example' })
      .expect(500);

    expect(response.body.error).toMatch(/failed to bind/i);
    expect(response.body.message).toMatch(/rolled back|retry/i);
    expect(mockDeleteUser).toHaveBeenCalledWith(MOCK_NEW_WORKOS_USER_ID);
  });
});
