import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';

// vi.hoisted ensures all of these are available inside vi.mock factories
const {
  TEST_ADMIN_USER_ID,
  TEST_REQUESTER_USER_ID,
  TEST_ORG_ID,
  mockCreateOrganizationMembership,
  mockSendInvitation,
} = vi.hoisted(() => ({
  TEST_ADMIN_USER_ID: 'user_join_req_admin',
  TEST_REQUESTER_USER_ID: 'user_join_req_requester',
  TEST_ORG_ID: 'org_join_req_test',
  mockCreateOrganizationMembership: vi.fn().mockResolvedValue({ id: 'om_test_new' }),
  mockSendInvitation: vi.fn(),
}));

vi.mock('../../src/auth/workos-client.js', () => ({
  workos: {
    userManagement: {
      listOrganizationMemberships: vi.fn().mockImplementation(({ userId, organizationId }) => {
        if (userId === TEST_ADMIN_USER_ID && organizationId === TEST_ORG_ID) {
          return Promise.resolve({
            data: [{ id: 'om_admin', userId: TEST_ADMIN_USER_ID, organizationId: TEST_ORG_ID, role: { slug: 'admin' }, status: 'active' }],
          });
        }
        return Promise.resolve({ data: [] });
      }),
      createOrganizationMembership: mockCreateOrganizationMembership,
      sendInvitation: mockSendInvitation,
      getUser: vi.fn().mockResolvedValue({ id: TEST_ADMIN_USER_ID, email: 'admin@example.com' }),
    },
    organizations: {
      getOrganization: vi.fn().mockResolvedValue({ id: TEST_ORG_ID, name: 'Test Org' }),
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

vi.mock('../../src/middleware/auth.js', () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = {
      id: TEST_ADMIN_USER_ID,
      email: 'admin@example.com',
      firstName: 'Admin',
      lastName: 'User',
      is_admin: false,
    };
    next();
  },
  requireAdmin: (_req: any, res: any) => {
    return res.status(403).json({ error: 'Admin required' });
  },
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
    mockCreateOrganizationMembership.mockResolvedValue({ id: 'om_test_new' });

    await pool.query(
      `INSERT INTO organizations (workos_organization_id, name, is_personal, created_at, updated_at)
       VALUES ($1, $2, false, NOW(), NOW())
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
    await pool.query('DELETE FROM organization_join_requests WHERE workos_organization_id = $1', [TEST_ORG_ID]);
  });

  it('approves a join request by creating direct org membership, not sending an invitation', async () => {
    const response = await request(app)
      .post(`/api/organizations/${TEST_ORG_ID}/join-requests/${joinRequestId}/approve`)
      .send({ role: 'member' })
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.message).toContain('requester@example.com');

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

  it('returns 400 when the user is already a member', async () => {
    const alreadyMemberError: any = new Error('Already a member');
    alreadyMemberError.code = 'organization_membership_already_exists';
    mockCreateOrganizationMembership.mockRejectedValueOnce(alreadyMemberError);

    const response = await request(app)
      .post(`/api/organizations/${TEST_ORG_ID}/join-requests/${joinRequestId}/approve`)
      .send({ role: 'member' })
      .expect(400);

    expect(response.body.error).toBe('User already a member');
  });

  it('returns 404 for a non-existent join request', async () => {
    const response = await request(app)
      .post(`/api/organizations/${TEST_ORG_ID}/join-requests/00000000-0000-0000-0000-000000000000/approve`)
      .send({ role: 'member' })
      .expect(404);

    expect(response.body.error).toBe('Request not found');
  });

  it('returns 400 for invalid role', async () => {
    const response = await request(app)
      .post(`/api/organizations/${TEST_ORG_ID}/join-requests/${joinRequestId}/approve`)
      .send({ role: 'owner' })
      .expect(400);

    expect(response.body.error).toBe('Invalid role');
  });
});
