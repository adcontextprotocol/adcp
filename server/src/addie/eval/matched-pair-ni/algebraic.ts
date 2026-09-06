import { types } from 'node:util';
import { add, canonicalRational, compare, divide, midpoint, multiply, pow, rational, subtract, type Rational, ONE, ZERO } from './rational.js';
import { canonicalPolynomial, degree, derivative, divideWithRemainder, evaluate, isZero, polynomial, polynomialNegate, type RationalPolynomial } from './polynomial.js';

function integerGcd(left: bigint, right: bigint): bigint {
  let a = left < 0n ? -left : left; let b = right < 0n ? -right : right;
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}
const MAX_ALGEBRAIC_DEGREE = 25;
/** Public root isolation shares the engine's bounded 24-bit refinement cap. */
const MAX_ROOT_REFINEMENT_BITS = 24;
/** Root work must resolve conservatively rather than monopolize a process. */
const MAX_ALGEBRAIC_ROOT_MILLISECONDS = 3_000;
class AlgebraicDeadline {
  private readonly until = Date.now() + MAX_ALGEBRAIC_ROOT_MILLISECONDS;
  check(): void { if (Date.now() > this.until) throw new RangeError('Algebraic root isolation deadline exceeded'); }
}
/** Positive primitive scaling preserves every Sturm sign while preventing fraction swell. */
function primitive(value: RationalPolynomial, deadline?: AlgebraicDeadline): RationalPolynomial {
  let common = 1n;
  for (const coefficient of value) { deadline?.check(); common = common / integerGcd(common, coefficient.denominator) * coefficient.denominator; }
  const integers = value.map((coefficient) => coefficient.numerator * (common / coefficient.denominator));
  const content = integers.reduce((result, coefficient) => integerGcd(result, coefficient), 0n) || 1n;
  return polynomial(integers.map((coefficient) => rational(coefficient / content)));
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
  return interval(values.reduce((x, y) => compare(x, y) < 0 ? x : y), values.reduce((x, y) => compare(x, y) > 0 ? x : y));
}
export function intervalDividePositive(a: RationalInterval, b: RationalInterval): RationalInterval {
  const dividend = canonicalInterval(a, 'Dividend interval'); const divisor = canonicalInterval(b, 'Divisor interval');
  if (compare(divisor.lower, ZERO) <= 0) throw new RangeError('Interval divisor must be positive');
  return interval(divide(dividend.lower, divisor.upper), divide(dividend.upper, divisor.lower));
}
export function evaluateInterval(value: RationalPolynomial, at: RationalInterval): RationalInterval {
  const polynomialValue = canonicalAlgebraicPolynomial(value); const atValue = canonicalInterval(at, 'Evaluation interval');
  let result = interval(ZERO, ZERO);
  for (let index = polynomialValue.length - 1; index >= 0; index--) result = intervalAdd(intervalMultiply(result, atValue), interval(polynomialValue[index]!, polynomialValue[index]!));
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
function sturmSequenceWithinDeadline(value: RationalPolynomial, deadline: AlgebraicDeadline): readonly RationalPolynomial[] {
  const polynomialValue = canonicalAlgebraicPolynomial(value);
  if (isZero(polynomialValue)) throw new RangeError('Sturm sequence requires a nonzero polynomial');
  const sequence: RationalPolynomial[] = [primitive(polynomialValue, deadline), primitive(derivative(polynomialValue), deadline)];
  while (!isZero(sequence[sequence.length - 1]!)) {
    deadline.check();
    const [, remainder] = divideWithRemainder(sequence[sequence.length - 2]!, sequence[sequence.length - 1]!);
    if (isZero(remainder)) break;
    sequence.push(primitive(polynomialNegate(remainder), deadline));
  }
  return Object.freeze(sequence);
}
export function sturmSequence(value: RationalPolynomial): readonly RationalPolynomial[] {
  return sturmSequenceWithinDeadline(value, new AlgebraicDeadline());
}
/** Exact Euclidean gcd, scaled only by positive content. */
function polynomialGcd(left: RationalPolynomial, right: RationalPolynomial, deadline?: AlgebraicDeadline): RationalPolynomial {
  let a = primitive(left, deadline); let b = primitive(right, deadline);
  while (!isZero(b)) {
    deadline?.check();
    const [, remainder] = divideWithRemainder(a, b);
    a = b; b = isZero(remainder) ? remainder : primitive(remainder, deadline);
  }
  return a;
}
/** Distinct roots only: repeated endpoint roots must not corrupt Sturm signs. */
function squareFree(value: RationalPolynomial, deadline?: AlgebraicDeadline): RationalPolynomial {
  const slope = derivative(value);
  if (isZero(slope)) return value;
  const divisor = polynomialGcd(value, slope, deadline);
  const [quotient, remainder] = divideWithRemainder(value, divisor);
  if (!isZero(remainder)) throw new RangeError('Polynomial square-free division was not exact');
  return primitive(quotient, deadline);
}
function rootsInOpen(sequence: readonly RationalPolynomial[], polynomial: RationalPolynomial, lower: Rational, upper: Rational): number {
  const inclusiveUpper = variations(sequence, lower) - variations(sequence, upper);
  return inclusiveUpper - (compare(evaluate(polynomial, upper), ZERO) === 0 ? 1 : 0);
}
export interface RootIsolation { readonly exact: readonly Rational[]; readonly intervals: readonly RationalInterval[]; readonly unresolved: boolean; }
/** Isolate every distinct interior root using Sturm counts and dyadic bisection. */
export function isolateInteriorRoots(value: RationalPolynomial, lower: Rational, upper: Rational, refinementBits = 24): RootIsolation {
  const polynomialValue = canonicalAlgebraicPolynomial(value); const lowerBound = canonicalRational(lower, 'Root lower bound'); const upperBound = canonicalRational(upper, 'Root upper bound');
  if (compare(lowerBound, upperBound) > 0) throw new RangeError('Root lower bound must not exceed upper bound');
  if (!Number.isSafeInteger(refinementBits) || refinementBits < 1 || refinementBits > MAX_ROOT_REFINEMENT_BITS) throw new RangeError(`Root refinement bits must be an integer in [1, ${MAX_ROOT_REFINEMENT_BITS}]`);
  if (degree(polynomialValue) <= 0) return Object.freeze({ exact: Object.freeze([]), intervals: Object.freeze([]), unresolved: false });
  const deadline = new AlgebraicDeadline();
  let distinct: RationalPolynomial; let sequence: readonly RationalPolynomial[];
  try {
    distinct = squareFree(polynomialValue, deadline);
    sequence = sturmSequenceWithinDeadline(distinct, deadline);
  } catch (error) {
    if (error instanceof RangeError && /deadline/.test(error.message)) return Object.freeze({ exact: Object.freeze([]), intervals: Object.freeze([]), unresolved: true });
    throw error;
  }
  const exact: Rational[] = [];
  const intervals: RationalInterval[] = [];
  let unresolved = false;
  const visit = (left: Rational, right: Rational, depth: number): void => {
    try { deadline.check(); } catch { unresolved = true; return; }
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
    if (compare(evaluate(polynomialValue, middle), ZERO) === 0) {
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
  visit(lowerBound, upperBound, 0);
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
  const polynomialValue = canonicalAlgebraicPolynomial(value); const lowerBound = canonicalRational(lower, 'Maximum lower bound'); const upperBound = canonicalRational(upper, 'Maximum upper bound');
  if (!Number.isSafeInteger(maxSplits) || maxSplits < 1 || maxSplits > MAX_ROOT_REFINEMENT_BITS) throw new RangeError(`Maximum root refinement must be an integer in [1, ${MAX_ROOT_REFINEMENT_BITS}]`);
  const roots = isolateInteriorRoots(derivative(polynomialValue), lowerBound, upperBound, maxSplits);
  let minimum = evaluate(polynomialValue, lowerBound);
  let maximum = minimum;
  for (const point of [upperBound, ...roots.exact]) {
    const candidate = evaluate(polynomialValue, point);
    if (compare(candidate, minimum) > 0) minimum = candidate;
    if (compare(candidate, maximum) > 0) maximum = candidate;
  }
  for (const root of roots.intervals) {
    const candidate = evaluateInterval(polynomialValue, root);
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
