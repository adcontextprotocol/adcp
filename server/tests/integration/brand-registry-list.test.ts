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
});
