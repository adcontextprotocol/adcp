/**
 * Integration test for migration 481: backfill orphaned prospect orgs from
 * prospect_contact_email when neither email_domain nor organization_domains
 * is populated.
 *
 * Real-world driver: org_01KDRZJAK62QV0CW53EEQJWWC2 ("Spotify", 2025-12-30)
 * had prospect_contact_email set but no domain anywhere — Migration 468
 * (organization_domains → email_domain) couldn't help, and findPayingOrg /
 * findClaimableProspectOrg / resolveOrgByDomain all missed the row.
 *
 * Migration 481 has already run by the time vitest seeds, so we re-execute
 * its body against fresh fixtures to verify the SQL the migration actually
 * shipped, not a paraphrase.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import type { Pool } from 'pg';

const ORG_ORPHAN = 'org_481_orphan_test';
const ORG_PERSONAL = 'org_481_personal_test';
const ORG_NO_CONTACT = 'org_481_nocontact_test';
const ORG_FREE_EMAIL = 'org_481_freeemail_test';
const ORG_ALREADY_HAS_DOMAIN_ROW = 'org_481_hasdomain_test';
const ORG_ALREADY_HAS_EMAIL_DOMAIN = 'org_481_hasemail_test';
const ORG_DOMAIN_OWNED_BY_OTHER = 'org_481_conflict_test';
const ORG_DOMAIN_OWNER = 'org_481_owner_test';
const ORG_BAD_EMAIL = 'org_481_bademail_test';

const TEST_ORGS = [
  ORG_ORPHAN,
  ORG_PERSONAL,
  ORG_NO_CONTACT,
  ORG_FREE_EMAIL,
  ORG_ALREADY_HAS_DOMAIN_ROW,
  ORG_ALREADY_HAS_EMAIL_DOMAIN,
  ORG_DOMAIN_OWNED_BY_OTHER,
  ORG_DOMAIN_OWNER,
  ORG_BAD_EMAIL,
];

const MIGRATION_SQL = readFileSync(
  resolve(__dirname, '../../src/db/migrations/481_backfill_orphan_org_from_contact.sql'),
  'utf8',
);

async function cleanup(pool: Pool) {
  await pool.query('DELETE FROM organization_domains WHERE workos_organization_id = ANY($1)', [TEST_ORGS]);
  await pool.query('DELETE FROM organizations WHERE workos_organization_id = ANY($1)', [TEST_ORGS]);
}

async function seedOrg(
  pool: Pool,
  orgId: string,
  opts: {
    is_personal?: boolean;
    email_domain?: string | null;
    prospect_contact_email?: string | null;
  } = {},
) {
  await pool.query(
    `INSERT INTO organizations (
       workos_organization_id, name, is_personal, email_domain,
       prospect_contact_email, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, NOW(), NOW())`,
    [
      orgId,
      `Org ${orgId}`,
      opts.is_personal ?? false,
      opts.email_domain ?? null,
      opts.prospect_contact_email ?? null,
    ],
  );
}

async function seedDomain(pool: Pool, orgId: string, domain: string) {
  await pool.query(
    `INSERT INTO organization_domains
       (workos_organization_id, domain, is_primary, verified, source, created_at, updated_at)
     VALUES ($1, $2, TRUE, TRUE, 'workos', NOW(), NOW())`,
    [orgId, domain],
  );
}

async function readOrg(pool: Pool, orgId: string) {
  const r = await pool.query<{ email_domain: string | null }>(
    'SELECT email_domain FROM organizations WHERE workos_organization_id = $1',
    [orgId],
  );
  return r.rows[0] ?? null;
}

async function readDomains(pool: Pool, orgId: string) {
  const r = await pool.query<{ domain: string; is_primary: boolean; verified: boolean; source: string }>(
    'SELECT domain, is_primary, verified, source FROM organization_domains WHERE workos_organization_id = $1',
    [orgId],
  );
  return r.rows;
}

describe('migration 481: backfill orphan org from prospect_contact_email', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString:
        process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:5432/adcp_test',
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

  it('backfills both email_domain and a non-verified organization_domains row from the contact email', async () => {
    await seedOrg(pool, ORG_ORPHAN, {
      is_personal: false,
      email_domain: null,
      prospect_contact_email: 'chelseag@spotify.test',
    });

    await pool.query(MIGRATION_SQL);

    const org = await readOrg(pool, ORG_ORPHAN);
    expect(org?.email_domain).toBe('spotify.test');

    const domains = await readDomains(pool, ORG_ORPHAN);
    expect(domains).toHaveLength(1);
    expect(domains[0]).toMatchObject({
      domain: 'spotify.test',
      is_primary: true,
      verified: false,
      source: 'backfill_prospect_contact',
    });
  });

  it('skips personal orgs', async () => {
    await seedOrg(pool, ORG_PERSONAL, {
      is_personal: true,
      email_domain: null,
      prospect_contact_email: 'me@personal.test',
    });

    await pool.query(MIGRATION_SQL);

    expect((await readOrg(pool, ORG_PERSONAL))?.email_domain).toBeNull();
    expect(await readDomains(pool, ORG_PERSONAL)).toHaveLength(0);
  });

  it('skips orgs with no prospect_contact_email', async () => {
    await seedOrg(pool, ORG_NO_CONTACT, {
      is_personal: false,
      email_domain: null,
      prospect_contact_email: null,
    });

    await pool.query(MIGRATION_SQL);

    expect((await readOrg(pool, ORG_NO_CONTACT))?.email_domain).toBeNull();
    expect(await readDomains(pool, ORG_NO_CONTACT)).toHaveLength(0);
  });

  it('skips free-email contact domains (gmail.com etc)', async () => {
    await seedOrg(pool, ORG_FREE_EMAIL, {
      is_personal: false,
      email_domain: null,
      prospect_contact_email: 'someone@gmail.com',
    });

    await pool.query(MIGRATION_SQL);

    expect((await readOrg(pool, ORG_FREE_EMAIL))?.email_domain).toBeNull();
    expect(await readDomains(pool, ORG_FREE_EMAIL)).toHaveLength(0);
  });

  it('leaves orgs with an existing organization_domains row alone', async () => {
    await seedOrg(pool, ORG_ALREADY_HAS_DOMAIN_ROW, {
      is_personal: false,
      email_domain: null,
      prospect_contact_email: 'chelseag@spotify.test',
    });
    await seedDomain(pool, ORG_ALREADY_HAS_DOMAIN_ROW, 'preexisting.test');

    await pool.query(MIGRATION_SQL);

    // The migration's WHERE clause excludes orgs with any organization_domains
    // row, so we shouldn't touch email_domain here. Migration 468 owns that.
    expect((await readOrg(pool, ORG_ALREADY_HAS_DOMAIN_ROW))?.email_domain).toBeNull();
    const domains = await readDomains(pool, ORG_ALREADY_HAS_DOMAIN_ROW);
    expect(domains).toHaveLength(1);
    expect(domains[0].domain).toBe('preexisting.test');
  });

  it('does not overwrite an already-populated email_domain', async () => {
    await seedOrg(pool, ORG_ALREADY_HAS_EMAIL_DOMAIN, {
      is_personal: false,
      email_domain: 'existing.test',
      prospect_contact_email: 'someone@otherdomain.test',
    });

    await pool.query(MIGRATION_SQL);

    expect((await readOrg(pool, ORG_ALREADY_HAS_EMAIL_DOMAIN))?.email_domain).toBe('existing.test');
  });

  it('does not steal a domain another org already owns in organization_domains', async () => {
    await seedOrg(pool, ORG_DOMAIN_OWNER, {
      is_personal: false,
      email_domain: 'taken.test',
      prospect_contact_email: null,
    });
    await seedDomain(pool, ORG_DOMAIN_OWNER, 'taken.test');

    await seedOrg(pool, ORG_DOMAIN_OWNED_BY_OTHER, {
      is_personal: false,
      email_domain: null,
      prospect_contact_email: 'newperson@taken.test',
    });

    await pool.query(MIGRATION_SQL);

    expect((await readOrg(pool, ORG_DOMAIN_OWNED_BY_OTHER))?.email_domain).toBeNull();
    expect(await readDomains(pool, ORG_DOMAIN_OWNED_BY_OTHER)).toHaveLength(0);
    // Owner row stays intact
    const ownerDomains = await readDomains(pool, ORG_DOMAIN_OWNER);
    expect(ownerDomains).toHaveLength(1);
    expect(ownerDomains[0].domain).toBe('taken.test');
  });

  it('skips malformed contact emails (no domain after @)', async () => {
    await seedOrg(pool, ORG_BAD_EMAIL, {
      is_personal: false,
      email_domain: null,
      prospect_contact_email: 'notanemail',
    });

    await pool.query(MIGRATION_SQL);

    expect((await readOrg(pool, ORG_BAD_EMAIL))?.email_domain).toBeNull();
    expect(await readDomains(pool, ORG_BAD_EMAIL)).toHaveLength(0);
  });

  it('is idempotent — second run does not change anything', async () => {
    await seedOrg(pool, ORG_ORPHAN, {
      is_personal: false,
      email_domain: null,
      prospect_contact_email: 'chelseag@spotify.test',
    });

    await pool.query(MIGRATION_SQL);
    const firstOrg = await readOrg(pool, ORG_ORPHAN);
    const firstDomains = await readDomains(pool, ORG_ORPHAN);

    await pool.query(MIGRATION_SQL);
    const secondOrg = await readOrg(pool, ORG_ORPHAN);
    const secondDomains = await readDomains(pool, ORG_ORPHAN);

    expect(secondOrg?.email_domain).toBe(firstOrg?.email_domain);
    expect(secondDomains).toEqual(firstDomains);
  });
});
