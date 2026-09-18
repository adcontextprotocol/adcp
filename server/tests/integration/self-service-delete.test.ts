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
vi.mock('../../src/middleware/auth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/middleware/auth.js')>()),
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = {
      id: TEST_USER_ID,
      email: 'owner@test.com',
      is_admin: false
    };
    next();
  },
  requireAdmin: (_req: any, res: any) => {
    return res.status(403).json({ error: 'Admin required' });
  },
}));

vi.mock('../../src/middleware/csrf.js', () => ({
  csrfProtection: (_req: any, _res: any, next: any) => next(),
}));

// Mock Stripe client to control subscription checks
vi.mock('../../src/billing/stripe-client.js', () => ({
  stripe: null,
  getSubscriptionInfo: vi.fn().mockResolvedValue(null),
  createStripeCustomer: vi.fn().mockResolvedValue(null),
  createCustomerSession: vi.fn().mockResolvedValue(null),
  createBillingPortalSession: vi.fn().mockResolvedValue(null),
}));

// Mock WorkOS client. Production code calls `new WorkOS(...)` and tests
// use `vi.mocked(instance.userManagement.listOrganizationMemberships)
// .mockImplementation(...)` to retarget per-test, so every `new WorkOS()`
// must hand back the SAME shared methods (otherwise the per-test override
// runs against a throwaway instance the production code never sees).
const workosMocks = vi.hoisted(() => ({
  listOrganizationMemberships: vi.fn(),
  deleteOrganization: vi.fn().mockResolvedValue({}),
  listOrganizations: vi.fn().mockResolvedValue({ data: [] }),
}));

