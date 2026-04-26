import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db/client.js', () => ({
  query: vi.fn(),
  getClient: vi.fn(),
}));

vi.mock('../../src/db/encryption.js', () => ({
  decrypt: vi.fn(),
  encrypt: vi.fn(),
  deriveKey: vi.fn(),
}));

import { ComplianceDatabase, type ResolvedOwnerAuth } from '../../src/db/compliance-db.js';
import { query } from '../../src/db/client.js';
import { decrypt } from '../../src/db/encryption.js';

const mockedQuery = vi.mocked(query);
const mockedDecrypt = vi.mocked(decrypt);

function mockRow(overrides: Record<string, unknown>) {
  const base = {
    organization_id: 'org_123',
    auth_token_encrypted: null,
    auth_token_iv: null,
    auth_type: 'bearer',
    oauth_access_token_encrypted: null,
    oauth_access_token_iv: null,
    oauth_refresh_token_encrypted: null,
    oauth_refresh_token_iv: null,
    oauth_token_expires_at: null,
    oauth_client_id: null,
    oauth_client_secret_encrypted: null,
    oauth_client_secret_iv: null,
    oauth_cc_token_endpoint: null,
    oauth_cc_client_id: null,
    oauth_cc_client_secret_encrypted: null,
    oauth_cc_client_secret_iv: null,
    oauth_cc_scope: null,
    oauth_cc_resource: null,
    oauth_cc_audience: null,
    oauth_cc_auth_method: null,
    ...overrides,
  };
  mockedQuery.mockResolvedValueOnce({ rows: [base], rowCount: 1, command: '', oid: 0, fields: [] });
}

