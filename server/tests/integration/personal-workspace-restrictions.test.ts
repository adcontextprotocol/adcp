import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';

const TEST_USER_ID = 'user_personal_test';
const TEST_PERSONAL_ORG_ID = 'org_personal_test';
const TEST_TEAM_ORG_ID = 'org_team_test';

// Mock WorkOS client BEFORE any imports that use it
vi.mock('../../src/auth/workos-client.js', () => ({
  workos: {
    userManagement: {
      listOrganizationMemberships: vi.fn().mockImplementation(({ userId, organizationId }) => {
        if (organizationId === TEST_PERSONAL_ORG_ID || organizationId === TEST_TEAM_ORG_ID) {
          return Promise.resolve({
            data: [{
              id: 'om_test',
              userId: TEST_USER_ID,
              organizationId: organizationId,
              role: { slug: 'owner' },
              status: 'active'
            }]
          });
        }
        return Promise.resolve({ data: [] });
      }),
      sendInvitation: vi.fn().mockResolvedValue({ id: 'inv_test' }),
    },
    organizations: {
      getOrganization: vi.fn().mockImplementation((orgId) => {
        return Promise.resolve({
          id: orgId,
          name: orgId === TEST_PERSONAL_ORG_ID ? 'Personal Workspace' : 'Team Workspace',
        });
      }),
    },
    portal: {
      generateLink: vi.fn().mockResolvedValue({ link: 'https://test-portal.workos.com' }),
    },
  },
}));

import { HTTPServer } from '../../src/http.js';
import request from 'supertest';
import { getPool, initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import type { Pool } from 'pg';

// Mock auth middleware to bypass authentication in tests
vi.mock('../../src/middleware/auth.js', () => ({
  requireAuth: (req: any, res: any, next: any) => {
    req.user = {
      id: TEST_USER_ID,
      email: 'owner@test.com',
      firstName: 'Test',
      lastName: 'User',
      is_admin: false
    };
    next();
  },
  requireAdmin: (req: any, res: any, next: any) => {
    return res.status(403).json({ error: 'Admin required' });
  },
}));

// Mock Stripe client
vi.mock('../../src/billing/stripe-client.js', () => ({
  stripe: null,
  getSubscriptionInfo: vi.fn().mockResolvedValue(null),
  createStripeCustomer: vi.fn().mockResolvedValue(null),
  createCustomerSession: vi.fn().mockResolvedValue(null),
  createBillingPortalSession: vi.fn().mockResolvedValue(null),
}));

describe('Personal Workspace Restrictions', () => {
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
    await pool.query('DELETE FROM organizations WHERE workos_organization_id LIKE $1', ['org_personal%']);
    await pool.query('DELETE FROM organizations WHERE workos_organization_id LIKE $1', ['org_team%']);

    await server?.stop();
    await closeDatabase();
  });

  beforeEach(async () => {
    // Create fresh test organizations before each test
    await pool.query(
      `INSERT INTO organizations (workos_organization_id, name, is_personal, created_at, updated_at)
       VALUES ($1, $2, true, NOW(), NOW())
       ON CONFLICT (workos_organization_id) DO UPDATE SET name = $2, is_personal = true`,
      [TEST_PERSONAL_ORG_ID, 'Personal Workspace']
    );

    await pool.query(
      `INSERT INTO organizations (workos_organization_id, name, is_personal, created_at, updated_at)
       VALUES ($1, $2, false, NOW(), NOW())
       ON CONFLICT (workos_organization_id) DO UPDATE SET name = $2, is_personal = false`,
      [TEST_TEAM_ORG_ID, 'Team Workspace']
    );
  });

  afterEach(async () => {
    // Clean up test data
    await pool.query('DELETE FROM organizations WHERE workos_organization_id LIKE $1', ['org_personal%']);
    await pool.query('DELETE FROM organizations WHERE workos_organization_id LIKE $1', ['org_team%']);
  });

  describe('POST /api/organizations/:orgId/invitations', () => {
    it('should reject invitations to personal workspaces', async () => {
      const response = await request(app)
        .post(`/api/organizations/${TEST_PERSONAL_ORG_ID}/invitations`)
        .send({ email: 'test@example.com', role: 'member' })
        .expect(400);

      expect(response.body.error).toBe('Personal workspace');
      expect(response.body.message).toContain('Personal workspaces cannot have team members');
    });

    it('should allow invitations to team workspaces', async () => {
      const response = await request(app)
        .post(`/api/organizations/${TEST_TEAM_ORG_ID}/invitations`)
        .send({ email: 'test@example.com', role: 'member' })
        .expect(200);

      expect(response.body.invitation).toBeDefined();
    });
  });

  describe('POST /api/organizations/:orgId/domain-verification-link', () => {
    it('should reject domain verification for personal workspaces', async () => {
      const response = await request(app)
        .post(`/api/organizations/${TEST_PERSONAL_ORG_ID}/domain-verification-link`)
        .send()
        .expect(400);

      expect(response.body.error).toBe('Personal workspace');
      expect(response.body.message).toContain('Personal workspaces cannot claim corporate domains');
    });

    it('should allow domain verification for team workspaces', async () => {
      const response = await request(app)
        .post(`/api/organizations/${TEST_TEAM_ORG_ID}/domain-verification-link`)
        .send()
        .expect(200);

      expect(response.body.link).toBeDefined();
    });
  });

  describe('is_personal flag behavior', () => {
    it('should return is_personal in organization data', async () => {
      // Query the database directly to verify is_personal is stored
      const personalResult = await pool.query(
        'SELECT is_personal FROM organizations WHERE workos_organization_id = $1',
        [TEST_PERSONAL_ORG_ID]
      );
      expect(personalResult.rows[0].is_personal).toBe(true);

      const teamResult = await pool.query(
        'SELECT is_personal FROM organizations WHERE workos_organization_id = $1',
        [TEST_TEAM_ORG_ID]
      );
      expect(teamResult.rows[0].is_personal).toBe(false);
    });
  });
});
