import { describe, it, expect, vi, beforeEach } from 'vitest';
import type Stripe from 'stripe';
import { handleSubscriptionCreated } from '../../src/billing/handle-subscription-created.js';

// Silence logger to keep test output clean. The handler's observable
// side effects are DB / Stripe / notifier calls — not log lines — so
// logger assertions are out of scope here.
vi.mock('../../src/logger.js', () => {
  const l = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return { logger: l, createLogger: () => l };
});

const ORG_ID = 'org_test_456';
const CUSTOMER_ID = 'cus_test_123';
const SUB_ID = 'sub_test_789';
const USER_ID = 'user_test_abc';
const USER_EMAIL = 'signer@example.com';

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as any;
}

function makeOrg(overrides: Record<string, any> = {}) {
  return {
    workos_organization_id: ORG_ID,
    name: 'Test Org',
    stripe_customer_id: CUSTOMER_ID,
    is_personal: false,
    pending_agreement_version: '1.0',
    pending_agreement_accepted_at: new Date('2026-04-20T00:00:00Z'),
    pending_agreement_user_id: USER_ID,
    agreement_signed_at: null,
    agreement_version: null,
    ...overrides,
  } as any;
}

function makeSubscription(overrides: Record<string, any> = {}): Stripe.Subscription {
  return {
    id: SUB_ID,
    customer: CUSTOMER_ID,
    status: 'active',
    currency: 'usd',
    metadata: {},
    items: {
      data: [{
        price: {
          unit_amount: 15000,
          recurring: { interval: 'year' },
          product: 'prod_mem_standard',
        },
      }],
    },
    ...overrides,
  } as any;
}

function makeCustomer(overrides: Record<string, any> = {}): Stripe.Customer {
  return {
    id: CUSTOMER_ID,
    email: USER_EMAIL,
    metadata: {},
    deleted: false,
    ...overrides,
  } as any;
}

function makeUser(overrides: Record<string, any> = {}) {
  return {
    id: USER_ID,
    email: USER_EMAIL,
    firstName: 'Signer',
    ...overrides,
  };
}

function makeDeps(overrides: Record<string, any> = {}) {
  const logger = makeLogger();
  const orgDb = {
    getCurrentAgreementByType: vi.fn().mockResolvedValue({ version: '1.0' }),
    updateOrganization: vi.fn().mockResolvedValue(undefined),
    recordUserAgreementAcceptance: vi.fn().mockResolvedValue(undefined),
    recordAuditLog: vi.fn().mockResolvedValue(undefined),
  };
  const stripe = {
    customers: { retrieve: vi.fn().mockResolvedValue(makeCustomer()) },
    products: { retrieve: vi.fn().mockResolvedValue({ name: 'Member Standard' }) },
    subscriptions: { update: vi.fn().mockResolvedValue(undefined) },
  };
  const workos = {
    userManagement: {
      getUser: vi.fn().mockResolvedValue(makeUser()),
      listUsers: vi.fn().mockResolvedValue({ data: [] }),
      listOrganizationMemberships: vi.fn().mockResolvedValue({ data: [{ id: 'om_1' }] }),
    },
  };
  const pool = { query: vi.fn().mockResolvedValue({ rowCount: 1 }) };
  const notifySystemError = vi.fn();
  const notifyNewSubscription = vi.fn().mockResolvedValue(true);
  return { logger, orgDb, stripe, workos, pool, notifySystemError, notifyNewSubscription, ...overrides };
}

