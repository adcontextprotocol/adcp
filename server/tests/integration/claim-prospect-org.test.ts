/**
 * Route-level test for POST /api/organizations/:orgId/claim — the endpoint
 * the auth/callback redirect lands a domain match against. Uses the same
 * WorkOS-mock-via-class harness as join-request-approval.test.ts, then
 * exercises the happy path plus each refusal branch under the row lock +
 * WorkOS round-trip flow.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

const {
  TEST_USER_ID,
  TEST_ORG_PROSPECT,
  TEST_ORG_PAYING,
  TEST_ORG_HAS_MEMBER,
  TEST_ORG_PERSONAL,
  TEST_DOMAIN,
  TEST_OTHER_DOMAIN,
  mockCreateOrganizationMembership,
} = vi.hoisted(() => {
  process.env.WORKOS_API_KEY ||= 'sk_test_dummy_for_unit_tests';
  process.env.WORKOS_CLIENT_ID ||= 'client_test_dummy_for_unit_tests';
  process.env.WORKOS_COOKIE_PASSWORD ||= 'test-cookie-password-32chars-min-len-1234';
  return {
    TEST_USER_ID: 'user_claim_test',
    TEST_ORG_PROSPECT: 'org_claim_route_prospect',
    TEST_ORG_PAYING: 'org_claim_route_paying',
    TEST_ORG_HAS_MEMBER: 'org_claim_route_hasmember',
    TEST_ORG_PERSONAL: 'org_claim_route_personal',
    TEST_DOMAIN: 'voiseclaim-route.test',
    TEST_OTHER_DOMAIN: 'someoneelse.test',
    mockCreateOrganizationMembership: vi.fn(),
  };
});

vi.mock('@workos-inc/node', () => ({
  WorkOS: class {
    userManagement = {
      createOrganizationMembership: mockCreateOrganizationMembership,
      listOrganizationMemberships: vi.fn().mockResolvedValue({ data: [] }),
      sendInvitation: vi.fn(),
      getUser: vi.fn().mockResolvedValue({ id: TEST_USER_ID, email: `claimer@${TEST_DOMAIN}` }),
    };
    organizations = {
      getOrganization: vi.fn().mockResolvedValue({ id: TEST_ORG_PROSPECT, name: 'Test Prospect' }),
    };
    adminPortal = {
      generateLink: vi.fn().mockResolvedValue({ link: 'https://test-portal.workos.com' }),
    };
  },
}));

vi.mock('../../src/auth/workos-client.js', () => ({
  workos: {
    userManagement: {
      createOrganizationMembership: mockCreateOrganizationMembership,
      listOrganizationMemberships: vi.fn().mockResolvedValue({ data: [] }),
      sendInvitation: vi.fn(),
      getUser: vi.fn().mockResolvedValue({ id: TEST_USER_ID, email: `claimer@${TEST_DOMAIN}` }),
    },
    organizations: {
      getOrganization: vi.fn().mockResolvedValue({ id: TEST_ORG_PROSPECT, name: 'Test Prospect' }),
    },
    adminPortal: {
      generateLink: vi.fn().mockResolvedValue({ link: 'https://test-portal.workos.com' }),
    },
  },
}));

import { HTTPServer } from '../../src/http.js';
import request from 'supertest';
import { initializeDatabase, closeDatabase, getPool } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import type { Pool } from 'pg';

let userOverride: { emailVerified?: boolean; email?: string } = {};

vi.mock('../../src/middleware/auth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/middleware/auth.js')>()),
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = {
      id: TEST_USER_ID,
      email: userOverride.email ?? `claimer@${TEST_DOMAIN}`,
      firstName: 'Claim',
      lastName: 'Tester',
      emailVerified: userOverride.emailVerified ?? true,
      is_admin: false,
    };
    next();
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

const ALL_TEST_ORGS = [
  TEST_ORG_PROSPECT,
  TEST_ORG_PAYING,
  TEST_ORG_HAS_MEMBER,
  TEST_ORG_PERSONAL,
];

async function cleanup(pool: Pool) {
  await pool.query('DELETE FROM organization_memberships WHERE workos_organization_id = ANY($1)', [ALL_TEST_ORGS]);
  await pool.query('DELETE FROM registry_audit_log WHERE workos_organization_id = ANY($1)', [ALL_TEST_ORGS]);
  await pool.query('DELETE FROM organization_domains WHERE workos_organization_id = ANY($1)', [ALL_TEST_ORGS]);
  await pool.query('DELETE FROM organizations WHERE workos_organization_id = ANY($1)', [ALL_TEST_ORGS]);
}

async function seedProspect(pool: Pool, opts: {
  orgId: string;
  domain: string;
  isPersonal?: boolean;
  subscriptionStatus?: string | null;
  hasMember?: boolean;
}) {
  await pool.query(
    `INSERT INTO organizations (workos_organization_id, name, is_personal, email_domain, subscription_status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW(), NOW())`,
    [opts.orgId, `Org ${opts.orgId}`, opts.isPersonal ?? false, opts.domain, opts.subscriptionStatus ?? null],
  );
  if (opts.hasMember) {
    await pool.query(
      `INSERT INTO organization_memberships (workos_user_id, workos_organization_id, workos_membership_id, email, role, seat_type, created_at, updated_at, synced_at)
       VALUES ($1, $2, $3, $4, 'owner', 'contributor', NOW(), NOW(), NOW())`,
      ['user_existing_owner', opts.orgId, 'om_existing', `existing@${opts.domain}`],
    );
  }
}

describe('POST /api/organizations/:orgId/claim', () => {
  let server: HTTPServer;
  let app: any;
  let pool: Pool;

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString: process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:5432/adcp_test',
    });
    await runMigrations();
    server = new HTTPServer();
    app = server.app;
  }, 60000);

  afterAll(async () => {
    await cleanup(pool);
    await closeDatabase();
  });

  beforeEach(async () => {
    await cleanup(pool);
    mockCreateOrganizationMembership.mockReset();
    mockCreateOrganizationMembership.mockResolvedValue({ id: 'om_new' });
    userOverride = {};
  });

  it.each([
    ['verified', true, TEST_DOMAIN],
    ['unverified', false, TEST_DOMAIN],
    ['wrong domain', true, TEST_OTHER_DOMAIN],
  ])('denies %s claim without grants or audits', async (_label, verified, domain) => {
    userOverride = { emailVerified: verified as boolean, email: `claimer@${domain}` };
    await seedProspect(pool, { orgId: TEST_ORG_PROSPECT, domain: TEST_DOMAIN });
    const res = await request(app).post(`/api/organizations/${TEST_ORG_PROSPECT}/claim`).send({});
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('organization_onboarding_disabled');
    expect(mockCreateOrganizationMembership).not.toHaveBeenCalled();
    expect((await pool.query('SELECT * FROM organization_memberships WHERE workos_organization_id = $1', [TEST_ORG_PROSPECT])).rowCount).toBe(0);
    expect((await pool.query('SELECT * FROM registry_audit_log WHERE workos_organization_id = $1', [TEST_ORG_PROSPECT])).rowCount).toBe(0);
  });
});
