/**
 * Regression test for #4448 follow-up: the WorkOS `organization.updated`
 * webhook handler (`syncOrganizationDomains`) used to set
 * `organizations.email_domain` from `org.domains[0]`. WorkOS's domain-array
 * order is not stable — an org with a verified root and a `failed` www
 * variant can have WorkOS list www first, which would overwrite the
 * correct email_domain on every webhook fire even though our
 * `organization_domains.is_primary=true` row was already pointing at the
 * root. Scope3 caught this in prod (escalation #334 follow-up): WorkOS
 * had `[www.scope3.com (failed), scope3.com (verified)]` but our DB had
 * `scope3.com is_primary=true` — `email_domain` was drifting to www on
 * every webhook.
 *
 * Fix: source `email_domain` from `organization_domains.is_primary=true`
 * (the canonical brand-primary), falling back to `org.domains[0]` only on
 * initial sync.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { initializeDatabase, closeDatabase, getPool } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { syncOrganizationDomains } from '../../src/routes/workos-webhooks.js';
import type { Pool } from 'pg';

const TEST_ORG = 'org_wkos_sync_email_test';

async function cleanup(pool: Pool) {
  await pool.query('DELETE FROM organization_domains WHERE workos_organization_id = $1', [TEST_ORG]);
  await pool.query('DELETE FROM brands WHERE domain LIKE $1', ['wkos-sync-email-%.test']);
  await pool.query('DELETE FROM organizations WHERE workos_organization_id = $1', [TEST_ORG]);
}

async function seedOrg(pool: Pool, isPersonal = false) {
  await pool.query(
    `INSERT INTO organizations (workos_organization_id, name, is_personal, created_at, updated_at)
     VALUES ($1, $2, $3, NOW(), NOW())
     ON CONFLICT (workos_organization_id) DO UPDATE SET is_personal = EXCLUDED.is_personal`,
    [TEST_ORG, 'Sync Email Domain Test Co', isPersonal],
  );
}

describe('syncOrganizationDomains email_domain sourcing', () => {
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

  it('does NOT overwrite email_domain when WorkOS lists a non-primary domain first', async () => {
    // Mimic Scope3: our DB has the root is_primary=true; WorkOS has the
    // www variant first in the array (often because it was added earlier
    // and never reordered after the root was verified).
    await pool.query(
      `INSERT INTO organization_domains (workos_organization_id, domain, is_primary, verified, source, created_at, updated_at)
       VALUES
         ($1, 'wkos-sync-email-root.test', true,  true,  'workos', NOW(), NOW()),
         ($1, 'wkos-sync-email-www.test',  false, false, 'workos', NOW(), NOW())`,
      [TEST_ORG],
    );

    await syncOrganizationDomains({
      id: TEST_ORG,
      name: 'Sync Email Domain Test Co',
      domains: [
        { domain: 'wkos-sync-email-www.test', state: 'pending' }, // WorkOS-order-first, but NOT primary in our table
        { domain: 'wkos-sync-email-root.test', state: 'verified' },
      ],
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-05-12T00:00:00Z',
    });

    const org = await pool.query<{ email_domain: string | null }>(
      `SELECT email_domain FROM organizations WHERE workos_organization_id = $1`,
      [TEST_ORG],
    );
    expect(org.rows[0].email_domain).toBe('wkos-sync-email-root.test');
  });

  it('initial sync (no is_primary row yet) falls back to org.domains[0]', async () => {
    // Cold start: no organization_domains rows exist. The upsert loop
    // inside the function inserts both, and the first one (i===0) is
    // upserted with isPrimary=true — so by the time the email_domain
    // UPDATE runs, the SELECT finds a primary row. Either way, the
    // initial-sync expectation is that email_domain matches org.domains[0].
    await syncOrganizationDomains({
      id: TEST_ORG,
      name: 'Sync Email Domain Test Co',
      domains: [
        { domain: 'wkos-sync-email-cold.test', state: 'verified' },
      ],
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-05-12T00:00:00Z',
    });

    const org = await pool.query<{ email_domain: string | null }>(
      `SELECT email_domain FROM organizations WHERE workos_organization_id = $1`,
      [TEST_ORG],
    );
    expect(org.rows[0].email_domain).toBe('wkos-sync-email-cold.test');
  });

  it('personal orgs do not touch email_domain', async () => {
    await cleanup(pool);
    await seedOrg(pool, /* isPersonal */ true);

    await syncOrganizationDomains({
      id: TEST_ORG,
      name: 'Sync Email Domain Test Co',
      domains: [
        { domain: 'wkos-sync-email-personal.test', state: 'verified' },
      ],
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-05-12T00:00:00Z',
    });

    const org = await pool.query<{ email_domain: string | null }>(
      `SELECT email_domain FROM organizations WHERE workos_organization_id = $1`,
      [TEST_ORG],
    );
    expect(org.rows[0].email_domain).toBeNull();
  });
});
