import { describe, it, expect } from 'vitest';
import {
  dimensionalDeliveryBreakdowns,
  deliveryDeviceTypes,
  sellsKeywordInventory,
  TRAINING_GEO_BREAKDOWN_SUPPORT,
  type DimensionalBreakdownInput,
} from '../../src/training-agent/delivery-breakdowns.js';

const TOTALS = { impressions: 100_001, spend: 1234.57, clicks: 999 };

function input(overrides: Partial<DimensionalBreakdownInput> = {}): DimensionalBreakdownInput {
  return {
    reporting: {
      supports_geo_breakdown: TRAINING_GEO_BREAKDOWN_SUPPORT,
      supports_device_type_breakdown: true,
      supports_keyword_breakdown: true,
    },
    channels: ['display'],
    coverageCountries: undefined,
    targeting: undefined,
    totals: TOTALS,
    dimensions: {},
    ...overrides,
  };
}

function sum(rows: Array<Record<string, unknown>>, metric: string): number {
  return rows.reduce((total, row) => total + (row[metric] as number), 0);
}

function expectReconciles(rows: Array<Record<string, unknown>>) {
  expect(sum(rows, 'impressions')).toBe(TOTALS.impressions);
  expect(sum(rows, 'clicks')).toBe(TOTALS.clicks);
  expect(Math.round(sum(rows, 'spend') * 100)).toBe(Math.round(TOTALS.spend * 100));
}

describe('sellsKeywordInventory / deliveryDeviceTypes', () => {
  it('flags search and retail_media only', () => {
    expect(sellsKeywordInventory(['search'])).toBe(true);
    expect(sellsKeywordInventory(['display', 'retail_media'])).toBe(true);
    expect(sellsKeywordInventory(['display'])).toBe(false);
    expect(sellsKeywordInventory(undefined)).toBe(false);
  });

  it('maps screen, audio, ctv, and dooh channels to device types', () => {
    expect(deliveryDeviceTypes(['display'])).toEqual(['mobile', 'desktop', 'tablet']);
    expect(deliveryDeviceTypes(['podcast'])).toEqual(['mobile', 'desktop']);
    expect(deliveryDeviceTypes(['ctv'])).toEqual(['ctv']);
    expect(deliveryDeviceTypes(['dooh'])).toEqual(['dooh']);
    expect(deliveryDeviceTypes(['display', 'ctv'])).toEqual(['mobile', 'desktop', 'tablet', 'ctv']);
  });

  it('returns none for print, radio, and linear_tv', () => {
    expect(deliveryDeviceTypes(['print', 'radio', 'linear_tv'])).toEqual([]);
    expect(deliveryDeviceTypes(undefined)).toEqual([]);
  });
});

describe('dimensionalDeliveryBreakdowns — gating', () => {
  it('returns nothing when no dimension is requested', () => {
    expect(dimensionalDeliveryBreakdowns(input({ dimensions: undefined }))).toEqual({});
    expect(dimensionalDeliveryBreakdowns(input({ dimensions: {} }))).toEqual({});
  });

  it('returns nothing when the capability is not declared', () => {
    const out = dimensionalDeliveryBreakdowns(input({
      reporting: {},
      dimensions: { geo: { geo_level: 'country' }, device_type: {}, keyword: {} },
    }));
    expect(out).toEqual({});
  });

  it('omits device_type for channels without device types even when declared', () => {
    const out = dimensionalDeliveryBreakdowns(input({ channels: ['linear_tv'], dimensions: { device_type: {} } }));
    expect(out.by_device_type).toBeUndefined();
  });

  it('omits a geo level the product does not declare', () => {
    const out = dimensionalDeliveryBreakdowns(input({
      reporting: { supports_geo_breakdown: { country: true } },
      dimensions: { geo: { geo_level: 'region' } },
    }));
    expect(out).toEqual({});
  });
});

