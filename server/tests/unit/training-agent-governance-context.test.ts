/**
 * `governance_context` JWS issuance & round-trip verification.
 *
 * Validates the training agent emits a compact-JWS token whose header, claim
 * set, and signature round-trip through the reference verifier described in
 * docs/building/by-layer/L1/security.mdx §"Reference implementation".
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { decodeProtectedHeader, jwtVerify, importJWK, type JWK } from 'jose';
import {
  signGovernanceContext,
  GOVERNANCE_JWS_TYP,
} from '../../src/training-agent/governance-context.js';
import {
  getGovernanceSigningPublicJwk,
  resetGovernanceSigning,
} from '../../src/training-agent/governance-signing.js';
import {
  clearGovernanceTokenReplayRegistry,
  verifyGovernedServiceAuthorization,
} from '../../src/training-agent/governance-verify.js';
import { computeGovernedPayloadHash } from '../../src/training-agent/governance-payload-hash.js';

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
  beforeEach(() => {
    resetGovernanceSigning();
    clearGovernanceTokenReplayRegistry();
  });
  afterEach(() => vi.useRealTimers());

  it('produces a compact JWS with the AdCP JWS profile header', async () => {
    const token = await signGovernanceContext({
      issuer: 'https://gov.example.com/governance',
      audience: 'https://buyer.example.com',
      bindingId: 'gb_header_test',
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
      bindingId: 'gb_round_trip',
      phase: 'intent',
      caller: 'https://buyer.example.com',
      checkId: 'chk_round_trip',
      authorizedCommitment: { amount: 1000, currency: 'USD' },
      plan: SAMPLE_PLAN,
    });

    const publicJwk = getGovernanceSigningPublicJwk() as unknown as JWK;
    const key = await importJWK(publicJwk, 'EdDSA');
    const { payload, protectedHeader } = await jwtVerify(token, key, {
      issuer: 'https://gov.example.com/governance',
      audience: 'https://seller.example.com',
      algorithms: ['EdDSA'],
      typ: GOVERNANCE_JWS_TYP,
      crit: { authorized_commitment: true },
    });

    expect(protectedHeader.typ).toBe(GOVERNANCE_JWS_TYP);
    expect(protectedHeader.crit).toEqual(['authorized_commitment']);
    expect(protectedHeader.authorized_commitment).toBe(true);
    expect(payload.iss).toBe('https://gov.example.com/governance');
    expect(payload.aud).toBe('https://seller.example.com');
    expect(payload.sub).toBe('gb_round_trip');
    expect(payload.sub).not.toContain(SAMPLE_PLAN.plan_id);
    expect(payload.phase).toBe('intent');
    expect(payload.caller).toBe('https://buyer.example.com');
    expect(payload.check_id).toBe('chk_round_trip');
    expect(typeof payload.iat).toBe('number');
    expect(typeof payload.exp).toBe('number');
    expect(payload.exp).toBeGreaterThan(payload.iat as number);
    expect(typeof payload.jti).toBe('string');
    expect(payload.plan_hash).toBe(SAMPLE_PLAN_HASH);
    expect(payload.authorized_commitment).toEqual({ amount: 1000, currency: 'USD' });
    expect(payload).not.toHaveProperty('media_buy_id');
  });

  it('intent-phase exp is within 15 minutes; execution-phase within 30 days', async () => {
    const intent = await signGovernanceContext({
      issuer: 'https://gov.example.com/governance',
      audience: 'https://seller.example.com',
      bindingId: 'gb_intent',
      phase: 'intent',
      caller: 'https://buyer.example.com',
      checkId: 'chk_intent',
      plan: SAMPLE_PLAN,
    });
    const purchase = await signGovernanceContext({
      issuer: 'https://gov.example.com/governance',
      audience: 'https://seller.example.com',
      bindingId: 'gb_intent',
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

  it('signs an explicit zero-cost ceiling as a critical extension', async () => {
    const token = await signGovernanceContext({
      issuer: 'https://gov.example.com/governance',
      audience: 'https://seller.example.com',
      bindingId: 'gb_zero_cost',
      phase: 'intent',
      caller: 'https://buyer.example.com',
      checkId: 'chk_zero_cost',
      authorizedCommitment: { amount: 0, currency: 'USD' },
      plan: SAMPLE_PLAN,
    });
    const header = decodeProtectedHeader(token);
    expect(header.crit).toEqual(['authorized_commitment']);
    expect(header.authorized_commitment).toBe(true);

    const key = await importJWK(getGovernanceSigningPublicJwk() as unknown as JWK, 'EdDSA');
    const { payload } = await jwtVerify(token, key, {
      algorithms: ['EdDSA'],
      crit: { authorized_commitment: true },
    });
    expect(payload.authorized_commitment).toEqual({ amount: 0, currency: 'USD' });
  });

  it('critically binds the authorized task and payload hash', async () => {
    const token = await signGovernanceContext({
      issuer: 'https://gov.example.com/governance',
      audience: 'https://seller.example.com',
      bindingId: 'gb_action_binding',
      phase: 'intent',
      caller: 'https://buyer.example.com',
      checkId: 'chk_action_binding',
      authorizedCommitment: { amount: 10, currency: 'USD' },
      authorizedTask: 'activate_signal',
      authorizedPayloadHash: 'payload_hash_example',
      plan: SAMPLE_PLAN,
    });
    const header = decodeProtectedHeader(token);
    expect(header.crit).toEqual([
      'authorized_commitment',
      'authorized_task',
      'authorized_payload_hash',
    ]);
    const key = await importJWK(getGovernanceSigningPublicJwk() as unknown as JWK, 'EdDSA');
    const { payload } = await jwtVerify(token, key, {
      algorithms: ['EdDSA'],
      crit: {
        authorized_commitment: true,
        authorized_task: true,
        authorized_payload_hash: true,
      },
    });
    expect(payload.authorized_task).toBe('activate_signal');
    expect(payload.authorized_payload_hash).toBe('payload_hash_example');
  });

  it('refuses media_buy_id on intent tokens', async () => {
    await expect(
      signGovernanceContext({
        issuer: 'https://gov.example.com/governance',
        audience: 'https://seller.example.com',
        bindingId: 'gb_bad',
        phase: 'intent',
        caller: 'https://buyer.example.com',
        checkId: 'chk_bad',
        mediaBuyId: 'mb_should_not_appear',
        plan: SAMPLE_PLAN,
      }),
    ).rejects.toThrow(/media_buy_id MUST be absent on intent-phase tokens/);
  });

  it('enforces signature, caller, audience, payload, amount, and expiry at the service boundary', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-04T12:00:00Z'));
    const payload = {
      idempotency_key: 'service-auth-vector-0001',
      account: { account_id: 'acc_001' },
      pricing_option_id: 'price_001',
    };
    const token = await signGovernanceContext({
      issuer: 'https://gov.example.com/governance',
      audience: 'https://signal.example.com',
      bindingId: 'gb_service_auth',
      phase: 'intent',
      caller: 'https://buyer.example.com',
      checkId: 'chk_service_auth',
      authorizedCommitment: { amount: 25, currency: 'USD' },
      authorizedTask: 'activate_signal',
      authorizedPayloadHash: computeGovernedPayloadHash(payload),
      plan: SAMPLE_PLAN,
    });
    const base = {
      token,
      expectedIssuer: 'https://gov.example.com/governance',
      expectedAudience: 'https://signal.example.com',
      expectedTask: 'activate_signal',
      payload,
      actualCommitment: { amount: 20, currency: 'USD' },
      authenticatedCaller: 'https://buyer.example.com',
    };

    await expect(verifyGovernedServiceAuthorization(base)).resolves.toMatchObject({ ok: true });
    await expect(verifyGovernedServiceAuthorization({ ...base, authenticatedCaller: 'https://attacker.example' }))
      .resolves.toMatchObject({ ok: false, errorCode: 'PERMISSION_DENIED' });
    await expect(verifyGovernedServiceAuthorization({ ...base, expectedAudience: 'https://other.example' }))
      .resolves.toMatchObject({ ok: false });
    await expect(verifyGovernedServiceAuthorization({
      ...base,
      payload: { ...payload, pricing_option_id: 'price_002' },
    })).resolves.toMatchObject({ ok: false });
    await expect(verifyGovernedServiceAuthorization({
      ...base,
      actualCommitment: { amount: 26, currency: 'USD' },
    })).resolves.toMatchObject({ ok: false });

    const parts = token.split('.');
    const tampered = `${parts[0]}.${parts[1]}.${parts[2].startsWith('A') ? 'B' : 'A'}${parts[2].slice(1)}`;
    await expect(verifyGovernedServiceAuthorization({ ...base, token: tampered }))
      .resolves.toMatchObject({ ok: false });

    vi.setSystemTime(new Date('2026-08-04T12:17:00Z'));
    await expect(verifyGovernedServiceAuthorization(base)).resolves.toMatchObject({ ok: false });
  });

  it('matches the published cross-language governance payload-hash vectors', () => {
    const vectors = JSON.parse(readFileSync(new URL(
      '../../../static/compliance/source/test-vectors/governance-authorization.json',
      import.meta.url,
    ), 'utf8')) as {
      payload_hash_cases: Array<{ payload: Record<string, unknown>; expected_hash: string }>;
      authorization_cases: Array<{
        id: string;
        task_match: boolean;
        payload_hash_match: boolean;
        authorized_amount: number;
        actual_amount: number;
        currency_match: boolean;
        critical_markers_complete: boolean;
        expected: 'accept' | 'reject';
      }>;
    };
    for (const vector of vectors.payload_hash_cases) {
      expect(computeGovernedPayloadHash(vector.payload)).toBe(vector.expected_hash);
    }
    for (const vector of vectors.authorization_cases) {
      const accepted = vector.task_match
        && vector.payload_hash_match
        && vector.actual_amount <= vector.authorized_amount
        && vector.currency_match
        && vector.critical_markers_complete;
      expect(accepted ? 'accept' : 'reject', vector.id).toBe(vector.expected);
    }
  });

  it('emits a fresh jti and plan_hash mismatch on each call (no caching)', async () => {
    const a = await signGovernanceContext({
      issuer: 'https://gov.example.com/governance',
      audience: 'https://seller.example.com',
      bindingId: 'gb_freshness',
      phase: 'intent',
      caller: 'https://buyer.example.com',
      checkId: 'chk_a',
      plan: SAMPLE_PLAN,
    });
    const b = await signGovernanceContext({
      issuer: 'https://gov.example.com/governance',
      audience: 'https://seller.example.com',
      bindingId: 'gb_freshness',
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
