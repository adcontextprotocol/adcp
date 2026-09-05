import { add, compare, divide, midpoint, multiply, negate, pow, rational, subtract, type Rational, ONE, ZERO } from './rational.js';
import { degree, derivative, divideWithRemainder, evaluate, isZero, polynomialNegate, polynomialScale, type RationalPolynomial } from './polynomial.js';

function integerGcd(left: bigint, right: bigint): bigint {
  let a = left < 0n ? -left : left; let b = right < 0n ? -right : right;
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}
/** Positive primitive scaling preserves every Sturm sign while preventing fraction swell. */
function primitive(value: RationalPolynomial): RationalPolynomial {
  let common = 1n;
  for (const coefficient of value) common = common / integerGcd(common, coefficient.denominator) * coefficient.denominator;
  const integers = value.map((coefficient) => coefficient.numerator * (common / coefficient.denominator));
  const content = integers.reduce((result, coefficient) => integerGcd(result, coefficient), 0n) || 1n;
  return Object.freeze(integers.map((coefficient) => rational(coefficient / content)));
}

export interface RationalInterval { readonly lower: Rational; readonly upper: Rational; }
export const interval = (lower: Rational, upper: Rational): RationalInterval => {
  if (compare(lower, upper) > 0) throw new RangeError('Invalid rational interval');
  return Object.freeze({ lower, upper });
};
export function intervalAdd(a: RationalInterval, b: RationalInterval): RationalInterval { return interval(add(a.lower, b.lower), add(a.upper, b.upper)); }
export function intervalSubtract(a: RationalInterval, b: RationalInterval): RationalInterval { return interval(subtract(a.lower, b.upper), subtract(a.upper, b.lower)); }
export function intervalMultiply(a: RationalInterval, b: RationalInterval): RationalInterval {
  const values = [multiply(a.lower, b.lower), multiply(a.lower, b.upper), multiply(a.upper, b.lower), multiply(a.upper, b.upper)];
  return interval(values.reduce((x, y) => compare(x, y) < 0 ? x : y), values.reduce((x, y) => compare(x, y) > 0 ? x : y));
}
export function intervalDividePositive(a: RationalInterval, b: RationalInterval): RationalInterval {
  if (compare(b.lower, ZERO) <= 0) throw new RangeError('Interval divisor must be positive');
  return interval(divide(a.lower, b.upper), divide(a.upper, b.lower));
}
export function evaluateInterval(value: RationalPolynomial, at: RationalInterval): RationalInterval {
  let result = interval(ZERO, ZERO);
  for (let index = value.length - 1; index >= 0; index--) result = intervalAdd(intervalMultiply(result, at), interval(value[index]!, value[index]!));
  return result;
}

