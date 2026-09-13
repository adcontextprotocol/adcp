/**
 * Exact cross-replica deletion-cache regression (#6827).
 *
 * Two independently loaded auth modules own distinct in-memory session caches
 * and distinct PostgreSQL pools. Replica A deletes an epoch-0 credential and
 * receives the local eviction. Replica B must reject its still-cached session
 * on the immediate next hit by observing the durable deletion fingerprint.
 */

import type { NextFunction, Request, Response } from 'express';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const USER_ID = 'user_authz_cross_replica_deleted';

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  loadSealedSession: vi.fn(),
}));

vi.hoisted(() => {
  delete process.env.DEV_USER_EMAIL;
  delete process.env.DEV_USER_ID;
  process.env.WORKOS_API_KEY = process.env.WORKOS_API_KEY ?? 'sk_test';
  process.env.WORKOS_CLIENT_ID = process.env.WORKOS_CLIENT_ID ?? 'client_test';
  process.env.WORKOS_COOKIE_PASSWORD =
    process.env.WORKOS_COOKIE_PASSWORD ?? 'placeholder-cookie-password-32-bytes-min';
});

vi.mock('@workos-inc/node', () => ({
  WorkOS: vi.fn(function WorkOS() {
    return {
      userManagement: { loadSealedSession: mocks.loadSealedSession },
      apiKeys: { createValidation: vi.fn() },
    };
  }),
}));

vi.mock('../../src/db/bans-db.js', () => ({
  bansDb: {
    checkPlatformBan: vi.fn().mockResolvedValue({ banned: false, ban: null }),
    checkPlatformBanForApiKey: vi.fn().mockResolvedValue({ banned: false, ban: null }),
  },
}));

function requestFor(cookie: string): Request {
  return {
    headers: {},
    cookies: { 'wos-session': cookie },
    path: '/api/me',
    originalUrl: '/api/me',
    accepts: () => false,
  } as unknown as Request;
}

function response(): Response {
  return {
    cookie: vi.fn(),
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    redirect: vi.fn().mockReturnThis(),
  } as unknown as Response;
}

describe('durable deletion fingerprint across independent replicas', () => {
  let poolA: Pool;
  let closeA: () => Promise<void>;
  let closeB: () => Promise<void>;
  let deleteOnA: (userId: string, source: 'workos_webhook') => Promise<unknown>;
  let fingerprintOnA: (userIds: string[]) => Promise<string>;
  let requireAuthA: (req: Request, res: Response, next: NextFunction) => Promise<unknown>;
  let requireAuthB: (req: Request, res: Response, next: NextFunction) => Promise<unknown>;
  let invalidateA: (userIds: string[]) => void;

  beforeAll(async () => {
    const connectionString = process.env.DATABASE_URL
      || 'postgresql://adcp:localdev@localhost:5432/adcp_test';

    vi.resetModules();
    const dbA = await import('../../src/db/client.js');
    poolA = dbA.initializeDatabase({ connectionString });
    closeA = dbA.closeDatabase;
    const migrationA = await import('../../src/db/migrate.js');
    await migrationA.runMigrations();
    const identityA = await import('../../src/db/identity-db.js');
    const epochA = await import('../../src/db/authorization-epoch-db.js');
    const authA = await import('../../src/middleware/auth.js');
    deleteOnA = identityA.deleteIdentityCredentialTransaction;
    fingerprintOnA = epochA.getAuthorizationFingerprint;
    requireAuthA = authA.requireAuth;
    invalidateA = authA.invalidateSessionsForUsers;

    vi.resetModules();
    const dbB = await import('../../src/db/client.js');
    dbB.initializeDatabase({ connectionString });
    closeB = dbB.closeDatabase;
    const authB = await import('../../src/middleware/auth.js');
    requireAuthB = authB.requireAuth;
  }, 60000);

  afterAll(async () => {
    await poolA.query(`DELETE FROM registry_audit_log WHERE workos_user_id = $1`, [USER_ID]);
    await poolA.query(`DELETE FROM users WHERE workos_user_id = $1`, [USER_ID]);
    await closeB();
    await closeA();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    await poolA.query(`DELETE FROM registry_audit_log WHERE workos_user_id = $1`, [USER_ID]);
    await poolA.query(`DELETE FROM users WHERE workos_user_id = $1`, [USER_ID]);
    await poolA.query(
      `INSERT INTO users (
         workos_user_id, email, first_name, last_name, email_verified,
         workos_created_at, workos_updated_at, created_at, updated_at
       ) VALUES ($1, 'cross-replica@authz.test', 'Cross', 'Replica', true,
                 NOW(), NOW(), NOW(), NOW())`,
      [USER_ID],
    );
    mocks.authenticate.mockResolvedValue({
      authenticated: true,
      user: {
        id: USER_ID,
        email: 'cross-replica@authz.test',
        firstName: 'Cross',
        lastName: 'Replica',
        emailVerified: true,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      accessToken: 'cross-replica-access-token',
    });
    mocks.loadSealedSession.mockReturnValue({
      authenticate: mocks.authenticate,
      refresh: vi.fn(),
    });
  });

  it('denies replica B immediately after replica A deletes an epoch-0 credential', async () => {
    const nextA = vi.fn() as NextFunction;
    const nextB = vi.fn() as NextFunction;
    const cookieA = `sealed-replica-a-${Date.now()}`;
    const cookieB = `sealed-replica-b-${Date.now()}`;

    expect(await fingerprintOnA([USER_ID])).toBe('');
    await requireAuthA(requestFor(cookieA), response(), nextA);
    await requireAuthB(requestFor(cookieB), response(), nextB);
    expect(mocks.authenticate).toHaveBeenCalledTimes(2);

    await deleteOnA(USER_ID, 'workos_webhook');
    invalidateA([USER_ID]);
    expect(await fingerprintOnA([USER_ID])).toMatch(
      /^user_authz_cross_replica_deleted:deleted:[0-9a-f-]{36}$/,
    );

    const replicaBResponse = response();
    await requireAuthB(requestFor(cookieB), replicaBResponse, nextB);

    expect(nextB).toHaveBeenCalledTimes(1);
    expect(mocks.authenticate).toHaveBeenCalledTimes(3);
    expect(replicaBResponse.status).toHaveBeenCalledWith(401);
  });
});
