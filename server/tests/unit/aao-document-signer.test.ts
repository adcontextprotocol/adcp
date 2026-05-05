/**
 * Unit coverage for the AAO document signer. Generates ephemeral
 * Ed25519 keys per test, sets the env vars the signer reads, then
 * exercises the round-trip: sign → embed envelope → verify → recover
 * canonical payload.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { generateKeyPair, exportJWK, jwtVerify, importJWK } from 'jose';
import {
  signHostedAdagentsDocument,
  verifyHostedAdagentsDocument,
  initAaoDocumentSigningKey,
  isAaoDocumentSigningEnabled,
  getDocumentSigningJwk,
  _resetForTesting,
} from '../../src/services/aao-document-signer.js';

async function generateAndSetKeys(): Promise<void> {
  const { publicKey, privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  // jose's exportPKCS8/exportSPKI return PEM strings. The signer expects
  // base64-encoded PEM (env-var pattern), so wrap them.
  const { exportPKCS8, exportSPKI } = await import('jose');
  const privatePem = await exportPKCS8(privateKey);
  const publicPem = await exportSPKI(publicKey);
  process.env.AAO_DOCUMENT_SIGNING_PRIVATE_KEY = Buffer.from(privatePem, 'utf8').toString('base64');
  process.env.AAO_DOCUMENT_SIGNING_PUBLIC_KEY = Buffer.from(publicPem, 'utf8').toString('base64');
}

describe('AAO document signer', () => {
  beforeEach(() => {
    _resetForTesting();
    delete process.env.AAO_DOCUMENT_SIGNING_PRIVATE_KEY;
    delete process.env.AAO_DOCUMENT_SIGNING_PUBLIC_KEY;
  });

  it('returns null when env keys are not configured', async () => {
    const result = await signHostedAdagentsDocument({ authorized_agents: [] }, 'example.com');
    expect(result).toBeNull();
    expect(isAaoDocumentSigningEnabled()).toBe(false);
    expect(getDocumentSigningJwk()).toBeNull();
  });

  describe('with ephemeral keys', () => {
    beforeAll(async () => {
      await generateAndSetKeys();
    });

    beforeEach(async () => {
      _resetForTesting();
      await generateAndSetKeys();
      await initAaoDocumentSigningKey();
    });

    it('signs a document and the JWS payload round-trips back to the input body', async () => {
      const body = {
        $schema: 'https://example/adagents.json',
        authorized_agents: [{ url: 'https://agent.example', authorized_for: 'all' }],
        properties: [{ type: 'website', name: 'example.com' }],
      };
      const env = await signHostedAdagentsDocument(body, 'example.com');
      expect(env).not.toBeNull();
      expect(env?.key_id).toBe('aao-document-1');
      expect(env?.publisher_domain).toBe('example.com');
      expect(env?.jws.split('.').length).toBe(3); // header.payload.signature

      const recovered = await verifyHostedAdagentsDocument(env!.jws, 'example.com');
      expect(recovered).not.toBeNull();
      expect(recovered).toMatchObject(body);
    });

    it('rejects verification when sub does not match the expected publisher_domain', async () => {
      const env = await signHostedAdagentsDocument({ authorized_agents: [] }, 'real.example');
      expect(env).not.toBeNull();
      const result = await verifyHostedAdagentsDocument(env!.jws, 'attacker.example');
      expect(result).toBeNull();
    });

    it('exposes the public JWK with adcp_use=aao-document-signing for JWKS publication', () => {
      const jwk = getDocumentSigningJwk();
      expect(jwk).not.toBeNull();
      expect(jwk).toMatchObject({
        kty: 'OKP',
        crv: 'Ed25519',
        alg: 'EdDSA',
        use: 'sig',
        kid: 'aao-document-1',
        adcp_use: 'aao-document-signing',
      });
    });

    it('JWS protected header carries the kid an external verifier needs', async () => {
      const env = await signHostedAdagentsDocument({ authorized_agents: [] }, 'example.com');
      expect(env).not.toBeNull();
      const headerB64 = env!.jws.split('.')[0];
      const header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8'));
      expect(header).toMatchObject({ alg: 'EdDSA', kid: 'aao-document-1', typ: 'JWT' });
    });

    it('appears in the canonical JWKS publication alongside request- and webhook-signing keys', async () => {
      const { getPublicSigningJwks, resetJwksForTests } = await import('../../src/security/jwks.js');
      resetJwksForTests();
      const jwks = getPublicSigningJwks();
      const kids = jwks.keys.map((k) => k.kid);
      expect(kids).toContain('aao-document-1');
      const docKey = jwks.keys.find((k) => k.kid === 'aao-document-1');
      expect(docKey?.adcp_use).toBe('aao-document-signing');
      expect(docKey?.kty).toBe('OKP');
      expect(docKey?.crv).toBe('Ed25519');
    });

    it('an external verifier can verify the JWS using only the published JWK', async () => {
      // Mimics what a buy-side verifier would do: fetch JWKS, find the
      // key by kid, verify the JWS without any AAO server-side helper.
      const body = { authorized_agents: [{ url: 'https://agent.example' }] };
      const env = await signHostedAdagentsDocument(body, 'example.com');
      expect(env).not.toBeNull();
      const jwk = getDocumentSigningJwk()!;
      const externalKey = await importJWK(jwk, 'EdDSA');
      const { payload } = await jwtVerify(env!.jws, externalKey, {
        issuer: 'https://aao.org',
        audience: 'aao-hosted-adagents',
        subject: 'example.com',
      });
      expect(payload).toMatchObject(body);
    });
  });
});
