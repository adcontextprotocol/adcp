/**
 * Tests for the duplicate-active-subscription guard.
 *
 * The guard is wired into POST /api/checkout-session, /api/invoice-request,
 * and /api/invite/:token/accept. Together those three are the only paths
 * that can mint a Stripe subscription/invoice on an org's behalf. Without
 * this guard, two of them in sequence produced Triton's duplicate $3K
 * Builder sub on top of an active $10K Corporate sub (Apr 2026).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.WORKOS_API_KEY = process.env.WORKOS_API_KEY ?? 'test';
process.env.WORKOS_CLIENT_ID = process.env.WORKOS_CLIENT_ID ?? 'client_test';

const mockCreatePortal = vi.fn<(customerId: string, returnUrl: string) => Promise<string | null>>();

vi.mock('../../src/billing/stripe-client.js', () => ({
  createCustomerPortalSession: (customerId: string, returnUrl: string) =>
    mockCreatePortal(customerId, returnUrl),
}));

const { blockIfActiveSubscription } = await import('../../src/billing/active-subscription-guard.js');
import type { OrganizationDatabase, SubscriptionInfo, Organization } from '../../src/db/organization-db.js';

function makeOrgDb(opts: {
  info: SubscriptionInfo | null;
  org?: Partial<Organization> | null;
}): OrganizationDatabase {
  return {
    getSubscriptionInfo: vi.fn().mockResolvedValue(opts.info),
    getOrganization: vi.fn().mockResolvedValue(opts.org ?? null),
  } as unknown as OrganizationDatabase;
}

const PORTAL_RETURN_URL = 'https://app/dashboard/membership';

describe('blockIfActiveSubscription', () => {
  beforeEach(() => {
    mockCreatePortal.mockReset();
  });

  it('returns null when org has no subscription info', async () => {
    const orgDb = makeOrgDb({ info: null });
    const result = await blockIfActiveSubscription('org_x', orgDb, { customerPortalReturnUrl: PORTAL_RETURN_URL });
    expect(result).toBeNull();
  });

  it('returns null when subscription status is "none"', async () => {
    const orgDb = makeOrgDb({ info: { status: 'none' } });
    const result = await blockIfActiveSubscription('org_x', orgDb, { customerPortalReturnUrl: PORTAL_RETURN_URL });
    expect(result).toBeNull();
  });

  it('returns null when subscription is canceled', async () => {
    const orgDb = makeOrgDb({ info: { status: 'canceled' } });
    const result = await blockIfActiveSubscription('org_x', orgDb, { customerPortalReturnUrl: PORTAL_RETURN_URL });
    expect(result).toBeNull();
  });

  it('blocks when subscription is past_due — minting another sub would stack unresolved invoices', async () => {
    const orgDb = makeOrgDb({
      info: { status: 'past_due', amount_cents: 300000 },
      org: { stripe_customer_id: 'cus_x' },
    });
    mockCreatePortal.mockResolvedValueOnce('https://billing.stripe.com/p/session/x');

    const result = await blockIfActiveSubscription('org_x', orgDb, { customerPortalReturnUrl: PORTAL_RETURN_URL });

    expect(result).not.toBeNull();
    expect(result!.body.existing_subscription.status).toBe('past_due');
  });

  it('returns null when subscription is unpaid (recoverable by re-subscribing)', async () => {
    const orgDb = makeOrgDb({ info: { status: 'unpaid' } });
    const result = await blockIfActiveSubscription('org_x', orgDb, { customerPortalReturnUrl: PORTAL_RETURN_URL });
    expect(result).toBeNull();
  });

  it('blocks when subscription is active and includes a customer portal URL', async () => {
    mockCreatePortal.mockResolvedValueOnce('https://billing.stripe.com/p/session/test');
    const orgDb = makeOrgDb({
      info: {
        status: 'active',
        product_name: 'Corporate Membership',
        amount_cents: 1000000,
        lookup_key: 'aao_membership_corporate_5m',
      },
      org: {
        workos_organization_id: 'org_triton',
        stripe_customer_id: 'cus_triton',
      },
    });

    const result = await blockIfActiveSubscription('org_triton', orgDb, { customerPortalReturnUrl: PORTAL_RETURN_URL });

    expect(result).not.toBeNull();
    expect(result!.status).toBe(409);
    expect(result!.body.error).toBe('Active subscription exists');
    expect(result!.body.message).toContain('Corporate Membership');
    expect(result!.body.message).toContain('$10,000.00');
    expect(result!.body.message).toContain('Stripe Customer Portal');
    expect(result!.body.existing_subscription).toEqual({
      status: 'active',
      product_name: 'Corporate Membership',
      amount_cents: 1000000,
    });
    expect(result!.body.customer_portal_url).toBe('https://billing.stripe.com/p/session/test');
    expect(mockCreatePortal).toHaveBeenCalledWith('cus_triton', PORTAL_RETURN_URL);
  });

  it('blocks when subscription is trialing', async () => {
    const orgDb = makeOrgDb({
      info: { status: 'trialing', amount_cents: 25050 },
      org: { stripe_customer_id: 'cus_x' },
    });
    mockCreatePortal.mockResolvedValueOnce(null);

    const result = await blockIfActiveSubscription('org_x', orgDb, { customerPortalReturnUrl: PORTAL_RETURN_URL });

    expect(result).not.toBeNull();
    expect(result!.body.existing_subscription.status).toBe('trialing');
  });

  it('formats fractional dollar amounts with 2 decimal places', async () => {
    const orgDb = makeOrgDb({
      info: { status: 'active', amount_cents: 25050 },
      org: { stripe_customer_id: null },
    });

    const result = await blockIfActiveSubscription('org_x', orgDb, { customerPortalReturnUrl: PORTAL_RETURN_URL });

    expect(result).not.toBeNull();
    // $250.50 must render with cents — toLocaleString defaults drop them.
    expect(result!.body.message).toContain('$250.50');
  });

  it('omits customer_portal_url when caller does not pass customerPortalReturnUrl (privilege check)', async () => {
    // The invite-acceptance route omits returnUrl because the recipient gets
    // `member` role only and a portal session would grant admin-equivalent
    // control over the org's subscription.
    const orgDb = makeOrgDb({
      info: { status: 'active', amount_cents: 1000000, product_name: 'Corporate Membership' },
      org: { stripe_customer_id: 'cus_triton' },
    });

    const result = await blockIfActiveSubscription('org_triton', orgDb /* no options */);

    expect(result).not.toBeNull();
    expect(result!.body.customer_portal_url).toBeUndefined();
    expect(result!.body.message).toContain('finance@agenticadvertising.org');
    expect(result!.body.message).not.toContain('Stripe Customer Portal');
    expect(mockCreatePortal).not.toHaveBeenCalled();
  });

  it('omits customer_portal_url when org has no Stripe customer id', async () => {
    const orgDb = makeOrgDb({
      info: { status: 'active', amount_cents: 5000 },
      org: { stripe_customer_id: null },
    });

    const result = await blockIfActiveSubscription('org_x', orgDb, { customerPortalReturnUrl: PORTAL_RETURN_URL });

    expect(result).not.toBeNull();
    expect(result!.body.customer_portal_url).toBeUndefined();
    // Falls back to the finance@ message when portal URL can't be generated.
    expect(result!.body.message).toContain('finance@agenticadvertising.org');
    expect(mockCreatePortal).not.toHaveBeenCalled();
  });

  it('omits customer_portal_url and does not throw when portal creation fails', async () => {
    mockCreatePortal.mockRejectedValueOnce(new Error('Stripe down'));
    const orgDb = makeOrgDb({
      info: { status: 'active', amount_cents: 5000 },
      org: { stripe_customer_id: 'cus_x' },
    });

    const result = await blockIfActiveSubscription('org_x', orgDb, { customerPortalReturnUrl: PORTAL_RETURN_URL });

    expect(result).not.toBeNull();
    expect(result!.body.customer_portal_url).toBeUndefined();
    expect(result!.body.message).toContain('finance@agenticadvertising.org');
  });

  it('falls back to lookup_key in the message when product_name is missing', async () => {
    const orgDb = makeOrgDb({
      info: {
        status: 'active',
        amount_cents: 300000,
        lookup_key: 'aao_membership_builder_3000',
      },
      org: { stripe_customer_id: null },
    });

    const result = await blockIfActiveSubscription('org_x', orgDb, { customerPortalReturnUrl: PORTAL_RETURN_URL });

    expect(result).not.toBeNull();
    expect(result!.body.message).toContain('aao_membership_builder_3000');
  });
});
