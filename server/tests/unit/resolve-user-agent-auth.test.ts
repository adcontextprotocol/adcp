import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveUserAgentAuth } from '../../src/routes/helpers/resolve-user-agent-auth.js';
import type { AgentContextDatabase } from '../../src/db/agent-context-db.js';
import type { ResolvedOwnerAuth } from '../../src/db/compliance-db.js';

type StubbedAgentContextDb = Pick<
  AgentContextDatabase,
  'getAuthInfoByOrgAndUrl' | 'getByOrgAndUrl' | 'getOAuthTokensByOrgAndUrl' | 'getOAuthClient'
>;

function makeDb(): {
  [K in keyof StubbedAgentContextDb]: ReturnType<typeof vi.fn>;
} {
  return {
    getAuthInfoByOrgAndUrl: vi.fn(),
    getByOrgAndUrl: vi.fn(),
    getOAuthTokensByOrgAndUrl: vi.fn(),
    getOAuthClient: vi.fn(),
  };
}

function makeLogger() {
  return { warn: vi.fn() };
}

const ORG = 'org_xyz';
const URL = 'https://agent.example.com';

describe('resolveUserAgentAuth', () => {
  let db: ReturnType<typeof makeDb>;
  let logger: ReturnType<typeof makeLogger>;

  beforeEach(() => {
    db = makeDb();
    logger = makeLogger();
  });

  const call = () =>
    resolveUserAgentAuth(db as unknown as AgentContextDatabase, ORG, URL, logger);

  it('returns static bearer when the connect form saved one', async () => {
    db.getAuthInfoByOrgAndUrl.mockResolvedValueOnce({ token: 'static_bearer', authType: 'bearer' });

    const auth = await call();

    expect(auth).toEqual({ type: 'bearer', token: 'static_bearer' });
    expect(db.getByOrgAndUrl).not.toHaveBeenCalled();
  });

  it('decodes static basic auth into username/password', async () => {
    const username = 'test-user';
    const password = 'test-pass';
    const encoded = Buffer.from(`${username}:${password}`).toString('base64');
    db.getAuthInfoByOrgAndUrl.mockResolvedValueOnce({ token: encoded, authType: 'basic' });

    const auth = await call();

    expect(auth).toEqual({ type: 'basic', username, password });
  });

  it('falls back to bearer when basic auth has no colon separator', async () => {
    // Documents the malformed-basic behavior: we don't silently fail or pass
    // through to OAuth — we hand the raw token to the agent as a bearer and
    // let it return a clear 401 if the format is wrong.
    const malformed = Buffer.from('no_separator_here').toString('base64');
    db.getAuthInfoByOrgAndUrl.mockResolvedValueOnce({ token: malformed, authType: 'basic' });

    const auth = await call();

    expect(auth).toEqual({ type: 'bearer', token: malformed });
    expect(db.getByOrgAndUrl).not.toHaveBeenCalled();
  });

  it('returns full oauth shape when refresh token and client are saved', async () => {
    const expiresAt = new Date('2030-01-01T00:00:00Z');
    db.getAuthInfoByOrgAndUrl.mockResolvedValueOnce(null);
    db.getByOrgAndUrl.mockResolvedValueOnce({ id: 'ctx_1', has_oauth_token: true });
    db.getOAuthTokensByOrgAndUrl.mockResolvedValueOnce({
      access_token: 'access',
      refresh_token: 'refresh',
      expires_at: expiresAt,
    });
    db.getOAuthClient.mockResolvedValueOnce({ client_id: 'client_abc', client_secret: 'secret' });

    const auth = await call();

    expect(auth).toEqual({
      type: 'oauth',
      tokens: { access_token: 'access', refresh_token: 'refresh', expires_at: expiresAt.toISOString() },
      client: { client_id: 'client_abc', client_secret: 'secret' },
    });
    // Arg-ordering guard: getOAuthClient is called with the context id, not the agent URL.
    expect(db.getOAuthClient).toHaveBeenCalledWith('ctx_1');
    expect(db.getOAuthTokensByOrgAndUrl).toHaveBeenCalledWith(ORG, URL);

    // Type-assignability guard: the returned value is a valid ResolvedOwnerAuth.
    const _typed: ResolvedOwnerAuth = auth!;
    void _typed;
  });

  it('omits client_secret when the OAuth client is public', async () => {
    db.getAuthInfoByOrgAndUrl.mockResolvedValueOnce(null);
    db.getByOrgAndUrl.mockResolvedValueOnce({ id: 'ctx_1', has_oauth_token: true });
    db.getOAuthTokensByOrgAndUrl.mockResolvedValueOnce({
      access_token: 'access',
      refresh_token: 'refresh',
    });
    db.getOAuthClient.mockResolvedValueOnce({ client_id: 'client_abc' });

    const auth = await call();

    expect(auth).toEqual({
      type: 'oauth',
      tokens: { access_token: 'access', refresh_token: 'refresh' },
      client: { client_id: 'client_abc' },
    });
  });

  it('returns oauth without client when none is registered', async () => {
    db.getAuthInfoByOrgAndUrl.mockResolvedValueOnce(null);
    db.getByOrgAndUrl.mockResolvedValueOnce({ id: 'ctx_1', has_oauth_token: true });
    db.getOAuthTokensByOrgAndUrl.mockResolvedValueOnce({
      access_token: 'access',
      refresh_token: 'refresh',
    });
    db.getOAuthClient.mockResolvedValueOnce(null);

    const auth = await call();

    expect(auth).toEqual({
      type: 'oauth',
      tokens: { access_token: 'access', refresh_token: 'refresh' },
    });
    const _typed: ResolvedOwnerAuth = auth!;
    void _typed;
  });

  it('falls back to raw bearer when OAuth has no refresh token (clear 401 instead of silent drop)', async () => {
    db.getAuthInfoByOrgAndUrl.mockResolvedValueOnce(null);
    db.getByOrgAndUrl.mockResolvedValueOnce({ id: 'ctx_1', has_oauth_token: true });
    db.getOAuthTokensByOrgAndUrl.mockResolvedValueOnce({ access_token: 'access' });

    const auth = await call();

    expect(auth).toEqual({ type: 'bearer', token: 'access' });
    // No client lookup needed when there's no refresh token.
    expect(db.getOAuthClient).not.toHaveBeenCalled();
  });

  it('prefers static token over OAuth when both are present', async () => {
    // Symmetry with resolveOwnerAuth: a connect-form static token shortcircuits
    // the OAuth path entirely.
    db.getAuthInfoByOrgAndUrl.mockResolvedValueOnce({ token: 'static_bearer', authType: 'bearer' });

    const auth = await call();

    expect(auth).toEqual({ type: 'bearer', token: 'static_bearer' });
    expect(db.getByOrgAndUrl).not.toHaveBeenCalled();
    expect(db.getOAuthTokensByOrgAndUrl).not.toHaveBeenCalled();
  });

  it('returns undefined when the org has no stored credentials', async () => {
    db.getAuthInfoByOrgAndUrl.mockResolvedValueOnce(null);
    db.getByOrgAndUrl.mockResolvedValueOnce({ id: 'ctx_1', has_oauth_token: false });

    const auth = await call();

    expect(auth).toBeUndefined();
    expect(db.getOAuthTokensByOrgAndUrl).not.toHaveBeenCalled();
  });

  it('returns undefined when agent_context is missing entirely', async () => {
    db.getAuthInfoByOrgAndUrl.mockResolvedValueOnce(null);
    db.getByOrgAndUrl.mockResolvedValueOnce(null);

    const auth = await call();

    expect(auth).toBeUndefined();
  });

  it('logs and falls through to OAuth when the static token lookup throws', async () => {
    db.getAuthInfoByOrgAndUrl.mockRejectedValueOnce(new Error('boom'));
    db.getByOrgAndUrl.mockResolvedValueOnce({ id: 'ctx_1', has_oauth_token: true });
    db.getOAuthTokensByOrgAndUrl.mockResolvedValueOnce({
      access_token: 'access',
      refresh_token: 'refresh',
    });
    db.getOAuthClient.mockResolvedValueOnce(null);

    const auth = await call();

    expect(auth).toEqual({
      type: 'oauth',
      tokens: { access_token: 'access', refresh_token: 'refresh' },
    });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ agentUrl: URL, orgId: ORG }),
      expect.stringContaining('static token lookup failed'),
    );
  });

  it('returns undefined and logs when the OAuth lookup throws', async () => {
    db.getAuthInfoByOrgAndUrl.mockResolvedValueOnce(null);
    db.getByOrgAndUrl.mockRejectedValueOnce(new Error('db down'));

    const auth = await call();

    expect(auth).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ agentUrl: URL, orgId: ORG }),
      expect.stringContaining('OAuth token lookup failed'),
    );
  });
});
