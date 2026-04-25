import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as clientModule from '../../src/db/client.js';
import * as stripeClientModule from '../../src/billing/stripe-client.js';

vi.mock('../../src/db/client.js');
vi.mock('../../src/billing/stripe-client.js');

// Stub WorkOS to avoid missing env var errors at import time
process.env.WORKOS_API_KEY = process.env.WORKOS_API_KEY ?? 'test';
process.env.WORKOS_CLIENT_ID = process.env.WORKOS_CLIENT_ID ?? 'client_test';

const { OrganizationDatabase } = await import('../../src/db/organization-db.js');

describe('findStripeCustomerMismatches — email / name detection', () => {
  let orgDb: InstanceType<typeof OrganizationDatabase>;
  let mockPool: any;

  beforeEach(() => {
    vi.clearAllMocks();

    mockPool = {
      query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    };
    vi.mocked(clientModule.getPool).mockReturnValue(mockPool);

    orgDb = new OrganizationDatabase();
  });

  it('detects an orphan customer matched by email (ResponsiveAds shape)', async () => {
    // Metadata scan finds nothing (orphan has no metadata)
    vi.mocked(stripeClientModule.listCustomersWithOrgIds).mockResolvedValue([]);

    // All-customers scan returns two customers with the same email
    vi.mocked(stripeClientModule.listAllCustomersWithDetails).mockResolvedValue([
      {
        id: 'cus_LINKED',
        email: 'matt@responsiveads.com',
        name: 'Acme Corp',
        workosOrgId: 'org_ABC',
        hasActiveSubscription: true,
      },
      {
        id: 'cus_ORPHAN',
        email: 'Matt@responsiveads.com', // different case — still a match
        name: 'Acme Corp',
        workosOrgId: undefined,
        hasActiveSubscription: true,
      },
    ]);

    // DB: linked customer for org_ABC
    mockPool.query.mockResolvedValueOnce({
      rows: [{ workos_organization_id: 'org_ABC', stripe_customer_id: 'cus_LINKED' }],
    });

    // getOrganization for org_ABC
    vi.spyOn(orgDb as any, 'getOrganization').mockResolvedValue({
      workos_organization_id: 'org_ABC',
      name: 'Acme Corp',
      stripe_customer_id: 'cus_LINKED',
    });

    const mismatches = await orgDb.findStripeCustomerMismatches();

    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]).toMatchObject({
      org_id: 'org_ABC',
      db_customer_id: 'cus_LINKED',
      orphan_customer_id: 'cus_ORPHAN',
      match_reason: 'email',
    });
  });

  it('deduplicates: metadata match is not also reported as email match', async () => {
    // Metadata scan finds the mismatch
    vi.mocked(stripeClientModule.listCustomersWithOrgIds).mockResolvedValue([
      { stripeCustomerId: 'cus_META', workosOrgId: 'org_XYZ' },
    ]);

    vi.mocked(stripeClientModule.listAllCustomersWithDetails).mockResolvedValue([
      {
        id: 'cus_DB',
        email: 'shared@example.com',
        name: 'Pinnacle Media',
        workosOrgId: 'org_XYZ',
        hasActiveSubscription: false,
      },
      {
        id: 'cus_META',
        email: 'shared@example.com',
        name: 'Pinnacle Media',
        workosOrgId: 'org_XYZ', // has metadata but different from DB
        hasActiveSubscription: false,
      },
    ]);

    mockPool.query.mockResolvedValueOnce({
      rows: [{ workos_organization_id: 'org_XYZ', stripe_customer_id: 'cus_DB' }],
    });

    vi.spyOn(orgDb as any, 'getOrganization').mockResolvedValue({
      workos_organization_id: 'org_XYZ',
      name: 'Pinnacle Media',
      stripe_customer_id: 'cus_DB',
    });

    const mismatches = await orgDb.findStripeCustomerMismatches();

    // Only one mismatch, reported as metadata, not duplicated as email
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0].match_reason).toBe('metadata');
  });

  it('detects orphan matched by name + active subscription', async () => {
    vi.mocked(stripeClientModule.listCustomersWithOrgIds).mockResolvedValue([]);

    vi.mocked(stripeClientModule.listAllCustomersWithDetails).mockResolvedValue([
      {
        id: 'cus_LINKED2',
        email: null,
        name: 'Nova Brands',
        workosOrgId: 'org_NB',
        hasActiveSubscription: true,
      },
      {
        id: 'cus_ORPHAN2',
        email: null,
        name: 'Nova Brands',
        workosOrgId: undefined,
        hasActiveSubscription: true,
      },
    ]);

    mockPool.query.mockResolvedValueOnce({
      rows: [{ workos_organization_id: 'org_NB', stripe_customer_id: 'cus_LINKED2' }],
    });

    vi.spyOn(orgDb as any, 'getOrganization').mockResolvedValue({
      workos_organization_id: 'org_NB',
      name: 'Nova Brands',
      stripe_customer_id: 'cus_LINKED2',
    });

    const mismatches = await orgDb.findStripeCustomerMismatches();

    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]).toMatchObject({
      orphan_customer_id: 'cus_ORPHAN2',
      match_reason: 'name',
    });
  });

  it('ignores name matches where orphan has no active subscription', async () => {
    vi.mocked(stripeClientModule.listCustomersWithOrgIds).mockResolvedValue([]);

    vi.mocked(stripeClientModule.listAllCustomersWithDetails).mockResolvedValue([
      {
        id: 'cus_LINKED3',
        email: null,
        name: 'StreamHaus',
        workosOrgId: 'org_SH',
        hasActiveSubscription: true,
      },
      {
        id: 'cus_STALE',
        email: null,
        name: 'StreamHaus',
        workosOrgId: undefined,
        hasActiveSubscription: false, // no active sub — should not be flagged by name
      },
    ]);

    mockPool.query.mockResolvedValueOnce({
      rows: [{ workos_organization_id: 'org_SH', stripe_customer_id: 'cus_LINKED3' }],
    });

    const mismatches = await orgDb.findStripeCustomerMismatches();

    expect(mismatches).toHaveLength(0);
  });
});
