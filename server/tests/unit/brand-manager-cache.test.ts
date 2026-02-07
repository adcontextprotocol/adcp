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
        $schema: 'https://adcontextprotocol.org/schemas/v1/brand.json',
        version: '1.0',
        house: {
          canonical_domain: 'acme.com',
          name: 'Acme Corp',
        },
        brands: [
          {
            canonical_domain: 'acme.com',
            names: [{ en: 'Acme' }],
            keller_type: 'master',
          },
        ],
      };

      mockedAxios.get.mockResolvedValueOnce({
        status: 200,
        data: mockBrandJson,
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
        $schema: 'https://adcontextprotocol.org/schemas/v1/brand.json',
        version: '1.0',
        house: {
          canonical_domain: 'fresh.com',
          name: 'Fresh Corp',
        },
        brands: [
          {
            canonical_domain: 'fresh.com',
            names: [{ en: 'Fresh' }],
            keller_type: 'master',
          },
        ],
      };

      mockedAxios.get.mockResolvedValue({
        status: 200,
        data: mockBrandJson,
      });

      // First call
      await manager.validateDomain('fresh.com');
      expect(mockedAxios.get).toHaveBeenCalledTimes(1);

      // Second call with skipCache - should fetch again
      await manager.validateDomain('fresh.com', { skipCache: true });
      expect(mockedAxios.get).toHaveBeenCalledTimes(2);
    });
  });

  describe('resolveBrand caching', () => {
    it('caches brand resolution results', async () => {
      const mockBrandJson = {
        $schema: 'https://adcontextprotocol.org/schemas/v1/brand.json',
        version: '1.0',
        house: {
          canonical_domain: 'example.com',
          name: 'Example Corp',
        },
        brands: [
          {
            canonical_domain: 'example.com',
            names: [{ en: 'Example' }],
            keller_type: 'master',
          },
        ],
      };

      mockedAxios.get.mockResolvedValue({
        status: 200,
        data: mockBrandJson,
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
        $schema: 'https://adcontextprotocol.org/schemas/v1/brand.json',
        version: '1.0',
        house: {
          canonical_domain: 'bypass.com',
          name: 'Bypass Corp',
        },
        brands: [
          {
            canonical_domain: 'bypass.com',
            names: [{ en: 'Bypass' }],
            keller_type: 'master',
          },
        ],
      };

      mockedAxios.get.mockResolvedValue({
        status: 200,
        data: mockBrandJson,
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
        $schema: 'https://adcontextprotocol.org/schemas/v1/brand.json',
        version: '1.0',
        house: {
          canonical_domain: 'stats.com',
          name: 'Stats Corp',
        },
        brands: [
          {
            canonical_domain: 'stats.com',
            names: [{ en: 'Stats' }],
            keller_type: 'master',
          },
        ],
      };

      mockedAxios.get.mockResolvedValue({
        status: 200,
        data: mockBrandJson,
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
        $schema: 'https://adcontextprotocol.org/schemas/v1/brand.json',
        version: '1.0',
        house: {
          canonical_domain: 'clear.com',
          name: 'Clear Corp',
        },
        brands: [
          {
            canonical_domain: 'clear.com',
            names: [{ en: 'Clear' }],
            keller_type: 'master',
          },
        ],
      };

      mockedAxios.get.mockResolvedValue({
        status: 200,
        data: mockBrandJson,
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
