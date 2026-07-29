import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  getClient: vi.fn(),
}));

vi.mock('../../src/db/client.js', () => ({
  query: mocks.query,
  getClient: mocks.getClient,
}));

import { BrandDatabase } from '../../src/db/brand-db.js';

function row(domain: string) {
  return {
    id: `id-${domain}`,
    domain,
    brand_name: domain,
    brand_names: '[]',
    brand_manifest: JSON.stringify({ name: domain }),
    has_brand_manifest: true,
    source_type: 'community',
    discovered_at: new Date('2026-01-01T00:00:00Z'),
  };
}

describe('BrandDatabase resolution precedence', () => {
  const db = new BrandDatabase();

  beforeEach(() => {
    mocks.query.mockReset();
    mocks.getClient.mockReset();
  });

  it('selects one domain row by hosted, brand_json, community, enriched precedence', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [row('leaf.example')] });

    await db.getDiscoveredBrandByDomain('LEAF.EXAMPLE');

    const [sql, params] = mocks.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('workos_organization_id IS NOT NULL AND domain_verified IS TRUE THEN 1');
    expect(sql).toContain("source_type = 'brand_json' THEN 2");
    expect(sql).toContain("source_type = 'community' THEN 3");
    expect(sql).toContain("source_type = 'enriched' THEN 4");
    expect(sql).toContain('last_validated DESC NULLS LAST');
    expect(sql).toContain('id ASC');
    expect(sql).toContain('LIMIT 1');
    expect(params).toEqual(['leaf.example']);
  });

  it('returns only the highest-priority row per domain in batch lookups', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [row('leaf.example'), row('house.example')] });

    const result = await db.getDiscoveredBrandsByDomains(['LEAF.EXAMPLE', 'house.example']);

    const [sql, params] = mocks.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('SELECT DISTINCT ON (domain)');
    expect(sql).toContain('ORDER BY domain');
    expect(sql).toContain('domain_verified IS TRUE THEN 1');
    expect(params).toEqual(['leaf.example', 'house.example']);
    expect([...result.keys()]).toEqual(['leaf.example', 'house.example']);
  });
});
