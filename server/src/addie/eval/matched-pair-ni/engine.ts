/**
 * Restricted-score E+M exact-unconditional matched-pair noninferiority
 * diagnostic after Lloyd & Moldovan (2008), Statistics in Medicine 27,
 * 3540-3549, doi:10.1002/sim.3229. This module is diagnostic only; see
 * admission.ts. It does not implement confidence inversion or resizing.
 */
import { evaluateInterval, interval, intervalAdd, intervalDividePositive, intervalMultiply, intervalSubtract, maximizePolynomial, sqrtInterval, type RationalInterval } from './algebraic.js';
import type { ExactInferenceCertificate, IndeterminateCertificate } from './certificates.js';
import { MATCHED_PAIR_NI_ADMISSION, type MatchedPairNiAdmission } from './admission.js';
import { constant, degree, divideWithRemainder, isZero, polynomialAdd, polynomialMultiply, polynomialPow, polynomialScale, type RationalPolynomial } from './polynomial.js';
import { add, choose, compare, decimal, divide, equal, multiply, negate, pow, rational, subtract, type Rational, ONE, TWO, validateExternalRational, ZERO } from './rational.js';

export const MATCHED_PAIR_NI_MAX_N = 25;
// 24 exact dyadic subdivisions give a < 2^-24 nuisance interval while
// bounding BigInt growth for the deliberately small diagnostic ceiling.
export const MATCHED_PAIR_NI_MAX_ROOT_BISECTIONS = 24;
export const MATCHED_PAIR_NI_MAX_POLYNOMIAL_DEGREE = 25;
/** Measured synchronous ceiling for exhaustive rejection-region certification. */
export const MATCHED_PAIR_NI_MAX_SIZE_N = 8;

export interface MatchedPairCounts { readonly n11: number; readonly n10: number; readonly n01: number; readonly n00: number; }
export interface ReducedMatchedPairState { readonly n: number; readonly x: number; readonly t: number; }
export interface MatchedPairNiInput { readonly counts: MatchedPairCounts; readonly margin: Rational; readonly alpha: Rational; }
export interface MatchedPairNiResult {
  readonly mode: 'restricted_score_e_plus_m' | 'conditional_mcnemar_zero_margin';
  /** Statistical rejection never authorizes Addie or a production decision. */
  readonly admission: MatchedPairNiAdmission;
  readonly diagnostic: Readonly<{
    /** Evidence about H0 only; deliberately not named `reject` or `decision`. */
    statisticalRejectNull: boolean;
    readonly pValue: Readonly<{ lower: Rational; upper: Rational }>;
    readonly certificate?: ExactInferenceCertificate;
    readonly indeterminate?: IndeterminateCertificate;
  }>;
}
type NoRootPromotionField = 'reject' extends keyof MatchedPairNiResult ? never : 'decision' extends keyof MatchedPairNiResult ? never : true;
/** Compile-time sentinel: adding a root promotion decision fails typecheck. */
export const MATCHED_PAIR_NI_NO_ROOT_PROMOTION_FIELD: NoRootPromotionField = true;

