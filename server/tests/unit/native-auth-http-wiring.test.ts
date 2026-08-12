import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

const mocks = vi.hoisted(() => ({
  getAuthorizationUrl: vi.fn(),
  authenticateWithCode: vi.fn(),
  listOrganizationMemberships: vi.fn(),
  setPendingAuth: vi.fn(),
  consumePendingAuth: vi.fn(),
  setGrant: vi.fn(),
  consumeGrant: vi.fn(),
}));

vi.hoisted(() => {
  process.env.WORKOS_API_KEY = 'sk_test_native_http_wiring';
  process.env.WORKOS_CLIENT_ID = 'client_test_native_http_wiring';
  process.env.WORKOS_COOKIE_PASSWORD = 'test-cookie-password-at-least-32-characters';
  process.env.WORKOS_REDIRECT_URI = 'https://agenticadvertising.org/auth/callback';
  delete process.env.DEV_USER_EMAIL;
  delete process.env.DEV_USER_ID;
});

vi.mock('@workos-inc/node', () => ({
  DomainDataState: { Verified: 'verified' },
  WorkOS: class WorkOS {
    userManagement = {
      getAuthorizationUrl: mocks.getAuthorizationUrl,
      authenticateWithCode: mocks.authenticateWithCode,
      listOrganizationMemberships: mocks.listOrganizationMemberships,
    };
    organizations = {};
    apiKeys = {};
  },
}));

vi.mock('../../src/config.js', async () => {
  const actual = await vi.importActual('../../src/config.js');
  return {
    ...actual,
    getDatabaseConfig: vi.fn().mockReturnValue({
      connectionString: 'postgresql://localhost/test',
    }),
  };
});

vi.mock('../../src/db/client.js', () => ({
  initializeDatabase: vi.fn(),
  getPool: vi.fn().mockReturnValue({
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
  }),
  isDatabaseInitialized: vi.fn().mockReturnValue(false),
  closeDatabase: vi.fn(),
  healthCheck: vi.fn().mockResolvedValue(undefined),
  query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
}));

vi.mock('../../src/db/migrate.js', () => ({
  runMigrations: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/db/native-auth-state-db.js', () => ({
  NATIVE_PENDING_TTL_MS: 10 * 60 * 1000,
  NATIVE_GRANT_TTL_MS: 2 * 60 * 1000,
  setPendingAuth: mocks.setPendingAuth,
  consumePendingAuth: mocks.consumePendingAuth,
  setGrant: mocks.setGrant,
  consumeGrant: mocks.consumeGrant,
  cleanupExpired: vi.fn().mockResolvedValue(0),
}));

const { HTTPServer } = await import('../../src/http.js');
const {
  NATIVE_CLIENT_ID,
  NATIVE_PROTOCOL_VERSION,
  NATIVE_REDIRECT_URI,
  deriveS256Challenge,
} = await import('../../src/routes/native-auth.js');

const STATE = 's'.repeat(43);
const CHALLENGE = 'c'.repeat(43);
const PENDING_ID = 'p'.repeat(43);
const WORKOS_VERIFIER = 'w'.repeat(43);

function nativePending() {
  return {
    clientId: NATIVE_CLIENT_ID,
    redirectUri: NATIVE_REDIRECT_URI,
    clientState: STATE,
    codeChallenge: CHALLENGE,
    workosCodeVerifier: WORKOS_VERIFIER,
    issuer: 'https://agenticadvertising.org',
  };
}

function appFor(server: HTTPServer) {
  return (server as unknown as { app: Parameters<typeof request>[0] }).app;
}

