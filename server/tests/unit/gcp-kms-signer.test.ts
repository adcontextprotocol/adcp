/**
 * Tests for the GCP KMS-backed RFC 9421 signing provider.
 *
 * The signer module reads two Fly secrets (GCP_SA_JSON, GCP_KMS_KEY_VERSION).
 * These tests cover the env-handling paths and the JWKS publication that
 * doesn't need a real KMS — full KMS round-trips need a mocked client and
 * are out of scope for unit tests.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createPublicKey } from 'node:crypto';

import { getGcpKmsSigningProvider, resetGcpKmsSignerForTests } from '../../src/security/gcp-kms-signer.js';
import { getPublicSigningJwks, resetJwksForTests } from '../../src/security/jwks.js';
import { EXPECTED_PUBLIC_KEY_PEM, KID } from '../../src/security/expected-public-key.js';

describe('gcp-kms-signer env handling', () => {
  const originalSa = process.env.GCP_SA_JSON;
  const originalKey = process.env.GCP_KMS_KEY_VERSION;

  beforeEach(() => {
    delete process.env.GCP_SA_JSON;
    delete process.env.GCP_KMS_KEY_VERSION;
    resetGcpKmsSignerForTests();
  });

  afterEach(() => {
    if (originalSa === undefined) delete process.env.GCP_SA_JSON;
    else process.env.GCP_SA_JSON = originalSa;
    if (originalKey === undefined) delete process.env.GCP_KMS_KEY_VERSION;
    else process.env.GCP_KMS_KEY_VERSION = originalKey;
    resetGcpKmsSignerForTests();
  });

  it('returns null when neither secret is set (dev default)', async () => {
    const provider = await getGcpKmsSigningProvider();
    expect(provider).toBeNull();
  });

  it('throws when GCP_SA_JSON is set but GCP_KMS_KEY_VERSION is not', async () => {
    process.env.GCP_SA_JSON = '{"client_email":"x@example.com","private_key":"x"}';
    await expect(getGcpKmsSigningProvider()).rejects.toThrow(/partially configured/i);
  });

  it('throws when GCP_KMS_KEY_VERSION is set but GCP_SA_JSON is not', async () => {
    process.env.GCP_KMS_KEY_VERSION = 'projects/p/locations/l/keyRings/r/cryptoKeys/k/cryptoKeyVersions/1';
    await expect(getGcpKmsSigningProvider()).rejects.toThrow(/partially configured/i);
  });

  it('throws when GCP_SA_JSON is not valid JSON', async () => {
    process.env.GCP_SA_JSON = 'not json';
    process.env.GCP_KMS_KEY_VERSION = 'projects/p/locations/l/keyRings/r/cryptoKeys/k/cryptoKeyVersions/1';
    await expect(getGcpKmsSigningProvider()).rejects.toThrow(/not valid JSON/i);
  });

  it('throws when GCP_SA_JSON lacks client_email or private_key', async () => {
    process.env.GCP_SA_JSON = '{"client_email":"x@example.com"}';
    process.env.GCP_KMS_KEY_VERSION = 'projects/p/locations/l/keyRings/r/cryptoKeys/k/cryptoKeyVersions/1';
    await expect(getGcpKmsSigningProvider()).rejects.toThrow(/client_email.*private_key|private_key.*client_email/i);
  });

  it('JSON.parse error message does NOT include parser detail (parser offset can quote secret bytes)', async () => {
    process.env.GCP_SA_JSON = '{"private_key":"-----BEGIN ROOT_OF_TRUST_BYTES-----';
    process.env.GCP_KMS_KEY_VERSION = 'projects/p/locations/l/keyRings/r/cryptoKeys/k/cryptoKeyVersions/1';
    await expect(getGcpKmsSigningProvider()).rejects.toThrow(/^GCP_SA_JSON is not valid JSON$/);
    // Negative assertion: the rejected error must not echo the malformed payload.
    await expect(
      getGcpKmsSigningProvider().catch((e: Error) => e.message)
    ).resolves.not.toMatch(/ROOT_OF_TRUST_BYTES|position \d+|Unexpected/);
  });

  it('concurrent first calls share one in-flight init (env-rejection path)', async () => {
    process.env.GCP_SA_JSON = '{"client_email":"x@example.com"}';
    process.env.GCP_KMS_KEY_VERSION = 'projects/p/locations/l/keyRings/r/cryptoKeys/k/cryptoKeyVersions/1';
    // Both should reject for the same reason (missing private_key) — and the
    // race-fix guarantees they don't fan out to two independent KMS clients
    // even when the rejection is synchronous-ish.
    const [a, b] = await Promise.allSettled([
      getGcpKmsSigningProvider(),
      getGcpKmsSigningProvider(),
    ]);
    expect(a.status).toBe('rejected');
    expect(b.status).toBe('rejected');
  });
});

describe('getPublicSigningJwks', () => {
  beforeEach(() => {
    resetJwksForTests();
  });

  it('publishes one Ed25519 JWK with the expected kid', () => {
    const jwks = getPublicSigningJwks();
    expect(jwks.keys).toHaveLength(1);
    const jwk = jwks.keys[0];
    expect(jwk.kty).toBe('OKP');
    expect(jwk.crv).toBe('Ed25519');
    expect(jwk.alg).toBe('EdDSA');
    expect(jwk.use).toBe('sig');
    expect(jwk.adcp_use).toBe('request-signing');
    expect(jwk.kid).toBe(KID);
    expect(jwk.key_ops).toEqual(['verify']);
  });

  it('JWK x parameter matches the committed PEM public key', () => {
    const jwks = getPublicSigningJwks();
    const jwk = jwks.keys[0];
    const pemDerived = createPublicKey(EXPECTED_PUBLIC_KEY_PEM).export({ format: 'jwk' }) as { x?: string };
    expect(jwk.x).toBe(pemDerived.x);
  });

  it('returns the same object on repeated calls (cache)', () => {
    const a = getPublicSigningJwks();
    const b = getPublicSigningJwks();
    expect(a).toBe(b);
  });
});
