/**
 * Pins the at-write contract of OrganizationDatabase.ensureOrganizationExists.
 *
 * Before this PR, the method created a local org row with only id+name —
 * any WorkOS domains attached to the org were never mirrored into
 * organization_domains and email_domain stayed NULL. Result: rows created
 * via this lazy-login path were invisible to findPayingOrgForDomain,
 * findClaimableProspectOrgForDomain, and resolveOrgByDomain — the same
 * orphan class Migration 481 backfilled for legacy data.
 *
 * The contract now: every domain WorkOS reports gets a corresponding
 * organization_domains row, and email_domain is seeded from the first
 * verified domain (falling back to the first listed).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { OrganizationDatabase } from '../../src/db/organization-db.js';
import type { Pool } from 'pg';
import type { WorkOS } from '@workos-inc/node';

const ORG_FRESH = 'org_ensure_fresh_test';
const ORG_NO_DOMAINS = 'org_ensure_nodomains_test';
const ORG_PENDING_ONLY = 'org_ensure_pendingonly_test';
const ORG_EXISTING = 'org_ensure_existing_test';
const ORG_DOMAIN_INCUMBENT = 'org_ensure_incumbent_test';
const ORG_DOMAIN_CHALLENGER = 'org_ensure_challenger_test';

const TEST_ORGS = [
  ORG_FRESH,
  ORG_NO_DOMAINS,
  ORG_PENDING_ONLY,
  ORG_EXISTING,
  ORG_DOMAIN_INCUMBENT,
  ORG_DOMAIN_CHALLENGER,
];

async function cleanup(pool: Pool) {
  await pool.query('DELETE FROM organization_domains WHERE workos_organization_id = ANY($1)', [TEST_ORGS]);
  await pool.query('DELETE FROM organizations WHERE workos_organization_id = ANY($1)', [TEST_ORGS]);
}

function fakeWorkos(orgId: string, name: string, domains: Array<{ domain: string; state: 'verified' | 'pending' }>): WorkOS {
  return {
    organizations: {
      getOrganization: vi.fn().mockResolvedValue({ id: orgId, name, domains }),
    },
  } as unknown as WorkOS;
}

async function readOrg(pool: Pool, orgId: string) {
  const r = await pool.query<{ email_domain: string | null; name: string }>(
    'SELECT email_domain, name FROM organizations WHERE workos_organization_id = $1',
    [orgId],
  );
  return r.rows[0] ?? null;
}

async function readDomains(pool: Pool, orgId: string) {
  const r = await pool.query<{ domain: string; is_primary: boolean; verified: boolean; source: string }>(
    `SELECT domain, is_primary, verified, source
       FROM organization_domains
       WHERE workos_organization_id = $1
       ORDER BY domain`,
    [orgId],
  );
  return r.rows;
}

describe('OrganizationDatabase.ensureOrganizationExists', () => {
  let pool: Pool;
  let orgDb: OrganizationDatabase;

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString:
        process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:5432/adcp_test',
    });
    await runMigrations();
    orgDb = new OrganizationDatabase();
  }, 60000);

  afterAll(async () => {
    await cleanup(pool);
    await closeDatabase();
  });

  beforeEach(async () => {
    await cleanup(pool);
  });

  it('mirrors WorkOS verified domains into organization_domains and seeds email_domain', async () => {
    const workos = fakeWorkos(ORG_FRESH, 'Fresh Co', [
      { domain: 'fresh.test', state: 'verified' },
    ]);

    await orgDb.ensureOrganizationExists(workos, ORG_FRESH);

    expect((await readOrg(pool, ORG_FRESH))?.email_domain).toBe('fresh.test');
    const domains = await readDomains(pool, ORG_FRESH);
    expect(domains).toHaveLength(1);
    expect(domains[0]).toMatchObject({
      domain: 'fresh.test',
      is_primary: true,
      verified: true,
      source: 'workos',
    });
  });

  it('creates the row even when WorkOS reports no domains', async () => {
    const workos = fakeWorkos(ORG_NO_DOMAINS, 'No Domains Co', []);

    await orgDb.ensureOrganizationExists(workos, ORG_NO_DOMAINS);

    const org = await readOrg(pool, ORG_NO_DOMAINS);
    expect(org?.name).toBe('No Domains Co');
    expect(org?.email_domain).toBeNull();
    expect(await readDomains(pool, ORG_NO_DOMAINS)).toHaveLength(0);
  });

  it('mirrors only verified domains; pending domains are skipped (no DNS proof)', async () => {
    const workos = fakeWorkos(ORG_FRESH, 'Mixed Co', [
      { domain: 'pending-first.test', state: 'pending' },
      { domain: 'verified-second.test', state: 'verified' },
    ]);

    await orgDb.ensureOrganizationExists(workos, ORG_FRESH);

    expect((await readOrg(pool, ORG_FRESH))?.email_domain).toBe('verified-second.test');
    const domains = await readDomains(pool, ORG_FRESH);
    expect(domains).toHaveLength(1);
    expect(domains[0]).toMatchObject({
      domain: 'verified-second.test',
      is_primary: true,
      verified: true,
    });
  });

  it('creates the row with NULL email_domain when WorkOS reports only pending domains', async () => {
    // Pending domains are never trust-bearing — a user could submit
    // `gmail.com` as pending on their org. We let the WorkOS-webhook-driven
    // syncOrganizationDomains pick them up once DNS-verified, never the
    // lazy-login path.
    const workos = fakeWorkos(ORG_PENDING_ONLY, 'Pending Co', [
      { domain: 'first-pending.test', state: 'pending' },
    ]);

    await orgDb.ensureOrganizationExists(workos, ORG_PENDING_ONLY);

    expect((await readOrg(pool, ORG_PENDING_ONLY))?.email_domain).toBeNull();
    expect(await readDomains(pool, ORG_PENDING_ONLY)).toHaveLength(0);
  });

  it('transfers a verified-domain row across orgs (WorkOS-authoritative trust model)', async () => {
    // upsertWorkosDomain transfers ownership on conflict because WorkOS is
    // the DNS-proof-of-control source of truth. If WorkOS attests Org B owns
    // a domain previously held by Org A, the row flips. Pin this behavior so
    // it's a conscious choice, not a regression — the only path that reaches
    // here is auth-gated and the WorkOS getOrganization call returns
    // verified=true only after DNS proof.
    await pool.query(
      `INSERT INTO organizations (workos_organization_id, name, is_personal, email_domain, created_at, updated_at)
       VALUES ($1, $2, false, $3, NOW(), NOW())`,
      [ORG_DOMAIN_INCUMBENT, 'Incumbent', 'shared.test'],
    );
    await pool.query(
      `INSERT INTO organization_domains
         (workos_organization_id, domain, is_primary, verified, source, created_at, updated_at)
       VALUES ($1, 'shared.test', TRUE, TRUE, 'workos', NOW(), NOW())`,
      [ORG_DOMAIN_INCUMBENT],
    );

    const workos = fakeWorkos(ORG_DOMAIN_CHALLENGER, 'Challenger', [
      { domain: 'shared.test', state: 'verified' },
    ]);

    await orgDb.ensureOrganizationExists(workos, ORG_DOMAIN_CHALLENGER);

    const r = await pool.query<{ workos_organization_id: string }>(
      `SELECT workos_organization_id FROM organization_domains WHERE domain = 'shared.test'`,
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].workos_organization_id).toBe(ORG_DOMAIN_CHALLENGER);
  });

  it('is a no-op when the org row already exists', async () => {
    await pool.query(
      `INSERT INTO organizations (workos_organization_id, name, is_personal, email_domain, created_at, updated_at)
       VALUES ($1, $2, false, $3, NOW(), NOW())`,
      [ORG_EXISTING, 'Already Here', 'already.test'],
    );

    const workos = fakeWorkos(ORG_EXISTING, 'Different Name', [
      { domain: 'shouldnotappear.test', state: 'verified' },
    ]);

    const result = await orgDb.ensureOrganizationExists(workos, ORG_EXISTING);
    expect(result.name).toBe('Already Here');
    expect((await readOrg(pool, ORG_EXISTING))?.email_domain).toBe('already.test');
    expect(await readDomains(pool, ORG_EXISTING)).toHaveLength(0);
    // Ensure WorkOS was not even consulted on the no-op path
    expect((workos.organizations.getOrganization as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });
});
