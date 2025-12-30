import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { HTTPServer } from '../../src/http.js';
import request from 'supertest';
import { getPool, initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import type { Pool } from 'pg';

/**
 * User Context API Tests
 *
 * Tests for the admin user context endpoint that shows member context
 * as Addie sees it (for debugging user issues and impersonation).
 */

// Mock auth middleware to bypass authentication in tests
vi.mock('../../src/middleware/auth.js', () => ({
  requireAuth: (req: any, res: any, next: any) => {
    req.user = {
      id: 'user_test_admin',
      email: 'admin@test.com',
      is_admin: true,
    };
    next();
  },
  requireAdmin: (req: any, res: any, next: any) => next(),
  optionalAuth: (req: any, res: any, next: any) => next(),
}));

// Mock WorkOS client to avoid external API calls
vi.mock('../../src/auth/workos-client.js', () => ({
  workos: {
    userManagement: {
      getUser: vi.fn().mockImplementation((userId: string) => {
        if (userId === 'user_test_workos') {
          return Promise.resolve({
            id: 'user_test_workos',
            email: 'test@example.com',
            firstName: 'Test',
            lastName: 'User',
            emailVerified: true,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          });
        }
        if (userId === 'user_nonexistent') {
          return Promise.reject(new Error('User not found'));
        }
        return Promise.resolve({
          id: userId,
          email: `${userId}@example.com`,
          firstName: 'Unknown',
          lastName: 'User',
          emailVerified: true,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
      }),
      listOrganizationMemberships: vi.fn().mockImplementation(({ userId, organizationId }: any) => {
        if (userId === 'user_test_workos') {
          return Promise.resolve({
            data: [
              {
                organizationId: 'org_test_context',
                role: { slug: 'admin' },
                createdAt: new Date().toISOString(),
              },
            ],
          });
        }
        if (organizationId === 'org_test_context') {
          return Promise.resolve({
            data: [
              { organizationId: 'org_test_context', userId: 'user_test_workos' },
              { organizationId: 'org_test_context', userId: 'user_test_2' },
            ],
          });
        }
        return Promise.resolve({ data: [] });
      }),
    },
  },
}));

// Mock Stripe client
vi.mock('../../src/billing/stripe-client.js', () => ({
  stripe: null,
  getSubscriptionInfo: vi.fn().mockResolvedValue({
    status: 'active',
    product_name: 'Annual Membership',
    current_period_end: Math.floor(Date.now() / 1000) + 86400 * 30,
    cancel_at_period_end: false,
  }),
}));

describe('User Context API Tests', () => {
  let server: HTTPServer;
  let app: any;
  let pool: Pool;
  const TEST_ORG_ID = 'org_test_context';
  const TEST_WORKOS_USER_ID = 'user_test_workos';
  const TEST_SLACK_USER_ID = 'U_test_context';

  beforeAll(async () => {
    // Initialize test database
    pool = initializeDatabase({
      connectionString: process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:53198/adcp_test',
    });

    // Run migrations
    await runMigrations();

    // Create test organization
    await pool.query(
      `INSERT INTO organizations (workos_organization_id, name, subscription_status, created_at, updated_at)
       VALUES ($1, $2, $3, NOW(), NOW())
       ON CONFLICT (workos_organization_id) DO UPDATE SET name = $2, subscription_status = $3`,
      [TEST_ORG_ID, 'Test Context Org', 'active']
    );

    // Create test Slack user mapping
    await pool.query(
      `INSERT INTO slack_user_mappings (
        slack_user_id, slack_email, slack_display_name, slack_real_name,
        slack_is_bot, slack_is_deleted, mapping_status, workos_user_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (slack_user_id) DO UPDATE SET workos_user_id = $8`,
      [TEST_SLACK_USER_ID, 'test@example.com', 'Test User', 'Test User', false, false, 'mapped', TEST_WORKOS_USER_ID]
    );

    // Create test member profile
    await pool.query(
      `INSERT INTO member_profiles (workos_organization_id, display_name, slug, tagline, offerings, headquarters, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
       ON CONFLICT (workos_organization_id) DO NOTHING`,
      [TEST_ORG_ID, 'Test Org Display', 'test-org', 'A test organization', ['DSP', 'SSP'], 'New York']
    );

    // Initialize HTTP server
    server = new HTTPServer();
    await server.start(0); // Use port 0 for random port
    app = server.app;
  });

  afterAll(async () => {
    // Clean up test data
    await pool.query('DELETE FROM member_profiles WHERE workos_organization_id = $1', [TEST_ORG_ID]);
    await pool.query('DELETE FROM slack_user_mappings WHERE slack_user_id = $1', [TEST_SLACK_USER_ID]);
    await pool.query('DELETE FROM organizations WHERE workos_organization_id = $1', [TEST_ORG_ID]);

    await server?.stop();
    await closeDatabase();
  });

  describe('GET /api/admin/users/:userId/context', () => {
    it('should return context for a WorkOS user ID', async () => {
      const response = await request(app)
        .get(`/api/admin/users/${TEST_WORKOS_USER_ID}/context?type=workos`)
        .expect(200);

      expect(response.body).toHaveProperty('is_mapped');
      expect(response.body).toHaveProperty('is_member');
      expect(response.body).toHaveProperty('slack_linked');
      expect(response.body.workos_user).toBeDefined();
      expect(response.body.workos_user.workos_user_id).toBe(TEST_WORKOS_USER_ID);
      expect(response.body.workos_user.email).toBe('test@example.com');
    });

    it('should return context for a Slack user ID', async () => {
      const response = await request(app)
        .get(`/api/admin/users/${TEST_SLACK_USER_ID}/context?type=slack`)
        .expect(200);

      expect(response.body).toHaveProperty('is_mapped');
      expect(response.body).toHaveProperty('slack_linked');
      expect(response.body.slack_user).toBeDefined();
      expect(response.body.slack_user.slack_user_id).toBe(TEST_SLACK_USER_ID);
    });

    it('should auto-detect WorkOS user ID format (starts with user_)', async () => {
      const response = await request(app)
        .get(`/api/admin/users/${TEST_WORKOS_USER_ID}/context`)
        .expect(200);

      expect(response.body.workos_user).toBeDefined();
      expect(response.body.workos_user.workos_user_id).toBe(TEST_WORKOS_USER_ID);
    });

    it('should auto-detect Slack user ID format (starts with U)', async () => {
      const response = await request(app)
        .get(`/api/admin/users/${TEST_SLACK_USER_ID}/context`)
        .expect(200);

      expect(response.body.slack_user).toBeDefined();
      expect(response.body.slack_user.slack_user_id).toBe(TEST_SLACK_USER_ID);
    });

    it('should return 404 for non-existent user', async () => {
      const response = await request(app)
        .get('/api/admin/users/user_nonexistent/context?type=workos')
        .expect(404);

      expect(response.body.error).toBe('User not found');
    });

    it('should include organization info when user has org membership', async () => {
      const response = await request(app)
        .get(`/api/admin/users/${TEST_WORKOS_USER_ID}/context?type=workos`)
        .expect(200);

      expect(response.body.organization).toBeDefined();
      expect(response.body.organization.workos_organization_id).toBe(TEST_ORG_ID);
      expect(response.body.organization.name).toBe('Test Context Org');
    });

    it('should include member profile when available', async () => {
      const response = await request(app)
        .get(`/api/admin/users/${TEST_WORKOS_USER_ID}/context?type=workos`)
        .expect(200);

      expect(response.body.member_profile).toBeDefined();
      expect(response.body.member_profile.display_name).toBe('Test Org Display');
      expect(response.body.member_profile.tagline).toBe('A test organization');
      expect(response.body.member_profile.offerings).toContain('DSP');
    });

    it('should include org membership details', async () => {
      const response = await request(app)
        .get(`/api/admin/users/${TEST_WORKOS_USER_ID}/context?type=workos`)
        .expect(200);

      expect(response.body.org_membership).toBeDefined();
      expect(response.body.org_membership.role).toBe('admin');
      expect(response.body.org_membership.member_count).toBeGreaterThanOrEqual(1);
    });

    it('should indicate slack_linked status correctly', async () => {
      const response = await request(app)
        .get(`/api/admin/users/${TEST_WORKOS_USER_ID}/context?type=workos`)
        .expect(200);

      expect(response.body.slack_linked).toBe(true);
      expect(response.body.slack_user).toBeDefined();
      expect(response.body.slack_user.slack_user_id).toBe(TEST_SLACK_USER_ID);
    });
  });

  describe('Context data completeness', () => {
    it('should return all expected context fields for a fully mapped user', async () => {
      const response = await request(app)
        .get(`/api/admin/users/${TEST_WORKOS_USER_ID}/context?type=workos`)
        .expect(200);

      // Required fields
      expect(response.body).toHaveProperty('is_mapped');
      expect(response.body).toHaveProperty('is_member');
      expect(response.body).toHaveProperty('slack_linked');

      // User info
      expect(response.body.workos_user).toHaveProperty('workos_user_id');
      expect(response.body.workos_user).toHaveProperty('email');
      expect(response.body.workos_user).toHaveProperty('first_name');
      expect(response.body.workos_user).toHaveProperty('last_name');
    });
  });
});
