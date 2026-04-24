import { describe, it, expect, vi, beforeEach } from 'vitest';
import type Stripe from 'stripe';
import type { WorkOS } from '@workos-inc/node';
import type { Pool } from 'pg';
import type { Logger } from 'pino';
import {
  handleSubscriptionCreated,
  type HandleSubscriptionCreatedArgs,
} from '../../src/billing/handle-subscription-created.js';
import type { OrganizationDatabase, Organization } from '../../src/db/organization-db.js';

const ORG_ID = 'org_test_456';
const CUSTOMER_ID = 'cus_test_123';
const SUB_ID = 'sub_test_789';
const USER_ID = 'user_test_abc';
const USER_EMAIL = 'signer@example.com';

function makeLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as unknown as Logger;
}

function makeOrg(overrides: Partial<Organization> = {}): Organization {
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
  } as Organization;
}

function makeSubscription(overrides: Partial<Stripe.Subscription> = {}): Stripe.Subscription {
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
    } as Stripe.ApiList<Stripe.SubscriptionItem>,
    ...overrides,
  } as Stripe.Subscription;
}

function makeCustomer(overrides: Partial<Stripe.Customer> = {}): Stripe.Customer {
  return {
    id: CUSTOMER_ID,
    email: USER_EMAIL,
    metadata: {},
    deleted: false,
    ...overrides,
  } as Stripe.Customer;
}

function makeUser(overrides: Record<string, unknown> = {}) {
  return {
    id: USER_ID,
    email: USER_EMAIL,
    firstName: 'Signer',
    ...overrides,
  };
}

interface MockedDeps {
  stripe: {
    customers: { retrieve: ReturnType<typeof vi.fn> };
    products: { retrieve: ReturnType<typeof vi.fn> };
    subscriptions: { update: ReturnType<typeof vi.fn> };
  };
  workos: {
    userManagement: {
      getUser: ReturnType<typeof vi.fn>;
      listUsers: ReturnType<typeof vi.fn>;
      listOrganizationMemberships: ReturnType<typeof vi.fn>;
    };
  };
  orgDb: {
    getCurrentAgreementByType: ReturnType<typeof vi.fn>;
    updateOrganization: ReturnType<typeof vi.fn>;
    recordUserAgreementAcceptance: ReturnType<typeof vi.fn>;
    recordAuditLog: ReturnType<typeof vi.fn>;
  };
  pool: { query: ReturnType<typeof vi.fn> };
  notifySystemError: ReturnType<typeof vi.fn>;
  notifyNewSubscription: ReturnType<typeof vi.fn>;
  logger: Logger;
}

function makeMockDeps(): MockedDeps {
  return {
    stripe: {
      customers: { retrieve: vi.fn().mockResolvedValue(makeCustomer()) },
      products: { retrieve: vi.fn().mockResolvedValue({ name: 'Member Standard' }) },
      subscriptions: { update: vi.fn().mockResolvedValue(undefined) },
    },
    workos: {
      userManagement: {
        getUser: vi.fn().mockResolvedValue(makeUser()),
        listUsers: vi.fn().mockResolvedValue({ data: [] }),
        listOrganizationMemberships: vi.fn().mockResolvedValue({ data: [{ id: 'om_1' }] }),
      },
    },
    orgDb: {
      getCurrentAgreementByType: vi.fn().mockResolvedValue({ version: '1.0' }),
      updateOrganization: vi.fn().mockResolvedValue(undefined),
      recordUserAgreementAcceptance: vi.fn().mockResolvedValue(undefined),
      recordAuditLog: vi.fn().mockResolvedValue(undefined),
    },
    pool: { query: vi.fn().mockResolvedValue({ rowCount: 1 }) },
    notifySystemError: vi.fn(),
    notifyNewSubscription: vi.fn().mockResolvedValue(true),
    logger: makeLogger(),
  };
}

function makeArgs(
  deps: MockedDeps,
  overrides: Partial<HandleSubscriptionCreatedArgs> = {},
): HandleSubscriptionCreatedArgs {
  return {
    subscription: makeSubscription(),
    customerId: CUSTOMER_ID,
    org: makeOrg(),
    stripe: deps.stripe as unknown as Stripe,
    workos: deps.workos as unknown as WorkOS,
    orgDb: deps.orgDb as unknown as OrganizationDatabase,
    pool: deps.pool as unknown as Pool,
    logger: deps.logger,
    notifySystemError: deps.notifySystemError,
    notifyNewSubscription: deps.notifyNewSubscription,
    ...overrides,
  };
}

