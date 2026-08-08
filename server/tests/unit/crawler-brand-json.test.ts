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

    const result = await ctx.scanBrandForDomain('leaf.example');

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
    expect(result).toEqual({
      found: true,
      valid: true,
      variant: 'brand_canonical',
      manifestPersisted: true,
    });
  }, 30_000);

  it('reports the live attempt as invalid instead of inferring success from stored state', async () => {
    const { CrawlerService } = await import('../../src/crawler.js');
    const ctx = Object.create((CrawlerService as any).prototype);
    const upsertDiscoveredBrand = vi.fn();
    Object.assign(ctx, {
      brandManager: {
        validateDomain: vi.fn().mockResolvedValue({
          valid: false,
          errors: [{ field: '$', message: 'Not found', severity: 'error' }],
          warnings: [],
          domain: 'missing.example',
          url: 'https://missing.example/.well-known/brand.json',
          status_code: 404,
        }),
      },
      brandDb: { upsertDiscoveredBrand },
    });

    await expect(ctx.scanBrandForDomain('missing.example')).resolves.toEqual({
      found: false,
      valid: false,
      variant: null,
      manifestPersisted: false,
    });
    expect(upsertDiscoveredBrand).not.toHaveBeenCalled();
  });

  it('reports a valid redirect without claiming that a full manifest was persisted', async () => {
    const { CrawlerService } = await import('../../src/crawler.js');
    const ctx = Object.create((CrawlerService as any).prototype);
    const upsertDiscoveredBrand = vi.fn().mockResolvedValue(undefined);
    Object.assign(ctx, {
      brandManager: {
        validateDomain: vi.fn().mockResolvedValue({
          valid: true,
          errors: [],
          warnings: [],
          domain: 'redirect.example',
          url: 'https://redirect.example/.well-known/brand.json',
          variant: 'house_redirect',
          raw_data: { house: 'house.example' },
        }),
      },
      brandDb: { upsertDiscoveredBrand },
    });

    await expect(ctx.scanBrandForDomain('redirect.example')).resolves.toEqual({
      found: true,
      valid: true,
      variant: 'house_redirect',
      manifestPersisted: false,
    });
    expect(upsertDiscoveredBrand).toHaveBeenCalledWith(expect.objectContaining({
      domain: 'redirect.example',
      has_brand_manifest: false,
      source_type: 'brand_json',
    }));
  });

  it('persists terminal origin evidence for an already-verified hosted pointer', async () => {
    const { CrawlerService } = await import('../../src/crawler.js');
    const ctx = Object.create((CrawlerService as any).prototype);
    const updateHostedBrand = vi.fn().mockResolvedValue(undefined);
    Object.assign(ctx, {
      brandManager: {
        validateDomain: vi.fn().mockResolvedValue({
          valid: true,
          errors: [],
          warnings: [],
          domain: 'hosted.example',
          url: 'https://hosted.example/.well-known/brand.json',
          variant: 'authoritative_location',
          raw_data: {
            authoritative_location: 'https://agenticadvertising.org/brands/hosted.example/brand.json',
          },
        }),
      },
      brandDb: {
        getHostedBrandByDomain: vi.fn().mockResolvedValue({
          id: 'brand_hosted',
          domain_verified: true,
        }),
        updateHostedBrand,
      },
    });

    await expect(ctx.scanBrandForDomain('hosted.example')).resolves.toEqual({
      found: true,
      valid: true,
      variant: 'authoritative_location',
      manifestPersisted: false,
    });
    expect(updateHostedBrand).toHaveBeenCalledWith('brand_hosted', {
      domain_verified: true,
      origin_validated: true,
    });
  });

  it('persists terminal origin evidence for a third-party hosted pointer without promoting ownership', async () => {
    const { CrawlerService } = await import('../../src/crawler.js');
    const ctx = Object.create((CrawlerService as any).prototype);
    const updateHostedBrand = vi.fn().mockResolvedValue(undefined);
    Object.assign(ctx, {
      brandManager: {
        validateDomain: vi.fn().mockResolvedValue({
          valid: true,
          errors: [],
          warnings: [],
          domain: 'hosted.example',
          url: 'https://hosted.example/.well-known/brand.json',
          variant: 'authoritative_location',
          raw_data: {
            authoritative_location: 'https://cdn.provider.example/brands/hosted.json',
          },
        }),
      },
      brandDb: {
        getHostedBrandByDomain: vi.fn().mockResolvedValue({
          id: 'brand_hosted',
          domain_verified: true,
        }),
        updateHostedBrand,
      },
    });

    await expect(ctx.scanBrandForDomain('hosted.example')).resolves.toEqual({
      found: true,
      valid: true,
      variant: 'authoritative_location',
      manifestPersisted: false,
    });
    expect(updateHostedBrand).toHaveBeenCalledWith('brand_hosted', {
      origin_validated: true,
    });
  });
});