function signsAt(sequence: readonly RationalPolynomial[], at: Rational): number[] {
  return sequence.map((item) => compare(evaluate(item, at), ZERO)).filter((value) => value !== 0);
}
function variations(sequence: readonly RationalPolynomial[], at: Rational): number {
  const signs = signsAt(sequence, at);
  return signs.reduce((total, item, index) => total + (index > 0 && signs[index - 1] !== item ? 1 : 0), 0);
}
/** Exact Sturm sequence; no floating arithmetic is used in root enumeration. */
export function sturmSequence(value: RationalPolynomial): readonly RationalPolynomial[] {
  if (isZero(value)) throw new RangeError('Sturm sequence requires a nonzero polynomial');
  const sequence: RationalPolynomial[] = [primitive(value), primitive(derivative(value))];
  while (!isZero(sequence[sequence.length - 1]!)) {
    const [, remainder] = divideWithRemainder(sequence[sequence.length - 2]!, sequence[sequence.length - 1]!);
    if (isZero(remainder)) break;
    sequence.push(primitive(polynomialNegate(remainder)));
  }
  return Object.freeze(sequence);
}
function rootsInOpen(sequence: readonly RationalPolynomial[], polynomial: RationalPolynomial, lower: Rational, upper: Rational): number {
  const inclusiveUpper = variations(sequence, lower) - variations(sequence, upper);
  return inclusiveUpper - (compare(evaluate(polynomial, upper), ZERO) === 0 ? 1 : 0);
}
export interface RootIsolation { readonly exact: readonly Rational[]; readonly intervals: readonly RationalInterval[]; readonly unresolved: boolean; }
/** Isolate every distinct interior root using Sturm counts and dyadic bisection. */
export function isolateInteriorRoots(value: RationalPolynomial, lower: Rational, upper: Rational, refinementBits = 96): RootIsolation {
  if (degree(value) <= 0) return Object.freeze({ exact: Object.freeze([]), intervals: Object.freeze([]), unresolved: false });
  const sequence = sturmSequence(value);
  const exact: Rational[] = [];
  const intervals: RationalInterval[] = [];
  let unresolved = false;
  const visit = (left: Rational, right: Rational, depth: number): void => {
    const count = rootsInOpen(sequence, value, left, right);
    if (count <= 0) return;
    // A singleton interval is an exact proof object. More than one root at
    // the hard refinement ceiling cannot be ordered safely, so fail closed.
    if (depth >= refinementBits) {
      if (count === 1) intervals.push(interval(left, right));
      else unresolved = true;
      return;
    }
    const middle = midpoint(left, right);
    if (compare(evaluate(value, middle), ZERO) === 0) {
      exact.push(middle);
      visit(left, middle, depth + 1);
      visit(middle, right, depth + 1);
      return;
    }
    // Continue even for one root: its narrow interval is the certificate used
    // to enclose p(root), rather than a numerical point estimate.
    visit(left, middle, depth + 1);
    visit(middle, right, depth + 1);
  };
  visit(lower, upper, 0);
  return Object.freeze({ exact: Object.freeze(exact), intervals: Object.freeze(intervals), unresolved });
}

export interface MaximumCertificate { readonly lower: Rational; readonly upper: Rational; readonly stationaryPointCount: number; readonly indeterminate: boolean; }
/**
 * A certified enclosure of max p(x) on a closed rational interval. Endpoints
 * and every derivative root are included; interval arithmetic encloses values
 * at irrational stationary points.
 */
export function maximizePolynomial(
  value: RationalPolynomial, lower: Rational, upper: Rational, maxSplits = 24,
  encloseAt: ((at: RationalInterval) => RationalInterval) | undefined = undefined,
): MaximumCertificate {
  const roots = isolateInteriorRoots(derivative(value), lower, upper, maxSplits);
  let minimum = evaluate(value, lower);
  let maximum = minimum;
  for (const point of [upper, ...roots.exact]) {
    const candidate = evaluate(value, point);
    if (compare(candidate, minimum) > 0) minimum = candidate;
    if (compare(candidate, maximum) > 0) maximum = candidate;
  }
  for (const root of roots.intervals) {
    const candidate = encloseAt ? encloseAt(root) : evaluateInterval(value, root);
    if (compare(candidate.lower, minimum) > 0) minimum = candidate.lower;
    if (compare(candidate.upper, maximum) > 0) maximum = candidate.upper;
  }
  return Object.freeze({ lower: minimum, upper: maximum, stationaryPointCount: roots.exact.length + roots.intervals.length, indeterminate: roots.unresolved });
}

/** Positive square-root enclosure by rational bisection. */
export function sqrtInterval(value: Rational, rounds = 56): RationalInterval {
  if (compare(value, ZERO) < 0) throw new RangeError('Square root requires a nonnegative rational');
  if (compare(value, ZERO) === 0) return interval(ZERO, ZERO);
  let lower = ZERO;
  let upper = compare(value, ONE) > 0 ? value : ONE;
  for (let round = 0; round < rounds; round++) {
    const middle = midpoint(lower, upper);
    if (compare(pow(middle, 2), value) <= 0) lower = middle;
    else upper = middle;
  }
  return interval(lower, upper);
}
