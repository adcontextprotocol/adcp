import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { HTTPServer } from '../../src/http.js';
import request from 'supertest';
import { getPool, initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import type { Pool } from 'pg';

const TEST_USER_ID = 'user_self_delete_test';
const TEST_ORG_ID = 'org_self_delete_test';

// Mock auth middleware to bypass authentication in tests
// This simulates a logged-in user who is the owner
vi.mock('../../src/middleware/auth.js', () => ({
  requireAuth: (req: any, res: any, next: any) => {
    req.user = {
      id: TEST_USER_ID,
      email: 'owner@test.com',
      is_admin: false
    };
    next();
  },
  requireAdmin: (req: any, res: any, next: any) => {
    return res.status(403).json({ error: 'Admin required' });
  },
}));

// Mock Stripe client to control subscription checks
vi.mock('../../src/billing/stripe-client.js', () => ({
  stripe: null,
  getSubscriptionInfo: vi.fn().mockResolvedValue(null),
  createStripeCustomer: vi.fn().mockResolvedValue(null),
  createCustomerSession: vi.fn().mockResolvedValue(null),
  createBillingPortalSession: vi.fn().mockResolvedValue(null),
}));

// Mock WorkOS client to return membership with owner role
vi.mock('@workos-inc/node', () => ({
  WorkOS: vi.fn().mockImplementation(() => ({
    userManagement: {
      listOrganizationMemberships: vi.fn().mockImplementation(({ userId, organizationId }) => {
        if (organizationId === TEST_ORG_ID) {
          return Promise.resolve({
            data: [{
              id: 'om_test',
              userId: TEST_USER_ID,
              organizationId: TEST_ORG_ID,
              role: { slug: 'owner' },
              status: 'active'
            }]
          });
        }
        // Non-owner org
        if (organizationId === 'org_member_only') {
          return Promise.resolve({
            data: [{
              id: 'om_member',
              userId: TEST_USER_ID,
              organizationId: 'org_member_only',
              role: { slug: 'member' },
              status: 'active'
            }]
          });
        }
        return Promise.resolve({ data: [] });
      }),
    },
    organizations: {
      deleteOrganization: vi.fn().mockResolvedValue({}),
      listOrganizations: vi.fn().mockResolvedValue({ data: [] }),
    },
  })),
}));

describe('Self-Service Delete Workspace', () => {
  let server: HTTPServer;
  let app: any;
  let pool: Pool;

  beforeAll(async () => {
    // Initialize test database
    pool = initializeDatabase({
      connectionString: process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:53198/adcp_test',
    });

    // Run migrations
    await runMigrations();

    // Initialize HTTP server
    server = new HTTPServer();
    await server.start(0);
    app = server.app;
  });

  afterAll(async () => {
    // Clean up any remaining test data
    await pool.query('DELETE FROM revenue_events WHERE workos_organization_id LIKE $1', ['org_self_delete%']);
    await pool.query('DELETE FROM member_profiles WHERE workos_organization_id LIKE $1', ['org_self_delete%']);
    await pool.query('DELETE FROM organizations WHERE workos_organization_id LIKE $1', ['org_self_delete%']);
    await pool.query('DELETE FROM organizations WHERE workos_organization_id = $1', ['org_member_only']);

    await server?.stop();
    await closeDatabase();
  });

  beforeEach(async () => {
    // Create fresh test organization before each test
    await pool.query(
      `INSERT INTO organizations (workos_organization_id, name, created_at, updated_at)
       VALUES ($1, $2, NOW(), NOW())
       ON CONFLICT (workos_organization_id) DO UPDATE SET name = $2`,
      [TEST_ORG_ID, 'Self Delete Test Org']
    );
  });

  afterEach(async () => {
    // Clean up test data
    await pool.query('DELETE FROM revenue_events WHERE workos_organization_id LIKE $1', ['org_self_delete%']);
    await pool.query('DELETE FROM member_profiles WHERE workos_organization_id LIKE $1', ['org_self_delete%']);
    await pool.query('DELETE FROM organizations WHERE workos_organization_id LIKE $1', ['org_self_delete%']);
    await pool.query('DELETE FROM organizations WHERE workos_organization_id = $1', ['org_member_only']);
  });

  describe('DELETE /api/organizations/:orgId', () => {
    it('should return 404 for non-existent organization', async () => {
      const response = await request(app)
        .delete('/api/organizations/org_nonexistent')
        .send({ confirmation: 'Some Name' })
        .expect(404);

      expect(response.body.error).toBe('Organization not found');
    });

    it('should require confirmation to delete', async () => {
      const response = await request(app)
        .delete(`/api/organizations/${TEST_ORG_ID}`)
        .send({})
        .expect(400);

      expect(response.body.error).toBe('Confirmation required');
      expect(response.body.requires_confirmation).toBe(true);
      expect(response.body.organization_name).toBe('Self Delete Test Org');
    });

    it('should reject wrong confirmation name', async () => {
      const response = await request(app)
        .delete(`/api/organizations/${TEST_ORG_ID}`)
        .send({ confirmation: 'Wrong Name' })
        .expect(400);

      expect(response.body.error).toBe('Confirmation required');
    });

    it('should prevent deletion of organization with payment history', async () => {
      // Create org with payment history
      const PAID_ORG_ID = 'org_self_delete_paid';
      await pool.query(
        `INSERT INTO organizations (workos_organization_id, name, stripe_customer_id, created_at, updated_at)
         VALUES ($1, $2, $3, NOW(), NOW())
         ON CONFLICT (workos_organization_id) DO UPDATE SET name = $2, stripe_customer_id = $3`,
        [PAID_ORG_ID, 'Paid Org', 'cus_paid']
      );

      // Add a revenue event
      await pool.query(
        `INSERT INTO revenue_events (workos_organization_id, revenue_type, amount_paid, currency, paid_at)
         VALUES ($1, $2, $3, $4, NOW())`,
        [PAID_ORG_ID, 'subscription_initial', 2999, 'usd']
      );

      // Mock WorkOS to return owner for this org too
      const { WorkOS } = await import('@workos-inc/node');
      const mockWorkOS = new WorkOS('test');
      vi.mocked(mockWorkOS.userManagement.listOrganizationMemberships).mockImplementation(({ organizationId }) => {
        if (organizationId === PAID_ORG_ID) {
          return Promise.resolve({
            data: [{
              id: 'om_paid',
              userId: TEST_USER_ID,
              organizationId: PAID_ORG_ID,
              role: { slug: 'owner' },
              status: 'active'
            }]
          });
        }
        return Promise.resolve({ data: [] });
      });

      const response = await request(app)
        .delete(`/api/organizations/${PAID_ORG_ID}`)
        .send({ confirmation: 'Paid Org' })
        .expect(400);

      expect(response.body.error).toBe('Cannot delete paid workspace');
      expect(response.body.has_payments).toBe(true);

      // Verify org still exists
      const checkResult = await pool.query(
        'SELECT 1 FROM organizations WHERE workos_organization_id = $1',
        [PAID_ORG_ID]
      );
      expect(checkResult.rows.length).toBe(1);
    });

    it('should successfully delete unpaid organization with correct confirmation', async () => {
      const response = await request(app)
        .delete(`/api/organizations/${TEST_ORG_ID}`)
        .send({ confirmation: 'Self Delete Test Org' })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.deleted_org_id).toBe(TEST_ORG_ID);

      // Verify org is deleted
      const checkResult = await pool.query(
        'SELECT 1 FROM organizations WHERE workos_organization_id = $1',
        [TEST_ORG_ID]
      );
      expect(checkResult.rows.length).toBe(0);
    });

    it('should cascade delete related member profiles', async () => {
      // Create a member profile for the test org
      await pool.query(
        `INSERT INTO member_profiles (workos_organization_id, display_name, slug, created_at, updated_at)
         VALUES ($1, $2, $3, NOW(), NOW())
         ON CONFLICT DO NOTHING`,
        [TEST_ORG_ID, 'Test Profile', 'test-profile-self-delete']
      );

      // Verify profile exists
      const beforeResult = await pool.query(
        'SELECT 1 FROM member_profiles WHERE workos_organization_id = $1',
        [TEST_ORG_ID]
      );
      expect(beforeResult.rows.length).toBe(1);

      // Delete the organization
      await request(app)
        .delete(`/api/organizations/${TEST_ORG_ID}`)
        .send({ confirmation: 'Self Delete Test Org' })
        .expect(200);

      // Verify profile is cascade deleted
      const afterResult = await pool.query(
        'SELECT 1 FROM member_profiles WHERE workos_organization_id = $1',
        [TEST_ORG_ID]
      );
      expect(afterResult.rows.length).toBe(0);
    });

    it('should reject non-owner attempting to delete', async () => {
      // Create org where user is only a member
      const MEMBER_ORG_ID = 'org_member_only';
      await pool.query(
        `INSERT INTO organizations (workos_organization_id, name, created_at, updated_at)
         VALUES ($1, $2, NOW(), NOW())
         ON CONFLICT (workos_organization_id) DO UPDATE SET name = $2`,
        [MEMBER_ORG_ID, 'Member Only Org']
      );

      const response = await request(app)
        .delete(`/api/organizations/${MEMBER_ORG_ID}`)
        .send({ confirmation: 'Member Only Org' })
        .expect(403);

      expect(response.body.error).toBe('Insufficient permissions');
    });

    it('should prevent deletion of organization with active subscription', async () => {
      // Create org with stripe customer
      const SUB_ORG_ID = 'org_self_delete_sub';
      await pool.query(
        `INSERT INTO organizations (workos_organization_id, name, stripe_customer_id, created_at, updated_at)
         VALUES ($1, $2, $3, NOW(), NOW())
         ON CONFLICT (workos_organization_id) DO UPDATE SET name = $2, stripe_customer_id = $3`,
        [SUB_ORG_ID, 'Subscribed Org', 'cus_sub_test']
      );

      // Mock WorkOS to return owner for this org
      const { WorkOS } = await import('@workos-inc/node');
      const mockWorkOS = new WorkOS('test');
      vi.mocked(mockWorkOS.userManagement.listOrganizationMemberships).mockImplementation(({ organizationId }) => {
        if (organizationId === SUB_ORG_ID) {
          return Promise.resolve({
            data: [{
              id: 'om_sub',
              userId: TEST_USER_ID,
              organizationId: SUB_ORG_ID,
              role: { slug: 'owner' },
              status: 'active'
            }]
          });
        }
        return Promise.resolve({ data: [] });
      });

      // Mock getSubscriptionInfo to return active subscription
      const { getSubscriptionInfo } = await import('../../src/billing/stripe-client.js');
      vi.mocked(getSubscriptionInfo).mockResolvedValueOnce({
        status: 'active',
        product_id: 'prod_test',
        product_name: 'Test Product',
        current_period_end: Math.floor(Date.now() / 1000) + 86400,
        cancel_at_period_end: false,
      });

      const response = await request(app)
        .delete(`/api/organizations/${SUB_ORG_ID}`)
        .send({ confirmation: 'Subscribed Org' })
        .expect(400);

      expect(response.body.error).toBe('Cannot delete workspace with active subscription');
      expect(response.body.has_active_subscription).toBe(true);
      expect(response.body.subscription_status).toBe('active');

      // Verify org still exists
      const checkResult = await pool.query(
        'SELECT 1 FROM organizations WHERE workos_organization_id = $1',
        [SUB_ORG_ID]
      );
      expect(checkResult.rows.length).toBe(1);
    });
  });
});
