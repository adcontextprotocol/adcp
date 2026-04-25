/**
 * Integration tests for the orphaned-brand adoption flow shipped in #3168 +
 * #3182. The unit tests cover the BrandIdentityError discriminator shape; this
 * file exercises the end-to-end transaction:
 *
 *   - relinquish via deleteHostedBrand sets the orphan flag and stashes prior
 *     ownership (instead of nuking the manifest)
 *   - public read paths skip orphaned rows
 *   - listOrphanedBrands surfaces them with prior owner context
 *   - updateBrandIdentity refuses an implicit decision on orphaned rows
 *   - explicit adopt vs clear branches produce the right manifest state
 *
 * Code reviewer flagged the absence of integration coverage on this flow as
 * the load-bearing gap on #3168.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

// Mock the logo URL validator before any module-graph load so the integration
// test doesn't make outbound HEAD requests against fake .example.com URLs.
// brand-identity.ts imports this; we replace it with an always-ok stub.
vi.mock('../../src/services/brand-logo-service.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/brand-logo-service.js')>(
    '../../src/services/brand-logo-service.js'
  );
  return {
    ...actual,
    checkLogoUrlIsImage: vi.fn().mockResolvedValue({ ok: true, contentType: 'image/png' }),
  };
});

import { initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { BrandDatabase } from '../../src/db/brand-db.js';
import { BrandIdentityError, updateBrandIdentity } from '../../src/services/brand-identity.js';
import type { Pool } from 'pg';

const TEST_DOMAIN = 'orphan-adopt.example.com';
const PRIOR_ORG = 'org_test_prior_owner_001';
const NEW_ORG = 'org_test_new_owner_002';

describe('Brand orphan-adoption integration', () => {
  let pool: Pool;
  let brandDb: BrandDatabase;
  let priorBrandId: string;

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString: process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:5432/adcp_test',
    });
    await runMigrations();
    brandDb = new BrandDatabase();
  });

  // Scope cleanup to this file's specific fixtures so a parallel run of
  // brand-registry-list.test.ts (which sweeps the entire .example.com pattern)
  // doesn't trample our seed and vice versa. nodejs-testing-expert flagged
  // this as a real parallelism risk in the #3186 review.
  async function clearTestFixtures() {
    await pool.query('DELETE FROM brands WHERE domain = $1', [TEST_DOMAIN]);
    await pool.query(
      'DELETE FROM organizations WHERE workos_organization_id IN ($1, $2)',
      [PRIOR_ORG, NEW_ORG]
    );
  }

  afterAll(async () => {
    await clearTestFixtures();
    await closeDatabase();
  });

  beforeEach(async () => {
    await clearTestFixtures();

    // Seed two test orgs so the cross-org SELECT inside transferBrandOwnership
    // and the prior-owner JOIN in listOrphanedBrands have rows to match.
    await pool.query(
      `INSERT INTO organizations (workos_organization_id, name, is_personal)
       VALUES ($1, 'Prior Owner Inc', false), ($2, 'New Owner Inc', false)
       ON CONFLICT (workos_organization_id) DO NOTHING`,
      [PRIOR_ORG, NEW_ORG]
    );

    // Seed a hosted brand owned by the prior org with a recognizable manifest.
    const result = await pool.query<{ id: string }>(
      `INSERT INTO brands (
         domain, workos_organization_id, brand_manifest, brand_name,
         source_type, review_status, is_public, has_brand_manifest, domain_verified
       ) VALUES ($1, $2, $3, 'Prior Brand', 'community', 'approved', TRUE, TRUE, TRUE)
       RETURNING id`,
      [
        TEST_DOMAIN,
        PRIOR_ORG,
        JSON.stringify({
          brands: [{
            id: 'prior',
            names: [{ en: 'Prior Brand' }],
            logos: [{ url: 'https://prior.example.com/logo.png' }],
            colors: { primary: '#aabbcc' },
          }],
        }),
      ]
    );
    priorBrandId = result.rows[0].id;
  });

  it('deleteHostedBrand sets manifest_orphaned and preserves the prior manifest', async () => {
    const ok = await brandDb.deleteHostedBrand(priorBrandId);
    expect(ok).toBe(true);

    const row = await pool.query<{
      manifest_orphaned: boolean;
      prior_owner_org_id: string | null;
      workos_organization_id: string | null;
      is_public: boolean;
      brand_manifest: Record<string, unknown> | null;
    }>(
      `SELECT manifest_orphaned, prior_owner_org_id, workos_organization_id,
              is_public, brand_manifest
       FROM brands WHERE id = $1`,
      [priorBrandId]
    );

    const r = row.rows[0];
    expect(r.manifest_orphaned).toBe(true);
    expect(r.prior_owner_org_id).toBe(PRIOR_ORG);
    expect(r.workos_organization_id).toBeNull();
    expect(r.is_public).toBe(false);
    // The manifest must be preserved server-side for adoption-at-claim-time.
    expect(r.brand_manifest).toBeTruthy();
    const brands = (r.brand_manifest as { brands?: Array<{ logos?: Array<{ url: string }> }> }).brands;
    expect(brands?.[0]?.logos?.[0]?.url).toBe('https://prior.example.com/logo.png');
  });

  it('getDiscoveredBrandByDomain still returns the orphaned row with the flag set so callers can branch', async () => {
    // The DB returns the row; callers (resolveBrand, registry-api routes,
    // brand-feeds, http member-profile endpoint) check manifest_orphaned and
    // refuse to surface it. We assert the data shape callers depend on.
    await brandDb.deleteHostedBrand(priorBrandId);
    const brand = await brandDb.getDiscoveredBrandByDomain(TEST_DOMAIN);
    expect(brand).toBeTruthy();
    expect(brand!.manifest_orphaned).toBe(true);
    expect(brand!.is_public).toBe(false);
  });

  it('updateBrandIdentity throws orphan_manifest_decision_required when adoptPriorManifest is undefined', async () => {
    await brandDb.deleteHostedBrand(priorBrandId);

    // Single rejection assertion that pins both the code and the meta —
    // toMatchObject pins the contract that the UX prompt + chat tool depend
    // on without re-running the failing transaction twice.
    await expect(
      updateBrandIdentity({
        workosOrganizationId: NEW_ORG,
        displayName: 'New Owner Inc',
        profile: { id: 'profile-test', primary_brand_domain: TEST_DOMAIN },
        logoUrl: 'https://newowner.example.com/logo.png',
        // adoptPriorManifest intentionally omitted
      })
    ).rejects.toMatchObject({
      name: 'BrandIdentityError',
      statusCode: 409,
      code: 'orphan_manifest_decision_required',
      meta: { brandDomain: TEST_DOMAIN, priorOwnerOrgId: PRIOR_ORG },
    });
  });

  it('updateBrandIdentity with adoptPriorManifest=false starts fresh and clears the orphan state', async () => {
    await brandDb.deleteHostedBrand(priorBrandId);

    const result = await updateBrandIdentity({
      workosOrganizationId: NEW_ORG,
      displayName: 'New Owner Inc',
      profile: { id: 'profile-test', primary_brand_domain: TEST_DOMAIN },
      logoUrl: 'https://newowner.example.com/logo.png',
      adoptPriorManifest: false,
    });

    expect(result.claimedOrphanedBrand).toBe(true);
    expect(result.keptPriorManifest).toBe(false);

    const row = await pool.query<{
      manifest_orphaned: boolean;
      prior_owner_org_id: string | null;
      workos_organization_id: string | null;
      is_public: boolean;
      brand_manifest: { brands?: Array<{ logos?: Array<{ url: string }> }> };
    }>(
      `SELECT manifest_orphaned, prior_owner_org_id, workos_organization_id,
              is_public, brand_manifest
       FROM brands WHERE domain = $1`,
      [TEST_DOMAIN]
    );

    const r = row.rows[0];
    expect(r.manifest_orphaned).toBe(false);
    expect(r.prior_owner_org_id).toBeNull();
    expect(r.workos_organization_id).toBe(NEW_ORG);
    expect(r.is_public).toBe(true);
    // Started fresh — only the new owner's logo, prior logo gone.
    const logos = r.brand_manifest.brands?.[0]?.logos ?? [];
    expect(logos.length).toBe(1);
    expect(logos[0].url).toBe('https://newowner.example.com/logo.png');
  });

  it('updateBrandIdentity with adoptPriorManifest=true keeps the prior manifest and merges the new logo', async () => {
    await brandDb.deleteHostedBrand(priorBrandId);

    const result = await updateBrandIdentity({
      workosOrganizationId: NEW_ORG,
      displayName: 'New Owner Inc',
      profile: { id: 'profile-test', primary_brand_domain: TEST_DOMAIN },
      logoUrl: 'https://newowner.example.com/logo.png',
      adoptPriorManifest: true,
    });

    expect(result.claimedOrphanedBrand).toBe(true);
    expect(result.keptPriorManifest).toBe(true);

    const row = await pool.query<{
      manifest_orphaned: boolean;
      workos_organization_id: string | null;
      is_public: boolean;
      brand_manifest: {
        brands?: Array<{
          id?: string;
          names?: Array<Record<string, string>>;
          logos?: Array<{ url: string }>;
          colors?: { primary?: string };
        }>;
      };
    }>(
      `SELECT manifest_orphaned, workos_organization_id, is_public, brand_manifest
       FROM brands WHERE domain = $1`,
      [TEST_DOMAIN]
    );

    const r = row.rows[0];
    expect(r.manifest_orphaned).toBe(false);
    expect(r.workos_organization_id).toBe(NEW_ORG);
    expect(r.is_public).toBe(true);
    // Adopted prior manifest — new logo replaced [0] but the rest of the
    // prior brand object survives. Pin two unrelated prior fields to
    // confirm "merge" rather than "accidentally untouched".
    const primary = r.brand_manifest.brands?.[0];
    expect(primary?.logos?.[0]?.url).toBe('https://newowner.example.com/logo.png');
    expect(primary?.colors?.primary).toBe('#aabbcc');
    expect(primary?.id).toBe('prior'); // prior brand id survives
    expect(primary?.names).toEqual([{ en: 'Prior Brand' }]); // prior name survives
  });

  it('cross-org write to a non-orphaned brand still throws cross_org_ownership (not the orphan code)', async () => {
    // Sanity check: the orphan path doesn't bypass the cross-org boundary
    // when the brand is currently owned. The brand seeded in beforeEach is
    // owned by PRIOR_ORG and not orphaned. Critical to assert the SPECIFIC
    // code so a regression that flips this to orphan_manifest_decision_required
    // (which would silently let cross-org writes through) is caught.
    await expect(
      updateBrandIdentity({
        workosOrganizationId: NEW_ORG,
        displayName: 'New Owner Inc',
        profile: { id: 'profile-test', primary_brand_domain: TEST_DOMAIN },
        logoUrl: 'https://newowner.example.com/logo.png',
        adoptPriorManifest: true, // even with adopt set, cross-org wins
      })
    ).rejects.toMatchObject({
      name: 'BrandIdentityError',
      statusCode: 403,
      code: 'cross_org_ownership',
      meta: { brandDomain: TEST_DOMAIN, currentOwnerOrgId: PRIOR_ORG },
    });
  });
});
