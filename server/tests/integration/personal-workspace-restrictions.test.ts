import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';

// vi.hoisted ensures constants and mock fns are available inside vi.mock factories.
// Env vars must be set here so AUTH_ENABLED resolves true before organizations.ts loads
// and calls new WorkOS() — without them workos is null and every workos!. call throws.
const {
  TEST_USER_ID,
  TEST_PERSONAL_ORG_ID,
  TEST_TEAM_ORG_ID,
  listOrganizationMemberships,
  sendInvitation,
  generateAdminPortalLink,
} = vi.hoisted(() => {
  process.env.WORKOS_API_KEY ||= 'sk_test_dummy_for_unit_tests';
  process.env.WORKOS_CLIENT_ID ||= 'client_test_dummy_for_unit_tests';
  process.env.WORKOS_COOKIE_PASSWORD ||= 'test-cookie-password-32chars-min-len-1234';
  return {
    TEST_USER_ID: 'user_personal_test',
    TEST_PERSONAL_ORG_ID: 'org_personal_test',
    TEST_TEAM_ORG_ID: 'org_team_test',
    listOrganizationMemberships: vi.fn(),
    sendInvitation: vi.fn(),
    generateAdminPortalLink: vi.fn().mockResolvedValue({ link: 'https://test-portal.workos.com' }),
  };
});

// organizations.ts calls new WorkOS() directly; mocking @workos-inc/node intercepts that
// constructor so every new WorkOS() returns the same shared mock methods.
vi.mock('@workos-inc/node', () => ({
  WorkOS: class {
    userManagement = {
      listOrganizationMemberships,
      sendInvitation,
      getInvitation: async () => sendInvitation.mock.results.at(-1)?.value,
    };
    organizations = {
      getOrganization: vi.fn().mockImplementation((orgId: string) => Promise.resolve({
        id: orgId,
        name: orgId === TEST_PERSONAL_ORG_ID ? 'Personal Workspace' : 'Team Workspace',
      })),
    };
    adminPortal = {
      generateLink: generateAdminPortalLink,
    };
  },
}));

// The mutation boundary uses the enforcement wrapper; both clients expose the
// same provider fixture. Real cookie/JWT authentication is covered separately.
vi.mock('../../src/auth/workos-client.js', async () => {
  const { WorkOS } = await import('@workos-inc/node');
  const instance = new WorkOS();
  return { workos: instance, getWorkos: () => instance, getAuthorizationEnforcementWorkos: () => instance };
});

vi.mock('../../src/auth/workos-jwt.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/auth/workos-jwt.js')>()),
  verifyWorkOSJWT: async (value: string) => ({ sub: value, isM2M: false }),
}));

import { HTTPServer } from '../../src/http.js';
import request from 'supertest';
import { getPool, initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { stampOrganizationTestUser } from '../helpers/organization-auth-fixture.js';
import { runMigrations } from '../../src/db/migrate.js';
import type { Pool } from 'pg';

// Mock auth middleware to bypass authentication in tests
vi.mock('../../src/middleware/auth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/middleware/auth.js')>()),
  requireAuth: async (req: any, _res: any, next: any) => {
    req.user = {
      id: TEST_USER_ID,
      email: 'owner@test.com',
      firstName: 'Test',
      lastName: 'User',
      is_admin: false
    };
    req.accessToken = TEST_USER_ID;
    await stampOrganizationTestUser(req.user);
    next();
  },
  requireAdmin: (_req: any, res: any) => {
    return res.status(403).json({ error: 'Admin required' });
  },
}));

