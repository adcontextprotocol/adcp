import { types } from 'node:util';
import { add, canonicalRational, compare, multiply, negate, rational, subtract, type Rational, ZERO } from './rational.js';

/** Coefficients are ascending by power and are normalized after every operation. */
export type RationalPolynomial = readonly Rational[];
export const MAX_RATIONAL_POLYNOMIAL_DEGREE = 25;
const normalizedPolynomials = new WeakSet<object>();

/** Build arrays without inherited Array.prototype setters, iterators, or map. */
function frozenArray<T>(length: number, at: (index: number) => T): readonly T[] {
  const result = new Array<T>(length);
  for (let index = 0; index < length; index++) Object.defineProperty(result, index, { value: at(index), enumerable: true, writable: false, configurable: false });
  return Object.freeze(result);
}

function primitiveLabel(value: unknown, fallback = 'Polynomial'): string {
  if (value === undefined) return fallback;
  if (typeof value !== 'string') throw new RangeError('Polynomial label must be a primitive string');
  return value;
}

/** Reject sparse, accessor, and Proxy arrays before copying coefficients once. */
function inertCoefficients(value: RationalPolynomial, name: string): readonly Rational[] {
  if (typeof value === 'object' && value !== null && normalizedPolynomials.has(value)) return value;
  if (!Array.isArray(value) || types.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) throw new RangeError(`${name} must not be sparse, accessor-backed, aliased, or a Proxy`);
  let descriptors: Record<PropertyKey, PropertyDescriptor>;
  try { descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<PropertyKey, PropertyDescriptor>; }
  catch { throw new RangeError(`${name} must not be sparse, accessor-backed, aliased, or a Proxy`); }
  const lengthDescriptor = descriptors.length;
  if (!lengthDescriptor || !Object.hasOwn(lengthDescriptor, 'value') || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value === 0 || lengthDescriptor.value - 1 > MAX_RATIONAL_POLYNOMIAL_DEGREE) throw new RangeError(`${name} degree must be in [0, ${MAX_RATIONAL_POLYNOMIAL_DEGREE}]`);
  const length = lengthDescriptor.value as number;
  const raw: Rational[] = new Array(length);
  try {
    for (let index = 0; index < length; index++) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.get !== undefined || descriptor.set !== undefined) throw new TypeError();
    }
    // Do not dispatch through Array.prototype helpers here: this boundary is
    // deliberately usable while a caller has poisoned Array.prototype.
    const keys = Reflect.ownKeys(descriptors);
    for (let index = 0; index < keys.length; index++) {
      const key = keys[index]!;
      if (key !== 'length' && (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/.test(key))) throw new TypeError();
    }
    for (let index = 0; index < length; index++) Object.defineProperty(raw, index, { value: descriptors[String(index)]!.value as Rational, enumerable: true, writable: false, configurable: false });
  } catch { throw new RangeError(`${name} must not be sparse, accessor-backed, or a Proxy`); }
  return frozenArray(length, (index) => canonicalRational(raw[index]!, `${name} coefficient`));
}
/** Snapshot a canonical polynomial before it is read by another public helper. */
export function canonicalPolynomial(value: RationalPolynomial, name = 'Polynomial'): RationalPolynomial {
  const label = primitiveLabel(name);
  const copied = inertCoefficients(value, label);
  if (copied.length > 1 && compare(copied[copied.length - 1]!, ZERO) === 0) throw new RangeError(`${label} must be canonical (no trailing zero coefficient)`);
  const result = frozenArray(copied.length, (index) => copied[index]!);
  normalizedPolynomials.add(result);
  return result;
}

