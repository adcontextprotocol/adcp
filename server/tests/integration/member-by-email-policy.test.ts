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
  sendInvitationMock,
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
      targetOwnerCurrentRole: 'owner' as 'owner' | 'admin' | 'member',
      targetMemberCurrentRole: 'member' as 'owner' | 'admin' | 'member',
      isCallerAAOAdmin: false,
      isStaticAdminApiKey: false,
    },
    // Shared mock so multiple `new WorkOS()` instances expose the same fn
    // and tests can inspect call args.
    sendInvitationMock: vi.fn().mockResolvedValue({
      id: 'inv_test',
      organizationId: 'org_role_policy_test',
      email: 'new-invitee@example.com',
      state: 'pending',
      expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      acceptInvitationUrl: 'https://test.workos.com/accept/abc',
    }),
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
          const targets = [
            {id: TARGET_MEMBERSHIP_ID, userId: TARGET_MEMBER_USER_ID, organizationId: TEST_ORG_ID, status: 'active', role: {slug: mockState.targetMemberCurrentRole}},
            {id: TARGET_OWNER_MEMBERSHIP_ID, userId: TARGET_OWNER_USER_ID, organizationId: TEST_ORG_ID, status: 'active', role: {slug: mockState.targetOwnerCurrentRole}},
            {id: 'om_caller', userId: CALLER_USER_ID, organizationId: TEST_ORG_ID, status: 'active', role: {slug: mockState.callerRole}},
          ];
          return Promise.resolve({data: targets.filter(row => !userId || row.userId === userId)});
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
              role: { slug: mockState.targetOwnerCurrentRole },
              status: 'active',
            });
          }
          if (membershipId === 'om_caller') return Promise.resolve({id: 'om_caller', userId: CALLER_USER_ID, organizationId: TEST_ORG_ID, status: 'active', role: {slug: mockState.callerRole}});
          return Promise.reject(new Error('Membership not found'));
        }),
        updateOrganizationMembership: vi.fn().mockImplementation((id, opts) => {
          if (id === TARGET_OWNER_MEMBERSHIP_ID) mockState.targetOwnerCurrentRole = opts.roleSlug;
          else mockState.targetMemberCurrentRole = opts.roleSlug;
          return Promise.resolve({id, userId: id === TARGET_OWNER_MEMBERSHIP_ID ? TARGET_OWNER_USER_ID : TARGET_MEMBER_USER_ID, organizationId: TEST_ORG_ID, status: 'active', role: {slug: opts.roleSlug}});
        }),
        createOrganizationMembership: vi.fn().mockResolvedValue({ id: 'om_new_test' }),
        sendInvitation: sendInvitationMock,
        getInvitation: vi.fn().mockImplementation(async () => sendInvitationMock.getMockImplementation()!()),
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
    getAuthorizationEnforcementWorkos: () => instance,
  };
});

vi.mock('../../src/middleware/auth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/middleware/auth.js')>();
  return {
    ...actual,
    requireAuth: async (req: any, _res: any, next: any) => {
      if (mockState.isStaticAdminApiKey) {
        req.user = {
          id: 'admin_api_key',
          email: 'admin-api-key@internal',
          firstName: 'Admin',
          lastName: 'API Key',
          is_admin: true,
        };
        req.isStaticAdminApiKey = true;
      } else {
        req.user = {
          id: CALLER_USER_ID,
          email: 'caller@example.com',
          firstName: 'Caller',
          lastName: 'Test',
          is_admin: false,
        };
      }
      if (!mockState.isStaticAdminApiKey) {
        await getPool().query('INSERT INTO users (workos_user_id,email) VALUES ($1,$2) ON CONFLICT DO NOTHING', [CALLER_USER_ID,'caller@example.com']);
        await getPool().query(`INSERT INTO organization_memberships (workos_user_id,workos_organization_id,workos_membership_id,email,role)
          VALUES ($1,$2,'om_caller','caller@example.com',$3) ON CONFLICT (workos_user_id,workos_organization_id) DO UPDATE SET role=$3`, [CALLER_USER_ID,TEST_ORG_ID,mockState.callerRole]);
        await getPool().query('UPDATE organization_memberships SET role=$1 WHERE workos_user_id=$2 AND workos_organization_id=$3', [mockState.targetMemberCurrentRole,TARGET_MEMBER_USER_ID,TEST_ORG_ID]);
        if (mockState.isCallerAAOAdmin) {
          const group = await getPool().query("SELECT id FROM working_groups WHERE slug='aao-admin'");
          await getPool().query("INSERT INTO working_group_memberships (working_group_id,workos_user_id,status) VALUES ($1,$2,'active') ON CONFLICT (working_group_id,workos_user_id) DO UPDATE SET status='active'",[group.rows[0].id,CALLER_USER_ID]);
        }
        req.accessToken = CALLER_USER_ID;
        await stampOrganizationTestUser(req.user, TEST_ORG_ID);
      }
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

vi.mock('../../src/addie/admin-status-lookup.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/addie/admin-status-lookup.js')>();
  const checkMembership = vi.fn().mockImplementation(() => Promise.resolve(mockState.isCallerAAOAdmin));
  const resolve = async (principal: any, email?: string | null) => {
    const id = typeof principal === 'string' ? principal : principal.authWorkosUserId ?? principal.id;
    return actual.decideAAOAdminAccess(await checkMembership(id), typeof principal === 'string' ? email : principal.email);
  };
  return {
    ...actual,
    isWebUserAAOAdmin: checkMembership,
    resolveWebUserAAOAdminAccess: resolve,
    isAuthenticatedUserAAOAdmin: async (principal: any) => (await resolve(principal)).isAdmin,
  };
});

