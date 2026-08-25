/**
 * Unit test: container-subsumption helpers pin the reference-seller
 * evaluation of `enums/available-metric.json`'s normative rule to a single
 * shared implementation, so `required_metrics` filtering and
 * `requested_metrics` narrowing can't silently diverge from each other or
 * from the schema's container -> leaf mapping.
 */

import { describe, it, expect } from 'vitest';
import {
  satisfies,
  satisfiesAll,
  resolveToCarrier,
  resolveRequestedMetrics,
  narrowMetricsRecord,
} from './metric-subsumption.js';

describe('satisfies', () => {
  it('a declared container satisfies a requirement for one of its leaves', () => {
    expect(satisfies(['viewability'], 'viewable_rate')).toBe(true);
    expect(satisfies(['viewability'], 'viewed_seconds')).toBe(true);
    expect(satisfies(['quartile_data'], 'quartile_75')).toBe(true);
  });

  it('an exact match always satisfies, container or leaf', () => {
    expect(satisfies(['viewable_rate'], 'viewable_rate')).toBe(true);
    expect(satisfies(['viewability'], 'viewability')).toBe(true);
    expect(satisfies(['impressions'], 'impressions')).toBe(true);
  });

  it('a declared leaf does not satisfy a sibling leaf', () => {
    expect(satisfies(['viewable_rate'], 'viewed_seconds')).toBe(false);
    expect(satisfies(['quartile_25'], 'quartile_50')).toBe(false);
  });

  it('a declared leaf does not satisfy the container', () => {
    expect(satisfies(['viewable_rate'], 'viewability')).toBe(false);
  });

  it('an undeclared metric never satisfies', () => {
    expect(satisfies(['impressions', 'spend'], 'viewable_rate')).toBe(false);
    expect(satisfies([], 'impressions')).toBe(false);
  });
});

describe('satisfiesAll', () => {
  it('is conjunctive: every required entry must be satisfied', () => {
    expect(satisfiesAll(['viewability'], ['viewable_rate', 'viewed_seconds'])).toBe(true);
    expect(satisfiesAll(['viewable_rate'], ['viewable_rate', 'viewed_seconds'])).toBe(false);
  });

  it('an empty requirement list is trivially satisfied', () => {
    expect(satisfiesAll([], [])).toBe(true);
  });
});

describe('resolveToCarrier', () => {
  it('resolves a leaf identity to its canonical carrier container', () => {
    expect(resolveToCarrier('viewable_rate')).toBe('viewability');
    expect(resolveToCarrier('viewable_impressions')).toBe('viewability');
    expect(resolveToCarrier('measurable_impressions')).toBe('viewability');
    expect(resolveToCarrier('viewed_seconds')).toBe('viewability');
    expect(resolveToCarrier('quartile_25')).toBe('quartile_data');
    expect(resolveToCarrier('quartile_50')).toBe('quartile_data');
    expect(resolveToCarrier('quartile_75')).toBe('quartile_data');
    expect(resolveToCarrier('quartile_100')).toBe('quartile_data');
  });

  it('resolves a container or a flat metric to itself', () => {
    expect(resolveToCarrier('viewability')).toBe('viewability');
    expect(resolveToCarrier('quartile_data')).toBe('quartile_data');
    expect(resolveToCarrier('impressions')).toBe('impressions');
    expect(resolveToCarrier('dooh_metrics')).toBe('dooh_metrics');
    expect(resolveToCarrier('time_based_views')).toBe('time_based_views');
  });
});

describe('resolveRequestedMetrics', () => {
  it('always includes impressions and spend', () => {
    const resolved = resolveRequestedMetrics(['clicks']);
    expect(resolved.has('impressions')).toBe(true);
    expect(resolved.has('spend')).toBe(true);
    expect(resolved.has('clicks')).toBe(true);
  });

  it('resolves a requested leaf to its carrier', () => {
    const resolved = resolveRequestedMetrics(['viewable_rate']);
    expect(resolved.has('viewability')).toBe(true);
    expect(resolved.has('viewable_rate')).toBe(false);
  });
});

describe('narrowMetricsRecord', () => {
  it('returns the record unchanged when keep is undefined (no narrowing requested)', () => {
    const record = { impressions: 100, spend: 5, clicks: 3 };
    expect(narrowMetricsRecord(record, undefined)).toBe(record);
  });

  it('drops metric fields not in the keep set', () => {
    const record = { impressions: 100, spend: 5, clicks: 3, viewability: { viewable_rate: 0.8 } };
    const narrowed = narrowMetricsRecord(record, new Set(['impressions', 'spend', 'viewability']));
    expect(narrowed).toEqual({ impressions: 100, spend: 5, viewability: { viewable_rate: 0.8 } });
  });

  it('leaves non-metric structural fields untouched regardless of keep', () => {
    const record = {
      package_id: 'pkg-0',
      impressions: 100,
      spend: 5,
      clicks: 3,
      pricing_model: 'cpm',
      missing_metrics: [],
    };
    const narrowed = narrowMetricsRecord(record, new Set(['impressions', 'spend']));
    expect(narrowed).toEqual({
      package_id: 'pkg-0',
      impressions: 100,
      spend: 5,
      pricing_model: 'cpm',
      missing_metrics: [],
    });
  });
});
