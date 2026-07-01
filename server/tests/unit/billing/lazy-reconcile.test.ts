/**
 * Tests for `attemptStripeReconciliation` — the lazy heal path that
 * surfaces drift between Stripe and our org row at the moment a paywall
 * gate would otherwise deny.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type Stripe from 'stripe';
import { attemptStripeReconciliation } from '../../../src/billing/lazy-reconcile.js';

const mockQuery = vi.fn();
const mockCustomersRetrieve = vi.fn();

function makeDeps() {
  return {
    pool: { query: mockQuery } as any,
    stripe: {
      customers: { retrieve: mockCustomersRetrieve },
    } as unknown as Stripe,
    logger: {
      info: vi.fn(), warn: vi.fn(), error: vi.fn(),
      debug: vi.fn(), trace: vi.fn(), fatal: vi.fn(),
      child: vi.fn().mockReturnThis(),
    } as any,
  };
}

beforeEach(() => {
  mockQuery.mockReset();
  mockCustomersRetrieve.mockReset();
});

function fakeOrg(overrides: Partial<{
  stripe_customer_id: string | null;
  subscription_status: string | null;
  subscription_canceled_at: Date | null;
  stripe_subscription_id: string | null;
  subscription_price_lookup_key: string | null;
  subscription_amount: number | null;
}> = {}) {
  // `'key' in overrides` preserves explicit null (vs ?? which would
  // substitute the default for null too).
  return {
    workos_organization_id: 'org_x',
    stripe_customer_id: 'stripe_customer_id' in overrides ? overrides.stripe_customer_id : 'cus_x',
    subscription_status: 'subscription_status' in overrides ? overrides.subscription_status : null,
    subscription_canceled_at: overrides.subscription_canceled_at ?? null,
    stripe_subscription_id:
      'stripe_subscription_id' in overrides ? overrides.stripe_subscription_id : null,
    subscription_price_lookup_key:
      'subscription_price_lookup_key' in overrides ? overrides.subscription_price_lookup_key : null,
    subscription_amount:
      'subscription_amount' in overrides ? overrides.subscription_amount : null,
  };
}

function fakeCustomerWithSubs(subs: unknown[]): Stripe.Customer {
  return {
    id: 'cus_x',
    deleted: false,
    subscriptions: { data: subs },
  } as unknown as Stripe.Customer;
}

function fakeMembershipSub(overrides: Partial<{
  id: string;
  status: Stripe.Subscription.Status;
  lookup_key: string | null;
  unit_amount: number;
}> = {}) {
  return {
    id: overrides.id ?? 'sub_x',
    status: overrides.status ?? 'active',
    current_period_end: 9999999999,
    canceled_at: null,
    items: {
      data: [{
        price: {
          unit_amount: overrides.unit_amount ?? 25000,
          currency: 'usd',
          recurring: { interval: 'year' },
          lookup_key: 'lookup_key' in overrides ? overrides.lookup_key : 'aao_membership_professional_250',
        },
      }],
    },
  };
}

describe('attemptStripeReconciliation', () => {
  it('heals an org row when Stripe customer has an active membership sub', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [fakeOrg({ subscription_status: null })] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ workos_organization_id: 'org_x' }] });
    mockCustomersRetrieve.mockResolvedValueOnce(fakeCustomerWithSubs([fakeMembershipSub()]));

    const result = await attemptStripeReconciliation('org_x', makeDeps());

    expect(result.healed).toBe(true);
    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(mockQuery.mock.calls[1][0]).toMatch(/UPDATE organizations/);
  });

  it('skips when org is fully synced (entitled status AND populated sub_id + lookup_key)', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [fakeOrg({
        subscription_status: 'active',
        stripe_subscription_id: 'sub_existing',
        subscription_price_lookup_key: 'aao_membership_professional_250',
        subscription_amount: 25000,
      })],
    });

    const result = await attemptStripeReconciliation('org_x', makeDeps());

    expect(result).toEqual({ healed: false, reason: 'already_entitled' });
    expect(mockCustomersRetrieve).not.toHaveBeenCalled();
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('heals Adzymic-shape: status=active but stripe_subscription_id and lookup_key NULL', async () => {
    // The partial-truth case that founding-era rows sat in for months.
    // Pre-fix this returned 'already_entitled' on the status check alone.
    mockQuery
      .mockResolvedValueOnce({
        rows: [fakeOrg({
          subscription_status: 'active',
          stripe_subscription_id: null,
          subscription_price_lookup_key: null,
          subscription_amount: null,
        })],
      })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ workos_organization_id: 'org_x' }] });
    mockCustomersRetrieve.mockResolvedValueOnce(
      fakeCustomerWithSubs([fakeMembershipSub({ lookup_key: 'aao_membership_corporate_under5m' })]),
    );

    const result = await attemptStripeReconciliation('org_x', makeDeps());

    expect(result.healed).toBe(true);
    expect(mockCustomersRetrieve).toHaveBeenCalledTimes(1);
    // Match the lookup_key in the UPDATE params without depending on positional
    // index — adjacent tests in this file pattern-match on call shape, not
    // positional binding, so a future param reorder doesn't silently invert.
    const updateParams = mockQuery.mock.calls[1][1] as unknown[];
    expect(updateParams).toContain('aao_membership_corporate_under5m');
  });

  it('heals when status=active but only stripe_subscription_id is missing (lookup_key set)', async () => {
    // Less common partial state, but still a sync gap. Either field missing
    // means lazy-reconcile should fill it in.
    mockQuery
      .mockResolvedValueOnce({
        rows: [fakeOrg({
          subscription_status: 'active',
          stripe_subscription_id: null,
          subscription_price_lookup_key: 'aao_membership_explorer_50',
          subscription_amount: 5000,
        })],
      })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ workos_organization_id: 'org_x' }] });
    mockCustomersRetrieve.mockResolvedValueOnce(fakeCustomerWithSubs([fakeMembershipSub()]));

    const result = await attemptStripeReconciliation('org_x', makeDeps());

    expect(result.healed).toBe(true);
  });

  it('skips when org has no Stripe customer id', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [fakeOrg({ stripe_customer_id: null })] });

    const result = await attemptStripeReconciliation('org_x', makeDeps());

    expect(result).toEqual({ healed: false, reason: 'no_stripe_customer' });
    expect(mockCustomersRetrieve).not.toHaveBeenCalled();
  });

  it('skips when Stripe customer is deleted', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [fakeOrg()] });
    mockCustomersRetrieve.mockResolvedValueOnce({ id: 'cus_x', deleted: true });

    const result = await attemptStripeReconciliation('org_x', makeDeps());

    expect(result).toEqual({ healed: false, reason: 'customer_deleted' });
  });

  it('skips when Stripe customer has no membership sub', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [fakeOrg()] });
    mockCustomersRetrieve.mockResolvedValueOnce(
      fakeCustomerWithSubs([fakeMembershipSub({ lookup_key: 'aao_event_ticket' })]),
    );

    const result = await attemptStripeReconciliation('org_x', makeDeps());

    expect(result).toEqual({ healed: false, reason: 'no_membership_sub' });
  });

  it('skips when membership sub is not in an entitled status (incomplete)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [fakeOrg()] });
    mockCustomersRetrieve.mockResolvedValueOnce(
      fakeCustomerWithSubs([fakeMembershipSub({ status: 'incomplete' })]),
    );

    const result = await attemptStripeReconciliation('org_x', makeDeps());

    expect(result).toEqual({ healed: false, reason: 'sub_not_entitled' });
  });

  it('treats trialing as entitled and heals', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [fakeOrg()] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ workos_organization_id: 'org_x' }] });
    mockCustomersRetrieve.mockResolvedValueOnce(
      fakeCustomerWithSubs([fakeMembershipSub({ status: 'trialing' })]),
    );

    const result = await attemptStripeReconciliation('org_x', makeDeps());

    expect(result.healed).toBe(true);
    if (result.healed) expect(result.subscriptionStatus).toBe('trialing');
  });

  it('multi-sub: picks the membership sub even when stacked with non-membership', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [fakeOrg()] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ workos_organization_id: 'org_x' }] });
    mockCustomersRetrieve.mockResolvedValueOnce(
      fakeCustomerWithSubs([
        fakeMembershipSub({ id: 'sub_event', lookup_key: 'aao_event_ticket' }),
        fakeMembershipSub({ id: 'sub_member', lookup_key: 'aao_membership_explorer_50' }),
      ]),
    );

    const result = await attemptStripeReconciliation('org_x', makeDeps());

    expect(result.healed).toBe(true);
    // The UPDATE was called with the membership sub's id at param 2 (stripe_subscription_id).
    const updateParams = mockQuery.mock.calls[1][1] as unknown[];
    expect(updateParams[1]).toBe('sub_member');
  });

  it('reports already_entitled when a concurrent webhook beat the heal write (rowCount=0)', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [fakeOrg()] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] });  // WHERE clause filtered out
    mockCustomersRetrieve.mockResolvedValueOnce(fakeCustomerWithSubs([fakeMembershipSub()]));

    const result = await attemptStripeReconciliation('org_x', makeDeps());

    expect(result).toEqual({ healed: false, reason: 'already_entitled' });
  });

  it('returns stripe_error and does not write when Stripe call throws', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [fakeOrg()] });
    mockCustomersRetrieve.mockRejectedValueOnce(new Error('rate limit'));

    const result = await attemptStripeReconciliation('org_x', makeDeps());

    expect(result).toEqual({ healed: false, reason: 'stripe_error' });
    expect(mockQuery).toHaveBeenCalledTimes(1);  // only the SELECT, no UPDATE
  });

  it('returns org_not_found when the org id does not exist', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await attemptStripeReconciliation('org_missing', makeDeps());

    expect(result).toEqual({ healed: false, reason: 'org_not_found' });
    expect(mockCustomersRetrieve).not.toHaveBeenCalled();
  });
});
