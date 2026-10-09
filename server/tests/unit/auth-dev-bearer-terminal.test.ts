import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';

const mocks = vi.hoisted(() => {
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('DEV_USER_EMAIL', 'dev@example.test');
  vi.stubEnv('DEV_USER_ID', 'user_dev_test');
  vi.stubEnv('WORKOS_API_KEY', 'sk_test_dev_bearer');
  vi.stubEnv('WORKOS_CLIENT_ID', 'client_test_dev_bearer');
  vi.stubEnv('WORKOS_COOKIE_PASSWORD', 'test-cookie-password-at-least-32-characters');
  return {
    authenticate: vi.fn(),
    refresh: vi.fn(),
    getRefreshedSession: vi.fn(),
  };
});

vi.mock('@workos-inc/node', () => ({
  WorkOS: class WorkOS {
    apiKeys = { createValidation: vi.fn() };
    userManagement = {
      loadSealedSession: () => ({ authenticate: mocks.authenticate, refresh: mocks.refresh }),
    };
  },
}));

vi.mock('../../src/db/session-refresh-db.js', () => ({
  cleanExpiredRefreshes: vi.fn().mockResolvedValue(0),
  getRefreshedSession: (...args: unknown[]) => mocks.getRefreshedSession(...args),
  storeRefreshedSession: vi.fn().mockResolvedValue(undefined),
}));

import {
  encodeDevSessionCookie,
  optionalAuth,
  requireAuth,
  stopAuthTimers,
} from '../../src/middleware/auth.js';

function bearerRequest(): Request {
  return {
    headers: { authorization: 'bEaReR\tinvalid-opaque-session' },
    cookies: { 'dev-session': encodeDevSessionCookie('admin') },
    query: {}, body: {}, params: {},
    accepts: vi.fn().mockReturnValue(false),
    originalUrl: '/api/protected',
    path: '/api/protected',
  } as unknown as Request;
}

function response(): Response {
  return {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    cookie: vi.fn().mockReturnThis(),
    redirect: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
  } as unknown as Response;
}

beforeEach(() => {
  mocks.authenticate.mockReset().mockResolvedValue({ authenticated: false });
  mocks.refresh.mockReset().mockResolvedValue({ authenticated: false, reason: 'invalid_grant', retryable: false });
  mocks.getRefreshedSession.mockReset().mockResolvedValue(null);
});

afterAll(() => {
  stopAuthTimers();
  vi.unstubAllEnvs();
});

describe.each([
  ['required', requireAuth],
  ['optional', optionalAuth],
] as const)('%s auth in dev mode', (_label, middleware) => {
  it('does not replace an explicit opaque Bearer with a valid dev-session cookie', async () => {
    const req = bearerRequest();
    const res = response();
    const next = vi.fn() as NextFunction;

    await middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
    expect(req.user).toBeUndefined();
  });
});
