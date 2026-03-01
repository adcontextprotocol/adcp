import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import axios from 'axios';
import { BrandManager } from '../../src/brand-manager.js';

// Mock axios
vi.mock('axios');
const mockedAxios = vi.mocked(axios, true);

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

      mockedAxios.get.mockResolvedValueOnce({
        status: 200,
        data: Buffer.from(JSON.stringify(mockBrandJson)),
      });

      // First call - should fetch
      const result1 = await manager.validateDomain('acme.com');
      expect(result1.valid).toBe(true);
      expect(mockedAxios.get).toHaveBeenCalledTimes(1);

      // Second call - should use cache
      const result2 = await manager.validateDomain('acme.com');
      expect(result2.valid).toBe(true);
      expect(mockedAxios.get).toHaveBeenCalledTimes(1); // Still 1

      // Results should be identical
      expect(result1.variant).toBe(result2.variant);
    });

    it('caches failed lookups separately', async () => {
      mockedAxios.get.mockResolvedValueOnce({
        status: 404,
        data: null,
      });

      // First call - should fetch and fail
      const result1 = await manager.validateDomain('missing.com');
      expect(result1.valid).toBe(false);
      expect(mockedAxios.get).toHaveBeenCalledTimes(1);

      // Second call - should use failed lookup cache
      const result2 = await manager.validateDomain('missing.com');
      expect(result2.valid).toBe(false);
      expect(mockedAxios.get).toHaveBeenCalledTimes(1); // Still 1
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

      mockedAxios.get.mockResolvedValue({
        status: 200,
        data: Buffer.from(JSON.stringify(mockBrandJson)),
      });

      // First call
      await manager.validateDomain('fresh.com');
      expect(mockedAxios.get).toHaveBeenCalledTimes(1);

      // Second call with skipCache - should fetch again
      await manager.validateDomain('fresh.com', { skipCache: true });
      expect(mockedAxios.get).toHaveBeenCalledTimes(2);
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

      mockedAxios.get.mockResolvedValueOnce({
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

      mockedAxios.get.mockResolvedValue({
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
      expect(mockedAxios.get).not.toHaveBeenCalled(); // Should not fetch
    });

    it('caches null results for failed resolutions', async () => {
      mockedAxios.get.mockResolvedValueOnce({
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
      expect(mockedAxios.get).not.toHaveBeenCalled();
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

      mockedAxios.get.mockResolvedValue({
        status: 200,
        data: Buffer.from(JSON.stringify(mockBrandJson)),
      });

      // First call
      await manager.resolveBrand('bypass.com');

      vi.clearAllMocks();

      // Second call with skipCache
      await manager.resolveBrand('bypass.com', { skipCache: true });
      expect(mockedAxios.get).toHaveBeenCalled();
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

      mockedAxios.get.mockResolvedValue({
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

      mockedAxios.get.mockResolvedValue({
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