vi.mock('../../src/middleware/csrf.js', () => ({
  csrfProtection: (_req: any, _res: any, next: any) => next(),
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
    generateAdminPortalLink.mockClear();
    sendInvitation.mockReset().mockImplementation(async ({ email, organizationId }) => ({
      id: 'inv_personal_policy_test', email, organizationId, state: 'pending',
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    }));
    await pool.query('DELETE FROM registry_audit_log WHERE workos_organization_id = ANY($1)', [[TEST_PERSONAL_ORG_ID, TEST_TEAM_ORG_ID]]);
    await pool.query('DELETE FROM organization_memberships WHERE workos_organization_id = ANY($1)', [[TEST_PERSONAL_ORG_ID, TEST_TEAM_ORG_ID]]);
    // Reset per-test: handler calls workos!.userManagement.listOrganizationMemberships via the new
    // WorkOS() instance; return owner membership for test user in known org IDs.
    // Note: the invitation test (team org) relies on community_only seat limit = 1 from DEFAULT_SEAT_LIMITS.
    listOrganizationMemberships.mockReset().mockImplementation(({ organizationId }: { organizationId: string }) => {
      if (organizationId === TEST_PERSONAL_ORG_ID || organizationId === TEST_TEAM_ORG_ID) {
        return Promise.resolve({
          data: [{ id: `om_${organizationId}`, userId: TEST_USER_ID, organizationId, role: { slug: 'owner' }, status: 'active' }],
        });
      }
      return Promise.resolve({ data: [] });
    });

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

    await pool.query('INSERT INTO users (workos_user_id, email) VALUES ($1, $2) ON CONFLICT DO NOTHING', [TEST_USER_ID, 'owner@test.com']);
    // Exact owner authority must exist locally and at WorkOS. A contributor
    // owner leaves the existing one-community-seat invitation allowance free.
    for (const orgId of [TEST_PERSONAL_ORG_ID, TEST_TEAM_ORG_ID]) {
      await pool.query(`INSERT INTO organization_memberships
        (workos_user_id, workos_organization_id, workos_membership_id, email, role, seat_type)
        VALUES ($1, $2, $3, 'owner@test.com', 'owner', 'contributor')`, [TEST_USER_ID, orgId, `om_${orgId}`]);
    }
  });

  afterEach(async () => {
    // Clean up test data; invitation_seat_types has no FK to organizations so must be deleted explicitly.
    await pool.query('DELETE FROM organization_memberships WHERE workos_organization_id = ANY($1)', [[TEST_PERSONAL_ORG_ID, TEST_TEAM_ORG_ID]]);
    await pool.query('DELETE FROM invitation_seat_types WHERE workos_organization_id LIKE $1', ['org_team%']);
    await pool.query('DELETE FROM organizations WHERE workos_organization_id LIKE $1', ['org_personal%']);
    await pool.query('DELETE FROM organizations WHERE workos_organization_id LIKE $1', ['org_team%']);
  });

  describe('POST /api/organizations/:orgId/invitations', () => {
    it('should reject invitations to personal workspaces', async () => {
      const response = await request(app)
        .post(`/api/organizations/${TEST_PERSONAL_ORG_ID}/invitations`)
        .send({ email: 'test@example.com', role: 'member' })
        .expect(400);

      expect(response.body.error).toContain('Personal workspaces cannot have team members');
      expect(sendInvitation).not.toHaveBeenCalled();
      expect((await pool.query('SELECT 1 FROM registry_audit_log WHERE workos_organization_id = $1', [TEST_PERSONAL_ORG_ID])).rowCount).toBe(0);
    });

    it('should allow invitations to team workspaces', async () => {
      const response = await request(app)
        .post(`/api/organizations/${TEST_TEAM_ORG_ID}/invitations`)
        .send({ email: 'test@example.com', role: 'member' })
        .expect(200);

      expect(response.body.invitation).toBeDefined();
      expect(sendInvitation).toHaveBeenCalledWith(expect.objectContaining({ inviterUserId: TEST_USER_ID, organizationId: TEST_TEAM_ORG_ID }));
      const audit = await pool.query('SELECT workos_user_id FROM registry_audit_log WHERE workos_organization_id = $1', [TEST_TEAM_ORG_ID]);
      expect(audit.rows).toEqual([{ workos_user_id: TEST_USER_ID }]);
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

    it('should allow an organization admin to open domain verification', async () => {
      listOrganizationMemberships.mockImplementationOnce(({ organizationId }: { organizationId: string }) => Promise.resolve({
        data: [{
          id: 'om_admin',
          userId: TEST_USER_ID,
          organizationId,
          role: { slug: 'admin' },
          status: 'active',
        }],
      }));

      const response = await request(app)
        .post(`/api/organizations/${TEST_TEAM_ORG_ID}/domain-verification-link`)
        .send()
        .expect(200);

      expect(response.body.link).toBeDefined();
      expect(generateAdminPortalLink).toHaveBeenCalledWith({
        organization: TEST_TEAM_ORG_ID,
        intent: 'domain_verification',
      });
    });

    it('should reject a regular member without generating an admin portal link', async () => {
      listOrganizationMemberships.mockImplementationOnce(({ organizationId }: { organizationId: string }) => Promise.resolve({
        data: [{
          id: 'om_member',
          userId: TEST_USER_ID,
          organizationId,
          role: { slug: 'member' },
          status: 'active',
        }],
      }));

      const response = await request(app)
        .post(`/api/organizations/${TEST_TEAM_ORG_ID}/domain-verification-link`)
        .send()
        .expect(403);

      expect(response.body.error).toBe('Insufficient permissions');
      expect(generateAdminPortalLink).not.toHaveBeenCalled();
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
