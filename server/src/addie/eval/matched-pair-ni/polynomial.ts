import { types } from 'node:util';
import { add, canonicalRational, compare, multiply, negate, rational, subtract, type Rational, ZERO } from './rational.js';

/** Coefficients are ascending by power and are normalized after every operation. */
export type RationalPolynomial = readonly Rational[];
export const MAX_RATIONAL_POLYNOMIAL_DEGREE = 25;
const normalizedPolynomials = new WeakSet<object>();

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
  const raw: Rational[] = [];
  try {
    for (let index = 0; index < length; index++) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.get !== undefined || descriptor.set !== undefined) throw new TypeError();
    }
    if (Reflect.ownKeys(descriptors).some((key) => key !== 'length' && (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/.test(key)))) throw new TypeError();
    for (let index = 0; index < length; index++) raw.push(descriptors[String(index)]!.value as Rational);
  } catch { throw new RangeError(`${name} must not be sparse, accessor-backed, or a Proxy`); }
  return Object.freeze(raw.map((coefficient) => canonicalRational(coefficient, `${name} coefficient`)));
}
/** Snapshot a canonical polynomial before it is read by another public helper. */
export function canonicalPolynomial(value: RationalPolynomial, name = 'Polynomial'): RationalPolynomial {
  const copied = inertCoefficients(value, name);
  if (copied.length > 1 && compare(copied[copied.length - 1]!, ZERO) === 0) throw new RangeError(`${name} must be canonical (no trailing zero coefficient)`);
  const result = Object.freeze([...copied]);
  normalizedPolynomials.add(result);
  return result;
}

export function polynomial(coefficients: readonly Rational[]): RationalPolynomial {
  const result = [...inertCoefficients(coefficients, 'Polynomial')];
  while (result.length > 1 && compare(result[result.length - 1]!, ZERO) === 0) result.pop();
  return canonicalPolynomial(Object.freeze(result.length === 0 ? [ZERO] : result), 'Polynomial');
}
export function constant(value: Rational): RationalPolynomial { return polynomial([value]); }
export function degree(value: RationalPolynomial): number { return canonicalPolynomial(value, 'Polynomial').length - 1; }
export function isZero(value: RationalPolynomial): boolean { const normalized = canonicalPolynomial(value, 'Polynomial'); return normalized.length === 1 && compare(normalized[0]!, ZERO) === 0; }
export function polynomialAdd(a: RationalPolynomial, b: RationalPolynomial): RationalPolynomial {
  const left = canonicalPolynomial(a, 'Left polynomial'); const right = canonicalPolynomial(b, 'Right polynomial');
  return polynomial(Array.from({ length: Math.max(left.length, right.length) }, (_, index) => add(left[index] ?? ZERO, right[index] ?? ZERO)));
}
export function polynomialSubtract(a: RationalPolynomial, b: RationalPolynomial): RationalPolynomial {
  const left = canonicalPolynomial(a, 'Left polynomial'); const right = canonicalPolynomial(b, 'Right polynomial');
  return polynomial(Array.from({ length: Math.max(left.length, right.length) }, (_, index) => subtract(left[index] ?? ZERO, right[index] ?? ZERO)));
}
export function polynomialScale(value: RationalPolynomial, scalar: Rational): RationalPolynomial { const normalized = canonicalPolynomial(value, 'Polynomial'); const factor = canonicalRational(scalar, 'Polynomial scalar'); return polynomial(normalized.map((item) => multiply(item, factor))); }
export function polynomialNegate(value: RationalPolynomial): RationalPolynomial { return polynomial(canonicalPolynomial(value, 'Polynomial').map(negate)); }
export function polynomialMultiply(a: RationalPolynomial, b: RationalPolynomial): RationalPolynomial {
  const left = canonicalPolynomial(a, 'Left polynomial'); const right = canonicalPolynomial(b, 'Right polynomial');
  if (left.length + right.length - 2 > MAX_RATIONAL_POLYNOMIAL_DEGREE) throw new RangeError(`Polynomial product exceeds degree ${MAX_RATIONAL_POLYNOMIAL_DEGREE}`);
  const result = Array.from({ length: left.length + right.length - 1 }, () => ZERO);
  for (let i = 0; i < left.length; i++) for (let j = 0; j < right.length; j++) result[i + j] = add(result[i + j]!, multiply(left[i]!, right[j]!));
  return polynomial(result);
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
  return polynomial(normalized.slice(1).map((coefficient, index) => multiply(coefficient, rational(index + 1))));
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
  const remainder = [...numerator];
  const quotient = Array.from({ length: Math.max(1, numerator.length - denominator.length + 1) }, () => ZERO);
  while (remainder.length - 1 >= denominator.length - 1 && !(remainder.length === 1 && compare(remainder[0]!, ZERO) === 0)) {
    const offset = remainder.length - denominator.length;
    const factor = multiply(remainder[remainder.length - 1]!, rational(denominator[denominator.length - 1]!.denominator, denominator[denominator.length - 1]!.numerator));
    quotient[offset] = add(quotient[offset]!, factor);
    for (let index = 0; index < denominator.length; index++) remainder[index + offset] = subtract(remainder[index + offset]!, multiply(factor, denominator[index]!));
    while (remainder.length > 1 && compare(remainder[remainder.length - 1]!, ZERO) === 0) remainder.pop();
  }
  return [polynomial(quotient), polynomial(remainder)];
}
