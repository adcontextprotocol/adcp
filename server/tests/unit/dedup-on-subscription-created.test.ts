/**
 * Tests for the webhook-side duplicate-subscription guard.
 *
 * Closes the cross-path race the intake-side guards leave open: Stripe
 * Checkout creates a session URL, not a subscription — the sub mints only
 * when the user completes the hosted page. Two concurrent intake paths
 * (admin invite + member checkout) can both pass their guards before
 * either mints a sub, so we re-check at `customer.subscription.created`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type Stripe from 'stripe';
import type { Logger } from 'pino';
import { dedupOnSubscriptionCreated } from '../../src/billing/dedup-on-subscription-created.js';

function makeSub(id: string, status: Stripe.Subscription.Status): Stripe.Subscription {
  return { id, status, customer: 'cus_test' } as unknown as Stripe.Subscription;
}

function makeStripe(opts: {
  list?: () => Promise<{ data: Stripe.Subscription[] }>;
  cancel?: () => Promise<Stripe.Subscription>;
}): Stripe {
  return {
    subscriptions: {
      list: opts.list ?? vi.fn().mockResolvedValue({ data: [] }),
      cancel: opts.cancel ?? vi.fn().mockResolvedValue({} as Stripe.Subscription),
    },
  } as unknown as Stripe;
}

function makeLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger;
}

describe('dedupOnSubscriptionCreated', () => {
  let logger: Logger;
  let notifySystemError: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    logger = makeLogger();
    notifySystemError = vi.fn();
  });

  it('returns duplicate=false when the customer has only the new sub', async () => {
    const newSub = makeSub('sub_new', 'active');
    const stripe = makeStripe({
      list: vi.fn().mockResolvedValue({ data: [newSub] }),
    });

    const result = await dedupOnSubscriptionCreated({
      subscription: newSub,
      customerId: 'cus_test',
      orgId: 'org_test',
      stripe,
      logger,
      notifySystemError,
    });

    expect(result.duplicate).toBe(false);
    expect(result.existingLiveSubIds).toEqual([]);
    expect(notifySystemError).not.toHaveBeenCalled();
    expect(stripe.subscriptions.cancel).not.toHaveBeenCalled();
  });

  it('returns duplicate=false when other subs exist but are all canceled/incomplete', async () => {
    const newSub = makeSub('sub_new', 'active');
    const stripe = makeStripe({
      list: vi.fn().mockResolvedValue({
        data: [
          newSub,
          makeSub('sub_old1', 'canceled'),
          makeSub('sub_old2', 'incomplete_expired'),
          makeSub('sub_old3', 'incomplete'),
        ],
      }),
    });

    const result = await dedupOnSubscriptionCreated({
      subscription: newSub,
      customerId: 'cus_test',
      orgId: 'org_test',
      stripe,
      logger,
      notifySystemError,
    });

    expect(result.duplicate).toBe(false);
    expect(result.existingLiveSubIds).toEqual([]);
    expect(stripe.subscriptions.cancel).not.toHaveBeenCalled();
  });

  it('cancels the new sub and alerts ops when another active sub exists', async () => {
    const newSub = makeSub('sub_new', 'active');
    const cancel = vi.fn().mockResolvedValue({} as Stripe.Subscription);
    const stripe = makeStripe({
      list: vi.fn().mockResolvedValue({
        data: [newSub, makeSub('sub_existing', 'active')],
      }),
      cancel,
    });

    const result = await dedupOnSubscriptionCreated({
      subscription: newSub,
      customerId: 'cus_test',
      orgId: 'org_test',
      stripe,
      logger,
      notifySystemError,
    });

    expect(result.duplicate).toBe(true);
    expect(result.existingLiveSubIds).toEqual(['sub_existing']);
    expect(cancel).toHaveBeenCalledWith('sub_new', { prorate: true });
    expect(notifySystemError).toHaveBeenCalledTimes(1);
    expect(notifySystemError.mock.calls[0][0].source).toBe('stripe-subscription-dedup');
    expect(notifySystemError.mock.calls[0][0].errorMessage).toContain('sub_new');
    expect(notifySystemError.mock.calls[0][0].errorMessage).toContain('sub_existing');
  });

  it('treats trialing and past_due as live and triggers cancel', async () => {
    const newSub = makeSub('sub_new', 'active');
    const cancel = vi.fn().mockResolvedValue({} as Stripe.Subscription);
    const stripe = makeStripe({
      list: vi.fn().mockResolvedValue({
        data: [
          newSub,
          makeSub('sub_trial', 'trialing'),
          makeSub('sub_past_due', 'past_due'),
        ],
      }),
      cancel,
    });

    const result = await dedupOnSubscriptionCreated({
      subscription: newSub,
      customerId: 'cus_test',
      orgId: 'org_test',
      stripe,
      logger,
      notifySystemError,
    });

    expect(result.duplicate).toBe(true);
    expect(result.existingLiveSubIds).toEqual(['sub_trial', 'sub_past_due']);
    expect(cancel).toHaveBeenCalledWith('sub_new', { prorate: true });
  });

  it('falls through to duplicate=false when subscriptions.list throws (transient Stripe blip)', async () => {
    const newSub = makeSub('sub_new', 'active');
    const stripe = makeStripe({
      list: vi.fn().mockRejectedValue(new Error('Stripe API down')),
    });

    const result = await dedupOnSubscriptionCreated({
      subscription: newSub,
      customerId: 'cus_test',
      orgId: 'org_test',
      stripe,
      logger,
      notifySystemError,
    });

    expect(result.duplicate).toBe(false);
    expect(result.existingLiveSubIds).toEqual([]);
    expect(stripe.subscriptions.cancel).not.toHaveBeenCalled();
    expect(notifySystemError).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('still alerts ops when cancel fails — manual intervention is needed', async () => {
    const newSub = makeSub('sub_new', 'active');
    const cancel = vi.fn().mockRejectedValue(new Error('cannot cancel'));
    const stripe = makeStripe({
      list: vi.fn().mockResolvedValue({
        data: [newSub, makeSub('sub_existing', 'active')],
      }),
      cancel,
    });

    const result = await dedupOnSubscriptionCreated({
      subscription: newSub,
      customerId: 'cus_test',
      orgId: 'org_test',
      stripe,
      logger,
      notifySystemError,
    });

    expect(result.duplicate).toBe(true);
    expect(result.existingLiveSubIds).toEqual(['sub_existing']);
    expect(notifySystemError).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalled();
  });

  it('handles missing orgId in the alert message', async () => {
    const newSub = makeSub('sub_new', 'active');
    const stripe = makeStripe({
      list: vi.fn().mockResolvedValue({
        data: [newSub, makeSub('sub_existing', 'active')],
      }),
    });

    const result = await dedupOnSubscriptionCreated({
      subscription: newSub,
      customerId: 'cus_test',
      orgId: null,
      stripe,
      logger,
      notifySystemError,
    });

    expect(result.duplicate).toBe(true);
    expect(notifySystemError.mock.calls[0][0].errorMessage).toContain('org unknown');
  });
});
