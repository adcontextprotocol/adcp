/**
 * `governance_context` JWS issuance & round-trip verification.
 *
 * Validates the training agent emits a compact-JWS token whose header, claim
 * set, and signature round-trip through the reference verifier described in
 * docs/building/by-layer/L1/security.mdx §"Reference implementation".
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import { decodeProtectedHeader, jwtVerify, importJWK, type JWK } from 'jose';
import {
  signGovernanceContext,
  GOVERNANCE_JWS_TYP,
} from '../../src/training-agent/governance-context.js';
import {
  getGovernanceSigningPublicJwk,
  resetGovernanceSigning,
} from '../../src/training-agent/governance-signing.js';

const SAMPLE_PLAN = {
  plan_id: 'plan_minimal_2026',
  brand: { domain: 'example.com' },
  objectives: 'Drive awareness for Q1 launch.',
  budget: {
    total: 100000,
    currency: 'USD',
    reallocation_threshold: 5000,
  },
  flight: {
    start: '2026-04-01T00:00:00Z',
    end: '2026-06-30T00:00:00Z',
  },
};

// Golden plan_hash from static/compliance/source/test-vectors/plan-hash/001-minimal-plan.json
const SAMPLE_PLAN_HASH = 'oR0jFDEtzcwgPbNf-Ofd_fZHYfAyD1TRbzGOFBVCG-c';

describe('signGovernanceContext — compact JWS issuance', () => {
  beforeEach(() => resetGovernanceSigning());

  it('produces a compact JWS with the AdCP JWS profile header', async () => {
    const token = await signGovernanceContext({
      issuer: 'https://gov.example.com/governance',
      audience: 'https://buyer.example.com',
      planId: SAMPLE_PLAN.plan_id,
      phase: 'intent',
      caller: 'https://buyer.example.com',
      checkId: 'chk_abc12345',
      plan: SAMPLE_PLAN,
    });

    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

    const header = decodeProtectedHeader(token);
    expect(header.alg).toBe('EdDSA');
    expect(header.typ).toBe(GOVERNANCE_JWS_TYP);
    expect(typeof header.kid).toBe('string');
    expect(header.kid).toBe(getGovernanceSigningPublicJwk().kid);
  });

  it('verifies against the published JWKS and carries the required claims', async () => {
    const token = await signGovernanceContext({
      issuer: 'https://gov.example.com/governance',
      audience: 'https://seller.example.com',
      planId: SAMPLE_PLAN.plan_id,
      phase: 'intent',
      caller: 'https://buyer.example.com',
      checkId: 'chk_round_trip',
      plan: SAMPLE_PLAN,
    });

    const publicJwk = getGovernanceSigningPublicJwk() as unknown as JWK;
    const key = await importJWK(publicJwk, 'EdDSA');
    const { payload, protectedHeader } = await jwtVerify(token, key, {
      issuer: 'https://gov.example.com/governance',
      audience: 'https://seller.example.com',
      algorithms: ['EdDSA'],
      typ: GOVERNANCE_JWS_TYP,
    });

    expect(protectedHeader.typ).toBe(GOVERNANCE_JWS_TYP);
    expect(payload.iss).toBe('https://gov.example.com/governance');
    expect(payload.aud).toBe('https://seller.example.com');
    expect(payload.sub).toBe(SAMPLE_PLAN.plan_id);
    expect(payload.phase).toBe('intent');
    expect(payload.caller).toBe('https://buyer.example.com');
    expect(payload.check_id).toBe('chk_round_trip');
    expect(typeof payload.iat).toBe('number');
    expect(typeof payload.exp).toBe('number');
    expect(payload.exp).toBeGreaterThan(payload.iat as number);
    expect(typeof payload.jti).toBe('string');
    expect(payload.plan_hash).toBe(SAMPLE_PLAN_HASH);
    expect(payload).not.toHaveProperty('media_buy_id');
  });

  it('intent-phase exp is within 15 minutes; execution-phase within 30 days', async () => {
    const intent = await signGovernanceContext({
      issuer: 'https://gov.example.com/governance',
      audience: 'https://seller.example.com',
      planId: SAMPLE_PLAN.plan_id,
      phase: 'intent',
      caller: 'https://buyer.example.com',
      checkId: 'chk_intent',
      plan: SAMPLE_PLAN,
    });
    const purchase = await signGovernanceContext({
      issuer: 'https://gov.example.com/governance',
      audience: 'https://seller.example.com',
      planId: SAMPLE_PLAN.plan_id,
      phase: 'purchase',
      caller: 'https://seller.example.com',
      checkId: 'chk_purchase',
      mediaBuyId: 'mb_123',
      plan: SAMPLE_PLAN,
    });

    const key = await importJWK(getGovernanceSigningPublicJwk() as unknown as JWK, 'EdDSA');
    const intentClaims = (await jwtVerify(intent, key, {
      issuer: 'https://gov.example.com/governance',
      audience: 'https://seller.example.com',
      algorithms: ['EdDSA'],
      typ: GOVERNANCE_JWS_TYP,
    })).payload;
    const purchaseClaims = (await jwtVerify(purchase, key, {
      issuer: 'https://gov.example.com/governance',
      audience: 'https://seller.example.com',
      algorithms: ['EdDSA'],
      typ: GOVERNANCE_JWS_TYP,
    })).payload;

    expect((intentClaims.exp as number) - (intentClaims.iat as number)).toBe(15 * 60);
    expect((purchaseClaims.exp as number) - (purchaseClaims.iat as number)).toBe(30 * 24 * 60 * 60);
    expect(purchaseClaims.media_buy_id).toBe('mb_123');
  });

  it('refuses media_buy_id on intent tokens', async () => {
    await expect(
      signGovernanceContext({
        issuer: 'https://gov.example.com/governance',
        audience: 'https://seller.example.com',
        planId: SAMPLE_PLAN.plan_id,
        phase: 'intent',
        caller: 'https://buyer.example.com',
        checkId: 'chk_bad',
        mediaBuyId: 'mb_should_not_appear',
        plan: SAMPLE_PLAN,
      }),
    ).rejects.toThrow(/media_buy_id MUST be absent on intent-phase tokens/);
  });

  it('emits a fresh jti and plan_hash mismatch on each call (no caching)', async () => {
    const a = await signGovernanceContext({
      issuer: 'https://gov.example.com/governance',
      audience: 'https://seller.example.com',
      planId: SAMPLE_PLAN.plan_id,
      phase: 'intent',
      caller: 'https://buyer.example.com',
      checkId: 'chk_a',
      plan: SAMPLE_PLAN,
    });
    const b = await signGovernanceContext({
      issuer: 'https://gov.example.com/governance',
      audience: 'https://seller.example.com',
      planId: SAMPLE_PLAN.plan_id,
      phase: 'intent',
      caller: 'https://buyer.example.com',
      checkId: 'chk_b',
      plan: SAMPLE_PLAN,
    });
    expect(a).not.toBe(b);

    const key = await importJWK(getGovernanceSigningPublicJwk() as unknown as JWK, 'EdDSA');
    const aJti = (await jwtVerify(a, key, {
      issuer: 'https://gov.example.com/governance',
      audience: 'https://seller.example.com',
      algorithms: ['EdDSA'],
      typ: GOVERNANCE_JWS_TYP,
    })).payload.jti;
    const bJti = (await jwtVerify(b, key, {
      issuer: 'https://gov.example.com/governance',
      audience: 'https://seller.example.com',
      algorithms: ['EdDSA'],
      typ: GOVERNANCE_JWS_TYP,
    })).payload.jti;
    expect(aJti).not.toBe(bJti);
  });
});
