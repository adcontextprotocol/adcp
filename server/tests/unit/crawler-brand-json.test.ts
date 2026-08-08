import { describe, expect, it, vi } from 'vitest';

describe('CrawlerService brand.json ingestion', () => {
  it('stores canonical documents without opaque legacy compatibility metadata', async () => {
    const { CrawlerService } = await import('../../src/crawler.js');
    const ctx = Object.create((CrawlerService as any).prototype);
    const canonical = {
      $schema: 'https://adcontextprotocol.org/schemas/v3/brand.json',
      id: 'leaf',
      names: [{ en: 'Leaf Brand' }],
      properties: [{ type: 'website', identifier: 'leaf.example', relationship: 'owned' }],
      legacy_properties: [{ type: 'website', identifier: 'unverified.example', relationship: 'direct' }],
      legacy_metadata: { unpromoted_brands: [{ id: 'unverified' }] },
    };
    const upsertDiscoveredBrand = vi.fn().mockResolvedValue(undefined);
    const upsertBrandProperties = vi.fn().mockResolvedValue(undefined);

    Object.assign(ctx, {
      brandManager: {
        validateDomain: vi.fn().mockResolvedValue({
          valid: true,
          errors: [],
          warnings: [],
          domain: 'leaf.example',
          url: 'https://leaf.example/.well-known/brand.json',
          variant: 'brand_canonical',
          raw_data: canonical,
        }),
      },
      brandDb: { upsertDiscoveredBrand },
      upsertBrandProperties,
    });

    await ctx.scanBrandForDomain('leaf.example');

    expect(upsertDiscoveredBrand).toHaveBeenCalledWith({
      domain: 'leaf.example',
      brand_name: 'Leaf Brand',
      has_brand_manifest: true,
      brand_manifest: {
        $schema: canonical.$schema,
        id: 'leaf',
        names: canonical.names,
        properties: canonical.properties,
      },
      source_type: 'brand_json',
    });
    expect(upsertBrandProperties).toHaveBeenCalledWith('leaf.example', canonical);
  }, 30_000);
});