function finiteCount(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a nonnegative safe integer`);
}
function validateState(state: ReducedMatchedPairState): void {
  finiteCount(state.n, 'n'); finiteCount(state.x, 'x'); finiteCount(state.t, 't');
  if (state.n === 0) throw new RangeError('At least one matched pair is required');
  if (state.x > state.t || state.t > state.n) throw new RangeError('Reduced state must satisfy 0 <= x <= t <= n');
  if (state.n > MATCHED_PAIR_NI_MAX_N) throw new RangeError(`Diagnostic ceiling is n <= ${MATCHED_PAIR_NI_MAX_N}; no confirmatory sample-size claim is made`);
}
function validateMargin(margin: Rational): void {
  validateExternalRational(margin, 'Margin');
  if (compare(margin, ZERO) < 0 || compare(margin, ONE) >= 0) throw new RangeError('Margin must be in [0, 1)');
}
export function reduceMatchedPairCounts(counts: MatchedPairCounts): ReducedMatchedPairState {
  for (const [name, value] of Object.entries(counts)) finiteCount(value, name);
  const n = counts.n11 + counts.n10 + counts.n01 + counts.n00;
  if (!Number.isSafeInteger(n)) throw new RangeError('Total count is not a safe integer');
  if (n === 0 || n > MATCHED_PAIR_NI_MAX_N) throw new RangeError(`Matched-pair total must be in [1, ${MATCHED_PAIR_NI_MAX_N}]`);
  return Object.freeze({ n, x: counts.n10, t: counts.n10 + counts.n01 });
}
function validate(state: ReducedMatchedPairState, margin: Rational, alpha: Rational): void {
  validateMargin(margin);
  validateExternalRational(alpha, 'Alpha');
  validateState(state);
  if (compare(alpha, ZERO) <= 0 || compare(alpha, ONE) >= 0) throw new RangeError('Alpha must be in (0, 1)');
}
export function enumerateReducedStates(n: number): readonly ReducedMatchedPairState[] {
  finiteCount(n, 'n');
  if (n === 0 || n > MATCHED_PAIR_NI_MAX_N) throw new RangeError(`Reduced-state enumeration requires n in [1, ${MATCHED_PAIR_NI_MAX_N}]`);
  return Object.freeze(Array.from({ length: n + 1 }, (_, t) => Array.from({ length: t + 1 }, (_, x) => Object.freeze({ n, x, t }))).flat());
}
function stateEquals(a: ReducedMatchedPairState, b: ReducedMatchedPairState): boolean { return a.n === b.n && a.x === b.x && a.t === b.t; }
function thetaHat(state: ReducedMatchedPairState): Rational { return divide(rational(2 * state.x - state.t), rational(state.n)); }
function phiHat(state: ReducedMatchedPairState): Rational { return divide(rational(state.t), rational(state.n)); }

/** Larger constrained root from the published score statistic's quadratic. */
export function restrictedPhiInterval(state: ReducedMatchedPairState, margin: Rational, squareRootRounds = 56): RationalInterval {
  validateState(state); validateMargin(margin);
  if (!Number.isSafeInteger(squareRootRounds) || squareRootRounds < 1 || squareRootRounds > 256) throw new RangeError('Square-root rounds must be an integer in [1, 256]');
  const theta = thetaHat(state);
  const phi = phiHat(state);
  const theta0 = negate(margin);
  const a = add(phi, multiply(theta, theta0));
  const b = subtract(multiply(theta, theta0), multiply(subtract(ONE, phi), pow(theta0, 2)));
  const discriminant = subtract(pow(a, 2), multiply(rational(4), b));
  const root = sqrtInterval(discriminant, squareRootRounds);
  const unconstrained = intervalDividePositive(intervalAdd(interval(a, a), root), interval(TWO, TWO));
  // Bisection encloses the algebraic root, so trim only the harmless spill
  // outside the feasible nuisance interval; a disjoint root is invalid data.
  if (compare(unconstrained.upper, margin) < 0 || compare(unconstrained.lower, ONE) > 0) {
    throw new RangeError('Restricted nuisance estimate is outside [margin, 1]');
  }
  return interval(
    compare(unconstrained.lower, margin) < 0 ? margin : unconstrained.lower,
    compare(unconstrained.upper, ONE) > 0 ? ONE : unconstrained.upper,
  );
}
interface Score { readonly direction: -1 | 0 | 1; readonly squared: RationalInterval; }
function score(state: ReducedMatchedPairState, margin: Rational, phi: RationalInterval = restrictedPhiInterval(state, margin)): Score {
  const difference = add(thetaHat(state), margin);
  const direction = compare(difference, ZERO);
  if (direction === 0) return { direction, squared: interval(ZERO, ZERO) };
  const numerator = multiply(rational(state.n), pow(difference, 2));
  const denominator = intervalSubtract(phi, interval(pow(margin, 2), pow(margin, 2)));
  return { direction, squared: intervalDividePositive(interval(numerator, numerator), denominator) };
}
/** `null` is a fail-closed unresolved ordering. */
function compareScore(a: ReducedMatchedPairState, b: ReducedMatchedPairState, margin: Rational): -1 | 0 | 1 | null {
  if (stateEquals(a, b)) return 0;
  const left = score(a, margin); const right = score(b, margin);
  if (left.direction !== right.direction) return left.direction < right.direction ? -1 : 1;
  if (left.direction === 0) return 0;
  const comparison = left.direction === 1
    ? compareIntervals(left.squared, right.squared)
    : compareIntervals(right.squared, left.squared);
  return comparison;
}
function compareIntervals(left: RationalInterval, right: RationalInterval): -1 | 1 | null {
  if (compare(left.upper, right.lower) < 0) return -1;
  if (compare(left.lower, right.upper) > 0) return 1;
  return null;
}
function compareScorePrecisely(a: ReducedMatchedPairState, b: ReducedMatchedPairState, margin: Rational): -1 | 0 | 1 | null {
  const coarse = compareScore(a, b, margin);
  if (coarse !== null) return coarse;
  const left = score(a, margin, restrictedPhiInterval(a, margin, 256));
  const right = score(b, margin, restrictedPhiInterval(b, margin, 256));
  if (left.direction !== right.direction) return left.direction < right.direction ? -1 : 1;
  if (left.direction === 0) return 0;
  const comparison = left.direction === 1 ? compareIntervals(left.squared, right.squared) : compareIntervals(right.squared, left.squared);
  if (comparison !== null) return comparison;
  return provenEqualScoreSquared(a, b, margin, left.squared, right.squared) ? 0 : null;
}
/** Minimal polynomial in z for z = n(thetaHat+m)^2/(phiRestricted-m^2). */
function scoreSquaredPolynomial(state: ReducedMatchedPairState, margin: Rational): RationalPolynomial {
  const theta = thetaHat(state); const phi = phiHat(state); const theta0 = negate(margin);
  const a = add(phi, multiply(theta, theta0));
  const b = subtract(multiply(theta, theta0), multiply(subtract(ONE, phi), pow(theta0, 2)));
  const m2 = pow(margin, 2);
  const k = multiply(rational(state.n), pow(add(theta, margin), 2));
  return [pow(k, 2), multiply(k, subtract(multiply(TWO, m2), a)), add(subtract(pow(m2, 2), multiply(a, m2)), b)];
}
function polynomialGcd(left: RationalPolynomial, right: RationalPolynomial): RationalPolynomial {
  let a = left; let b = right;
  while (!isZero(b)) {
    const [, remainder] = divideWithRemainder(a, b);
    a = b; b = remainder;
  }
  return a;
}
/** Exact equality is needed for E-tail ties; an interval overlap alone is never a tie. */
function provenEqualScoreSquared(
  a: ReducedMatchedPairState, b: ReducedMatchedPairState, margin: Rational,
  left: RationalInterval, right: RationalInterval,
): boolean {
  if (compare(left.upper, right.lower) < 0 || compare(left.lower, right.upper) > 0) return false;
  return degree(polynomialGcd(scoreSquaredPolynomial(a, margin), scoreSquaredPolynomial(b, margin))) >= 1;
}

/** P(X=x,T=t | theta=-m, phi), as a rational polynomial in phi. */
export function reducedStateProbabilityPolynomial(state: ReducedMatchedPairState, margin: Rational): RationalPolynomial {
  validateState(state); validateMargin(margin);
  const coefficient = divide(rational(choose(state.n, state.t) * choose(state.t, state.x)), pow(TWO, state.t));
  return polynomialScale(
    polynomialMultiply(
      polynomialMultiply(polynomialPow([negate(margin), ONE], state.x), polynomialPow([margin, ONE], state.t - state.x)),
      polynomialPow([ONE, negate(ONE)], state.n - state.t),
    ), coefficient,
  );
}
function intervalPow(value: RationalInterval, exponent: number): RationalInterval {
  let result = interval(ONE, ONE);
  for (let count = 0; count < exponent; count++) result = intervalMultiply(result, value);
  return result;
}
/** Nonnegative factored form avoids dependency blow-up from expanded coefficients. */
function reducedStateProbabilityInterval(state: ReducedMatchedPairState, margin: Rational, phi: RationalInterval): RationalInterval {
  const coefficient = divide(rational(choose(state.n, state.t) * choose(state.t, state.x)), pow(TWO, state.t));
  return intervalMultiply(interval(coefficient, coefficient), intervalMultiply(
    intervalMultiply(intervalPow(intervalSubtract(phi, interval(margin, margin)), state.x), intervalPow(intervalAdd(phi, interval(margin, margin)), state.t - state.x)),
    intervalPow(intervalSubtract(interval(ONE, ONE), phi), state.n - state.t),
  ));
}
function probabilityRegionInterval(states: readonly ReducedMatchedPairState[], margin: Rational, phi: RationalInterval): RationalInterval {
  return states.reduce((result, state) => intervalAdd(result, reducedStateProbabilityInterval(state, margin, phi)), interval(ZERO, ZERO));
}
function stateKey(state: ReducedMatchedPairState): string { return `${state.x}:${state.t}`; }
/** Caches the exhaustive E step, keeping the certified result deterministic. */
function buildEStep(states: readonly ReducedMatchedPairState[], margin: Rational) {
  const phis = new Map<string, RationalInterval>();
  const scores = new Map<string, Score>();
  const ePolynomials = new Map<string, RationalPolynomial | null>();
  const eValues = new Map<string, RationalInterval | null>();
  const probabilities = new Map<string, RationalPolynomial>();
  let orderingAmbiguous = false;
  const phi = (state: ReducedMatchedPairState) => {
    const key = stateKey(state); let value = phis.get(key);
    if (!value) { value = restrictedPhiInterval(state, margin); phis.set(key, value); }
    return value;
  };
  const scoreFor = (state: ReducedMatchedPairState) => {
    const key = stateKey(state); let value = scores.get(key);
    if (!value) { value = score(state, margin, phi(state)); scores.set(key, value); }
    return value;
  };
  const order = (a: ReducedMatchedPairState, b: ReducedMatchedPairState): -1 | 0 | 1 | null => {
    if (stateEquals(a, b)) return 0;
    const left = scoreFor(a); const right = scoreFor(b);
    if (left.direction !== right.direction) return left.direction < right.direction ? -1 : 1;
    if (left.direction === 0) return 0;
    const coarse = left.direction === 1 ? compareIntervals(left.squared, right.squared) : compareIntervals(right.squared, left.squared);
    return coarse ?? compareScorePrecisely(a, b, margin);
  };
  const ePolynomial = (source: ReducedMatchedPairState): RationalPolynomial | null => {
    const key = stateKey(source);
    if (ePolynomials.has(key)) return ePolynomials.get(key)!;
    // Form all upper score tails once. This is the same E step as a nested
    // enumeration but avoids rebuilding O(states^2) polynomials.
    const ordered = [...states];
    ordered.sort((a, b) => {
      const value = order(a, b);
      if (value === null) { orderingAmbiguous = true; return 0; }
      return value;
    });
    if (orderingAmbiguous) return null;
    let tail = constant(ZERO);
    for (let end = ordered.length - 1; end >= 0;) {
      let start = end;
      while (start > 0) {
        const tie = order(ordered[start - 1]!, ordered[end]!);
        if (tie === null) { orderingAmbiguous = true; return null; }
        if (tie !== 0) break;
        start--;
      }
      for (let index = start; index <= end; index++) {
        const member = ordered[index]!;
        const memberKey = stateKey(member);
        let probability = probabilities.get(memberKey);
        if (!probability) { probability = reducedStateProbabilityPolynomial(member, margin); probabilities.set(memberKey, probability); }
        tail = polynomialAdd(tail, probability);
      }
      for (let index = start; index <= end; index++) ePolynomials.set(stateKey(ordered[index]!), tail);
      end = start - 1;
    }
    return ePolynomials.get(key)!;
  };
  const eValue = (source: ReducedMatchedPairState): RationalInterval | null => {
    const key = stateKey(source);
    if (eValues.has(key)) return eValues.get(key)!;
    const value = ePolynomial(source);
    const result = value ? evaluateInterval(value, phi(source)) : null;
    eValues.set(key, result);
    return result;
  };
  return Object.freeze({ eValue, hasAmbiguousOrdering: () => orderingAmbiguous });
}

export function conditionalMcNemarPValue(state: ReducedMatchedPairState): Rational {
  validateState(state);
  if (state.t === 0) return ONE;
  let numerator = ZERO;
  for (let x = state.x; x <= state.t; x++) numerator = add(numerator, divide(rational(choose(state.t, x)), pow(TWO, state.t)));
  return numerator;
}

export function restrictedScoreEM(input: MatchedPairNiInput): MatchedPairNiResult {
  const observed = reduceMatchedPairCounts(input.counts);
  validate(observed, input.margin, input.alpha);
  if (equal(input.margin, ZERO)) {
    const p = conditionalMcNemarPValue(observed);
    return Object.freeze({ mode: 'conditional_mcnemar_zero_margin', admission: MATCHED_PAIR_NI_ADMISSION, diagnostic: Object.freeze({ statisticalRejectNull: compare(p, input.alpha) <= 0, pValue: Object.freeze({ lower: p, upper: p }) }) });
  }
  const states = enumerateReducedStates(observed.n);
  const eStep = buildEStep(states, input.margin);
  return restrictedScoreEMReduced(observed, input.margin, input.alpha, states, eStep);
}
function restrictedScoreEMReduced(
  observed: ReducedMatchedPairState, margin: Rational, alpha: Rational,
  states: readonly ReducedMatchedPairState[], eStep: ReturnType<typeof buildEStep>,
): MatchedPairNiResult {
  const observedE = eStep.eValue(observed);
  if (!observedE || eStep.hasAmbiguousOrdering()) return indeterminate('ambiguous_score_ordering');
  let region = constant(ZERO);
  const regionStates: ReducedMatchedPairState[] = [];
  for (const state of states) {
    const current = eStep.eValue(state);
    if (!current) return indeterminate('ambiguous_score_ordering');
    if (stateEquals(state, observed) || compare(current.upper, observedE.lower) <= 0) {
      region = polynomialAdd(region, reducedStateProbabilityPolynomial(state, margin));
      regionStates.push(state);
    }
    else if (compare(current.lower, observedE.upper) <= 0) return indeterminate('ambiguous_e_ordering');
  }
  const maximum = maximizePolynomial(region, margin, ONE, MATCHED_PAIR_NI_MAX_ROOT_BISECTIONS,
    (phi) => probabilityRegionInterval(regionStates, margin, phi));
  if (maximum.indeterminate) return indeterminate('root_isolation_ceiling');
  const pValue = Object.freeze({ lower: maximum.lower, upper: maximum.upper });
  const certificate: ExactInferenceCertificate = Object.freeze({
    method: 'lloyd_moldovan_2008_restricted_score_e_plus_m', nullBoundary: 'theta=-margin', maximization: 'rational_sturm_and_interval_bisection',
    evaluatedEndpoints: true, stationaryPointCount: maximum.stationaryPointCount, pValue,
    safeCeiling: Object.freeze({ maxN: MATCHED_PAIR_NI_MAX_N, maxPolynomialDegree: MATCHED_PAIR_NI_MAX_POLYNOMIAL_DEGREE, maxRootBisections: MATCHED_PAIR_NI_MAX_ROOT_BISECTIONS }),
    exactness: 'certified_enclosure_only',
  });
  return Object.freeze({ mode: 'restricted_score_e_plus_m', admission: MATCHED_PAIR_NI_ADMISSION, diagnostic: Object.freeze({ statisticalRejectNull: compare(pValue.upper, alpha) <= 0, pValue, certificate }) });
}
function indeterminate(reason: IndeterminateCertificate['reason']): MatchedPairNiResult {
  return Object.freeze({ mode: 'restricted_score_e_plus_m', admission: MATCHED_PAIR_NI_ADMISSION, diagnostic: Object.freeze({ statisticalRejectNull: false, pValue: Object.freeze({ lower: ZERO, upper: ONE }), indeterminate: Object.freeze({ method: 'lloyd_moldovan_2008_restricted_score_e_plus_m', reason, reject: false }) }) });
}

export interface NullBoundarySizeEnvelope {
  readonly status: 'certified' | 'indeterminate';
  /** Exact lower/upper rejection-region polynomials; never optimistic omission. */
  readonly lower: RationalPolynomial;
  readonly upper: RationalPolynomial;
  readonly indeterminateStates: readonly ReducedMatchedPairState[];
  readonly reason: 'indeterminate_p_value' | 'size_complexity_ceiling' | null;
}
/**
 * Certified null-boundary size envelope. Any unresolved p-value is included
 * in the upper polynomial, never silently discarded from a claimed exact size.
 */
export function nullBoundarySizeEnvelope(n: number, margin: Rational, alpha: Rational): NullBoundarySizeEnvelope {
  validate({ n, x: 0, t: 0 }, margin, alpha);
  if (equal(margin, ZERO)) throw new RangeError('Zero margin has conditional McNemar size, not an E+M polynomial');
  const states = enumerateReducedStates(n);
  if (n > MATCHED_PAIR_NI_MAX_SIZE_N) {
    let upper = constant(ZERO);
    for (const state of states) upper = polynomialAdd(upper, reducedStateProbabilityPolynomial(state, margin));
    return Object.freeze({ status: 'indeterminate', lower: constant(ZERO), upper, indeterminateStates: states, reason: 'size_complexity_ceiling' });
  }
  const eStep = buildEStep(states, margin);
  let lower = constant(ZERO); let upper = constant(ZERO);
  const indeterminateStates: ReducedMatchedPairState[] = [];
  for (const state of states) {
    const counts = { n11: n - state.t, n10: state.x, n01: state.t - state.x, n00: 0 };
    const outcome = restrictedScoreEMReduced(reduceMatchedPairCounts(counts), margin, alpha, states, eStep);
    const probability = reducedStateProbabilityPolynomial(state, margin);
    if (outcome.diagnostic.indeterminate) {
      upper = polynomialAdd(upper, probability);
      indeterminateStates.push(state);
    } else if (outcome.diagnostic.statisticalRejectNull) {
      lower = polynomialAdd(lower, probability);
      upper = polynomialAdd(upper, probability);
    }
  }
  return Object.freeze({
    status: indeterminateStates.length === 0 ? 'certified' : 'indeterminate', lower, upper,
    indeterminateStates: Object.freeze(indeterminateStates), reason: indeterminateStates.length === 0 ? null : 'indeterminate_p_value',
  });
}
/** Typed non-admitting contracts: confidence inversion and adaptive resizing are deliberately absent. */
export interface MatchedPairNiConfidenceInversion { readonly status: 'not_implemented_non_admitting'; }
export interface MatchedPairNiAdaptiveResizing { readonly status: 'not_implemented_non_admitting'; }
export const parseMatchedPairNiDecimal = decimal;
