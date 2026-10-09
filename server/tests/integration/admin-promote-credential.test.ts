/** Identity promotion containment preserves both privilege directions. */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import type { Pool } from 'pg';

vi.hoisted(() => {
  process.env.WORKOS_API_KEY ??= 'sk_test_mock_key';
  process.env.WORKOS_CLIENT_ID ??= 'client_mock_id';
  process.env.WORKOS_COOKIE_PASSWORD ??= 'test-cookie-password-at-least-32-chars-long';
});

const provider = vi.hoisted(() => ({ getUser: vi.fn(), createUser: vi.fn(), updateUser: vi.fn(), deleteUser: vi.fn() }));

vi.mock('../../src/auth/workos-client.js', () => {
  const mockUserManagement = provider;
  const mockWorkos = { userManagement: mockUserManagement };
  return { workos: mockWorkos, getWorkos: () => mockWorkos };
});

vi.mock('../../src/middleware/auth.js', async (importOriginal) => {
  const mockedRequireAuth = (req: any, _res: any, next: any) => {
    req.adminAccessMechanism = req.headers['x-test-admin-access-mechanism'] || undefined;
    req.user = {
      id: 'user_test_admin_promote',
      authWorkosUserId: 'user_test_admin_promote_credential',
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
    // don't propagate. Re-build the array so admin/users routes
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
import { handleEmailLinkVerification } from '../../src/routes/account-linking.js';
import { createAdminUsersRouter } from '../../src/routes/admin/users.js';
import { stopAuthTimers } from '../../src/middleware/auth.js';

const HOST_USER_ID = 'user_test_promote_host';
const TARGET_USER_ID = 'user_test_promote_target';
const HOST_ORG_ID = 'org_test_promote_host';
const TARGET_ORG_ID = 'org_test_promote_target';

describe('admin promote credential to primary', () => {
  let app: any;
  let pool: Pool;

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString: process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:5432/adcp_test',
    });
    await runMigrations();
    // Isolate the verification route's durable limiter across repeated runs.
    await pool.query(`DELETE FROM rate_limit_hits WHERE key LIKE 'verify-email-exec:%'`);
    app = express();
    app.use(express.json());
    app.use('/api/admin/users', createAdminUsersRouter());
    handleEmailLinkVerification(app);
  }, 60000);

  afterAll(async () => {
    await cleanup();
    stopAuthTimers();
    await closeDatabase();
  });

  beforeEach(async () => {
    await cleanup();
    vi.clearAllMocks();
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

  async function snapshotAuthority() {
    const snapshot = await Promise.all([
      pool.query(`SELECT * FROM users WHERE workos_user_id IN ($1, $2) ORDER BY workos_user_id`, [HOST_USER_ID, TARGET_USER_ID]),
      pool.query(`SELECT * FROM identity_workos_users WHERE workos_user_id IN ($1, $2) ORDER BY workos_user_id`, [HOST_USER_ID, TARGET_USER_ID]),
      pool.query(`SELECT * FROM organization_memberships WHERE workos_user_id IN ($1, $2) ORDER BY workos_user_id, workos_organization_id`, [HOST_USER_ID, TARGET_USER_ID]),
      pool.query(`SELECT * FROM organizations WHERE workos_organization_id IN ($1, $2) ORDER BY workos_organization_id`, [HOST_ORG_ID, TARGET_ORG_ID]),
    ]);
    return snapshot.map(result => result.rows);
  }

  // Seed an existing linked identity directly. Containment must not require a
  // destructive merge to succeed as part of test preparation.
  async function setupBoundPair(hostRole: string, targetRole: string) {
    await pool.query(
      `INSERT INTO organization_memberships (workos_user_id, workos_organization_id, email, role, created_at, updated_at)
       VALUES ($1, $3, 'host@test.example', $4, NOW(), NOW()),
              ($2, $3, 'target@test.example', $5, NOW(), NOW())`,
      [HOST_USER_ID, TARGET_USER_ID, HOST_ORG_ID, hostRole, targetRole],
    );
    await pool.query(
      `UPDATE users SET primary_organization_id = $1 WHERE workos_user_id = $2`,
      [HOST_ORG_ID, HOST_USER_ID],
    );
    await pool.query(
      `UPDATE users SET primary_organization_id = $1 WHERE workos_user_id = $2`,
      [TARGET_ORG_ID, TARGET_USER_ID],
    );
    await pool.query(
      `UPDATE identity_workos_users SET identity_id = (
         SELECT identity_id FROM identity_workos_users WHERE workos_user_id = $1
       ), is_primary = FALSE WHERE workos_user_id = $2`,
      [HOST_USER_ID, TARGET_USER_ID],
    );
  }

  it.each([
    ['admin', 'member'],
    ['member', 'admin'],
  ])('preserves %s primary and %s target authority through concurrent promotion, consolidation and replay', async (hostRole, targetRole) => {
    await setupBoundPair(hostRole, targetRole);
    const before = await snapshotAuthority();
    const calls = [
      `/api/admin/users/${HOST_USER_ID}/credentials/${TARGET_USER_ID}/promote`,
      `/api/admin/users/${TARGET_USER_ID}/credentials/${HOST_USER_ID}/promote`,
      `/api/admin/users/${HOST_USER_ID}/credentials`,
      `/api/admin/users/${TARGET_USER_ID}/credentials`,
    ];
    const invoke = (path: string, consolidate: boolean) => request(app).post(path)
      .send({ workos_user_id: path.includes(HOST_USER_ID) ? TARGET_USER_ID : HOST_USER_ID, consolidate })
      .expect(409)
      .expect(({ body }) => expect(body.error).toBe('identity_mutation_disabled'));
    await Promise.all(calls.flatMap(path => [invoke(path, false), invoke(path, true)]));
    for (const path of calls) await invoke(path, true);
    expect(await snapshotAuthority()).toEqual(before);
    for (const mock of Object.values(provider)) expect(mock).not.toHaveBeenCalled();
  });

  it.each([
    [HOST_USER_ID, TARGET_USER_ID],
    [TARGET_USER_ID, HOST_USER_ID],
  ])('refuses an in-flight member merge token from %s to %s and its replay', async (primaryId, targetId) => {
    await setupBoundPair('admin', 'member');
    const token = `containment-${primaryId}-${targetId}`;
    await pool.query(
      `INSERT INTO email_link_tokens (token, primary_workos_user_id, target_email, target_workos_user_id, expires_at)
       VALUES ($1, $2, 'target@test.example', $3, NOW() + INTERVAL '1 hour')`,
      [token, primaryId, targetId],
    );
    const before = await snapshotAuthority();
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await request(app).post('/verify-email-link')
        .type('form').send({ token, consolidate: true }).expect(200);
      expect(response.text).toContain('Verification Failed');
      expect(await snapshotAuthority()).toEqual(before);
    }
    expect((await pool.query(`SELECT status FROM email_link_tokens WHERE token = $1`, [token])).rows)
      .toEqual([{ status: 'revoked' }]);
    expect((await pool.query(`SELECT 1 FROM user_email_aliases WHERE workos_user_id IN ($1, $2)`, [HOST_USER_ID, TARGET_USER_ID])).rows)
      .toEqual([]);
    for (const mock of Object.values(provider)) expect(mock).not.toHaveBeenCalled();
  });

  it('preserves bare alias verification without moving authority or calling WorkOS', async () => {
    await setupBoundPair('admin', 'member');
    const token = 'containment-bare-alias';
    await pool.query(
      `INSERT INTO email_link_tokens (token, primary_workos_user_id, target_email, expires_at)
       VALUES ($1, $2, 'alias@test.example', NOW() + INTERVAL '1 hour')`,
      [token, HOST_USER_ID],
    );
    const before = await snapshotAuthority();
    const response = await request(app).post('/verify-email-link')
      .type('form').send({ token }).expect(200);
    expect(response.text).toContain('<title>Email Linked');
    expect(await snapshotAuthority()).toEqual(before);
    expect((await pool.query(`SELECT email FROM user_email_aliases WHERE workos_user_id = $1`, [HOST_USER_ID])).rows)
      .toEqual([{ email: 'alias@test.example' }]);
    for (const mock of Object.values(provider)) expect(mock).not.toHaveBeenCalled();
  });

  it('refuses promotion without a current primary even for a static admin API key', async () => {
    await setupBoundPair('admin', 'member');
    await pool.query(`UPDATE identity_workos_users SET is_primary = FALSE WHERE workos_user_id = $1`, [HOST_USER_ID]);
    const before = await snapshotAuthority();
    await request(app)
      .post(`/api/admin/users/${HOST_USER_ID}/credentials/${TARGET_USER_ID}/promote`)
      .set('X-Test-Admin-Access-Mechanism', 'static_admin_api_key')
      .send({ consolidate: true })
      .expect(409)
      .expect(({ body }) => expect(body.error).toBe('identity_mutation_disabled'));
    expect(await snapshotAuthority()).toEqual(before);
    for (const mock of Object.values(provider)) expect(mock).not.toHaveBeenCalled();
  });
});
