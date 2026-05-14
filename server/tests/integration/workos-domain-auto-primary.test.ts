/**
 * Integration tests for the WorkOS verified-domain → organization_domains
 * auto-promote path. When WorkOS marks a non-personal-org domain verified
 * and no other is_primary row exists, the row gets is_primary=true and
 * `organizations.email_domain` is updated in the same transaction.
 *
 * Driver: Media.net escalation (2026-05-06). Members with a single
 * WorkOS-verified domain were missing brand-primary on a separate column,
 * blocking publish-agent. After Stage 2 of #4159, organization_domains.is_primary
 * is the single source of truth for both org-membership inference and
 * brand identity, so the auto-promote here covers the publish-agent gate too.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { upsertOrganizationDomain } from '../../src/routes/workos-webhooks.js';
import type { Pool } from 'pg';

const TEST_ORG = 'org_wkos_brand_primary_test';

async function cleanup(pool: Pool) {
  await pool.query('DELETE FROM organization_domains WHERE workos_organization_id = $1', [TEST_ORG]);
  await pool.query('DELETE FROM brands WHERE domain LIKE $1', ['wkos-brand-primary-%.test']);
  await pool.query('DELETE FROM organizations WHERE workos_organization_id = $1', [TEST_ORG]);
}

async function seedOrg(pool: Pool, isPersonal: boolean = false) {
  await pool.query(
    `INSERT INTO organizations (workos_organization_id, name, is_personal, created_at, updated_at)
     VALUES ($1, $2, $3, NOW(), NOW())
     ON CONFLICT (workos_organization_id) DO UPDATE SET is_personal = EXCLUDED.is_personal`,
    [TEST_ORG, 'Auto-Primary Test Co', isPersonal],
  );
}

describe('WorkOS verified-domain → organization_domains.is_primary auto-promote', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString: process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:5432/adcp_test',
    });
    await runMigrations();
  }, 60000);

  afterAll(async () => {
    await cleanup(pool);
    await closeDatabase();
  });

  beforeEach(async () => {
    await cleanup(pool);
    await seedOrg(pool);
  });

  it('promotes a verified domain to is_primary when no other primary exists', async () => {
    await upsertOrganizationDomain({
      id: 'od_test_1',
      organization_id: TEST_ORG,
      domain: 'wkos-brand-primary-1.test',
      state: 'verified',
    });

    const row = await pool.query<{ is_primary: boolean }>(
      `SELECT is_primary FROM organization_domains
        WHERE workos_organization_id = $1 AND domain = $2`,
      [TEST_ORG, 'wkos-brand-primary-1.test'],
    );
    expect(row.rows[0].is_primary).toBe(true);

    const org = await pool.query<{ email_domain: string | null }>(
      `SELECT email_domain FROM organizations WHERE workos_organization_id = $1`,
      [TEST_ORG],
    );
    expect(org.rows[0].email_domain).toBe('wkos-brand-primary-1.test');
  });

  it('does NOT clobber an existing is_primary row', async () => {
    await pool.query(
      `INSERT INTO organization_domains (workos_organization_id, domain, verified, is_primary, source, created_at, updated_at)
       VALUES ($1, 'wkos-brand-primary-claimed.test', true, true, 'workos', NOW(), NOW())`,
      [TEST_ORG],
    );

    await upsertOrganizationDomain({
      id: 'od_test_2',
      organization_id: TEST_ORG,
      domain: 'wkos-brand-primary-different.test',
      state: 'verified',
    });

    const claimed = await pool.query<{ is_primary: boolean }>(
      `SELECT is_primary FROM organization_domains
        WHERE workos_organization_id = $1 AND domain = 'wkos-brand-primary-claimed.test'`,
      [TEST_ORG],
    );
    expect(claimed.rows[0].is_primary).toBe(true);

    const incoming = await pool.query<{ is_primary: boolean }>(
      `SELECT is_primary FROM organization_domains
        WHERE workos_organization_id = $1 AND domain = 'wkos-brand-primary-different.test'`,
      [TEST_ORG],
    );
    expect(incoming.rows[0].is_primary).toBe(false);
  });

  it('does not promote when the domain is pending (not yet verified)', async () => {
    await upsertOrganizationDomain({
      id: 'od_test_3',
      organization_id: TEST_ORG,
      domain: 'wkos-brand-primary-pending.test',
      state: 'pending',
    });

    const row = await pool.query<{ is_primary: boolean }>(
      `SELECT is_primary FROM organization_domains
        WHERE workos_organization_id = $1 AND domain = 'wkos-brand-primary-pending.test'`,
      [TEST_ORG],
    );
    expect(row.rows[0].is_primary).toBe(false);

    const org = await pool.query<{ email_domain: string | null }>(
      `SELECT email_domain FROM organizations WHERE workos_organization_id = $1`,
      [TEST_ORG],
    );
    expect(org.rows[0].email_domain).toBeNull();
  });

  it('does NOT auto-promote for a personal org (squeeze prevention for org-membership inference)', async () => {
    // Personal-tier individual subs shouldn't auto-claim their email
    // domain as the org's primary, because that would inject every
    // signup with that domain into the lone individual's org via
    // membership inference.
    await seedOrg(pool, true);

    await upsertOrganizationDomain({
      id: 'od_test_personal',
      organization_id: TEST_ORG,
      domain: 'wkos-brand-primary-personal.test',
      state: 'verified',
    });

    const row = await pool.query<{ is_primary: boolean }>(
      `SELECT is_primary FROM organization_domains
        WHERE workos_organization_id = $1 AND domain = 'wkos-brand-primary-personal.test'`,
      [TEST_ORG],
    );
    expect(row.rows[0].is_primary).toBe(false);

    const org = await pool.query<{ email_domain: string | null }>(
      `SELECT email_domain FROM organizations WHERE workos_organization_id = $1`,
      [TEST_ORG],
    );
    expect(org.rows[0].email_domain).toBeNull();
  });
});
