import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';

// vi.hoisted ensures all of these are available inside vi.mock factories.
// Env vars must be set here so AUTH_ENABLED resolves true before organizations.ts loads
// and calls new WorkOS() — without them workos is null and every workos!. call throws.
const {
  TEST_ADMIN_USER_ID,
  TEST_REQUESTER_USER_ID,
  TEST_ORG_ID,
  mockCreateOrganizationMembership,
  mockSendInvitation,
  listOrganizationMemberships,
} = vi.hoisted(() => {
  process.env.WORKOS_API_KEY ||= 'sk_test_dummy_for_unit_tests';
  process.env.WORKOS_CLIENT_ID ||= 'client_test_dummy_for_unit_tests';
  process.env.WORKOS_COOKIE_PASSWORD ||= 'test-cookie-password-32chars-min-len-1234';
  return {
    TEST_ADMIN_USER_ID: 'user_join_req_admin',
    TEST_REQUESTER_USER_ID: 'user_join_req_requester',
    TEST_ORG_ID: 'org_join_req_test',
    mockCreateOrganizationMembership: vi.fn(),
    mockSendInvitation: vi.fn(),
    listOrganizationMemberships: vi.fn(),
  };
});

// organizations.ts calls new WorkOS() directly; mocking @workos-inc/node intercepts that
// constructor so every new WorkOS() returns the same shared mock methods.
vi.mock('@workos-inc/node', () => ({
  WorkOS: class {
    userManagement = {
      listOrganizationMemberships,
      createOrganizationMembership: mockCreateOrganizationMembership,
      getOrganizationMembership: async () => ({ id: 'om_test_new',userId: TEST_REQUESTER_USER_ID,organizationId: TEST_ORG_ID,status:'active',role:{slug:'member'} }),
      deleteOrganizationMembership: vi.fn(),
      sendInvitation: mockSendInvitation,
      getUser: vi.fn().mockResolvedValue({ id: TEST_ADMIN_USER_ID, email: 'admin@example.com' }),
    };
    organizations = {
      getOrganization: vi.fn().mockResolvedValue({ id: TEST_ORG_ID, name: 'Test Org' }),
    };
    adminPortal = {
      generateLink: vi.fn().mockResolvedValue({ link: 'https://test-portal.workos.com' }),
    };
  },
}));

vi.mock('../../src/auth/workos-client.js', async () => {
  const { WorkOS } = await import('@workos-inc/node');
  return { getAuthorizationEnforcementWorkos: () => new WorkOS(), getWorkos: () => new WorkOS() };
});

import { HTTPServer } from '../../src/http.js';
import request from 'supertest';
import { getPool, initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { stampOrganizationTestUser } from '../helpers/organization-auth-fixture.js';
import { runMigrations } from '../../src/db/migrate.js';
import type { Pool } from 'pg';

vi.mock('../../src/middleware/auth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/middleware/auth.js')>()),
  requireAuth: async (req: any, _res: any, next: any) => {
    req.user = {
      id: TEST_ADMIN_USER_ID,
      email: 'admin@example.com',
      firstName: 'Admin',
      lastName: 'User',
      is_admin: false,
    };
    if (req.originalUrl.startsWith('/api/organizations/')) {
      await getPool().query('INSERT INTO users (workos_user_id,email) VALUES ($1,$2) ON CONFLICT DO NOTHING',[TEST_ADMIN_USER_ID,'admin@example.com']);
      await getPool().query(`INSERT INTO organization_memberships (workos_user_id,workos_organization_id,workos_membership_id,email,role)
        VALUES ($1,$2,'om_admin','admin@example.com','admin') ON CONFLICT (workos_user_id,workos_organization_id) DO NOTHING`,[TEST_ADMIN_USER_ID,TEST_ORG_ID]);
      req.accessToken = TEST_ADMIN_USER_ID;
      await stampOrganizationTestUser(req.user, TEST_ORG_ID);
    }
    next();
  },
  requireAdmin: (_req: any, res: any) => {
    return res.status(403).json({ error: 'Admin required' });
  },
}));

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

