/**
 * Pins the invariants of the canonical writer module
 * `db/organization-domains-db.ts` (#4159 Stage 3a + 3b).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { initializeDatabase, closeDatabase, getPool } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import {
  linkDomain,
  setPrimaryDomain,
  upsertWorkosDomain,
  autoPromotePrimaryIfNone,
  removeWorkosDomainAndReselectPrimary,
  unlinkDomainAndReselectPrimary,
} from '../../src/db/organization-domains-db.js';
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

    it('with isPrimary=true demotes the existing primary for that org', async () => {
      await linkDomain({
        orgId: ORG_A,
        domain: D1,
        source: 'email_verification',
        verified: true,
        isPrimary: true,
      });

      await linkDomain({
        orgId: ORG_A,
        domain: D2,
        source: 'email_verification',
        verified: true,
        isPrimary: true,
      });

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

    it('with isPrimary=true promotes an existing same-org row idempotently', async () => {
      await linkDomain({
        orgId: ORG_A,
        domain: D1,
        source: 'manual',
        verified: false,
        isPrimary: false,
      });

      const result = await linkDomain({
        orgId: ORG_A,
        domain: D1,
        source: 'email_verification',
        verified: true,
        isPrimary: true,
      });

      expect(result).toEqual({ inserted: false, conflictOrgId: null });

      const row = await getPool().query(
        `SELECT is_primary, verified, source FROM organization_domains WHERE workos_organization_id = $1 AND domain = $2`,
        [ORG_A, D1],
      );
      expect(row.rows[0].is_primary).toBe(true);
      expect(row.rows[0].verified).toBe(true);
      expect(row.rows[0].source).toBe('email_verification');
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

    it('with requireVerified=false, promotes an unverified row (admin override)', async () => {
      await linkDomain({ orgId: ORG_A, domain: D3, source: 'admin_discovery', verified: false, isPrimary: false });

      const result = await setPrimaryDomain({
        orgId: ORG_A,
        domain: D3,
        requireVerified: false,
      });
      expect(result).toEqual({ ok: true });

      const rows = await getPool().query(
        `SELECT domain FROM organization_domains
          WHERE workos_organization_id = $1 AND is_primary = true`,
        [ORG_A],
      );
      expect(rows.rows[0].domain).toBe(D3);
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

  // ───────────────────────────────────────────────────────────────────────
  // Stage 3b: WorkOS-sourced writers
  // ───────────────────────────────────────────────────────────────────────

  describe('upsertWorkosDomain', () => {
    it('inserts a fresh row with source=workos', async () => {
      await upsertWorkosDomain({ orgId: ORG_A, domain: D1, verified: true });

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

    it('TRANSFERS ownership on conflict — WorkOS is authoritative', async () => {
      await upsertWorkosDomain({ orgId: ORG_B, domain: D_TAKEN, verified: true });

      // WorkOS now reassigns the domain to ORG_A; we must follow.
      await upsertWorkosDomain({ orgId: ORG_A, domain: D_TAKEN, verified: true });

      const row = await getPool().query(
        `SELECT workos_organization_id, source FROM organization_domains WHERE domain = $1`,
        [D_TAKEN],
      );
      expect(row.rows[0]).toMatchObject({
        workos_organization_id: ORG_A,
        source: 'workos',
      });
    });

    it('flips a non-workos row to source=workos on conflict', async () => {
      await linkDomain({ orgId: ORG_A, domain: D1, source: 'manual', verified: false });

      await upsertWorkosDomain({ orgId: ORG_A, domain: D1, verified: true });

      const row = await getPool().query(
        `SELECT source, verified FROM organization_domains WHERE domain = $1`,
        [D1],
      );
      expect(row.rows[0]).toMatchObject({ source: 'workos', verified: true });
    });

    it('on cross-org conflict, transfers ownership but preserves the existing row\'s is_primary (caller intent dropped)', async () => {
      // Pin the documented edge case: caller passes isPrimary=true but the
      // existing row from a different org was is_primary=false. Ownership
      // transfers (good), but the EXCLUDED set excludes is_primary so the
      // existing false stays. Callers that need "set primary on this row,
      // regardless of conflict" must call setPrimaryDomain after.
      await upsertWorkosDomain({ orgId: ORG_B, domain: D_TAKEN, verified: true, isPrimary: false });

      await upsertWorkosDomain({ orgId: ORG_A, domain: D_TAKEN, verified: true, isPrimary: true });

      const row = await getPool().query(
        `SELECT workos_organization_id, is_primary FROM organization_domains WHERE domain = $1`,
        [D_TAKEN],
      );
      expect(row.rows[0]).toMatchObject({
        workos_organization_id: ORG_A,
        is_primary: false,
      });
    });

    it('on cross-org conflict, demotes a transferred primary row for the new org', async () => {
      await upsertWorkosDomain({ orgId: ORG_A, domain: D1, verified: true, isPrimary: true });
      await upsertWorkosDomain({ orgId: ORG_B, domain: D_TAKEN, verified: true, isPrimary: true });

      await upsertWorkosDomain({ orgId: ORG_A, domain: D_TAKEN, verified: true });

      const rows = await getPool().query(
        `SELECT domain, is_primary FROM organization_domains
          WHERE workos_organization_id = $1 ORDER BY domain`,
        [ORG_A],
      );
      expect(rows.rows).toEqual([
        { domain: D1, is_primary: true },
        { domain: D_TAKEN, is_primary: false },
      ]);
    });
  });

  describe('autoPromotePrimaryIfNone', () => {
    it('promotes when no primary exists; updates email_domain', async () => {
      await upsertWorkosDomain({ orgId: ORG_A, domain: D1, verified: true });

      const result = await autoPromotePrimaryIfNone({ orgId: ORG_A, domain: D1 });
      expect(result).toEqual({ promoted: true });

      const row = await getPool().query(
        `SELECT is_primary FROM organization_domains WHERE domain = $1`,
        [D1],
      );
      expect(row.rows[0].is_primary).toBe(true);

      const org = await getPool().query(
        `SELECT email_domain FROM organizations WHERE workos_organization_id = $1`,
        [ORG_A],
      );
      expect(org.rows[0].email_domain).toBe(D1);
    });

    it('does NOT promote when another primary already exists', async () => {
      await upsertWorkosDomain({ orgId: ORG_A, domain: D1, verified: true, isPrimary: true });
      await upsertWorkosDomain({ orgId: ORG_A, domain: D2, verified: true });

      // Set email_domain to a sentinel; promotion should not touch it.
      await getPool().query(
        `UPDATE organizations SET email_domain = 'sentinel.test' WHERE workos_organization_id = $1`,
        [ORG_A],
      );

      const result = await autoPromotePrimaryIfNone({ orgId: ORG_A, domain: D2 });
      expect(result).toEqual({ promoted: false });

      const rows = await getPool().query(
        `SELECT domain FROM organization_domains
          WHERE workos_organization_id = $1 AND is_primary = true`,
        [ORG_A],
      );
      expect(rows.rows[0].domain).toBe(D1);

      const org = await getPool().query(
        `SELECT email_domain FROM organizations WHERE workos_organization_id = $1`,
        [ORG_A],
      );
      expect(org.rows[0].email_domain).toBe('sentinel.test');
    });
  });

  describe('removeWorkosDomainAndReselectPrimary', () => {
    it('returns deleted=false when no row exists', async () => {
      const result = await removeWorkosDomainAndReselectPrimary({ orgId: ORG_A, domain: 'never.test' });
      expect(result).toEqual({ deleted: false, wasPrimary: false, newPrimary: null });
    });

    it('does NOT delete non-workos rows (admin-imported is immune)', async () => {
      await linkDomain({ orgId: ORG_A, domain: D1, source: 'admin_discovery', verified: true, isPrimary: true });

      const result = await removeWorkosDomainAndReselectPrimary({ orgId: ORG_A, domain: D1 });
      expect(result.deleted).toBe(false);

      const row = await getPool().query(`SELECT 1 FROM organization_domains WHERE domain = $1`, [D1]);
      expect(row.rowCount).toBe(1);
    });

    it('deletes a non-primary workos row; no reselection', async () => {
      await upsertWorkosDomain({ orgId: ORG_A, domain: D1, verified: true, isPrimary: true });
      await upsertWorkosDomain({ orgId: ORG_A, domain: D2, verified: true });

      const result = await removeWorkosDomainAndReselectPrimary({ orgId: ORG_A, domain: D2 });
      expect(result).toEqual({ deleted: true, wasPrimary: false, newPrimary: null });

      const remaining = await getPool().query(
        `SELECT domain FROM organization_domains WHERE workos_organization_id = $1 AND is_primary = true`,
        [ORG_A],
      );
      expect(remaining.rows[0].domain).toBe(D1);
    });

    it('deletes the primary row, picks the oldest verified remaining as new primary, syncs email_domain', async () => {
      await upsertWorkosDomain({ orgId: ORG_A, domain: D1, verified: true, isPrimary: true });
      // Force a known created_at ordering: D2 older than D3.
      await upsertWorkosDomain({ orgId: ORG_A, domain: D2, verified: true });
      await upsertWorkosDomain({ orgId: ORG_A, domain: D3, verified: true });
      await getPool().query(
        `UPDATE organization_domains SET created_at = $1 WHERE domain = $2`,
        [new Date('2024-01-01'), D2],
      );
      await getPool().query(
        `UPDATE organization_domains SET created_at = $1 WHERE domain = $2`,
        [new Date('2024-06-01'), D3],
      );
      await getPool().query(
        `UPDATE organizations SET email_domain = $1 WHERE workos_organization_id = $2`,
        [D1, ORG_A],
      );

      const result = await removeWorkosDomainAndReselectPrimary({ orgId: ORG_A, domain: D1 });
      expect(result).toEqual({ deleted: true, wasPrimary: true, newPrimary: D2 });

      const newPrimary = await getPool().query(
        `SELECT domain FROM organization_domains WHERE workos_organization_id = $1 AND is_primary = true`,
        [ORG_A],
      );
      expect(newPrimary.rows[0].domain).toBe(D2);

      const org = await getPool().query(
        `SELECT email_domain FROM organizations WHERE workos_organization_id = $1`,
        [ORG_A],
      );
      expect(org.rows[0].email_domain).toBe(D2);
    });

    it('deletes the only primary row, no remaining; nulls email_domain', async () => {
      await upsertWorkosDomain({ orgId: ORG_A, domain: D1, verified: true, isPrimary: true });
      await getPool().query(
        `UPDATE organizations SET email_domain = $1 WHERE workos_organization_id = $2`,
        [D1, ORG_A],
      );

      const result = await removeWorkosDomainAndReselectPrimary({ orgId: ORG_A, domain: D1 });
      expect(result).toEqual({ deleted: true, wasPrimary: true, newPrimary: null });

      const org = await getPool().query(
        `SELECT email_domain FROM organizations WHERE workos_organization_id = $1`,
        [ORG_A],
      );
      expect(org.rows[0].email_domain).toBeNull();
    });
  });

  describe('unlinkDomainAndReselectPrimary', () => {
    it('returns deleted=false when no row exists', async () => {
      const result = await unlinkDomainAndReselectPrimary({ orgId: ORG_A, domain: 'never.test' });
      expect(result).toEqual({ deleted: false, wasPrimary: false, newPrimary: null });
    });

    it('DELETES non-workos rows (admin-flavor unlink, no source filter)', async () => {
      await linkDomain({ orgId: ORG_A, domain: D1, source: 'admin_discovery', verified: true, isPrimary: true });

      const result = await unlinkDomainAndReselectPrimary({ orgId: ORG_A, domain: D1 });
      expect(result.deleted).toBe(true);

      const row = await getPool().query(`SELECT 1 FROM organization_domains WHERE domain = $1`, [D1]);
      expect(row.rowCount).toBe(0);
    });

    it('non-primary row delete leaves email_domain untouched', async () => {
      await linkDomain({ orgId: ORG_A, domain: D1, source: 'workos', verified: true, isPrimary: true });
      await linkDomain({ orgId: ORG_A, domain: D2, source: 'manual', verified: false, isPrimary: false });

      const result = await unlinkDomainAndReselectPrimary({ orgId: ORG_A, domain: D2 });
      expect(result).toEqual({ deleted: true, wasPrimary: false, newPrimary: null });

      const org = await getPool().query(
        `SELECT email_domain FROM organizations WHERE workos_organization_id = $1`,
        [ORG_A],
      );
      expect(org.rows[0].email_domain).toBe(D1);
    });

    it('reselect prefers verified, falls back to unverified', async () => {
      await linkDomain({ orgId: ORG_A, domain: D1, source: 'workos', verified: true, isPrimary: true });
      await linkDomain({ orgId: ORG_A, domain: D2, source: 'manual', verified: false, isPrimary: false });
      await linkDomain({ orgId: ORG_A, domain: D3, source: 'manual', verified: false, isPrimary: false });
      await getPool().query(
        `UPDATE organization_domains SET created_at = $1 WHERE domain = $2`,
        [new Date('2024-01-01'), D2],
      );
      await getPool().query(
        `UPDATE organization_domains SET created_at = $1 WHERE domain = $2`,
        [new Date('2024-06-01'), D3],
      );

      // Delete the only verified row; reselect should pick D2 (oldest unverified).
      const result = await unlinkDomainAndReselectPrimary({ orgId: ORG_A, domain: D1 });
      expect(result).toEqual({ deleted: true, wasPrimary: true, newPrimary: D2 });

      const org = await getPool().query(
        `SELECT email_domain FROM organizations WHERE workos_organization_id = $1`,
        [ORG_A],
      );
      expect(org.rows[0].email_domain).toBe(D2);
    });

    it('reselect picks verified over older unverified', async () => {
      await linkDomain({ orgId: ORG_A, domain: D1, source: 'workos', verified: true, isPrimary: true });
      await linkDomain({ orgId: ORG_A, domain: D2, source: 'manual', verified: false, isPrimary: false });
      await linkDomain({ orgId: ORG_A, domain: D3, source: 'workos', verified: true, isPrimary: false });
      await getPool().query(
        `UPDATE organization_domains SET created_at = $1 WHERE domain = $2`,
        [new Date('2024-01-01'), D2],
      );
      await getPool().query(
        `UPDATE organization_domains SET created_at = $1 WHERE domain = $2`,
        [new Date('2024-06-01'), D3],
      );

      // Delete D1 (primary). D2 is older but unverified; D3 is verified.
      // verified DESC, created_at ASC → D3 wins.
      const result = await unlinkDomainAndReselectPrimary({ orgId: ORG_A, domain: D1 });
      expect(result).toEqual({ deleted: true, wasPrimary: true, newPrimary: D3 });
    });
  });
});