describe('native OAuth HTTPServer wiring', () => {
  let server: HTTPServer | undefined;

  afterEach(async () => {
    await server?.stop();
    server = undefined;
    vi.clearAllMocks();
  });

  it('mounts native start and binds the upstream WorkOS transaction with PKCE', async () => {
    mocks.getAuthorizationUrl.mockImplementation((options: Record<string, string>) => {
      const url = new URL('https://workos.test/authorize');
      url.searchParams.set('state', options.state);
      url.searchParams.set('code_challenge', options.codeChallenge);
      return url.toString();
    });
    server = new HTTPServer();

    const response = await request(appFor(server)).post('/auth/native/start').send({
      v: NATIVE_PROTOCOL_VERSION,
      client_id: NATIVE_CLIENT_ID,
      redirect_uri: NATIVE_REDIRECT_URI,
      state: STATE,
      code_challenge: CHALLENGE,
      code_challenge_method: 'S256',
    });

    expect(response.status).toBe(200);
    expect(mocks.setPendingAuth).toHaveBeenCalledOnce();
    const [, stored] = mocks.setPendingAuth.mock.calls[0];
    expect(stored.workosCodeVerifier).toHaveLength(43);
    expect(mocks.getAuthorizationUrl).toHaveBeenCalledWith(expect.objectContaining({
      codeChallenge: deriveS256Challenge(stored.workosCodeVerifier),
      codeChallengeMethod: 'S256',
    }));
  });

  it('routes a native callback error once and fails closed on replay', async () => {
    mocks.consumePendingAuth
      .mockResolvedValueOnce(nativePending())
      .mockResolvedValueOnce(undefined);
    server = new HTTPServer();
    const state = JSON.stringify({ native_pending_id: PENDING_ID });

    const first = await request(appFor(server)).get('/auth/callback').query({
      state,
      error: 'access_denied',
    });
    expect(first.status).toBe(302);
    expect(first.headers['cache-control']).toBe('no-store');
    expect(first.headers.pragma).toBe('no-cache');
    const location = new URL(first.headers.location);
    expect(location.protocol).toBe('org.agenticadvertising.addie:');
    expect([...location.searchParams.keys()].sort()).toEqual(['error', 'iss', 'state', 'v']);
    expect(first.headers.location).not.toContain('sealed_session');
    expect(first.headers.location).not.toContain('email');

    const replay = await request(appFor(server)).get('/auth/callback').query({
      state,
      code: 'workos-code',
    });
    expect(replay.status).toBe(400);
    expect(replay.headers['cache-control']).toBe('no-store');
    expect(replay.headers.pragma).toBe('no-cache');
    expect(replay.body).toEqual({ error: 'invalid_request' });
  });

  it('prevents caching when the native pending-state store fails', async () => {
    mocks.consumePendingAuth.mockRejectedValueOnce(new Error('database unavailable'));
    server = new HTTPServer();

    const response = await request(appFor(server)).get('/auth/callback').query({
      state: JSON.stringify({ native_pending_id: PENDING_ID }),
      code: 'workos-code',
    });

    expect(response.status).toBe(503);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers.pragma).toBe('no-cache');
    expect(response.body).toEqual({ error: 'temporarily_unavailable' });
  });

  it('redeems the WorkOS code with its server-side verifier before issuing a safe grant', async () => {
    mocks.consumePendingAuth.mockResolvedValueOnce(nativePending());
    mocks.authenticateWithCode.mockResolvedValueOnce({
      sealedSession: 'SEALED_SESSION_SECRET',
      user: {
        id: 'user_1',
        email: 'person@example.com',
        firstName: 'Person',
        lastName: 'Example',
        emailVerified: true,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    });
    mocks.listOrganizationMemberships.mockResolvedValueOnce({ data: [] });
    server = new HTTPServer();

    const response = await request(appFor(server)).get('/auth/callback').query({
      state: JSON.stringify({ native_pending_id: PENDING_ID }),
      code: 'workos-authorization-code',
    });

    expect(response.status).toBe(302);
    expect(mocks.authenticateWithCode).toHaveBeenCalledWith(expect.objectContaining({
      code: 'workos-authorization-code',
      codeVerifier: WORKOS_VERIFIER,
    }));
    expect(mocks.setGrant).toHaveBeenCalledOnce();
    const location = new URL(response.headers.location);
    expect([...location.searchParams.keys()].sort()).toEqual(['code', 'iss', 'state', 'v']);
    expect(response.headers.location).not.toContain('SEALED_SESSION_SECRET');
    expect(response.headers.location).not.toContain('person%40example.com');
  });

  it('rejects the legacy bearer-in-URI login protocol', async () => {
    server = new HTTPServer();
    const response = await request(appFor(server)).get('/auth/login').query({
      native: 'true',
      redirect_uri: 'addie://auth/callback',
    });

    expect(response.status).toBe(426);
    expect(response.body).toEqual({
      error: 'native_client_upgrade_required',
      native_protocol: 2,
    });
    expect(response.headers.location).toBeUndefined();
  });
});
