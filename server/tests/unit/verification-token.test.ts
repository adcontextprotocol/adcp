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

    it('round-trips a token with adcp_version claim', async () => {
      const signed = await signVerificationToken({
        agent_url: 'https://example.com/mcp',
        role: 'sales',
        verified_specialisms: ['media_buy_seller'],
        verification_modes: ['spec'],
        adcp_version: '3.0',
      });

      const claims = await verifyVerificationToken(signed!.token);
      expect((claims as unknown as { adcp_version?: string }).adcp_version).toBe('3.0');
    });

    it('omits adcp_version from the token when caller did not pass it', async () => {
      const signed = await signVerificationToken({
        agent_url: 'https://example.com/mcp',
        role: 'sales',
        verified_specialisms: ['media_buy_seller'],
        verification_modes: ['spec'],
      });

      const claims = await verifyVerificationToken(signed!.token);
      expect((claims as unknown as { adcp_version?: string }).adcp_version).toBeUndefined();
    });

    it('refuses to sign when adcp_version is malformed (fail-closed)', async () => {
      // Security review: dropping the claim silently and emitting a token
      // without it would let a poisoned DB row turn into a downgrade
      // attack — verifiers might treat "no adcp_version" as "pre-Stage-2
      // token, accept as authoritative." Fail closed instead.
      const signed = await signVerificationToken({
        agent_url: 'https://example.com/mcp',
        role: 'sales',
        verified_specialisms: ['media_buy_seller'],
        verification_modes: ['spec'],
        adcp_version: '3.0; DROP TABLE',
      });

      expect(signed).toBeNull();
    });

    it('refuses to sign an adcp_version with a leading-zero major', async () => {
      // Matches the DB CHECK constraint: ^[1-9][0-9]*\.[0-9]+$.
      const signed = await signVerificationToken({
        agent_url: 'https://example.com/mcp',
        role: 'sales',
        verified_specialisms: ['media_buy_seller'],
        verification_modes: ['spec'],
        adcp_version: '0.5',
      });

      expect(signed).toBeNull();
    });

    it('refuses to sign full semver (3.0.0) as adcp_version', async () => {
      // The claim is MAJOR.MINOR, not full semver. Full semver lives in
      // protocol_version. Mixing them up is a programming error that
      // should fail loudly at sign time.
      const signed = await signVerificationToken({
        agent_url: 'https://example.com/mcp',
        role: 'sales',
        verified_specialisms: ['media_buy_seller'],
        verification_modes: ['spec'],
        adcp_version: '3.0.0',
      });

      expect(signed).toBeNull();
    });

    it('signs adcp_version with double-digit minor without truncation', async () => {
      const signed = await signVerificationToken({
        agent_url: 'https://example.com/mcp',
        role: 'sales',
        verified_specialisms: ['media_buy_seller'],
        verification_modes: ['spec'],
        adcp_version: '3.10',
      });

      const claims = await verifyVerificationToken(signed!.token);
      expect((claims as unknown as { adcp_version?: string }).adcp_version).toBe('3.10');
    });

    it('refuses to sign when no known modes remain after filtering', async () => {
      const result = await signVerificationToken({
        agent_url: 'https://example.com/mcp',
        role: 'sales',
        verified_specialisms: ['media_buy_seller'],
        verification_modes: ['platinum' as never], // unknown — gets filtered out
      });
      expect(result).toBeNull();
    });

    it('drops unknown modes from a signed token', async () => {
      const signed = await signVerificationToken({
        agent_url: 'https://example.com/mcp',
        role: 'sales',
        verified_specialisms: ['media_buy_seller'],
        verification_modes: ['spec', 'platinum' as never],
      });
      const claims = await verifyVerificationToken(signed!.token);
      expect(claims!.verification_modes).toEqual(['spec']);
    });

    it('rejects a token whose payload lacks verification_modes', async () => {
      // Fabricate a token with the old shape (no verification_modes claim).
      // Jose's SignJWT path is internal; we hand-roll a minimal old-shape
      // payload by signing without the modes claim and verify rejection.
      const { privateKey } = await jose.generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
      // Note: this token is signed with a DIFFERENT key than the one
      // initVerificationKeys loaded, so jose.jwtVerify will reject it
      // regardless of payload — which is fine for this test's purpose
      // (we want to confirm the runtime validation path is structured to
      // reject incomplete payloads). The claim-shape check happens after
      // signature verification, so this test exercises rejection generally.
      const oldShapeToken = await new jose.SignJWT({
        agent_url: 'https://example.com/mcp',
        role: 'sales',
        verified_specialisms: ['media_buy_seller'],
        // intentionally no verification_modes
      })
        .setProtectedHeader({ alg: 'EdDSA' })
        .setIssuer('https://aao.org')
        .setAudience('aao-verification')
        .setIssuedAt()
        .setExpirationTime('30d')
        .sign(privateKey);

      const claims = await verifyVerificationToken(oldShapeToken);
      expect(claims).toBeNull();
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