vi.mock('@workos-inc/node', () => ({
  WorkOS: class {
    userManagement = {
      listOrganizationMemberships: workosMocks.listOrganizationMemberships,
    };
    organizations = {
      deleteOrganization: workosMocks.deleteOrganization,
      listOrganizations: workosMocks.listOrganizations,
    };
  },
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
    // Reset per-test WorkOS mock to the default (owner of TEST_ORG_ID,
    // member of org_member_only, empty otherwise). Per-test cases below
    // reassign this implementation when they need to allow ownership of
    // a different org id.
    workosMocks.listOrganizationMemberships.mockReset().mockImplementation(
      ({ organizationId }: { organizationId: string }) => {
        if (organizationId === TEST_ORG_ID) {
          return Promise.resolve({
            data: [{
              id: 'om_test',
              userId: TEST_USER_ID,
              organizationId: TEST_ORG_ID,
              role: { slug: 'owner' },
              status: 'active',
            }],
          });
        }
        if (organizationId === 'org_member_only') {
          return Promise.resolve({
            data: [{
              id: 'om_member',
              userId: TEST_USER_ID,
              organizationId: 'org_member_only',
              role: { slug: 'member' },
              status: 'active',
            }],
          });
        }
        return Promise.resolve({ data: [] });
      },
    );
  });

  afterEach(async () => {
    // Clean up test data
    await pool.query('DELETE FROM revenue_events WHERE workos_organization_id LIKE $1', ['org_self_delete%']);
    await pool.query('DELETE FROM member_profiles WHERE workos_organization_id LIKE $1', ['org_self_delete%']);
    await pool.query('DELETE FROM organizations WHERE workos_organization_id LIKE $1', ['org_self_delete%']);
    await pool.query('DELETE FROM organizations WHERE workos_organization_id = $1', ['org_member_only']);
  });

  // #6827: self-service deletion is contained. Every request reaching the route
  // gets one stable temporary-unavailable response before provider, database,
  // cache, notification or audit work. These cases keep the original fixtures so
  // the former decision inputs (confirmation text, payment history, active
  // subscription, non-owner role, unknown organization) are proven not to change
  // the outcome and not to mutate stored rows.
  describe('DELETE /api/organizations/:orgId (contained)', () => {
    const unavailable = {
      error: 'organization_deletion_unavailable',
      message: 'Organization deletion is temporarily unavailable.',
    };

    beforeEach(() => {
      workosMocks.deleteOrganization.mockClear();
    });

    async function expectContained(orgId: string, body: unknown) {
      const response = await request(app)
        .delete(`/api/organizations/${orgId}`)
        .send(body as object)
        .expect(503);

      expect(response.body).toEqual(unavailable);
      expect(workosMocks.deleteOrganization).not.toHaveBeenCalled();
      return response;
    }

    async function orgRow(orgId: string) {
      const result = await pool.query(
        'SELECT to_jsonb(o) AS row FROM organizations o WHERE workos_organization_id = $1',
        [orgId]
      );
      return result.rows[0]?.row ?? null;
    }

    it('returns the same response for an organization the caller does not belong to', async () => {
      // No membership lookup runs, so the response cannot be used to enumerate
      // organization IDs and cannot be distinguished from the owner response.
      await expectContained('org_nonexistent', { confirmation: 'Some Name' });
    });

    it('returns the contained response without confirmation and leaves the row intact', async () => {
      const before = await orgRow(TEST_ORG_ID);
      const response = await expectContained(TEST_ORG_ID, {});

      // No organization name, confirmation prompt or other org data is disclosed.
      expect(response.body).not.toHaveProperty('organization_name');
      expect(response.body).not.toHaveProperty('requires_confirmation');
      expect(await orgRow(TEST_ORG_ID)).toEqual(before);
    });

    it('returns the contained response for a wrong confirmation name', async () => {
      const before = await orgRow(TEST_ORG_ID);
      await expectContained(TEST_ORG_ID, { confirmation: 'Wrong Name' });
      expect(await orgRow(TEST_ORG_ID)).toEqual(before);
    });

    it('returns the contained response for an organization with payment history', async () => {
      const PAID_ORG_ID = 'org_self_delete_paid';
      await pool.query(
        `INSERT INTO organizations (workos_organization_id, name, stripe_customer_id, created_at, updated_at)
         VALUES ($1, $2, $3, NOW(), NOW())
         ON CONFLICT (workos_organization_id) DO UPDATE SET name = $2, stripe_customer_id = $3`,
        [PAID_ORG_ID, 'Paid Org', 'cus_paid']
      );
      await pool.query(
        `INSERT INTO revenue_events (workos_organization_id, revenue_type, amount_paid, currency, paid_at)
         VALUES ($1, $2, $3, $4, NOW())`,
        [PAID_ORG_ID, 'subscription_initial', 2999, 'usd']
      );

      // Owning PAID_ORG_ID no longer changes anything, but keep the fixture
      // faithful to the authority the contained route used to accept.
      workosMocks.listOrganizationMemberships.mockImplementation(({ organizationId }: { organizationId: string }) => {
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

      const before = await orgRow(PAID_ORG_ID);
      const response = await expectContained(PAID_ORG_ID, { confirmation: 'Paid Org' });

      // The payment-history verdict is no longer disclosed either.
      expect(response.body).not.toHaveProperty('has_payments');
      expect(await orgRow(PAID_ORG_ID)).toEqual(before);

      const revenue = await pool.query(
        'SELECT COUNT(*)::int AS count FROM revenue_events WHERE workos_organization_id = $1',
        [PAID_ORG_ID]
      );
      expect(revenue.rows[0].count).toBe(1);
    });

    it('does not delete an unpaid organization even with the exact confirmation', async () => {
      const before = await orgRow(TEST_ORG_ID);
      await expectContained(TEST_ORG_ID, { confirmation: 'Self Delete Test Org' });
      expect(await orgRow(TEST_ORG_ID)).toEqual(before);
    });

    it('does not cascade into related member profiles', async () => {
      await pool.query(
        `INSERT INTO member_profiles (workos_organization_id, display_name, slug, created_at, updated_at)
         VALUES ($1, $2, $3, NOW(), NOW())
         ON CONFLICT DO NOTHING`,
        [TEST_ORG_ID, 'Test Profile', 'test-profile-self-delete']
      );

      await expectContained(TEST_ORG_ID, { confirmation: 'Self Delete Test Org' });

      const afterResult = await pool.query(
        'SELECT 1 FROM member_profiles WHERE workos_organization_id = $1',
        [TEST_ORG_ID]
      );
      expect(afterResult.rows.length).toBe(1);
    });

    it('returns the contained response for a non-owner member', async () => {
      const MEMBER_ORG_ID = 'org_member_only';
      await pool.query(
        `INSERT INTO organizations (workos_organization_id, name, created_at, updated_at)
         VALUES ($1, $2, NOW(), NOW())
         ON CONFLICT (workos_organization_id) DO UPDATE SET name = $2`,
        [MEMBER_ORG_ID, 'Member Only Org']
      );

      const before = await orgRow(MEMBER_ORG_ID);
      const response = await expectContained(MEMBER_ORG_ID, { confirmation: 'Member Only Org' });

      // A member and an owner are indistinguishable here; neither is permitted.
      expect(response.body.error).not.toBe('Insufficient permissions');
      expect(await orgRow(MEMBER_ORG_ID)).toEqual(before);
    });

    it('returns the contained response for an organization with an active subscription', async () => {
      const SUB_ORG_ID = 'org_self_delete_sub';
      await pool.query(
        `INSERT INTO organizations (workos_organization_id, name, subscription_status, created_at, updated_at)
         VALUES ($1, $2, 'active', NOW(), NOW())
         ON CONFLICT (workos_organization_id) DO UPDATE SET name = $2, subscription_status = 'active'`,
        [SUB_ORG_ID, 'Subscribed Org']
      );

      workosMocks.listOrganizationMemberships.mockImplementation(({ organizationId }: { organizationId: string }) => {
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

      const before = await orgRow(SUB_ORG_ID);
      const response = await expectContained(SUB_ORG_ID, { confirmation: 'Subscribed Org' });

      expect(response.body).not.toHaveProperty('subscription_status');
      expect(await orgRow(SUB_ORG_ID)).toEqual(before);
    });
  });
});
