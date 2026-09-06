import { types } from 'node:util';
import { add, canonicalRational, compare, divide, midpoint, multiply, pow, rational, rationalBitLength, subtract, type Rational, ONE, ZERO } from './rational.js';
import { canonicalPolynomial, degree, derivative, divideWithRemainder, evaluate, isZero, polynomial, polynomialNegate, type RationalPolynomial } from './polynomial.js';

function integerGcd(left: bigint, right: bigint): bigint {
  let a = left < 0n ? -left : left; let b = right < 0n ? -right : right;
  while (b !== 0n) { const remainder = a % b; a = b; b = remainder; }
  return a;
}
const MAX_ALGEBRAIC_DEGREE = 25;
/** Public syntax cap; the smaller direct work domain is checked separately. */
const MAX_ROOT_REFINEMENT_BITS = 24;
/** Direct validation helpers have a small deterministic coefficient budget. */
const MAX_DIRECT_ROOT_DEGREE = 8;
const MAX_DIRECT_ROOT_REFINEMENT_BITS = 24;
const MAX_DIRECT_ROOT_COEFFICIENT_BITS = 512;
const MAX_DIRECT_ROOT_TOTAL_BITS = 4_096;
/** Mutable arrays here never dispatch through caller-mutable prototypes. */
function ownArray<T>(length: number): T[] { return new Array<T>(length); }
function ownSet<T>(target: T[], index: number, value: T): void {
  Object.defineProperty(target, index, { value, enumerable: true, writable: true, configurable: true });
}
function ownAppend<T>(target: T[], value: T): void { ownSet(target, target.length, value); }
/** Positive primitive scaling preserves every Sturm sign while preventing fraction swell. */
function primitive(value: RationalPolynomial): RationalPolynomial {
  let common = 1n;
  for (let index = 0; index < value.length; index++) {
    const coefficient = value[index]!;
    common = common / integerGcd(common, coefficient.denominator) * coefficient.denominator;
  }
  const integers = ownArray<bigint>(value.length);
  let content = 0n;
  for (let index = 0; index < value.length; index++) {
    const integer = value[index]!.numerator * (common / value[index]!.denominator);
    ownSet(integers, index, integer);
    content = integerGcd(content, integer);
  }
  const divisor = content || 1n;
  const coefficients = ownArray<Rational>(integers.length);
  for (let index = 0; index < integers.length; index++) ownSet(coefficients, index, rational(integers[index]! / divisor));
  return polynomial(coefficients);
}
function canonicalAlgebraicPolynomial(value: RationalPolynomial): RationalPolynomial {
  const normalized = canonicalPolynomial(value, 'Algebraic polynomial');
  if (degree(normalized) > MAX_ALGEBRAIC_DEGREE) {
    throw new RangeError(`Algebraic polynomial degree must be in [0, ${MAX_ALGEBRAIC_DEGREE}]`);
  }
  return normalized;
}

