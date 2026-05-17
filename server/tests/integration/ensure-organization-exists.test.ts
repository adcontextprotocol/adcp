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

const TEST_ORGS = [ORG_FRESH, ORG_NO_DOMAINS, ORG_PENDING_ONLY, ORG_EXISTING];

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

  it('prefers verified over pending when picking the primary email_domain', async () => {
    const workos = fakeWorkos(ORG_FRESH, 'Mixed Co', [
      { domain: 'pending-first.test', state: 'pending' },
      { domain: 'verified-second.test', state: 'verified' },
    ]);

    await orgDb.ensureOrganizationExists(workos, ORG_FRESH);

    expect((await readOrg(pool, ORG_FRESH))?.email_domain).toBe('verified-second.test');
    const domains = await readDomains(pool, ORG_FRESH);
    expect(domains).toHaveLength(2);
    const primary = domains.find((d) => d.is_primary);
    expect(primary?.domain).toBe('verified-second.test');
    expect(primary?.verified).toBe(true);
    const pending = domains.find((d) => !d.is_primary);
    expect(pending?.domain).toBe('pending-first.test');
    expect(pending?.verified).toBe(false);
  });

  it('falls back to the first listed domain when none are verified', async () => {
    const workos = fakeWorkos(ORG_PENDING_ONLY, 'Pending Co', [
      { domain: 'first-pending.test', state: 'pending' },
    ]);

    await orgDb.ensureOrganizationExists(workos, ORG_PENDING_ONLY);

    expect((await readOrg(pool, ORG_PENDING_ONLY))?.email_domain).toBe('first-pending.test');
    const domains = await readDomains(pool, ORG_PENDING_ONLY);
    expect(domains[0]).toMatchObject({
      domain: 'first-pending.test',
      is_primary: true,
      verified: false,
    });
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
