import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { BrandDatabase } from '../../src/db/brand-db.js';

const ENRICHED_DOMAIN = 'provenance-enriched.test';
const CANONICAL_DOMAIN = 'provenance-canonical.test';
const HOSTED_DOMAIN = 'provenance-hosted.test';
const HOSTED_ORG_ID = 'org_provenance_owner';
const TEST_DOMAINS = [ENRICHED_DOMAIN, CANONICAL_DOMAIN, HOSTED_DOMAIN];

describe('brand provenance write precedence', () => {
  let pool: Pool;
  const db = new BrandDatabase();

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString: process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:5432/adcp_test',
    });
    await runMigrations();
  }, 60_000);

  beforeEach(async () => {
    await pool.query('DELETE FROM brands WHERE domain = ANY($1)', [TEST_DOMAINS]);
    await pool.query('DELETE FROM organizations WHERE workos_organization_id = $1', [HOSTED_ORG_ID]);
    await pool.query(
      `INSERT INTO organizations (workos_organization_id, name, subscription_status, created_at, updated_at)
       VALUES ($1, 'Provenance Owner', 'active', NOW(), NOW())`,
      [HOSTED_ORG_ID],
    );
  });

  afterAll(async () => {
    if (!pool) return;
    await pool.query('DELETE FROM brands WHERE domain = ANY($1)', [TEST_DOMAINS]);
    await pool.query('DELETE FROM organizations WHERE workos_organization_id = $1', [HOSTED_ORG_ID]);
    await closeDatabase();
  });

  it('round-trips known enrichment attribution and clears it on community promotion', async () => {
    await db.upsertDiscoveredBrand({
      domain: ENRICHED_DOMAIN,
      brand_name: 'Provider Identity',
      source_type: 'enriched',
      enrichment_provider: 'brandfetch',
    });

    // An older/alternate enrichment writer must not erase known attribution.
    await db.upsertDiscoveredBrand({
      domain: ENRICHED_DOMAIN,
      brand_name: 'Provider Refresh',
      source_type: 'enriched',
    });
    expect(await db.getDiscoveredBrandByDomain(ENRICHED_DOMAIN)).toMatchObject({
      source_type: 'enriched',
      enrichment_provider: 'brandfetch',
    });

    await db.upsertDiscoveredBrand({
      domain: ENRICHED_DOMAIN,
      brand_name: 'Community Identity',
      source_type: 'community',
    });
    const promoted = await db.getDiscoveredBrandByDomain(ENRICHED_DOMAIN);
    expect(promoted).toMatchObject({
      brand_name: 'Community Identity',
      source_type: 'community',
    });
    expect(promoted?.enrichment_provider).toBeNull();
  });

  it('does not let enrichment replace an origin-published canonical identity', async () => {
    await db.upsertDiscoveredBrand({
      domain: CANONICAL_DOMAIN,
      brand_name: 'Origin Canonical',
      brand_manifest: { name: 'Origin Canonical' },
      has_brand_manifest: true,
      source_type: 'brand_json',
    });

    const winner = await db.upsertDiscoveredBrand({
      domain: CANONICAL_DOMAIN,
      brand_name: 'Vendor Replacement',
      brand_manifest: { name: 'Vendor Replacement' },
      has_brand_manifest: true,
      source_type: 'enriched',
      enrichment_provider: 'brandfetch',
    });

    expect(winner).toMatchObject({
      brand_name: 'Origin Canonical',
      source_type: 'brand_json',
    });
    expect(winner.enrichment_provider).toBeNull();
  });

  it('does not let enrichment replace a verified-owner identity', async () => {
    await pool.query(
      `INSERT INTO brands (
        domain, brand_name, brand_manifest, has_brand_manifest, source_type,
        workos_organization_id, domain_verified
      ) VALUES ($1, 'Owner Canonical', $2::jsonb, true, 'community', $3, true)`,
      [HOSTED_DOMAIN, JSON.stringify({ name: 'Owner Canonical' }), HOSTED_ORG_ID],
    );

    const winner = await db.upsertDiscoveredBrand({
      domain: HOSTED_DOMAIN,
      brand_name: 'Vendor Replacement',
      brand_manifest: { name: 'Vendor Replacement' },
      has_brand_manifest: true,
      source_type: 'enriched',
      enrichment_provider: 'brandfetch',
    });

    expect(winner).toMatchObject({
      brand_name: 'Owner Canonical',
      workos_organization_id: HOSTED_ORG_ID,
      domain_verified: true,
    });
    expect(winner.brand_manifest).toEqual({ name: 'Owner Canonical' });
    expect(winner.enrichment_provider).toBeNull();
  });
});
