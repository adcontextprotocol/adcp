import { describe, it, expect } from 'vitest';
import { extractPublisherPropertiesFromBrandJson } from '../../src/services/brand-json-properties.js';

describe('extractPublisherPropertiesFromBrandJson', () => {
  it('returns [] for null/undefined/empty manifest', () => {
    expect(extractPublisherPropertiesFromBrandJson(null)).toEqual([]);
    expect(extractPublisherPropertiesFromBrandJson(undefined)).toEqual([]);
    expect(extractPublisherPropertiesFromBrandJson({})).toEqual([]);
  });

  it('extracts top-level properties[]', () => {
    const result = extractPublisherPropertiesFromBrandJson({
      properties: [
        { identifier: 'Wonderstruck.org', type: 'website', relationship: 'owned' },
        { identifier: 'community.wonderstruck.org', type: 'website', relationship: 'direct' },
      ],
    });
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      type: 'website',
      name: 'wonderstruck.org',
      identifiers: [{ type: 'domain', value: 'wonderstruck.org' }],
      tags: ['relationship:owned'],
      source: 'brand_json',
    });
    // 'owned' has no adagents.json counterpart — delegation_type is not set
    expect(result[0].delegation_type).toBeUndefined();
    expect(result[1].tags).toEqual(['relationship:direct']);
    expect(result[1].delegation_type).toBe('direct');
  });

  it('maps relationship to delegation_type for bilateral-verification values', () => {
    const result = extractPublisherPropertiesFromBrandJson({
      properties: [
        { identifier: 'a.example', type: 'website', relationship: 'direct' },
        { identifier: 'b.example', type: 'website', relationship: 'delegated' },
        { identifier: 'c.example', type: 'website', relationship: 'ad_network' },
        { identifier: 'd.example', type: 'website', relationship: 'owned' },
        { identifier: 'e.example', type: 'website' },
      ],
    });
    expect(result[0].delegation_type).toBe('direct');
    expect(result[1].delegation_type).toBe('delegated');
    expect(result[2].delegation_type).toBe('ad_network');
    expect(result[3].delegation_type).toBeUndefined();
    expect(result[4].delegation_type).toBeUndefined();
  });

  it('extracts brands[].properties[] (house manifest shape)', () => {
    const result = extractPublisherPropertiesFromBrandJson({
      brands: [
        { name: 'Sub A', properties: [{ identifier: 'a.example', type: 'website' }] },
        { name: 'Sub B', properties: [{ identifier: 'b.example', type: 'website' }] },
      ],
    });
    expect(result.map((p) => p.name)).toEqual(['a.example', 'b.example']);
  });

  it('maps delegation_type through brands[].properties[] (house manifest shape)', () => {
    const result = extractPublisherPropertiesFromBrandJson({
      brands: [
        { name: 'Sub A', properties: [{ identifier: 'a.example', type: 'website', relationship: 'delegated' }] },
        { name: 'Sub B', properties: [{ identifier: 'b.example', type: 'website', relationship: 'owned' }] },
      ],
    });
    expect(result[0].delegation_type).toBe('delegated');
    expect(result[1].delegation_type).toBeUndefined();
  });

  it('dedupes the same identifier across top-level and house shapes', () => {
    const result = extractPublisherPropertiesFromBrandJson({
      properties: [{ identifier: 'shared.example', type: 'website' }],
      brands: [{ properties: [{ identifier: 'shared.example', type: 'website' }] }],
    });
    expect(result).toHaveLength(1);
  });

  it('skips entries without an identifier', () => {
    const result = extractPublisherPropertiesFromBrandJson({
      properties: [
        { type: 'website' },
        { identifier: '', type: 'website' },
        { identifier: 'ok.example', type: 'website' },
      ],
    });
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('ok.example');
  });

  it('preserves identifiers for non-website types using a generic type tag', () => {
    const result = extractPublisherPropertiesFromBrandJson({
      properties: [
        { identifier: 'com.acme.app', type: 'mobile_app' },
        { identifier: 'roku.acme.tv', type: 'ctv_app' },
      ],
    });
    expect(result[0]).toMatchObject({
      type: 'mobile_app',
      identifiers: [{ type: 'mobile_app', value: 'com.acme.app' }],
    });
    expect(result[1]).toMatchObject({
      type: 'ctv_app',
      identifiers: [{ type: 'ctv_app', value: 'roku.acme.tv' }],
    });
  });

  it('caps walking at MAX_BRAND_JSON_PROPERTIES (5000) to bound work on hostile manifests', () => {
    const big = Array.from({ length: 6000 }, (_, i) => ({
      identifier: `prop-${i}.example`,
      type: 'website',
    }));
    const result = extractPublisherPropertiesFromBrandJson({ properties: big });
    expect(result).toHaveLength(5000);
  });

  it('defaults type=website and omits relationship tag when missing', () => {
    const result = extractPublisherPropertiesFromBrandJson({
      properties: [{ identifier: 'plain.example' }],
    });
    expect(result[0]).toMatchObject({
      type: 'website',
      tags: [],
      identifiers: [{ type: 'domain', value: 'plain.example' }],
    });
  });
});
