import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BRAND_JSON_HTTP_CACHE_TTL_SECONDS,
  BRAND_MANAGER_CACHE_TTL_SECONDS,
  BRAND_RESOLVE_HTTP_CACHE_TTL_SECONDS,
  brandJsonCacheControl,
  brandResolveCacheControl,
} from '../../src/services/brand-resolution-cache-policy.js';

describe('brand resolution cache policy', () => {
  it('uses conservative source and outcome-aware TTLs', () => {
    expect(BRAND_MANAGER_CACHE_TTL_SECONDS).toEqual({
      origin: 86_400,
      negative: 300,
    });
    expect(BRAND_JSON_HTTP_CACHE_TTL_SECONDS).toEqual({
      brand_json: 3_600,
      community: 900,
      enriched: 300,
      miss: 60,
    });
    expect(BRAND_RESOLVE_HTTP_CACHE_TTL_SECONDS).toEqual({
      hosted: 300,
      brand_json: 300,
      community: 120,
      enriched: 60,
      stub: 60,
      miss: 30,
    });
  });

  it('does not cache fresh resolver responses', () => {
    expect(brandJsonCacheControl('brand_json')).toBe('public, max-age=3600');
    expect(brandJsonCacheControl('miss')).toBe('public, max-age=60');
    expect(brandJsonCacheControl('error')).toBe('no-store');
    expect(brandResolveCacheControl('hosted')).toBe('public, max-age=300');
    expect(brandResolveCacheControl('enriched')).toBe('public, max-age=60');
    expect(brandResolveCacheControl('miss')).toBe('public, max-age=30');
    expect(brandResolveCacheControl('brand_json', true)).toBe('no-store');
    expect(brandResolveCacheControl('error')).toBe('no-store');
  });

  it('keeps the published TTL table aligned with this policy', () => {
    const docs = readFileSync(new URL('../../../docs/registry/index.mdx', import.meta.url), 'utf8');
    expect(docs).toContain('| `BrandManager`: successful origin validation or resolution | 24 hours |');
    expect(docs).toContain('| `BrandManager`: failed validation or resolution miss | 5 minutes |');
    expect(docs).toContain(`| \`GET /brands/:domain/brand.json\`: \`brand_json\` | \`${brandJsonCacheControl('brand_json')}\` (1 hour) |`);
    expect(docs).toContain(`| \`GET /brands/:domain/brand.json\`: \`community\` | \`${brandJsonCacheControl('community')}\` (15 minutes) |`);
    expect(docs).toContain(`| \`GET /brands/:domain/brand.json\`: \`enriched\` | \`${brandJsonCacheControl('enriched')}\` (5 minutes) |`);
    expect(docs).toContain(`| \`GET /brands/:domain/brand.json\`: 404 miss | \`${brandJsonCacheControl('miss')}\` (1 minute) |`);
    expect(docs).toContain('| `GET /brands/:domain/brand.json`: failure | `no-store` |');
    expect(docs).toContain(`| \`GET /api/brands/resolve\`: \`hosted\` or \`brand_json\` | \`${brandResolveCacheControl('hosted')}\` (5 minutes) |`);
    expect(docs).toContain(`| \`GET /api/brands/resolve\`: \`community\` | \`${brandResolveCacheControl('community')}\` (2 minutes) |`);
    expect(docs).toContain(`| \`GET /api/brands/resolve\`: \`enriched\` or \`stub\` | \`${brandResolveCacheControl('enriched')}\` (1 minute) |`);
    expect(docs).toContain(`| \`GET /api/brands/resolve\`: miss | \`${brandResolveCacheControl('miss')}\` (30 seconds) |`);
    expect(docs).toContain('| `GET /api/brands/resolve`: error or `fresh=true` | `no-store` |');
  });
});
