/**
 * Pins the invariants of the canonical writer module
 * `db/organization-domains-db.ts` (#4159 Stage 3a).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { initializeDatabase, closeDatabase, getPool } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { linkDomain, setPrimaryDomain } from '../../src/db/organization-domains-db.js';
import type { Pool } from 'pg';

const ORG_A = 'org_orgdom_db_a';
const ORG_B = 'org_orgdom_db_b';
const D1 = 'orgdom-db-1.test';
const D2 = 'orgdom-db-2.test';
const D3 = 'orgdom-db-3.test';
const D_TAKEN = 'orgdom-db-taken.test';

const TEST_ORGS = [ORG_A, ORG_B];
const TEST_DOMAINS = [D1, D2, D3, D_TAKEN];

async function clearFixtures(pool: Pool) {
  await pool.query('DELETE FROM organization_domains WHERE workos_organization_id = ANY($1)', [TEST_ORGS]);
  await pool.query('DELETE FROM organization_domains WHERE domain = ANY($1)', [TEST_DOMAINS]);
  await pool.query('DELETE FROM organizations WHERE workos_organization_id = ANY($1)', [TEST_ORGS]);
}

async function seedOrg(pool: Pool, orgId: string) {
  await pool.query(
    `INSERT INTO organizations (workos_organization_id, name, is_personal, created_at, updated_at)
     VALUES ($1, $2, false, NOW(), NOW())
     ON CONFLICT (workos_organization_id) DO NOTHING`,
    [orgId, `Org ${orgId}`],
  );
}

describe('organization-domains-db (#4159 Stage 3a)', () => {
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
    await seedOrg(pool, ORG_A);
    await seedOrg(pool, ORG_B);
  });

  describe('linkDomain', () => {
    it('inserts a row and returns inserted=true', async () => {
      const result = await linkDomain({
        orgId: ORG_A,
        domain: D1,
        source: 'workos',
        verified: true,
        isPrimary: false,
      });

      expect(result).toEqual({ inserted: true, conflictOrgId: null });

      const row = await getPool().query(
        `SELECT workos_organization_id, source, verified, is_primary FROM organization_domains WHERE domain = $1`,
        [D1],
      );
      expect(row.rows[0]).toMatchObject({
        workos_organization_id: ORG_A,
        source: 'workos',
        verified: true,
        is_primary: false,
      });
    });

    it('with isPrimary=true also denormalizes organizations.email_domain', async () => {
      await linkDomain({
        orgId: ORG_A,
        domain: D1,
        source: 'email_verification',
        verified: true,
        isPrimary: true,
      });

      const org = await getPool().query(
        `SELECT email_domain FROM organizations WHERE workos_organization_id = $1`,
        [ORG_A],
      );
      expect(org.rows[0].email_domain).toBe(D1);
    });

    it('does NOT touch email_domain when isPrimary=false', async () => {
      await getPool().query(
        `UPDATE organizations SET email_domain = 'pre-existing.test' WHERE workos_organization_id = $1`,
        [ORG_A],
      );

      await linkDomain({
        orgId: ORG_A,
        domain: D2,
        source: 'manual',
        verified: false,
        isPrimary: false,
      });

      const org = await getPool().query(
        `SELECT email_domain FROM organizations WHERE workos_organization_id = $1`,
        [ORG_A],
      );
      expect(org.rows[0].email_domain).toBe('pre-existing.test');
    });

    it('returns inserted=false and conflictOrgId=null for same-org conflict (idempotent re-link)', async () => {
      await linkDomain({ orgId: ORG_A, domain: D1, source: 'workos', verified: true, isPrimary: true });

      const second = await linkDomain({
        orgId: ORG_A,
        domain: D1,
        source: 'workos',
        verified: true,
        isPrimary: true,
      });

      expect(second).toEqual({ inserted: false, conflictOrgId: null });
    });

    it('returns inserted=false and conflictOrgId=ORG_B for cross-org conflict; existing row untouched', async () => {
      await linkDomain({ orgId: ORG_B, domain: D_TAKEN, source: 'workos', verified: true, isPrimary: true });

      const result = await linkDomain({
        orgId: ORG_A,
        domain: D_TAKEN,
        source: 'import',
        verified: true,
        isPrimary: true,
      });

      expect(result).toEqual({ inserted: false, conflictOrgId: ORG_B });

      const row = await getPool().query(
        `SELECT workos_organization_id, source, is_primary FROM organization_domains WHERE domain = $1`,
        [D_TAKEN],
      );
      expect(row.rows[0]).toMatchObject({
        workos_organization_id: ORG_B,
        source: 'workos',
        is_primary: true,
      });
    });
  });

  describe('setPrimaryDomain', () => {
    beforeEach(async () => {
      // Seed two verified workos rows on ORG_A; one is primary.
      await linkDomain({ orgId: ORG_A, domain: D1, source: 'workos', verified: true, isPrimary: true });
      await linkDomain({ orgId: ORG_A, domain: D2, source: 'workos', verified: true, isPrimary: false });
    });

    it('flips primary atomically and updates organizations.email_domain', async () => {
      const result = await setPrimaryDomain({ orgId: ORG_A, domain: D2 });
      expect(result).toEqual({ ok: true });

      const rows = await getPool().query(
        `SELECT domain, is_primary FROM organization_domains
          WHERE workos_organization_id = $1 ORDER BY domain`,
        [ORG_A],
      );
      expect(rows.rows).toEqual([
        { domain: D1, is_primary: false },
        { domain: D2, is_primary: true },
      ]);

      const org = await getPool().query(
        `SELECT email_domain FROM organizations WHERE workos_organization_id = $1`,
        [ORG_A],
      );
      expect(org.rows[0].email_domain).toBe(D2);
    });

    it('returns not_found when the domain is not linked to the org', async () => {
      const result = await setPrimaryDomain({ orgId: ORG_A, domain: 'never-linked.test' });
      expect(result).toEqual({ ok: false, reason: 'not_found' });
    });

    it('returns not_verified when the row is unverified', async () => {
      await linkDomain({ orgId: ORG_A, domain: D3, source: 'workos', verified: false, isPrimary: false });

      const result = await setPrimaryDomain({ orgId: ORG_A, domain: D3 });
      expect(result).toEqual({ ok: false, reason: 'not_verified' });
    });

    it('returns source_not_allowed when requireSource excludes the row source', async () => {
      await linkDomain({ orgId: ORG_A, domain: D3, source: 'import', verified: true, isPrimary: false });

      const result = await setPrimaryDomain({
        orgId: ORG_A,
        domain: D3,
        requireSource: ['workos'],
      });
      expect(result).toMatchObject({ ok: false, reason: 'source_not_allowed', foundSource: 'import' });

      // Existing primary is unchanged.
      const rows = await getPool().query(
        `SELECT domain FROM organization_domains
          WHERE workos_organization_id = $1 AND is_primary = true`,
        [ORG_A],
      );
      expect(rows.rows[0].domain).toBe(D1);
    });
  });
});