vi.mock('../../src/slack/org-group-dm.js', () => ({
  notifyJoinRequest: vi.fn().mockResolvedValue(undefined),
  notifyMemberAdded: vi.fn().mockResolvedValue(undefined),
}));

describe('Join Request Approval', () => {
  let server: HTTPServer;
  let app: any;
  let pool: Pool;
  let joinRequestId: string;

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString: process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:53198/adcp_test',
    });
    await runMigrations();
    server = new HTTPServer();
    await server.start(0);
    app = server.app;
  });

  afterAll(async () => {
    await pool.query('DELETE FROM organization_join_requests WHERE workos_organization_id = $1', [TEST_ORG_ID]);
    await pool.query('DELETE FROM organizations WHERE workos_organization_id = $1', [TEST_ORG_ID]);
    await server?.stop();
    await closeDatabase();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    listOrganizationMemberships.mockReset();
    mockCreateOrganizationMembership.mockReset();
    mockCreateOrganizationMembership.mockResolvedValue({ id: 'om_test_new',userId:TEST_REQUESTER_USER_ID,organizationId:TEST_ORG_ID,status:'active',role:{slug:'member'} });
    // Re-establish after clearAllMocks: handler calls workos!.userManagement.listOrganizationMemberships
    // via the new WorkOS() instance; the mock must return admin membership for test user.
    listOrganizationMemberships.mockImplementation(({ userId, organizationId }: { userId: string; organizationId: string }) => {
      if (userId === TEST_ADMIN_USER_ID && organizationId === TEST_ORG_ID) {
        return Promise.resolve({
          data: [{ id: 'om_admin', userId: TEST_ADMIN_USER_ID, organizationId: TEST_ORG_ID, role: { slug: 'admin' }, status: 'active' }],
        });
      }
      return Promise.resolve({ data: [] });
    });

    await pool.query(
      `INSERT INTO organizations (workos_organization_id, name, is_personal, subscription_status, membership_tier, created_at, updated_at)
       VALUES ($1, $2, false, 'active', 'company_standard', NOW(), NOW())
       ON CONFLICT (workos_organization_id) DO UPDATE SET name = $2, is_personal = false`,
      [TEST_ORG_ID, 'Test Org']
    );

    const result = await pool.query(
      `INSERT INTO organization_join_requests (workos_user_id, user_email, first_name, last_name, workos_organization_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [TEST_REQUESTER_USER_ID, 'requester@example.com', 'Sam', 'Sousa', TEST_ORG_ID]
    );
    joinRequestId = result.rows[0].id;
  });

  afterEach(async () => {
    await pool.query('DELETE FROM organization_memberships WHERE workos_organization_id=$1',[TEST_ORG_ID]);
    await pool.query('DELETE FROM organization_join_requests WHERE workos_organization_id = $1', [TEST_ORG_ID]);
  });

  it('denies inline join onboarding even with a pending provider invitation', async () => {
    listOrganizationMemberships.mockResolvedValueOnce({
      data: [{
        id: 'om_pending',
        userId: TEST_ADMIN_USER_ID,
        organizationId: TEST_ORG_ID,
        role: { slug: 'member' },
        status: 'pending',
      }],
    });

    const response = await request(app)
      .post('/api/join-requests')
      .send({ organization_id: TEST_ORG_ID })
      .expect(403);

    expect(response.body.error).toBe('organization_join_onboarding_unavailable');
    expect(mockCreateOrganizationMembership).not.toHaveBeenCalled();
  });

  it('does not create a phantom request when ownerless auto-approve hits a pending WorkOS invitation', async () => {
    await pool.query(
      `UPDATE organizations SET email_domain = $2 WHERE workos_organization_id = $1`,
      [TEST_ORG_ID, 'example.com'],
    );
    listOrganizationMemberships
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({ data: [] });
    const reactivateError: any = new Error('Pending organization memberships cannot be reactivated. The invite must be accepted instead.');
    reactivateError.code = 'cannot_reactivate_pending_organization_membership';
    mockCreateOrganizationMembership.mockRejectedValueOnce(reactivateError);

    const response = await request(app)
      .post('/api/join-requests')
      .send({ organization_id: TEST_ORG_ID })
      .expect(403);

    expect(response.body.error).toBe('organization_join_onboarding_unavailable');

    const result = await pool.query(
      `SELECT id FROM organization_join_requests
       WHERE workos_organization_id = $1 AND workos_user_id = $2`,
      [TEST_ORG_ID, TEST_ADMIN_USER_ID],
    );
    expect(result.rows).toHaveLength(0);
  });

  it('approves a join request by creating direct org membership, not sending an invitation', async () => {
    const response = await request(app)
      .post(`/api/organizations/${TEST_ORG_ID}/join-requests/${joinRequestId}/approve`)
      .send({ role: 'member' })
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.success).toBe(true);

    expect(mockCreateOrganizationMembership).toHaveBeenCalledWith({
      userId: TEST_REQUESTER_USER_ID,
      organizationId: TEST_ORG_ID,
      roleSlug: 'member',
    });
    expect(mockSendInvitation).not.toHaveBeenCalled();
  });

  it('marks the join request as approved after membership is created', async () => {
    await request(app)
      .post(`/api/organizations/${TEST_ORG_ID}/join-requests/${joinRequestId}/approve`)
      .send({ role: 'member' })
      .expect(200);

    const result = await pool.query(
      'SELECT status FROM organization_join_requests WHERE id = $1',
      [joinRequestId]
    );
    expect(result.rows[0].status).toBe('approved');
  });

  it('returns 409 and preserves pending row for explicit reconciliation when provider reports an existing member', async () => {
    const alreadyMemberError: any = new Error('Already a member');
    alreadyMemberError.code = 'organization_membership_already_exists';
    mockCreateOrganizationMembership.mockRejectedValueOnce(alreadyMemberError);

    const response = await request(app)
      .post(`/api/organizations/${TEST_ORG_ID}/join-requests/${joinRequestId}/approve`)
      .send({ role: 'member' })
      .expect(409);

    expect(response.body.error).toBe('membership_state_conflict');

    // An already-existing provider member is not proof this request was approved.
    const result = await pool.query(
      'SELECT status FROM organization_join_requests WHERE id = $1',
      [joinRequestId]
    );
    expect(result.rows[0].status).toBe('pending');
  });

  it('returns 409 and leaves pending row intact on cannot_reactivate error', async () => {
    // cannot_reactivate means a pending WorkOS invitation exists — the user is NOT yet
    // a member. The join request must stay pending for admin resolution.
    const reactivateError: any = new Error('Cannot reactivate');
    reactivateError.code = 'cannot_reactivate_pending_organization_membership';
    mockCreateOrganizationMembership.mockRejectedValueOnce(reactivateError);

    const response = await request(app)
      .post(`/api/organizations/${TEST_ORG_ID}/join-requests/${joinRequestId}/approve`)
      .send({ role: 'member' })
      .expect(409);

    expect(response.body.error).toBe('membership_state_conflict');

    // Row must stay pending — user was NOT added
    const result = await pool.query(
      'SELECT status FROM organization_join_requests WHERE id = $1',
      [joinRequestId]
    );
    expect(result.rows[0].status).toBe('pending');
  });

  it('returns 404 for a non-existent join request', async () => {
    const response = await request(app)
      .post(`/api/organizations/${TEST_ORG_ID}/join-requests/00000000-0000-0000-0000-000000000000/approve`)
      .send({ role: 'member' })
      .expect(404);

    expect(response.body.error).toBe('not_found');
  });

  it('returns 400 for invalid role', async () => {
    const response = await request(app)
      .post(`/api/organizations/${TEST_ORG_ID}/join-requests/${joinRequestId}/approve`)
      .send({ role: 'owner' })
      .expect(400);

    expect(response.body.error).toBe('invalid_request');
  });
});

vi.mock('../../src/auth/workos-jwt.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/auth/workos-jwt.js')>()),
  verifyWorkOSJWT: async (value: string) => ({ sub: value, isM2M: false }),
}));
vi.mock('../../src/services/organization-membership-notifications.js', () => ({ notifyMembershipSeats: vi.fn(), notifyMembershipSeatRequest: vi.fn() }));
