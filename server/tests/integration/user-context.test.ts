import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { HTTPServer } from '../../src/http.js';
import request from 'supertest';
import { getPool, initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import type { Pool } from 'pg';
import { getWorkos } from '../../src/auth/workos-client.js';

/**
 * User Context API Tests
 *
 * Tests for the admin user context endpoint that shows member context
 * as Addie sees it (for debugging user issues and impersonation).
 */

// Mock auth middleware to bypass authentication in tests
vi.mock('../../src/middleware/auth.js', async (importOriginal) => {
  const mockedRequireAuth = (req: any, _res: any, next: any) => {
    const testUserId = typeof req.headers['x-test-user-id'] === 'string'
      ? req.headers['x-test-user-id']
      : 'user_test_admin';
    req.user = {
      id: testUserId,
      email: 'admin@test.com',
      is_admin: true,
    };
    next();
  };
  const passThrough = (_req: any, _res: any, next: any) => next();
  return {
    ...(await importOriginal<typeof import('../../src/middleware/auth.js')>()),
    requireAuth: mockedRequireAuth,
    requireAdmin: passThrough,
    optionalAuth: passThrough,
    // `requireGlobalAdmin` is an exported array of middleware refs
    // captured at module-load time; the per-export mocks above don't
    // propagate into it. Re-build the array so admin/users routes
    // (`...requireGlobalAdmin`) reach the mocked handlers.
    requireGlobalAdmin: [mockedRequireAuth, passThrough, passThrough],
  };
});

vi.mock('../../src/middleware/csrf.js', () => ({
  csrfProtection: (_req: any, _res: any, next: any) => next(),
}));

// Mock WorkOS client to avoid external API calls.
// workos-client.ts exports getWorkos() (a function), not a `workos` singleton —
// so we export both: `workos` for any direct property access and `getWorkos` for
// the call sites in member-context.ts (getWorkos().userManagement.*).
vi.mock('../../src/auth/workos-client.js', () => {
  const mockUserManagement = {
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
        const err: any = new Error('User not found');
        err.status = 404;
        return Promise.reject(err);
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
    // getWebMemberContext calls this twice: once with { userId } for the user's own
    // memberships, and once with { organizationId } for the org's full member list.
    listOrganizationMemberships: vi.fn().mockImplementation(({ userId, organizationId }: any) => {
      if (userId === 'user_test_workos') {
        const memberships = [
          {
            organizationId: 'org_test_context_other',
            userId: 'user_test_workos',
            role: { slug: 'owner' },
            status: 'active',
            createdAt: new Date(Date.now() - 86400 * 1000).toISOString(),
          },
          {
            organizationId: 'org_test_context',
            userId: 'user_test_workos',
            role: { slug: 'admin' },
            status: 'active',
            createdAt: new Date().toISOString(),
          },
        ];
        return Promise.resolve({
          data: organizationId ? memberships.filter((m) => m.organizationId === organizationId) : memberships,
        });
      }
      if (userId === 'user_test_single_context') {
        const memberships = [
          {
            organizationId: 'org_test_context',
            userId: 'user_test_single_context',
            role: { slug: 'member' },
            status: 'active',
            createdAt: new Date().toISOString(),
          },
        ];
        return Promise.resolve({
          data: organizationId ? memberships.filter((m) => m.organizationId === organizationId) : memberships,
        });
      }
      if (organizationId === 'org_test_context') {
        return Promise.resolve({
          data: [
            { organizationId: 'org_test_context', userId: 'user_test_workos', status: 'active', role: { slug: 'admin' } },
            { organizationId: 'org_test_context', userId: 'user_test_single_context', status: 'active', role: { slug: 'member' } },
            { organizationId: 'org_test_context', userId: 'user_test_2', status: 'active', role: { slug: 'member' } },
          ],
        });
      }
      return Promise.resolve({ data: [] });
    }),
  };
  const mockInstance = { userManagement: mockUserManagement };
  return {
    workos: mockInstance,
    getWorkos: () => mockInstance,
  };
});

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
  const TEST_OTHER_ORG_ID = 'org_test_context_other';
  const TEST_WORKOS_USER_ID = 'user_test_workos';
  const TEST_SINGLE_ORG_WORKOS_USER_ID = 'user_test_single_context';
  const TEST_STALE_WORKOS_USER_ID = 'user_test_stale_context';
  const TEST_SLACK_USER_ID = 'U_test_context';

  beforeAll(async () => {
    // Initialize test database
    pool = initializeDatabase({
      connectionString: process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:53198/adcp_test',
    });

    // Run migrations
    await runMigrations();

    // Create test organizations
    await pool.query(
      `INSERT INTO organizations (workos_organization_id, name, subscription_status, created_at, updated_at)
       VALUES ($1, $2, $3, NOW(), NOW())
       ON CONFLICT (workos_organization_id) DO UPDATE SET name = $2, subscription_status = $3`,
      [TEST_ORG_ID, 'Test Context Org', 'active']
    );
    await pool.query(
      `INSERT INTO organizations (workos_organization_id, name, subscription_status, created_at, updated_at)
       VALUES ($1, $2, $3, NOW(), NOW())
       ON CONFLICT (workos_organization_id) DO UPDATE SET name = $2, subscription_status = $3`,
      [TEST_OTHER_ORG_ID, 'Other Context Org', null]
    );

    await pool.query(
      `INSERT INTO users (workos_user_id, email, primary_organization_id, created_at, updated_at)
       VALUES ($1, $2, $3, NOW(), NOW())
       ON CONFLICT (workos_user_id) DO UPDATE
         SET email = EXCLUDED.email,
             primary_organization_id = EXCLUDED.primary_organization_id,
             updated_at = NOW()`,
      [TEST_WORKOS_USER_ID, 'test@example.com', TEST_ORG_ID]
    );
    await pool.query(
      `INSERT INTO users (workos_user_id, email, primary_organization_id, created_at, updated_at)
       VALUES ($1, $2, $3, NOW(), NOW())
       ON CONFLICT (workos_user_id) DO UPDATE
         SET email = EXCLUDED.email,
             primary_organization_id = EXCLUDED.primary_organization_id,
             updated_at = NOW()`,
      [TEST_SINGLE_ORG_WORKOS_USER_ID, 'single@example.com', TEST_ORG_ID]
    );
    await pool.query(
      `INSERT INTO users (workos_user_id, email, primary_organization_id, created_at, updated_at)
       VALUES ($1, $2, $3, NOW(), NOW())
       ON CONFLICT (workos_user_id) DO UPDATE
         SET email = EXCLUDED.email,
             primary_organization_id = EXCLUDED.primary_organization_id,
             updated_at = NOW()`,
      [TEST_STALE_WORKOS_USER_ID, 'stale@example.com', TEST_ORG_ID]
    );

    await pool.query(
      `INSERT INTO organization_memberships (
         workos_user_id, workos_organization_id, workos_membership_id, email,
         role, seat_type, synced_at, created_at, updated_at
       ) VALUES
         ($1, $2, $4, $5, 'admin', 'community_only', NOW(), NOW(), NOW()),
         ($1, $3, $6, $5, 'owner', 'community_only', NOW(), NOW(), NOW()),
         ($7, $2, $8, $9, 'member', 'community_only', NOW(), NOW(), NOW()),
         ($10, $2, $11, $12, 'admin', 'community_only', NOW(), NOW(), NOW())
       ON CONFLICT (workos_user_id, workos_organization_id)
       DO UPDATE SET role = EXCLUDED.role, updated_at = NOW()`,
      [
        TEST_WORKOS_USER_ID,
        TEST_ORG_ID,
        TEST_OTHER_ORG_ID,
        `om_${TEST_WORKOS_USER_ID}_${TEST_ORG_ID}`,
        'test@example.com',
        `om_${TEST_WORKOS_USER_ID}_${TEST_OTHER_ORG_ID}`,
        TEST_SINGLE_ORG_WORKOS_USER_ID,
        `om_${TEST_SINGLE_ORG_WORKOS_USER_ID}_${TEST_ORG_ID}`,
        'single@example.com',
        TEST_STALE_WORKOS_USER_ID,
        `om_${TEST_STALE_WORKOS_USER_ID}_${TEST_ORG_ID}`,
        'stale@example.com',
      ]
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

    await pool.query(
      `DELETE FROM person_relationships
       WHERE slack_user_id = $1 OR workos_user_id = $2 OR email = $3`,
      [TEST_SLACK_USER_ID, TEST_WORKOS_USER_ID, 'test@example.com']
    );

    await pool.query(
      `INSERT INTO person_relationships (
        slack_user_id, workos_user_id, email, display_name, stage,
        interaction_count, sentiment_trend, unreplied_outreach_count
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [TEST_SLACK_USER_ID, TEST_WORKOS_USER_ID, 'test@example.com', 'Test User', 'participating', 3, 'neutral', 0]
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
    await pool.query('DELETE FROM member_profiles WHERE workos_organization_id = ANY($1)', [[TEST_ORG_ID, TEST_OTHER_ORG_ID]]);
    await pool.query('DELETE FROM person_relationships WHERE slack_user_id = $1 OR workos_user_id = $2', [TEST_SLACK_USER_ID, TEST_WORKOS_USER_ID]);
    await pool.query('DELETE FROM slack_user_mappings WHERE slack_user_id = $1', [TEST_SLACK_USER_ID]);
    await pool.query('DELETE FROM organization_memberships WHERE workos_user_id = ANY($1)', [[TEST_WORKOS_USER_ID, TEST_SINGLE_ORG_WORKOS_USER_ID, TEST_STALE_WORKOS_USER_ID]]);
    await pool.query('DELETE FROM users WHERE workos_user_id = ANY($1)', [[TEST_WORKOS_USER_ID, TEST_SINGLE_ORG_WORKOS_USER_ID, TEST_STALE_WORKOS_USER_ID]]);
    await pool.query('DELETE FROM organizations WHERE workos_organization_id = ANY($1)', [[TEST_ORG_ID, TEST_OTHER_ORG_ID]]);

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
        .get(`/api/admin/users/${TEST_SLACK_USER_ID}/context?type=slack&org=${TEST_ORG_ID}`)
        .expect(200);

      expect(response.body).toHaveProperty('is_mapped');
      expect(response.body).toHaveProperty('slack_linked');
      expect(response.body.slack_user).toBeDefined();
      expect(response.body.slack_user.slack_user_id).toBe(TEST_SLACK_USER_ID);
      expect(response.body.organization.workos_organization_id).toBe(TEST_ORG_ID);
      expect(response.body.org_membership.role).toBe('admin');
    });

    it('should not hydrate org context when local primary org lacks active WorkOS membership', async () => {
      const response = await request(app)
        .get(`/api/admin/users/${TEST_STALE_WORKOS_USER_ID}/context?type=workos&org=${TEST_ORG_ID}`)
        .expect(200);

      expect(response.body.workos_user.workos_user_id).toBe(TEST_STALE_WORKOS_USER_ID);
      expect(response.body.organization).toBeUndefined();
      expect(response.body.org_membership).toBeUndefined();
    });

    it('should not default org context for multi-org users without explicit selection', async () => {
      const response = await request(app)
        .get(`/api/admin/users/${TEST_WORKOS_USER_ID}/context?type=workos`)
        .expect(200);

      expect(response.body.workos_user.workos_user_id).toBe(TEST_WORKOS_USER_ID);
      expect(response.body.organization).toBeUndefined();
      expect(response.body.org_membership).toBeUndefined();
    });

    it('should default org context for a user with exactly one active WorkOS organization', async () => {
      const response = await request(app)
        .get(`/api/admin/users/${TEST_SINGLE_ORG_WORKOS_USER_ID}/context?type=workos`)
        .expect(200);

      expect(response.body.workos_user.workos_user_id).toBe(TEST_SINGLE_ORG_WORKOS_USER_ID);
      expect(response.body.organization.workos_organization_id).toBe(TEST_ORG_ID);
      expect(response.body.org_membership.role).toBe('member');
    });

    it('should preserve member engagement when relationship engagement is present', async () => {
      const response = await request(app)
        .get(`/api/admin/users/${TEST_SLACK_USER_ID}/context?type=slack&org=${TEST_ORG_ID}`)
        .expect(200);

      expect(response.body.engagement).toMatchObject({
        login_count_30d: expect.any(Number),
        working_group_count: expect.any(Number),
        email_click_count_30d: expect.any(Number),
      });

      expect(response.body.relationship_engagement).toMatchObject({
        opportunities: expect.any(Array),
        contact_eligibility: expect.objectContaining({
          can_contact: expect.any(Boolean),
        }),
        relationship_stage: 'participating',
        unreplied_count: expect.any(Number),
      });
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
      expect(response.body.organization).toBeUndefined();
      expect(response.body.org_membership).toBeUndefined();
    });

    it('should return 404 for non-existent user', async () => {
      const response = await request(app)
        .get('/api/admin/users/user_nonexistent/context?type=workos')
        .expect(404);

      expect(response.body.error).toBe('User not found');
    });

    it('should include organization info when user has org membership', async () => {
      const response = await request(app)
        .get(`/api/admin/users/${TEST_WORKOS_USER_ID}/context?type=workos&org=${TEST_ORG_ID}`)
        .expect(200);

      expect(response.body.organization).toBeDefined();
      expect(response.body.organization.workos_organization_id).toBe(TEST_ORG_ID);
      expect(response.body.organization.name).toBe('Test Context Org');
    });

    it('should include member profile when available', async () => {
      const response = await request(app)
        .get(`/api/admin/users/${TEST_WORKOS_USER_ID}/context?type=workos&org=${TEST_ORG_ID}`)
        .expect(200);

      expect(response.body.member_profile).toBeDefined();
      expect(response.body.member_profile.display_name).toBe('Test Org Display');
      expect(response.body.member_profile.tagline).toBe('A test organization');
      expect(response.body.member_profile.offerings).toContain('DSP');
    });

    it('should include org membership details', async () => {
      const response = await request(app)
        .get(`/api/admin/users/${TEST_WORKOS_USER_ID}/context?type=workos&org=${TEST_ORG_ID}`)
        .expect(200);

      expect(response.body.org_membership).toBeDefined();
      expect(response.body.org_membership.role).toBe('admin');
      expect(response.body.org_membership.member_count).toBeGreaterThanOrEqual(1);
    });

    it('should indicate slack_linked status correctly', async () => {
      const response = await request(app)
        .get(`/api/admin/users/${TEST_WORKOS_USER_ID}/context?type=workos&org=${TEST_ORG_ID}`)
        .expect(200);

      expect(response.body.slack_linked).toBe(true);
      expect(response.body.slack_user).toBeDefined();
      expect(response.body.slack_user.slack_user_id).toBe(TEST_SLACK_USER_ID);
    });
  });

  describe('GET /api/me/addie-home', () => {
    it('hydrates the explicitly selected organization from the org query', async () => {
      const listMemberships = (getWorkos() as any).userManagement.listOrganizationMemberships as ReturnType<typeof vi.fn>;
      listMemberships.mockClear();

      const response = await request(app)
        .get(`/api/me/addie-home?org=${TEST_ORG_ID}`)
        .set('x-test-user-id', TEST_WORKOS_USER_ID)
        .expect(200);

      expect(response.body.greeting.orgName).toBe('Test Context Org');
      expect(response.body.greeting.isMember).toBe(true);
      expect(listMemberships).toHaveBeenCalledWith(expect.objectContaining({
        userId: TEST_WORKOS_USER_ID,
        organizationId: TEST_ORG_ID,
      }));
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