export function polynomial(coefficients: readonly Rational[]): RationalPolynomial {
  const copied = inertCoefficients(coefficients, 'Polynomial');
  let length = copied.length;
  while (length > 1 && compare(copied[length - 1]!, ZERO) === 0) length--;
  return canonicalPolynomial(frozenArray(length, (index) => copied[index]!), 'Polynomial');
}
export function constant(value: Rational): RationalPolynomial { return polynomial([value]); }
export function degree(value: RationalPolynomial): number { return canonicalPolynomial(value, 'Polynomial').length - 1; }
export function isZero(value: RationalPolynomial): boolean { const normalized = canonicalPolynomial(value, 'Polynomial'); return normalized.length === 1 && compare(normalized[0]!, ZERO) === 0; }
export function polynomialAdd(a: RationalPolynomial, b: RationalPolynomial): RationalPolynomial {
  const left = canonicalPolynomial(a, 'Left polynomial'); const right = canonicalPolynomial(b, 'Right polynomial');
  return polynomial(frozenArray(Math.max(left.length, right.length), (index) => add(left[index] ?? ZERO, right[index] ?? ZERO)));
}
export function polynomialSubtract(a: RationalPolynomial, b: RationalPolynomial): RationalPolynomial {
  const left = canonicalPolynomial(a, 'Left polynomial'); const right = canonicalPolynomial(b, 'Right polynomial');
  return polynomial(frozenArray(Math.max(left.length, right.length), (index) => subtract(left[index] ?? ZERO, right[index] ?? ZERO)));
}
export function polynomialScale(value: RationalPolynomial, scalar: Rational): RationalPolynomial { const normalized = canonicalPolynomial(value, 'Polynomial'); const factor = canonicalRational(scalar, 'Polynomial scalar'); return polynomial(frozenArray(normalized.length, (index) => multiply(normalized[index]!, factor))); }
export function polynomialNegate(value: RationalPolynomial): RationalPolynomial { const normalized = canonicalPolynomial(value, 'Polynomial'); return polynomial(frozenArray(normalized.length, (index) => negate(normalized[index]!))); }
export function polynomialMultiply(a: RationalPolynomial, b: RationalPolynomial): RationalPolynomial {
  const left = canonicalPolynomial(a, 'Left polynomial'); const right = canonicalPolynomial(b, 'Right polynomial');
  if (left.length + right.length - 2 > MAX_RATIONAL_POLYNOMIAL_DEGREE) throw new RangeError(`Polynomial product exceeds degree ${MAX_RATIONAL_POLYNOMIAL_DEGREE}`);
  const result: Rational[] = new Array(left.length + right.length - 1);
  for (let index = 0; index < result.length; index++) Object.defineProperty(result, index, { value: ZERO, enumerable: true, writable: true, configurable: false });
  for (let i = 0; i < left.length; i++) for (let j = 0; j < right.length; j++) Object.defineProperty(result, i + j, { value: add(result[i + j]!, multiply(left[i]!, right[j]!)), enumerable: true, writable: true, configurable: false });
  return polynomial(frozenArray(result.length, (index) => result[index]!));
}
export function polynomialPow(value: RationalPolynomial, exponent: number): RationalPolynomial {
  const normalized = canonicalPolynomial(value, 'Polynomial');
  if (!Number.isSafeInteger(exponent) || exponent < 0) throw new RangeError('Polynomial exponent must be nonnegative');
  let base = normalized;
  let result = constant(rational(1));
  for (let e = exponent; e > 0; e = Math.floor(e / 2)) {
    if (e % 2) result = polynomialMultiply(result, base);
    if (e > 1) base = polynomialMultiply(base, base);
  }
  return result;
}
export function derivative(value: RationalPolynomial): RationalPolynomial {
  const normalized = canonicalPolynomial(value, 'Polynomial');
  if (normalized.length === 1) return polynomial([ZERO]);
  return polynomial(frozenArray(normalized.length - 1, (index) => multiply(normalized[index + 1]!, rational(index + 1))));
}
export function evaluate(value: RationalPolynomial, at: Rational): Rational {
  const normalized = canonicalPolynomial(value, 'Polynomial'); const point = canonicalRational(at, 'Evaluation point');
  let result = ZERO;
  for (let index = normalized.length - 1; index >= 0; index--) result = add(multiply(result, point), normalized[index]!);
  return result;
}
/** Exact polynomial long division. */
export function divideWithRemainder(dividend: RationalPolynomial, divisor: RationalPolynomial): readonly [RationalPolynomial, RationalPolynomial] {
  const numerator = canonicalPolynomial(dividend, 'Dividend'); const denominator = canonicalPolynomial(divisor, 'Divisor');
  if (isZero(denominator)) throw new RangeError('Polynomial division by zero');
  let remainder = frozenArray(numerator.length, (index) => numerator[index]!);
  const quotient: Rational[] = new Array(Math.max(1, numerator.length - denominator.length + 1));
  for (let index = 0; index < quotient.length; index++) Object.defineProperty(quotient, index, { value: ZERO, enumerable: true, writable: true, configurable: false });
  while (remainder.length - 1 >= denominator.length - 1 && !(remainder.length === 1 && compare(remainder[0]!, ZERO) === 0)) {
    const offset = remainder.length - denominator.length;
    const factor = multiply(remainder[remainder.length - 1]!, rational(denominator[denominator.length - 1]!.denominator, denominator[denominator.length - 1]!.numerator));
    Object.defineProperty(quotient, offset, { value: add(quotient[offset]!, factor), enumerable: true, writable: true, configurable: false });
    const updated: Rational[] = new Array(remainder.length);
    for (let index = 0; index < remainder.length; index++) Object.defineProperty(updated, index, { value: index >= offset && index < offset + denominator.length ? subtract(remainder[index]!, multiply(factor, denominator[index - offset]!)) : remainder[index]!, enumerable: true, writable: false, configurable: false });
    let remainderLength = updated.length;
    while (remainderLength > 1 && compare(updated[remainderLength - 1]!, ZERO) === 0) remainderLength--;
    remainder = frozenArray(remainderLength, (index) => updated[index]!);
  }
  return [polynomial(frozenArray(quotient.length, (index) => quotient[index]!)), polynomial(remainder)];
}
