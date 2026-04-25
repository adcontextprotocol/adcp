/**
 * Integration tests for the brand-claim file-placement challenge (#3176).
 *
 * The HTTP verify endpoint fetches a placement URL via safeFetch; we mock
 * fetchAndMatchClaimToken at the module-graph level so the test doesn't need
 * a live web server. The real network behavior is exercised by safeFetch's
 * own tests; this suite focuses on the issue/verify state machine and the
 * cross-org / orphan branching.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

const fetchAndMatch = vi.hoisted(() => vi.fn());
vi.mock('../../src/services/brand-claim-challenge.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/brand-claim-challenge.js')>(
    '../../src/services/brand-claim-challenge.js'
  );
  return {
    ...actual,
    fetchAndMatchClaimToken: fetchAndMatch,
  };
});

import { initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { BrandDatabase } from '../../src/db/brand-db.js';
import type { Pool } from 'pg';

const TEST_DOMAIN = 'claim-challenge.example.com';
const ORG_A = 'org_test_claim_a_001';
const ORG_B = 'org_test_claim_b_002';

describe('Brand claim challenge integration', () => {
  let pool: Pool;
  let brandDb: BrandDatabase;

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString: process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:5432/adcp_test',
    });
    await runMigrations();
    brandDb = new BrandDatabase();
  });

  async function clearFixtures() {
    await pool.query('DELETE FROM brands WHERE domain = $1', [TEST_DOMAIN]);
    await pool.query('DELETE FROM organizations WHERE workos_organization_id IN ($1, $2)', [ORG_A, ORG_B]);
  }

  afterAll(async () => {
    await clearFixtures();
    await closeDatabase();
  });

  beforeEach(async () => {
    await clearFixtures();
    fetchAndMatch.mockReset();
    await pool.query(
      `INSERT INTO organizations (workos_organization_id, name, is_personal)
       VALUES ($1, 'Org A', false), ($2, 'Org B', false)
       ON CONFLICT (workos_organization_id) DO NOTHING`,
      [ORG_A, ORG_B]
    );
  });

  it('issueBrandClaimChallenge creates a brand row when none exists and stamps the token', async () => {
    const { token, expiresAt } = await brandDb.issueBrandClaimChallenge(TEST_DOMAIN, ORG_A);
    expect(token).toMatch(/^adcp-claim-/);
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());

    const challenge = await brandDb.getBrandClaimChallenge(TEST_DOMAIN);
    expect(challenge).toBeTruthy();
    expect(challenge!.token).toBe(token);
    expect(challenge!.orgId).toBe(ORG_A);
    expect(challenge!.expired).toBe(false);
  });

  it('issueBrandClaimChallenge overwrites a prior token for the same domain', async () => {
    const first = await brandDb.issueBrandClaimChallenge(TEST_DOMAIN, ORG_A);
    const second = await brandDb.issueBrandClaimChallenge(TEST_DOMAIN, ORG_B);
    expect(second.token).not.toBe(first.token);
    const challenge = await brandDb.getBrandClaimChallenge(TEST_DOMAIN);
    expect(challenge!.token).toBe(second.token);
    expect(challenge!.orgId).toBe(ORG_B);
  });

  it('expired challenge is reported as expired', async () => {
    // Issue with negative TTL so it's already expired at write time.
    await brandDb.issueBrandClaimChallenge(TEST_DOMAIN, ORG_A, -1000);
    const challenge = await brandDb.getBrandClaimChallenge(TEST_DOMAIN);
    expect(challenge!.expired).toBe(true);
  });

  it('applyVerifiedBrandClaim claims an unowned brand, marks verified, clears the token', async () => {
    await brandDb.issueBrandClaimChallenge(TEST_DOMAIN, ORG_A);
    const result = await brandDb.applyVerifiedBrandClaim(TEST_DOMAIN, ORG_A);
    expect(result).toBeTruthy();
    expect(result!.workos_organization_id).toBe(ORG_A);
    expect(result!.domain_verified).toBe(true);
    expect(result!.is_public).toBe(true);

    // Token cleared so it can't be replayed.
    const post = await brandDb.getBrandClaimChallenge(TEST_DOMAIN);
    expect(post).toBeNull();
  });

  it('applyVerifiedBrandClaim with adoptPriorManifest=true keeps the prior manifest', async () => {
    // Seed a hosted brand owned by ORG_A, then relinquish so the row is
    // orphaned with a preserved manifest. ORG_B then claims via challenge.
    await pool.query(
      `INSERT INTO brands (
         domain, workos_organization_id, brand_manifest, brand_name,
         source_type, review_status, is_public, has_brand_manifest, domain_verified
       ) VALUES ($1, $2, $3, 'Prior Brand', 'community', 'approved', TRUE, TRUE, TRUE)`,
      [
        TEST_DOMAIN,
        ORG_A,
        JSON.stringify({
          brands: [{ id: 'prior', logos: [{ url: 'https://prior.example.com/logo.png' }] }],
        }),
      ]
    );
    const before = await brandDb.getDiscoveredBrandByDomain(TEST_DOMAIN);
    await brandDb.deleteHostedBrand(before!.id);

    await brandDb.issueBrandClaimChallenge(TEST_DOMAIN, ORG_B);
    const result = await brandDb.applyVerifiedBrandClaim(TEST_DOMAIN, ORG_B, { adoptPriorManifest: true });
    expect(result!.workos_organization_id).toBe(ORG_B);

    const row = await pool.query<{
      manifest_orphaned: boolean;
      brand_manifest: { brands?: Array<{ logos?: Array<{ url: string }> }> };
    }>('SELECT manifest_orphaned, brand_manifest FROM brands WHERE domain = $1', [TEST_DOMAIN]);
    expect(row.rows[0].manifest_orphaned).toBe(false);
    // Adopted — prior logo URL survived.
    expect(row.rows[0].brand_manifest.brands?.[0]?.logos?.[0]?.url).toBe('https://prior.example.com/logo.png');
  });

  it('applyVerifiedBrandClaim default starts fresh, clearing the prior manifest', async () => {
    await pool.query(
      `INSERT INTO brands (
         domain, workos_organization_id, brand_manifest, brand_name,
         source_type, review_status, is_public, has_brand_manifest, domain_verified
       ) VALUES ($1, $2, $3, 'Prior Brand', 'community', 'approved', TRUE, TRUE, TRUE)`,
      [
        TEST_DOMAIN,
        ORG_A,
        JSON.stringify({ brands: [{ id: 'prior', logos: [{ url: 'https://prior.example.com/logo.png' }] }] }),
      ]
    );
    const before = await brandDb.getDiscoveredBrandByDomain(TEST_DOMAIN);
    await brandDb.deleteHostedBrand(before!.id);

    await brandDb.issueBrandClaimChallenge(TEST_DOMAIN, ORG_B);
    await brandDb.applyVerifiedBrandClaim(TEST_DOMAIN, ORG_B);
    const row = await pool.query<{
      brand_manifest: { brands?: Array<{ logos?: Array<{ url: string }> }> };
      has_brand_manifest: boolean;
    }>('SELECT brand_manifest, has_brand_manifest FROM brands WHERE domain = $1', [TEST_DOMAIN]);
    expect(row.rows[0].has_brand_manifest).toBe(false);
    expect(row.rows[0].brand_manifest).toEqual({});
  });
});