describe('dimensionalDeliveryBreakdowns — geo', () => {
  const geo = (dimension: Record<string, unknown>, rest: Partial<DimensionalBreakdownInput> = {}) =>
    dimensionalDeliveryBreakdowns(input({ dimensions: { geo: dimension }, ...rest }));

  it('uses package geo_countries first', () => {
    const out = geo({ geo_level: 'country' }, {
      targeting: { geo_countries: ['US', 'CA'] },
      coverageCountries: ['GB'],
    });
    const rows = out.by_geo as Array<Record<string, unknown>>;
    expect(rows.map(r => r.geo_code).sort()).toEqual(['CA', 'US']);
    expect(rows[0]).toMatchObject({ geo_level: 'country' });
    expectReconciles(rows);
    expect(out.by_geo_truncated).toBe(false);
  });

  it('falls back to product coverage, then US', () => {
    const covered = geo({ geo_level: 'country' }, { coverageCountries: ['GB', 'DE'] });
    expect((covered.by_geo as Array<Record<string, unknown>>).map(r => r.geo_code).sort()).toEqual(['DE', 'GB']);
    const fallback = geo({ geo_level: 'country' });
    expect((fallback.by_geo as Array<Record<string, unknown>>).map(r => r.geo_code)).toEqual(['US']);
  });

  it('derives region rows from geo_regions else per-country defaults', () => {
    const targeted = geo({ geo_level: 'region' }, { targeting: { geo_regions: ['US-CA', 'US-NY'] } });
    expect((targeted.by_geo as Array<Record<string, unknown>>).map(r => r.geo_code).sort()).toEqual(['US-CA', 'US-NY']);
    const defaults = geo({ geo_level: 'region' }, { targeting: { geo_countries: ['US', 'CA'] } });
    const rows = defaults.by_geo as Array<Record<string, unknown>>;
    expect(rows.map(r => r.geo_code)).toEqual(expect.arrayContaining(['US-CA', 'US-TX', 'CA-ON']));
    expect(rows).toHaveLength(8);
    expectReconciles(rows);
  });

  it('reports metro rows only for nielsen_dma and only when US is covered', () => {
    const us = geo({ geo_level: 'metro', system: 'nielsen_dma' });
    const rows = us.by_geo as Array<Record<string, unknown>>;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every(r => r.geo_level === 'metro' && r.system === 'nielsen_dma')).toBe(true);
    expectReconciles(rows);

    expect(geo({ geo_level: 'metro', system: 'uk_itl1' })).toEqual({});
    expect(geo({ geo_level: 'metro', system: 'eurostat_nuts2' })).toEqual({});

    const nonUs = geo({ geo_level: 'metro', system: 'nielsen_dma' }, { targeting: { geo_countries: ['GB'] } });
    expect(nonUs.by_geo).toEqual([]);
  });

  it('uses targeted nielsen_dma metros and ignores other systems in targeting', () => {
    const out = geo({ geo_level: 'metro', system: 'nielsen_dma' }, {
      targeting: {
        geo_metros: [
          { system: 'nielsen_dma', values: ['501', '803'] },
          { system: 'uk_itl1', values: ['TLI'] },
        ],
      },
    });
    expect((out.by_geo as Array<Record<string, unknown>>).map(r => r.geo_code).sort()).toEqual(['501', '803']);
  });

  it('applies limit and flags truncation; totals still reconcile when untruncated', () => {
    const out = geo({ geo_level: 'region', limit: 2 }, { targeting: { geo_countries: ['US'] } });
    expect(out.by_geo).toHaveLength(2);
    expect(out.by_geo_truncated).toBe(true);
    const full = geo({ geo_level: 'region' }, { targeting: { geo_countries: ['US'] } });
    expect(full.by_geo_truncated).toBe(false);
  });

  it('sorts by the requested metric and direction, echoing the sort', () => {
    const out = geo({ geo_level: 'country', sort_by: 'impressions', sort_direction: 'asc' }, {
      targeting: { geo_countries: ['US', 'CA', 'MX'] },
    });
    const rows = out.by_geo as Array<Record<string, unknown>>;
    const impressions = rows.map(r => r.impressions as number);
    expect(impressions).toEqual([...impressions].sort((a, b) => a - b));
    expect(out.by_geo_sorted_by).toBe('impressions');
    expect(out.by_geo_sort_direction).toBe('asc');
  });

  it('falls back to spend/desc when the metric is absent from the rows', () => {
    const out = geo({ geo_level: 'country', sort_by: 'conversions', sort_direction: 'asc' }, {
      targeting: { geo_countries: ['US', 'CA'] },
    });
    expect(out.by_geo_sorted_by).toBe('spend');
    expect(out.by_geo_sort_direction).toBe('desc');
    const spend = (out.by_geo as Array<Record<string, unknown>>).map(r => r.spend as number);
    expect(spend).toEqual([...spend].sort((a, b) => b - a));
  });
});

