import { describe, expect, it } from 'vitest';
import fixture from '../../../../src/addie/eval/matched-pair-ni/fixtures/published-lm-2008.json' with { type: 'json' };
import { isolateInteriorRoots, maximizePolynomial } from '../../../../src/addie/eval/matched-pair-ni/algebraic.js';
import { denyMatchedPairNiPromotion, MATCHED_PAIR_NI_ADMISSION, matchedPairNiAdmission } from '../../../../src/addie/eval/matched-pair-ni/admission.js';
import {
  conditionalMcNemarPValue,
  enumerateReducedStates,
  nullBoundarySizeEnvelope,
  MATCHED_PAIR_NI_NO_ROOT_PROMOTION_FIELD,
  parseMatchedPairNiDecimal,
  reducedStateProbabilityPolynomial,
  restrictedPhiInterval,
  restrictedScoreEM,
} from '../../../../src/addie/eval/matched-pair-ni/engine.js';
import { polynomialAdd, polynomialMultiply, polynomialPow, polynomialScale } from '../../../../src/addie/eval/matched-pair-ni/polynomial.js';
import { add, choose, compare, decimal, divide, negate, pow, rational, subtract, ONE, TWO, ZERO } from '../../../../src/addie/eval/matched-pair-ni/rational.js';

describe('Lloyd--Moldovan restricted-score E+M diagnostic', () => {
  const margin = parseMatchedPairNiDecimal('0.10');
  const alpha = parseMatchedPairNiDecimal('0.05');

  it('reproduces the published n=25, x=2, t=2 score E+M fixture to four decimals', () => {
    expect(fixture.schema_version).toBe(1);
    expect(fixture.provenance.kind).toBe('published_claim_pending_independent_reference_match');
    expect(fixture.margin).toMatch(/^0\.[0-9]+$/);
    expect(fixture.reported_p_value).toMatch(/^0\.[0-9]+$/);
    expect(fixture.counts.x + (fixture.counts.t - fixture.counts.x)).toBe(fixture.counts.t);
    const fixtureMargin = parseMatchedPairNiDecimal(fixture.margin);
    const reported = decimal(fixture.reported_p_value);
    const fourDecimalHalfUnit = decimal('0.00005');
    const outcome = restrictedScoreEM({
      counts: {
        n11: fixture.counts.n - fixture.counts.t, n10: fixture.counts.x,
        n01: fixture.counts.t - fixture.counts.x, n00: 0,
      }, margin: fixtureMargin, alpha,
    });
    expect(outcome.diagnostic.indeterminate).toBeUndefined();
    expect(outcome.diagnostic.statisticalRejectNull).toBe(true);
    expect(outcome.admission.admitted).toBe(false);
    expect(compare(outcome.diagnostic.pValue.lower, subtract(reported, fourDecimalHalfUnit))).toBeGreaterThan(0);
    expect(compare(outcome.diagnostic.pValue.upper, add(reported, fourDecimalHalfUnit))).toBeLessThan(0);
    expect(outcome.diagnostic.certificate?.evaluatedEndpoints).toBe(true);
    expect(outcome.diagnostic.certificate?.maximization).toBe('rational_sturm_and_interval_bisection');
  }, 30_000);

  it('routes an exactly zero margin only to exact conditional McNemar', () => {
    const outcome = restrictedScoreEM({
      counts: { n11: 2, n10: 2, n01: 1, n00: 3 }, margin: ZERO, alpha,
    });
    expect(outcome.mode).toBe('conditional_mcnemar_zero_margin');
    expect(outcome.diagnostic.pValue.lower).toEqual(conditionalMcNemarPValue({ n: 8, x: 2, t: 3 }));
  });

  it('handles zero discordance and rejects malformed/infeasible inputs', () => {
    expect(restrictedScoreEM({ counts: { n11: 3, n10: 0, n01: 0, n00: 2 }, margin, alpha }).diagnostic.pValue.upper).toBeDefined();
    expect(() => restrictedScoreEM({ counts: { n11: 0, n10: -1, n01: 1, n00: 1 }, margin, alpha })).toThrow(/nonnegative/);
    expect(() => restrictedScoreEM({ counts: { n11: 0, n10: 26, n01: 0, n00: 0 }, margin, alpha })).toThrow(/\[1, 25\]/);
    expect(() => restrictedScoreEM({
      counts: { n11: 1, n10: 0, n01: 0, n00: 0 }, alpha,
      margin: { numerator: 1n << 257n, denominator: 1n },
    })).toThrow(/256-bit/);
    expect(() => enumerateReducedStates(100_000)).toThrow(/n in \[1, 25\]/);
    expect(() => restrictedPhiInterval({ n: 5, x: 6, t: 5 }, margin)).toThrow(/0 <= x <= t <= n/);
    expect(() => isolateInteriorRoots([ONE, ONE], ZERO, ONE, -1)).toThrow(/\[1, 64\]/);
  });

  it('exhaustively reduces four-cell null probabilities for every small table', () => {
    const n = 4;
    for (const state of enumerateReducedStates(n)) {
      let fourCell = [ZERO];
      for (let n11 = 0; n11 <= n - state.t; n11++) {
        const n00 = n - state.t - n11;
        const coefficient = rational(choose(n, n11) * choose(n - n11, state.x) * choose(n - n11 - state.x, state.t - state.x));
        const term = polynomialScale(polynomialMultiply(
          polynomialMultiply(polynomialPow([negate(margin), ONE], state.x), polynomialPow([margin, ONE], state.t - state.x)),
          polynomialPow([ONE, negate(ONE)], n11 + n00),
        ), divide(coefficient, pow(TWO, n)));
        fourCell = polynomialAdd(fourCell, term);
      }
      // Compare every normalized coefficient, not samples, so this asserts
      // polynomial equality for the entire nuisance interval.
      expect(fourCell).toEqual(reducedStateProbabilityPolynomial(state, margin));
    }
  });

  it('certifies a practical small-n/margin/alpha null-boundary matrix continuously', () => {
    for (const [n, candidateMargin, candidateAlpha] of [[3, '0.10', '0.05'], [4, '0.10', '0.05'], [3, '0.20', '0.10']] as const) {
      const parsedMargin = decimal(candidateMargin);
      const parsedAlpha = decimal(candidateAlpha);
      const size = nullBoundarySizeEnvelope(n, parsedMargin, parsedAlpha);
      expect(size.status).toBe('certified');
      const certificate = maximizePolynomial(size.upper, parsedMargin, ONE);
      expect(certificate.indeterminate).toBe(false);
      expect(compare(certificate.upper, parsedAlpha)).toBeLessThanOrEqual(0);
    }
  });

  it('sentinels require both endpoints and stationary points in maximization', () => {
    const endpointOnly = maximizePolynomial([ZERO, ONE], margin, ONE);
    expect(compare(endpointOnly.lower, rational(1))).toBe(0);
    // -(x - 1/2)^2 is zero only at its interior stationary maximum.
    const interiorOnly = maximizePolynomial([negate(rational(1, 4)), ONE, negate(ONE)], ZERO, ONE);
    expect(compare(interiorOnly.lower, ZERO)).toBe(0);
    expect(interiorOnly.stationaryPointCount).toBeGreaterThan(0);
  });

  it('finds the published-review repeated-endpoint Sturm counterexample interior maximum', () => {
    const outcome = restrictedScoreEM({
      counts: { n11: 1, n10: 3, n01: 0, n00: 0 }, margin: decimal('0.07'), alpha,
    });
    expect(outcome.diagnostic.statisticalRejectNull).toBe(false);
    expect(outcome.diagnostic.certificate?.stationaryPointCount).toBeGreaterThan(0);
    expect(compare(outcome.diagnostic.pValue.lower, decimal('0.05888'))).toBeGreaterThan(0);
    expect(compare(outcome.diagnostic.pValue.upper, decimal('0.05889'))).toBeLessThan(0);
  });

  it('propagates no n=5,m=.20 state uncertainty into a size envelope', () => {
    const size = nullBoundarySizeEnvelope(5, decimal('0.20'), alpha);
    expect(size.status).toBe('certified');
    expect(size.indeterminateStates).toEqual([]);
    const maximum = maximizePolynomial(size.upper, decimal('0.20'), ONE);
    expect(compare(maximum.upper, decimal('0.0420'))).toBeLessThan(0);
  });

  it('returns an explicitly indeterminate envelope at the size-work ceiling', () => {
    const size = nullBoundarySizeEnvelope(9, margin, alpha);
    expect(size.status).toBe('indeterminate');
    expect(size.reason).toBe('size_complexity_ceiling');
    expect(size.indeterminateStates).toHaveLength(55);
  });

  it('has a hard-coded, non-overridable non-admission declaration', () => {
    expect(matchedPairNiAdmission()).toBe(MATCHED_PAIR_NI_ADMISSION);
    expect(MATCHED_PAIR_NI_ADMISSION.admitted).toBe(false);
    expect(MATCHED_PAIR_NI_ADMISSION.reasons).toEqual(expect.arrayContaining([
      'missing_independent_reference_match', 'continuous_type_i_certificate_review_required',
      'supported_n_has_no_confirmatory_sample_size_validation', 'unvalidated_adaptive_reestimation',
    ]));
  });

  it('has no promotion-shaped result field and always denies a promotion consumer', () => {
    const diagnostic = restrictedScoreEM({ counts: { n11: 3, n10: 1, n01: 0, n00: 1 }, margin, alpha });
    expect(Object.hasOwn(diagnostic, 'reject')).toBe(false);
    expect(Object.hasOwn(diagnostic, 'decision')).toBe(false);
    expect(MATCHED_PAIR_NI_NO_ROOT_PROMOTION_FIELD).toBe(true);
    expect(denyMatchedPairNiPromotion(diagnostic)).toBe(MATCHED_PAIR_NI_ADMISSION);
    expect(denyMatchedPairNiPromotion(diagnostic).admitted).toBe(false);
  });
});
