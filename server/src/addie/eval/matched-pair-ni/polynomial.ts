import { add, compare, multiply, negate, rational, subtract, type Rational, ZERO } from './rational.js';

/** Coefficients are ascending by power and are normalized after every operation. */
export type RationalPolynomial = readonly Rational[];

export function polynomial(coefficients: readonly Rational[]): RationalPolynomial {
  const result = [...coefficients];
  while (result.length > 1 && compare(result[result.length - 1]!, ZERO) === 0) result.pop();
  return Object.freeze(result.length === 0 ? [ZERO] : result);
}
export function constant(value: Rational): RationalPolynomial { return polynomial([value]); }
export function degree(value: RationalPolynomial): number { return value.length - 1; }
export function isZero(value: RationalPolynomial): boolean { return value.length === 1 && compare(value[0]!, ZERO) === 0; }
export function polynomialAdd(a: RationalPolynomial, b: RationalPolynomial): RationalPolynomial {
  return polynomial(Array.from({ length: Math.max(a.length, b.length) }, (_, index) => add(a[index] ?? ZERO, b[index] ?? ZERO)));
}
export function polynomialSubtract(a: RationalPolynomial, b: RationalPolynomial): RationalPolynomial {
  return polynomial(Array.from({ length: Math.max(a.length, b.length) }, (_, index) => subtract(a[index] ?? ZERO, b[index] ?? ZERO)));
}
export function polynomialScale(value: RationalPolynomial, scalar: Rational): RationalPolynomial { return polynomial(value.map((item) => multiply(item, scalar))); }
export function polynomialNegate(value: RationalPolynomial): RationalPolynomial { return polynomial(value.map(negate)); }
export function polynomialMultiply(a: RationalPolynomial, b: RationalPolynomial): RationalPolynomial {
  const result = Array.from({ length: a.length + b.length - 1 }, () => ZERO);
  for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++) result[i + j] = add(result[i + j]!, multiply(a[i]!, b[j]!));
  return polynomial(result);
}
export function polynomialPow(value: RationalPolynomial, exponent: number): RationalPolynomial {
  if (!Number.isSafeInteger(exponent) || exponent < 0) throw new RangeError('Polynomial exponent must be nonnegative');
  let base = value;
  let result = constant(rational(1));
  for (let e = exponent; e > 0; e = Math.floor(e / 2)) {
    if (e % 2) result = polynomialMultiply(result, base);
    base = polynomialMultiply(base, base);
  }
  return result;
}
export function derivative(value: RationalPolynomial): RationalPolynomial {
  return polynomial(value.slice(1).map((coefficient, index) => multiply(coefficient, rational(index + 1))));
}
export function evaluate(value: RationalPolynomial, at: Rational): Rational {
  let result = ZERO;
  for (let index = value.length - 1; index >= 0; index--) result = add(multiply(result, at), value[index]!);
  return result;
}
/** Exact polynomial long division. */
export function divideWithRemainder(dividend: RationalPolynomial, divisor: RationalPolynomial): readonly [RationalPolynomial, RationalPolynomial] {
  if (isZero(divisor)) throw new RangeError('Polynomial division by zero');
  const remainder = [...dividend];
  const quotient = Array.from({ length: Math.max(1, degree(dividend) - degree(divisor) + 1) }, () => ZERO);
  while (remainder.length - 1 >= degree(divisor) && !(remainder.length === 1 && compare(remainder[0]!, ZERO) === 0)) {
    const offset = remainder.length - 1 - degree(divisor);
    const factor = multiply(remainder[remainder.length - 1]!, rational(divisor[divisor.length - 1]!.denominator, divisor[divisor.length - 1]!.numerator));
    quotient[offset] = add(quotient[offset]!, factor);
    for (let index = 0; index < divisor.length; index++) remainder[index + offset] = subtract(remainder[index + offset]!, multiply(factor, divisor[index]!));
    while (remainder.length > 1 && compare(remainder[remainder.length - 1]!, ZERO) === 0) remainder.pop();
  }
  return [polynomial(quotient), polynomial(remainder)];
}
