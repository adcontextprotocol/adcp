/**
 * Semantic validation for viewed-seconds distributions.
 *
 * JSON Schema draft-07 covers the carrier shapes, required siblings, and
 * scalar bounds. Cross-value ordering and histogram sums are mirrored here
 * for the reference seller's delivery-simulation write boundary.
 */

export type DeliveryMetricViolation = {
  rule: string;
  field: string;
  expected?: unknown;
  predicted?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function validateViewedSecondsDistributionSemantics(
  viewability: unknown,
): DeliveryMetricViolation[] {
  if (!isRecord(viewability)) return [];

  const violations: DeliveryMetricViolation[] = [];
  const measurable = viewability.measurable_impressions;
  const percentiles = viewability.viewed_seconds_percentiles;

  if (isRecord(percentiles)) {
    if (!finiteNumber(measurable) || !Number.isInteger(measurable) || measurable < 1) {
      violations.push({
        rule: 'viewed_seconds_distribution_population',
        field: 'viewability.measurable_impressions',
        expected: 'positive integer when percentiles are present',
        predicted: measurable,
      });
    }

    const keys = ['p25', 'p50', 'p75', 'p90', 'p95'] as const;
    for (let index = 1; index < keys.length; index += 1) {
      const previous = percentiles[keys[index - 1]];
      const current = percentiles[keys[index]];
      if (finiteNumber(previous) && finiteNumber(current) && current < previous) {
        violations.push({
          rule: 'viewed_seconds_percentile_order',
          field: `viewability.viewed_seconds_percentiles.${keys[index]}`,
          expected: `>= ${keys[index - 1]} (${previous})`,
          predicted: current,
        });
      }
    }
  }

  const histogram = viewability.viewed_seconds_histogram;
  if (!Array.isArray(histogram)) return violations;

  if (!finiteNumber(measurable) || !Number.isInteger(measurable) || measurable < 0) {
    violations.push({
      rule: 'viewed_seconds_distribution_population',
      field: 'viewability.measurable_impressions',
      expected: 'non-negative integer when a histogram is present',
      predicted: measurable,
    });
  }

  let impressionSum = 0;
  let canCompareSum = true;
  for (let index = 0; index < histogram.length; index += 1) {
    const bucket = histogram[index];
    if (!isRecord(bucket)) {
      canCompareSum = false;
      continue;
    }

    const lower = bucket.lower_bound_seconds;
    const upper = bucket.upper_bound_seconds;
    const impressions = bucket.impressions;
    if (finiteNumber(impressions)) impressionSum += impressions;
    else canCompareSum = false;

    if (index < histogram.length - 1 && upper === undefined) {
      violations.push({
        rule: 'viewed_seconds_histogram_bounds',
        field: `viewability.viewed_seconds_histogram.${index}.upper_bound_seconds`,
        expected: 'present on every non-final bucket',
      });
    }
    if (finiteNumber(lower) && finiteNumber(upper) && upper <= lower) {
      violations.push({
        rule: 'viewed_seconds_histogram_bounds',
        field: `viewability.viewed_seconds_histogram.${index}.upper_bound_seconds`,
        expected: `> lower_bound_seconds (${lower})`,
        predicted: upper,
      });
    }

    if (index === 0) continue;
    const previous = histogram[index - 1];
    if (!isRecord(previous)) continue;
    const previousLower = previous.lower_bound_seconds;
    const previousUpper = previous.upper_bound_seconds;
    if (finiteNumber(previousLower) && finiteNumber(lower) && lower < previousLower) {
      violations.push({
        rule: 'viewed_seconds_histogram_bounds',
        field: `viewability.viewed_seconds_histogram.${index}.lower_bound_seconds`,
        expected: `>= previous lower_bound_seconds (${previousLower})`,
        predicted: lower,
      });
    }
    if (finiteNumber(previousUpper) && finiteNumber(lower) && lower < previousUpper) {
      violations.push({
        rule: 'viewed_seconds_histogram_bounds',
        field: `viewability.viewed_seconds_histogram.${index}.lower_bound_seconds`,
        expected: `>= previous upper_bound_seconds (${previousUpper})`,
        predicted: lower,
      });
    }
  }

  if (canCompareSum && finiteNumber(measurable) && impressionSum !== measurable) {
    violations.push({
      rule: 'viewed_seconds_histogram_population',
      field: 'viewability.viewed_seconds_histogram',
      expected: `impressions sum ${measurable}`,
      predicted: impressionSum,
    });
  }

  return violations;
}
