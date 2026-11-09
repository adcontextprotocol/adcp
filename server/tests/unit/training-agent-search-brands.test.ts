import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { handleSearchBrands } from '../../src/training-agent/brand-handlers.js';
import type { TrainingContext } from '../../src/training-agent/types.js';

const advertiserIndustries = (JSON.parse(readFileSync(new URL(
  '../../../static/schemas/source/enums/advertiser-industry.json',
  import.meta.url,
), 'utf8')) as { enum: string[] }).enum;

const ctx: TrainingContext = {
  mode: 'open',
  tenantId: 'brand',
  principal: 'test-buyer',
};

describe('training-agent search_brands', () => {
  it('returns schema-shaped brand stubs with canonical trust state and echoed context', () => {
    const result = handleSearchBrands({
      query: 'Mexican swimmer',
      countries: ['US'],
      context: { correlation_id: 'search-test' },
    }, ctx) as Record<string, any>;

    expect(result.status).toBe('completed');
    expect(result.context).toEqual({ correlation_id: 'search-test' });
    expect(result.brands).toHaveLength(1);
    expect(result.brands[0]).toMatchObject({
      brand_id: 'sofia_reyes',
      relationship_trust: 'inline',
      house: { domain: 'lotientertainment.com' },
      rights: { countries: expect.arrayContaining(['US']) },
    });
    expect(['mutual_assertion', 'one_sided_brand', 'one_sided_house', 'unverified'])
      .not.toContain(result.brands[0].relationship_trust);
  });

  it('paginates deterministically and rejects a cursor from another list', () => {
    const first = handleSearchBrands({
      query: '',
      pagination: { max_results: 1 },
    }, ctx) as Record<string, any>;

    expect(first.brands).toHaveLength(1);
    expect(first.pagination).toMatchObject({ has_more: true });
    expect(first.pagination.cursor).toEqual(expect.any(String));

    const second = handleSearchBrands({
      query: '',
      pagination: { max_results: 1, cursor: first.pagination.cursor },
    }, ctx) as Record<string, any>;
    expect(second.brands).toHaveLength(1);
    expect(second.brands[0].brand_id).not.toBe(first.brands[0].brand_id);

    const invalid = handleSearchBrands({
      query: '',
      pagination: { cursor: Buffer.from('list_accounts:offset:1').toString('base64url') },
    }, ctx) as Record<string, any>;
    expect(invalid.errors).toEqual([
      expect.objectContaining({ code: 'INVALID_REQUEST', field: 'pagination.cursor' }),
    ]);
  });

  it('asks the buyer to correct an absent query instead of throwing', () => {
    const result = handleSearchBrands({ context: { correlation_id: 'no-query' } }, ctx) as Record<string, any>;
    expect(result.errors).toEqual([
      expect.objectContaining({ code: 'INVALID_REQUEST', field: 'query', recovery: 'correctable' }),
    ]);
    expect(result.brands).toBeUndefined();
    expect(result.context).toEqual({ correlation_id: 'no-query' });
  });

  it('reports industries from the advertiser-industry taxonomy', () => {
    const allowed = new Set(advertiserIndustries);
    const result = handleSearchBrands({ query: '', pagination: { max_results: 100 } }, ctx) as Record<string, any>;
    const industries = (result.brands as Array<{ industries?: string[] }>).flatMap(brand => brand.industries ?? []);
    expect(industries.length).toBeGreaterThan(0);
    expect(industries.filter(industry => !allowed.has(industry))).toEqual([]);
  });

  it('carries the house a 3.1 result requires on every brand', () => {
    const current = handleSearchBrands({ query: '', pagination: { max_results: 100 } }, ctx) as Record<string, any>;
    const threeOne = handleSearchBrands(
      { query: '', pagination: { max_results: 100 } },
      { ...ctx, servedAdcpVersion: '3.1' },
    ) as Record<string, any>;
    // 3.2 makes house conditional on a recorded affiliation.
    expect((current.brands as Array<Record<string, unknown>>).some(brand => brand.house === undefined)).toBe(true);
    expect((threeOne.brands as Array<Record<string, unknown>>).filter(brand => brand.house === undefined)).toEqual([]);
  });
});