describe('dimensionalDeliveryBreakdowns — device_type', () => {
  const device = (dimension: Record<string, unknown>, rest: Partial<DimensionalBreakdownInput> = {}) =>
    dimensionalDeliveryBreakdowns(input({ dimensions: { device_type: dimension }, ...rest }));

  it('returns one row per device with reconciling totals', () => {
    const out = device({});
    const rows = out.by_device_type as Array<Record<string, unknown>>;
    expect(rows.map(r => r.device_type).sort()).toEqual(['desktop', 'mobile', 'tablet']);
    expectReconciles(rows);
    expect(out.by_device_type_truncated).toBe(false);
    expect(out.by_device_type_pagination).toBeUndefined();
    expect(out.by_device_type_sorted_by).toBe('spend');
    expect(out.by_device_type_sort_direction).toBe('desc');
  });

  it('paginates with a cursor; following it returns the remaining rows', () => {
    const first = device({ limit: 2 });
    expect(first.by_device_type).toHaveLength(2);
    expect(first.by_device_type_truncated).toBe(true);
    const pagination = first.by_device_type_pagination as { has_more: boolean; cursor: string; total_count: number };
    expect(pagination).toMatchObject({ has_more: true, total_count: 3 });

    const second = device({ limit: 2, cursor: pagination.cursor });
    const rest = second.by_device_type as Array<Record<string, unknown>>;
    expect(rest).toHaveLength(1);
    expect(second.by_device_type_pagination).toBeUndefined();
    const all = [...(first.by_device_type as Array<Record<string, unknown>>), ...rest];
    expect(new Set(all.map(r => r.device_type)).size).toBe(3);
    expectReconciles(all);
  });

  it('ignores an invalid cursor', () => {
    const out = device({ limit: 2, cursor: 'garbage' });
    expect(out.by_device_type).toHaveLength(2);
  });
});

describe('dimensionalDeliveryBreakdowns — keyword', () => {
  const keyword = (targeting: Record<string, unknown> | undefined, dimension: Record<string, unknown> = {}) =>
    dimensionalDeliveryBreakdowns(input({ channels: ['search'], targeting, dimensions: { keyword: dimension } }));

  it('emits one row per unique (keyword, match_type) with reconciling totals', () => {
    const out = keyword({
      keyword_targets: [
        { keyword: 'running shoes', match_type: 'broad' },
        { keyword: 'running shoes', match_type: 'exact' },
        { keyword: 'running shoes', match_type: 'broad' },
        { keyword: 'trail shoes', match_type: 'phrase' },
      ],
    });
    const rows = out.by_keyword as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(3);
    expect(rows.map(r => `${r.keyword}|${r.match_type}`).sort()).toEqual([
      'running shoes|broad', 'running shoes|exact', 'trail shoes|phrase',
    ]);
    expectReconciles(rows);
  });

  it('returns an empty list with no keyword targets', () => {
    const out = keyword(undefined);
    expect(out.by_keyword).toEqual([]);
    expect(out.by_keyword_truncated).toBe(false);
  });

  it('applies limit', () => {
    const out = keyword({
      keyword_targets: [
        { keyword: 'a', match_type: 'broad' },
        { keyword: 'b', match_type: 'broad' },
        { keyword: 'c', match_type: 'broad' },
      ],
    }, { limit: 2 });
    expect(out.by_keyword).toHaveLength(2);
    expect(out.by_keyword_truncated).toBe(true);
  });
});
