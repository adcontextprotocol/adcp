/** Creation-and-bind is contained before any WorkOS mutation or local insert. */

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
import { initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import type { Pool } from 'pg';

// Mock auth middleware: synthetic admin user. Use importOriginal so that
// helpers like createRequireWorkingGroupLeader (used by other mounted
// routers) are still available — env vars are set via vi.hoisted above
// so the WorkOS constructor at module load doesn't blow up.
vi.mock('../../src/middleware/auth.js', async (importOriginal) => {
  const mockedRequireAuth = (req: any, _res: any, next: any) => {
    req.user = {
      id: 'user_test_admin_bind',
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
    // `requireGlobalAdmin` is an exported array that captures its
    // member references at module-load time, so the per-export mocks
    // above don't propagate into it. Re-build the array here with the
    // mocked entries so admin/users routes (which use
    // `...requireGlobalAdmin`) get the test-friendly chain.
    requireGlobalAdmin: [mockedRequireAuth, passThrough, passThrough],
  };
});

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

import express from 'express';
import { createAdminUsersRouter } from '../../src/routes/admin/users.js';
import { stopAuthTimers } from '../../src/middleware/auth.js';

const EXISTING_USER_ID = 'user_test_bind_existing';

describe('POST /api/admin/users/:userId/linked-emails (admin bind)', () => {
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

  it.each([
    { email: 'newalias@test.example' },
    { email: 'newalias@test.example', consolidate: true },
    { email: 'existing@test.example' },
    { email: 'not-an-email' },
    {},
  ])('refuses create-and-bind before provider or local writes: %j', async (body) => {
    const before = await pool.query(
      `SELECT to_jsonb(u) AS state FROM users u WHERE workos_user_id = $1`,
      [EXISTING_USER_ID],
    );
    const bindingsBefore = await pool.query(
      `SELECT * FROM identity_workos_users WHERE workos_user_id = $1`,
      [EXISTING_USER_ID],
    );

    const response = await request(app)
      .post(`/api/admin/users/${EXISTING_USER_ID}/linked-emails`)
      .send(body)
      .expect(409);

    expect(response.body).toEqual({
      error: 'identity_mutation_disabled',
      message: 'Identity consolidation is disabled until authority and provenance can be preserved.',
    });
    expect(mockCreateUser).not.toHaveBeenCalled();
    expect(mockDeleteUser).not.toHaveBeenCalled();
    expect((await pool.query(
      `SELECT to_jsonb(u) AS state FROM users u WHERE workos_user_id = $1`,
      [EXISTING_USER_ID],
    )).rows).toEqual(before.rows);
    expect((await pool.query(
      `SELECT * FROM identity_workos_users WHERE workos_user_id = $1`,
      [EXISTING_USER_ID],
    )).rows).toEqual(bindingsBefore.rows);
    expect((await pool.query(
      `SELECT 1 FROM users WHERE workos_user_id = $1`,
      [MOCK_NEW_WORKOS_USER_ID],
    )).rows).toEqual([]);
  });

  it('refuses when the existing identity has no primary binding', async () => {
    await pool.query(`DELETE FROM identity_workos_users WHERE workos_user_id = $1`, [EXISTING_USER_ID]);
    await request(app)
      .post(`/api/admin/users/${EXISTING_USER_ID}/linked-emails`)
      .send({ email: 'missing-primary@test.example', consolidate: true })
      .expect(409)
      .expect(({ body }) => expect(body.error).toBe('identity_mutation_disabled'));
    expect(mockCreateUser).not.toHaveBeenCalled();
    expect(mockDeleteUser).not.toHaveBeenCalled();
    expect((await pool.query(
      `SELECT 1 FROM identity_workos_users WHERE workos_user_id = $1`,
      [EXISTING_USER_ID],
    )).rows).toEqual([]);
  });
});
