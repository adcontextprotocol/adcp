/**
 * Unit tests for `resolveCallerOrgId` — the shared auth-resolution helper
 * used by `/api/registry/operator` and `/api/registry/agents` to decide which
 * `members_only` / `private` agents a caller is allowed to see.
 *
 * Locks in the three token shapes the registry API must accept:
 *   1. WorkOS OIDC access token (RS256 JWT, `org_id` claim)
 *   2. WorkOS API key (sk_* / wos_api_key_*)
 *   3. Sealed session (middleware sets `req.user`)
 *
 * Regression guard for the issue where OIDC JWTs silently fell through to
 * public-only, leaving `agents: []` for authenticated callers.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const validateWorkOSApiKeyMock = vi.fn();
const jwtVerifyMock = vi.fn();
const dbQueryMock = vi.fn();

vi.mock('../../src/middleware/auth.js', () => ({
  validateWorkOSApiKey: (...args: unknown[]) => validateWorkOSApiKeyMock(...args),
}));

vi.mock('jose', () => ({
  createRemoteJWKSet: () => 'fake-jwks-set',
  jwtVerify: (...args: unknown[]) => jwtVerifyMock(...args),
}));

vi.mock('../../src/db/client.js', () => ({
  query: (...args: unknown[]) => dbQueryMock(...args),
}));

// Import under test *after* the mocks are registered.
const { resolveCallerOrgId, orgIdFromBearerJwt, __resetJwksForTests } = await import(
  '../../src/routes/helpers/resolve-caller-org.js'
);

function reqWith(authHeader?: string, user?: { id?: string }) {
  return {
    headers: authHeader ? { authorization: authHeader } : {},
    user,
  };
}

describe('resolveCallerOrgId', () => {
  beforeEach(() => {
    validateWorkOSApiKeyMock.mockReset();
    jwtVerifyMock.mockReset();
    dbQueryMock.mockReset();
    process.env.WORKOS_CLIENT_ID = 'client_test';
    __resetJwksForTests();
  });

  // ── OIDC JWT path (the new behavior this change adds) ───────────

  it('returns org_id from a verified OIDC JWT', async () => {
    jwtVerifyMock.mockResolvedValueOnce({ payload: { org_id: 'org_from_jwt', sub: 'user_123' } });

    const orgId = await resolveCallerOrgId(reqWith('Bearer eyJabc.def.ghi'));

    expect(orgId).toBe('org_from_jwt');
    expect(jwtVerifyMock).toHaveBeenCalledTimes(1);
    expect(validateWorkOSApiKeyMock).not.toHaveBeenCalled();
    expect(dbQueryMock).not.toHaveBeenCalled();
  });

  it('falls through to API key / session when JWT verification fails', async () => {
    jwtVerifyMock.mockRejectedValueOnce(new Error('bad signature'));
    validateWorkOSApiKeyMock.mockResolvedValueOnce(null);

    const orgId = await resolveCallerOrgId(reqWith('Bearer eyJabc.def.ghi'));

    expect(orgId).toBeNull();
    expect(jwtVerifyMock).toHaveBeenCalledTimes(1);
    expect(validateWorkOSApiKeyMock).toHaveBeenCalledTimes(1);
  });

  it('falls through when the JWT has no org_id claim', async () => {
    jwtVerifyMock.mockResolvedValueOnce({ payload: { sub: 'user_123' } });
    validateWorkOSApiKeyMock.mockResolvedValueOnce(null);

    const orgId = await resolveCallerOrgId(reqWith('Bearer eyJabc.def.ghi'));

    expect(orgId).toBeNull();
    expect(validateWorkOSApiKeyMock).toHaveBeenCalledTimes(1);
  });

  // ── API key path (regression — must still work) ─────────────────

  it('returns org from a valid WorkOS API key (sk_ prefix)', async () => {
    validateWorkOSApiKeyMock.mockResolvedValueOnce({ organizationId: 'org_from_apikey' });

    const orgId = await resolveCallerOrgId(reqWith('Bearer sk_live_abc123'));

    expect(orgId).toBe('org_from_apikey');
    // JWT helper must skip API keys without calling jwtVerify.
    expect(jwtVerifyMock).not.toHaveBeenCalled();
    expect(validateWorkOSApiKeyMock).toHaveBeenCalledTimes(1);
    expect(dbQueryMock).not.toHaveBeenCalled();
  });

  it('returns org from a legacy wos_api_key_ prefix key', async () => {
    validateWorkOSApiKeyMock.mockResolvedValueOnce({ organizationId: 'org_legacy' });

    const orgId = await resolveCallerOrgId(reqWith('Bearer wos_api_key_legacy123'));

    expect(orgId).toBe('org_legacy');
    expect(jwtVerifyMock).not.toHaveBeenCalled();
  });

  // ── Sealed-session path (existing behavior) ─────────────────────

  it('falls back to users.primary_organization_id when only req.user is set', async () => {
    validateWorkOSApiKeyMock.mockResolvedValueOnce(null);
    dbQueryMock.mockResolvedValueOnce({ rows: [{ primary_organization_id: 'org_from_session' }] });

    const orgId = await resolveCallerOrgId(reqWith(undefined, { id: 'user_session' }));

    expect(orgId).toBe('org_from_session');
    expect(dbQueryMock).toHaveBeenCalledWith(
      'SELECT primary_organization_id FROM users WHERE workos_user_id = $1',
      ['user_session'],
    );
  });

  it('returns null when session user has no primary_organization_id', async () => {
    validateWorkOSApiKeyMock.mockResolvedValueOnce(null);
    dbQueryMock.mockResolvedValueOnce({ rows: [{ primary_organization_id: null }] });

    const orgId = await resolveCallerOrgId(reqWith(undefined, { id: 'user_no_org' }));

    expect(orgId).toBeNull();
  });

  it('swallows DB errors and returns null rather than throwing', async () => {
    validateWorkOSApiKeyMock.mockResolvedValueOnce(null);
    dbQueryMock.mockRejectedValueOnce(new Error('connection reset'));

    const orgId = await resolveCallerOrgId(reqWith(undefined, { id: 'user_db_err' }));

    expect(orgId).toBeNull();
  });

  // ── Unauthenticated / malformed ────────────────────────────────

  it('returns null with no Authorization header and no session user', async () => {
    validateWorkOSApiKeyMock.mockResolvedValueOnce(null);

    const orgId = await resolveCallerOrgId(reqWith());

    expect(orgId).toBeNull();
    expect(jwtVerifyMock).not.toHaveBeenCalled();
    expect(dbQueryMock).not.toHaveBeenCalled();
  });

  it('returns null for a non-Bearer Authorization header', async () => {
    validateWorkOSApiKeyMock.mockResolvedValueOnce(null);

    const orgId = await resolveCallerOrgId(reqWith('Basic dXNlcjpwYXNz'));

    expect(orgId).toBeNull();
    expect(jwtVerifyMock).not.toHaveBeenCalled();
  });
});

describe('orgIdFromBearerJwt', () => {
  beforeEach(() => {
    jwtVerifyMock.mockReset();
    process.env.WORKOS_CLIENT_ID = 'client_test';
    __resetJwksForTests();
  });

  it('returns null when WORKOS_CLIENT_ID is unset (no JWKS configured)', async () => {
    delete process.env.WORKOS_CLIENT_ID;
    __resetJwksForTests();

    const orgId = await orgIdFromBearerJwt(reqWith('Bearer eyJabc.def.ghi'));

    expect(orgId).toBeNull();
    expect(jwtVerifyMock).not.toHaveBeenCalled();
  });

  it('returns null for API-key-shaped bearer tokens', async () => {
    expect(await orgIdFromBearerJwt(reqWith('Bearer sk_live_abc'))).toBeNull();
    expect(await orgIdFromBearerJwt(reqWith('Bearer wos_api_key_abc'))).toBeNull();
    expect(jwtVerifyMock).not.toHaveBeenCalled();
  });

  it('returns null for tokens that do not look like a JWT (no eyJ prefix)', async () => {
    expect(await orgIdFromBearerJwt(reqWith('Bearer random-sealed-session-blob'))).toBeNull();
    expect(jwtVerifyMock).not.toHaveBeenCalled();
  });
});
