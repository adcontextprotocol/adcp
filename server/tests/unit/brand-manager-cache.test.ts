import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

vi.mock('../../src/utils/url-security.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/utils/url-security.js')>();
  return {
    ...actual,
    safeFetchAxiosLike: vi.fn(),
  };
});

import { BrandManager } from '../../src/brand-manager.js';
import { safeFetchAxiosLike } from '../../src/utils/url-security.js';

const mockedSafeFetch = vi.mocked(safeFetchAxiosLike);

describe('BrandManager caching', () => {
  let manager: BrandManager;

  beforeEach(() => {
    manager = new BrandManager();
    vi.clearAllMocks();
  });

  afterEach(() => {
    manager.clearCache();
  });

  describe('validateDomain caching', () => {
    it('caches successful validation results', async () => {
      const mockBrandJson = {
        $schema: 'https://adcontextprotocol.org/schemas/latest/brand.json',
        version: '1.0',
        house: {
          domain: 'acme.com',
          name: 'Acme Corp',
        },
        brands: [
          {
            id: 'acme',
            names: [{ en: 'Acme' }],
            keller_type: 'master',
          },
        ],
      };

      mockedSafeFetch.mockResolvedValueOnce({
        status: 200,
        data: Buffer.from(JSON.stringify(mockBrandJson)),
      });

      // First call - should fetch
      const result1 = await manager.validateDomain('acme.com');
      expect(result1.valid).toBe(true);
      expect(mockedSafeFetch).toHaveBeenCalledTimes(1);

      // Second call - should use cache
      const result2 = await manager.validateDomain('acme.com');
      expect(result2.valid).toBe(true);
      expect(mockedSafeFetch).toHaveBeenCalledTimes(1); // Still 1

      // Results should be identical
      expect(result1.variant).toBe(result2.variant);
    });

    it('caches failed lookups separately', async () => {
      mockedSafeFetch.mockResolvedValueOnce({
        status: 404,
        data: null,
      });

      // First call - should fetch and fail
      const result1 = await manager.validateDomain('missing.com');
      expect(result1.valid).toBe(false);
      expect(mockedSafeFetch).toHaveBeenCalledTimes(1);

      // Second call - should use failed lookup cache
      const result2 = await manager.validateDomain('missing.com');
      expect(result2.valid).toBe(false);
      expect(mockedSafeFetch).toHaveBeenCalledTimes(1); // Still 1
    });

    it('bypasses cache with skipCache option', async () => {
      const mockBrandJson = {
        $schema: 'https://adcontextprotocol.org/schemas/latest/brand.json',
        version: '1.0',
        house: {
          domain: 'fresh.com',
          name: 'Fresh Corp',
        },
        brands: [
          {
            id: 'fresh',
            names: [{ en: 'Fresh' }],
            keller_type: 'master',
          },
        ],
      };

      mockedSafeFetch.mockResolvedValue({
        status: 200,
        data: Buffer.from(JSON.stringify(mockBrandJson)),
      });

      // First call
      await manager.validateDomain('fresh.com');
      expect(mockedSafeFetch).toHaveBeenCalledTimes(1);

      // Second call with skipCache - should fetch again
      await manager.validateDomain('fresh.com', { skipCache: true });
      expect(mockedSafeFetch).toHaveBeenCalledTimes(2);
    });
  });

  describe('UTF-8 encoding', () => {
    it('preserves non-ASCII characters from brand.json', async () => {
      const mockBrandJson = {
        $schema: 'https://adcontextprotocol.org/schemas/latest/brand.json',
        version: '1.0',
        house: {
          domain: 'marabou.se',
          name: 'Marabou',
        },
        brands: [
          {
            id: 'marabou',
            names: [{ sv: 'Marabou' }],
            keller_type: 'master',
            brand_manifest: {
              description: 'Sveriges mest älskade choklad för alla smaker och tillfällen.',
            },
          },
        ],
      };

      mockedSafeFetch.mockResolvedValueOnce({
        status: 200,
        data: Buffer.from(JSON.stringify(mockBrandJson), 'utf-8'),
      });

      const result = await manager.validateDomain('marabou.se');
      expect(result.valid).toBe(true);
      const portfolio = result.raw_data as typeof mockBrandJson;
      expect(portfolio.brands[0].brand_manifest.description).toBe(
        'Sveriges mest älskade choklad för alla smaker och tillfällen.'
      );
    });
  });

  describe('resolveBrand caching', () => {
    it('caches brand resolution results', async () => {
      const mockBrandJson = {
        $schema: 'https://adcontextprotocol.org/schemas/latest/brand.json',
        version: '1.0',
        house: {
          domain: 'example.com',
          name: 'Example Corp',
        },
        brands: [
          {
            id: 'example',
            names: [{ en: 'Example' }],
            keller_type: 'master',
          },
        ],
      };

      mockedSafeFetch.mockResolvedValue({
        status: 200,
        data: Buffer.from(JSON.stringify(mockBrandJson)),
      });

      // First call - should fetch
      const result1 = await manager.resolveBrand('example.com');
      expect(result1).not.toBeNull();
      expect(result1?.brand_name).toBe('Example');

      // Clear call count but not caches
      vi.clearAllMocks();

      // Second call - should use cache
      const result2 = await manager.resolveBrand('example.com');
      expect(result2).not.toBeNull();
      expect(result2?.brand_name).toBe('Example');
      expect(mockedSafeFetch).not.toHaveBeenCalled(); // Should not fetch
    });

    it('caches null results for failed resolutions', async () => {
      mockedSafeFetch.mockResolvedValueOnce({
        status: 404,
        data: null,
      });

      // First call - should fail
      const result1 = await manager.resolveBrand('notfound.com');
      expect(result1).toBeNull();

      vi.clearAllMocks();

      // Second call - should use cache (no fetch)
      const result2 = await manager.resolveBrand('notfound.com');
      expect(result2).toBeNull();
      expect(mockedSafeFetch).not.toHaveBeenCalled();
    });

    it('bypasses cache with skipCache option', async () => {
      const mockBrandJson = {
        $schema: 'https://adcontextprotocol.org/schemas/latest/brand.json',
        version: '1.0',
        house: {
          domain: 'bypass.com',
          name: 'Bypass Corp',
        },
        brands: [
          {
            id: 'bypass',
            names: [{ en: 'Bypass' }],
            keller_type: 'master',
          },
        ],
      };

      mockedSafeFetch.mockResolvedValue({
        status: 200,
        data: Buffer.from(JSON.stringify(mockBrandJson)),
      });

      // First call
      await manager.resolveBrand('bypass.com');

      vi.clearAllMocks();

      // Second call with skipCache
      await manager.resolveBrand('bypass.com', { skipCache: true });
      expect(mockedSafeFetch).toHaveBeenCalled();
    });
  });

  describe('brand_manifest construction', () => {
    it('populates brand_manifest from flat brand fields (master-brand fallback)', async () => {
      const mockBrandJson = {
        $schema: 'https://adcontextprotocol.org/schemas/latest/brand.json',
        version: '1.0',
        house: {
          domain: 'wonderstruck.org',
          name: 'Wonderstruck',
        },
        brands: [
          {
            id: 'wonderstruck',
            names: [{ en: 'Wonderstruck' }],
            keller_type: 'master',
            description: 'A creative studio',
            target_audience: 'designers',
            tagline: 'Make wonder',
            logos: [{ url: 'https://wonderstruck.org/logo.svg' }],
            colors: { primary: '#ff00ff' },
            fonts: { primary: 'Inter' },
            tone: 'playful',
          },
        ],
      };

      mockedSafeFetch.mockResolvedValue({
        status: 200,
        data: Buffer.from(JSON.stringify(mockBrandJson)),
      });

      const result = await manager.resolveBrand('wonderstruck.org');
      expect(result).not.toBeNull();
      expect(result?.brand_manifest).toBeDefined();
      expect(result?.brand_manifest?.description).toBe('A creative studio');
      expect(result?.brand_manifest?.target_audience).toBe('designers');
      expect(result?.brand_manifest?.tagline).toBe('Make wonder');
      expect(result?.brand_manifest?.logos).toEqual([
        { url: 'https://wonderstruck.org/logo.svg' },
      ]);
      expect(result?.brand_manifest?.colors).toEqual({ primary: '#ff00ff' });
      expect(result?.brand_manifest?.fonts).toEqual({ primary: 'Inter' });
      expect(result?.brand_manifest?.tone).toBe('playful');
    });

    it('strips identity fields from brand_manifest', async () => {
      const mockBrandJson = {
        $schema: 'https://adcontextprotocol.org/schemas/latest/brand.json',
        version: '1.0',
        house: {
          domain: 'acme.com',
          name: 'Acme',
        },
        brands: [
          {
            id: 'acme',
            names: [{ en: 'Acme' }],
            keller_type: 'master',
            parent_brand: 'parent',
            description: 'A brand',
          },
        ],
      };

      mockedSafeFetch.mockResolvedValue({
        status: 200,
        data: Buffer.from(JSON.stringify(mockBrandJson)),
      });

      const result = await manager.resolveBrand('acme.com');
      expect(result?.brand_manifest).toBeDefined();
      expect(result?.brand_manifest).not.toHaveProperty('id');
      expect(result?.brand_manifest).not.toHaveProperty('names');
      expect(result?.brand_manifest).not.toHaveProperty('keller_type');
      expect(result?.brand_manifest).not.toHaveProperty('parent_brand');
      expect(result?.brand_manifest?.description).toBe('A brand');
    });

    it('returns brand_manifest from property-match resolution', async () => {
      const mockBrandJson = {
        $schema: 'https://adcontextprotocol.org/schemas/latest/brand.json',
        version: '1.0',
        house: {
          domain: 'house.com',
          name: 'House',
        },
        brands: [
          {
            id: 'subbrand',
            names: [{ en: 'Sub Brand' }],
            keller_type: 'sub_brand',
            description: 'A sub-brand',
            properties: [{ type: 'website', identifier: 'subbrand.com' }],
          },
        ],
      };

      mockedSafeFetch.mockResolvedValue({
        status: 200,
        data: Buffer.from(JSON.stringify(mockBrandJson)),
      });

      const result = await manager.resolveBrand('subbrand.com');
      expect(result).not.toBeNull();
      expect(result?.brand_manifest).toBeDefined();
      expect(result?.brand_manifest?.description).toBe('A sub-brand');
    });

    it('merges legacy nested brand_manifest with flat fields', async () => {
      const mockBrandJson = {
        $schema: 'https://adcontextprotocol.org/schemas/latest/brand.json',
        version: '1.0',
        house: {
          domain: 'legacy.com',
          name: 'Legacy',
        },
        brands: [
          {
            id: 'legacy',
            names: [{ en: 'Legacy' }],
            keller_type: 'master',
            description: 'Flat description',
            brand_manifest: {
              legacy_field: 'from-nested',
              description: 'Nested description (should be overridden)',
            },
          },
        ],
      };

      mockedSafeFetch.mockResolvedValue({
        status: 200,
        data: Buffer.from(JSON.stringify(mockBrandJson)),
      });

      const result = await manager.resolveBrand('legacy.com');
      expect(result?.brand_manifest).toBeDefined();
      expect(result?.brand_manifest?.legacy_field).toBe('from-nested');
      // Flat fields take precedence over legacy nested values
      expect(result?.brand_manifest?.description).toBe('Flat description');
    });

    it('omits brand_manifest when no manifest data is present', async () => {
      const mockBrandJson = {
        $schema: 'https://adcontextprotocol.org/schemas/latest/brand.json',
        version: '1.0',
        house: {
          domain: 'minimal.com',
          name: 'Minimal',
        },
        brands: [
          {
            id: 'minimal',
            names: [{ en: 'Minimal' }],
            keller_type: 'master',
          },
        ],
      };

      mockedSafeFetch.mockResolvedValue({
        status: 200,
        data: Buffer.from(JSON.stringify(mockBrandJson)),
      });

      const result = await manager.resolveBrand('minimal.com');
      expect(result).not.toBeNull();
      expect(result?.brand_manifest).toBeUndefined();
    });

    it('populates brand_manifest from resolveBrandRef with brand_id', async () => {
      const mockBrandJson = {
        $schema: 'https://adcontextprotocol.org/schemas/latest/brand.json',
        version: '1.0',
        house: {
          domain: 'multi.com',
          name: 'Multi',
        },
        brands: [
          {
            id: 'brand-a',
            names: [{ en: 'Brand A' }],
            keller_type: 'master',
            description: 'Brand A description',
          },
          {
            id: 'brand-b',
            names: [{ en: 'Brand B' }],
            keller_type: 'sub_brand',
            description: 'Brand B description',
          },
        ],
      };

      mockedSafeFetch.mockResolvedValue({
        status: 200,
        data: Buffer.from(JSON.stringify(mockBrandJson)),
      });

      const result = await manager.resolveBrandRef({
        domain: 'multi.com',
        brand_id: 'brand-b',
      });
      expect(result).not.toBeNull();
      expect(result?.brand_manifest?.description).toBe('Brand B description');
    });
  });

  describe('cache management', () => {
    it('getCacheStats returns correct counts', async () => {
      const mockBrandJson = {
        $schema: 'https://adcontextprotocol.org/schemas/latest/brand.json',
        version: '1.0',
        house: {
          domain: 'stats.com',
          name: 'Stats Corp',
        },
        brands: [
          {
            id: 'stats',
            names: [{ en: 'Stats' }],
            keller_type: 'master',
          },
        ],
      };

      mockedSafeFetch.mockResolvedValue({
        status: 200,
        data: Buffer.from(JSON.stringify(mockBrandJson)),
      });

      // Initial state
      let stats = manager.getCacheStats();
      expect(stats.validation).toBe(0);
      expect(stats.resolution).toBe(0);
      expect(stats.failed).toBe(0);

      // After successful validation
      await manager.validateDomain('stats.com');
      stats = manager.getCacheStats();
      expect(stats.validation).toBe(1);

      // After resolution
      await manager.resolveBrand('stats.com');
      stats = manager.getCacheStats();
      expect(stats.resolution).toBe(1);
    });

    it('clearCache clears all caches', async () => {
      const mockBrandJson = {
        $schema: 'https://adcontextprotocol.org/schemas/latest/brand.json',
        version: '1.0',
        house: {
          domain: 'clear.com',
          name: 'Clear Corp',
        },
        brands: [
          {
            id: 'clear',
            names: [{ en: 'Clear' }],
            keller_type: 'master',
          },
        ],
      };

      mockedSafeFetch.mockResolvedValue({
        status: 200,
        data: Buffer.from(JSON.stringify(mockBrandJson)),
      });

      await manager.validateDomain('clear.com');
      await manager.resolveBrand('clear.com');

      let stats = manager.getCacheStats();
      expect(stats.validation).toBeGreaterThan(0);

      manager.clearCache();

      stats = manager.getCacheStats();
      expect(stats.validation).toBe(0);
      expect(stats.resolution).toBe(0);
      expect(stats.failed).toBe(0);
    });
  });
});
