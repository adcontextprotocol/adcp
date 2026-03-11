import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockGetDiscoveredBrandByDomain, mockUpsertDiscoveredBrand, mockEditDiscoveredBrand, mockFetchBrandData } = vi.hoisted(() => ({
  mockGetDiscoveredBrandByDomain: vi.fn(),
  mockUpsertDiscoveredBrand: vi.fn().mockResolvedValue({}),
  mockEditDiscoveredBrand: vi.fn().mockResolvedValue({ brand: {}, revision_number: 2 }),
  mockFetchBrandData: vi.fn(),
}));

vi.mock('../../src/db/brand-db.js', () => ({
  brandDb: {
    getDiscoveredBrandByDomain: mockGetDiscoveredBrandByDomain,
    upsertDiscoveredBrand: mockUpsertDiscoveredBrand,
    editDiscoveredBrand: mockEditDiscoveredBrand,
  },
  BrandDatabase: class {
    getDiscoveredBrandByDomain = mockGetDiscoveredBrandByDomain;
    upsertDiscoveredBrand = mockUpsertDiscoveredBrand;
    editDiscoveredBrand = mockEditDiscoveredBrand;
  },
}));

vi.mock('../../src/services/brandfetch.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/brandfetch.js')>('../../src/services/brandfetch.js');
  return {
    ...actual,
    isBrandfetchConfigured: vi.fn().mockReturnValue(true),
    fetchBrandData: mockFetchBrandData,
  };
});