export interface RationalInterval { readonly lower: Rational; readonly upper: Rational; }
const normalizedIntervals = new WeakSet<object>();
export const interval = (lower: Rational, upper: Rational): RationalInterval => {
  const lowerCopy = canonicalRational(lower, 'Interval lower bound'); const upperCopy = canonicalRational(upper, 'Interval upper bound');
  if (compare(lowerCopy, upperCopy) > 0) throw new RangeError('Invalid rational interval');
  const result = Object.freeze({ lower: lowerCopy, upper: upperCopy }); normalizedIntervals.add(result); return result;
};
function canonicalInterval(value: RationalInterval, name: string): RationalInterval {
  if (typeof value === 'object' && value !== null && normalizedIntervals.has(value)) return value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RangeError(`${name} must be a rational interval`);
  let descriptors: PropertyDescriptorMap;
  try {
    if (types.isProxy(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) throw new TypeError();
    descriptors = Object.getOwnPropertyDescriptors(value);
  }
  catch { throw new RangeError(`${name} must not be a Proxy or dynamic object`); }
  if (Reflect.ownKeys(descriptors).length !== 2 || !Object.hasOwn(descriptors, 'lower') || !Object.hasOwn(descriptors, 'upper')) throw new RangeError(`${name} has unexpected fields`);
  const lower = descriptors.lower!; const upper = descriptors.upper!;
  if (!Object.hasOwn(lower, 'value') || !Object.hasOwn(upper, 'value') || lower.get !== undefined || lower.set !== undefined || upper.get !== undefined || upper.set !== undefined) throw new RangeError(`${name} must not contain accessors`);
  return interval(lower.value as Rational, upper.value as Rational);
}
export function intervalAdd(a: RationalInterval, b: RationalInterval): RationalInterval { const left = canonicalInterval(a, 'Left interval'); const right = canonicalInterval(b, 'Right interval'); return interval(add(left.lower, right.lower), add(left.upper, right.upper)); }
export function intervalSubtract(a: RationalInterval, b: RationalInterval): RationalInterval { const left = canonicalInterval(a, 'Left interval'); const right = canonicalInterval(b, 'Right interval'); return interval(subtract(left.lower, right.upper), subtract(left.upper, right.lower)); }
export function intervalMultiply(a: RationalInterval, b: RationalInterval): RationalInterval {
  const left = canonicalInterval(a, 'Left interval'); const right = canonicalInterval(b, 'Right interval');
  const values = [multiply(left.lower, right.lower), multiply(left.lower, right.upper), multiply(left.upper, right.lower), multiply(left.upper, right.upper)];
  let minimum = values[0]!; let maximum = values[0]!;
  for (let index = 1; index < values.length; index++) {
    const candidate = values[index]!;
    if (compare(candidate, minimum) < 0) minimum = candidate;
    if (compare(candidate, maximum) > 0) maximum = candidate;
  }
  return interval(minimum, maximum);
}
export function intervalDividePositive(a: RationalInterval, b: RationalInterval): RationalInterval {
  const dividend = canonicalInterval(a, 'Dividend interval'); const divisor = canonicalInterval(b, 'Divisor interval');
  if (compare(divisor.lower, ZERO) <= 0) throw new RangeError('Interval divisor must be positive');
  // Division by a positive interval is monotone in neither argument when the
  // dividend is signed.  Four exact endpoint quotients enclose all accepted
  // cases: negative, zero-crossing, positive, and singleton dividends.
  const values = [
    divide(dividend.lower, divisor.lower), divide(dividend.lower, divisor.upper),
    divide(dividend.upper, divisor.lower), divide(dividend.upper, divisor.upper),
  ];
  let minimum = values[0]!; let maximum = values[0]!;
  for (let index = 1; index < values.length; index++) {
    const candidate = values[index]!;
    if (compare(candidate, minimum) < 0) minimum = candidate;
    if (compare(candidate, maximum) > 0) maximum = candidate;
  }
  return interval(minimum, maximum);
}
export function evaluateInterval(value: RationalPolynomial, at: RationalInterval): RationalInterval {
  const polynomialValue = canonicalAlgebraicPolynomial(value); const atValue = canonicalInterval(at, 'Evaluation interval');
  let result = interval(ZERO, ZERO);
  for (let index = polynomialValue.length - 1; index >= 0; index--) result = intervalAdd(intervalMultiply(result, atValue), interval(polynomialValue[index]!, polynomialValue[index]!));
  return result;
}

function signsAt(sequence: readonly RationalPolynomial[], at: Rational): number[] {
  const signs = ownArray<number>(0);
  for (let index = 0; index < sequence.length; index++) {
    const sign = compare(evaluate(sequence[index]!, at), ZERO);
    if (sign !== 0) ownAppend(signs, sign);
  }
  return signs;
}
function variations(sequence: readonly RationalPolynomial[], at: Rational): number {
  const signs = signsAt(sequence, at);
  let total = 0;
  for (let index = 1; index < signs.length; index++) if (signs[index - 1] !== signs[index]) total++;
  return total;
}
/** Exact Sturm sequence; no floating arithmetic is used in root enumeration. */
function sturmSequenceWithinBudget(value: RationalPolynomial): readonly RationalPolynomial[] {
  const polynomialValue = canonicalAlgebraicPolynomial(value);
  if (isZero(polynomialValue)) throw new RangeError('Sturm sequence requires a nonzero polynomial');
  const sequence = ownArray<RationalPolynomial>(0);
  ownAppend(sequence, primitive(polynomialValue));
  ownAppend(sequence, primitive(derivative(polynomialValue)));
  while (!isZero(sequence[sequence.length - 1]!)) {
    const division = divideWithRemainder(sequence[sequence.length - 2]!, sequence[sequence.length - 1]!);
    const remainder = division[1]!;
    if (isZero(remainder)) break;
    ownAppend(sequence, primitive(polynomialNegate(remainder)));
  }
  return Object.freeze(sequence);
}
export function sturmSequence(value: RationalPolynomial): readonly RationalPolynomial[] {
  const normalized = canonicalAlgebraicPolynomial(value);
  if (!withinDirectRootBudget(normalized, MAX_DIRECT_ROOT_REFINEMENT_BITS)) throw new RangeError('Direct Sturm sequence exceeds deterministic validation budget');
  return sturmSequenceWithinBudget(normalized);
}
/** Exact Euclidean gcd, scaled only by positive content. */
function polynomialGcd(left: RationalPolynomial, right: RationalPolynomial): RationalPolynomial {
  let a = primitive(left); let b = primitive(right);
  while (!isZero(b)) {
    const division = divideWithRemainder(a, b);
    const remainder = division[1]!;
    a = b; b = isZero(remainder) ? remainder : primitive(remainder);
  }
  return a;
}
/** Distinct roots only: repeated endpoint roots must not corrupt Sturm signs. */
function squareFree(value: RationalPolynomial): RationalPolynomial {
  const slope = derivative(value);
  if (isZero(slope)) return value;
  const divisor = polynomialGcd(value, slope);
  const division = divideWithRemainder(value, divisor);
  const quotient = division[0]!; const remainder = division[1]!;
  if (!isZero(remainder)) throw new RangeError('Polynomial square-free division was not exact');
  return primitive(quotient);
}
function rootsInOpen(sequence: readonly RationalPolynomial[], polynomial: RationalPolynomial, lower: Rational, upper: Rational): number {
  const inclusiveUpper = variations(sequence, lower) - variations(sequence, upper);
  return inclusiveUpper - (compare(evaluate(polynomial, upper), ZERO) === 0 ? 1 : 0);
}
export interface RootIsolation { readonly exact: readonly Rational[]; readonly intervals: readonly RationalInterval[]; readonly unresolved: boolean; }
/** Isolate every distinct interior root using Sturm counts and dyadic bisection. */
function withinDirectRootBudget(value: RationalPolynomial, refinementBits: number): boolean {
  let totalBits = 0;
  for (let index = 0; index < value.length; index++) {
    const bits = rationalBitLength(value[index]!);
    totalBits += bits;
    if (bits > MAX_DIRECT_ROOT_COEFFICIENT_BITS || totalBits > MAX_DIRECT_ROOT_TOTAL_BITS) return false;
  }
  return degree(value) <= MAX_DIRECT_ROOT_DEGREE && refinementBits <= MAX_DIRECT_ROOT_REFINEMENT_BITS;
}
function isolateRoots(value: RationalPolynomial, lower: Rational, upper: Rational, refinementBits: number): RootIsolation {
  const polynomialValue = canonicalAlgebraicPolynomial(value); const lowerBound = canonicalRational(lower, 'Root lower bound'); const upperBound = canonicalRational(upper, 'Root upper bound');
  if (compare(lowerBound, upperBound) > 0) throw new RangeError('Root lower bound must not exceed upper bound');
  if (!Number.isSafeInteger(refinementBits) || refinementBits < 1 || refinementBits > MAX_ROOT_REFINEMENT_BITS) throw new RangeError(`Root refinement bits must be an integer in [1, ${MAX_ROOT_REFINEMENT_BITS}]`);
  if (degree(polynomialValue) <= 0) return Object.freeze({ exact: Object.freeze([]), intervals: Object.freeze([]), unresolved: false });
  const distinct = squareFree(polynomialValue); const sequence = sturmSequenceWithinBudget(distinct);
  const exact: Rational[] = [];
  const intervals: RationalInterval[] = [];
  let unresolved = false;
  const visit = (left: Rational, right: Rational, depth: number): void => {
    const count = rootsInOpen(sequence, distinct, left, right);
    if (count <= 0) return;
    // A singleton interval is an exact proof object. More than one root at
    // the hard refinement ceiling cannot be ordered safely, so fail closed.
    if (depth >= refinementBits) {
      if (count === 1) ownAppend(intervals, interval(left, right));
      else unresolved = true;
      return;
    }
    const middle = midpoint(left, right);
    if (compare(evaluate(polynomialValue, middle), ZERO) === 0) {
      ownAppend(exact, middle);
      visit(left, middle, depth + 1);
      visit(middle, right, depth + 1);
      return;
    }
    // Continue even for one root: its narrow interval is the certificate used
    // to enclose p(root), rather than a numerical point estimate.
    visit(left, middle, depth + 1);
    visit(middle, right, depth + 1);
  };
  visit(lowerBound, upperBound, 0);
  return Object.freeze({ exact: Object.freeze(exact), intervals: Object.freeze(intervals), unresolved });
}
/** Bounded direct root isolation for standalone diagnostic validation. */
export function isolateInteriorRoots(value: RationalPolynomial, lower: Rational, upper: Rational, refinementBits = MAX_DIRECT_ROOT_REFINEMENT_BITS): RootIsolation {
  const polynomialValue = canonicalAlgebraicPolynomial(value); const lowerBound = canonicalRational(lower, 'Root lower bound'); const upperBound = canonicalRational(upper, 'Root upper bound');
  if (!Number.isSafeInteger(refinementBits) || refinementBits < 1 || refinementBits > MAX_ROOT_REFINEMENT_BITS) throw new RangeError(`Root refinement bits must be an integer in [1, ${MAX_ROOT_REFINEMENT_BITS}]`);
  if (!withinDirectRootBudget(polynomialValue, refinementBits)) return Object.freeze({ exact: Object.freeze([]), intervals: Object.freeze([]), unresolved: true });
  return isolateRoots(polynomialValue, lowerBound, upperBound, refinementBits);
}
export interface MaximumCertificate { readonly lower: Rational; readonly upper: Rational; readonly stationaryPointCount: number; readonly indeterminate: boolean; }
/**
 * A certified enclosure of max p(x) on a closed rational interval. Endpoints
 * and every derivative root are included; interval arithmetic encloses values
 * at irrational stationary points.
 */
export function maximizePolynomial(
  value: RationalPolynomial, lower: Rational, upper: Rational, maxSplits = MAX_DIRECT_ROOT_REFINEMENT_BITS,
): MaximumCertificate {
  const polynomialValue = canonicalAlgebraicPolynomial(value); const lowerBound = canonicalRational(lower, 'Maximum lower bound'); const upperBound = canonicalRational(upper, 'Maximum upper bound');
  if (!Number.isSafeInteger(maxSplits) || maxSplits < 1 || maxSplits > MAX_ROOT_REFINEMENT_BITS) throw new RangeError(`Maximum root refinement must be an integer in [1, ${MAX_ROOT_REFINEMENT_BITS}]`);
  const roots = isolateInteriorRoots(derivative(polynomialValue), lowerBound, upperBound, maxSplits);
  let minimum = evaluate(polynomialValue, lowerBound);
  let maximum = minimum;
  const endpoint = evaluate(polynomialValue, upperBound);
  if (compare(endpoint, minimum) > 0) minimum = endpoint;
  if (compare(endpoint, maximum) > 0) maximum = endpoint;
  for (let index = 0; index < roots.exact.length; index++) {
    const candidate = evaluate(polynomialValue, roots.exact[index]!);
    if (compare(candidate, minimum) > 0) minimum = candidate;
    if (compare(candidate, maximum) > 0) maximum = candidate;
  }
  for (let index = 0; index < roots.intervals.length; index++) {
    const candidate = evaluateInterval(polynomialValue, roots.intervals[index]!);
    if (compare(candidate.lower, minimum) > 0) minimum = candidate.lower;
    if (compare(candidate.upper, maximum) > 0) maximum = candidate.upper;
  }
  return Object.freeze({ lower: minimum, upper: maximum, stationaryPointCount: roots.exact.length + roots.intervals.length, indeterminate: roots.unresolved });
}

/** Positive square-root enclosure by rational bisection. */
export function sqrtInterval(value: Rational, rounds = 56): RationalInterval {
  const radicand = canonicalRational(value, 'Square-root value');
  if (!Number.isSafeInteger(rounds) || rounds < 1 || rounds > 256) throw new RangeError('Square-root rounds must be an integer in [1, 256]');
  if (compare(radicand, ZERO) < 0) throw new RangeError('Square root requires a nonnegative rational');
  if (compare(radicand, ZERO) === 0) return interval(ZERO, ZERO);
  let lower = ZERO;
  let upper = compare(radicand, ONE) > 0 ? radicand : ONE;
  for (let round = 0; round < rounds; round++) {
    const middle = midpoint(lower, upper);
    if (compare(pow(middle, 2), radicand) <= 0) lower = middle;
    else upper = middle;
  }
  return interval(lower, upper);
}
