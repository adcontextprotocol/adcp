/**
 * Integration tests for POST /api/admin/accounts/:orgId/reset-subscription-state.
 *
 * The endpoint is destructive (nullifies 13 subscription_* columns and writes
 * an audit-log row in a single transaction). Each safety guard gets a
 * dedicated test plus an atomicity test verifying the transaction rolls back
 * if either write fails.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

process.env.WORKOS_API_KEY = process.env.WORKOS_API_KEY ?? 'test';
process.env.WORKOS_CLIENT_ID = process.env.WORKOS_CLIENT_ID ?? 'client_test';

const { mockPoolQuery, mockPoolConnect, mockStripeCustomersRetrieve, stripeMockState } = vi.hoisted(() => ({
  mockPoolQuery: vi.fn<any>(),
  mockPoolConnect: vi.fn<any>(),
  mockStripeCustomersRetrieve: vi.fn<any>(),
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
    connect: () => mockPoolConnect(),
  }),
}));

vi.mock('../../src/billing/stripe-client.js', () => ({
  get stripe() {
    if (!stripeMockState.configured) return null;
    return {
      customers: {
        retrieve: (...args: unknown[]) => mockStripeCustomersRetrieve(...args),
      },
    };
  },
  STRIPE_WEBHOOK_SECRET: 'whsec_test',
}));

const ORG_ID = 'org_test_01';
const ORG_NAME = 'Test Org Inc';
const STRIPE_CUSTOMER_ID = 'cus_test_01';

function makeOrgRow(overrides: Record<string, unknown> = {}) {
  return {
    workos_organization_id: ORG_ID,
    name: ORG_NAME,
    stripe_customer_id: STRIPE_CUSTOMER_ID,
    subscription_status: 'canceled',
    stripe_subscription_id: 'sub_old_01',
    subscription_amount: 300000,
    subscription_currency: 'usd',
    subscription_interval: 'year',
    subscription_current_period_end: new Date('2026-04-01'),
    subscription_canceled_at: new Date('2026-04-15'),
    subscription_product_id: 'prod_01',
    subscription_product_name: 'Builder',
    subscription_price_id: 'price_01',
    subscription_price_lookup_key: 'aao_membership_builder_3000',
    membership_tier: 'builder',
    subscription_metadata: null,
    ...overrides,
  };
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

function makeTxClient(opts?: {
  failOn?: 'UPDATE' | 'INSERT' | 'COMMIT';
}) {
  const calls: string[] = [];
  const query = vi.fn(async (sql: string) => {
    const trimmed = sql.trim();
    calls.push(trimmed);
    if (opts?.failOn === 'UPDATE' && trimmed.startsWith('UPDATE organizations')) {
      throw new Error('UPDATE failed');
    }
    if (opts?.failOn === 'INSERT' && trimmed.startsWith('INSERT INTO registry_audit_log')) {
      throw new Error('audit INSERT failed');
    }
    if (opts?.failOn === 'COMMIT' && trimmed === 'COMMIT') {
      throw new Error('COMMIT failed');
    }
    return { rows: [], rowCount: 0 };
  });
  const release = vi.fn();
  return { client: { query, release }, calls, query, release };
}

describe('POST /api/admin/accounts/:orgId/reset-subscription-state', () => {
  beforeEach(() => {
    mockPoolQuery.mockReset();
    mockPoolConnect.mockReset();
    mockStripeCustomersRetrieve.mockReset();
    stripeMockState.configured = true;
  });

  it('returns 404 when the org does not exist', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    const app = await buildApp();

    const res = await request(app)
      .post(`/api/admin/accounts/${ORG_ID}/reset-subscription-state`)
      .send({ confirmation: ORG_NAME, reason: 'cleanup of stale row' });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Organization not found');
  });

  it('returns 400 when reason is missing', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [makeOrgRow()] });
    const app = await buildApp();

    const res = await request(app)
      .post(`/api/admin/accounts/${ORG_ID}/reset-subscription-state`)
      .send({ confirmation: ORG_NAME });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Reason required');
  });

  it('returns 400 when reason is shorter than 10 characters', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [makeOrgRow()] });
    const app = await buildApp();

    const res = await request(app)
      .post(`/api/admin/accounts/${ORG_ID}/reset-subscription-state`)
      .send({ confirmation: ORG_NAME, reason: 'too short' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Reason required');
  });

  it('returns 400 when confirmation does not match the org name', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [makeOrgRow()] });
    const app = await buildApp();

    const res = await request(app)
      .post(`/api/admin/accounts/${ORG_ID}/reset-subscription-state`)
      .send({ confirmation: 'Wrong Name', reason: 'cleanup of stale row' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Confirmation required');
    expect(res.body.requires_confirmation).toBe(true);
    expect(res.body.organization_name).toBe(ORG_NAME);
  });

  it('returns 400 when Stripe shows live subscriptions on the customer (active/trialing/past_due)', async () => {
    // All three statuses in TIER_PRESERVING_STATUSES must block the reset.
    // If a future change drops past_due from the blocking set, this test must fail.
    mockPoolQuery.mockResolvedValueOnce({ rows: [makeOrgRow()] });
    mockStripeCustomersRetrieve.mockResolvedValueOnce({
      deleted: false,
      subscriptions: {
        data: [
          { id: 'sub_live_active', status: 'active' },
          { id: 'sub_live_trial', status: 'trialing' },
          { id: 'sub_live_pastdue', status: 'past_due' },
          { id: 'sub_canceled', status: 'canceled' },
        ],
      },
    });
    const app = await buildApp();

    const res = await request(app)
      .post(`/api/admin/accounts/${ORG_ID}/reset-subscription-state`)
      .send({ confirmation: ORG_NAME, reason: 'cleanup of stale row' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Live subscriptions exist');
    expect(res.body.live_subscription_ids).toEqual([
      'sub_live_active',
      'sub_live_trial',
      'sub_live_pastdue',
    ]);
  });

  it('returns 503 when stripe_customer_id is set but Stripe is unconfigured', async () => {
    stripeMockState.configured = false;
    mockPoolQuery.mockResolvedValueOnce({ rows: [makeOrgRow()] });
    const app = await buildApp();

    const res = await request(app)
      .post(`/api/admin/accounts/${ORG_ID}/reset-subscription-state`)
      .send({ confirmation: ORG_NAME, reason: 'cleanup of stale row' });

    expect(res.status).toBe(503);
    expect(res.body.error).toBe('Stripe not configured');
    // The route must short-circuit *before* trying to call Stripe.
    expect(mockStripeCustomersRetrieve).not.toHaveBeenCalled();
  });

  it('proceeds when Stripe shows only non-live subscriptions', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [makeOrgRow()] });
    mockStripeCustomersRetrieve.mockResolvedValueOnce({
      deleted: false,
      subscriptions: {
        data: [
          { id: 'sub_canceled_01', status: 'canceled' },
          { id: 'sub_incomplete', status: 'incomplete' },
        ],
      },
    });
    const tx = makeTxClient();
    mockPoolConnect.mockResolvedValueOnce(tx.client);
    const app = await buildApp();

    const res = await request(app)
      .post(`/api/admin/accounts/${ORG_ID}/reset-subscription-state`)
      .send({ confirmation: ORG_NAME, reason: 'cleanup of stale row' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.cleared_fields).toContain('stripe_subscription_id');
    expect(res.body.cleared_fields).not.toContain('stripe_customer_id');
  });

  it('proceeds when the Stripe customer is deleted', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [makeOrgRow()] });
    mockStripeCustomersRetrieve.mockResolvedValueOnce({ deleted: true });
    const tx = makeTxClient();
    mockPoolConnect.mockResolvedValueOnce(tx.client);
    const app = await buildApp();

    const res = await request(app)
      .post(`/api/admin/accounts/${ORG_ID}/reset-subscription-state`)
      .send({ confirmation: ORG_NAME, reason: 'cleanup of stale row' });

    expect(res.status).toBe(200);
    // Transaction must still run even when the Stripe live-sub check is bypassed.
    expect(tx.calls[0]).toBe('BEGIN');
    expect(tx.calls).toContain('COMMIT');
  });

  it('proceeds without a Stripe check when stripe_customer_id is null', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [makeOrgRow({ stripe_customer_id: null })],
    });
    const tx = makeTxClient();
    mockPoolConnect.mockResolvedValueOnce(tx.client);
    const app = await buildApp();

    const res = await request(app)
      .post(`/api/admin/accounts/${ORG_ID}/reset-subscription-state`)
      .send({ confirmation: ORG_NAME, reason: 'cleanup of stale row' });

    expect(res.status).toBe(200);
    expect(mockStripeCustomersRetrieve).not.toHaveBeenCalled();
  });

  it('happy path: clears 13 fields, leaves stripe_customer_id intact, records audit log in one transaction', async () => {
    // makeOrgRow() defaults set 12 fields non-null and leave subscription_metadata null.
    // Set metadata too so cleared_fields covers all 13.
    const fullOrg = makeOrgRow({ subscription_metadata: { foo: 'bar' } });
    mockPoolQuery.mockResolvedValueOnce({ rows: [fullOrg] });
    mockStripeCustomersRetrieve.mockResolvedValueOnce({
      deleted: false,
      subscriptions: { data: [] },
    });
    const tx = makeTxClient();
    mockPoolConnect.mockResolvedValueOnce(tx.client);
    const app = await buildApp();

    const res = await request(app)
      .post(`/api/admin/accounts/${ORG_ID}/reset-subscription-state`)
      .send({ confirmation: ORG_NAME, reason: 'orphaned subscription_id blocking unique constraint' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      org_id: ORG_ID,
      org_name: ORG_NAME,
    });

    // Pin the exact set of cleared fields so a future regression that drops a
    // column from the UPDATE list fails this test.
    expect(res.body.cleared_fields).toEqual(
      expect.arrayContaining([
        'subscription_status',
        'stripe_subscription_id',
        'subscription_amount',
        'subscription_currency',
        'subscription_interval',
        'subscription_current_period_end',
        'subscription_canceled_at',
        'subscription_product_id',
        'subscription_product_name',
        'subscription_price_id',
        'subscription_price_lookup_key',
        'membership_tier',
        'subscription_metadata',
      ]),
    );
    expect(res.body.cleared_fields).toHaveLength(13);
    expect(res.body.cleared_fields).not.toContain('stripe_customer_id');

    // Invariant transaction shape — BEGIN first, COMMIT last, INSERT audit
    // after UPDATE. Avoids brittle positional asserts so adding a SET LOCAL
    // statement_timeout between BEGIN and UPDATE wouldn't break the test.
    expect(tx.calls[0]).toBe('BEGIN');
    expect(tx.calls[tx.calls.length - 1]).toBe('COMMIT');
    const updateIdx = tx.calls.findIndex((s) => s.startsWith('UPDATE organizations'));
    const insertIdx = tx.calls.findIndex((s) => s.startsWith('INSERT INTO registry_audit_log'));
    expect(updateIdx).toBeGreaterThan(0);
    expect(insertIdx).toBeGreaterThan(updateIdx);
    expect(tx.release).toHaveBeenCalledTimes(1);

    // Verify the UPDATE actually nulls the columns it claims to. Spot-check
    // the first/last in the column list and the parameterized id.
    const updateCall = tx.query.mock.calls.find((c) =>
      String(c[0]).startsWith('UPDATE organizations'),
    )!;
    const updateSql = String(updateCall[0]);
    expect(updateSql).toMatch(/subscription_status\s*=\s*NULL/);
    expect(updateSql).toMatch(/membership_tier\s*=\s*NULL/);
    expect(updateSql).toMatch(/subscription_metadata\s*=\s*NULL/);
    expect((updateCall[1] as unknown[])[0]).toBe(ORG_ID);

    // Audit log: assert by parameter index that we record the correct action,
    // resource type, and details payload — so a future param-order shuffle
    // fails loudly instead of silently picking up a different column.
    const insertCallArgs = tx.query.mock.calls.find((c) =>
      String(c[0]).startsWith('INSERT INTO registry_audit_log'),
    )!;
    const insertParams = insertCallArgs[1] as unknown[];
    expect(insertParams[0]).toBe(ORG_ID);
    expect(insertParams[1]).toBe('user_admin_01');
    expect(insertParams[2]).toBe('subscription_state_reset');
    expect(insertParams[3]).toBe('organization');
    expect(insertParams[4]).toBe(ORG_ID);

    const auditDetails = JSON.parse(String(insertParams[5]));
    expect(auditDetails.reason).toBe('orphaned subscription_id blocking unique constraint');
    expect(auditDetails.admin_email).toBe('admin@test');
    expect(auditDetails.before_state.stripe_customer_id).toBe(STRIPE_CUSTOMER_ID);
    expect(auditDetails.before_state.stripe_subscription_id).toBe('sub_old_01');
    expect(auditDetails.before_state.subscription_metadata).toEqual({ foo: 'bar' });
  });

  it('atomicity: rolls back the UPDATE if the audit-log INSERT fails', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [makeOrgRow()] });
    mockStripeCustomersRetrieve.mockResolvedValueOnce({
      deleted: false,
      subscriptions: { data: [] },
    });
    const tx = makeTxClient({ failOn: 'INSERT' });
    mockPoolConnect.mockResolvedValueOnce(tx.client);
    const app = await buildApp();

    const res = await request(app)
      .post(`/api/admin/accounts/${ORG_ID}/reset-subscription-state`)
      .send({ confirmation: ORG_NAME, reason: 'cleanup of stale row' });

    expect(res.status).toBe(500);
    // ROLLBACK must have run; client must be released either way.
    expect(tx.calls).toContain('ROLLBACK');
    expect(tx.calls).not.toContain('COMMIT');
    expect(tx.release).toHaveBeenCalled();
  });

  it('atomicity: rolls back if the UPDATE itself fails', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [makeOrgRow()] });
    mockStripeCustomersRetrieve.mockResolvedValueOnce({
      deleted: false,
      subscriptions: { data: [] },
    });
    const tx = makeTxClient({ failOn: 'UPDATE' });
    mockPoolConnect.mockResolvedValueOnce(tx.client);
    const app = await buildApp();

    const res = await request(app)
      .post(`/api/admin/accounts/${ORG_ID}/reset-subscription-state`)
      .send({ confirmation: ORG_NAME, reason: 'cleanup of stale row' });

    expect(res.status).toBe(500);
    expect(tx.calls).toContain('ROLLBACK');
    expect(tx.calls).not.toContain('COMMIT');
    // Exactly once — a finally-block refactor that double-releases is a real pg footgun.
    expect(tx.release).toHaveBeenCalledTimes(1);
  });
});
