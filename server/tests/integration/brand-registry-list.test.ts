import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { BrandDatabase } from '../../src/db/brand-db.js';
import type { Pool } from 'pg';

describe('BrandDatabase.getAllBrandsForRegistry', () => {
  let pool: Pool;
  let brandDb: BrandDatabase;

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString: process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:5432/adcp_test',
    });
    await runMigrations();
    brandDb = new BrandDatabase();
  });

  afterAll(async () => {
    await pool.query("DELETE FROM brands WHERE domain LIKE '%.example.com'");
    await closeDatabase();
  });

  beforeEach(async () => {
    await pool.query("DELETE FROM brands WHERE domain LIKE '%.example.com'");
  });

  async function insertBrand(overrides: Record<string, unknown>) {
    const defaults = {
      domain: 'test.example.com',
      brand_name: 'Test Brand',
      source_type: 'community',
      is_public: false,
      has_brand_manifest: false,
      domain_verified: false,
      review_status: 'approved',
    };
    const row = { ...defaults, ...overrides };
    await pool.query(
      `INSERT INTO brands (domain, brand_name, source_type, is_public, has_brand_manifest, domain_verified, review_status, brand_manifest, house_domain)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (domain) DO UPDATE SET
         brand_name = EXCLUDED.brand_name,
         source_type = EXCLUDED.source_type,
         is_public = EXCLUDED.is_public,
         has_brand_manifest = EXCLUDED.has_brand_manifest,
         domain_verified = EXCLUDED.domain_verified,
         review_status = EXCLUDED.review_status,
         brand_manifest = EXCLUDED.brand_manifest,
         house_domain = EXCLUDED.house_domain`,
      [
        row.domain,
        row.brand_name,
        row.source_type,
        row.is_public,
        row.has_brand_manifest,
        row.domain_verified,
        row.review_status,
        row.brand_manifest ? JSON.stringify(row.brand_manifest) : null,
        row.house_domain || null,
      ]
    );
  }

  it('executes without ambiguous column errors', async () => {
    await insertBrand({ domain: 'hosted-brand.example.com', is_public: true, brand_name: 'Hosted' });
    const result = await brandDb.getAllBrandsForRegistry({});
    expect(result).toBeInstanceOf(Array);
  });

  it('returns hosted brands with source=hosted', async () => {
    await insertBrand({
      domain: 'hosted-brand.example.com',
      brand_name: 'Hosted Brand',
      is_public: true,
      source_type: 'community',
      domain_verified: true,
    });
    const result = await brandDb.getAllBrandsForRegistry({});
    const hosted = result.find((b) => b.domain === 'hosted-brand.example.com');
    expect(hosted).toBeDefined();
    expect(hosted!.source).toBe('hosted');
    expect(hosted!.has_manifest).toBe(true);
    expect(hosted!.verified).toBe(true);
  });

  it('returns community brands with their actual source_type', async () => {
    await insertBrand({
      domain: 'community-brand.example.com',
      brand_name: 'Community Brand',
      is_public: false,
      source_type: 'community',
      review_status: 'approved',
    });
    const result = await brandDb.getAllBrandsForRegistry({});
    const community = result.find((b) => b.domain === 'community-brand.example.com');
    expect(community).toBeDefined();
    expect(community!.source).toBe('community');
  });

  it('excludes pending non-public brands', async () => {
    await insertBrand({
      domain: 'private-brand.example.com',
      brand_name: 'Pending Private',
      is_public: false,
      review_status: 'pending',
    });
    const result = await brandDb.getAllBrandsForRegistry({});
    const pending = result.find((b) => b.domain === 'private-brand.example.com');
    expect(pending).toBeUndefined();
  });

  it('counts sub-brands via house_domain', async () => {
    await insertBrand({
      domain: 'hosted-brand.example.com',
      brand_name: 'House Brand',
      is_public: true,
    });
    await insertBrand({
      domain: 'sub-brand.example.com',
      brand_name: 'Sub Brand',
      is_public: true,
      house_domain: 'hosted-brand.example.com',
    });
    const result = await brandDb.getAllBrandsForRegistry({});
    const house = result.find((b) => b.domain === 'hosted-brand.example.com');
    expect(house).toBeDefined();
    expect(house!.sub_brand_count).toBeGreaterThanOrEqual(1);
  });

  it('filters by search term', async () => {
    await insertBrand({ domain: 'hosted-brand.example.com', brand_name: 'Acme Corp', is_public: true });
    await insertBrand({ domain: 'community-brand.example.com', brand_name: 'Other Inc', is_public: true });

    const result = await brandDb.getAllBrandsForRegistry({ search: 'acme' });
    const matched = result.filter((b) => b.domain === 'hosted-brand.example.com');
    const excluded = result.filter((b) => b.domain === 'community-brand.example.com');
    expect(matched.length).toBe(1);
    expect(excluded.length).toBe(0);
  });

  it('respects limit and offset', async () => {
    await insertBrand({ domain: 'hosted-brand.example.com', brand_name: 'AAA', is_public: true });
    await insertBrand({ domain: 'community-brand.example.com', brand_name: 'BBB', is_public: true });

    const page1 = await brandDb.getAllBrandsForRegistry({ search: 'example.com', limit: 1, offset: 0 });
    const page2 = await brandDb.getAllBrandsForRegistry({ search: 'example.com', limit: 1, offset: 1 });

    expect(page1.length).toBe(1);
    expect(page2.length).toBe(1);
    // ORDER BY employee_count DESC, brand_name — both have 0 employees so brand_name wins
    expect(page1[0].brand_name).toBe('AAA');
    expect(page2[0].brand_name).toBe('BBB');
  });

  describe('source filter', () => {
    // Round-trip property: ?source=X returns only rows the response labels source=X.
    // Prevents drift between filter input and response output — the original
    // bug (#3521) was that the filter was ignored entirely.

    async function seedAllSources(prefix = 'src') {
      // Owner-registered: source_type='community' AND is_public=true → response label 'hosted'
      await insertBrand({
        domain: `${prefix}-hosted.example.com`,
        brand_name: 'Hosted Owner',
        is_public: true,
        source_type: 'community',
      });
      // Crawler-discovered with live brand.json → response label 'brand_json'
      await insertBrand({
        domain: `${prefix}-bj.example.com`,
        brand_name: 'Authoritative',
        is_public: false,
        source_type: 'brand_json',
      });
      // Community-contributed, not owner-claimed → response label 'community'
      await insertBrand({
        domain: `${prefix}-comm.example.com`,
        brand_name: 'Community Pick',
        is_public: false,
        source_type: 'community',
      });
      // Brandfetch-enriched → response label 'enriched'
      await insertBrand({
        domain: `${prefix}-enr.example.com`,
        brand_name: 'Enriched Pick',
        is_public: false,
        source_type: 'enriched',
      });
    }

    it('?source=hosted returns only is_public=true rows', async () => {
      await seedAllSources('hosted');
      const result = await brandDb.getAllBrandsForRegistry({ search: 'hosted-', source: 'hosted' });
      expect(result.length).toBe(1);
      expect(result[0].domain).toBe('hosted-hosted.example.com');
      expect(result[0].source).toBe('hosted');
    });

    it('?source=brand_json excludes hosted rows even if source_type would match', async () => {
      // A pathological row: source_type='brand_json' AND is_public=true.
      // Response labels it 'hosted', so ?source=brand_json must NOT return it.
      await insertBrand({
        domain: 'mixed.example.com',
        brand_name: 'Mixed',
        is_public: true,
        source_type: 'brand_json',
      });
      await insertBrand({
        domain: 'pure-bj.example.com',
        brand_name: 'Pure BJ',
        is_public: false,
        source_type: 'brand_json',
      });

      const result = await brandDb.getAllBrandsForRegistry({ search: '.example.com', source: 'brand_json' });
      const domains = result.map((b) => b.domain);
      expect(domains).toContain('pure-bj.example.com');
      expect(domains).not.toContain('mixed.example.com');
      result.forEach((b) => expect(b.source).toBe('brand_json'));
    });

    it('?source=community returns only non-hosted community rows', async () => {
      await seedAllSources('comm');
      const result = await brandDb.getAllBrandsForRegistry({ search: 'comm-', source: 'community' });
      expect(result.length).toBe(1);
      expect(result[0].domain).toBe('comm-comm.example.com');
      expect(result[0].source).toBe('community');
    });

    it('?source=enriched returns only enriched rows', async () => {
      await seedAllSources('enr');
      const result = await brandDb.getAllBrandsForRegistry({ search: 'enr-', source: 'enriched' });
      expect(result.length).toBe(1);
      expect(result[0].domain).toBe('enr-enr.example.com');
      expect(result[0].source).toBe('enriched');
    });

    it('all four filter values partition the four seeded rows', async () => {
      await seedAllSources('part');
      const search = 'part-';

      const [hosted, brand_json, community, enriched, all] = await Promise.all([
        brandDb.getAllBrandsForRegistry({ search, source: 'hosted' }),
        brandDb.getAllBrandsForRegistry({ search, source: 'brand_json' }),
        brandDb.getAllBrandsForRegistry({ search, source: 'community' }),
        brandDb.getAllBrandsForRegistry({ search, source: 'enriched' }),
        brandDb.getAllBrandsForRegistry({ search }),
      ]);

      expect(hosted.length + brand_json.length + community.length + enriched.length).toBe(all.length);
    });

    it('omitting source returns the union (regression: filter must not silently apply a default)', async () => {
      await seedAllSources('union');
      const result = await brandDb.getAllBrandsForRegistry({ search: 'union-' });
      expect(result.length).toBe(4);
    });
  });

  describe('getBrandRegistryStats', () => {
    it('hosted, brand_json, community, enriched are disjoint and reconcile with filter results', async () => {
      // is_public=true is counted ONLY as hosted; the source_type buckets
      // exclude it. Otherwise the dashboard double-counts owner-registered
      // brands and the filter+stats pair becomes inconsistent.
      await insertBrand({
        domain: 'stats-hosted.example.com',
        brand_name: 'Stats Hosted',
        is_public: true,
        source_type: 'community',
      });
      await insertBrand({
        domain: 'stats-bj.example.com',
        brand_name: 'Stats BJ',
        is_public: false,
        source_type: 'brand_json',
      });
      await insertBrand({
        domain: 'stats-comm.example.com',
        brand_name: 'Stats Comm',
        is_public: false,
        source_type: 'community',
      });
      await insertBrand({
        domain: 'stats-enr.example.com',
        brand_name: 'Stats Enr',
        is_public: false,
        source_type: 'enriched',
      });

      const stats = await brandDb.getBrandRegistryStats('stats-');
      expect(stats.hosted).toBe(1);
      expect(stats.brand_json).toBe(1);
      expect(stats.community).toBe(1);
      expect(stats.enriched).toBe(1);
      expect(stats.total).toBe(4);
    });

    it('honors the search arg', async () => {
      // Two prefixes; search must narrow to one. Without this, the search
      // arg could be silently ignored (the filter bug we just fixed for the
      // list endpoint had its mirror in the stats path).
      await insertBrand({ domain: 'pfxA-1.example.com', brand_name: 'A1', is_public: true });
      await insertBrand({ domain: 'pfxA-2.example.com', brand_name: 'A2', is_public: true });
      await insertBrand({ domain: 'pfxB-1.example.com', brand_name: 'B1', is_public: true });

      const a = await brandDb.getBrandRegistryStats('pfxA-');
      const b = await brandDb.getBrandRegistryStats('pfxB-');
      expect(a.total).toBe(2);
      expect(b.total).toBe(1);
    });
  });
});
