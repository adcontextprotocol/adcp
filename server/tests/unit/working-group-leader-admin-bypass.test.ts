import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

/**
 * Focused unit tests for the site-admin bypass in the working-group leader
 * and member middleware factories (#7269).
 *
 * The bypass must recognize BOTH aao-admin working group membership (the
 * deployed primary authority, via isWebUserAAOAdmin) and the ADMIN_EMAILS
 * break-glass list — matching requireAdmin. A membership-lookup failure
 * degrades to non-admin (isWebUserAAOAdmin fails closed) without disabling a
 * valid break-glass grant.
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

vi.mock('../../src/addie/mcp/admin-tools.js', () => ({
  isWebUserAAOAdmin: mocks.isWebUserAAOAdmin,
}));

const {
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
  } as unknown as Request;

  const res = {
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
    expect(mocks.isWebUserAAOAdmin).toHaveBeenCalledWith('user_web');
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

  it('denies when the admin membership lookup fails (fail closed)', async () => {
    // isWebUserAAOAdmin fails closed to `false` on lookup error; a non-leader,
    // non-break-glass user must then be denied rather than granted.
    mocks.isWebUserAAOAdmin.mockResolvedValue(false);
    const db = createWorkingGroupDb({ isLeader: false, isMember: false });
    const { req, res, next } = createReqRes();

    await factory(db)(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect((res as unknown as { statusCode: number }).statusCode).toBe(403);
  });
});
