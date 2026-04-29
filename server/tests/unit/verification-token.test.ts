import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as jose from 'jose';
import {
  initVerificationKeys,
  signVerificationToken,
  verifyVerificationToken,
  getPublicJwks,
  isTokenSigningEnabled,
  _resetForTesting,
} from '../../src/services/verification-token.js';

describe('verification-token', () => {
  describe('without keys configured', () => {
    it('reports signing disabled', () => {
      expect(isTokenSigningEnabled()).toBe(false);
    });

    it('returns null when signing', async () => {
      const result = await signVerificationToken({
        agent_url: 'https://example.com/mcp',
        role: 'sales',
        verified_specialisms: ['media_buy_seller'],
        verification_modes: ['spec'],
      });
      expect(result).toBeNull();
    });

    it('returns empty JWKS', () => {
      expect(getPublicJwks()).toEqual({ keys: [] });
    });
  });

  describe('with keys configured', () => {
    beforeAll(async () => {
      // Generate a test Ed25519 key pair and set env vars
      const { privateKey, publicKey } = await jose.generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
      const privatePem = await jose.exportPKCS8(privateKey);
      const publicPem = await jose.exportSPKI(publicKey);

      process.env.AAO_VERIFICATION_PRIVATE_KEY = Buffer.from(privatePem).toString('base64');
      process.env.AAO_VERIFICATION_PUBLIC_KEY = Buffer.from(publicPem).toString('base64');

      const initialized = await initVerificationKeys();
      expect(initialized).toBe(true);
    });

    afterAll(() => {
      _resetForTesting();
      delete process.env.AAO_VERIFICATION_PRIVATE_KEY;
      delete process.env.AAO_VERIFICATION_PUBLIC_KEY;
    });

    it('reports signing enabled', () => {
      expect(isTokenSigningEnabled()).toBe(true);
    });

    it('returns non-empty JWKS', () => {
      const jwks = getPublicJwks();
      expect(jwks.keys).toHaveLength(1);
      expect(jwks.keys[0].alg).toBe('EdDSA');
      expect(jwks.keys[0].kid).toBe('aao-verification-1');
    });

    it('signs and verifies a token round-trip', async () => {
      const signed = await signVerificationToken({
        agent_url: 'https://example.com/mcp',
        role: 'sales',
        verified_specialisms: ['media_buy_seller', 'media_buy_non_guaranteed'],
        verification_modes: ['spec'],
        protocol_version: '3.0.0',
      });

      expect(signed).not.toBeNull();
      expect(signed!.token).toBeTruthy();
      expect(signed!.expires_at).toBeInstanceOf(Date);
      expect(signed!.expires_at.getTime()).toBeGreaterThan(Date.now());

      const claims = await verifyVerificationToken(signed!.token);
      expect(claims).not.toBeNull();
      expect(claims!.agent_url).toBe('https://example.com/mcp');
      expect(claims!.role).toBe('sales');
      expect(claims!.verified_specialisms).toEqual(['media_buy_seller', 'media_buy_non_guaranteed']);
      expect(claims!.verification_modes).toEqual(['spec']);
      expect(claims!.protocol_version).toBe('3.0.0');
      expect(claims!.iss).toBe('https://aao.org');
    });

    it('round-trips a token with both spec and live modes', async () => {
      const signed = await signVerificationToken({
        agent_url: 'https://example.com/mcp',
        role: 'sales',
        verified_specialisms: ['media_buy_seller'],
        verification_modes: ['spec', 'live'],
      });

      const claims = await verifyVerificationToken(signed!.token);
      expect(claims!.verification_modes).toEqual(['spec', 'live']);
    });

    it('rejects a tampered token', async () => {
      const signed = await signVerificationToken({
        agent_url: 'https://example.com/mcp',
        role: 'sales',
        verified_specialisms: ['media_buy_seller'],
        verification_modes: ['spec'],
      });

      // Tamper with the token payload
      const tampered = signed!.token.slice(0, -5) + 'XXXXX';
      const claims = await verifyVerificationToken(tampered);
      expect(claims).toBeNull();
    });
  });
});
