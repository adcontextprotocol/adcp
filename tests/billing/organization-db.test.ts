// lint-allow-test-imports-file: TODO(#3118-followup) — this suite uses
// dynamic-import-after-vi.mock to grab fresh mock refs per test. Convert to
// the vi.hoisted pattern so it can drop the resetModules + dynamic imports.
import { describe, test, expect, vi, beforeEach } from 'vitest';

// Mock the database client
vi.mock('../../server/src/db/client.js', () => ({
  getPool: vi.fn(),
}));

// Mock the Stripe client
vi.mock('../../server/src/billing/stripe-client.js', () => ({
  getStripeSubscriptionInfo: vi.fn(),
}));

describe('organization-db', () => {
  let mockPool: any;
  let mockGetStripeSubscriptionInfo: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();

    // Setup mock pool with connection support for transactional queries
    const mockClient = {
      query: vi.fn(),
      release: vi.fn(),
    };
    mockPool = {
      query: vi.fn(),
      connect: vi.fn().mockResolvedValue(mockClient),
      _mockClient: mockClient,
    };

    // Setup mocks
    const { getPool } = await import('../../server/src/db/client.js') as any;
    const stripeClient = await import('../../server/src/billing/stripe-client.js') as any;
    mockGetStripeSubscriptionInfo = stripeClient.getStripeSubscriptionInfo;
    getPool.mockReturnValue(mockPool);
  });

  describe('createOrganization', () => {
    test('inserts organization with correct fields', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [{
          workos_organization_id: 'org_123',
          name: 'Test Org',
          stripe_customer_id: null,
          agreement_signed_at: null,
          agreement_version: null,
          created_at: new Date(),
          updated_at: new Date(),
        }],
      });

      const { OrganizationDatabase } = await import('../../server/src/db/organization-db.js');
      const orgDb = new OrganizationDatabase();

      const result = await orgDb.createOrganization({
        workos_organization_id: 'org_123',
        name: 'Test Org',
      });

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO organizations'),
        ['org_123', 'Test Org', false, null, null, null, null]
      );
      expect(result).toMatchObject({
        workos_organization_id: 'org_123',
        name: 'Test Org',
      });
    });

    test('persists email_domain (lowercased, trimmed) for non-personal orgs', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [{ workos_organization_id: 'org_voise', name: 'Voise Tech', email_domain: 'voisetech.com' }],
      });

      const { OrganizationDatabase } = await import('../../server/src/db/organization-db.js');
      const orgDb = new OrganizationDatabase();

      await orgDb.createOrganization({
        workos_organization_id: 'org_voise',
        name: 'Voise Tech',
        email_domain: '  Voisetech.COM  ',
      });

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO organizations'),
        ['org_voise', 'Voise Tech', false, null, null, null, 'voisetech.com']
      );
    });

    test('forces email_domain NULL on personal orgs even if one is supplied', async () => {
      // Personal-tier email_domain stays NULL by design — the column is the
      // auto-membership inference key and must not light up for individual subs.
      mockPool.query.mockResolvedValueOnce({
        rows: [{ workos_organization_id: 'org_personal', name: 'Personal' }],
      });

      const { OrganizationDatabase } = await import('../../server/src/db/organization-db.js');
      const orgDb = new OrganizationDatabase();

      await orgDb.createOrganization({
        workos_organization_id: 'org_personal',
        name: 'Personal',
        is_personal: true,
        email_domain: 'someone.dev',
      });

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO organizations'),
        ['org_personal', 'Personal', true, null, null, null, null]
      );
    });

    test('handles errors gracefully', async () => {
      mockPool.query.mockRejectedValueOnce(new Error('Database error'));

      const { OrganizationDatabase } = await import('../../server/src/db/organization-db.js');
      const orgDb = new OrganizationDatabase();

      await expect(
        orgDb.createOrganization({
          workos_organization_id: 'org_123',
          name: 'Test Org',
        })
      ).rejects.toThrow('Database error');
    });
  });

  describe('setStripeCustomerId', () => {
    test('updates existing organization', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [],
      });

      const { OrganizationDatabase } = await import('../../server/src/db/organization-db.js');
      const orgDb = new OrganizationDatabase();

      await orgDb.setStripeCustomerId('org_123', 'cus_123');

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE organizations'),
        ['cus_123', 'org_123']
      );
    });

    test('handles errors gracefully', async () => {
      mockPool.query.mockRejectedValueOnce(new Error('Database error'));

      const { OrganizationDatabase } = await import('../../server/src/db/organization-db.js');
      const orgDb = new OrganizationDatabase();

      await expect(
        orgDb.setStripeCustomerId('org_notfound', 'cus_123')
      ).rejects.toThrow('Database error');
    });
  });

  describe('getOrganization', () => {
    test('returns organization data', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [{
          workos_organization_id: 'org_123',
          name: 'Test Org',
          slug: 'test-org',
          stripe_customer_id: 'cus_123',
          created_at: new Date(),
          updated_at: new Date(),
        }],
      });

      const { OrganizationDatabase } = await import('../../server/src/db/organization-db.js');
      const orgDb = new OrganizationDatabase();

      const result = await orgDb.getOrganization('org_123');

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('SELECT * FROM organizations'),
        ['org_123']
      );
      expect(result).toMatchObject({
        workos_organization_id: 'org_123',
        name: 'Test Org',
        stripe_customer_id: 'cus_123',
      });
    });

    test('returns null for non-existent organization', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [],
      });

      const { OrganizationDatabase } = await import('../../server/src/db/organization-db.js');
      const orgDb = new OrganizationDatabase();

      const result = await orgDb.getOrganization('org_notfound');

      expect(result).toBeNull();
    });
  });

  describe('inferMembershipTier', () => {
    test('returns null for null or zero amount', async () => {
      const { inferMembershipTier } = await import('../../server/src/db/organization-db.js');
      expect(inferMembershipTier(null, 'year', false)).toBeNull();
      expect(inferMembershipTier(0, 'year', false)).toBeNull();
    });

    test('infers individual_professional for $250/yr personal', async () => {
      const { inferMembershipTier } = await import('../../server/src/db/organization-db.js');
      expect(inferMembershipTier(25000, 'year', true)).toBe('individual_professional');
    });

    test('infers individual_academic for $50/yr personal', async () => {
      const { inferMembershipTier } = await import('../../server/src/db/organization-db.js');
      expect(inferMembershipTier(5000, 'year', true)).toBe('individual_academic');
    });

    test('infers company_standard for $2,500/yr company', async () => {
      const { inferMembershipTier } = await import('../../server/src/db/organization-db.js');
      expect(inferMembershipTier(250000, 'year', false)).toBe('company_standard');
    });

    test('infers company_icl for $10,000/yr company (founding corporate rate)', async () => {
      const { inferMembershipTier } = await import('../../server/src/db/organization-db.js');
      expect(inferMembershipTier(1000000, 'year', false)).toBe('company_icl');
    });

    test('infers company_icl at $7K boundary', async () => {
      const { inferMembershipTier } = await import('../../server/src/db/organization-db.js');
      expect(inferMembershipTier(700000, 'year', false)).toBe('company_icl');
      expect(inferMembershipTier(699999, 'year', false)).toBe('company_standard');
    });

    test('infers company_icl for $15,000/yr company', async () => {
      const { inferMembershipTier } = await import('../../server/src/db/organization-db.js');
      expect(inferMembershipTier(1500000, 'year', false)).toBe('company_icl');
    });

    test('infers company_leader for $50,000/yr company', async () => {
      const { inferMembershipTier } = await import('../../server/src/db/organization-db.js');
      expect(inferMembershipTier(5000000, 'year', false)).toBe('company_leader');
    });

    test('annualizes monthly amounts', async () => {
      const { inferMembershipTier } = await import('../../server/src/db/organization-db.js');
      // $208.33/month * 12 = $2,500/yr
      expect(inferMembershipTier(20833, 'month', false)).toBe('company_standard');
    });

    test('handles monthly rounding for $250/yr individual', async () => {
      const { inferMembershipTier } = await import('../../server/src/db/organization-db.js');
      // $250/yr billed monthly = $20.83/mo = 2083¢. 2083 * 12 = 24996¢ (under 25000)
      expect(inferMembershipTier(2083, 'month', true)).toBe('individual_professional');
    });

    test('handles monthly rounding for $50/yr individual', async () => {
      const { inferMembershipTier } = await import('../../server/src/db/organization-db.js');
      // $50/yr billed monthly = $4.16/mo = 416¢. 416 * 12 = 4992¢ (under 5000)
      expect(inferMembershipTier(416, 'month', true)).toBe('individual_academic');
    });

    test('handles monthly rounding for $50K/yr company', async () => {
      const { inferMembershipTier } = await import('../../server/src/db/organization-db.js');
      // $50K/yr billed monthly = $4166.66/mo = 416666¢. 416666 * 12 = 4999992¢ (under 5000000)
      expect(inferMembershipTier(416666, 'month', false)).toBe('company_leader');
    });
  });

  describe('tierFromLookupKey', () => {
    test('maps current tier product lookup keys', async () => {
      const { tierFromLookupKey } = await import('../../server/src/db/organization-db.js');
      expect(tierFromLookupKey('aao_membership_explorer_50')).toBe('individual_academic');
      expect(tierFromLookupKey('aao_membership_professional_250')).toBe('individual_professional');
      expect(tierFromLookupKey('aao_membership_builder_3000')).toBe('company_standard');
      expect(tierFromLookupKey('aao_membership_member_15000')).toBe('company_icl');
      expect(tierFromLookupKey('aao_membership_partner_10000')).toBe('company_icl');
      expect(tierFromLookupKey('aao_membership_leader_50000')).toBe('company_leader');
    });

    test('maps legacy founding-member product lookup keys', async () => {
      const { tierFromLookupKey } = await import('../../server/src/db/organization-db.js');
      expect(tierFromLookupKey('aao_membership_individual')).toBe('individual_professional');
      expect(tierFromLookupKey('aao_membership_individual_discounted')).toBe('individual_academic');
      expect(tierFromLookupKey('aao_membership_corporate_under5m')).toBe('company_standard');
      expect(tierFromLookupKey('aao_membership_corporate_5m')).toBe('company_icl');
      expect(tierFromLookupKey('aao_membership_industry_council_leader_50000')).toBe('company_leader');
    });

    test('returns null for non-tier lookup keys', async () => {
      const { tierFromLookupKey } = await import('../../server/src/db/organization-db.js');
      expect(tierFromLookupKey(null)).toBeNull();
      expect(tierFromLookupKey(undefined)).toBeNull();
      expect(tierFromLookupKey('aao_invoice_membership_10k')).toBeNull();
      expect(tierFromLookupKey('aao_sponsorship_gold')).toBeNull();
    });
  });

  describe('getSeatUsage', () => {
    test('counts Slack-mapped users as contributors', async () => {
      // 3 total members, 1 is a derived contributor (Slack-mapped)
      mockPool.query.mockResolvedValueOnce({
        rows: [{ total: '3', contributor: '1' }],
      });

      const { getSeatUsage } = await import('../../server/src/db/organization-db.js');
      const usage = await getSeatUsage('org_123');

      expect(usage).toEqual({ contributor: 1, community_only: 2 });
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('slack_user_mappings'),
        ['org_123']
      );
    });

    test('counts working group members as contributors', async () => {
      // 5 total, 3 are contributors (mix of Slack, WG, admin-assigned)
      mockPool.query.mockResolvedValueOnce({
        rows: [{ total: '5', contributor: '3' }],
      });

      const { getSeatUsage } = await import('../../server/src/db/organization-db.js');
      const usage = await getSeatUsage('org_123');

      expect(usage).toEqual({ contributor: 3, community_only: 2 });
    });

    test('returns zeros for empty org', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [{ total: '0', contributor: '0' }],
      });

      const { getSeatUsage } = await import('../../server/src/db/organization-db.js');
      const usage = await getSeatUsage('org_123');

      expect(usage).toEqual({ contributor: 0, community_only: 0 });
    });

    test('includes admin-assigned contributor seat_type in derivation', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [{ total: '2', contributor: '2' }],
      });

      const { getSeatUsage } = await import('../../server/src/db/organization-db.js');
      const usage = await getSeatUsage('org_123');

      expect(usage).toEqual({ contributor: 2, community_only: 0 });
      // Verify the query checks seat_type = 'contributor' in the FILTER
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining("seat_type = 'contributor'"),
        ['org_123']
      );
    });
  });

  describe('getUserSeatType', () => {
    test('returns contributor for Slack-mapped user', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [{ is_contributor: true }],
      });

      const { getUserSeatType } = await import('../../server/src/db/organization-db.js');
      const result = await getUserSeatType('user_123');

      expect(result).toBe('contributor');
    });

    test('returns community_only for user with no Slack or WG access', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [{ is_contributor: false }],
      });

      const { getUserSeatType } = await import('../../server/src/db/organization-db.js');
      const result = await getUserSeatType('user_456');

      expect(result).toBe('community_only');
    });

    test('returns null for user with no org membership', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      const { getUserSeatType } = await import('../../server/src/db/organization-db.js');
      const result = await getUserSeatType('user_unknown');

      expect(result).toBeNull();
    });

    test('checks admin-assigned seat_type in derivation', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [{ is_contributor: true }],
      });

      const { getUserSeatType } = await import('../../server/src/db/organization-db.js');
      await getUserSeatType('user_789');

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining("seat_type = 'contributor'"),
        ['user_789']
      );
    });
  });

  describe('resolveMembershipTier', () => {
    test('returns explicit tier when set', async () => {
      const { resolveMembershipTier } = await import('../../server/src/db/organization-db.js');
      expect(resolveMembershipTier({
        membership_tier: 'company_standard',
        subscription_status: 'active',
        subscription_amount: 5000000,
        subscription_interval: 'year',
        is_personal: false,
      })).toBe('company_standard');
    });

    test('infers tier from active subscription when membership_tier is null', async () => {
      const { resolveMembershipTier } = await import('../../server/src/db/organization-db.js');
      expect(resolveMembershipTier({
        membership_tier: null,
        subscription_status: 'active',
        subscription_amount: 250000,
        subscription_interval: 'year',
        is_personal: false,
      })).toBe('company_standard');
    });

    test('infers tier from past_due subscription when membership_tier is null', async () => {
      const { resolveMembershipTier } = await import('../../server/src/db/organization-db.js');
      expect(resolveMembershipTier({
        membership_tier: null,
        subscription_status: 'past_due',
        subscription_amount: 25000,
        subscription_interval: 'year',
        is_personal: true,
      })).toBe('individual_professional');
    });

    test('infers tier from trialing subscription when membership_tier is null', async () => {
      const { resolveMembershipTier } = await import('../../server/src/db/organization-db.js');
      expect(resolveMembershipTier({
        membership_tier: null,
        subscription_status: 'trialing',
        subscription_amount: 250000,
        subscription_interval: 'year',
        is_personal: false,
      })).toBe('company_standard');
    });

    test('returns null when membership_tier is null and subscription is canceled', async () => {
      const { resolveMembershipTier } = await import('../../server/src/db/organization-db.js');
      expect(resolveMembershipTier({
        membership_tier: null,
        subscription_status: 'canceled',
        subscription_amount: 250000,
        subscription_interval: 'year',
        is_personal: false,
      })).toBeNull();
    });

    test('returns null when membership_tier is null and subscription is incomplete_expired', async () => {
      const { resolveMembershipTier } = await import('../../server/src/db/organization-db.js');
      expect(resolveMembershipTier({
        membership_tier: null,
        subscription_status: 'incomplete_expired',
        subscription_amount: 250000,
        subscription_interval: 'year',
        is_personal: false,
      })).toBeNull();
    });

    test('returns null when membership_tier is null and subscription is unpaid', async () => {
      const { resolveMembershipTier } = await import('../../server/src/db/organization-db.js');
      expect(resolveMembershipTier({
        membership_tier: null,
        subscription_status: 'unpaid',
        subscription_amount: 25000,
        subscription_interval: 'year',
        is_personal: true,
      })).toBeNull();
    });

    test('prefers stored lookup key over amount inference when membership_tier is null', async () => {
      const { resolveMembershipTier } = await import('../../server/src/db/organization-db.js');
      expect(resolveMembershipTier({
        membership_tier: null,
        subscription_price_lookup_key: 'aao_membership_professional_250',
        subscription_status: 'active',
        subscription_amount: 5000, // amount says Explorer, but lookup key says Professional
        subscription_interval: 'year',
        is_personal: true,
      })).toBe('individual_professional');
    });

    test('falls back to amount inference when lookup key is null', async () => {
      const { resolveMembershipTier } = await import('../../server/src/db/organization-db.js');
      expect(resolveMembershipTier({
        membership_tier: null,
        subscription_price_lookup_key: null,
        subscription_status: 'active',
        subscription_amount: 25000,
        subscription_interval: 'year',
        is_personal: true,
      })).toBe('individual_professional');
    });

    test('returns null for null/undefined org', async () => {
      const { resolveMembershipTier } = await import('../../server/src/db/organization-db.js');
      expect(resolveMembershipTier(null)).toBeNull();
      expect(resolveMembershipTier(undefined)).toBeNull();
    });
  });

  describe('buildSubscriptionUpdate', () => {
    const makeSubscription = (overrides: any = {}) => ({
      status: 'active',
      id: 'sub_123',
      current_period_end: 1700000000,
      canceled_at: null,
      items: { data: [{ price: {
        unit_amount: 25000,
        currency: 'usd',
        recurring: { interval: 'year' },
        id: 'price_123',
        product: { id: 'prod_123', name: 'Professional Membership' },
        lookup_key: 'aao_membership_professional_250',
      } }] },
      ...overrides,
    });

    test('resolves tier from lookup key', async () => {
      const { buildSubscriptionUpdate } = await import('../../server/src/db/organization-db.js');
      const result = buildSubscriptionUpdate(makeSubscription(), true);
      expect(result.membership_tier).toBe('individual_professional');
      expect(result.subscription_price_lookup_key).toBe('aao_membership_professional_250');
      expect(result.subscription_product_id).toBe('prod_123');
      expect(result.subscription_product_name).toBe('Professional Membership');
      expect(result.subscription_price_id).toBe('price_123');
    });

    test('falls back to amount inference when no lookup key', async () => {
      const { buildSubscriptionUpdate } = await import('../../server/src/db/organization-db.js');
      const sub = makeSubscription();
      sub.items.data[0].price.lookup_key = null;
      const result = buildSubscriptionUpdate(sub, true);
      expect(result.membership_tier).toBe('individual_professional');
      expect(result.subscription_price_lookup_key).toBeNull();
    });

    test('returns null tier for canceled subscription', async () => {
      const { buildSubscriptionUpdate } = await import('../../server/src/db/organization-db.js');
      const result = buildSubscriptionUpdate(makeSubscription({ status: 'canceled' }), true);
      expect(result.membership_tier).toBeNull();
      expect(result.subscription_status).toBe('canceled');
    });

    test('preserves tier for past_due subscription', async () => {
      const { buildSubscriptionUpdate } = await import('../../server/src/db/organization-db.js');
      const result = buildSubscriptionUpdate(makeSubscription({ status: 'past_due' }), true);
      expect(result.membership_tier).toBe('individual_professional');
    });

    test('handles string product ref (unexpanded)', async () => {
      const { buildSubscriptionUpdate } = await import('../../server/src/db/organization-db.js');
      const sub = makeSubscription();
      sub.items.data[0].price.product = 'prod_456';
      const result = buildSubscriptionUpdate(sub, true);
      expect(result.subscription_product_id).toBe('prod_456');
      expect(result.subscription_product_name).toBeNull();
    });
  });

  describe('canAddSeat', () => {
    test('infers tier from subscription when membership_tier is null', async () => {
      const client = mockPool._mockClient;
      // BEGIN
      client.query.mockResolvedValueOnce({ rows: [] });
      // SELECT ... FOR UPDATE: org with null membership_tier but active $2,500/yr subscription
      client.query.mockResolvedValueOnce({
        rows: [{
          membership_tier: null,
          subscription_amount: 250000,
          subscription_interval: 'year',
          subscription_status: 'active',
          is_personal: false,
        }],
      });
      // Member counts (total + contributor via FILTER)
      client.query.mockResolvedValueOnce({ rows: [{ total: '0', contributor: '0' }] });
      // Pending invitations
      client.query.mockResolvedValueOnce({ rows: [] });
      // COMMIT
      client.query.mockResolvedValueOnce({ rows: [] });

      const { canAddSeat } = await import('../../server/src/db/organization-db.js');
      const result = await canAddSeat('org_123', 'contributor');

      expect(result.allowed).toBe(true);
      expect(client.release).toHaveBeenCalled();
    });

    test('denies contributor seats when no subscription and no tier', async () => {
      const client = mockPool._mockClient;
      client.query.mockResolvedValueOnce({ rows: [] }); // BEGIN
      client.query.mockResolvedValueOnce({
        rows: [{
          membership_tier: null,
          subscription_amount: null,
          subscription_interval: null,
          subscription_status: null,
          is_personal: false,
        }],
      });
      client.query.mockResolvedValueOnce({ rows: [{ total: '0', contributor: '0' }] }); // member counts
      client.query.mockResolvedValueOnce({ rows: [] }); // pending invitations
      client.query.mockResolvedValueOnce({ rows: [] }); // COMMIT

      const { canAddSeat } = await import('../../server/src/db/organization-db.js');
      const result = await canAddSeat('org_123', 'contributor');

      expect(result.allowed).toBe(false);
    });

    test('denies contributor seats for canceled subscription even with amount', async () => {
      const client = mockPool._mockClient;
      client.query.mockResolvedValueOnce({ rows: [] }); // BEGIN
      client.query.mockResolvedValueOnce({
        rows: [{
          membership_tier: null,
          subscription_amount: 250000,
          subscription_interval: 'year',
          subscription_status: 'canceled',
          is_personal: false,
        }],
      });
      client.query.mockResolvedValueOnce({ rows: [{ total: '0', contributor: '0' }] }); // member counts
      client.query.mockResolvedValueOnce({ rows: [] }); // pending invitations
      client.query.mockResolvedValueOnce({ rows: [] }); // COMMIT

      const { canAddSeat } = await import('../../server/src/db/organization-db.js');
      const result = await canAddSeat('org_123', 'contributor');

      expect(result.allowed).toBe(false);
    });
  });

  describe('getSubscriptionInfo', () => {
    test('returns status "none" when organization has no stripe_customer_id', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [{
          workos_organization_id: 'org_123',
          stripe_customer_id: null,
          name: 'Test Org',
          agreement_signed_at: null,
          agreement_version: null,
          created_at: new Date(),
          updated_at: new Date(),
        }],
      });

      const { OrganizationDatabase } = await import('../../server/src/db/organization-db.js');
      const orgDb = new OrganizationDatabase();

      const result = await orgDb.getSubscriptionInfo('org_123');

      expect(result).toEqual({ status: 'none' });
      expect(mockGetStripeSubscriptionInfo).not.toHaveBeenCalled();
    });

    test('returns status "none" when organization does not exist', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [],
      });

      const { OrganizationDatabase } = await import('../../server/src/db/organization-db.js');
      const orgDb = new OrganizationDatabase();

      const result = await orgDb.getSubscriptionInfo('org_notfound');

      expect(result).toEqual({ status: 'none' });
      expect(mockGetStripeSubscriptionInfo).not.toHaveBeenCalled();
    });

    test('calls getStripeSubscriptionInfo when stripe_customer_id exists', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [{
          workos_organization_id: 'org_123',
          stripe_customer_id: 'cus_123',
        }],
      });

      mockGetStripeSubscriptionInfo.mockResolvedValueOnce({
        status: 'active',
        product_name: 'Test Product',
        current_period_end: 1234567890,
      });

      const { OrganizationDatabase } = await import('../../server/src/db/organization-db.js');
      const orgDb = new OrganizationDatabase();

      const result = await orgDb.getSubscriptionInfo('org_123');

      expect(mockGetStripeSubscriptionInfo).toHaveBeenCalledWith('cus_123');
      expect(result).toEqual({
        status: 'active',
        product_name: 'Test Product',
        current_period_end: 1234567890,
      });
    });

    test('handles Stripe API errors gracefully by falling back to local DB', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [{
          workos_organization_id: 'org_123',
          stripe_customer_id: 'cus_123',
          subscription_status: null, // No local status
        }],
      });

      mockGetStripeSubscriptionInfo.mockResolvedValueOnce(null);

      const { OrganizationDatabase } = await import('../../server/src/db/organization-db.js');
      const orgDb = new OrganizationDatabase();

      const result = await orgDb.getSubscriptionInfo('org_123');

      // Falls back to 'none' when Stripe fails and no local status
      expect(result).toEqual({ status: 'none' });
    });

    test('uses local DB subscription_status when Stripe fails', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [{
          workos_organization_id: 'org_123',
          stripe_customer_id: 'cus_123',
          subscription_status: 'active',
          subscription_product_name: 'Member',
          subscription_current_period_end: new Date('2025-12-31'),
          subscription_canceled_at: null,
        }],
      });

      mockGetStripeSubscriptionInfo.mockResolvedValueOnce(null);

      const { OrganizationDatabase } = await import('../../server/src/db/organization-db.js');
      const orgDb = new OrganizationDatabase();

      const result = await orgDb.getSubscriptionInfo('org_123');

      // Falls back to local DB fields
      expect(result).toEqual({
        status: 'active',
        product_name: 'Member',
        current_period_end: Math.floor(new Date('2025-12-31').getTime() / 1000),
        cancel_at_period_end: false,
      });
    });
  });
});
