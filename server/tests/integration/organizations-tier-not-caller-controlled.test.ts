/**
 * Verifies the contract change on `POST /api/organizations`: callers MUST
 * NOT be able to stamp `membership_tier` from request input. The Stripe
 * webhook (`http.ts:3904`) is the sole writer of `organizations.membership_tier`;
 * accepting it from the caller would let any authenticated user grant
 * themselves tier-gated UI state in the gap before any subscription exists.
 *
 * Also asserts that `corporate_domain` is no longer required to match the
 * caller's email — the field is server-derived and any caller-supplied
 * value is ignored.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

const {
  TEST_USER_ID,
  TEST_DOMAIN,
  mockCreateOrganization,
  mockCreateOrganizationMembership,
} = vi.hoisted(() => {
  process.env.WORKOS_API_KEY ||= 'sk_test_dummy_for_unit_tests';
  process.env.WORKOS_CLIENT_ID ||= 'client_test_dummy_for_unit_tests';
  process.env.WORKOS_COOKIE_PASSWORD ||= 'test-cookie-password-32chars-min-len-1234';
  return {
    TEST_USER_ID: 'user_tier_security_test',
    TEST_DOMAIN: 'tier-security.test',
    mockCreateOrganization: vi.fn(),
    mockCreateOrganizationMembership: vi.fn(),
  };
});

vi.mock('@workos-inc/node', () => ({
  WorkOS: class {
    userManagement = {
      createOrganizationMembership: mockCreateOrganizationMembership,
      listOrganizationMemberships: vi.fn().mockResolvedValue({ data: [] }),
      sendInvitation: vi.fn(),
      getUser: vi.fn().mockResolvedValue({ id: TEST_USER_ID, email: `owner@${TEST_DOMAIN}` }),
      updateOrganizationMembership: vi.fn(),
    };
    organizations = {
      createOrganization: mockCreateOrganization,
      getOrganization: vi.fn(),
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
      getUser: vi.fn().mockResolvedValue({ id: TEST_USER_ID, email: `owner@${TEST_DOMAIN}` }),
      updateOrganizationMembership: vi.fn(),
    },
    organizations: {
      createOrganization: mockCreateOrganization,
      getOrganization: vi.fn(),
    },
    adminPortal: {
      generateLink: vi.fn().mockResolvedValue({ link: 'https://test-portal.workos.com' }),
    },
  },
}));

vi.mock('../../src/middleware/auth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/middleware/auth.js')>()),
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = {
      id: TEST_USER_ID,
      email: `owner@${TEST_DOMAIN}`,
      firstName: 'Test',
      lastName: 'Owner',
      emailVerified: true,
      is_admin: false,
    };
    next();
  },
}));

vi.mock('../../src/middleware/csrf.js', () => ({
  csrfProtection: (_req: any, _res: any, next: any) => next(),
}));

vi.mock('../../src/middleware/rate-limit.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/middleware/rate-limit.js')>()),
  orgCreationRateLimiter: (_req: any, _res: any, next: any) => next(),
}));

vi.mock('../../src/billing/stripe-client.js', () => ({
  stripe: null,
  getSubscriptionInfo: vi.fn().mockResolvedValue(null),
  createStripeCustomer: vi.fn().mockResolvedValue(null),
  createCustomerSession: vi.fn().mockResolvedValue(null),
  createBillingPortalSession: vi.fn().mockResolvedValue(null),
}));

import { HTTPServer } from '../../src/http.js';
import request from 'supertest';
import { initializeDatabase, closeDatabase, getPool } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import type { Pool } from 'pg';

const TEST_ORG_PREFIX = 'org_tier_security_';

describe('POST /api/organizations: tier and domain are not caller-controlled', () => {
  let server: HTTPServer;
  let app: any;
  let pool: Pool;
  let createdOrgId: string;

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString:
        process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:53198/adcp_test',
    });
    await runMigrations();
    server = new HTTPServer();
    await server.start(0);
    app = server.app;
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM organization_memberships WHERE workos_organization_id LIKE $1`, [
      `${TEST_ORG_PREFIX}%`,
    ]);
    await pool.query(`DELETE FROM organization_domains WHERE workos_organization_id LIKE $1`, [
      `${TEST_ORG_PREFIX}%`,
    ]);
    await pool.query(`DELETE FROM registry_audit_log WHERE workos_organization_id LIKE $1`, [
      `${TEST_ORG_PREFIX}%`,
    ]);
    await pool.query(`DELETE FROM organizations WHERE workos_organization_id LIKE $1`, [
      `${TEST_ORG_PREFIX}%`,
    ]);
    await server?.stop();
    await closeDatabase();
  });

  beforeEach(async () => {
    createdOrgId = `${TEST_ORG_PREFIX}${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    mockCreateOrganization.mockReset().mockResolvedValue({ id: createdOrgId, name: 'Acme Tier Test' });
    mockCreateOrganizationMembership.mockReset().mockResolvedValue({
      id: `om_${Date.now()}`,
      userId: TEST_USER_ID,
      organizationId: createdOrgId,
      role: { slug: 'owner' },
    });

    await pool.query(`DELETE FROM organization_domains WHERE domain LIKE $1`, [`%${TEST_DOMAIN}`]);
  });

  it('ignores caller-supplied membership_tier — DB row stores NULL', async () => {
    const res = await request(app)
      .post('/api/organizations')
      .send({
        organization_name: 'Acme Tier Test',
        company_type: 'brand',
        revenue_tier: '5m_50m',
        // The bug: pre-fix, this stamped `membership_tier='company_leader'`
        // on the row, leaking tier-gated UI state until a Stripe sub
        // overwrote it.
        membership_tier: 'company_leader',
      });

    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(300);

    const orgId = res.body?.organization?.id ?? res.body?.id;
    expect(orgId).toBeTruthy();

    const row = await pool.query<{ membership_tier: string | null }>(
      `SELECT membership_tier FROM organizations WHERE workos_organization_id = $1`,
      [orgId],
    );
    expect(row.rowCount).toBe(1);
    expect(row.rows[0].membership_tier).toBeNull();
  });

  it('does not 400 when caller-supplied corporate_domain disagrees with email — field is ignored', async () => {
    const res = await request(app)
      .post('/api/organizations')
      .send({
        organization_name: 'Acme Domain-Mismatch Test',
        company_type: 'brand',
        revenue_tier: '5m_50m',
        // Pre-fix, this returned 400 "Domain mismatch". Server now derives
        // domain from `req.user.email` and ignores this field.
        corporate_domain: 'someone-else.example',
      });

    expect(res.status).not.toBe(400);
    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(300);

    const orgId = res.body?.organization?.id ?? res.body?.id;
    const domainRow = await pool.query<{ domain: string }>(
      `SELECT domain FROM organization_domains WHERE workos_organization_id = $1`,
      [orgId],
    );
    expect(domainRow.rows.map((r) => r.domain)).toContain(TEST_DOMAIN);
    expect(domainRow.rows.map((r) => r.domain)).not.toContain('someone-else.example');
  });
});
