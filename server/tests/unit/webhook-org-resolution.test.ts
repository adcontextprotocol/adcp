import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveOrgForStripeCustomer } from '../../src/billing/webhook-helpers.js';
import { StripeCustomerConflictError } from '../../src/db/organization-db.js';

// Mock the logger to avoid console noise in tests
vi.mock('../../src/logger.js', () => {
  const childLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    logger: childLogger,
    createLogger: () => childLogger,
  };
});

const TEST_CUSTOMER_ID = 'cus_test_123';
const TEST_ORG_ID = 'org_test_456';
const TEST_ORG = {
  workos_organization_id: TEST_ORG_ID,
  name: 'Test Org',
  stripe_customer_id: TEST_CUSTOMER_ID,
  is_personal: false,
} as any;

function createMockOrgDb(overrides?: Record<string, any>) {
  return {
    getOrganizationByStripeCustomerId: vi.fn().mockResolvedValue(null),
    getOrganization: vi.fn().mockResolvedValue(null),
    setStripeCustomerId: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as any;
}

function createMockStripe(customerMetadata?: Record<string, string>, subscriptionMetadata?: Record<string, string>) {
  return {
    customers: {
      retrieve: vi.fn().mockResolvedValue({
        id: TEST_CUSTOMER_ID,
        metadata: customerMetadata || {},
      }),
    },
    subscriptions: {
      retrieve: vi.fn().mockResolvedValue({
        id: 'sub_test',
        metadata: subscriptionMetadata || {},
      }),
    },
  } as any;
}

describe('resolveOrgForStripeCustomer', () => {
  it('returns org on fast path via stripe_customer_id without calling Stripe API', async () => {
    const orgDb = createMockOrgDb({
      getOrganizationByStripeCustomerId: vi.fn().mockResolvedValue(TEST_ORG),
    });
    const stripe = createMockStripe();

    const result = await resolveOrgForStripeCustomer({
      customerId: TEST_CUSTOMER_ID,
      stripe,
      orgDb,
    });

    expect(result).toEqual(TEST_ORG);
    expect(stripe.customers.retrieve).not.toHaveBeenCalled();
    expect(orgDb.setStripeCustomerId).not.toHaveBeenCalled();
  });

  it('falls back to Stripe customer metadata when stripe_customer_id lookup fails', async () => {
    const orgDb = createMockOrgDb({
      getOrganization: vi.fn().mockResolvedValue(TEST_ORG),
    });
    const stripe = createMockStripe({ workos_organization_id: TEST_ORG_ID });

    const result = await resolveOrgForStripeCustomer({
      customerId: TEST_CUSTOMER_ID,
      stripe,
      orgDb,
    });

    expect(result).toEqual(TEST_ORG);
    expect(stripe.customers.retrieve).toHaveBeenCalledWith(TEST_CUSTOMER_ID);
    expect(orgDb.getOrganization).toHaveBeenCalledWith(TEST_ORG_ID);
    expect(orgDb.setStripeCustomerId).toHaveBeenCalledWith(TEST_ORG_ID, TEST_CUSTOMER_ID);
  });

  it('falls back to subscription metadata when customer metadata is missing', async () => {
    const orgDb = createMockOrgDb({
      getOrganization: vi.fn().mockResolvedValue(TEST_ORG),
    });
    const stripe = createMockStripe(); // no customer metadata

    const subscription = {
      id: 'sub_test',
      metadata: { workos_organization_id: TEST_ORG_ID },
    } as any;

    const result = await resolveOrgForStripeCustomer({
      customerId: TEST_CUSTOMER_ID,
      stripe,
      orgDb,
      subscription,
    });

    expect(result).toEqual(TEST_ORG);
    expect(orgDb.getOrganization).toHaveBeenCalledWith(TEST_ORG_ID);
    expect(orgDb.setStripeCustomerId).toHaveBeenCalledWith(TEST_ORG_ID, TEST_CUSTOMER_ID);
  });

  it('falls back to invoice subscription metadata', async () => {
    const orgDb = createMockOrgDb({
      getOrganization: vi.fn().mockResolvedValue(TEST_ORG),
    });
    const stripe = createMockStripe(
      {}, // no customer metadata
      { workos_organization_id: TEST_ORG_ID }, // subscription metadata
    );

    const invoice = {
      id: 'inv_test',
      subscription: 'sub_test',
    } as any;

    const result = await resolveOrgForStripeCustomer({
      customerId: TEST_CUSTOMER_ID,
      stripe,
      orgDb,
      invoice,
    });

    expect(result).toEqual(TEST_ORG);
    expect(stripe.subscriptions.retrieve).toHaveBeenCalledWith('sub_test');
    expect(orgDb.getOrganization).toHaveBeenCalledWith(TEST_ORG_ID);
    expect(orgDb.setStripeCustomerId).toHaveBeenCalledWith(TEST_ORG_ID, TEST_CUSTOMER_ID);
  });

  it('returns null when all lookups fail', async () => {
    const orgDb = createMockOrgDb();
    const stripe = createMockStripe();

    const result = await resolveOrgForStripeCustomer({
      customerId: TEST_CUSTOMER_ID,
      stripe,
      orgDb,
    });

    expect(result).toBeNull();
    expect(orgDb.setStripeCustomerId).not.toHaveBeenCalled();
  });

  it('returns null when org ID found but org does not exist in database', async () => {
    const orgDb = createMockOrgDb(); // getOrganization returns null
    const stripe = createMockStripe({ workos_organization_id: TEST_ORG_ID });

    const result = await resolveOrgForStripeCustomer({
      customerId: TEST_CUSTOMER_ID,
      stripe,
      orgDb,
    });

    expect(result).toBeNull();
    expect(orgDb.getOrganization).toHaveBeenCalledWith(TEST_ORG_ID);
    expect(orgDb.setStripeCustomerId).not.toHaveBeenCalled();
  });

  it('handles StripeCustomerConflictError gracefully — returns org without throwing', async () => {
    const orgDb = createMockOrgDb({
      getOrganization: vi.fn().mockResolvedValue(TEST_ORG),
      setStripeCustomerId: vi.fn().mockRejectedValue(
        new StripeCustomerConflictError(TEST_CUSTOMER_ID, TEST_ORG_ID, 'org_other', 'Other Org')
      ),
    });
    const stripe = createMockStripe({ workos_organization_id: TEST_ORG_ID });

    const result = await resolveOrgForStripeCustomer({
      customerId: TEST_CUSTOMER_ID,
      stripe,
      orgDb,
    });

    expect(result).toEqual(TEST_ORG);
  });

  it('handles deleted Stripe customer by falling back to subscription metadata', async () => {
    const orgDb = createMockOrgDb({
      getOrganization: vi.fn().mockResolvedValue(TEST_ORG),
    });
    const stripe = {
      customers: {
        retrieve: vi.fn().mockResolvedValue({ id: TEST_CUSTOMER_ID, deleted: true }),
      },
    } as any;

    const subscription = {
      id: 'sub_test',
      metadata: { workos_organization_id: TEST_ORG_ID },
    } as any;

    const result = await resolveOrgForStripeCustomer({
      customerId: TEST_CUSTOMER_ID,
      stripe,
      orgDb,
      subscription,
    });

    expect(result).toEqual(TEST_ORG);
  });

  it('returns null for deleted customer with no other fallbacks', async () => {
    const orgDb = createMockOrgDb();
    const stripe = {
      customers: {
        retrieve: vi.fn().mockResolvedValue({ id: TEST_CUSTOMER_ID, deleted: true }),
      },
    } as any;

    const result = await resolveOrgForStripeCustomer({
      customerId: TEST_CUSTOMER_ID,
      stripe,
      orgDb,
    });

    expect(result).toBeNull();
  });

  it('prefers subscription metadata over invoice subscription lookup', async () => {
    const orgDb = createMockOrgDb({
      getOrganization: vi.fn().mockResolvedValue(TEST_ORG),
    });
    const stripe = createMockStripe(
      {}, // no customer metadata
      { workos_organization_id: 'org_from_invoice_sub' }, // invoice sub metadata (should not be reached)
    );

    const subscription = {
      id: 'sub_test',
      metadata: { workos_organization_id: TEST_ORG_ID },
    } as any;

    const invoice = {
      id: 'inv_test',
      subscription: 'sub_test',
    } as any;

    const result = await resolveOrgForStripeCustomer({
      customerId: TEST_CUSTOMER_ID,
      stripe,
      orgDb,
      subscription,
      invoice,
    });

    expect(result).toEqual(TEST_ORG);
    // Should NOT have called subscriptions.retrieve since subscription metadata was sufficient
    expect(stripe.subscriptions.retrieve).not.toHaveBeenCalled();
    expect(orgDb.getOrganization).toHaveBeenCalledWith(TEST_ORG_ID);
  });
});
