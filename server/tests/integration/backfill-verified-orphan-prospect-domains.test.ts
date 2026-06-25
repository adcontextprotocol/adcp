/**
 * Integration test for migration 521: repair fresh orphan prospects by
 * backfilling an unverified primary organization_domains row from the original
 * inbound/slack triage decision or a business contact email.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { findClaimableProspectOrgForDomain } from '../../src/db/org-filters.js';
import type { Pool } from 'pg';

const ORG_TRIAGE = 'org_521_triage_orphan_test';
const ORG_CONTACT = 'org_521_contact_orphan_test';
const ORG_CONFLICT = 'org_521_conflict_orphan_test';
const ORG_OWNER = 'org_521_owner_test';
const ORG_FREE = 'org_521_free_test';

const TEST_ORGS = [ORG_TRIAGE, ORG_CONTACT, ORG_CONFLICT, ORG_OWNER, ORG_FREE];
const TEST_DOMAINS = [
  'triage-orphan.test',
  'contact-orphan.test',
  'already-owned-521.test',
  'gmail.com',
  'uol.com.br',
];

const MIGRATION_SQL = readFileSync(
  resolve(__dirname, '../../src/db/migrations/521_backfill_verified_orphan_prospect_domains.sql'),
  'utf8',
);

async function cleanup(pool: Pool) {
  await pool.query('DELETE FROM prospect_triage_log WHERE domain = ANY($1)', [TEST_DOMAINS]);
  await pool.query('DELETE FROM organization_domains WHERE workos_organization_id = ANY($1)', [TEST_ORGS]);
  await pool.query('DELETE FROM organization_domains WHERE domain = ANY($1)', [TEST_DOMAINS]);
  await pool.query('DELETE FROM organizations WHERE workos_organization_id = ANY($1)', [TEST_ORGS]);
}

async function seedOrg(
  pool: Pool,
  orgId: string,
  opts: {
    name?: string;
    prospect_source?: string | null;
    prospect_contact_email?: string | null;
    email_domain?: string | null;
  } = {},
) {
  await pool.query(
    `INSERT INTO organizations (
       workos_organization_id, name, is_personal, email_domain,
       prospect_source, prospect_contact_email, created_at, updated_at
     ) VALUES ($1, $2, false, $3, $4, $5, NOW(), NOW())`,
    [
      orgId,
      opts.name ?? `Org ${orgId}`,
      opts.email_domain ?? null,
      opts.prospect_source ?? 'inbound',
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

async function seedTriageLog(pool: Pool, opts: { domain: string; company_name: string; source?: string }) {
  await pool.query(
    `INSERT INTO prospect_triage_log
       (domain, action, reason, owner, priority, verdict, company_name, source, enriched, created_at)
     VALUES ($1, 'create', 'test', 'human', 'standard', 'test', $2, $3, false, NOW())`,
    [opts.domain, opts.company_name, opts.source ?? 'inbound'],
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

describe('migration 521: backfill orphan prospect domains', () => {
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

  it('backfills an unverified primary domain row from a matching inbound triage log', async () => {
    await seedOrg(pool, ORG_TRIAGE, { name: 'Triage Prospect', prospect_source: 'inbound' });
    await seedTriageLog(pool, {
      company_name: 'Triage Prospect',
      domain: 'triage-orphan.test',
      source: 'inbound',
    });

    await pool.query(MIGRATION_SQL);

    expect((await readOrg(pool, ORG_TRIAGE))?.email_domain).toBe('triage-orphan.test');
    expect(await readDomains(pool, ORG_TRIAGE)).toEqual([
      {
        domain: 'triage-orphan.test',
        is_primary: true,
        verified: false,
        source: 'backfill_prospect_contact',
      },
    ]);
    expect((await findClaimableProspectOrgForDomain('triage-orphan.test'))?.organization_id).toBe(ORG_TRIAGE);
  });

  it('prefers a business contact email domain when present', async () => {
    await seedOrg(pool, ORG_CONTACT, {
      name: 'Contact Prospect',
      prospect_source: 'inbound',
      prospect_contact_email: 'buyer@contact-orphan.test',
    });
    await seedTriageLog(pool, {
      company_name: 'Contact Prospect',
      domain: 'triage-orphan.test',
      source: 'inbound',
    });

    await pool.query(MIGRATION_SQL);

    expect((await readOrg(pool, ORG_CONTACT))?.email_domain).toBe('contact-orphan.test');
    const domains = await readDomains(pool, ORG_CONTACT);
    expect(domains).toHaveLength(1);
    expect(domains[0]).toMatchObject({
      domain: 'contact-orphan.test',
      verified: false,
      source: 'backfill_prospect_contact',
    });
  });

  it('does not steal a domain already owned by another organization', async () => {
    await seedOrg(pool, ORG_OWNER, {
      name: 'Existing Owner',
      email_domain: 'already-owned-521.test',
      prospect_source: null,
    });
    await seedDomain(pool, ORG_OWNER, 'already-owned-521.test');

    await seedOrg(pool, ORG_CONFLICT, { name: 'Conflicting Prospect', prospect_source: 'inbound' });
    await seedTriageLog(pool, {
      company_name: 'Conflicting Prospect',
      domain: 'already-owned-521.test',
      source: 'inbound',
    });

    await pool.query(MIGRATION_SQL);

    expect((await readOrg(pool, ORG_CONFLICT))?.email_domain).toBeNull();
    expect(await readDomains(pool, ORG_CONFLICT)).toHaveLength(0);
    expect((await readOrg(pool, ORG_OWNER))?.email_domain).toBe('already-owned-521.test');
  });

  it('skips free-email domains from triage logs', async () => {
    await seedOrg(pool, ORG_FREE, { name: 'Free Email Prospect', prospect_source: 'inbound' });
    await seedTriageLog(pool, {
      company_name: 'Free Email Prospect',
      domain: 'uol.com.br',
      source: 'inbound',
    });

    await pool.query(MIGRATION_SQL);

    expect((await readOrg(pool, ORG_FREE))?.email_domain).toBeNull();
    expect(await readDomains(pool, ORG_FREE)).toHaveLength(0);
  });

  it('falls back to the triage domain when the contact email domain is a public mailbox', async () => {
    await seedOrg(pool, ORG_CONTACT, {
      name: 'Mailbox Contact Prospect',
      prospect_source: 'inbound',
      prospect_contact_email: 'luiz@uol.com.br',
    });
    await seedTriageLog(pool, {
      company_name: 'Mailbox Contact Prospect',
      domain: 'contact-orphan.test',
      source: 'inbound',
    });

    await pool.query(MIGRATION_SQL);

    expect((await readOrg(pool, ORG_CONTACT))?.email_domain).toBe('contact-orphan.test');
    const domains = await readDomains(pool, ORG_CONTACT);
    expect(domains).toHaveLength(1);
    expect(domains[0]).toMatchObject({
      domain: 'contact-orphan.test',
      verified: false,
      source: 'backfill_prospect_contact',
    });
  });
});
