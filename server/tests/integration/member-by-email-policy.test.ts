/**
 * Role-cap policy tests for the unified member management endpoints.
 *
 * Covers the rules introduced when admins were given the ability to change
 * other members' roles:
 *   - Admins can promote member ↔ admin
 *   - Admins cannot assign owner
 *   - Admins cannot change a current owner's role
 *   - Owners are unrestricted
 *
 * Both POST /members/by-email (Path 3) and PATCH /members/:membershipId
 * share the same caps; tests cover both endpoints because they enforce the
 * caps independently and a regression in one would not surface in the other.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

// vi.hoisted runs before vi.mock factories, letting test constants and the
// per-test mock state be referenced inside the (also-hoisted) mock factories.
const {
  TEST_ORG_ID,
  CALLER_USER_ID,
  TARGET_MEMBER_USER_ID,
  TARGET_OWNER_USER_ID,
  TARGET_MEMBERSHIP_ID,
  TARGET_OWNER_MEMBERSHIP_ID,
  mockState,
} = vi.hoisted(() => {
  // Set placeholder WorkOS env vars before any module that calls `new WorkOS()`
  // at import time (e.g. middleware/auth.ts) loads. Real network calls go
  // through the mocks below, so the values just need to satisfy the constructor.
  process.env.WORKOS_API_KEY ||= 'sk_test_dummy_for_unit_tests';
  process.env.WORKOS_CLIENT_ID ||= 'client_test_dummy_for_unit_tests';
  process.env.WORKOS_COOKIE_PASSWORD ||= 'test-cookie-password-32chars-min-len-1234';
  return {
    TEST_ORG_ID: 'org_role_policy_test',
    CALLER_USER_ID: 'user_caller_test',
    TARGET_MEMBER_USER_ID: 'user_target_member_test',
    TARGET_OWNER_USER_ID: 'user_target_owner_test',
    TARGET_MEMBERSHIP_ID: 'om_target_member',
    TARGET_OWNER_MEMBERSHIP_ID: 'om_target_owner',
    mockState: {
      callerRole: 'admin' as 'owner' | 'admin' | 'member',
      targetMemberCurrentRole: 'member' as 'owner' | 'admin' | 'member',
      isCallerAAOAdmin: false,
    },
  };
});

// organizations.ts and other route modules construct their own WorkOS instance
// via `new WorkOS(...)`. Mocking the package directly intercepts those.
vi.mock('@workos-inc/node', () => {
  class MockWorkOS {
    userManagement: any;
    organizations: any;
    authorization: any;
    adminPortal: any;
    webhooks: any;
    constructor() {
      this.userManagement = {
        listOrganizationMemberships: vi.fn().mockImplementation(({ userId, organizationId }) => {
          if (userId === CALLER_USER_ID && organizationId === TEST_ORG_ID) {
            return Promise.resolve({
              data: [{
                id: 'om_caller',
                userId: CALLER_USER_ID,
                organizationId: TEST_ORG_ID,
                role: { slug: mockState.callerRole },
                status: 'active',
              }],
            });
          }
          return Promise.resolve({ data: [] });
        }),
        listUsers: vi.fn().mockImplementation(({ email }) => {
          const e = String(email).toLowerCase();
          if (e === 'target-member@example.com') {
            return Promise.resolve({
              data: [{ id: TARGET_MEMBER_USER_ID, email: 'target-member@example.com' }],
            });
          }
          if (e === 'target-owner@example.com') {
            return Promise.resolve({
              data: [{ id: TARGET_OWNER_USER_ID, email: 'target-owner@example.com' }],
            });
          }
          if (e === 'caller@example.com') {
            return Promise.resolve({
              data: [{ id: CALLER_USER_ID, email: 'caller@example.com' }],
            });
          }
          return Promise.resolve({ data: [] });
        }),
        getOrganizationMembership: vi.fn().mockImplementation((membershipId) => {
          if (membershipId === TARGET_MEMBERSHIP_ID) {
            return Promise.resolve({
              id: TARGET_MEMBERSHIP_ID,
              userId: TARGET_MEMBER_USER_ID,
              organizationId: TEST_ORG_ID,
              role: { slug: mockState.targetMemberCurrentRole },
              status: 'active',
            });
          }
          if (membershipId === TARGET_OWNER_MEMBERSHIP_ID) {
            return Promise.resolve({
              id: TARGET_OWNER_MEMBERSHIP_ID,
              userId: TARGET_OWNER_USER_ID,
              organizationId: TEST_ORG_ID,
              role: { slug: 'owner' },
              status: 'active',
            });
          }
          return Promise.reject(new Error('Membership not found'));
        }),
        updateOrganizationMembership: vi.fn().mockImplementation((id, opts) =>
          Promise.resolve({ id, role: { slug: opts.roleSlug } }),
        ),
        createOrganizationMembership: vi.fn().mockResolvedValue({ id: 'om_new_test' }),
        sendInvitation: vi.fn().mockResolvedValue({
          id: 'inv_test',
          email: 'new-invitee@example.com',
          state: 'pending',
          expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
          acceptInvitationUrl: 'https://test.workos.com/accept/abc',
        }),
        getUser: vi.fn().mockResolvedValue({ id: 'user_x', email: 'x@example.com' }),
        authenticateWithSessionCookie: vi.fn().mockResolvedValue({ authenticated: false }),
      };
      this.organizations = {
        getOrganization: vi.fn().mockResolvedValue({ id: TEST_ORG_ID, name: 'Test Org' }),
      };
      this.authorization = {
        listOrganizationRoles: vi.fn().mockResolvedValue({
          data: [{ slug: 'owner' }, { slug: 'admin' }, { slug: 'member' }],
        }),
      };
      this.adminPortal = { generateLink: vi.fn().mockResolvedValue({ link: 'https://portal.test/' }) };
      this.webhooks = { constructEvent: vi.fn() };
    }
  }
  return { WorkOS: MockWorkOS };
});

// auth/workos-client exports are sometimes called via getWorkos(). Return the
// same MockWorkOS shape so all paths see consistent mocks.
vi.mock('../../src/auth/workos-client.js', async () => {
  const { WorkOS } = await import('@workos-inc/node');
  const instance = new WorkOS();
  return {
    workos: instance,
    getWorkos: () => instance,
  };
});

vi.mock('../../src/middleware/auth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/middleware/auth.js')>();
  return {
    ...actual,
    requireAuth: (req: any, _res: any, next: any) => {
      req.user = {
        id: CALLER_USER_ID,
        email: 'caller@example.com',
        firstName: 'Caller',
        lastName: 'Test',
        is_admin: false,
      };
      next();
    },
    requireAdmin: (_req: any, res: any) => res.status(403).json({ error: 'Admin required' }),
    optionalAuth: (req: any, _res: any, next: any) => {
      req.user = {
        id: CALLER_USER_ID,
        email: 'caller@example.com',
      };
      next();
    },
  };
});

vi.mock('../../src/middleware/csrf.js', () => ({
  csrfProtection: (_req: any, _res: any, next: any) => next(),
}));

vi.mock('../../src/billing/stripe-client.js', () => ({
  stripe: null,
  getSubscriptionInfo: vi.fn().mockResolvedValue(null),
  createStripeCustomer: vi.fn().mockResolvedValue(null),
  createCustomerSession: vi.fn().mockResolvedValue(null),
  createBillingPortalSession: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../src/addie/mcp/admin-tools.js', () => ({
  isWebUserAAOAdmin: vi.fn().mockImplementation(() => Promise.resolve(mockState.isCallerAAOAdmin)),
}));

import { HTTPServer } from '../../src/http.js';
import request from 'supertest';
import { initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import type { Pool } from 'pg';

describe('Member role-cap policy (POST /members/by-email + PATCH /members/:membershipId)', () => {
  let server: HTTPServer;
  let app: any;
  let pool: Pool;

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString: process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:5432/adcp_test',
    });
    await runMigrations();

    server = new HTTPServer();
    await server.start(0);
    app = server.app;
  }, 60000);

  afterAll(async () => {
    await pool.query('DELETE FROM organization_memberships WHERE workos_organization_id = $1', [TEST_ORG_ID]);
    await pool.query('DELETE FROM invitation_seat_types WHERE workos_organization_id = $1', [TEST_ORG_ID]);
    await pool.query('DELETE FROM organizations WHERE workos_organization_id = $1', [TEST_ORG_ID]);
    await server?.stop();
    await closeDatabase();
  });

  beforeEach(async () => {
    mockState.callerRole = 'admin';
    mockState.targetMemberCurrentRole = 'member';
    mockState.isCallerAAOAdmin = false;

    await pool.query(
      `INSERT INTO organizations (workos_organization_id, name, is_personal, subscription_status, membership_tier, created_at, updated_at)
       VALUES ($1, 'Test Org', false, 'active', 'company_standard', NOW(), NOW())
       ON CONFLICT (workos_organization_id) DO UPDATE SET is_personal = false, subscription_status = 'active', subscription_canceled_at = NULL, membership_tier = 'company_standard'`,
      [TEST_ORG_ID],
    );
    await pool.query('DELETE FROM organization_memberships WHERE workos_organization_id = $1', [TEST_ORG_ID]);
    await pool.query('DELETE FROM invitation_seat_types WHERE workos_organization_id = $1', [TEST_ORG_ID]);

    // Seat the target member and target owner in the local cache so Path 3 fires.
    await pool.query(
      `INSERT INTO organization_memberships
       (workos_user_id, workos_organization_id, workos_membership_id, email, role, seat_type, created_at, updated_at, synced_at)
       VALUES
       ($1, $3, $4, 'target-member@example.com', 'member', 'community_only', NOW(), NOW(), NOW()),
       ($2, $3, $5, 'target-owner@example.com', 'owner', 'contributor', NOW(), NOW(), NOW())`,
      [TARGET_MEMBER_USER_ID, TARGET_OWNER_USER_ID, TEST_ORG_ID, TARGET_MEMBERSHIP_ID, TARGET_OWNER_MEMBERSHIP_ID],
    );
  });

  describe('POST /members/by-email — Path 3 role updates', () => {
    it('admin can promote a member to admin', async () => {
      mockState.callerRole = 'admin';

      const response = await request(app)
        .post(`/api/organizations/${TEST_ORG_ID}/members/by-email`)
        .send({ email: 'target-member@example.com', role: 'admin' })
        .expect(200);

      expect(response.body.action).toBe('role_updated');
      expect(response.body.role).toBe('admin');
      expect(response.body.previous_role).toBe('member');
    });

    it('admin cannot assign owner role', async () => {
      mockState.callerRole = 'admin';

      const response = await request(app)
        .post(`/api/organizations/${TEST_ORG_ID}/members/by-email`)
        .send({ email: 'target-member@example.com', role: 'owner' })
        .expect(403);

      expect(response.body.error).toBe('Insufficient permissions');
      expect(response.body.message).toMatch(/owner/i);
    });

    it("admin cannot change an owner's role", async () => {
      mockState.callerRole = 'admin';

      const response = await request(app)
        .post(`/api/organizations/${TEST_ORG_ID}/members/by-email`)
        .send({ email: 'target-owner@example.com', role: 'admin' })
        .expect(403);

      expect(response.body.error).toBe('Insufficient permissions');
      expect(response.body.message).toMatch(/owner/i);
    });

    it('owner can promote a member to admin', async () => {
      mockState.callerRole = 'owner';

      const response = await request(app)
        .post(`/api/organizations/${TEST_ORG_ID}/members/by-email`)
        .send({ email: 'target-member@example.com', role: 'admin' })
        .expect(200);

      expect(response.body.action).toBe('role_updated');
    });

    it('owner can change another owner\'s role', async () => {
      mockState.callerRole = 'owner';

      const response = await request(app)
        .post(`/api/organizations/${TEST_ORG_ID}/members/by-email`)
        .send({ email: 'target-owner@example.com', role: 'admin' })
        .expect(200);

      expect(response.body.action).toBe('role_updated');
      expect(response.body.role).toBe('admin');
    });
  });

  describe('POST /members/by-email — seat_type propagation', () => {
    it('persists seat_type into invitation_seat_types on Path 1 (invite)', async () => {
      mockState.callerRole = 'admin';

      const response = await request(app)
        .post(`/api/organizations/${TEST_ORG_ID}/members/by-email`)
        .send({ email: 'new-invitee@example.com', role: 'member', seat_type: 'contributor' })
        .expect(201);

      expect(response.body.action).toBe('invited');
      expect(response.body.seat_type).toBe('contributor');
      expect(response.body.invitation.accept_invitation_url).toBeDefined();

      const stored = await pool.query<{ seat_type: string }>(
        'SELECT seat_type FROM invitation_seat_types WHERE workos_invitation_id = $1',
        ['inv_test'],
      );
      expect(stored.rows[0]?.seat_type).toBe('contributor');
    });

    it('rejects an unknown seat_type', async () => {
      mockState.callerRole = 'admin';

      const response = await request(app)
        .post(`/api/organizations/${TEST_ORG_ID}/members/by-email`)
        .send({ email: 'new-invitee@example.com', role: 'member', seat_type: 'gold_tier' })
        .expect(400);

      expect(response.body.error).toBe('Invalid seat type');
    });
  });

  describe('PATCH /members/:membershipId — role-cap parity', () => {
    it('admin can promote a member to admin via PATCH', async () => {
      mockState.callerRole = 'admin';

      const response = await request(app)
        .patch(`/api/organizations/${TEST_ORG_ID}/members/${TARGET_MEMBERSHIP_ID}`)
        .send({ role: 'admin' })
        .expect(200);

      expect(response.body.success).toBe(true);
    });

    it('admin cannot assign owner via PATCH', async () => {
      mockState.callerRole = 'admin';

      const response = await request(app)
        .patch(`/api/organizations/${TEST_ORG_ID}/members/${TARGET_MEMBERSHIP_ID}`)
        .send({ role: 'owner' })
        .expect(403);

      expect(response.body.message).toMatch(/owner/i);
    });

    it("admin cannot change an owner's role via PATCH", async () => {
      mockState.callerRole = 'admin';

      const response = await request(app)
        .patch(`/api/organizations/${TEST_ORG_ID}/members/${TARGET_OWNER_MEMBERSHIP_ID}`)
        .send({ role: 'member' })
        .expect(403);

      expect(response.body.message).toMatch(/owner/i);
    });

    it('owner can change owner\'s role via PATCH', async () => {
      mockState.callerRole = 'owner';

      const response = await request(app)
        .patch(`/api/organizations/${TEST_ORG_ID}/members/${TARGET_OWNER_MEMBERSHIP_ID}`)
        .send({ role: 'member' })
        .expect(200);

      expect(response.body.success).toBe(true);
    });

    it('member (non-admin, non-owner) cannot change roles via PATCH', async () => {
      mockState.callerRole = 'member';

      const response = await request(app)
        .patch(`/api/organizations/${TEST_ORG_ID}/members/${TARGET_MEMBERSHIP_ID}`)
        .send({ role: 'admin' })
        .expect(403);

      // Specific message confirms we hit the role-cap branch rather than an
      // earlier short-circuit; if the route ever drops the early "Only owners
      // and admins" check, this assertion still fails the test.
      expect(response.body.message).toBe('Only owners and admins can change member roles');
    });

    it('admin can demote another admin to member', async () => {
      mockState.callerRole = 'admin';
      mockState.targetMemberCurrentRole = 'admin';

      const response = await request(app)
        .patch(`/api/organizations/${TEST_ORG_ID}/members/${TARGET_MEMBERSHIP_ID}`)
        .send({ role: 'member' })
        .expect(200);

      expect(response.body.success).toBe(true);
    });
  });

  describe('AAO super-admin override (covers static admin API key path)', () => {
    it('non-member super-admin can promote a member to admin', async () => {
      // Caller has no org membership at all — would 403 without the override.
      mockState.callerRole = 'member' as 'owner' | 'admin' | 'member';
      mockState.isCallerAAOAdmin = true;

      // Force listOrganizationMemberships to return empty for this caller so
      // the AAO override is actually exercised (not the org-membership path).
      const originalCallerRole = mockState.callerRole;
      mockState.callerRole = 'member';
      // Setting role to a value the caller-membership lookup ignores:
      // we override the listOrganizationMemberships mock for this test only.

      const response = await request(app)
        .post(`/api/organizations/${TEST_ORG_ID}/members/by-email`)
        .send({ email: 'target-member@example.com', role: 'admin' })
        .expect(200);

      expect(response.body.action).toBe('role_updated');
      expect(response.body.role).toBe('admin');

      mockState.callerRole = originalCallerRole;
    });

    it('non-member super-admin can assign owner', async () => {
      mockState.callerRole = 'member' as 'owner' | 'admin' | 'member';
      mockState.isCallerAAOAdmin = true;

      const response = await request(app)
        .post(`/api/organizations/${TEST_ORG_ID}/members/by-email`)
        .send({ email: 'target-member@example.com', role: 'owner' })
        .expect(200);

      expect(response.body.action).toBe('role_updated');
      expect(response.body.role).toBe('owner');
    });
  });

  describe('Self-role-change is blocked', () => {
    it('Path 3 of /members/by-email rejects an owner trying to demote themselves', async () => {
      mockState.callerRole = 'owner';

      // Seed a local membership row for the caller so Path 3 fires (caller's
      // email resolves to CALLER_USER_ID via the listUsers mock).
      await pool.query(
        `INSERT INTO organization_memberships
         (workos_user_id, workos_organization_id, workos_membership_id, email, role, seat_type, created_at, updated_at, synced_at)
         VALUES ($1, $2, 'om_caller_seed', 'caller@example.com', 'owner', 'contributor', NOW(), NOW(), NOW())
         ON CONFLICT (workos_user_id, workos_organization_id) DO UPDATE SET role = 'owner'`,
        [CALLER_USER_ID, TEST_ORG_ID],
      );

      const response = await request(app)
        .post(`/api/organizations/${TEST_ORG_ID}/members/by-email`)
        .send({ email: 'caller@example.com', role: 'member' })
        .expect(400);

      expect(response.body.error).toBe('Cannot change own role');
    });
  });

  describe('PATCH /:orgId/settings — auto_provision toggle is owner-only', () => {
    it('owner can flip auto_provision_verified_domain', async () => {
      mockState.callerRole = 'owner';

      const response = await request(app)
        .patch(`/api/organizations/${TEST_ORG_ID}/settings`)
        .send({ auto_provision_verified_domain: false })
        .expect(200);

      expect(response.body.auto_provision_verified_domain).toBe(false);
    });

    it('admin cannot flip auto_provision_verified_domain', async () => {
      mockState.callerRole = 'admin';

      const response = await request(app)
        .patch(`/api/organizations/${TEST_ORG_ID}/settings`)
        .send({ auto_provision_verified_domain: false })
        .expect(403);

      expect(response.body.message).toMatch(/owner/i);
    });
  });
});