vi.mock('../../src/db/registry-requests-db.js', () => ({
  registryRequestsDb: {
    trackRequest: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../../src/brand-manager.js', () => ({
  BrandManager: class {
    resolveBrand = vi.fn().mockResolvedValue(null);
  },
}));

import { ENRICHMENT_CACHE_MAX_AGE_MS } from '../../src/services/brandfetch.js';
import { createBrandToolHandlers } from '../../src/addie/mcp/brand-tools.js';

describe('Brandfetch DB caching', () => {
  let handlers: Map<string, (args: Record<string, unknown>) => Promise<string>>;

  beforeEach(() => {
    vi.clearAllMocks();
    handlers = createBrandToolHandlers();
  });

  describe('research_brand', () => {
    const handler = () => handlers.get('research_brand')!;

    it('returns cached data when brand was enriched within 30 days', async () => {
      mockGetDiscoveredBrandByDomain.mockResolvedValue({
        id: 'test-id',
        domain: 'acme.com',
        has_brand_manifest: true,
        brand_manifest: {
          name: 'Acme Corp',
          url: 'https://acme.com',
          description: 'A test brand',
          logos: [{ url: 'https://acme.com/logo.svg', tags: ['logo'] }],
          colors: { primary: '#ff0000' },
          fonts: [{ name: 'Inter', role: 'body' }],
          company: { name: 'Acme Corp', industry: 'Technology' },
        },
        last_validated: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000), // 7 days ago
        source_type: 'enriched',
        brand_name: 'Acme Corp',
        brand_names: [],
        discovered_at: new Date(),
      });

      const result = JSON.parse(await handler()({ domain: 'acme.com' }));

      expect(result.success).toBe(true);
      expect(result.cached).toBe(true);
      expect(result.brand.name).toBe('Acme Corp');
      expect(result.logos).toHaveLength(1);
      expect(result.colors.primary).toBe('#ff0000');
      expect(result.company.name).toBe('Acme Corp');
      expect(mockFetchBrandData).not.toHaveBeenCalled();
    });

    it('calls Brandfetch when cached data is older than 30 days', async () => {
      mockGetDiscoveredBrandByDomain.mockResolvedValue({
        id: 'test-id',
        domain: 'stale.com',
        has_brand_manifest: true,
        brand_manifest: { name: 'Stale', url: 'https://stale.com' },
        last_validated: new Date(Date.now() - 45 * 24 * 60 * 60 * 1000), // 45 days ago
        source_type: 'enriched',
        brand_name: 'Stale',
        brand_names: [],
        discovered_at: new Date(),
      });

      mockFetchBrandData.mockResolvedValue({
        success: true,
        domain: 'stale.com',
        manifest: {
          name: 'Stale Corp',
          url: 'https://stale.com',
        },
      });

      const result = JSON.parse(await handler()({ domain: 'stale.com' }));

      expect(result.success).toBe(true);
      expect(result.cached).toBe(false);
      expect(mockFetchBrandData).toHaveBeenCalledWith('stale.com');
    });

    it('calls Brandfetch when no DB record exists', async () => {
      mockGetDiscoveredBrandByDomain.mockResolvedValue(null);

      mockFetchBrandData.mockResolvedValue({
        success: true,
        domain: 'new.com',
        manifest: {
          name: 'New Brand',
          url: 'https://new.com',
          description: 'Fresh brand',
        },
        company: { name: 'New Brand', industry: 'Retail' },
      });

      const result = JSON.parse(await handler()({ domain: 'new.com' }));

      expect(result.success).toBe(true);
      expect(result.cached).toBe(false);
      expect(result.brand.name).toBe('New Brand');
      expect(mockFetchBrandData).toHaveBeenCalledWith('new.com');
    });

    it('saves Brandfetch results to DB after fresh fetch', async () => {
      mockGetDiscoveredBrandByDomain.mockResolvedValue(null);

      mockFetchBrandData.mockResolvedValue({
        success: true,
        domain: 'save.com',
        manifest: {
          name: 'Save Corp',
          url: 'https://save.com',
          logos: [{ url: 'https://save.com/logo.svg', tags: ['logo'] }],
          colors: { primary: '#0000ff' },
        },
        company: { name: 'Save Corp' },
      });

      await handler()({ domain: 'save.com' });

      // Allow fire-and-forget to resolve
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(mockUpsertDiscoveredBrand).toHaveBeenCalledWith(
        expect.objectContaining({
          domain: 'save.com',
          brand_name: 'Save Corp',
          has_brand_manifest: true,
          source_type: 'enriched',
          brand_manifest: expect.objectContaining({
            name: 'Save Corp',
            url: 'https://save.com',
            company: { name: 'Save Corp' },
          }),
        })
      );
    });

    it('skips DB cache when brand has no manifest', async () => {
      mockGetDiscoveredBrandByDomain.mockResolvedValue({
        id: 'test-id',
        domain: 'empty.com',
        has_brand_manifest: false,
        brand_manifest: null,
        last_validated: new Date(),
        source_type: 'community',
        brand_name: 'Empty',
        brand_names: [],
        discovered_at: new Date(),
      });

      mockFetchBrandData.mockResolvedValue({
        success: true,
        domain: 'empty.com',
        manifest: { name: 'Empty', url: 'https://empty.com' },
      });

      const result = JSON.parse(await handler()({ domain: 'empty.com' }));

      expect(result.cached).toBe(false);
      expect(mockFetchBrandData).toHaveBeenCalled();
    });
  });

  describe('ENRICHMENT_CACHE_MAX_AGE_MS', () => {
    it('is 30 days in milliseconds', () => {
      expect(ENRICHMENT_CACHE_MAX_AGE_MS).toBe(30 * 24 * 60 * 60 * 1000);
    });
  });

  describe('research_brand quality validation', () => {
    const handler = () => handlers.get('research_brand')!;

    it('saves low-quality Brandfetch results as community', async () => {
      mockGetDiscoveredBrandByDomain.mockResolvedValue(null);

      mockFetchBrandData.mockResolvedValue({
        success: true,
        domain: 'lowquality.com',
        manifest: {
          name: 'Low Quality',
          url: 'https://lowquality.com',
        },
        highQuality: false,
      });

      await handler()({ domain: 'lowquality.com' });

      // Allow fire-and-forget to resolve
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(mockUpsertDiscoveredBrand).toHaveBeenCalledWith(
        expect.objectContaining({
          domain: 'lowquality.com',
          source_type: 'community',
        })
      );
    });

    it('saves high-quality Brandfetch results as enriched', async () => {
      mockGetDiscoveredBrandByDomain.mockResolvedValue(null);

      mockFetchBrandData.mockResolvedValue({
        success: true,
        domain: 'highquality.com',
        manifest: {
          name: 'High Quality',
          url: 'https://highquality.com',
          logos: [{ url: 'https://example.com/logo.svg', tags: ['logo'] }],
        },
        highQuality: true,
      });

      await handler()({ domain: 'highquality.com' });

      await new Promise(resolve => setTimeout(resolve, 10));

      expect(mockUpsertDiscoveredBrand).toHaveBeenCalledWith(
        expect.objectContaining({
          domain: 'highquality.com',
          source_type: 'enriched',
        })
      );
    });
  });

  describe('save_brand with industry', () => {
    const handler = () => handlers.get('save_brand')!;

    it('sets industry on a new brand via brand_manifest.company.industry', async () => {
      mockGetDiscoveredBrandByDomain.mockResolvedValue(null);
      mockUpsertDiscoveredBrand.mockResolvedValue({ domain: 'newbrand.com', id: 'test-id' });

      const result = JSON.parse(await handler()({
        domain: 'newbrand.com',
        brand_name: 'New Brand',
        industry: 'Healthcare',
      }));

      expect(result.success).toBe(true);
      expect(mockUpsertDiscoveredBrand).toHaveBeenCalledWith(
        expect.objectContaining({
          domain: 'newbrand.com',
          brand_name: 'New Brand',
          brand_manifest: expect.objectContaining({
            company: { industry: 'Healthcare' },
          }),
        })
      );
    });

    it('rejects empty industry string', async () => {
      const result = JSON.parse(await handler()({
        domain: 'test.com',
        brand_name: 'Test',
        industry: '',
      }));
      expect(result.error).toContain('industry must be 1-200 characters');
    });

    it('rejects whitespace-only industry', async () => {
      const result = JSON.parse(await handler()({
        domain: 'test.com',
        brand_name: 'Test',
        industry: '   ',
      }));
      expect(result.error).toContain('industry must be 1-200 characters');
    });

    it('merges industry into existing manifest on update', async () => {
      mockGetDiscoveredBrandByDomain.mockResolvedValue({
        id: 'existing-id',
        domain: 'existing.com',
        source_type: 'enriched',
        brand_name: 'Existing Brand',
        brand_manifest: {
          name: 'Existing Brand',
          url: 'https://existing.com',
          company: { name: 'Existing Corp', employees: '100' },
        },
        has_brand_manifest: true,
        review_status: 'approved',
      });
      mockEditDiscoveredBrand.mockResolvedValue({
        brand: { domain: 'existing.com', id: 'existing-id' },
        revision_number: 3,
      });

      const result = JSON.parse(await handler()({
        domain: 'existing.com',
        brand_name: 'Existing Brand',
        industry: 'Retail',
      }));

      expect(result.success).toBe(true);
      expect(mockEditDiscoveredBrand).toHaveBeenCalledWith(
        'existing.com',
        expect.objectContaining({
          brand_manifest: expect.objectContaining({
            company: expect.objectContaining({
              name: 'Existing Corp',
              employees: '100',
              industry: 'Retail',
            }),
          }),
        })
      );
    });
  });
});
