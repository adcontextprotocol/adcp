import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

/**
 * Focused unit tests for the site-admin bypass in the working-group leader
 * and member middleware factories (#7269).
 *
 * The bypass must recognize BOTH aao-admin working group membership (the
 * deployed primary authority) and the ADMIN_EMAILS break-glass list —
 * matching requireAdmin. Lookup failures remain unavailable without disabling
 * a valid independently configured break-glass grant.
 */

const mocks = vi.hoisted(() => ({
  isWebUserAAOAdmin: vi.fn(),
}));

vi.hoisted(() => {
  process.env.WORKOS_API_KEY = 'sk_test_wg_leader_bypass';
  process.env.WORKOS_CLIENT_ID = 'client_test_wg_leader_bypass';
  process.env.WORKOS_COOKIE_PASSWORD =
    'test-cookie-password-at-least-32-characters';
  delete process.env.DEV_USER_EMAIL;
  delete process.env.DEV_USER_ID;
});

vi.mock('@workos-inc/node', () => ({
  WorkOS: class WorkOS {
    apiKeys = { createValidation: vi.fn() };
    userManagement = { loadSealedSession: vi.fn() };
  },
}));

vi.mock('../../src/db/working-group-db.js', () => ({
  WorkingGroupDatabase: class {
    getWorkingGroupIdBySlug = vi.fn().mockResolvedValue('wg_aao_admin');
    isMember = mocks.isWebUserAAOAdmin;
  },
}));

import { invalidateAllAdminStatusCaches } from '../../src/addie/admin-status-cache.js';

const {
  requireAdmin,
  createRequireWorkingGroupLeader,
  createRequireWorkingGroupMember,
  stopAuthTimers,
} = await import('../../src/middleware/auth.js');

const WG = { id: 'wg_signals', slug: 'signals' };

function createWorkingGroupDb(overrides?: {
  isLeader?: boolean;
  isMember?: boolean;
  group?: { id: string } | null;
}) {
  return {
    getWorkingGroupBySlug: vi
      .fn()
      .mockResolvedValue(overrides?.group === undefined ? WG : overrides.group),
    isLeader: vi.fn().mockResolvedValue(overrides?.isLeader ?? false),
    isMember: vi.fn().mockResolvedValue(overrides?.isMember ?? false),
  };
}

function createReqRes(email = 'user@example.test') {
  const req = {
    user: { id: 'user_web', email },
    params: { slug: 'signals' },
    headers: { accept: 'application/json' },
    accepts: () => false,
    originalUrl: '/api/admin/test',
    path: '/admin/test',
    method: 'GET',
  } as unknown as Request;

  const res = {
    headers: {} as Record<string, string>,
    setHeader(name: string, value: string) { this.headers[name] = value; },
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  } as unknown as Response & { statusCode: number; body: unknown };

  const next = vi.fn() as unknown as NextFunction;
  return { req, res, next };
}

beforeEach(() => {
  vi.clearAllMocks();
  invalidateAllAdminStatusCaches();
  delete process.env.ADMIN_EMAILS;
  mocks.isWebUserAAOAdmin.mockResolvedValue(false);
});

afterAll(() => {
  stopAuthTimers();
});

