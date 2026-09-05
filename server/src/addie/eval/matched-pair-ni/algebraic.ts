import { add, compare, divide, midpoint, multiply, pow, rational, subtract, type Rational, validateBoundedRational, ONE, ZERO } from './rational.js';
import { degree, derivative, divideWithRemainder, evaluate, isZero, polynomialNegate, type RationalPolynomial } from './polynomial.js';

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
const MAX_ALGEBRAIC_DEGREE = 25;
function validateAlgebraicPolynomial(value: RationalPolynomial): void {
  if (!Array.isArray(value) || value.length === 0 || degree(value) > MAX_ALGEBRAIC_DEGREE) {
    throw new RangeError(`Algebraic polynomial degree must be in [0, ${MAX_ALGEBRAIC_DEGREE}]`);
  }
  for (const coefficient of value) validateBoundedRational(coefficient, 'Polynomial coefficient');
}

export interface RationalInterval { readonly lower: Rational; readonly upper: Rational; }
export const interval = (lower: Rational, upper: Rational): RationalInterval => {
  validateBoundedRational(lower, 'Interval lower bound'); validateBoundedRational(upper, 'Interval upper bound');
  if (compare(lower, upper) > 0) throw new RangeError('Invalid rational interval');
  return Object.freeze({ lower, upper });
};
function validateInterval(value: RationalInterval, name: string): void {
  if (!value || typeof value !== 'object') throw new RangeError(`${name} must be a rational interval`);
  interval(value.lower, value.upper);
}
export function intervalAdd(a: RationalInterval, b: RationalInterval): RationalInterval { validateInterval(a, 'Left interval'); validateInterval(b, 'Right interval'); return interval(add(a.lower, b.lower), add(a.upper, b.upper)); }
export function intervalSubtract(a: RationalInterval, b: RationalInterval): RationalInterval { validateInterval(a, 'Left interval'); validateInterval(b, 'Right interval'); return interval(subtract(a.lower, b.upper), subtract(a.upper, b.lower)); }
export function intervalMultiply(a: RationalInterval, b: RationalInterval): RationalInterval {
  validateInterval(a, 'Left interval'); validateInterval(b, 'Right interval');
  const values = [multiply(a.lower, b.lower), multiply(a.lower, b.upper), multiply(a.upper, b.lower), multiply(a.upper, b.upper)];
  return interval(values.reduce((x, y) => compare(x, y) < 0 ? x : y), values.reduce((x, y) => compare(x, y) > 0 ? x : y));
}
export function intervalDividePositive(a: RationalInterval, b: RationalInterval): RationalInterval {
  validateInterval(a, 'Dividend interval'); validateInterval(b, 'Divisor interval');
  if (compare(b.lower, ZERO) <= 0) throw new RangeError('Interval divisor must be positive');
  return interval(divide(a.lower, b.upper), divide(a.upper, b.lower));
}
export function evaluateInterval(value: RationalPolynomial, at: RationalInterval): RationalInterval {
  validateAlgebraicPolynomial(value); validateInterval(at, 'Evaluation interval');
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
  validateAlgebraicPolynomial(value);
  if (isZero(value)) throw new RangeError('Sturm sequence requires a nonzero polynomial');
  const sequence: RationalPolynomial[] = [primitive(value), primitive(derivative(value))];
  while (!isZero(sequence[sequence.length - 1]!)) {
    const [, remainder] = divideWithRemainder(sequence[sequence.length - 2]!, sequence[sequence.length - 1]!);
    if (isZero(remainder)) break;
    sequence.push(primitive(polynomialNegate(remainder)));
  }
  return Object.freeze(sequence);
}
/** Exact Euclidean gcd, scaled only by positive content. */
function polynomialGcd(left: RationalPolynomial, right: RationalPolynomial): RationalPolynomial {
  let a = primitive(left); let b = primitive(right);
  while (!isZero(b)) {
    const [, remainder] = divideWithRemainder(a, b);
    a = b; b = isZero(remainder) ? remainder : primitive(remainder);
  }
  return a;
}
/** Distinct roots only: repeated endpoint roots must not corrupt Sturm signs. */
function squareFree(value: RationalPolynomial): RationalPolynomial {
  const slope = derivative(value);
  if (isZero(slope)) return value;
  const divisor = polynomialGcd(value, slope);
  const [quotient, remainder] = divideWithRemainder(value, divisor);
  if (!isZero(remainder)) throw new RangeError('Polynomial square-free division was not exact');
  return primitive(quotient);
}
function rootsInOpen(sequence: readonly RationalPolynomial[], polynomial: RationalPolynomial, lower: Rational, upper: Rational): number {
  const inclusiveUpper = variations(sequence, lower) - variations(sequence, upper);
  return inclusiveUpper - (compare(evaluate(polynomial, upper), ZERO) === 0 ? 1 : 0);
}
export interface RootIsolation { readonly exact: readonly Rational[]; readonly intervals: readonly RationalInterval[]; readonly unresolved: boolean; }
/** Isolate every distinct interior root using Sturm counts and dyadic bisection. */
export function isolateInteriorRoots(value: RationalPolynomial, lower: Rational, upper: Rational, refinementBits = 96): RootIsolation {
  validateAlgebraicPolynomial(value); validateBoundedRational(lower, 'Root lower bound'); validateBoundedRational(upper, 'Root upper bound');
  if (compare(lower, upper) > 0) throw new RangeError('Root lower bound must not exceed upper bound');
  if (degree(value) <= 0) return Object.freeze({ exact: Object.freeze([]), intervals: Object.freeze([]), unresolved: false });
  if (!Number.isSafeInteger(refinementBits) || refinementBits < 1 || refinementBits > 64) throw new RangeError('Root refinement bits must be an integer in [1, 64]');
  const distinct = squareFree(value);
  const sequence = sturmSequence(distinct);
  const exact: Rational[] = [];
  const intervals: RationalInterval[] = [];
  let unresolved = false;
  const visit = (left: Rational, right: Rational, depth: number): void => {
    const count = rootsInOpen(sequence, distinct, left, right);
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
): MaximumCertificate {
  validateAlgebraicPolynomial(value); validateBoundedRational(lower, 'Maximum lower bound'); validateBoundedRational(upper, 'Maximum upper bound');
  if (!Number.isSafeInteger(maxSplits) || maxSplits < 1 || maxSplits > 64) throw new RangeError('Maximum root refinement must be an integer in [1, 64]');
  const roots = isolateInteriorRoots(derivative(value), lower, upper, maxSplits);
  let minimum = evaluate(value, lower);
  let maximum = minimum;
  for (const point of [upper, ...roots.exact]) {
    const candidate = evaluate(value, point);
    if (compare(candidate, minimum) > 0) minimum = candidate;
    if (compare(candidate, maximum) > 0) maximum = candidate;
  }
  for (const root of roots.intervals) {
    const candidate = evaluateInterval(value, root);
    if (compare(candidate.lower, minimum) > 0) minimum = candidate.lower;
    if (compare(candidate.upper, maximum) > 0) maximum = candidate.upper;
  }
  return Object.freeze({ lower: minimum, upper: maximum, stationaryPointCount: roots.exact.length + roots.intervals.length, indeterminate: roots.unresolved });
}

/** Positive square-root enclosure by rational bisection. */
export function sqrtInterval(value: Rational, rounds = 56): RationalInterval {
  validateBoundedRational(value, 'Square-root value');
  if (!Number.isSafeInteger(rounds) || rounds < 1 || rounds > 256) throw new RangeError('Square-root rounds must be an integer in [1, 256]');
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
