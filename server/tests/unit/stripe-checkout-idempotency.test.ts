import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.STRIPE_SECRET_KEY ||= 'sk_test_checkout_idempotency';

const mocks = vi.hoisted(() => ({
  retrievePrice: vi.fn(),
  createSession: vi.fn(),
  createCoupon: vi.fn(),
}));

vi.mock('stripe', () => ({
  default: class StripeMock {
    static API_VERSION = '2025-01-27.acacia';
    prices = { retrieve: mocks.retrievePrice };
    promotionCodes = { list: vi.fn() };
    checkout = { sessions: { create: mocks.createSession } };
    coupons = { create: mocks.createCoupon };
  },
}));

vi.mock('../../src/addie/error-notifier.js', () => ({ notifySystemError: vi.fn() }));

const { createCheckoutSession, createCoupon } = await import('../../src/billing/stripe-client.js');

beforeEach(() => {
  vi.clearAllMocks();
  mocks.retrievePrice.mockResolvedValue({ recurring: { interval: 'year' }, lookup_key: 'aao_membership_company' });
  mocks.createSession.mockResolvedValue({ id: 'cs_123', url: 'https://checkout.stripe.test/cs_123' });
  mocks.createCoupon.mockResolvedValue({ id: 'coupon_123', name: 'Referral' });
});

describe('Stripe write idempotency boundaries', () => {
  it('forwards the persisted attempt key as the Checkout SDK request option', async () => {
    await createCheckoutSession({
      priceId: 'price_123',
      successUrl: 'https://example.test/success',
      cancelUrl: 'https://example.test/cancel',
      workosOrganizationId: 'org_123',
      workosUserId: 'user_123',
      idempotencyKey: 'attempt_key',
    });

    expect(mocks.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ line_items: [{ price: 'price_123', quantity: 1 }] }),
      { idempotencyKey: 'attempt_key' },
    );
  });

  it('forwards a stable referral key when creating a one-use coupon', async () => {
    await createCoupon({
      name: 'Referral',
      percent_off: 10,
      duration: 'once',
    }, 'referral_coupon_key');

    expect(mocks.createCoupon).toHaveBeenCalledWith(
      expect.objectContaining({ percent_off: 10 }),
      { idempotencyKey: 'referral_coupon_key' },
    );
  });
});
