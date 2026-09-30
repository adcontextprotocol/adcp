/** Server-rendered pages share session refreshes and clear cookies WorkOS rejects. */
import { createHash } from 'node:crypto';
import express from 'express';
import supertest from 'supertest';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  sessions: new Map<string, { authenticate: ReturnType<typeof vi.fn>; refresh: ReturnType<typeof vi.fn> }>(),
  getRefreshedSession: vi.fn(), storeRefreshedSession: vi.fn(),
}));
vi.hoisted(() => {
  process.env.DEV_USER_EMAIL = '';
  process.env.DEV_USER_ID = '';
  process.env.WORKOS_API_KEY ??= 'sk_test';
  process.env.WORKOS_CLIENT_ID ??= 'client_test';
  process.env.WORKOS_COOKIE_PASSWORD ??= 'placeholder-cookie-password-32-bytes-min';
});
vi.mock('@workos-inc/node', () => ({
  WorkOS: vi.fn(function WorkOS() {
    return {
      userManagement: {
        loadSealedSession: ({ sessionData }: { sessionData: string }) => {
          const session = mocks.sessions.get(sessionData);
          if (!session) throw new Error(`unexpected session ${sessionData}`);
          return session;
        },
      },
      apiKeys: { createValidation: vi.fn() },
    };
  }),
}));
vi.mock('../../src/db/session-refresh-db.js', () => ({
  getRefreshedSession: mocks.getRefreshedSession,
  storeRefreshedSession: mocks.storeRefreshedSession,
  cleanExpiredRefreshes: vi.fn().mockResolvedValue(0),
}));
import { resolvePageSession, stopAuthTimers } from '../../src/middleware/auth.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const USER = { id: 'user_01', email: 'ada@acme.example', firstName: 'Ada', lastName: null };

function session(name: string, { valid = false, refresh }: { valid?: boolean; refresh?: unknown } = {}) {
  const entry = {
    authenticate: vi.fn().mockResolvedValue(valid
      ? { authenticated: true, user: USER }
      : { authenticated: false, reason: 'invalid_jwt' }),
    refresh: refresh instanceof Error
      ? vi.fn().mockRejectedValue(refresh)
      : vi.fn().mockResolvedValue(refresh ?? { authenticated: false, reason: 'invalid_grant', retryable: false }),
  };
  mocks.sessions.set(name, entry);
  return entry;
}

function page(cookie?: string) {
  const server = express();
  server.use((req, _res, next) => {
    req.cookies = cookie === undefined ? {} : { 'wos-session': cookie };
    next();
  });
  server.get('/page', async (req, res) => {
    const result = await resolvePageSession(req, res);
    res.json({ user: result.user?.id ?? null, cleared: result.cleared });
  });
  return supertest(server).get('/page');
}

const sessionCookieHeader = (headers: Record<string, unknown>) =>
  ((headers['set-cookie'] as string[] | undefined) ?? []).filter(c => c.startsWith('wos-session='));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.sessions.clear();
  mocks.getRefreshedSession.mockResolvedValue(undefined);
  mocks.storeRefreshedSession.mockResolvedValue(undefined);
});
afterAll(() => stopAuthTimers());

describe('resolvePageSession', () => {
  it('renders anonymously without touching WorkOS when no cookie is sent', async () => {
    const response = await page();
    expect(response.body).toEqual({ user: null, cleared: false });
    expect(response.headers['set-cookie']).toBeUndefined();
  });

  it('returns the user for a valid session without rewriting the cookie', async () => {
    session('valid-session', { valid: true });
    const response = await page('valid-session');
    expect(response.body).toEqual({ user: 'user_01', cleared: false });
    expect(sessionCookieHeader(response.headers)).toEqual([]);
  });

  it('shares a refresh so other copies of the cookie can recover the rotated token', async () => {
    session('expired-session', { refresh: { authenticated: true, sealedSession: 'rotated-session' } });
    session('rotated-session', { valid: true });

    const response = await page('expired-session');

    expect(response.body).toEqual({ user: 'user_01', cleared: false });
    expect(sessionCookieHeader(response.headers)[0]).toMatch(/^wos-session=rotated-session;.*HttpOnly/);
    expect(mocks.storeRefreshedSession).toHaveBeenCalledWith(hash('expired-session'), 'rotated-session');
  });

  it('adopts a session another request rotated, waiting once for it to be stored', async () => {
    session('bridged-copy');
    session('rotated-elsewhere', { valid: true });
    mocks.getRefreshedSession.mockResolvedValueOnce(undefined).mockResolvedValueOnce('rotated-elsewhere');

    const response = await page('bridged-copy');

    expect(response.body).toEqual({ user: 'user_01', cleared: false });
    expect(mocks.getRefreshedSession).toHaveBeenCalledTimes(2);
    expect(mocks.getRefreshedSession).toHaveBeenCalledWith(hash('bridged-copy'));
    expect(sessionCookieHeader(response.headers)[0]).toMatch(/^wos-session=rotated-elsewhere;/);
  });

  it.each([
    ['invalid_grant', { authenticated: false, reason: 'invalid_grant', retryable: false }],
    ['invalid_session_cookie', { authenticated: false, reason: 'invalid_session_cookie', retryable: false }],
  ])('clears a cookie WorkOS rejects with %s', async (_reason, refresh) => {
    session('dead-session', { refresh });

    const response = await page('dead-session');

    expect(response.body).toEqual({ user: null, cleared: true });
    const [cleared] = sessionCookieHeader(response.headers);
    expect(cleared).toMatch(/^wos-session=;/);
    expect(cleared).toMatch(/Expires=Thu, 01 Jan 1970/);
    expect(cleared).toMatch(/HttpOnly/);
  });

  it('keeps the cookie through a retryable WorkOS failure', async () => {
    session('expired-session', { refresh: { authenticated: false, reason: 'server_error', retryable: true } });

    const response = await page('expired-session');

    expect(response.body).toEqual({ user: null, cleared: false });
    expect(sessionCookieHeader(response.headers)).toEqual([]);
    expect(mocks.getRefreshedSession).not.toHaveBeenCalled();
  });

  it('keeps the cookie when refresh fails in an unrecognized way', async () => {
    session('expired-session', { refresh: new Error('socket hang up') });

    const response = await page('expired-session');

    expect(response.body).toEqual({ user: null, cleared: false });
    expect(sessionCookieHeader(response.headers)).toEqual([]);
  });
});
