import { describe, test, expect, jest, beforeEach } from '@jest/globals';

// Mock the database client
jest.mock('../../server/src/db/client.js', () => ({
  getPool: jest.fn(),
}));

// Mock the Stripe client
jest.mock('../../server/src/billing/stripe-client.js', () => ({
  getStripeSubscriptionInfo: jest.fn(),
}));

describe('organization-db', () => {
  let mockPool: any;
  let mockGetStripeSubscriptionInfo: any;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();

    // Setup mock pool
    mockPool = {
      query: jest.fn(),
    };

    // Setup mocks
    const { getPool } = require('../../server/src/db/client.js');
    mockGetStripeSubscriptionInfo = require('../../server/src/billing/stripe-client.js').getStripeSubscriptionInfo;
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
        ['org_123', 'Test Org', false, null, null, null]
      );
      expect(result).toMatchObject({
        workos_organization_id: 'org_123',
        name: 'Test Org',
      });
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
