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

    it('retains a prior positive cache while exposing the latest fresh failure', async () => {
      const validDocument = {
        id: 'stable',
        names: [{ en: 'Stable' }],
      };
      mockedSafeFetch
        .mockResolvedValueOnce({ status: 200, data: Buffer.from(JSON.stringify(validDocument)) })
        .mockResolvedValueOnce({ status: 503, data: Buffer.from('unavailable') });

      expect((await manager.validateDomain('stable.example')).valid).toBe(true);
      expect((await manager.validateDomain('stable.example', { skipCache: true })).valid).toBe(false);
      expect(manager.getLastValidationResult('stable.example')?.status_code).toBe(503);
      expect((await manager.validateDomain('stable.example')).valid).toBe(true);
      expect(mockedSafeFetch).toHaveBeenCalledTimes(2);
    });

    it('promotes the narrow legacy portfolio shape without inventing trust relationships', async () => {
      const legacyBrandJson = {
        $schema: 'https://schemas.adcontextprotocol.org/brand/v1/brand.json',
        name: 'Example House',
        domain: 'example.com',
        legal_operator: {
          name: 'Example LLC',
          domain: 'example.com',
          relationship: 'registered_account_operator',
        },
        brands: [
          {
            id: 'example',
            name: 'Example',
            properties: [
              { type: 'website', identifier: 'example.com', relationship: 'owned' },
              { type: 'website', identifier: 'alias.example' },
            ],
          },
          {
            id: 'partner',
            name: 'Partner',
            properties: [
              {
                type: 'website',
                identifier: 'partner.com',
                relationship: 'operated_publisher_brand',
              },
            ],
          },
        ],
      };
      mockedSafeFetch.mockResolvedValueOnce({
        status: 200,
        data: Buffer.from(JSON.stringify(legacyBrandJson)),
      });

      const result = await manager.validateDomain('example.com');

      expect(result.valid).toBe(true);
      expect(result.variant).toBe('brand_canonical');
      expect(result.promoted_from_schema).toBe(legacyBrandJson.$schema);
      expect(result.warnings).toEqual(expect.arrayContaining([
        expect.objectContaining({ field: 'brands' }),
        expect.objectContaining({ field: 'legal_operator' }),
      ]));
      const promoted = result.raw_data as Record<string, any>;
      expect(promoted.$schema).toBe('https://adcontextprotocol.org/schemas/v3/brand.json');
      expect(promoted.names).toEqual([{ und: 'Example' }, { und: 'Example House' }]);
      expect(promoted.properties).toEqual([
        { type: 'website', identifier: 'example.com', relationship: 'owned' },
      ]);
      expect(promoted.legacy_properties).toEqual([
        { type: 'website', identifier: 'alias.example' },
      ]);
      expect(promoted.legacy_metadata.unpromoted_brands[0].id).toBe('partner');
      expect(promoted.legacy_metadata.legal_operator).toEqual(legacyBrandJson.legal_operator);

      const resolved = await manager.resolveBrand('example.com');
      expect(resolved).toMatchObject({
        source: 'brand_json',
        relationship_trust: 'standalone',
        promoted_from_schema: legacyBrandJson.$schema,
      });
      expect(resolved?.migration_warnings?.length).toBeGreaterThan(0);
    });

    it('promotes a leaf-hosted legacy shape to a canonical v3 document', async () => {
      const legacyBrandJson = {
        $schema: 'https://schemas.adcontextprotocol.org/brand/v1/brand.json',
        name: 'Leaf Brand',
        domain: 'leaf.example',
        house: { domain: 'house.example', name: 'Example House' },
        brands: [{
          id: 'leaf',
          name: 'Leaf Brand',
          properties: [
            { type: 'website', identifier: 'leaf.example', relationship: 'owned' },
            {
              type: 'website',
              identifier: 'house.example',
              relationship: 'registered_account_operator',
            },
          ],
        }],
      };
      mockedSafeFetch.mockResolvedValueOnce({
        status: 200,
        data: Buffer.from(JSON.stringify(legacyBrandJson)),
      });

      const result = await manager.validateDomain('leaf.example');

      expect(result.valid).toBe(true);
      expect(result.variant).toBe('brand_canonical');
      expect(result.raw_data).toMatchObject({
        id: 'leaf',
        names: [{ und: 'Leaf Brand' }],
        house_domain: 'house.example',
        properties: [{ type: 'website', identifier: 'leaf.example', relationship: 'owned' }],
      });
      expect((result.raw_data as Record<string, any>).legacy_properties[0].relationship)
        .toBe('registered_account_operator');
    });

    it.each([
      {
        label: 'a forbidden canonical brand_refs field',
        document: {
          id: 'leaf',
          names: [{ en: 'Leaf' }],
          brand_refs: [{ domain: 'child.example', brand_id: 'child' }],
        },
      },
      {
        label: 'an unsupported property relationship',
        document: {
          id: 'leaf',
          names: [{ en: 'Leaf' }],
          properties: [{ type: 'website', identifier: 'leaf.example', relationship: 'bogus' }],
        },
      },
    ])('rejects v3 documents containing $label', async ({ document }) => {
      mockedSafeFetch.mockResolvedValueOnce({
        status: 200,
        data: Buffer.from(JSON.stringify(document)),
      });

      const result = await manager.validateDomain('leaf.example');

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('rejects a House Portfolio whose house.domain is not bound to the TLS origin', async () => {
      const forgedPortfolio = {
        house: { domain: 'trusted.example', name: 'Trusted House' },
        brands: [{
          id: 'evil',
          names: [{ en: 'Evil' }],
          properties: [{ type: 'website', identifier: 'evil.example', relationship: 'owned' }],
        }],
      };
      mockedSafeFetch.mockResolvedValueOnce({
        status: 200,
        data: Buffer.from(JSON.stringify(forgedPortfolio)),
      });

      const result = await manager.validateDomain('evil.example');

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(expect.objectContaining({ field: 'house.domain' }));
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

    it('does not replace a positive resolution cache on a transient fresh failure', async () => {
      const canonical = { id: 'stable', names: [{ en: 'Stable' }] };
      mockedSafeFetch
        .mockResolvedValueOnce({ status: 200, data: Buffer.from(JSON.stringify(canonical)) })
        .mockResolvedValueOnce({ status: 503, data: Buffer.from('unavailable') });

      expect((await manager.resolveBrand('stable.example'))?.brand_name).toBe('Stable');
      expect(await manager.resolveBrand('stable.example', { skipCache: true })).toBeNull();
      expect((await manager.resolveBrand('stable.example'))?.brand_name).toBe('Stable');
      expect(mockedSafeFetch).toHaveBeenCalledTimes(2);
    });

    it('retains terminal redirect diagnostics under the originally requested domain', async () => {
      const redirect = { house: 'house.example' };
      mockedSafeFetch
        .mockResolvedValueOnce({ status: 200, data: Buffer.from(JSON.stringify(redirect)) })
        .mockResolvedValueOnce({ status: 503, data: Buffer.from('unavailable') });

      expect(await manager.resolveBrand('leaf.example', { skipCache: true })).toBeNull();
      expect(manager.getLastValidationResult('leaf.example')).toMatchObject({
        valid: false,
        domain: 'house.example',
        status_code: 503,
      });
    });

    it('resolves a v3 Brand Canonical Document', async () => {
      const canonical = {
        $schema: 'https://adcontextprotocol.org/schemas/v3/brand.json',
        id: 'leaf',
        names: [{ en: 'Leaf Brand' }],
        house_domain: 'house.example',
        description: 'Leaf-owned identity',
        properties: [{ type: 'website', identifier: 'leaf.example', relationship: 'owned' }],
      };
      mockedSafeFetch.mockResolvedValueOnce({
        status: 200,
        data: Buffer.from(JSON.stringify(canonical)),
      });

      const result = await manager.resolveBrand('leaf.example');

      expect(result).toMatchObject({
        canonical_id: 'leaf',
        canonical_domain: 'leaf.example',
        brand_name: 'Leaf Brand',
        claimed_house_domain: 'house.example',
        relationship_trust: 'leaf_only',
        source: 'brand_json',
        brand_manifest: { description: 'Leaf-owned identity' },
      });
      expect(result?.house_domain).toBeUndefined();
      expect(result?.brand_manifest).not.toHaveProperty('house_domain');
      expect(result?.brand_manifest).not.toHaveProperty('$schema');
    });

    it('follows a house brand_refs pointer only to the matching canonical brand', async () => {
      const portfolio = {
        $schema: 'https://adcontextprotocol.org/schemas/v3/brand.json',
        house: { domain: 'house.example', name: 'Example House' },
        brand_refs: [{ domain: 'leaf.example', brand_id: 'leaf' }],
      };
      const canonical = {
        $schema: 'https://adcontextprotocol.org/schemas/v3/brand.json',
        id: 'leaf',
        names: [{ en: 'Leaf Brand' }],
        house_domain: 'house.example',
      };
      mockedSafeFetch
        .mockResolvedValueOnce({ status: 200, data: Buffer.from(JSON.stringify(portfolio)) })
        .mockResolvedValueOnce({ status: 200, data: Buffer.from(JSON.stringify(canonical)) });

      const result = await manager.resolveBrandRef({
        domain: 'house.example',
        brand_id: 'leaf',
      });

      expect(result).toMatchObject({
        canonical_id: 'leaf',
        canonical_domain: 'leaf.example',
        brand_name: 'Leaf Brand',
        house_domain: 'house.example',
        claimed_house_domain: 'house.example',
        relationship_trust: 'mutual',
        source: 'brand_json',
      });
      expect(mockedSafeFetch).toHaveBeenCalledTimes(2);
    });

    it('marks a one-sided house pointer as house_only without trusting parentage', async () => {
      const portfolio = {
        house: { domain: 'house.example', name: 'Example House' },
        brand_refs: [{ domain: 'leaf.example', brand_id: 'leaf' }],
      };
      const standaloneLeaf = {
        id: 'leaf',
        names: [{ en: 'Leaf Brand' }],
      };
      mockedSafeFetch
        .mockResolvedValueOnce({ status: 200, data: Buffer.from(JSON.stringify(portfolio)) })
        .mockResolvedValueOnce({ status: 200, data: Buffer.from(JSON.stringify(standaloneLeaf)) });

      const result = await manager.resolveBrandRef({
        domain: 'house.example',
        brand_id: 'leaf',
      });

      expect(result).toMatchObject({
        relationship_trust: 'house_only',
        canonical_domain: 'leaf.example',
      });
      expect(result?.house_domain).toBeUndefined();
      expect(result?.claimed_house_domain).toBeUndefined();
    });

    it('verifies a direct canonical house claim through reciprocal brand_refs', async () => {
      const canonical = {
        id: 'leaf',
        names: [{ en: 'Leaf Brand' }],
        house_domain: 'house.example',
      };
      const portfolio = {
        house: { domain: 'house.example', name: 'Example House' },
        brand_refs: [{ domain: 'leaf.example', brand_id: 'leaf' }],
      };
      mockedSafeFetch
        .mockResolvedValueOnce({ status: 200, data: Buffer.from(JSON.stringify(canonical)) })
        .mockResolvedValueOnce({ status: 200, data: Buffer.from(JSON.stringify(portfolio)) });

      const result = await manager.resolveBrand('leaf.example');

      expect(result).toMatchObject({
        house_domain: 'house.example',
        claimed_house_domain: 'house.example',
        house_name: 'Example House',
        relationship_trust: 'mutual',
      });
    });

    it('fetches authoritative_location at the exact published URL', async () => {
      const pointer = {
        authoritative_location: 'https://cdn.example/custom/brand.json',
      };
      const canonical = {
        id: 'cdn_brand',
        names: [{ en: 'CDN Brand' }],
      };
      mockedSafeFetch
        .mockResolvedValueOnce({ status: 200, data: Buffer.from(JSON.stringify(pointer)) })
        .mockResolvedValueOnce({ status: 200, data: Buffer.from(JSON.stringify(canonical)) });

      const result = await manager.resolveBrand('origin.example');

      expect(result).toMatchObject({
        canonical_id: 'cdn_brand',
        canonical_domain: 'origin.example',
        relationship_trust: 'standalone',
      });
      expect(mockedSafeFetch).toHaveBeenNthCalledWith(
        2,
        'https://cdn.example/custom/brand.json',
        expect.objectContaining({ sameSiteRedirectsOnly: true })
      );
    });

    it('does not follow brand_refs from a portfolio forged for another house origin', async () => {
      const forgedPortfolio = {
        house: { domain: 'trusted.example', name: 'Trusted House' },
        brand_refs: [{ domain: 'leaf.example', brand_id: 'leaf' }],
      };
      mockedSafeFetch.mockResolvedValueOnce({
        status: 200,
        data: Buffer.from(JSON.stringify(forgedPortfolio)),
      });

      const result = await manager.resolveBrandRef({
        domain: 'evil.example',
        brand_id: 'leaf',
      });

      expect(result).toBeNull();
      expect(mockedSafeFetch).toHaveBeenCalledTimes(1);
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

      mockedSafeFetch
        .mockResolvedValueOnce({
          status: 200,
          data: Buffer.from(JSON.stringify({ house: 'house.com' })),
        })
        .mockResolvedValueOnce({
          status: 200,
          data: Buffer.from(JSON.stringify(mockBrandJson)),
        });

      const result = await manager.resolveBrand('subbrand.com');
      expect(result).not.toBeNull();
      expect(result?.brand_manifest).toBeDefined();
      expect(result?.brand_manifest?.description).toBe('A sub-brand');
      // properties is ownership/identity data, not creative payload — must
      // not leak into brand_manifest, which downstream consumers treat as
      // logos/colors/fonts/tone (see services/brand-enrichment.ts).
      expect(result?.brand_manifest).not.toHaveProperty('properties');
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
            id: 'brand_a',
            names: [{ en: 'Brand A' }],
            keller_type: 'master',
            description: 'Brand A description',
          },
          {
            id: 'brand_b',
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
        brand_id: 'brand_b',
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