describe('handleSubscriptionCreated', () => {
  let deps: MockedDeps;

  beforeEach(() => {
    vi.clearAllMocks();
    deps = makeMockDeps();
  });

  it('happy path: records org agreement, user attestation, audit log, activity row, and returns admin context', async () => {
    const result = await handleSubscriptionCreated(makeArgs(deps));

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

    expect(deps.notifySystemError).not.toHaveBeenCalled();

    expect(result).toEqual({
      userEmail: USER_EMAIL,
      workosUserId: USER_ID,
      firstName: 'Signer',
      productName: 'Member Standard',
    });
  });

  it('deleted customer short-circuits: notifies, records nothing, returns undefined', async () => {
    deps.stripe.customers.retrieve.mockResolvedValue({ id: CUSTOMER_ID, deleted: true });

    const result = await handleSubscriptionCreated(makeArgs(deps));

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
    const result = await handleSubscriptionCreated(makeArgs(deps, {
      org: makeOrg({ pending_agreement_user_id: null }),
    }));

    expect(deps.orgDb.updateOrganization).toHaveBeenCalledTimes(1);
    expect(deps.orgDb.updateOrganization).toHaveBeenCalledWith(ORG_ID, expect.objectContaining({
      agreement_version: '1.0',
    }));

    expect(deps.orgDb.recordUserAgreementAcceptance).not.toHaveBeenCalled();
    expect(deps.orgDb.recordAuditLog).not.toHaveBeenCalled();
    expect(deps.pool.query).not.toHaveBeenCalled();

    expect(deps.notifySystemError).toHaveBeenCalledWith(expect.objectContaining({
      errorMessage: expect.stringContaining('no WorkOS user resolvable'),
    }));

    expect(deps.notifyNewSubscription).toHaveBeenCalled();
    expect(deps.stripe.subscriptions.update).toHaveBeenCalled();

    expect(result).toBeUndefined();
  });

  it('recordUserAgreementAcceptance throws: alerts, no throw, pending NOT cleared, handler continues', async () => {
    deps.orgDb.recordUserAgreementAcceptance.mockRejectedValue(new Error('unique violation'));

    const result = await handleSubscriptionCreated(makeArgs(deps));

    expect(deps.notifySystemError).toHaveBeenCalledWith(expect.objectContaining({
      errorMessage: expect.stringContaining('insert failed'),
    }));

    // Only the org-level update fired; pending-clear did NOT run
    expect(deps.orgDb.updateOrganization).toHaveBeenCalledTimes(1);

    expect(deps.orgDb.recordAuditLog).not.toHaveBeenCalled();
    expect(deps.pool.query).not.toHaveBeenCalled();

    expect(deps.notifyNewSubscription).toHaveBeenCalled();

    expect(result).toBeUndefined();
  });

  it('attributes the user-level record to pending_agreement_user_id even when subscription metadata names a different user', async () => {
    // Positive assertion only: the record lands with the PENDING user id,
    // not the metadata user id. The resolver's own unit test covers
    // which sources get queried in what order.
    const subscription = makeSubscription({ metadata: { workos_user_id: 'user_metadata_different' } });
    deps.workos.userManagement.getUser.mockImplementation(async (id: string) => {
      if (id === USER_ID) return makeUser({ id: USER_ID });
      return makeUser({ id });
    });

    await handleSubscriptionCreated(makeArgs(deps, { subscription }));

    expect(deps.orgDb.recordUserAgreementAcceptance).toHaveBeenCalledWith(expect.objectContaining({
      workos_user_id: USER_ID,
    }));
  });

  it('no pending_agreement_version: falls back to current published version via orgDb lookup', async () => {
    deps.orgDb.getCurrentAgreementByType.mockResolvedValue({ version: '2.0' });

    await handleSubscriptionCreated(makeArgs(deps, {
      org: makeOrg({
        pending_agreement_version: null,
        pending_agreement_accepted_at: null,
        pending_agreement_user_id: USER_ID,
      }),
    }));

    expect(deps.orgDb.recordUserAgreementAcceptance).toHaveBeenCalledWith(
      expect.objectContaining({ agreement_version: '2.0' }),
    );
  });

  it('pending_agreement_version present but pending_agreement_accepted_at missing: uses now() for the timestamp', async () => {
    const before = Date.now();
    await handleSubscriptionCreated(makeArgs(deps, {
      org: makeOrg({
        pending_agreement_version: '1.0',
        pending_agreement_accepted_at: null,
      }),
    }));
    const after = Date.now();

    const firstUpdate = deps.orgDb.updateOrganization.mock.calls[0];
    const signedAt = firstUpdate[1].agreement_signed_at as Date;
    expect(signedAt).toBeInstanceOf(Date);
    expect(signedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(signedAt.getTime()).toBeLessThanOrEqual(after);
  });

  it('Stripe metadata stamp failure is logged but does NOT fail the handler', async () => {
    deps.stripe.subscriptions.update.mockRejectedValue(new Error('stripe 500'));

    const result = await handleSubscriptionCreated(makeArgs(deps));

    expect(result).toEqual(expect.objectContaining({ workosUserId: USER_ID }));
    expect(deps.orgDb.recordUserAgreementAcceptance).toHaveBeenCalled();
  });

  it('notifyNewSubscription rejection is logged but does NOT fail the handler', async () => {
    deps.notifyNewSubscription.mockRejectedValue(new Error('slack 503'));

    const result = await handleSubscriptionCreated(makeArgs(deps));

    expect(result).toEqual(expect.objectContaining({ workosUserId: USER_ID }));
    expect(deps.orgDb.recordUserAgreementAcceptance).toHaveBeenCalled();
  });
});
