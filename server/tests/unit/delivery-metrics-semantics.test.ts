import { describe, expect, it } from 'vitest';
import { validateViewedSecondsDistributionSemantics } from '../../src/training-agent/delivery-metrics-semantics.js';

const valid = {
  measurable_impressions: 100,
  viewed_seconds: 4.25,
  viewed_seconds_percentiles: { p25: 1, p50: 2.5, p75: 5, p90: 9, p95: 12 },
  viewed_seconds_histogram: [
    { lower_bound_seconds: 0, upper_bound_seconds: 1, impressions: 20 },
    { lower_bound_seconds: 1, upper_bound_seconds: 5, impressions: 55 },
    { lower_bound_seconds: 5, impressions: 25 },
  ],
};

describe('viewed-seconds distribution semantics', () => {
  it('accepts ordered percentiles and a partitioned histogram', () => {
    expect(validateViewedSecondsDistributionSemantics(valid)).toEqual([]);
    expect(validateViewedSecondsDistributionSemantics({
      ...valid,
      viewed_seconds_percentiles: { p25: 1, p50: 1, p75: 1, p90: 1, p95: 1 },
    })).toEqual([]);
    expect(validateViewedSecondsDistributionSemantics({
      measurable_impressions: 0,
      viewed_seconds_histogram: [{ lower_bound_seconds: 0, impressions: 0 }],
    })).toEqual([]);
  });

  it.each([
    ['decreasing percentile', { ...valid, viewed_seconds_percentiles: { p25: 1, p50: 3, p75: 2, p90: 9, p95: 12 } }, 'viewed_seconds_percentile_order'],
    ['fractional population', { ...valid, measurable_impressions: 99.5 }, 'viewed_seconds_distribution_population'],
    ['zero percentile population', { ...valid, measurable_impressions: 0, viewed_seconds_histogram: undefined }, 'viewed_seconds_distribution_population'],
    ['inverted bucket', { ...valid, viewed_seconds_histogram: [{ lower_bound_seconds: 2, upper_bound_seconds: 1, impressions: 100 }] }, 'viewed_seconds_histogram_bounds'],
    ['unordered buckets', { ...valid, viewed_seconds_histogram: [{ lower_bound_seconds: 5, upper_bound_seconds: 6, impressions: 50 }, { lower_bound_seconds: 1, impressions: 50 }] }, 'viewed_seconds_histogram_bounds'],
    ['overlapping buckets', { ...valid, viewed_seconds_histogram: [{ lower_bound_seconds: 0, upper_bound_seconds: 5, impressions: 50 }, { lower_bound_seconds: 4, impressions: 50 }] }, 'viewed_seconds_histogram_bounds'],
    ['non-final open bucket', { ...valid, viewed_seconds_histogram: [{ lower_bound_seconds: 0, impressions: 50 }, { lower_bound_seconds: 1, impressions: 50 }] }, 'viewed_seconds_histogram_bounds'],
    ['wrong impression sum', { ...valid, viewed_seconds_histogram: [{ lower_bound_seconds: 0, impressions: 99 }] }, 'viewed_seconds_histogram_population'],
  ])('rejects %s', (_label, value, rule) => {
    expect(validateViewedSecondsDistributionSemantics(value).map(violation => violation.rule)).toContain(rule);
  });
});
