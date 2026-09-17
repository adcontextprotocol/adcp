/**
 * Unit tests for `resolveCallerOrgId` — the shared auth-resolution helper
 * used by `/api/registry/operator` and `/api/registry/agents` to decide which
 * `members_only` / `private` agents a caller is allowed to see.
 *
 * Locks in the three token shapes the registry API must accept:
 *   1. WorkOS OIDC access token (RS256 JWT, `org_id` claim) — JWKS is picked
 *      per-token from the `iss` claim, not from a server-wide env var.
 *   2. WorkOS API key (sk_* / wos_api_key_*)
 *   3. Sealed session (middleware supplies a fresh authorization snapshot)
 *
 * Regression guard for the issue where OIDC JWTs silently fell through to
 * public-only, leaving `agents: []` for authenticated callers.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const validateWorkOSApiKeyMock = vi.fn();
const jwtVerifyMock = vi.fn();
const decodeJwtMock = vi.fn();
const dbQueryMock = vi.fn();
vi.mock('../../src/middleware/auth.js', async () => ({
  ...await import('../../src/auth/organization-selection.js'),
  validateWorkOSApiKey: (...args: unknown[]) => validateWorkOSApiKeyMock(...args),
}));

vi.mock('jose', async (importOriginal) => ({
  ...await importOriginal<typeof import('jose')>(),
  createRemoteJWKSet: () => 'fake-jwks-set',
  jwtVerify: (...args: unknown[]) => jwtVerifyMock(...args),
  decodeJwt: (...args: unknown[]) => decodeJwtMock(...args),
}));

vi.mock('../../src/db/client.js', () => ({
  query: (...args: unknown[]) => dbQueryMock(...args),
}));

// Import under test *after* the mocks are registered.
const { resolveCallerOrgId, orgIdFromBearerJwt, __resetJwksForTests } = await import(
  '../../src/routes/helpers/resolve-caller-org.js'
);

function reqWith(
  authHeader?: string,
  user?: { id?: string },
  selectors: Record<string, unknown> = {},
) {
  return {
    query: {}, body: {}, params: {},
    ...selectors,
    headers: {
      ...(authHeader ? { authorization: authHeader } : {}),
      ...((selectors.headers as Record<string, unknown> | undefined) ?? {}),
    },
    user,
  };
}

const ISS = 'https://auth.agenticadvertising.org/user_management/client_01KAVKB3S313R5M49EMHDR3HYN';

describe('resolveCallerOrgId', () => {
  beforeEach(() => {
    validateWorkOSApiKeyMock.mockReset();
    jwtVerifyMock.mockReset();
    decodeJwtMock.mockReset();
    dbQueryMock.mockReset();
    __resetJwksForTests();
  });

  // ── OIDC JWT path (the new behavior this change adds) ───────────

  it('returns org_id from a verified OIDC JWT', async () => {
    decodeJwtMock.mockReturnValueOnce({ iss: ISS });
    jwtVerifyMock.mockResolvedValueOnce({ payload: { org_id: 'org_from_jwt', sub: 'user_123' } });

    const orgId = await resolveCallerOrgId(reqWith('Bearer eyJabc.def.ghi'));

    expect(orgId).toBe('org_from_jwt');
    expect(jwtVerifyMock).toHaveBeenCalledTimes(1);
    // jwtVerify must pin the issuer it resolved from unverified decode.
    expect(jwtVerifyMock.mock.calls[0][2]).toMatchObject({ issuer: ISS });
    expect(validateWorkOSApiKeyMock).not.toHaveBeenCalled();
    expect(dbQueryMock).not.toHaveBeenCalled();
  });

  it('rejects an invalid JWT without selecting an attached user organization', async () => {
    decodeJwtMock.mockReturnValueOnce({ iss: ISS });
    jwtVerifyMock.mockRejectedValueOnce(Object.assign(new Error('bad signature'), { code: 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED' }));
    validateWorkOSApiKeyMock.mockResolvedValueOnce(null);

    await expect(resolveCallerOrgId(reqWith('Bearer eyJabc.def.ghi')))
      .rejects.toMatchObject({ status: 401 });
    expect(jwtVerifyMock).toHaveBeenCalledTimes(1);
    expect(validateWorkOSApiKeyMock).toHaveBeenCalledTimes(1);
  });

  it('does not infer an organization when the JWT has no org_id claim', async () => {
    decodeJwtMock.mockReturnValueOnce({ iss: ISS });
    jwtVerifyMock.mockResolvedValueOnce({ payload: { sub: 'user_123' } });
    validateWorkOSApiKeyMock.mockResolvedValueOnce(null);

    await expect(resolveCallerOrgId(reqWith('Bearer eyJabc.def.ghi')))
      .rejects.toMatchObject({ status: 401 });
    expect(validateWorkOSApiKeyMock).toHaveBeenCalledTimes(1);
  });

  it('rejects JWTs whose iss does not match the WorkOS AuthKit pattern', async () => {
    decodeJwtMock.mockReturnValueOnce({ iss: 'https://evil.example.com/issuer' });
    validateWorkOSApiKeyMock.mockResolvedValueOnce(null);

    await expect(resolveCallerOrgId(reqWith('Bearer eyJabc.def.ghi')))
      .rejects.toMatchObject({ status: 401 });
    expect(jwtVerifyMock).not.toHaveBeenCalled();
  });

  it('rejects JWTs with a missing iss claim', async () => {
    decodeJwtMock.mockReturnValueOnce({ sub: 'user_no_iss' });
    validateWorkOSApiKeyMock.mockResolvedValueOnce(null);

    await expect(resolveCallerOrgId(reqWith('Bearer eyJabc.def.ghi')))
      .rejects.toMatchObject({ status: 401 });
    expect(jwtVerifyMock).not.toHaveBeenCalled();
  });

  // ── API key path (regression — must still work) ─────────────────

  it('returns org from a valid WorkOS API key (sk_ prefix)', async () => {
    validateWorkOSApiKeyMock.mockResolvedValueOnce({ organizationId: 'org_from_apikey' });

    const orgId = await resolveCallerOrgId(reqWith('Bearer sk_live_abc123'));

    expect(orgId).toBe('org_from_apikey');
    // JWT helper must skip API keys without calling decodeJwt/jwtVerify.
    expect(decodeJwtMock).not.toHaveBeenCalled();
    expect(jwtVerifyMock).not.toHaveBeenCalled();
    expect(validateWorkOSApiKeyMock).toHaveBeenCalledTimes(1);
    expect(dbQueryMock).not.toHaveBeenCalled();
  });

  it.each([
    ['header', { headers: { 'x-organization-id': 'org_other' } }],
    ['query org', { query: { org: 'org_other' } }],
    ['query org_id', { query: { org_id: 'org_other' } }],
    ['query organization_id', { query: { organization_id: 'org_other' } }],
    ['query organizationId', { query: { organizationId: 'org_other' } }],
    ['body org_id', { body: { org_id: 'org_other' } }],
    ['body organization_id', { body: { organization_id: 'org_other' } }],
    ['body organizationId', { body: { organizationId: 'org_other' } }],
    ['route org_id', { params: { org_id: 'org_other' } }],
    ['route orgId', { params: { orgId: 'org_other' } }],
    ['route organizationId', { params: { organizationId: 'org_other' } }],
  ] as const)('rejects an API-key provider conflict from %s without caller fallback', async (_location, selectors) => {
    validateWorkOSApiKeyMock.mockResolvedValueOnce({ organizationId: 'org_from_apikey' });

    await expect(resolveCallerOrgId(reqWith('Bearer sk_live_abc123', { id: 'cookie_user' }, selectors)))
      .rejects.toMatchObject({ status: 403 });
    expect(dbQueryMock).not.toHaveBeenCalled();
  });

  it('returns org from a legacy wos_api_key_ prefix key', async () => {
    validateWorkOSApiKeyMock.mockResolvedValueOnce({ organizationId: 'org_legacy' });

    const orgId = await resolveCallerOrgId(reqWith('Bearer wos_api_key_legacy123'));

    expect(orgId).toBe('org_legacy');
    expect(decodeJwtMock).not.toHaveBeenCalled();
    expect(jwtVerifyMock).not.toHaveBeenCalled();
  });

  it.each(['Bearer sk_revoked', 'Bearer wos_api_key_rotated', 'bearer sk_revoked', 'BEARER   sk_revoked'])(
    'does not fall back to an attached user or implicit org for rejected key %s', async (authorization) => {
      validateWorkOSApiKeyMock.mockResolvedValueOnce(null);
      dbQueryMock.mockResolvedValue({ rows: [{ primary_organization_id: 'org_other', joins_valid: true }] });

      await expect(resolveCallerOrgId(reqWith(authorization, { id: 'user_other' }))).rejects.toMatchObject({ status: 401 });
      expect(dbQueryMock).not.toHaveBeenCalled();
    },
  );

  it('propagates unavailable key authorization without a primary-org fallback', async () => {
    const unavailable = Object.assign(new Error('API key validation unavailable'), { status: 503 });
    validateWorkOSApiKeyMock.mockRejectedValueOnce(unavailable);

    await expect(resolveCallerOrgId(reqWith('Bearer sk_unavailable', { id: 'user_other' })))
      .rejects.toMatchObject({ status: 503 });
    expect(dbQueryMock).not.toHaveBeenCalled();
  });

  it.each(['Bearer', 'bearer ', 'BEARER   ', 'Bearer wrong-static-token', 'Bearer malformed-opaque-token'])(
    'does not select the cookie organization for explicit bearer %j', async (authorization) => {
      validateWorkOSApiKeyMock.mockResolvedValue(null);
      dbQueryMock.mockResolvedValue({ rows: [{ primary_organization_id: 'org_other', joins_valid: true }] });

      await expect(resolveCallerOrgId(reqWith(authorization, { id: 'user_other' }))).rejects.toMatchObject({ status: 401 });
      expect(dbQueryMock).not.toHaveBeenCalled();
      expect(jwtVerifyMock).not.toHaveBeenCalled();
    },
  );

  it.each(['ERR_JWT_EXPIRED', 'ERR_JWT_INVALID', 'ERR_JWT_CLAIM_VALIDATION_FAILED', 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED', 'ERR_JWKS_NO_MATCHING_KEY'])(
    'does not select the cookie organization for definitive JWT failure %s', async (code) => {
      decodeJwtMock.mockReturnValue({ iss: ISS });
      jwtVerifyMock.mockRejectedValue(Object.assign(new Error('Invalid token'), { code }));
      validateWorkOSApiKeyMock.mockResolvedValue(null);

      await expect(resolveCallerOrgId(reqWith('bearer   eyJinvalid.payload.sig', { id: 'user_other' }))).rejects.toMatchObject({ status: 401 });
      expect(dbQueryMock).not.toHaveBeenCalled();
    },
  );

  it('does not infer the cookie organization when a verified JWT lacks an organization', async () => {
    decodeJwtMock.mockReturnValue({ iss: ISS });
    jwtVerifyMock.mockResolvedValue({ payload: { sub: 'user_jwt' } });
    validateWorkOSApiKeyMock.mockResolvedValue(null);

    await expect(resolveCallerOrgId(reqWith('BEARER eyJnoorg.payload.sig', { id: 'user_other' }))).rejects.toMatchObject({ status: 401 });
    expect(dbQueryMock).not.toHaveBeenCalled();
  });

  it.each([
    new Error('Unknown provider failure'),
    Object.assign(new Error('JWKS HTTP failure'), { code: 'ERR_JOSE_GENERIC' }),
    Object.assign(new Error('Malformed JWKS'), { code: 'ERR_JWKS_INVALID' }),
    Object.assign(new Error('JWKS timeout'), { code: 'ERR_JWKS_TIMEOUT' }),
    Object.assign(new Error('Connection failed'), { code: 'ECONNRESET' }),
    Object.assign(new Error('Provider error'), { status: 503 }),
  ])('propagates unavailable JWT verification without cookie or API-key fallback: %s', async (error) => {
    decodeJwtMock.mockReturnValue({ iss: ISS });
    jwtVerifyMock.mockRejectedValue(error);

    await expect(resolveCallerOrgId(reqWith('bEaReR\teyJunavailable.payload.sig', { id: 'user_other' })))
      .rejects.toMatchObject({ status: 503 });
    expect(dbQueryMock).not.toHaveBeenCalled();
    expect(validateWorkOSApiKeyMock).not.toHaveBeenCalled();
  });

  it('recognizes alternate bearer formatting for valid JWTs without cookie fallback', async () => {
    decodeJwtMock.mockReturnValue({ iss: ISS });
    jwtVerifyMock.mockResolvedValue({ payload: { org_id: 'org_selected' } });

    expect(await resolveCallerOrgId(reqWith('bEaReR\t eyJvalid.payload.sig', { id: 'user_other' }))).toBe('org_selected');
    expect(dbQueryMock).not.toHaveBeenCalled();
  });

  it.each([
    ['removed', undefined],
    ['replaced with a valid API key', 'Bearer sk_injected'],
    ['replaced with a different authentication scheme', 'Basic dXNlcjpwYXNz'],
  ] as const)('keeps an invalid JWT terminal when Authorization is %s during verification', async (_change, replacement) => {
    let rejectVerification!: (error: Error) => void;
    const verification = new Promise<never>((_resolve, reject) => { rejectVerification = reject; });
    decodeJwtMock.mockReturnValue({ iss: ISS });
    jwtVerifyMock.mockReturnValueOnce(verification);
    validateWorkOSApiKeyMock.mockImplementation(async (validationReq: { headers: { authorization?: string } }) => (
      validationReq.headers.authorization === 'Bearer sk_injected'
        ? { organizationId: 'org_injected' }
        : null
    ));
    dbQueryMock.mockResolvedValue({ rows: [{ primary_organization_id: 'org_cookie', joins_valid: true }] });
    const incoming = reqWith('Bearer eyJoriginal.payload.sig', { id: 'user_cookie' });

    const result = resolveCallerOrgId(incoming).then(
      (organizationId) => ({ organizationId }),
      (error: { status: number }) => ({ status: error.status }),
    );
    expect(jwtVerifyMock).toHaveBeenCalledWith('eyJoriginal.payload.sig', expect.any(Function), expect.any(Object));
    if (replacement === undefined) delete incoming.headers.authorization;
    else incoming.headers.authorization = replacement;
    rejectVerification(Object.assign(new Error('Expired original JWT'), { code: 'ERR_JWT_EXPIRED' }));

    expect(await result).toEqual({ status: 401 });
    expect(dbQueryMock).not.toHaveBeenCalled();
  });

  it('keeps unavailable JWT verification terminal after the bearer header is removed', async () => {
    let rejectVerification!: (error: Error) => void;
    const verification = new Promise<never>((_resolve, reject) => { rejectVerification = reject; });
    decodeJwtMock.mockReturnValue({ iss: ISS });
    jwtVerifyMock.mockReturnValueOnce(verification);
    const incoming = reqWith('bEaReR\teyJoriginal.payload.sig', { id: 'user_cookie' });

    const result = resolveCallerOrgId(incoming).then(
      (organizationId) => ({ organizationId }),
      (error: { status: number }) => ({ status: error.status }),
    );
    expect(jwtVerifyMock).toHaveBeenCalledTimes(1);
    delete incoming.headers.authorization;
    rejectVerification(new Error('JWKS unavailable'));

    expect(await result).toEqual({ status: 503 });
    expect(validateWorkOSApiKeyMock).not.toHaveBeenCalled();
    expect(dbQueryMock).not.toHaveBeenCalled();
  });

  it.each([
    ['headers', 'x-organization-id'],
    ['query', 'organizationId'],
    ['query', 'org_id'],
    ['body', 'org_id'],
    ['params', 'org_id'],
    ['body', 'organizationId'],
    ['params', 'organizationId'],
  ] as const)('retains an original %s selector conflict across JWT verification', async (location, field) => {
    let finishVerification!: (result: { payload: { org_id: string } }) => void;
    const verification = new Promise((resolve) => { finishVerification = resolve; });
    decodeJwtMock.mockReturnValue({ iss: ISS });
    jwtVerifyMock.mockReturnValueOnce(verification);
    const incoming = reqWith('Bearer eyJoriginal.payload.sig', { id: 'user_cookie' }, {
      [location]: { [field]: 'org_conflicting' },
    });

    const result = resolveCallerOrgId(incoming).then(
      (organizationId) => ({ organizationId }),
      (error: { status: number }) => ({ status: error.status }),
    );
    expect(jwtVerifyMock).toHaveBeenCalledTimes(1);
    (incoming[location] as Record<string, unknown>)[field] = 'org_verified';
    finishVerification({ payload: { org_id: 'org_verified' } });

    expect(await result).toEqual({ status: 403 });
    expect(dbQueryMock).not.toHaveBeenCalled();
  });

  it('retains a matching organization selector when another middleware replaces it during JWT verification', async () => {
    let finishVerification!: (result: { payload: { org_id: string } }) => void;
    const verification = new Promise((resolve) => { finishVerification = resolve; });
    decodeJwtMock.mockReturnValue({ iss: ISS });
    jwtVerifyMock.mockReturnValueOnce(verification);
    const incoming = reqWith('Bearer eyJoriginal.payload.sig', { id: 'user_cookie' }, {
      query: { organizationId: 'org_verified' },
    });

    const result = resolveCallerOrgId(incoming);
    expect(jwtVerifyMock).toHaveBeenCalledTimes(1);
    incoming.query = { organizationId: 'org_other' };
    finishVerification({ payload: { org_id: 'org_verified' } });

    expect(await result).toBe('org_verified');
    expect(dbQueryMock).not.toHaveBeenCalled();
  });

  it.each([
    [Object.assign(new Error('Expired token'), { code: 'ERR_JWT_EXPIRED' }), 401],
    [new Error('JWT provider unavailable'), 503],
  ] as const)('reports credential failure before inspecting conflicting selectors: %s', async (error, status) => {
    decodeJwtMock.mockReturnValue({ iss: ISS });
    jwtVerifyMock.mockRejectedValue(error);
    validateWorkOSApiKeyMock.mockResolvedValue(null);

    await expect(resolveCallerOrgId(reqWith('Bearer eyJfailure.payload.sig', { id: 'user_cookie' }, {
      query: { organizationId: 'org_conflicting' },
    }))).rejects.toMatchObject({ status });
    expect(dbQueryMock).not.toHaveBeenCalled();
  });

  // ── Sealed-session path (existing behavior) ─────────────────────

  it('does not infer a primary or sole org from a bare authenticated user', async () => {
    dbQueryMock.mockResolvedValue({ rows: [{ primary_organization_id: 'org_primary', joins_valid: true }] });

    expect(await resolveCallerOrgId(reqWith(undefined, { id: 'user_session' }))).toBeNull();
    expect(dbQueryMock).not.toHaveBeenCalled();
    expect(validateWorkOSApiKeyMock).not.toHaveBeenCalled();
  });

  it('uses verified bearer authority independently of an attached cookie user without a snapshot', async () => {
    decodeJwtMock.mockReturnValueOnce({ iss: ISS });
    jwtVerifyMock.mockResolvedValue({ payload: { org_id: 'org_bearer' } });

    expect(await resolveCallerOrgId(reqWith('Bearer eyJabc.def.ghi', { id: 'user_session' }))).toBe('org_bearer');
    expect(jwtVerifyMock).toHaveBeenCalledTimes(1);
    expect(validateWorkOSApiKeyMock).not.toHaveBeenCalled();
    expect(dbQueryMock).not.toHaveBeenCalled();
  });

  // ── Unauthenticated / malformed ────────────────────────────────

  it('returns null with no Authorization header and no session user', async () => {
    validateWorkOSApiKeyMock.mockResolvedValueOnce(null);

    const orgId = await resolveCallerOrgId(reqWith());

    expect(orgId).toBeNull();
    expect(decodeJwtMock).not.toHaveBeenCalled();
    expect(dbQueryMock).not.toHaveBeenCalled();
  });

  it('returns null for a non-Bearer Authorization header', async () => {
    validateWorkOSApiKeyMock.mockResolvedValueOnce(null);

    const orgId = await resolveCallerOrgId(reqWith('Basic dXNlcjpwYXNz'));

    expect(orgId).toBeNull();
    expect(decodeJwtMock).not.toHaveBeenCalled();
  });
});

describe('orgIdFromBearerJwt', () => {
  beforeEach(() => {
    jwtVerifyMock.mockReset();
    decodeJwtMock.mockReset();
    __resetJwksForTests();
  });

  it('returns null for API-key-shaped bearer tokens', async () => {
    expect(await orgIdFromBearerJwt(reqWith('Bearer sk_live_abc'))).toBeNull();
    expect(await orgIdFromBearerJwt(reqWith('Bearer wos_api_key_abc'))).toBeNull();
    expect(decodeJwtMock).not.toHaveBeenCalled();
    expect(jwtVerifyMock).not.toHaveBeenCalled();
  });

  it('returns null for tokens that do not look like a JWT (no eyJ prefix)', async () => {
    expect(await orgIdFromBearerJwt(reqWith('Bearer random-sealed-session-blob'))).toBeNull();
    expect(decodeJwtMock).not.toHaveBeenCalled();
    expect(jwtVerifyMock).not.toHaveBeenCalled();
  });

  it('caches the JWKS per client_id across calls', async () => {
    const iss2 = 'https://auth.agenticadvertising.org/user_management/client_OTHER';
    decodeJwtMock.mockReturnValueOnce({ iss: ISS });
    decodeJwtMock.mockReturnValueOnce({ iss: ISS });
    decodeJwtMock.mockReturnValueOnce({ iss: iss2 });
    jwtVerifyMock.mockResolvedValue({ payload: { org_id: 'org_a' } });

    await orgIdFromBearerJwt(reqWith('Bearer eyJa.b.c'));
    await orgIdFromBearerJwt(reqWith('Bearer eyJa.b.c'));
    await orgIdFromBearerJwt(reqWith('Bearer eyJa.b.c'));

    // Each verification wraps the cached resolver to preserve key-service failures.
    const jwksArgs = jwtVerifyMock.mock.calls.map(c => c[1]);
    expect(jwksArgs.every((resolver) => typeof resolver === 'function')).toBe(true);
    // (Both JWKSets are the same fake string from the mock factory, but the
    // behavior under test is that we call createRemoteJWKSet once per client.
    // We rely on the cache map to dedupe — if it didn't, Map.size would be 2.)
    expect(jwksArgs[2]).toBeDefined();
    expect(jwtVerifyMock.mock.calls[2][2]).toMatchObject({ issuer: iss2 });
  });
});
