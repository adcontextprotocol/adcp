import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SignJWT, generateKeyPair, exportJWK, type KeyLike } from 'jose';
import {
  looksLikeJWT,
  verifyWorkOSJWT,
  __setJWKSForTesting,
} from '../../src/auth/workos-jwt.js';

// WORKOS_CLIENT_ID must be set before workos-jwt.ts is imported for the
// module's `WORKOS_CLIENT_ID` constant to pick it up. Vitest evaluates
// top-level test code after module imports, so we set it at module load.
process.env.WORKOS_CLIENT_ID ??= 'client_01TESTAZPVALUE';
const EXPECTED_AZP = process.env.WORKOS_CLIENT_ID!;

describe('looksLikeJWT', () => {
  it('accepts compact JWT format (three base64url segments)', () => {
    // Three arbitrary base64url-safe segments — this heuristic only checks
    // structure, not signature, so the payload content is irrelevant.
    expect(looksLikeJWT('aaa_bbb-ccc.ddd_eee-fff.ggg_hhh-iii')).toBe(true);
  });

  it('rejects WorkOS API key formats', () => {
    expect(looksLikeJWT('sk_fake_example_key_for_testing_only')).toBe(false);
    expect(looksLikeJWT('wos_api_key_abc123')).toBe(false);
  });

  it('rejects strings with the wrong number of segments', () => {
    expect(looksLikeJWT('header.payload')).toBe(false);
    expect(looksLikeJWT('one-segment')).toBe(false);
    expect(looksLikeJWT('a.b.c.d')).toBe(false);
  });

  it('rejects strings with empty segments', () => {
    expect(looksLikeJWT('..')).toBe(false);
    expect(looksLikeJWT('a..c')).toBe(false);
    expect(looksLikeJWT('.b.c')).toBe(false);
  });

  it('rejects segments with non-base64url characters', () => {
    expect(looksLikeJWT('header.payload.signature with spaces')).toBe(false);
    expect(looksLikeJWT('header.pay+load.sig')).toBe(false);
    expect(looksLikeJWT('header.payload.sig/nature')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(looksLikeJWT('')).toBe(false);
  });
});

describe('verifyWorkOSJWT', () => {
  let privateKey: KeyLike;
  let publicKey: KeyLike;

  beforeAll(async () => {
    const kp = await generateKeyPair('RS256');
    privateKey = kp.privateKey;
    publicKey = kp.publicKey;
    const jwk = await exportJWK(publicKey);
    // Swap in a static-key resolver that matches any `alg: RS256` kid.
    __setJWKSForTesting(async () => ({ ...jwk, alg: 'RS256' }));
  });

  afterAll(() => {
    __setJWKSForTesting(null);
  });

  async function mint(claims: Record<string, unknown>, expiresIn: string | number = '5m'): Promise<string> {
    return new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256' })
      .setSubject(claims.sub as string | undefined ?? 'user_01TEST')
      .setIssuedAt()
      .setExpirationTime(expiresIn)
      .sign(privateKey);
  }

  it('accepts a valid user token and extracts claims', async () => {
    const token = await mint({
      sub: 'user_01ABC',
      azp: EXPECTED_AZP,
      org_id: 'org_01XYZ',
      email: 'test@example.com',
      scope: 'openid profile email',
    });
    const result = await verifyWorkOSJWT(token);
    expect(result.sub).toBe('user_01ABC');
    expect(result.clientId).toBe(EXPECTED_AZP);
    expect(result.orgId).toBe('org_01XYZ');
    expect(result.email).toBe('test@example.com');
    expect(result.isM2M).toBe(false);
    expect(result.scopes).toEqual(['openid', 'profile', 'email']);
  });

  it('accepts a token identified via client_id (RFC 9068 style)', async () => {
    const token = await mint({
      sub: 'user_01ABC',
      client_id: EXPECTED_AZP,
    });
    const result = await verifyWorkOSJWT(token);
    expect(result.clientId).toBe(EXPECTED_AZP);
  });

  it('rejects a token whose azp does not match WORKOS_CLIENT_ID', async () => {
    const token = await mint({
      sub: 'user_01ABC',
      azp: 'client_01DIFFERENT_APP',
    });
    await expect(verifyWorkOSJWT(token)).rejects.toThrow(/application id/);
  });

  it('rejects a token whose client_id does not match WORKOS_CLIENT_ID', async () => {
    const token = await mint({
      sub: 'user_01ABC',
      client_id: 'client_01DIFFERENT_APP',
    });
    await expect(verifyWorkOSJWT(token)).rejects.toThrow(/application id/);
  });

  it('rejects a token with no azp and no client_id', async () => {
    const token = await mint({ sub: 'user_01ABC' });
    await expect(verifyWorkOSJWT(token)).rejects.toThrow(/application id/);
  });

  it('rejects an expired token', async () => {
    const token = await mint({ sub: 'user_01ABC', azp: EXPECTED_AZP }, '-1s');
    await expect(verifyWorkOSJWT(token)).rejects.toThrow();
  });

  it('rejects a token signed by an unknown key', async () => {
    const other = await generateKeyPair('RS256');
    const token = await new SignJWT({ sub: 'user_01ABC', azp: EXPECTED_AZP })
      .setProtectedHeader({ alg: 'RS256' })
      .setExpirationTime('5m')
      .sign(other.privateKey);
    await expect(verifyWorkOSJWT(token)).rejects.toThrow();
  });

  it('flags M2M tokens (client_credentials)', async () => {
    const token = await mint({
      sub: 'client_01APP',
      azp: EXPECTED_AZP,
      grant_type: 'client_credentials',
    });
    const result = await verifyWorkOSJWT(token);
    expect(result.isM2M).toBe(true);
  });

  it('flags M2M tokens when sub starts with client_', async () => {
    const token = await mint({ sub: 'client_01APP', azp: EXPECTED_AZP });
    const result = await verifyWorkOSJWT(token);
    expect(result.isM2M).toBe(true);
  });
});
