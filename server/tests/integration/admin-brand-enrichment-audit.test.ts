/**
 * Admin PATCH /api/admin/brand-enrichment/brand/:domain audit-log integration test.
 *
 * `house_domain` feeds the brand-hierarchy auto-link path, so changes to it
 * can graft new sets of users onto a paying org's auto-link reach. The PATCH
 * handler must write a registry_audit_log row with prior + new values + admin
 * email so a misbehaving / compromised admin is detectable.
 *
 * Per security review on PR #3378.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { HTTPServer } from '../../src/http.js';
import request from 'supertest';
import { initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import type { Pool } from 'pg';

vi.mock('../../src/middleware/auth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/middleware/auth.js')>()),
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { id: 'user_test_admin_audit', email: 'admin-audit@test.com', is_admin: true };
    next();
  },
  requireAdmin: (_req: any, _res: any, next: any) => next(),
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

const TEST_BRAND_DOMAIN = 'audit-test-brand.test';
const TEST_PARENT_DOMAIN = 'audit-test-parent.test';
const TEST_NEW_PARENT_DOMAIN = 'audit-test-new-parent.test';
const TEST_PARENT_ORG_ID = 'org_audit_test_parent';

describe('admin brand PATCH audit log', () => {
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
    await pool.query('DELETE FROM registry_audit_log WHERE workos_user_id = $1', ['user_test_admin_audit']);
    await pool.query('DELETE FROM brands WHERE domain = $1', [TEST_BRAND_DOMAIN]);
    await pool.query('DELETE FROM organization_domains WHERE workos_organization_id = $1', [TEST_PARENT_ORG_ID]);
    await pool.query('DELETE FROM organizations WHERE workos_organization_id = $1', [TEST_PARENT_ORG_ID]);
    await server.stop();
    await closeDatabase();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM registry_audit_log WHERE workos_user_id = $1', ['user_test_admin_audit']);
    await pool.query('DELETE FROM brands WHERE domain = $1', [TEST_BRAND_DOMAIN]);
    await pool.query('DELETE FROM organization_domains WHERE workos_organization_id = $1', [TEST_PARENT_ORG_ID]);
    await pool.query('DELETE FROM organizations WHERE workos_organization_id = $1', [TEST_PARENT_ORG_ID]);

    // Seed a brand and a paying parent org with a verified domain so the
    // audit log can resolve a non-sentinel workos_organization_id.
    await pool.query(
      `INSERT INTO brands (domain, brand_name, source_type, created_at, updated_at)
       VALUES ($1, 'Test Brand', 'enriched', NOW(), NOW())`,
      [TEST_BRAND_DOMAIN],
    );
    await pool.query(
      `INSERT INTO organizations (workos_organization_id, name, subscription_status, created_at, updated_at)
       VALUES ($1, 'Audit Parent', 'active', NOW(), NOW())`,
      [TEST_PARENT_ORG_ID],
    );
    await pool.query(
      `INSERT INTO organization_domains (workos_organization_id, domain, verified, is_primary, source, created_at, updated_at)
       VALUES ($1, $2, true, true, 'workos', NOW(), NOW())`,
      [TEST_PARENT_ORG_ID, TEST_PARENT_DOMAIN],
    );
  });

  it('writes an audit row when house_domain changes from null to a value', async () => {
    const res = await request(app)
      .patch(`/api/admin/brand-enrichment/brand/${TEST_BRAND_DOMAIN}`)
      .send({ house_domain: TEST_PARENT_DOMAIN });

    expect(res.status).toBe(200);

    const audit = await pool.query<{
      action: string;
      workos_organization_id: string;
      details: Record<string, unknown>;
    }>(
      `SELECT action, workos_organization_id, details FROM registry_audit_log
       WHERE workos_user_id = $1 AND resource_id = $2`,
      ['user_test_admin_audit', TEST_BRAND_DOMAIN],
    );

    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].action).toBe('brand_house_domain_changed');
    expect(audit.rows[0].workos_organization_id).toBe(TEST_PARENT_ORG_ID); // resolved, not sentinel
    expect(audit.rows[0].details).toMatchObject({
      domain: TEST_BRAND_DOMAIN,
      prior_house_domain: null,
      new_house_domain: TEST_PARENT_DOMAIN,
      admin_email: 'admin-audit@test.com',
    });
  });

  it('writes an audit row when house_domain changes from one value to another', async () => {
    // Pre-set house_domain to TEST_PARENT_DOMAIN.
    await pool.query(
      'UPDATE brands SET house_domain = $1 WHERE domain = $2',
      [TEST_PARENT_DOMAIN, TEST_BRAND_DOMAIN],
    );

    const res = await request(app)
      .patch(`/api/admin/brand-enrichment/brand/${TEST_BRAND_DOMAIN}`)
      .send({ house_domain: TEST_NEW_PARENT_DOMAIN });

    expect(res.status).toBe(200);

    const audit = await pool.query<{ details: Record<string, unknown> }>(
      `SELECT details FROM registry_audit_log
       WHERE workos_user_id = $1 AND resource_id = $2 AND action = 'brand_house_domain_changed'`,
      ['user_test_admin_audit', TEST_BRAND_DOMAIN],
    );

    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].details).toMatchObject({
      prior_house_domain: TEST_PARENT_DOMAIN,
      new_house_domain: TEST_NEW_PARENT_DOMAIN,
    });
  });

  it('does NOT write an audit row when house_domain is unchanged', async () => {
    await pool.query(
      'UPDATE brands SET house_domain = $1 WHERE domain = $2',
      [TEST_PARENT_DOMAIN, TEST_BRAND_DOMAIN],
    );

    // PATCH with the same house_domain.
    const res = await request(app)
      .patch(`/api/admin/brand-enrichment/brand/${TEST_BRAND_DOMAIN}`)
      .send({ house_domain: TEST_PARENT_DOMAIN, keller_type: 'sub_brand' });

    expect(res.status).toBe(200);

    const audit = await pool.query(
      `SELECT id FROM registry_audit_log
       WHERE workos_user_id = $1 AND resource_id = $2 AND action = 'brand_house_domain_changed'`,
      ['user_test_admin_audit', TEST_BRAND_DOMAIN],
    );

    expect(audit.rows).toHaveLength(0);
  });

  it('falls back to system_brand_registry sentinel when neither prior nor new domain matches a known org', async () => {
    const res = await request(app)
      .patch(`/api/admin/brand-enrichment/brand/${TEST_BRAND_DOMAIN}`)
      .send({ house_domain: 'unknown-domain-no-org.test' });

    expect(res.status).toBe(200);

    const audit = await pool.query<{ workos_organization_id: string }>(
      `SELECT workos_organization_id FROM registry_audit_log
       WHERE workos_user_id = $1 AND resource_id = $2`,
      ['user_test_admin_audit', TEST_BRAND_DOMAIN],
    );

    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].workos_organization_id).toBe('system_brand_registry');
  });

  it('writes audit row clearing house_domain to null', async () => {
    await pool.query(
      'UPDATE brands SET house_domain = $1 WHERE domain = $2',
      [TEST_PARENT_DOMAIN, TEST_BRAND_DOMAIN],
    );

    const res = await request(app)
      .patch(`/api/admin/brand-enrichment/brand/${TEST_BRAND_DOMAIN}`)
      .send({ house_domain: '' });

    expect(res.status).toBe(200);

    const audit = await pool.query<{ details: Record<string, unknown> }>(
      `SELECT details FROM registry_audit_log
       WHERE workos_user_id = $1 AND resource_id = $2 AND action = 'brand_house_domain_changed'`,
      ['user_test_admin_audit', TEST_BRAND_DOMAIN],
    );

    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].details).toMatchObject({
      prior_house_domain: TEST_PARENT_DOMAIN,
      new_house_domain: null,
    });
  });
});
