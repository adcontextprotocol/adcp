/**
 * Integration tests for applyVerifiedBrandClaim — the brand-registry side
 * of the WorkOS-driven brand-claim flow (#3176).
 *
 * The route handler (POST /api/me/member-profile/brand-claim/verify) and the
 * organization_domain.verified webhook BOTH call this method after WorkOS
 * confirms the DNS challenge. Whichever lands first wins; the other is a
 * no-op. This suite pins that idempotency contract plus the orphan/fresh
 * branching that the route's adopt_prior_manifest flag exposes.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { BrandDatabase } from '../../src/db/brand-db.js';
import type { Pool } from 'pg';

const TEST_DOMAIN = 'claim-apply.example.com';
const ORG_A = 'org_test_apply_a';
const ORG_B = 'org_test_apply_b';

describe('applyVerifiedBrandClaim', () => {
  let pool: Pool;
  let brandDb: BrandDatabase;

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString: process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:5432/adcp_test',
    });
    await runMigrations();
    brandDb = new BrandDatabase();
  });

  async function cleanup() {
    await pool.query('DELETE FROM brands WHERE domain = $1', [TEST_DOMAIN]);
    await pool.query('DELETE FROM organizations WHERE workos_organization_id IN ($1, $2)', [ORG_A, ORG_B]);
  }

  afterAll(async () => {
    await cleanup();
    await closeDatabase();
  });

  beforeEach(async () => {
    await cleanup();
    await pool.query(
      `INSERT INTO organizations (workos_organization_id, name, is_personal)
       VALUES ($1, 'Org A', false), ($2, 'Org B', false)
       ON CONFLICT (workos_organization_id) DO NOTHING`,
      [ORG_A, ORG_B]
    );
  });

  it('creates a verified brand row when none exists', async () => {
    const result = await brandDb.applyVerifiedBrandClaim(TEST_DOMAIN, ORG_A);
    expect(result).toBeTruthy();
    expect(result!.workos_organization_id).toBe(ORG_A);
    expect(result!.domain_verified).toBe(true);
    expect(result!.is_public).toBe(true);
  });

  it('is idempotent — second call with the same org is a no-op match', async () => {
    await brandDb.applyVerifiedBrandClaim(TEST_DOMAIN, ORG_A);
    const second = await brandDb.applyVerifiedBrandClaim(TEST_DOMAIN, ORG_A);
    expect(second).toBeTruthy();
    expect(second!.workos_organization_id).toBe(ORG_A);
    expect(second!.domain_verified).toBe(true);
  });

  it('transfers ownership when an unverified incumbent is replaced (matches WorkOS state)', async () => {
    // Seed an unverified incumbent — corresponds to the soft-claim case
    // before WorkOS verified the new claimant. WorkOS would reject the
    // create call upstream if both were verified, so the inline write only
    // ever transfers between unverified or unclaimed states.
    await pool.query(
      `INSERT INTO brands (domain, workos_organization_id, source_type, review_status, is_public, has_brand_manifest, domain_verified)
       VALUES ($1, $2, 'community', 'approved', TRUE, FALSE, FALSE)`,
      [TEST_DOMAIN, ORG_A]
    );
    await brandDb.applyVerifiedBrandClaim(TEST_DOMAIN, ORG_B);
    const row = await pool.query<{ workos_organization_id: string; domain_verified: boolean }>(
      'SELECT workos_organization_id, domain_verified FROM brands WHERE domain = $1',
      [TEST_DOMAIN]
    );
    expect(row.rows[0].workos_organization_id).toBe(ORG_B);
    expect(row.rows[0].domain_verified).toBe(true);
  });

  it('clears the orphan flag and resets manifest by default', async () => {
    // Seed an orphaned brand — prior owner relinquished, manifest preserved.
    await pool.query(
      `INSERT INTO brands (
         domain, brand_manifest, source_type, review_status,
         is_public, has_brand_manifest, manifest_orphaned, prior_owner_org_id
       ) VALUES ($1, $2, 'community', 'approved', FALSE, TRUE, TRUE, $3)`,
      [
        TEST_DOMAIN,
        JSON.stringify({ brands: [{ id: 'prior', logos: [{ url: 'https://prior.example.com/logo.png' }] }] }),
        ORG_A,
      ]
    );
    await brandDb.applyVerifiedBrandClaim(TEST_DOMAIN, ORG_B);
    const row = await pool.query<{
      manifest_orphaned: boolean;
      prior_owner_org_id: string | null;
      brand_manifest: Record<string, unknown>;
      has_brand_manifest: boolean;
    }>(
      'SELECT manifest_orphaned, prior_owner_org_id, brand_manifest, has_brand_manifest FROM brands WHERE domain = $1',
      [TEST_DOMAIN]
    );
    expect(row.rows[0].manifest_orphaned).toBe(false);
    expect(row.rows[0].prior_owner_org_id).toBeNull();
    expect(row.rows[0].has_brand_manifest).toBe(false);
    expect(row.rows[0].brand_manifest).toEqual({});
  });

  it('preserves the prior manifest when adoptPriorManifest is true', async () => {
    await pool.query(
      `INSERT INTO brands (
         domain, brand_manifest, source_type, review_status,
         is_public, has_brand_manifest, manifest_orphaned, prior_owner_org_id
       ) VALUES ($1, $2, 'community', 'approved', FALSE, TRUE, TRUE, $3)`,
      [
        TEST_DOMAIN,
        JSON.stringify({ brands: [{ id: 'prior', logos: [{ url: 'https://prior.example.com/logo.png' }] }] }),
        ORG_A,
      ]
    );
    await brandDb.applyVerifiedBrandClaim(TEST_DOMAIN, ORG_B, { adoptPriorManifest: true });
    const row = await pool.query<{
      manifest_orphaned: boolean;
      brand_manifest: { brands?: Array<{ logos?: Array<{ url: string }> }> };
    }>(
      'SELECT manifest_orphaned, brand_manifest FROM brands WHERE domain = $1',
      [TEST_DOMAIN]
    );
    expect(row.rows[0].manifest_orphaned).toBe(false);
    expect(row.rows[0].brand_manifest.brands?.[0]?.logos?.[0]?.url).toBe('https://prior.example.com/logo.png');
  });
});
