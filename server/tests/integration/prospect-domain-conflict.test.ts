/**
 * Pins the conflict-handling behavior in `createProspect` (#4321):
 * when a domain row already exists for a different org, the prospect
 * insert must NOT transfer ownership. After #4159 Stage 2,
 * `organization_domains.is_primary` drives brand identity, so a stray
 * `ON CONFLICT DO UPDATE SET workos_organization_id = EXCLUDED...` would
 * silently move the brand-identity primary across orgs.
 *
 * Two layers of defense:
 *   1. Pre-check at `resolveOrgByDomain` rejects callers whose domain is
 *      already linked. This is the primary path users hit.
 *   2. INSERT-level `ON CONFLICT (domain) DO NOTHING`. Catches races and
 *      alias-resolution misses where the pre-check returns null but the
 *      domain row already exists.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

const {
  EXISTING_ORG_ID,
  PROSPECT_ORG_ID,
  TAKEN_DOMAIN,
  FRESH_DOMAIN,
  RACE_DOMAIN,
  CONTACT_DOMAIN,
  UPDATE_DOMAIN,
  mockCreateOrganization,
  mockResolveOrgByDomain,
} = vi.hoisted(() => {
  process.env.WORKOS_API_KEY ||= 'sk_test_dummy_for_unit_tests';
  process.env.WORKOS_CLIENT_ID ||= 'client_test_dummy_for_unit_tests';
  return {
    EXISTING_ORG_ID: 'org_prospect_conflict_existing',
    PROSPECT_ORG_ID: 'org_prospect_conflict_new',
    TAKEN_DOMAIN: 'taken-by-original.test',
    FRESH_DOMAIN: 'fresh-domain-for-prospect.test',
    RACE_DOMAIN: 'race-conflict.test',
    CONTACT_DOMAIN: 'contact-only-prospect.test',
    UPDATE_DOMAIN: 'updated-prospect-domain.test',
    mockCreateOrganization: vi.fn(),
    mockResolveOrgByDomain: vi.fn(),
  };
});

vi.mock('@workos-inc/node', async () => {
  const actual = await vi.importActual<typeof import('@workos-inc/node')>('@workos-inc/node');
  return {
    ...actual,
    WorkOS: class {
      organizations = {
        createOrganization: mockCreateOrganization,
      };
    },
  };
});

vi.mock('../../src/db/domain-resolution-db.js', () => ({
  resolveOrgByDomain: mockResolveOrgByDomain,
}));

vi.mock('../../src/services/brand-enrichment.js', () => ({
  researchDomain: vi.fn().mockResolvedValue(undefined),
  trackBackground: vi.fn(),
}));

vi.mock('../../src/services/enrichment.js', () => ({
  enrichOrganization: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/services/lusha.js', () => ({
  isLushaConfigured: () => false,
}));

import { initializeDatabase, closeDatabase, getPool } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createProspect, updateProspect } from '../../src/services/prospect.js';
import type { Pool } from 'pg';

const TEST_ORGS = [EXISTING_ORG_ID, PROSPECT_ORG_ID];
const TEST_DOMAINS = [TAKEN_DOMAIN, FRESH_DOMAIN, RACE_DOMAIN, CONTACT_DOMAIN, UPDATE_DOMAIN];

async function clearFixtures(pool: Pool) {
  await pool.query('DELETE FROM organization_domains WHERE workos_organization_id = ANY($1)', [TEST_ORGS]);
  await pool.query('DELETE FROM organization_domains WHERE domain = ANY($1)', [TEST_DOMAINS]);
  await pool.query('DELETE FROM organizations WHERE workos_organization_id = ANY($1)', [TEST_ORGS]);
}

async function seedExistingOwner(pool: Pool, domain: string) {
  await pool.query(
    `INSERT INTO organizations (workos_organization_id, name, is_personal, created_at, updated_at)
     VALUES ($1, $2, false, NOW(), NOW())
     ON CONFLICT (workos_organization_id) DO NOTHING`,
    [EXISTING_ORG_ID, 'Original Owner'],
  );
  await pool.query(
    `INSERT INTO organization_domains (workos_organization_id, domain, is_primary, verified, source, created_at, updated_at)
     VALUES ($1, $2, true, true, 'workos', NOW(), NOW())
     ON CONFLICT (domain) DO NOTHING`,
    [EXISTING_ORG_ID, domain],
  );
}

describe('createProspect domain conflict handling (#4321)', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString:
        process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:5432/adcp_test',
    });
    await runMigrations();
  });

  afterAll(async () => {
    await clearFixtures(pool);
    await closeDatabase();
  });

  beforeEach(async () => {
    await clearFixtures(pool);
    mockCreateOrganization.mockReset();
    mockCreateOrganization.mockResolvedValue({
      id: PROSPECT_ORG_ID,
      name: 'New Prospect',
    });
    mockResolveOrgByDomain.mockReset();
    mockResolveOrgByDomain.mockResolvedValue(null);
  });

  it('pre-check rejects when domain is already linked to another org', async () => {
    await seedExistingOwner(pool, TAKEN_DOMAIN);

    // The real resolver would catch this — restore real behavior for one call.
    mockResolveOrgByDomain.mockResolvedValueOnce({
      orgId: EXISTING_ORG_ID,
      matchedDomain: TAKEN_DOMAIN,
      method: 'exact',
    });

    const result = await createProspect({
      name: 'Some Prospect',
      domain: TAKEN_DOMAIN,
      prospect_source: 'manual',
    });

    expect(result.success).toBe(false);
    expect(result.alreadyExists).toBe(true);

    const row = await pool.query(
      `SELECT workos_organization_id FROM organization_domains WHERE domain = $1`,
      [TAKEN_DOMAIN],
    );
    expect(row.rows[0].workos_organization_id).toBe(EXISTING_ORG_ID);
  });

  it('INSERT-level conflict (race / resolver-miss) does NOT transfer ownership', async () => {
    // Bypass the pre-check (mockResolveOrgByDomain returns null by default)
    // to simulate the race condition: two concurrent createProspect calls
    // for the same domain both passing the pre-check, then one losing the
    // INSERT race. The loser must not steal the winner's row.
    await seedExistingOwner(pool, RACE_DOMAIN);

    const result = await createProspect({
      name: 'New Prospect',
      domain: RACE_DOMAIN,
      prospect_source: 'manual',
    });

    expect(result.success).toBe(false);
    expect(result.alreadyExists).toBe(true);
    expect(result.error).toContain('already linked');

    const row = await pool.query(
      `SELECT workos_organization_id, is_primary, source
         FROM organization_domains WHERE domain = $1`,
      [RACE_DOMAIN],
    );
    expect(row.rowCount).toBe(1);
    expect(row.rows[0].workos_organization_id).toBe(EXISTING_ORG_ID);
    expect(row.rows[0].is_primary).toBe(true);
    expect(row.rows[0].source).toBe('workos');

    // Prospect org was not persisted locally with a conflicting email_domain.
    const prospectDomains = await pool.query(
      `SELECT domain FROM organization_domains WHERE workos_organization_id = $1`,
      [PROSPECT_ORG_ID],
    );
    expect(prospectDomains.rowCount).toBe(0);

    const prospectOrg = await pool.query(
      `SELECT email_domain FROM organizations WHERE workos_organization_id = $1`,
      [PROSPECT_ORG_ID],
    );
    expect(prospectOrg.rowCount).toBe(0);
  });

  it('inserts a new organization_domains row for a fresh domain (no conflict)', async () => {
    const result = await createProspect({
      name: 'New Prospect',
      domain: FRESH_DOMAIN,
      prospect_source: 'manual',
    });

    expect(result.success).toBe(true);

    const row = await pool.query(
      `SELECT workos_organization_id, is_primary, verified, source
         FROM organization_domains WHERE domain = $1`,
      [FRESH_DOMAIN],
    );
    expect(row.rowCount).toBe(1);
    expect(row.rows[0].workos_organization_id).toBe(PROSPECT_ORG_ID);
    expect(row.rows[0].is_primary).toBe(true);
    expect(row.rows[0].verified).toBe(true);
    expect(row.rows[0].source).toBe('import');
  });

  it('infers and verifies the domain from a business contact email when domain is omitted', async () => {
    const result = await createProspect({
      name: 'Contact Only Prospect',
      prospect_contact_email: `buyer@${CONTACT_DOMAIN}`,
      prospect_source: 'inbound',
    });

    expect(result.success).toBe(true);
    expect(mockCreateOrganization).toHaveBeenCalledWith({
      name: 'Contact Only Prospect',
      domainData: [{ domain: CONTACT_DOMAIN, state: 'pending' }],
    });

    const org = await pool.query(
      `SELECT email_domain FROM organizations WHERE workos_organization_id = $1`,
      [PROSPECT_ORG_ID],
    );
    expect(org.rows[0].email_domain).toBe(CONTACT_DOMAIN);

    const row = await pool.query(
      `SELECT workos_organization_id, is_primary, verified, source
         FROM organization_domains WHERE domain = $1`,
      [CONTACT_DOMAIN],
    );
    expect(row.rowCount).toBe(1);
    expect(row.rows[0]).toMatchObject({
      workos_organization_id: PROSPECT_ORG_ID,
      is_primary: true,
      verified: false,
      source: 'backfill_prospect_contact',
    });
  });

  it('rejects prospect creation when neither a domain nor business contact email is present', async () => {
    const result = await createProspect({
      name: 'No Domain Prospect',
      prospect_source: 'manual',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('business domain');
    expect(mockCreateOrganization).not.toHaveBeenCalled();
  });

  it('mirrors admin email_domain updates into a verified primary organization_domains row', async () => {
    await pool.query(
      `INSERT INTO organizations (workos_organization_id, name, is_personal, created_at, updated_at)
       VALUES ($1, $2, false, NOW(), NOW())`,
      [PROSPECT_ORG_ID, 'Update Domain Prospect'],
    );

    const result = await updateProspect(PROSPECT_ORG_ID, {
      fields: { email_domain: UPDATE_DOMAIN },
    });

    expect(result.success).toBe(true);
    expect(result.updated?.email_domain).toBe(UPDATE_DOMAIN);

    const row = await pool.query(
      `SELECT workos_organization_id, is_primary, verified, source
         FROM organization_domains WHERE domain = $1`,
      [UPDATE_DOMAIN],
    );
    expect(row.rowCount).toBe(1);
    expect(row.rows[0]).toMatchObject({
      workos_organization_id: PROSPECT_ORG_ID,
      is_primary: true,
      verified: true,
      source: 'admin_discovery',
    });
  });
});
