/**
 * brands.workos_organization_id under the contained organization merge (#6827).
 *
 * These fixtures previously proved the repoint mergeOrganizations performed:
 * secondary-owned brand rows landed at the primary org inside the merge
 * transaction, so the FK ON DELETE SET NULL (migration 474) never fired for
 * them. Merge execution is now contained, so the same fixtures prove the
 * stronger property instead — the contained service refuses and no brand row,
 * owner pointer or organization row moves at all. Restore the repoint
 * assertions together with a reviewed merge lifecycle.
 *
 * The direct-delete case below never used merge and is unchanged: it still
 * covers the FK SET NULL plus orphan trigger on its own.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { mergeOrganizations } from '../../src/db/org-merge-db.js';
import { OrganizationMergeUnavailableError } from '../../src/db/org-merge-containment.js';
import type { Pool } from 'pg';
import type { WorkOS } from '@workos-inc/node';

const PRIMARY_ORG = 'org_merge_brands_primary';
const SECONDARY_ORG = 'org_merge_brands_secondary';
const THIRD_ORG = 'org_merge_brands_third';
const PRIMARY_DOMAIN = 'merge-brands-primary.test';
const SECONDARY_DOMAIN_A = 'merge-brands-secondary-a.test';
const SECONDARY_DOMAIN_B = 'merge-brands-secondary-b.test';
const THIRD_DOMAIN = 'merge-brands-third.test';
const ORPHAN_DOMAIN = 'merge-brands-orphan.test';
const MERGED_BY = 'user_merge_brands_admin';

// Records rather than no-ops: the contained service must never reach it.
const deleteCalls: string[] = [];
const workosStub = {
  organizations: {
    deleteOrganization: async (id: string) => { deleteCalls.push(id); },
  },
} as unknown as WorkOS;

async function expectMergeRefused(pool: Pool) {
  deleteCalls.length = 0;
  await expect(mergeOrganizations(PRIMARY_ORG, SECONDARY_ORG, MERGED_BY, workosStub))
    .rejects.toThrow(OrganizationMergeUnavailableError);
  expect(deleteCalls).toEqual([]);
  // The secondary organization is never deleted, so the FK never fires.
  const secondary = await pool.query<{ count: string }>(
    'SELECT COUNT(*)::text AS count FROM organizations WHERE workos_organization_id = $1',
    [SECONDARY_ORG],
  );
  expect(secondary.rows[0]?.count).toBe('1');
}

describe('contained mergeOrganizations — brands keep their owner', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString: process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:5432/adcp_test',
    });
    await runMigrations();
  }, 60000);

  afterAll(async () => {
    await cleanup();
    await closeDatabase();
  });

  beforeEach(async () => {
    await cleanup();
    await pool.query(
      `INSERT INTO organizations (workos_organization_id, name, created_at, updated_at)
       VALUES ($1, 'Primary', NOW(), NOW()),
              ($2, 'Secondary', NOW(), NOW()),
              ($3, 'Third', NOW(), NOW())`,
      [PRIMARY_ORG, SECONDARY_ORG, THIRD_ORG],
    );
  });

  async function cleanup() {
    await pool.query(
      `DELETE FROM brands WHERE domain IN ($1, $2, $3, $4, $5)`,
      [PRIMARY_DOMAIN, SECONDARY_DOMAIN_A, SECONDARY_DOMAIN_B, THIRD_DOMAIN, ORPHAN_DOMAIN],
    );
    await pool.query(
      `DELETE FROM organizations WHERE workos_organization_id IN ($1, $2, $3)`,
      [PRIMARY_ORG, SECONDARY_ORG, THIRD_ORG],
    );
  }

  async function seedBrand(domain: string, orgId: string | null) {
    await pool.query(
      `INSERT INTO brands (domain, workos_organization_id, source_type, is_public, created_at, updated_at)
       VALUES ($1, $2, 'community', TRUE, NOW(), NOW())`,
      [domain, orgId],
    );
  }

  it('refuses and leaves every brand ownership exactly as it was', async () => {
    // One case rather than four: after an unconditional refusal there is no
    // code path that could treat a secondary-owned, primary-owned, third-owned
    // or NULL-owned brand differently, so seeding all four together and
    // asserting the whole set is both stronger and honest about what is tested.
    await seedBrand(SECONDARY_DOMAIN_A, SECONDARY_ORG);
    await seedBrand(SECONDARY_DOMAIN_B, SECONDARY_ORG);
    await seedBrand(PRIMARY_DOMAIN, PRIMARY_ORG);
    await seedBrand(THIRD_DOMAIN, THIRD_ORG);
    await seedBrand(ORPHAN_DOMAIN, null);

    await expectMergeRefused(pool);

    const after = await pool.query<{
      domain: string;
      workos_organization_id: string | null;
      prior_owner_org_id: string | null;
      manifest_orphaned: boolean;
    }>(
      `SELECT domain, workos_organization_id, prior_owner_org_id, manifest_orphaned
       FROM brands WHERE domain = ANY($1) ORDER BY domain`,
      [[PRIMARY_DOMAIN, SECONDARY_DOMAIN_A, SECONDARY_DOMAIN_B, THIRD_DOMAIN, ORPHAN_DOMAIN]],
    );
    // Compared as a set so the assertion does not encode a collation order.
    const asSet = (pairs: [string, string | null][]) =>
      pairs.map(([domain, org]) => `${domain}|${org ?? 'NULL'}`).sort();
    expect(
      asSet(after.rows.map(row => [row.domain, row.workos_organization_id])),
    ).toEqual(asSet([
      [ORPHAN_DOMAIN, null],
      [PRIMARY_DOMAIN, PRIMARY_ORG],
      [SECONDARY_DOMAIN_A, SECONDARY_ORG],
      [SECONDARY_DOMAIN_B, SECONDARY_ORG],
      [THIRD_DOMAIN, THIRD_ORG],
    ]));

    // The secondary org row survives, so neither the FK ON DELETE SET NULL nor
    // the orphan trigger fires — the hazard the repoint existed to avoid cannot
    // arise while merge is contained.
    for (const row of after.rows) {
      expect(row.prior_owner_org_id).toBeNull();
      expect(row.manifest_orphaned).toBe(false);
    }
  });

  it('direct org delete (no merge) triggers FK SET NULL + orphan trigger', async () => {
    // When an org is deleted without a merge to absorb its brands, the FK
    // cascade nulls workos_organization_id and the BEFORE UPDATE trigger
    // (migration 474) mirrors the relinquish state — manifest_orphaned,
    // is_public=FALSE, domain_verified=FALSE, prior_owner_org_id stashed.
    // Without the trigger, the brand row would remain publicly listed in
    // the registry as a verified-but-unowned brand.
    await pool.query(
      `INSERT INTO brands (
         domain, workos_organization_id, source_type, is_public,
         domain_verified, manifest_orphaned, created_at, updated_at
       ) VALUES ($1, $2, 'community', TRUE, TRUE, FALSE, NOW(), NOW())`,
      [SECONDARY_DOMAIN_A, SECONDARY_ORG],
    );

    await pool.query(
      'DELETE FROM organizations WHERE workos_organization_id = $1',
      [SECONDARY_ORG],
    );

    const after = await pool.query<{
      workos_organization_id: string | null;
      prior_owner_org_id: string | null;
      manifest_orphaned: boolean;
      is_public: boolean;
      domain_verified: boolean;
    }>(
      `SELECT workos_organization_id, prior_owner_org_id, manifest_orphaned,
              is_public, domain_verified
       FROM brands WHERE domain = $1`,
      [SECONDARY_DOMAIN_A],
    );
    expect(after.rows[0]?.workos_organization_id).toBeNull();
    expect(after.rows[0]?.prior_owner_org_id).toBe(SECONDARY_ORG);
    expect(after.rows[0]?.manifest_orphaned).toBe(true);
    expect(after.rows[0]?.is_public).toBe(false);
    expect(after.rows[0]?.domain_verified).toBe(false);
  });
});
