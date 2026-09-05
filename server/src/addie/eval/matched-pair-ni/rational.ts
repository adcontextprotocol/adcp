/** Normalized, finite BigInt rational arithmetic for the diagnostic NI slice. */
export interface Rational { readonly numerator: bigint; readonly denominator: bigint; }
/** External operands are capped before any exact algebraic work begins. */
export const MAX_EXTERNAL_RATIONAL_BITS = 256;
export const MAX_EXTERNAL_DECIMAL_CHARACTERS = 80;
/** Absolute guard for direct-module arithmetic and intermediate certificates. */
export const MAX_RATIONAL_BITS = 8_192;
const normalizedRationals = new WeakSet<object>();

function gcd(left: bigint, right: bigint): bigint {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

export function rational(numerator: bigint | number, denominator: bigint | number = 1n): Rational {
  let n = BigInt(numerator);
  let d = BigInt(denominator);
  if (bitLength(n) > MAX_RATIONAL_BITS || bitLength(d) > MAX_RATIONAL_BITS) throw new RangeError(`Rational exceeds ${MAX_RATIONAL_BITS}-bit arithmetic ceiling`);
  if (d === 0n) throw new RangeError('Rational denominator must not be zero');
  if (n === 0n) return ZERO;
  if (d < 0n) [n, d] = [-n, -d];
  const divisor = gcd(n, d);
  const result = Object.freeze({ numerator: n / divisor, denominator: d / divisor });
  normalizedRationals.add(result);
  return result;
}

export const ZERO: Rational = Object.freeze({ numerator: 0n, denominator: 1n });
export const ONE: Rational = Object.freeze({ numerator: 1n, denominator: 1n });
export const TWO: Rational = Object.freeze({ numerator: 2n, denominator: 1n });
normalizedRationals.add(ZERO); normalizedRationals.add(ONE); normalizedRationals.add(TWO);

export function validateBoundedRational(value: Rational, name: string): void {
  if (typeof value === 'object' && value !== null && normalizedRationals.has(value)) return;
  if (typeof value?.numerator !== 'bigint' || typeof value?.denominator !== 'bigint' || value.denominator <= 0n || bitLength(value.numerator) > MAX_RATIONAL_BITS || bitLength(value.denominator) > MAX_RATIONAL_BITS) throw new RangeError(`${name} exceeds the rational arithmetic ceiling`);
  if ((value.numerator === 0n && value.denominator !== 1n) || (value.numerator !== 0n && gcd(value.numerator, value.denominator) !== 1n)) throw new RangeError(`${name} must be normalized`);
}
export function add(a: Rational, b: Rational): Rational { validateBoundedRational(a, 'Left rational'); validateBoundedRational(b, 'Right rational'); return rational(a.numerator * b.denominator + b.numerator * a.denominator, a.denominator * b.denominator); }
export function subtract(a: Rational, b: Rational): Rational { validateBoundedRational(a, 'Left rational'); validateBoundedRational(b, 'Right rational'); return rational(a.numerator * b.denominator - b.numerator * a.denominator, a.denominator * b.denominator); }
export function multiply(a: Rational, b: Rational): Rational { validateBoundedRational(a, 'Left rational'); validateBoundedRational(b, 'Right rational'); return rational(a.numerator * b.numerator, a.denominator * b.denominator); }
export function divide(a: Rational, b: Rational): Rational {
  validateBoundedRational(a, 'Left rational'); validateBoundedRational(b, 'Right rational');
  if (b.numerator === 0n) throw new RangeError('Rational division by zero');
  return rational(a.numerator * b.denominator, a.denominator * b.numerator);
}
export function negate(a: Rational): Rational { validateBoundedRational(a, 'Rational'); return rational(-a.numerator, a.denominator); }
export function compare(a: Rational, b: Rational): -1 | 0 | 1 {
  validateBoundedRational(a, 'Left rational'); validateBoundedRational(b, 'Right rational');
  const value = a.numerator * b.denominator - b.numerator * a.denominator;
  return value < 0n ? -1 : value > 0n ? 1 : 0;
}
export function equal(a: Rational, b: Rational): boolean { return compare(a, b) === 0; }
export function abs(a: Rational): Rational { return a.numerator < 0n ? negate(a) : a; }
export function pow(a: Rational, exponent: number): Rational {
  validateBoundedRational(a, 'Rational');
  if (!Number.isSafeInteger(exponent) || exponent < 0) throw new RangeError('Rational exponent must be a nonnegative safe integer');
  let base = a;
  let result = ONE;
  for (let e = exponent; e > 0; e = Math.floor(e / 2)) {
    if (e % 2 === 1) result = multiply(result, base);
    if (e > 1) base = multiply(base, base);
  }
  return result;
}
export function midpoint(a: Rational, b: Rational): Rational { return divide(add(a, b), TWO); }
export function decimal(value: string): Rational {
  if (value.length > MAX_EXTERNAL_DECIMAL_CHARACTERS) throw new RangeError(`Decimal literal exceeds ${MAX_EXTERNAL_DECIMAL_CHARACTERS}-character diagnostic ceiling`);
  if (!/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value)) throw new RangeError('Margin and alpha must be finite decimal literals');
  const negative = value.startsWith('-');
  const [wholeRaw, fraction = ''] = (negative ? value.slice(1) : value).split('.');
  const scale = 10n ** BigInt(fraction.length);
  const numerator = BigInt(`${wholeRaw}${fraction}`);
  return rational(negative ? -numerator : numerator, scale);
}
export function choose(n: number, k: number): bigint {
  if (!Number.isSafeInteger(n) || !Number.isSafeInteger(k) || n < 0 || n > 25 || k < 0 || k > n) throw new RangeError('Binomial arguments must satisfy 0 <= k <= n <= 25');
  const selected = Math.min(k, n - k);
  let result = 1n;
  for (let i = 1; i <= selected; i++) result = result * BigInt(n - selected + i) / BigInt(i);
  return result;
}
export function display(a: Rational): string { return a.denominator === 1n ? String(a.numerator) : `${a.numerator}/${a.denominator}`; }
function bitLength(value: bigint): number { return (value < 0n ? -value : value).toString(2).length; }
/** Validate untrusted structural Rational values at the engine boundary. */
export function validateExternalRational(value: Rational, name: string): void {
  if (typeof value?.numerator !== 'bigint' || typeof value?.denominator !== 'bigint' || value.denominator <= 0n) {
    throw new RangeError(`${name} must be a normalized Rational`);
  }
  if (bitLength(value.numerator) > MAX_EXTERNAL_RATIONAL_BITS || bitLength(value.denominator) > MAX_EXTERNAL_RATIONAL_BITS) {
    throw new RangeError(`${name} exceeds the ${MAX_EXTERNAL_RATIONAL_BITS}-bit diagnostic ceiling`);
  }
  if (value.numerator === 0n && value.denominator !== 1n) throw new RangeError(`${name} must be normalized`);
  if (value.numerator !== 0n && gcd(value.numerator, value.denominator) !== 1n) throw new RangeError(`${name} must be normalized`);
}
