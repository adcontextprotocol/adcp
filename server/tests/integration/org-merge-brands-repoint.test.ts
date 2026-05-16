/**
 * Integration test for the brands.workos_organization_id repoint added in
 * mergeOrganizations.
 *
 * Without the repoint, the FK ON DELETE SET NULL on brands (migration 474)
 * fires when the secondary org row is deleted at the end of the merge,
 * leaving the secondary's brand rows owner-less. With the repoint inside
 * the merge transaction, the brand rows land at the primary org first and
 * the FK never fires for them.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { initializeDatabase, closeDatabase, getPool } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { mergeOrganizations } from '../../src/db/org-merge-db.js';
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

const workosStub = {
  organizations: {
    deleteOrganization: async (_id: string) => {},
  },
} as unknown as WorkOS;

describe('mergeOrganizations — brands.workos_organization_id repoint', () => {
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

  it('repoints brands owned by the secondary org to the primary org', async () => {
    await seedBrand(SECONDARY_DOMAIN_A, SECONDARY_ORG);
    await seedBrand(SECONDARY_DOMAIN_B, SECONDARY_ORG);

    const summary = await mergeOrganizations(PRIMARY_ORG, SECONDARY_ORG, MERGED_BY, workosStub);

    const after = await pool.query<{ workos_organization_id: string | null }>(
      'SELECT workos_organization_id FROM brands WHERE domain = ANY($1) ORDER BY domain',
      [[SECONDARY_DOMAIN_A, SECONDARY_DOMAIN_B]],
    );
    expect(after.rows).toHaveLength(2);
    expect(after.rows[0]?.workos_organization_id).toBe(PRIMARY_ORG);
    expect(after.rows[1]?.workos_organization_id).toBe(PRIMARY_ORG);

    // Summary reports the repoint so admins running merges can audit it.
    const brandsEntry = summary.tables_merged.find((t) => t.table_name === 'brands');
    expect(brandsEntry).toBeDefined();
    expect(brandsEntry!.rows_moved).toBe(2);
  });

  it('does not touch brands owned by the primary or a third org', async () => {
    await seedBrand(PRIMARY_DOMAIN, PRIMARY_ORG);
    await seedBrand(THIRD_DOMAIN, THIRD_ORG);

    await mergeOrganizations(PRIMARY_ORG, SECONDARY_ORG, MERGED_BY, workosStub);

    const after = await pool.query<{ domain: string; workos_organization_id: string | null }>(
      'SELECT domain, workos_organization_id FROM brands WHERE domain = ANY($1) ORDER BY domain',
      [[PRIMARY_DOMAIN, THIRD_DOMAIN]],
    );
    expect(after.rows.find((r) => r.domain === PRIMARY_DOMAIN)?.workos_organization_id).toBe(PRIMARY_ORG);
    expect(after.rows.find((r) => r.domain === THIRD_DOMAIN)?.workos_organization_id).toBe(THIRD_ORG);
  });

  it('does not touch brands with null workos_organization_id', async () => {
    await seedBrand(ORPHAN_DOMAIN, null);

    await mergeOrganizations(PRIMARY_ORG, SECONDARY_ORG, MERGED_BY, workosStub);

    const after = await pool.query<{ workos_organization_id: string | null }>(
      'SELECT workos_organization_id FROM brands WHERE domain = $1',
      [ORPHAN_DOMAIN],
    );
    expect(after.rows[0]?.workos_organization_id).toBeNull();
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

  it('repoint runs before the secondary org is deleted, so the FK SET NULL never fires for these rows', async () => {
    // Without the repoint, the FK ON DELETE SET NULL would fire when the
    // secondary org row is deleted at the end of the merge, leaving these
    // brands owner-less. The repoint inside the merge transaction takes
    // precedence — assert the column lands at primary, not NULL.
    await seedBrand(SECONDARY_DOMAIN_A, SECONDARY_ORG);

    await mergeOrganizations(PRIMARY_ORG, SECONDARY_ORG, MERGED_BY, workosStub);

    const after = await pool.query<{ workos_organization_id: string | null }>(
      'SELECT workos_organization_id FROM brands WHERE domain = $1',
      [SECONDARY_DOMAIN_A],
    );
    // Specifically NOT null — the FK fired for any column that DIDN'T get
    // repointed, but we explicitly UPDATE'd this one before the DELETE.
    expect(after.rows[0]?.workos_organization_id).not.toBeNull();
    expect(after.rows[0]?.workos_organization_id).toBe(PRIMARY_ORG);

    // Confirm secondary org row was actually deleted (proves the FK
    // would have fired had the repoint not run first).
    const secondaryCheck = await pool.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM organizations WHERE workos_organization_id = $1',
      [SECONDARY_ORG],
    );
    expect(secondaryCheck.rows[0]?.count).toBe('0');
  });
});
