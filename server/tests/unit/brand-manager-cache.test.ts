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
      expect(mockedSafeFetch).toHaveBeenCalledWith(
        'https://acme.com/.well-known/brand.json',
        expect.objectContaining({ maxResponseBytes: 256 * 1024 }),
      );

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
      expect(result1.raw_data).toBeUndefined();
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
      expect((await manager.validateDomain('stable.example')).valid).toBe(true);
      expect(mockedSafeFetch).toHaveBeenCalledTimes(2);
    });

    it('rejects non-hostname lookup inputs without issuing a request', async () => {
      const result = await manager.validateDomain('public.example:8443/admin?probe=true');

      expect(result.valid).toBe(false);
      expect(result.errors).toEqual(expect.arrayContaining([
        expect.objectContaining({ field: 'domain' }),
      ]));
      expect(mockedSafeFetch).not.toHaveBeenCalled();
    });

    it('reports body-free diagnostics scoped to each resolution', async () => {
      const oversized = {
        id: 'oversized',
        names: [{ en: 'Oversized' }],
        description: 'x'.repeat(1024),
      };
      mockedSafeFetch
        .mockResolvedValueOnce({ status: 200, data: Buffer.from(JSON.stringify(oversized)) })
        .mockResolvedValueOnce({ status: 503, data: Buffer.from('unavailable') });

      const resolved = await manager.resolveBrandWithDiagnostics('body.example');
      expect(resolved.brand?.canonical_id).toBe('oversized');
      expect(resolved.last_attempt).not.toHaveProperty('raw_data');

      const failed = await manager.resolveBrandWithDiagnostics('other.example');
      expect(failed.brand).toBeNull();
      expect(failed.last_attempt).toMatchObject({
        domain: 'other.example',
        status_code: 503,
      });
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
              { type: 'website', identifier: 'distribution.example', relationship: 'direct' },
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
        { type: 'website', identifier: 'distribution.example', relationship: 'direct' },
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
        properties: [{ type: 'website', identifier: 'leaf.example', relationship: 'owned' }],
        legacy_metadata: {
          legacy_house: { domain: 'house.example', name: 'Example House' },
        },
      });
      expect(result.raw_data).not.toHaveProperty('house_domain');
      expect((result.raw_data as Record<string, any>).legacy_properties[0].relationship)
        .toBe('registered_account_operator');
    });

    it('rejects ambiguous legacy identity when the origin property is duplicated', async () => {
      const legacyBrandJson = {
        $schema: 'https://schemas.adcontextprotocol.org/brand/v1/brand.json',
        brands: [{
          id: 'ambiguous',
          name: 'Ambiguous',
          properties: [
            { type: 'website', identifier: 'ambiguous.example', relationship: 'owned' },
            { type: 'website', identifier: 'ambiguous.example', relationship: 'owned' },
          ],
        }],
      };
      mockedSafeFetch.mockResolvedValueOnce({
        status: 200,
        data: Buffer.from(JSON.stringify(legacyBrandJson)),
      });

      const result = await manager.validateDomain('ambiguous.example');

      expect(result.valid).toBe(false);
      expect(result.warnings).toEqual(expect.arrayContaining([
        expect.objectContaining({
          field: 'brands',
          message: expect.stringContaining('found 2'),
        }),
      ]));
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
      expect(result.raw_data).toBeUndefined();
    });

    it('does not retain an invalid parsed document in the failed cache', async () => {
      const invalidDocument = {
        id: 'invalid',
        names: [{ en: 'Invalid' }],
        properties: [{ type: 'website', identifier: 'invalid.example', relationship: 'bogus' }],
        attacker_padding: 'x'.repeat(64 * 1024),
      };
      mockedSafeFetch.mockResolvedValueOnce({
        status: 200,
        data: Buffer.from(JSON.stringify(invalidDocument)),
      });

      const first = await manager.validateDomain('invalid.example');
      const cached = await manager.validateDomain('invalid.example');

      expect(first.valid).toBe(false);
      expect(first.raw_data).toBeUndefined();
      expect(cached.raw_data).toBeUndefined();
      expect(mockedSafeFetch).toHaveBeenCalledTimes(1);
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

    it('reports the terminal redirect attempt that ended the resolution', async () => {
      const redirect = { house: 'house.example' };
      mockedSafeFetch
        .mockResolvedValueOnce({ status: 200, data: Buffer.from(JSON.stringify(redirect)) })
        .mockResolvedValueOnce({ status: 503, data: Buffer.from('unavailable') });

      const resolution = await manager.resolveBrandWithDiagnostics('leaf.example', { skipCache: true });

      expect(resolution.brand).toBeNull();
      expect(resolution.last_attempt).toMatchObject({
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
        relationship_trust: 'unverifiable',
        source: 'brand_json',
        brand_manifest: { description: 'Leaf-owned identity' },
      });
      expect(result?.house_domain).toBeUndefined();
      expect(result?.brand_manifest).not.toHaveProperty('house_domain');
      expect(result?.brand_manifest).not.toHaveProperty('$schema');
    });

    it('marks a valid house portfolio without reciprocity as leaf_only', async () => {
      const canonical = {
        id: 'leaf',
        names: [{ en: 'Leaf Brand' }],
        house_domain: 'house.example',
      };
      const silentPortfolio = {
        house: { domain: 'house.example', name: 'Example House' },
        brand_refs: [{ domain: 'different.example', brand_id: 'different' }],
      };
      mockedSafeFetch
        .mockResolvedValueOnce({ status: 200, data: Buffer.from(JSON.stringify(canonical)) })
        .mockResolvedValueOnce({ status: 200, data: Buffer.from(JSON.stringify(silentPortfolio)) });

      const result = await manager.resolveBrand('leaf.example');

      expect(result).toMatchObject({
        claimed_house_domain: 'house.example',
        relationship_trust: 'leaf_only',
      });
      expect(result?.house_domain).toBeUndefined();
    });

    it('marks a failed house fetch as unverifiable', async () => {
      const canonical = {
        id: 'leaf',
        names: [{ en: 'Leaf Brand' }],
        house_domain: 'house.example',
      };
      mockedSafeFetch
        .mockResolvedValueOnce({ status: 200, data: Buffer.from(JSON.stringify(canonical)) })
        .mockResolvedValueOnce({ status: 503, data: Buffer.from('unavailable') });

      const result = await manager.resolveBrand('leaf.example');

      expect(result).toMatchObject({
        claimed_house_domain: 'house.example',
        relationship_trust: 'unverifiable',
      });
    });

    it('marks a house redirect loop as unverifiable', async () => {
      const canonical = {
        id: 'leaf',
        names: [{ en: 'Leaf Brand' }],
        house_domain: 'house.example',
      };
      const loop = { house: 'house.example' };
      mockedSafeFetch
        .mockResolvedValueOnce({ status: 200, data: Buffer.from(JSON.stringify(canonical)) })
        .mockResolvedValueOnce({ status: 200, data: Buffer.from(JSON.stringify(loop)) });

      const result = await manager.resolveBrand('leaf.example');

      expect(result).toMatchObject({
        claimed_house_domain: 'house.example',
        relationship_trust: 'unverifiable',
      });
      expect(mockedSafeFetch).toHaveBeenCalledTimes(2);
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

    it('retains cached mutual trust when a fresh reciprocal check is temporarily unavailable', async () => {
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
        .mockResolvedValueOnce({ status: 200, data: Buffer.from(JSON.stringify(portfolio)) })
        .mockResolvedValueOnce({ status: 200, data: Buffer.from(JSON.stringify(canonical)) })
        .mockResolvedValueOnce({ status: 503, data: Buffer.from('temporarily unavailable') });

      expect(await manager.resolveBrand('leaf.example')).toMatchObject({
        relationship_trust: 'mutual',
        house_domain: 'house.example',
      });
      expect(await manager.resolveBrand('leaf.example', { skipCache: true })).toMatchObject({
        relationship_trust: 'mutual',
        house_domain: 'house.example',
      });

      vi.clearAllMocks();
      expect(await manager.resolveBrand('leaf.example')).toMatchObject({
        relationship_trust: 'mutual',
        house_domain: 'house.example',
      });
      expect(mockedSafeFetch).not.toHaveBeenCalled();
    });

    it('replaces cached mutual trust when the house returns a definitive non-portfolio document', async () => {
      const canonical = {
        id: 'leaf',
        names: [{ en: 'Leaf Brand' }],
        house_domain: 'house.example',
      };
      const portfolio = {
        house: { domain: 'house.example', name: 'Example House' },
        brand_refs: [{ domain: 'leaf.example', brand_id: 'leaf' }],
      };
      const replacement = { id: 'house', names: [{ en: 'House' }] };
      mockedSafeFetch
        .mockResolvedValueOnce({ status: 200, data: Buffer.from(JSON.stringify(canonical)) })
        .mockResolvedValueOnce({ status: 200, data: Buffer.from(JSON.stringify(portfolio)) })
        .mockResolvedValueOnce({ status: 200, data: Buffer.from(JSON.stringify(canonical)) })
        .mockResolvedValueOnce({ status: 200, data: Buffer.from(JSON.stringify(replacement)) });

      expect(await manager.resolveBrand('leaf.example')).toMatchObject({
        relationship_trust: 'mutual',
      });
      expect(await manager.resolveBrand('leaf.example', { skipCache: true })).toMatchObject({
        relationship_trust: 'unverifiable',
      });

      vi.clearAllMocks();
      expect(await manager.resolveBrand('leaf.example')).toMatchObject({
        relationship_trust: 'unverifiable',
      });
      expect(mockedSafeFetch).not.toHaveBeenCalled();
    });

    it('verifies a canonical house claim through an authoritative_location portfolio', async () => {
      const canonical = {
        id: 'leaf',
        names: [{ en: 'Leaf Brand' }],
        house_domain: 'house.example',
      };
      const pointer = {
        authoritative_location: 'https://cdn.house.example/portfolio/brand.json',
      };
      const portfolio = {
        house: { domain: 'house.example', name: 'Example House' },
        brand_refs: [{ domain: 'leaf.example', brand_id: 'leaf' }],
      };
      mockedSafeFetch
        .mockResolvedValueOnce({ status: 200, data: Buffer.from(JSON.stringify(canonical)) })
        .mockResolvedValueOnce({ status: 200, data: Buffer.from(JSON.stringify(pointer)) })
        .mockResolvedValueOnce({ status: 200, data: Buffer.from(JSON.stringify(portfolio)) });

      const result = await manager.resolveBrand('leaf.example');

      expect(result).toMatchObject({
        house_domain: 'house.example',
        claimed_house_domain: 'house.example',
        house_name: 'Example House',
        relationship_trust: 'mutual',
      });
      expect(mockedSafeFetch).toHaveBeenNthCalledWith(
        3,
        pointer.authoritative_location,
        expect.objectContaining({
          maxResponseBytes: 256 * 1024,
          sameSiteRedirectsOnly: true,
        }),
      );
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
        expect.objectContaining({
          maxResponseBytes: 256 * 1024,
          sameSiteRedirectsOnly: true,
        })
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

  // brand.json trust invariant: relationship trust requires reciprocation.
  // A House Redirect is the leaf's one-sided claim, so the named house's
  // document must name the leaf before its identity can answer for the leaf.
  describe('house redirect reciprocation', () => {
    const redirect = { house: 'house.example' };

    it('does not hand a house master brand to a domain the house never names', async () => {
      const portfolio = {
        house: { domain: 'house.example', name: 'Example House' },
        brands: [{
          id: 'house_master',
          names: [{ en: 'Example House' }],
          keller_type: 'master',
          properties: [{ type: 'website', identifier: 'house.example', relationship: 'owned' }],
        }],
      };
      mockedSafeFetch
        .mockResolvedValueOnce({ status: 200, data: Buffer.from(JSON.stringify(redirect)) })
        .mockResolvedValueOnce({ status: 200, data: Buffer.from(JSON.stringify(portfolio)) });

      const result = await manager.resolveBrand('squatter.example');

      expect(result).toMatchObject({
        canonical_id: 'squatter.example',
        canonical_domain: 'squatter.example',
        claimed_house_domain: 'house.example',
        relationship_trust: 'leaf_only',
      });
      expect(result?.house_domain).toBeUndefined();
      expect(result?.names).toBeUndefined();
    });

    it('resolves a redirect the house reciprocates with an owned property', async () => {
      const portfolio = {
        house: { domain: 'house.example', name: 'Example House' },
        brands: [{
          id: 'regional',
          names: [{ en: 'Regional Brand' }],
          properties: [{ type: 'website', identifier: 'regional.example', relationship: 'owned' }],
        }],
      };
      mockedSafeFetch
        .mockResolvedValueOnce({ status: 200, data: Buffer.from(JSON.stringify(redirect)) })
        .mockResolvedValueOnce({ status: 200, data: Buffer.from(JSON.stringify(portfolio)) });

      expect(await manager.resolveBrand('regional.example')).toMatchObject({
        canonical_id: 'regional',
        brand_name: 'Regional Brand',
        house_domain: 'house.example',
        relationship_trust: 'inline',
      });
    });

    it('treats a monetization property as a path to inventory, not an identity', async () => {
      const portfolio = {
        house: { domain: 'house.example', name: 'Example House' },
        brands: [{
          id: 'network',
          names: [{ en: 'Ad Network' }],
          properties: [{ type: 'website', identifier: 'publisher.example', relationship: 'delegated' }],
        }],
      };
      mockedSafeFetch
        .mockResolvedValueOnce({ status: 200, data: Buffer.from(JSON.stringify(redirect)) })
        .mockResolvedValueOnce({ status: 200, data: Buffer.from(JSON.stringify(portfolio)) });

      const result = await manager.resolveBrand('publisher.example');

      expect(result).toMatchObject({
        canonical_id: 'publisher.example',
        relationship_trust: 'leaf_only',
      });
      expect(result?.brand_name).not.toBe('Ad Network');
    });

    it('does not hand a house canonical document to an unnamed domain', async () => {
      const houseCanonical = {
        id: 'house_brand',
        names: [{ en: 'House Brand' }],
        properties: [{ type: 'website', identifier: 'house.example', relationship: 'owned' }],
      };
      mockedSafeFetch
        .mockResolvedValueOnce({ status: 200, data: Buffer.from(JSON.stringify(redirect)) })
        .mockResolvedValueOnce({ status: 200, data: Buffer.from(JSON.stringify(houseCanonical)) });

      const result = await manager.resolveBrand('squatter.example');

      expect(result).toMatchObject({
        canonical_id: 'squatter.example',
        claimed_house_domain: 'house.example',
        relationship_trust: 'leaf_only',
      });
      expect(result?.brand_name).not.toBe('House Brand');
    });

    it('resolves a redirect to a house canonical document that names the leaf', async () => {
      const houseCanonical = {
        id: 'house_brand',
        names: [{ en: 'House Brand' }],
        properties: [
          { type: 'website', identifier: 'house.example', relationship: 'owned' },
          { type: 'website', identifier: 'legacy.example', relationship: 'owned' },
        ],
      };
      mockedSafeFetch
        .mockResolvedValueOnce({ status: 200, data: Buffer.from(JSON.stringify(redirect)) })
        .mockResolvedValueOnce({ status: 200, data: Buffer.from(JSON.stringify(houseCanonical)) });

      expect(await manager.resolveBrand('legacy.example')).toMatchObject({
        canonical_id: 'house_brand',
        brand_name: 'House Brand',
      });
    });

    it('keeps a redirected brand agent pointer without adopting the house identity', async () => {
      const agentDocument = {
        brand_agent: { id: 'house_agent', url: 'https://agent.house.example/mcp' },
      };
      mockedSafeFetch
        .mockResolvedValueOnce({ status: 200, data: Buffer.from(JSON.stringify(redirect)) })
        .mockResolvedValueOnce({ status: 200, data: Buffer.from(JSON.stringify(agentDocument)) });

      expect(await manager.resolveBrand('squatter.example')).toMatchObject({
        canonical_id: 'squatter.example',
        canonical_domain: 'squatter.example',
        brand_agent_url: 'https://agent.house.example/mcp',
        claimed_house_domain: 'house.example',
        relationship_trust: 'leaf_only',
      });
    });
  });

  describe('mutual trust aging', () => {
    const canonical = {
      id: 'leaf',
      names: [{ en: 'Leaf Brand' }],
      house_domain: 'house.example',
    };
    const portfolio = {
      house: { domain: 'house.example', name: 'Example House' },
      brand_refs: [{ domain: 'leaf.example', brand_id: 'leaf' }],
    };

    it('stamps a mutual edge with the time both sides were seen', async () => {
      mockedSafeFetch
        .mockResolvedValueOnce({ status: 200, data: Buffer.from(JSON.stringify(canonical)) })
        .mockResolvedValueOnce({ status: 200, data: Buffer.from(JSON.stringify(portfolio)) });

      const result = await manager.resolveBrand('leaf.example');

      expect(result?.relationship_trust).toBe('mutual');
      expect(Date.parse(result?.relationship_verified_at ?? '')).toBeGreaterThan(0);
    });

    it('does not advance the verification time while reusing a retained edge', async () => {
      mockedSafeFetch
        .mockResolvedValueOnce({ status: 200, data: Buffer.from(JSON.stringify(canonical)) })
        .mockResolvedValueOnce({ status: 200, data: Buffer.from(JSON.stringify(portfolio)) })
        .mockResolvedValueOnce({ status: 200, data: Buffer.from(JSON.stringify(canonical)) })
        .mockResolvedValueOnce({ status: 503, data: Buffer.from('unavailable') });

      const verified = await manager.resolveBrand('leaf.example');
      const retained = await manager.resolveBrand('leaf.example', { skipCache: true });

      expect(retained?.relationship_trust).toBe('mutual');
      expect(retained?.relationship_verified_at).toBe(verified?.relationship_verified_at);
    });

    it('ages a retained edge out even while refreshes keep the cache entry alive', async () => {
      const hour = 60 * 60 * 1000;
      vi.useFakeTimers();
      try {
        mockedSafeFetch
          .mockResolvedValueOnce({ status: 200, data: Buffer.from(JSON.stringify(canonical)) })
          .mockResolvedValueOnce({ status: 200, data: Buffer.from(JSON.stringify(portfolio)) });
        expect((await manager.resolveBrand('leaf.example'))?.relationship_trust).toBe('mutual');

        // A refresh inside the window rewrites the cache entry with a fresh TTL,
        // so the entry outlives the verification it was built from.
        vi.advanceTimersByTime(12 * hour);
        mockedSafeFetch
          .mockResolvedValueOnce({ status: 200, data: Buffer.from(JSON.stringify(canonical)) })
          .mockResolvedValueOnce({ status: 503, data: Buffer.from('unavailable') });
        expect(
          (await manager.resolveBrand('leaf.example', { skipCache: true }))?.relationship_trust,
        ).toBe('mutual');

        vi.advanceTimersByTime(13 * hour);
        mockedSafeFetch
          .mockResolvedValueOnce({ status: 200, data: Buffer.from(JSON.stringify(canonical)) })
          .mockResolvedValueOnce({ status: 503, data: Buffer.from('unavailable') });
        const aged = await manager.resolveBrand('leaf.example', { skipCache: true });

        expect(aged).toMatchObject({
          relationship_trust: 'unverifiable',
          claimed_house_domain: 'house.example',
        });
        expect(aged?.house_domain).toBeUndefined();
        expect(aged?.relationship_verified_at).toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
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
