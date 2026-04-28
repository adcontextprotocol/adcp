/**
 * Integration tests for the customer-facing auto-provisioning toggles.
 *
 * Exercises GET /api/organizations/:orgId/domains (now returns both flags
 * + inferred_subsidiaries) and PATCH /api/organizations/:orgId/settings
 * (now accepts auto_provision_brand_hierarchy_children) end-to-end against
 * a real DB and mocked WorkOS membership lookup.
 *
 * The trigger on auto_provision_brand_hierarchy_children should set
 * auto_provision_hierarchy_enabled_at when the flag flips false→true.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { HTTPServer } from '../../src/http.js';
import request from 'supertest';
import { initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import type { Pool } from 'pg';

const OWNER_USER = 'user_apt_owner';
const ADMIN_USER = 'user_apt_admin';
const TEST_ORG = 'org_apt_test';
const TEST_DOMAIN = 'apt-co.test';
const SUB_DOMAIN_A = 'apt-sub-a.test';
const SUB_DOMAIN_B = 'apt-sub-b.test';

let currentMockUser = OWNER_USER;
let currentMockEmail = 'owner@apt-co.test';

vi.mock('../../src/middleware/auth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/middleware/auth.js')>()),
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { id: currentMockUser, email: currentMockEmail, is_admin: false };
    next();
  },
}));

vi.mock('../../src/middleware/csrf.js', () => ({
  csrfProtection: (_req: any, _res: any, next: any) => next(),
}));

const workosMocks = vi.hoisted(() => ({
  listOrganizationMemberships: vi.fn(),
}));

vi.mock('@workos-inc/node', () => ({
  WorkOS: class {
    userManagement = {
      listOrganizationMemberships: workosMocks.listOrganizationMemberships,
    };
    organizations = {};
  },
}));

vi.mock('../../src/addie/mcp/admin-tools.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/addie/mcp/admin-tools.js')>()),
  isWebUserAAOAdmin: vi.fn().mockResolvedValue(false),
}));

describe('org auto-provisioning toggles', () => {
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
  });

  afterAll(async () => {
    await cleanupTestData(pool);
    await server.stop();
    await closeDatabase();
  });

  beforeEach(async () => {
    await cleanupTestData(pool);
    workosMocks.listOrganizationMemberships.mockReset();
  });

  it('owner GET /domains returns both flags and inferred subsidiaries', async () => {
    await seedTestOrg(pool, { hierarchyOptIn: false });
    await seedSubsidiary(pool, SUB_DOMAIN_A, TEST_DOMAIN, 'Subsidiary A');
    await seedSubsidiary(pool, SUB_DOMAIN_B, TEST_DOMAIN, 'Subsidiary B');
    workosMocks.listOrganizationMemberships.mockResolvedValue({
      data: [{ role: { slug: 'owner' }, status: 'active' }],
    });

    const res = await request(app).get(`/api/organizations/${TEST_ORG}/domains`);

    expect(res.status).toBe(200);
    expect(res.body.auto_provision_verified_domain).toBe(true); // default
    expect(res.body.auto_provision_brand_hierarchy_children).toBe(false); // default
    expect(res.body.auto_provision_hierarchy_enabled_at).toBeNull();
    expect(res.body.inferred_subsidiaries).toHaveLength(2);
    const domains = res.body.inferred_subsidiaries.map((s: any) => s.domain).sort();
    expect(domains).toEqual([SUB_DOMAIN_A, SUB_DOMAIN_B]);
  });

  it('inferred_subsidiaries excludes low-confidence and stale brand-registry rows', async () => {
    await seedTestOrg(pool);
    // Low confidence — must NOT appear.
    await seedSubsidiary(pool, SUB_DOMAIN_A, TEST_DOMAIN, 'Low Confidence Sub', { confidence: 'low' });
    // High confidence but stale (200 days old) — must NOT appear.
    const stale = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000);
    await seedSubsidiary(pool, SUB_DOMAIN_B, TEST_DOMAIN, 'Stale Sub', { last_validated: stale });
    workosMocks.listOrganizationMemberships.mockResolvedValue({
      data: [{ role: { slug: 'owner' }, status: 'active' }],
    });

    const res = await request(app).get(`/api/organizations/${TEST_ORG}/domains`);
    expect(res.body.inferred_subsidiaries).toEqual([]);
  });

  it('owner PATCH /settings flips auto_provision_brand_hierarchy_children, trigger sets enabled_at', async () => {
    await seedTestOrg(pool, { hierarchyOptIn: false });
    workosMocks.listOrganizationMemberships.mockResolvedValue({
      data: [{ role: { slug: 'owner' }, status: 'active' }],
    });

    const res = await request(app)
      .patch(`/api/organizations/${TEST_ORG}/settings`)
      .send({ auto_provision_brand_hierarchy_children: true });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.auto_provision_brand_hierarchy_children).toBe(true);

    // The trigger should have set enabled_at to NOW().
    const orgRow = await pool.query<{
      auto_provision_brand_hierarchy_children: boolean;
      auto_provision_hierarchy_enabled_at: Date | null;
    }>(
      `SELECT auto_provision_brand_hierarchy_children, auto_provision_hierarchy_enabled_at
       FROM organizations WHERE workos_organization_id = $1`,
      [TEST_ORG]
    );
    expect(orgRow.rows[0].auto_provision_brand_hierarchy_children).toBe(true);
    expect(orgRow.rows[0].auto_provision_hierarchy_enabled_at).not.toBeNull();
  });

  it('admin (not owner) cannot flip auto_provision_brand_hierarchy_children', async () => {
    await seedTestOrg(pool, { hierarchyOptIn: false });
    currentMockUser = ADMIN_USER;
    currentMockEmail = 'admin@apt-co.test';
    workosMocks.listOrganizationMemberships.mockResolvedValue({
      data: [{ role: { slug: 'admin' }, status: 'active' }],
    });

    const res = await request(app)
      .patch(`/api/organizations/${TEST_ORG}/settings`)
      .send({ auto_provision_brand_hierarchy_children: true });

    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/owners/i);

    // DB should be unchanged.
    const orgRow = await pool.query<{ auto_provision_brand_hierarchy_children: boolean }>(
      `SELECT auto_provision_brand_hierarchy_children FROM organizations WHERE workos_organization_id = $1`,
      [TEST_ORG]
    );
    expect(orgRow.rows[0].auto_provision_brand_hierarchy_children).toBe(false);

    // Reset for next test
    currentMockUser = OWNER_USER;
    currentMockEmail = 'owner@apt-co.test';
  });

  it('flipping the flag back to false clears the enabled_at timestamp', async () => {
    await seedTestOrg(pool, { hierarchyOptIn: true });
    workosMocks.listOrganizationMemberships.mockResolvedValue({
      data: [{ role: { slug: 'owner' }, status: 'active' }],
    });

    // Confirm enabled_at is set on the seeded row.
    const before = await pool.query<{ auto_provision_hierarchy_enabled_at: Date | null }>(
      `SELECT auto_provision_hierarchy_enabled_at FROM organizations WHERE workos_organization_id = $1`,
      [TEST_ORG]
    );
    expect(before.rows[0].auto_provision_hierarchy_enabled_at).not.toBeNull();

    const res = await request(app)
      .patch(`/api/organizations/${TEST_ORG}/settings`)
      .send({ auto_provision_brand_hierarchy_children: false });

    expect(res.status).toBe(200);

    const after = await pool.query<{
      auto_provision_brand_hierarchy_children: boolean;
      auto_provision_hierarchy_enabled_at: Date | null;
    }>(
      `SELECT auto_provision_brand_hierarchy_children, auto_provision_hierarchy_enabled_at
       FROM organizations WHERE workos_organization_id = $1`,
      [TEST_ORG]
    );
    expect(after.rows[0].auto_provision_brand_hierarchy_children).toBe(false);
    expect(after.rows[0].auto_provision_hierarchy_enabled_at).toBeNull();
  });

  it('rejects non-boolean auto_provision_brand_hierarchy_children', async () => {
    await seedTestOrg(pool);
    workosMocks.listOrganizationMemberships.mockResolvedValue({
      data: [{ role: { slug: 'owner' }, status: 'active' }],
    });

    const res = await request(app)
      .patch(`/api/organizations/${TEST_ORG}/settings`)
      .send({ auto_provision_brand_hierarchy_children: 'yes-please' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid auto_provision_brand_hierarchy_children/);
  });
});

async function cleanupTestData(pool: Pool) {
  await pool.query('DELETE FROM organization_domains WHERE workos_organization_id = $1', [TEST_ORG]);
  await pool.query('DELETE FROM organizations WHERE workos_organization_id = $1', [TEST_ORG]);
  await pool.query('DELETE FROM brands WHERE domain = ANY($1)', [[SUB_DOMAIN_A, SUB_DOMAIN_B, TEST_DOMAIN]]);
}

async function seedTestOrg(pool: Pool, opts: { hierarchyOptIn?: boolean } = {}) {
  // Always INSERT with flag false; flip via UPDATE if requested so the
  // trigger fires (BEFORE UPDATE only, matching the PATCH-driven prod path).
  await pool.query(
    `INSERT INTO organizations (
       workos_organization_id, name, email_domain, subscription_status,
       auto_provision_brand_hierarchy_children, created_at, updated_at
     ) VALUES ($1, 'APT Test Co', $2, 'active', false, NOW(), NOW())
     ON CONFLICT (workos_organization_id) DO UPDATE
       SET auto_provision_brand_hierarchy_children = false,
           auto_provision_hierarchy_enabled_at = NULL`,
    [TEST_ORG, TEST_DOMAIN]
  );
  if (opts.hierarchyOptIn === true) {
    await pool.query(
      `UPDATE organizations SET auto_provision_brand_hierarchy_children = true
       WHERE workos_organization_id = $1`,
      [TEST_ORG]
    );
  }
  await pool.query(
    `INSERT INTO organization_domains (workos_organization_id, domain, verified, is_primary, source, created_at, updated_at)
     VALUES ($1, $2, true, true, 'workos', NOW(), NOW())
     ON CONFLICT (domain) DO UPDATE SET verified = true, workos_organization_id = $1`,
    [TEST_ORG, TEST_DOMAIN]
  );
}

async function seedSubsidiary(
  pool: Pool,
  domain: string,
  parentDomain: string,
  brandName: string,
  opts: { confidence?: 'high' | 'low'; last_validated?: Date | null } = {},
) {
  await pool.query(
    `INSERT INTO brands (domain, brand_name, house_domain, source_type, brand_manifest, last_validated, created_at, updated_at)
     VALUES ($1, $2, $3, 'enriched', $4, $5, NOW(), NOW())
     ON CONFLICT (domain) DO UPDATE
       SET house_domain = EXCLUDED.house_domain,
           brand_manifest = EXCLUDED.brand_manifest,
           last_validated = EXCLUDED.last_validated`,
    [
      domain,
      brandName,
      parentDomain,
      JSON.stringify({ classification: { confidence: opts.confidence ?? 'high' } }),
      opts.last_validated === undefined ? new Date() : opts.last_validated,
    ]
  );
}
