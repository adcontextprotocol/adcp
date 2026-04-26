/**
 * Tests for the GCP KMS-backed RFC 9421 signing providers (request +
 * webhook). Covers the env-handling paths and the JWKS publication that
 * doesn't need a real KMS — full KMS round-trips need a mocked client and
 * are out of scope for unit tests.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createPublicKey } from 'node:crypto';

import {
  getRequestSigningProvider,
  getWebhookSigningProvider,
  resetGcpKmsSignerForTests,
} from '../../src/security/gcp-kms-signer.js';
import { getPublicSigningJwks, resetJwksForTests } from '../../src/security/jwks.js';
import {
  REQUEST_SIGNING_PUBLIC_KEY_PEM,
  REQUEST_SIGNING_KID,
  WEBHOOK_SIGNING_PUBLIC_KEY_PEM,
  WEBHOOK_SIGNING_KID,
} from '../../src/security/expected-public-key.js';

describe('gcp-kms-signer env handling — request signing', () => {
  const originalSa = process.env.GCP_SA_JSON;
  const originalReq = process.env.GCP_KMS_KEY_VERSION;
  const originalWh = process.env.GCP_KMS_WEBHOOK_KEY_VERSION;

  beforeEach(() => {
    delete process.env.GCP_SA_JSON;
    delete process.env.GCP_KMS_KEY_VERSION;
    delete process.env.GCP_KMS_WEBHOOK_KEY_VERSION;
    resetGcpKmsSignerForTests();
  });

  afterEach(() => {
    if (originalSa === undefined) delete process.env.GCP_SA_JSON;
    else process.env.GCP_SA_JSON = originalSa;
    if (originalReq === undefined) delete process.env.GCP_KMS_KEY_VERSION;
    else process.env.GCP_KMS_KEY_VERSION = originalReq;
    if (originalWh === undefined) delete process.env.GCP_KMS_WEBHOOK_KEY_VERSION;
    else process.env.GCP_KMS_WEBHOOK_KEY_VERSION = originalWh;
    resetGcpKmsSignerForTests();
  });

  it('returns null when neither secret is set (dev default)', async () => {
    expect(await getRequestSigningProvider()).toBeNull();
  });

  it('throws when GCP_SA_JSON is set but GCP_KMS_KEY_VERSION is not', async () => {
    process.env.GCP_SA_JSON = '{"client_email":"x@example.com","private_key":"x"}';
    await expect(getRequestSigningProvider()).rejects.toThrow(/partially configured/i);
  });

  it('throws when GCP_KMS_KEY_VERSION is set but GCP_SA_JSON is not', async () => {
    process.env.GCP_KMS_KEY_VERSION = 'projects/p/locations/l/keyRings/r/cryptoKeys/k/cryptoKeyVersions/1';
    await expect(getRequestSigningProvider()).rejects.toThrow(/partially configured/i);
  });

  it('throws when GCP_SA_JSON is not valid JSON', async () => {
    process.env.GCP_SA_JSON = 'not json';
    process.env.GCP_KMS_KEY_VERSION = 'projects/p/locations/l/keyRings/r/cryptoKeys/k/cryptoKeyVersions/1';
    await expect(getRequestSigningProvider()).rejects.toThrow(/not valid JSON/i);
  });

  it('throws when GCP_SA_JSON lacks client_email or private_key', async () => {
    process.env.GCP_SA_JSON = '{"client_email":"x@example.com"}';
    process.env.GCP_KMS_KEY_VERSION = 'projects/p/locations/l/keyRings/r/cryptoKeys/k/cryptoKeyVersions/1';
    await expect(getRequestSigningProvider()).rejects.toThrow(/client_email.*private_key|private_key.*client_email/i);
  });

  it('JSON.parse error message does NOT include parser detail (parser offset can quote secret bytes)', async () => {
    process.env.GCP_SA_JSON = '{"private_key":"-----BEGIN ROOT_OF_TRUST_BYTES-----';
    process.env.GCP_KMS_KEY_VERSION = 'projects/p/locations/l/keyRings/r/cryptoKeys/k/cryptoKeyVersions/1';
    await expect(getRequestSigningProvider()).rejects.toThrow(/^GCP_SA_JSON is not valid JSON$/);
    await expect(
      getRequestSigningProvider().catch((e: Error) => e.message)
    ).resolves.not.toMatch(/ROOT_OF_TRUST_BYTES|position \d+|Unexpected/);
  });

  it('concurrent first calls share one in-flight init (env-rejection path)', async () => {
    process.env.GCP_SA_JSON = '{"client_email":"x@example.com"}';
    process.env.GCP_KMS_KEY_VERSION = 'projects/p/locations/l/keyRings/r/cryptoKeys/k/cryptoKeyVersions/1';
    const [a, b] = await Promise.allSettled([
      getRequestSigningProvider(),
      getRequestSigningProvider(),
    ]);
    expect(a.status).toBe('rejected');
    expect(b.status).toBe('rejected');
  });
});

describe('gcp-kms-signer env handling — webhook signing', () => {
  const originalSa = process.env.GCP_SA_JSON;
  const originalReq = process.env.GCP_KMS_KEY_VERSION;
  const originalWh = process.env.GCP_KMS_WEBHOOK_KEY_VERSION;

  beforeEach(() => {
    delete process.env.GCP_SA_JSON;
    delete process.env.GCP_KMS_KEY_VERSION;
    delete process.env.GCP_KMS_WEBHOOK_KEY_VERSION;
    resetGcpKmsSignerForTests();
  });

  afterEach(() => {
    if (originalSa === undefined) delete process.env.GCP_SA_JSON;
    else process.env.GCP_SA_JSON = originalSa;
    if (originalReq === undefined) delete process.env.GCP_KMS_KEY_VERSION;
    else process.env.GCP_KMS_KEY_VERSION = originalReq;
    if (originalWh === undefined) delete process.env.GCP_KMS_WEBHOOK_KEY_VERSION;
    else process.env.GCP_KMS_WEBHOOK_KEY_VERSION = originalWh;
    resetGcpKmsSignerForTests();
  });

  it('returns null when neither secret is set', async () => {
    expect(await getWebhookSigningProvider()).toBeNull();
  });

  it('throws when GCP_SA_JSON is set but GCP_KMS_WEBHOOK_KEY_VERSION is not', async () => {
    process.env.GCP_SA_JSON = '{"client_email":"x@example.com","private_key":"x"}';
    await expect(getWebhookSigningProvider()).rejects.toThrow(/webhook-signing partially configured/i);
  });

  it('request and webhook caches are independent', async () => {
    process.env.GCP_SA_JSON = '{"client_email":"x@example.com"}';
    process.env.GCP_KMS_KEY_VERSION = 'projects/p/locations/l/keyRings/r/cryptoKeys/req/cryptoKeyVersions/1';
    process.env.GCP_KMS_WEBHOOK_KEY_VERSION = 'projects/p/locations/l/keyRings/r/cryptoKeys/wh/cryptoKeyVersions/1';
    // Both reject (missing private_key in SA), independently.
    await expect(getRequestSigningProvider()).rejects.toThrow(/client_email.*private_key|private_key.*client_email/i);
    await expect(getWebhookSigningProvider()).rejects.toThrow(/client_email.*private_key|private_key.*client_email/i);
  });
});

describe('getPublicSigningJwks', () => {
  beforeEach(() => {
    resetJwksForTests();
  });

  it('publishes two JWKs — one per AdCP signing purpose', () => {
    const jwks = getPublicSigningJwks();
    expect(jwks.keys).toHaveLength(2);
    const purposes = jwks.keys.map(k => k.adcp_use).sort();
    expect(purposes).toEqual(['request-signing', 'webhook-signing']);
  });

  it('request-signing JWK shape', () => {
    const jwk = getPublicSigningJwks().keys.find(k => k.adcp_use === 'request-signing')!;
    expect(jwk.kty).toBe('OKP');
    expect(jwk.crv).toBe('Ed25519');
    expect(jwk.alg).toBe('EdDSA');
    expect(jwk.use).toBe('sig');
    expect(jwk.kid).toBe(REQUEST_SIGNING_KID);
    expect(jwk.key_ops).toEqual(['verify']);
    const pemDerived = createPublicKey(REQUEST_SIGNING_PUBLIC_KEY_PEM).export({ format: 'jwk' }) as { x?: string };
    expect(jwk.x).toBe(pemDerived.x);
  });

  it('webhook-signing JWK shape', () => {
    const jwk = getPublicSigningJwks().keys.find(k => k.adcp_use === 'webhook-signing')!;
    expect(jwk.kty).toBe('OKP');
    expect(jwk.crv).toBe('Ed25519');
    expect(jwk.alg).toBe('EdDSA');
    expect(jwk.use).toBe('sig');
    expect(jwk.kid).toBe(WEBHOOK_SIGNING_KID);
    expect(jwk.key_ops).toEqual(['verify']);
    const pemDerived = createPublicKey(WEBHOOK_SIGNING_PUBLIC_KEY_PEM).export({ format: 'jwk' }) as { x?: string };
    expect(jwk.x).toBe(pemDerived.x);
  });

  it('request and webhook keys have distinct material (per AdCP key-separation)', () => {
    const jwks = getPublicSigningJwks();
    const req = jwks.keys.find(k => k.adcp_use === 'request-signing')!;
    const webhook = jwks.keys.find(k => k.adcp_use === 'webhook-signing')!;
    expect(req.x).not.toBe(webhook.x);
    expect(req.kid).not.toBe(webhook.kid);
  });

  it('returns the same object on repeated calls (cache)', () => {
    const a = getPublicSigningJwks();
    const b = getPublicSigningJwks();
    expect(a).toBe(b);
  });
});