import { HTTPServer } from '../../src/http.js';
import request from 'supertest';
import { initializeDatabase, closeDatabase, getPool } from '../../src/db/client.js';
import { stampOrganizationTestUser } from '../helpers/organization-auth-fixture.js';
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
    mockState.targetOwnerCurrentRole = 'owner';
    await pool.query('DELETE FROM working_group_memberships WHERE workos_user_id=$1',[CALLER_USER_ID]);
    mockState.isCallerAAOAdmin = false;
    mockState.isStaticAdminApiKey = false;
    sendInvitationMock.mockClear();

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

      expect(response.body.error).toBe('access_denied');
    });

    it("admin cannot change an owner's role", async () => {
      mockState.callerRole = 'admin';

      const response = await request(app)
        .post(`/api/organizations/${TEST_ORG_ID}/members/by-email`)
        .send({ email: 'target-owner@example.com', role: 'admin' })
        .expect(403);

      expect(response.body.error).toBe('access_denied');
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

      expect(response.body.error).toBe('invalid_request');
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

      expect(response.body.error).toBe('access_denied');
    });

    it("admin cannot change an owner's role via PATCH", async () => {
      mockState.callerRole = 'admin';

      const response = await request(app)
        .patch(`/api/organizations/${TEST_ORG_ID}/members/${TARGET_OWNER_MEMBERSHIP_ID}`)
        .send({ role: 'member' })
        .expect(403);

      expect(response.body.error).toBe('access_denied');
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

      expect(response.body.error).toBe('access_denied');
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

  describe('POST /members/by-email — Path 1 inviter attribution', () => {
    it('passes the caller as inviterUserId for a normal authenticated admin', async () => {
      mockState.callerRole = 'admin';

      await request(app)
        .post(`/api/organizations/${TEST_ORG_ID}/members/by-email`)
        .send({ email: 'new-invitee@example.com', role: 'member', seat_type: 'community_only' })
        .expect(201);

      expect(sendInvitationMock).toHaveBeenCalledTimes(1);
      const args = sendInvitationMock.mock.calls[0][0];
      expect(args.inviterUserId).toBe(CALLER_USER_ID);
      expect(args.email).toBe('new-invitee@example.com');
      expect(args.organizationId).toBe(TEST_ORG_ID);
      expect(args.roleSlug).toBe('member');
    });

    it('denies static ADMIN_API_KEY without sending an invitation', async () => {
      mockState.isStaticAdminApiKey = true;
      await request(app).post(`/api/organizations/${TEST_ORG_ID}/members/by-email`)
        .send({ email: 'new-invitee@example.com', role: 'member' }).expect(403);
      expect(sendInvitationMock).not.toHaveBeenCalled();
    });
  });

  describe('Platform admin does not elevate organization authority', () => {
    for (const role of ['admin', 'owner']) it(`direct member platform admin cannot assign ${role}`, async () => {
      mockState.callerRole = 'member';
      mockState.isCallerAAOAdmin = true;
      await request(app).post(`/api/organizations/${TEST_ORG_ID}/members/by-email`)
        .send({ email: 'target-member@example.com', role }).expect(403);
      expect(mockState.targetMemberCurrentRole).toBe('member');
      expect(sendInvitationMock).not.toHaveBeenCalled();
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
         VALUES ($1, $2, 'om_caller', 'caller@example.com', 'owner', 'contributor', NOW(), NOW(), NOW())
         ON CONFLICT (workos_user_id, workos_organization_id) DO UPDATE SET role = 'owner'`,
        [CALLER_USER_ID, TEST_ORG_ID],
      );

      const response = await request(app)
        .post(`/api/organizations/${TEST_ORG_ID}/members/by-email`)
        .send({ email: 'caller@example.com', role: 'member' })
        .expect(400);

      expect(response.body.error).toBe('invalid_request');
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

      expect(response.body.error).toBe('Insufficient permissions');
    });
  });
});

vi.mock('../../src/auth/workos-jwt.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/auth/workos-jwt.js')>()),
  verifyWorkOSJWT: async (value: string) => ({ sub: value, isM2M: false }),
}));
vi.mock('../../src/services/organization-membership-notifications.js', () => ({ notifyMembershipSeats: vi.fn(), notifyMembershipSeatRequest: vi.fn() }));
