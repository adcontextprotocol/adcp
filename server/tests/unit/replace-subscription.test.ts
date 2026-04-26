/**
 * Integration tests for POST /api/admin/accounts/:orgId/replace-subscription.
 *
 * The endpoint does an in-place Stripe subscription update — same sub_id,
 * new price item (and optional coupon). Each safety guard plus the happy
 * path plus the post-Stripe audit-log path are covered.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import type Stripe from 'stripe';

process.env.WORKOS_API_KEY = process.env.WORKOS_API_KEY ?? 'test';
process.env.WORKOS_CLIENT_ID = process.env.WORKOS_CLIENT_ID ?? 'client_test';

const {
  mockPoolQuery,
  mockGetOrg,
  mockStripeRetrievePrice,
  mockStripeListPrices,
  mockStripeRetrieveCoupon,
  mockStripeRetrieveSub,
  mockStripeUpdateSub,
  stripeMockState,
} = vi.hoisted(() => ({
  mockPoolQuery: vi.fn<any>(),
  mockGetOrg: vi.fn<any>(),
  mockStripeRetrievePrice: vi.fn<any>(),
  mockStripeListPrices: vi.fn<any>(),
  mockStripeRetrieveCoupon: vi.fn<any>(),
  mockStripeRetrieveSub: vi.fn<any>(),
  mockStripeUpdateSub: vi.fn<any>(),
  stripeMockState: { configured: true } as { configured: boolean },
}));

vi.mock('../../src/middleware/auth.js', () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { id: 'user_admin_01', email: 'admin@test', is_admin: true };
    next();
  },
  requireAdmin: (_req: any, _res: any, next: any) => next(),
}));

vi.mock('../../src/db/client.js', () => ({
  getPool: () => ({
    query: (...args: unknown[]) => mockPoolQuery(...args),
  }),
}));

vi.mock('../../src/db/organization-db.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/db/organization-db.js')>();
  return {
    ...actual,
    OrganizationDatabase: class MockOrgDb {
      getOrganization(orgId: string) {
        return mockGetOrg(orgId);
      }
    },
  };
});

vi.mock('../../src/billing/stripe-client.js', () => ({
  get stripe() {
    if (!stripeMockState.configured) return null;
    return {
      prices: {
        retrieve: (...args: unknown[]) => mockStripeRetrievePrice(...args),
        list: (...args: unknown[]) => mockStripeListPrices(...args),
      },
      coupons: {
        retrieve: (...args: unknown[]) => mockStripeRetrieveCoupon(...args),
      },
      subscriptions: {
        retrieve: (...args: unknown[]) => mockStripeRetrieveSub(...args),
        update: (...args: unknown[]) => mockStripeUpdateSub(...args),
      },
    };
  },
  STRIPE_WEBHOOK_SECRET: 'whsec_test',
}));

const ORG_ID = 'org_test_01';
const ORG_NAME = 'Test Org';
const SUB_ID = 'sub_existing';
const ITEM_ID = 'si_existing';
const OLD_PRICE_ID = 'price_old';
const NEW_PRICE_ID = 'price_new';
const NEW_LOOKUP_KEY = 'aao_membership_member_25000_custom';
const COUPON_ID = 'founder-50pct-off';

function makeOrg(overrides: Record<string, unknown> = {}) {
  return {
    workos_organization_id: ORG_ID,
    name: ORG_NAME,
    stripe_customer_id: 'cus_test',
    stripe_subscription_id: SUB_ID,
    ...overrides,
  };
}

function makePrice(overrides: Partial<Stripe.Price> = {}): Stripe.Price {
  return {
    id: NEW_PRICE_ID,
    active: true,
    lookup_key: NEW_LOOKUP_KEY,
    unit_amount: 2500000,
    currency: 'usd',
    recurring: { interval: 'year' },
    ...overrides,
  } as unknown as Stripe.Price;
}

function makeExistingSub(overrides: Partial<Stripe.Subscription> = {}): Stripe.Subscription {
  return {
    id: SUB_ID,
    status: 'active',
    collection_method: 'charge_automatically',
    metadata: { signed_agreement_version: '1.2' },
    items: {
      data: [
        {
          id: ITEM_ID,
          price: {
            id: OLD_PRICE_ID,
            lookup_key: 'aao_membership_member_15000',
            unit_amount: 1500000,
            recurring: { interval: 'year' },
          },
        },
      ],
    },
    ...overrides,
  } as unknown as Stripe.Subscription;
}

async function buildApp() {
  const { setupAccountsBillingRoutes } = await import('../../src/routes/admin/accounts-billing.js');
  const app = express();
  app.use(express.json());
  const router = express.Router();
  setupAccountsBillingRoutes(router, { workos: null });
  app.use('/api/admin', router);
  return app;
}

describe('POST /api/admin/accounts/:orgId/replace-subscription', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stripeMockState.configured = true;
    mockPoolQuery.mockResolvedValue({ rows: [] });
  });

  it('returns 503 when Stripe is unconfigured', async () => {
    stripeMockState.configured = false;
    const app = await buildApp();

    const res = await request(app)
      .post(`/api/admin/accounts/${ORG_ID}/replace-subscription`)
      .send({ price_id: NEW_PRICE_ID, reason: 'custom contract signed' });

    expect(res.status).toBe(503);
  });

  it('returns 400 when reason is missing or short', async () => {
    const app = await buildApp();

    const res = await request(app)
      .post(`/api/admin/accounts/${ORG_ID}/replace-subscription`)
      .send({ price_id: NEW_PRICE_ID, reason: 'short' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Reason required');
  });

  it('returns 400 when neither lookup_key nor price_id is provided', async () => {
    const app = await buildApp();

    const res = await request(app)
      .post(`/api/admin/accounts/${ORG_ID}/replace-subscription`)
      .send({ reason: 'custom contract signed for member tier' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Price source required');
  });

  it('returns 400 when both lookup_key and price_id are provided', async () => {
    const app = await buildApp();

    const res = await request(app)
      .post(`/api/admin/accounts/${ORG_ID}/replace-subscription`)
      .send({
        lookup_key: NEW_LOOKUP_KEY,
        price_id: NEW_PRICE_ID,
        reason: 'custom contract signed for member tier',
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Price source required');
  });

  it('returns 404 when org does not exist', async () => {
    mockGetOrg.mockResolvedValueOnce(null);
    const app = await buildApp();

    const res = await request(app)
      .post(`/api/admin/accounts/${ORG_ID}/replace-subscription`)
      .send({ price_id: NEW_PRICE_ID, reason: 'custom contract signed for member tier' });

    expect(res.status).toBe(404);
  });

  it('returns 400 when org has no subscription to replace', async () => {
    mockGetOrg.mockResolvedValueOnce(makeOrg({ stripe_subscription_id: null }));
    const app = await buildApp();

    const res = await request(app)
      .post(`/api/admin/accounts/${ORG_ID}/replace-subscription`)
      .send({ price_id: NEW_PRICE_ID, reason: 'custom contract signed for member tier' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('No active subscription');
  });

  it('returns 400 when lookup_key matches no active price', async () => {
    mockGetOrg.mockResolvedValueOnce(makeOrg());
    mockStripeListPrices.mockResolvedValueOnce({ data: [] });
    const app = await buildApp();

    const res = await request(app)
      .post(`/api/admin/accounts/${ORG_ID}/replace-subscription`)
      .send({ lookup_key: NEW_LOOKUP_KEY, reason: 'custom contract signed for member tier' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Price not found');
  });

  it('returns 400 when lookup_key matches multiple active prices', async () => {
    mockGetOrg.mockResolvedValueOnce(makeOrg());
    mockStripeListPrices.mockResolvedValueOnce({
      data: [makePrice(), makePrice({ id: 'price_other' })],
    });
    const app = await buildApp();

    const res = await request(app)
      .post(`/api/admin/accounts/${ORG_ID}/replace-subscription`)
      .send({ lookup_key: NEW_LOOKUP_KEY, reason: 'custom contract signed for member tier' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Ambiguous lookup_key');
  });

  it('returns 400 when target price is inactive', async () => {
    mockGetOrg.mockResolvedValueOnce(makeOrg());
    mockStripeRetrievePrice.mockResolvedValueOnce(makePrice({ active: false }));
    const app = await buildApp();

    const res = await request(app)
      .post(`/api/admin/accounts/${ORG_ID}/replace-subscription`)
      .send({ price_id: NEW_PRICE_ID, reason: 'custom contract signed for member tier' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Price inactive');
  });

  it('returns 400 when coupon does not exist', async () => {
    mockGetOrg.mockResolvedValueOnce(makeOrg());
    mockStripeRetrievePrice.mockResolvedValueOnce(makePrice());
    mockStripeRetrieveCoupon.mockRejectedValueOnce(new Error('No such coupon'));
    const app = await buildApp();

    const res = await request(app)
      .post(`/api/admin/accounts/${ORG_ID}/replace-subscription`)
      .send({
        price_id: NEW_PRICE_ID,
        coupon_id: 'nonexistent',
        reason: 'custom contract signed for member tier',
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Coupon not found');
  });

  it('returns 400 when coupon is no longer valid', async () => {
    mockGetOrg.mockResolvedValueOnce(makeOrg());
    mockStripeRetrievePrice.mockResolvedValueOnce(makePrice());
    mockStripeRetrieveCoupon.mockResolvedValueOnce({ id: COUPON_ID, valid: false });
    const app = await buildApp();

    const res = await request(app)
      .post(`/api/admin/accounts/${ORG_ID}/replace-subscription`)
      .send({
        price_id: NEW_PRICE_ID,
        coupon_id: COUPON_ID,
        reason: 'custom contract signed for member tier',
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Coupon invalid');
  });

  it('returns 400 when the org\'s tracked subscription is gone in Stripe', async () => {
    mockGetOrg.mockResolvedValueOnce(makeOrg());
    mockStripeRetrievePrice.mockResolvedValueOnce(makePrice());
    mockStripeRetrieveSub.mockRejectedValueOnce(new Error('No such subscription'));
    const app = await buildApp();

    const res = await request(app)
      .post(`/api/admin/accounts/${ORG_ID}/replace-subscription`)
      .send({ price_id: NEW_PRICE_ID, reason: 'custom contract signed for member tier' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Subscription not found in Stripe');
  });

  it('returns 502 when stripe.subscriptions.update rejects', async () => {
    mockGetOrg.mockResolvedValueOnce(makeOrg());
    mockStripeRetrievePrice.mockResolvedValueOnce(makePrice());
    mockStripeRetrieveSub.mockResolvedValueOnce(makeExistingSub());
    mockStripeUpdateSub.mockRejectedValueOnce(new Error('Invalid billing_cycle_anchor'));
    const app = await buildApp();

    const res = await request(app)
      .post(`/api/admin/accounts/${ORG_ID}/replace-subscription`)
      .send({ price_id: NEW_PRICE_ID, reason: 'custom contract signed for member tier' });

    expect(res.status).toBe(502);
    expect(res.body.error).toBe('Stripe update failed');
    expect(res.body.message).toContain('Invalid billing_cycle_anchor');
  });

  it('happy path: in-place update preserves sub_id, sets metadata, writes audit row', async () => {
    mockGetOrg.mockResolvedValueOnce(makeOrg());
    mockStripeRetrievePrice.mockResolvedValueOnce(makePrice());
    mockStripeRetrieveSub.mockResolvedValueOnce(makeExistingSub());
    mockStripeUpdateSub.mockResolvedValueOnce(
      makeExistingSub({
        items: {
          data: [
            {
              id: ITEM_ID,
              price: {
                id: NEW_PRICE_ID,
                lookup_key: NEW_LOOKUP_KEY,
                unit_amount: 2500000,
                recurring: { interval: 'year' },
              },
            },
          ],
        } as Stripe.ApiList<Stripe.SubscriptionItem>,
      }),
    );
    const app = await buildApp();

    const res = await request(app)
      .post(`/api/admin/accounts/${ORG_ID}/replace-subscription`)
      .send({
        price_id: NEW_PRICE_ID,
        reason: 'custom contract signed for member tier 2026',
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.subscription_id).toBe(SUB_ID);
    expect(res.body.before.price_id).toBe(OLD_PRICE_ID);
    expect(res.body.after.price_id).toBe(NEW_PRICE_ID);
    expect(res.body.after.proration_behavior).toBe('none');

    // Stripe update was called with the right shape:
    expect(mockStripeUpdateSub).toHaveBeenCalledWith(SUB_ID, expect.objectContaining({
      items: [{ id: ITEM_ID, price: NEW_PRICE_ID }],
      proration_behavior: 'none',
      billing_cycle_anchor: 'unchanged',
    }));

    // Metadata preserves the existing signed_agreement_version and adds
    // the admin attribution fields.
    const updateArgs = mockStripeUpdateSub.mock.calls[0][1] as {
      metadata: Record<string, string>;
    };
    expect(updateArgs.metadata.signed_agreement_version).toBe('1.2');
    expect(updateArgs.metadata.replaced_by_admin).toBe('user_admin_01');
    expect(updateArgs.metadata.replace_reason).toBe('custom contract signed for member tier 2026');

    // Audit log INSERT was issued with the right action + before/after.
    const insertCall = mockPoolQuery.mock.calls.find((c) =>
      String(c[0]).startsWith('INSERT INTO registry_audit_log'),
    );
    expect(insertCall).toBeDefined();
    const params = insertCall![1] as unknown[];
    expect(params[2]).toBe('subscription_replaced');
    expect(params[3]).toBe('subscription');
    expect(params[4]).toBe(SUB_ID);
    const details = JSON.parse(String(params[5]));
    expect(details.before_state.price_id).toBe(OLD_PRICE_ID);
    expect(details.after_state.price_id).toBe(NEW_PRICE_ID);
  });

  it('applies coupon as discounts:[{coupon}] when coupon_id provided', async () => {
    mockGetOrg.mockResolvedValueOnce(makeOrg());
    mockStripeRetrievePrice.mockResolvedValueOnce(makePrice());
    mockStripeRetrieveCoupon.mockResolvedValueOnce({ id: COUPON_ID, valid: true });
    mockStripeRetrieveSub.mockResolvedValueOnce(makeExistingSub());
    mockStripeUpdateSub.mockResolvedValueOnce(makeExistingSub());
    const app = await buildApp();

    await request(app)
      .post(`/api/admin/accounts/${ORG_ID}/replace-subscription`)
      .send({
        price_id: NEW_PRICE_ID,
        coupon_id: COUPON_ID,
        reason: 'custom contract signed for member tier',
      });

    expect(mockStripeUpdateSub).toHaveBeenCalledWith(SUB_ID, expect.objectContaining({
      discounts: [{ coupon: COUPON_ID }],
    }));
  });

  it('honors caller-provided proration_behavior when present', async () => {
    mockGetOrg.mockResolvedValueOnce(makeOrg());
    mockStripeRetrievePrice.mockResolvedValueOnce(makePrice());
    mockStripeRetrieveSub.mockResolvedValueOnce(makeExistingSub());
    mockStripeUpdateSub.mockResolvedValueOnce(makeExistingSub());
    const app = await buildApp();

    await request(app)
      .post(`/api/admin/accounts/${ORG_ID}/replace-subscription`)
      .send({
        price_id: NEW_PRICE_ID,
        proration_behavior: 'create_prorations',
        reason: 'custom contract signed for member tier',
      });

    expect(mockStripeUpdateSub).toHaveBeenCalledWith(SUB_ID, expect.objectContaining({
      proration_behavior: 'create_prorations',
    }));
  });

  it('resolves price by lookup_key when only lookup_key is provided', async () => {
    mockGetOrg.mockResolvedValueOnce(makeOrg());
    mockStripeListPrices.mockResolvedValueOnce({ data: [makePrice()] });
    mockStripeRetrieveSub.mockResolvedValueOnce(makeExistingSub());
    mockStripeUpdateSub.mockResolvedValueOnce(makeExistingSub());
    const app = await buildApp();

    const res = await request(app)
      .post(`/api/admin/accounts/${ORG_ID}/replace-subscription`)
      .send({
        lookup_key: NEW_LOOKUP_KEY,
        reason: 'custom contract signed for member tier',
      });

    expect(res.status).toBe(200);
    expect(mockStripeListPrices).toHaveBeenCalledWith({
      lookup_keys: [NEW_LOOKUP_KEY],
      active: true,
      limit: 2,
    });
    expect(mockStripeRetrievePrice).not.toHaveBeenCalled();
  });

  it('returns 200 even if audit-log INSERT fails after Stripe write succeeds', async () => {
    // The Stripe change is the primary side effect; an audit-write failure
    // should be logged loudly but not roll back the user's request.
    mockGetOrg.mockResolvedValueOnce(makeOrg());
    mockStripeRetrievePrice.mockResolvedValueOnce(makePrice());
    mockStripeRetrieveSub.mockResolvedValueOnce(makeExistingSub());
    mockStripeUpdateSub.mockResolvedValueOnce(makeExistingSub());
    mockPoolQuery.mockRejectedValueOnce(new Error('audit table missing'));
    const app = await buildApp();

    const res = await request(app)
      .post(`/api/admin/accounts/${ORG_ID}/replace-subscription`)
      .send({
        price_id: NEW_PRICE_ID,
        reason: 'custom contract signed for member tier',
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});