describe.each([
  {
    label: 'leader',
    factory: createRequireWorkingGroupLeader,
    grantKey: 'isLeader' as const,
  },
  {
    label: 'member',
    factory: createRequireWorkingGroupMember,
    grantKey: 'isMember' as const,
  },
])('createRequireWorkingGroup$label admin bypass', ({ factory, grantKey }) => {
  it('allows an aao-admin member without a working-group grant', async () => {
    mocks.isWebUserAAOAdmin.mockResolvedValue(true);
    const db = createWorkingGroupDb();
    const { req, res, next } = createReqRes();

    await factory(db)(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(mocks.isWebUserAAOAdmin).toHaveBeenCalledWith('wg_aao_admin', 'user_web');
    // Admin short-circuits before any group lookup.
    expect(db.getWorkingGroupBySlug).not.toHaveBeenCalled();
  });

  it('allows an ADMIN_EMAILS break-glass user', async () => {
    process.env.ADMIN_EMAILS = 'ops@example.test, admin@example.test';
    mocks.isWebUserAAOAdmin.mockResolvedValue(false);
    const db = createWorkingGroupDb();
    const { req, res, next } = createReqRes('ADMIN@example.test');

    await factory(db)(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(db.getWorkingGroupBySlug).not.toHaveBeenCalled();
  });

  it('denies an ordinary non-leader/non-member', async () => {
    const db = createWorkingGroupDb({ isLeader: false, isMember: false });
    const { req, res, next } = createReqRes();

    await factory(db)(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect((res as unknown as { statusCode: number }).statusCode).toBe(403);
  });

  it('allows a working-group grant even when not an admin', async () => {
    const db = createWorkingGroupDb({ [grantKey]: true });
    const { req, res, next } = createReqRes();

    await factory(db)(req, res, next);

    expect(next).toHaveBeenCalledOnce();
  });

  it('never regains reserved platform authority through a canonical group grant', async () => {
    const db = createWorkingGroupDb({ isLeader: true, isMember: true, group: { id: 'wg_aao_admin' } });
    const { req, res, next } = createReqRes();
    req.params.slug = 'aao-admin';
    req.user!.id = 'user_canonical_admin';
    req.user!.authWorkosUserId = 'user_authenticated_non_admin';

    await factory(db)(req, res, next);

    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
    expect(db.getWorkingGroupBySlug).not.toHaveBeenCalled();
    expect(db.isLeader).not.toHaveBeenCalled();
    expect(db.isMember).not.toHaveBeenCalled();
  });

  it('returns a retryable 503 when the administrator lookup is unavailable', async () => {
    mocks.isWebUserAAOAdmin.mockRejectedValue(new Error('database unavailable'));
    const db = createWorkingGroupDb({ isLeader: false, isMember: false });
    const { req, res, next } = createReqRes();

    await factory(db)(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect((res as unknown as { statusCode: number }).statusCode).toBe(503);
    expect(res.body).toMatchObject({ error: 'admin_authorization_unavailable' });
  });
});


describe.each([
  { label: 'platform admin', middleware: requireAdmin },
  { label: 'working-group leader', middleware: createRequireWorkingGroupLeader(createWorkingGroupDb()) },
  { label: 'working-group member', middleware: createRequireWorkingGroupMember(createWorkingGroupDb()) },
])('$label credential boundary', ({ middleware }) => {
  it.each([
    { authenticated: 'user_admin', canonical: 'user_member', allowed: true },
    { authenticated: 'user_member', canonical: 'user_admin', allowed: false },
  ])('authorizes $authenticated without inheriting $canonical', async ({ authenticated, canonical, allowed }) => {
    mocks.isWebUserAAOAdmin.mockImplementation(async (_group: string, userId: string) => userId === 'user_admin');
    const { req, res, next } = createReqRes();
    req.user!.id = canonical;
    req.user!.authWorkosUserId = authenticated;
    await middleware(req, res, next);
    expect(mocks.isWebUserAAOAdmin).toHaveBeenCalledWith('wg_aao_admin', authenticated);
    expect(next).toHaveBeenCalledTimes(allowed ? 1 : 0);
    expect(res.statusCode).toBe(allowed ? 200 : 403);
  });

  it('preserves independently configured break-glass authority during an outage', async () => {
    process.env.ADMIN_EMAILS = 'ops@example.test';
    mocks.isWebUserAAOAdmin.mockRejectedValue(new Error('database unavailable'));
    const { req, res, next } = createReqRes('OPS@example.test');
    req.user!.authWorkosUserId = 'user_authenticated';
    await middleware(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.statusCode).toBe(200);
  });
});