describe('handleSubscriptionCreated', () => {
  let deps: ReturnType<typeof makeDeps>;

  beforeEach(() => {
    vi.clearAllMocks();
    deps = makeDeps();
  });

  it('happy path: records org agreement, user attestation, audit log, activity row, and returns admin context', async () => {
    const result = await handleSubscriptionCreated({
      subscription: makeSubscription(),
      customerId: CUSTOMER_ID,
      org: makeOrg(),
      ...(deps as any),
    });

    // User-level attestation inserted with the expected keys
    expect(deps.orgDb.recordUserAgreementAcceptance).toHaveBeenCalledWith({
      workos_user_id: USER_ID,
      email: USER_EMAIL,
      agreement_type: 'membership',
      agreement_version: '1.0',
      workos_organization_id: ORG_ID,
    });

    // Org-level agreement set, then pending_* cleared in a second update
    const updates = deps.orgDb.updateOrganization.mock.calls;
    expect(updates[0]).toEqual([ORG_ID, expect.objectContaining({
      agreement_version: '1.0',
      agreement_signed_at: expect.any(Date),
    })]);
    expect(updates[1]).toEqual([ORG_ID, {
      pending_agreement_version: null,
      pending_agreement_accepted_at: null,
      pending_agreement_user_id: null,
    }]);

    // Audit log + org_activities row
    expect(deps.orgDb.recordAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      workos_organization_id: ORG_ID,
      workos_user_id: USER_ID,
      action: 'subscription_created',
    }));
    expect(deps.pool.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO org_activities'),
      expect.arrayContaining([ORG_ID, 'subscription', expect.any(String), USER_ID, USER_EMAIL]),
    );

    // Slack notify + Stripe metadata stamp fired
    expect(deps.notifyNewSubscription).toHaveBeenCalled();
    expect(deps.stripe.subscriptions.update).toHaveBeenCalledWith(SUB_ID, {
      metadata: expect.objectContaining({
        workos_organization_id: ORG_ID,
        membership_agreement_version: '1.0',
      }),
    });

    // Failure path must not fire
    expect(deps.notifySystemError).not.toHaveBeenCalled();

    expect(result).toEqual({
      userEmail: USER_EMAIL,
      workosUserId: USER_ID,
      firstName: 'Signer',
      productName: 'Member Standard',
    });
  });

  it('deleted customer short-circuits: notifies, records nothing, returns undefined', async () => {
    deps.stripe.customers.retrieve.mockResolvedValue({ id: CUSTOMER_ID, deleted: true } as any);

    const result = await handleSubscriptionCreated({
      subscription: makeSubscription(),
      customerId: CUSTOMER_ID,
      org: makeOrg(),
      ...(deps as any),
    });

    expect(result).toBeUndefined();
    expect(deps.notifySystemError).toHaveBeenCalledWith(expect.objectContaining({
      source: 'stripe-webhook-agreement',
      errorMessage: expect.stringContaining('customer is deleted'),
    }));
    expect(deps.orgDb.updateOrganization).not.toHaveBeenCalled();
    expect(deps.orgDb.recordUserAgreementAcceptance).not.toHaveBeenCalled();
    expect(deps.notifyNewSubscription).not.toHaveBeenCalled();
  });

  it('user not resolvable: records org agreement, alerts loudly, does NOT clear pending (so Stripe retry can reuse it)', async () => {
    // Force resolver to fail: no pending id, no metadata, no matching email
    deps.workos.userManagement.listOrganizationMemberships.mockResolvedValue({ data: [] });
    const result = await handleSubscriptionCreated({
      subscription: makeSubscription(),
      customerId: CUSTOMER_ID,
      org: makeOrg({ pending_agreement_user_id: null }),
      ...(deps as any),
    });

    // Org-level agreement still recorded (one update, not two — pending not cleared)
    expect(deps.orgDb.updateOrganization).toHaveBeenCalledTimes(1);
    expect(deps.orgDb.updateOrganization).toHaveBeenCalledWith(ORG_ID, expect.objectContaining({
      agreement_version: '1.0',
    }));

    // No user-level attestation, no audit log, no activity row
    expect(deps.orgDb.recordUserAgreementAcceptance).not.toHaveBeenCalled();
    expect(deps.orgDb.recordAuditLog).not.toHaveBeenCalled();
    expect(deps.pool.query).not.toHaveBeenCalled();

    // Loud alert
    expect(deps.notifySystemError).toHaveBeenCalledWith(expect.objectContaining({
      errorMessage: expect.stringContaining('no WorkOS user resolvable'),
    }));

    // Slack + metadata stamp still fire (org-level recording happened)
    expect(deps.notifyNewSubscription).toHaveBeenCalled();
    expect(deps.stripe.subscriptions.update).toHaveBeenCalled();

    expect(result).toBeUndefined();
  });

  it('recordUserAgreementAcceptance throws: alerts, no throw, pending NOT cleared, handler continues', async () => {
    deps.orgDb.recordUserAgreementAcceptance.mockRejectedValue(new Error('unique violation'));

    const result = await handleSubscriptionCreated({
      subscription: makeSubscription(),
      customerId: CUSTOMER_ID,
      org: makeOrg(),
      ...(deps as any),
    });

    expect(deps.notifySystemError).toHaveBeenCalledWith(expect.objectContaining({
      errorMessage: expect.stringContaining('insert failed'),
    }));

    // Only the org-level update fired; pending-clear did NOT run
    expect(deps.orgDb.updateOrganization).toHaveBeenCalledTimes(1);

    // Audit log + activity row skipped since user record didn't land
    expect(deps.orgDb.recordAuditLog).not.toHaveBeenCalled();
    expect(deps.pool.query).not.toHaveBeenCalled();

    // Rest of the webhook still runs
    expect(deps.notifyNewSubscription).toHaveBeenCalled();

    expect(result).toBeUndefined();
  });

  it('pending_agreement_user_id is the highest-priority source, beating subscription and customer metadata', async () => {
    const subscription = makeSubscription({
      metadata: { workos_user_id: 'user_metadata_loser' },
    });
    const customer = makeCustomer({
      metadata: { workos_user_id: 'user_metadata_loser_2' },
    });
    deps.stripe.customers.retrieve.mockResolvedValue(customer);
    deps.workos.userManagement.getUser.mockResolvedValue(makeUser({ id: USER_ID }));

    await handleSubscriptionCreated({
      subscription,
      customerId: CUSTOMER_ID,
      org: makeOrg({ pending_agreement_user_id: USER_ID }),
      ...(deps as any),
    });

    expect(deps.workos.userManagement.getUser).toHaveBeenCalledWith(USER_ID);
    // Metadata-sourced ids should never have been looked up
    expect(deps.workos.userManagement.getUser).not.toHaveBeenCalledWith('user_metadata_loser');
    expect(deps.workos.userManagement.getUser).not.toHaveBeenCalledWith('user_metadata_loser_2');
  });

  it('no pending_agreement_version: falls back to current published version via orgDb lookup', async () => {
    deps.orgDb.getCurrentAgreementByType.mockResolvedValue({ version: '2.0' });

    await handleSubscriptionCreated({
      subscription: makeSubscription(),
      customerId: CUSTOMER_ID,
      org: makeOrg({
        pending_agreement_version: null,
        pending_agreement_accepted_at: null,
        pending_agreement_user_id: USER_ID,
      }),
      ...(deps as any),
    });

    expect(deps.orgDb.recordUserAgreementAcceptance).toHaveBeenCalledWith(
      expect.objectContaining({ agreement_version: '2.0' }),
    );
  });

  it('Stripe metadata stamp failure is logged but does NOT fail the handler', async () => {
    deps.stripe.subscriptions.update.mockRejectedValue(new Error('stripe 500'));

    const result = await handleSubscriptionCreated({
      subscription: makeSubscription(),
      customerId: CUSTOMER_ID,
      org: makeOrg(),
      ...(deps as any),
    });

    // Happy path result still returned — metadata stamp is fire-and-forget
    expect(result).toEqual(expect.objectContaining({ workosUserId: USER_ID }));
    // User-level record still landed
    expect(deps.orgDb.recordUserAgreementAcceptance).toHaveBeenCalled();
  });
});
