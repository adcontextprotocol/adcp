/**
 * Integration test for migration 468: backfill organizations.email_domain
 * from organization_domains.
 *
 * Migration 468 has already run by the time this test seeds, so we re-execute
 * its body against the seeded fixtures. This verifies the SQL the migration
 * actually shipped, not a paraphrase.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import type { Pool } from 'pg';

const ORG_PROSPECT = 'org_backfill_prospect_test';
const ORG_PERSONAL = 'org_backfill_personal_test';
const ORG_NO_DOMAINS = 'org_backfill_nodomains_test';
const ORG_ALREADY_FILLED = 'org_backfill_filled_test';
const ORG_MULTI_DOMAIN = 'org_backfill_multi_test';

const TEST_ORGS = [ORG_PROSPECT, ORG_PERSONAL, ORG_NO_DOMAINS, ORG_ALREADY_FILLED, ORG_MULTI_DOMAIN];

const MIGRATION_SQL = readFileSync(
  resolve(__dirname, '../../src/db/migrations/468_backfill_org_email_domain.sql'),
  'utf8',
);

async function cleanup(pool: Pool) {
  await pool.query('DELETE FROM organization_domains WHERE workos_organization_id = ANY($1)', [TEST_ORGS]);
  await pool.query('DELETE FROM organizations WHERE workos_organization_id = ANY($1)', [TEST_ORGS]);
}

async function seedOrg(
  pool: Pool,
  orgId: string,
  opts: { is_personal?: boolean; email_domain?: string | null } = {},
) {
  await pool.query(
    `INSERT INTO organizations (workos_organization_id, name, is_personal, email_domain, created_at, updated_at)
     VALUES ($1, $2, $3, $4, NOW(), NOW())
     ON CONFLICT (workos_organization_id) DO UPDATE
       SET is_personal = EXCLUDED.is_personal,
           email_domain = EXCLUDED.email_domain`,
    [orgId, `Org ${orgId}`, opts.is_personal ?? false, opts.email_domain ?? null],
  );
}

async function seedDomain(
  pool: Pool,
  orgId: string,
  domain: string,
  opts: { is_primary?: boolean; verified?: boolean; created_at?: string } = {},
) {
  await pool.query(
    `INSERT INTO organization_domains (workos_organization_id, domain, is_primary, verified, source, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'workos', COALESCE($5::timestamptz, NOW()), NOW())
     ON CONFLICT (domain) DO UPDATE
       SET is_primary = EXCLUDED.is_primary,
           verified = EXCLUDED.verified,
           workos_organization_id = $1`,
    [orgId, domain, opts.is_primary ?? false, opts.verified ?? false, opts.created_at ?? null],
  );
}

async function getEmailDomain(pool: Pool, orgId: string): Promise<string | null> {
  const r = await pool.query<{ email_domain: string | null }>(
    'SELECT email_domain FROM organizations WHERE workos_organization_id = $1',
    [orgId],
  );
  return r.rows[0]?.email_domain ?? null;
}

describe('migration 468: backfill org email_domain', () => {
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
  });

  it('fills email_domain on a non-personal org from its single organization_domains row', async () => {
    await seedOrg(pool, ORG_PROSPECT, { is_personal: false, email_domain: null });
    await seedDomain(pool, ORG_PROSPECT, 'voisetech.test', { is_primary: true, verified: true });

    await pool.query(MIGRATION_SQL);

    expect(await getEmailDomain(pool, ORG_PROSPECT)).toBe('voisetech.test');
  });

  it('skips personal orgs even when they have an organization_domains row', async () => {
    await seedOrg(pool, ORG_PERSONAL, { is_personal: true, email_domain: null });
    await seedDomain(pool, ORG_PERSONAL, 'individual.test', { is_primary: true, verified: true });

    await pool.query(MIGRATION_SQL);

    expect(await getEmailDomain(pool, ORG_PERSONAL)).toBeNull();
  });

  it('leaves orgs with no organization_domains rows untouched (NULL stays NULL)', async () => {
    await seedOrg(pool, ORG_NO_DOMAINS, { is_personal: false, email_domain: null });

    await pool.query(MIGRATION_SQL);

    expect(await getEmailDomain(pool, ORG_NO_DOMAINS)).toBeNull();
  });

  it('does not overwrite an already-populated email_domain', async () => {
    await seedOrg(pool, ORG_ALREADY_FILLED, { is_personal: false, email_domain: 'existing.test' });
    await seedDomain(pool, ORG_ALREADY_FILLED, 'different.test', { is_primary: true, verified: true });

    await pool.query(MIGRATION_SQL);

    expect(await getEmailDomain(pool, ORG_ALREADY_FILLED)).toBe('existing.test');
  });

  it('prefers is_primary=true over verified=true over oldest when multiple domains exist', async () => {
    await seedOrg(pool, ORG_MULTI_DOMAIN, { is_personal: false, email_domain: null });
    // Oldest, verified, but NOT primary
    await seedDomain(pool, ORG_MULTI_DOMAIN, 'old-verified.test', {
      is_primary: false, verified: true, created_at: '2020-01-01T00:00:00Z',
    });
    // Newer, primary, NOT verified — should still win on is_primary
    await seedDomain(pool, ORG_MULTI_DOMAIN, 'newer-primary.test', {
      is_primary: true, verified: false, created_at: '2024-01-01T00:00:00Z',
    });

    await pool.query(MIGRATION_SQL);

    expect(await getEmailDomain(pool, ORG_MULTI_DOMAIN)).toBe('newer-primary.test');
  });

  it('is idempotent — second run does not change anything', async () => {
    await seedOrg(pool, ORG_PROSPECT, { is_personal: false, email_domain: null });
    await seedDomain(pool, ORG_PROSPECT, 'voisetech.test', { is_primary: true, verified: true });

    await pool.query(MIGRATION_SQL);
    const first = await getEmailDomain(pool, ORG_PROSPECT);
    await pool.query(MIGRATION_SQL);
    const second = await getEmailDomain(pool, ORG_PROSPECT);

    expect(first).toBe('voisetech.test');
    expect(second).toBe('voisetech.test');
  });
});