describe('ComplianceDatabase.resolveOwnerAuth', () => {
  let db: ComplianceDatabase;

  beforeEach(() => {
    db = new ComplianceDatabase();
    vi.clearAllMocks();
  });

  it('returns undefined when no row matches', async () => {
    mockedQuery.mockResolvedValueOnce({ rows: [], rowCount: 0, command: '', oid: 0, fields: [] });
    const auth = await db.resolveOwnerAuth('https://agent.example.com');
    expect(auth).toBeUndefined();
  });

  it('returns static bearer when auth_token_encrypted is present', async () => {
    mockRow({ auth_token_encrypted: 'enc_bearer', auth_token_iv: 'iv_bearer', auth_type: 'bearer' });
    mockedDecrypt.mockReturnValueOnce('bearer-token-plaintext');

    const auth = await db.resolveOwnerAuth('https://agent.example.com');
    expect(auth).toEqual({ type: 'bearer', token: 'bearer-token-plaintext' });
  });

  it('decodes static basic auth into username/password', async () => {
    const username = 'test-user';
    const password = 'test-pass';
    const credentials = Buffer.from(`${username}:${password}`).toString('base64');
    mockRow({ auth_token_encrypted: 'enc_basic', auth_token_iv: 'iv_basic', auth_type: 'basic' });
    mockedDecrypt.mockReturnValueOnce(credentials);

    const auth = await db.resolveOwnerAuth('https://agent.example.com');
    expect(auth).toEqual({ type: 'basic', username, password });
  });

  it('falls back to bearer when basic-typed token has no colon separator', async () => {
    const malformed = Buffer.from('no_separator_here').toString('base64');
    mockRow({ auth_token_encrypted: 'enc_mal', auth_token_iv: 'iv_mal', auth_type: 'basic' });
    mockedDecrypt.mockReturnValueOnce(malformed);

    const auth = await db.resolveOwnerAuth('https://agent.example.com');
    expect(auth).toEqual({ type: 'bearer', token: malformed });
  });

  it('returns the full oauth shape when a refresh token is saved', async () => {
    const expiresAt = new Date('2030-01-01T00:00:00.000Z');
    mockRow({
      oauth_access_token_encrypted: 'enc_access',
      oauth_access_token_iv: 'iv_access',
      oauth_refresh_token_encrypted: 'enc_refresh',
      oauth_refresh_token_iv: 'iv_refresh',
      oauth_token_expires_at: expiresAt,
      oauth_client_id: 'client_abc',
      oauth_client_secret_encrypted: 'enc_secret',
      oauth_client_secret_iv: 'iv_secret',
    });
    // Distinct plaintexts per ciphertext — swapping access/refresh in the code
    // under test would produce different assertion values.
    mockedDecrypt.mockImplementation((encrypted: string) => {
      if (encrypted === 'enc_access') return 'access-plaintext';
      if (encrypted === 'enc_refresh') return 'refresh-plaintext';
      if (encrypted === 'enc_secret') return 'secret-plaintext';
      throw new Error(`unexpected decrypt call: ${encrypted}`);
    });

    const auth = await db.resolveOwnerAuth('https://agent.example.com');
    expect(auth).toEqual({
      type: 'oauth',
      tokens: {
        access_token: 'access-plaintext',
        refresh_token: 'refresh-plaintext',
        expires_at: expiresAt.toISOString(),
      },
      client: { client_id: 'client_abc', client_secret: 'secret-plaintext' },
    });

    // Type-assignability guard: the returned value fits the SDK-compatible union.
    const _typed: ResolvedOwnerAuth = auth!;
    void _typed;
  });

  it('returns oauth without client when no oauth_client_id is saved', async () => {
    mockRow({
      oauth_access_token_encrypted: 'enc_access',
      oauth_access_token_iv: 'iv_access',
      oauth_refresh_token_encrypted: 'enc_refresh',
      oauth_refresh_token_iv: 'iv_refresh',
    });
    mockedDecrypt.mockImplementation((encrypted: string) =>
      encrypted === 'enc_access' ? 'access-plaintext' : 'refresh-plaintext',
    );

    const auth = await db.resolveOwnerAuth('https://agent.example.com');
    expect(auth).toEqual({
      type: 'oauth',
      tokens: { access_token: 'access-plaintext', refresh_token: 'refresh-plaintext' },
    });
    const _typed: ResolvedOwnerAuth = auth!;
    void _typed;
  });

  it('returns oauth with public client (no secret) when secret is not saved', async () => {
    mockRow({
      oauth_access_token_encrypted: 'enc_access',
      oauth_access_token_iv: 'iv_access',
      oauth_refresh_token_encrypted: 'enc_refresh',
      oauth_refresh_token_iv: 'iv_refresh',
      oauth_client_id: 'public_client',
    });
    mockedDecrypt.mockImplementation((encrypted: string) =>
      encrypted === 'enc_access' ? 'access-plaintext' : 'refresh-plaintext',
    );

    const auth = await db.resolveOwnerAuth('https://agent.example.com');
    expect(auth).toEqual({
      type: 'oauth',
      tokens: { access_token: 'access-plaintext', refresh_token: 'refresh-plaintext' },
      client: { client_id: 'public_client' },
    });
  });

  it('falls back to raw bearer when no refresh token is saved, even if token is near expiry', async () => {
    // Previously the 5-minute buffer returned undefined here, which dropped
    // the Authorization header entirely. Sending the access token lets the
    // agent return a clear 401 rather than "Missing Authorization header".
    const expiresInTwoMinutes = new Date(Date.now() + 2 * 60 * 1000);
    mockRow({
      oauth_access_token_encrypted: 'enc_access',
      oauth_access_token_iv: 'iv_access',
      oauth_token_expires_at: expiresInTwoMinutes,
    });
    mockedDecrypt.mockReturnValueOnce('access-plaintext');

    const auth = await db.resolveOwnerAuth('https://agent.example.com');
    expect(auth).toEqual({ type: 'bearer', token: 'access-plaintext' });
  });

  it('prefers static token over OAuth when both are present', async () => {
    mockRow({
      auth_token_encrypted: 'enc_bearer',
      auth_token_iv: 'iv_bearer',
      auth_type: 'bearer',
      oauth_access_token_encrypted: 'enc_access',
      oauth_access_token_iv: 'iv_access',
      oauth_refresh_token_encrypted: 'enc_refresh',
      oauth_refresh_token_iv: 'iv_refresh',
    });
    mockedDecrypt.mockReturnValueOnce('static-bearer-plaintext');

    const auth = await db.resolveOwnerAuth('https://agent.example.com');
    expect(auth).toEqual({ type: 'bearer', token: 'static-bearer-plaintext' });
    // Exactly one decrypt call: the OAuth path must not execute.
    expect(mockedDecrypt).toHaveBeenCalledTimes(1);
  });

  it('returns oauth_client_credentials shape when configured', async () => {
    mockRow({
      oauth_cc_token_endpoint: 'https://auth.example.com/oauth/token',
      oauth_cc_client_id: 'client_abc',
      oauth_cc_client_secret_encrypted: 'enc_cc_secret',
      oauth_cc_client_secret_iv: 'iv_cc_secret',
      oauth_cc_scope: 'adcp',
      oauth_cc_resource: 'https://agent.example.com',
      oauth_cc_audience: 'https://agent.example.com',
      oauth_cc_auth_method: 'basic',
    });
    mockedDecrypt.mockReturnValueOnce('cc-secret-plaintext');

    const auth = await db.resolveOwnerAuth('https://agent.example.com');
    expect(auth).toEqual({
      type: 'oauth_client_credentials',
      credentials: {
        token_endpoint: 'https://auth.example.com/oauth/token',
        client_id: 'client_abc',
        client_secret: 'cc-secret-plaintext',
        scope: 'adcp',
        resource: 'https://agent.example.com',
        audience: 'https://agent.example.com',
        auth_method: 'basic',
      },
    });

    const _typed: ResolvedOwnerAuth = auth!;
    void _typed;
  });

  it('returns oauth_client_credentials without optional fields when none are saved', async () => {
    mockRow({
      oauth_cc_token_endpoint: 'https://auth.example.com/oauth/token',
      oauth_cc_client_id: 'client_abc',
      oauth_cc_client_secret_encrypted: 'enc_cc_secret',
      oauth_cc_client_secret_iv: 'iv_cc_secret',
    });
    mockedDecrypt.mockReturnValueOnce('cc-secret-plaintext');

    const auth = await db.resolveOwnerAuth('https://agent.example.com');
    expect(auth).toEqual({
      type: 'oauth_client_credentials',
      credentials: {
        token_endpoint: 'https://auth.example.com/oauth/token',
        client_id: 'client_abc',
        client_secret: 'cc-secret-plaintext',
      },
    });
  });

  it('drops (and logs warn on) an unrecognized oauth_cc_auth_method value', async () => {
    mockRow({
      oauth_cc_token_endpoint: 'https://auth.example.com/oauth/token',
      oauth_cc_client_id: 'client_abc',
      oauth_cc_client_secret_encrypted: 'enc_cc_secret',
      oauth_cc_client_secret_iv: 'iv_cc_secret',
      // A stale value from a migration or a rogue write — the resolver drops
      // it rather than poisoning the return type. The warn log surfaces the
      // write-path validation gap; this test asserts only the behavior, the
      // log is observed via the test runner's stderr capture.
      oauth_cc_auth_method: 'client_secret_post',
    });
    mockedDecrypt.mockReturnValueOnce('cc-secret-plaintext');

    const auth = await db.resolveOwnerAuth('https://agent.example.com');
    expect(auth).toEqual({
      type: 'oauth_client_credentials',
      credentials: {
        token_endpoint: 'https://auth.example.com/oauth/token',
        client_id: 'client_abc',
        client_secret: 'cc-secret-plaintext',
      },
    });
  });

  it('returns undefined when token_endpoint is set but client_id is missing (partial row)', async () => {
    // Partial rows shouldn't happen given the write-path validation, but are
    // defensive-guarded here — a botched migration or manual DB write must
    // not lead to emitting an invalid { credentials } shape to the SDK.
    mockRow({
      oauth_cc_token_endpoint: 'https://auth.example.com/oauth/token',
      // client_id intentionally null
      oauth_cc_client_secret_encrypted: 'enc_cc_secret',
      oauth_cc_client_secret_iv: 'iv_cc_secret',
    });

    const auth = await db.resolveOwnerAuth('https://agent.example.com');
    expect(auth).toBeUndefined();
  });

  it('returns undefined when client_secret_encrypted is set but client_secret_iv is missing', async () => {
    // Symmetric to the auth-code path's half-written-row guard.
    mockRow({
      oauth_cc_token_endpoint: 'https://auth.example.com/oauth/token',
      oauth_cc_client_id: 'client_abc',
      oauth_cc_client_secret_encrypted: 'enc_cc_secret',
      // iv intentionally null — can't decrypt without it
    });

    const auth = await db.resolveOwnerAuth('https://agent.example.com');
    expect(auth).toBeUndefined();
  });

  it('prefers auth-code OAuth over client-credentials when both are present', async () => {
    mockRow({
      oauth_access_token_encrypted: 'enc_access',
      oauth_access_token_iv: 'iv_access',
      oauth_refresh_token_encrypted: 'enc_refresh',
      oauth_refresh_token_iv: 'iv_refresh',
      oauth_cc_token_endpoint: 'https://auth.example.com/oauth/token',
      oauth_cc_client_id: 'client_abc',
      oauth_cc_client_secret_encrypted: 'enc_cc_secret',
      oauth_cc_client_secret_iv: 'iv_cc_secret',
    });
    mockedDecrypt.mockImplementation((encrypted: string) => {
      if (encrypted === 'enc_access') return 'access-plaintext';
      if (encrypted === 'enc_refresh') return 'refresh-plaintext';
      throw new Error(`unexpected decrypt call: ${encrypted}`);
    });

    const auth = await db.resolveOwnerAuth('https://agent.example.com');
    // Auth-code with a refresh token has zero round-trip cost; client-creds
    // always pays an exchange. Prefer the cheaper path when both exist.
    expect(auth).toEqual({
      type: 'oauth',
      tokens: { access_token: 'access-plaintext', refresh_token: 'refresh-plaintext' },
    });
  });

  it('returns undefined when the query throws', async () => {
    mockedQuery.mockRejectedValueOnce(new Error('db down'));
    const auth = await db.resolveOwnerAuth('https://agent.example.com');
    expect(auth).toBeUndefined();
  });
});
