import { beforeEach, describe, expect, it, vi } from 'vitest';

const query = vi.hoisted(() => vi.fn());
vi.mock('../../src/db/client.js', () => ({ query }));

import {
  claimMembershipCheckoutAttempt,
  completeMembershipCheckoutAttempt,
  fingerprintMembershipCheckoutPayload,
  isDefinitiveCheckoutFailure,
} from '../../src/billing/membership-checkout-attempt.js';

beforeEach(() => vi.clearAllMocks());

describe('membership checkout attempts', () => {
  it('binds the payload hash to price and initiating user metadata', () => {
    const base = {
      priceId: 'price_a',
      successUrl: 'https://example.test/success',
      cancelUrl: 'https://example.test/cancel',
      workosOrganizationId: 'org_1',
      workosUserId: 'user_1',
    };
    expect(fingerprintMembershipCheckoutPayload(base)).not.toBe(fingerprintMembershipCheckoutPayload({
      ...base,
      priceId: 'price_b',
    }));
    expect(fingerprintMembershipCheckoutPayload(base)).not.toBe(fingerprintMembershipCheckoutPayload({
      ...base,
      workosUserId: 'user_2',
    }));
  });

  it('rejects a different payload while an attempt is live', async () => {
    query.mockResolvedValueOnce({ rows: [{ payload_fingerprint: 'old_fingerprint' }] });
    await expect(claimMembershipCheckoutAttempt({
      organizationId: 'org_1',
      userId: 'user_1',
      payloadFingerprint: 'new_fingerprint',
    })).resolves.toEqual({ kind: 'conflict' });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('replays a stored open session for the identical payload', async () => {
    query.mockResolvedValueOnce({ rows: [{
      payload_fingerprint: 'same_fingerprint',
      idempotency_key: 'attempt_key',
      stripe_session_id: 'cs_123',
      stripe_session_url: 'https://checkout.stripe.test/cs_123',
    }] });
    await expect(claimMembershipCheckoutAttempt({
      organizationId: 'org_1',
      userId: 'user_1',
      payloadFingerprint: 'same_fingerprint',
    })).resolves.toEqual({
      kind: 'replay',
      sessionId: 'cs_123',
      url: 'https://checkout.stripe.test/cs_123',
    });
  });

  it('reuses only the same attempt key after an ambiguous Stripe failure', async () => {
    query.mockResolvedValueOnce({ rows: [{
      payload_fingerprint: 'same_fingerprint',
      idempotency_key: 'attempt_key',
      stripe_session_id: null,
      stripe_session_url: null,
    }] });
    await expect(claimMembershipCheckoutAttempt({
      organizationId: 'org_1',
      userId: 'user_1',
      payloadFingerprint: 'same_fingerprint',
    })).resolves.toEqual({ kind: 'create', idempotencyKey: 'attempt_key' });
  });

  it('marks completion only once so concurrent retries cannot double-consume discounts', async () => {
    query.mockResolvedValueOnce({ rows: [{ organization_id: 'org_1' }] });
    await expect(completeMembershipCheckoutAttempt({
      organizationId: 'org_1',
      idempotencyKey: 'attempt_key',
      sessionId: 'cs_123',
      url: 'https://checkout.stripe.test/cs_123',
    })).resolves.toBe(true);
    expect(query.mock.calls[0][0]).toContain('stripe_session_id IS NULL');
  });

  it('clears only failures that prove no Stripe session was created', () => {
    expect(isDefinitiveCheckoutFailure({ type: 'StripeInvalidRequestError' })).toBe(true);
    expect(isDefinitiveCheckoutFailure({ type: 'StripeConnectionError' })).toBe(false);
    expect(isDefinitiveCheckoutFailure(new Error('timeout'))).toBe(false);
  });
});
