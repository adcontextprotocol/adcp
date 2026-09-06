/** Normalized, finite BigInt rational arithmetic for the diagnostic NI slice. */
export interface Rational { readonly numerator: bigint; readonly denominator: bigint; }
/** External operands are capped before any exact algebraic work begins. */
export const MAX_EXTERNAL_RATIONAL_BITS = 256;
export const MAX_EXTERNAL_DECIMAL_CHARACTERS = 80;
/** Absolute guard for direct-module arithmetic and intermediate certificates. */
export const MAX_RATIONAL_BITS = 8_192;
const normalizedRationals = new WeakSet<object>();

/** Labels are part of the untrusted diagnostic boundary, never coercion hooks. */
function primitiveLabel(value: unknown, fallback = 'Rational'): string {
  if (value === undefined) return fallback;
  if (typeof value !== 'string') throw new RangeError('Rational label must be a primitive string');
  return value;
}

/**
 * Reject dynamic structured values before exact arithmetic observes them.
 * Node identifies Proxies without invoking their traps; descriptor inspection
 * then rejects accessors without invoking them. The returned record is never
 * the caller's object, so later mutation cannot alter a certificate.
 */
function inertRecord(value: unknown, name: string, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RangeError(`${name} must be an inert record`);
  let descriptors: PropertyDescriptorMap;
  try {
    if (types.isProxy(value)) throw new TypeError();
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new TypeError();
    descriptors = Object.getOwnPropertyDescriptors(value);
  }
  catch { throw new RangeError(`${name} must not be a Proxy or dynamic object`); }
  if (Reflect.ownKeys(descriptors).length !== fields.length || fields.some((field) => !Object.hasOwn(descriptors, field))) {
    throw new RangeError(`${name} has unexpected fields`);
  }
  const copy = Object.create(null) as Record<string, unknown>;
  for (const field of fields) {
    const descriptor = descriptors[field]!;
    if (!Object.hasOwn(descriptor, 'value') || descriptor.get !== undefined || descriptor.set !== undefined) {
      throw new RangeError(`${name} must not contain accessors`);
    }
    Object.defineProperty(copy, field, { value: descriptor.value, enumerable: true, writable: false, configurable: false });
  }
  return Object.freeze(copy);
}

function gcd(left: bigint, right: bigint): bigint {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

export function rational(numerator: bigint | number, denominator: bigint | number = 1n): Rational {
  const integer = (value: bigint | number, name: string): bigint => {
    if (typeof value === 'bigint') return value;
    if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
    throw new RangeError(`${name} must be a bigint or safe integer number`);
  };
  let n = integer(numerator, 'Rational numerator');
  let d = integer(denominator, 'Rational denominator');
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

/** Snapshot a structural Rational exactly once into an inert canonical value. */
export function canonicalRational(value: Rational, name = 'Rational'): Rational {
  const label = primitiveLabel(name);
  if (typeof value === 'object' && value !== null && normalizedRationals.has(value)) return value;
  const copy = inertRecord(value, label, ['numerator', 'denominator']);
  if (typeof copy.numerator !== 'bigint' || typeof copy.denominator !== 'bigint' || copy.denominator <= 0n || bitLength(copy.numerator) > MAX_RATIONAL_BITS || bitLength(copy.denominator) > MAX_RATIONAL_BITS) throw new RangeError(`${label} exceeds the rational arithmetic ceiling`);
  if ((copy.numerator === 0n && copy.denominator !== 1n) || (copy.numerator !== 0n && gcd(copy.numerator, copy.denominator) !== 1n)) throw new RangeError(`${label} must be normalized`);
  return rational(copy.numerator, copy.denominator);
}
export function validateBoundedRational(value: Rational, name: string): void { canonicalRational(value, name); }
export function add(a: Rational, b: Rational): Rational { const left = canonicalRational(a, 'Left rational'); const right = canonicalRational(b, 'Right rational'); return rational(left.numerator * right.denominator + right.numerator * left.denominator, left.denominator * right.denominator); }
export function subtract(a: Rational, b: Rational): Rational { const left = canonicalRational(a, 'Left rational'); const right = canonicalRational(b, 'Right rational'); return rational(left.numerator * right.denominator - right.numerator * left.denominator, left.denominator * right.denominator); }
export function multiply(a: Rational, b: Rational): Rational { const left = canonicalRational(a, 'Left rational'); const right = canonicalRational(b, 'Right rational'); return rational(left.numerator * right.numerator, left.denominator * right.denominator); }
export function divide(a: Rational, b: Rational): Rational {
  const left = canonicalRational(a, 'Left rational'); const right = canonicalRational(b, 'Right rational');
  if (right.numerator === 0n) throw new RangeError('Rational division by zero');
  return rational(left.numerator * right.denominator, left.denominator * right.numerator);
}
export function negate(a: Rational): Rational { const normalized = canonicalRational(a); return rational(-normalized.numerator, normalized.denominator); }
export function compare(a: Rational, b: Rational): -1 | 0 | 1 {
  const left = canonicalRational(a, 'Left rational'); const right = canonicalRational(b, 'Right rational');
  const value = left.numerator * right.denominator - right.numerator * left.denominator;
  return value < 0n ? -1 : value > 0n ? 1 : 0;
}
export function equal(a: Rational, b: Rational): boolean { return compare(a, b) === 0; }
export function abs(a: Rational): Rational { const normalized = canonicalRational(a); return normalized.numerator < 0n ? negate(normalized) : normalized; }
export function pow(a: Rational, exponent: number): Rational {
  const normalized = canonicalRational(a);
  if (!Number.isSafeInteger(exponent) || exponent < 0) throw new RangeError('Rational exponent must be a nonnegative safe integer');
  let base = normalized;
  let result = ONE;
  for (let e = exponent; e > 0; e = Math.floor(e / 2)) {
    if (e % 2 === 1) result = multiply(result, base);
    if (e > 1) base = multiply(base, base);
  }
  return result;
}
export function midpoint(a: Rational, b: Rational): Rational { return divide(add(a, b), TWO); }
export function decimal(value: string): Rational {
  if (typeof value !== 'string') throw new RangeError('Decimal literal must be a primitive string');
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
export function display(a: Rational): string { const normalized = canonicalRational(a); return normalized.denominator === 1n ? String(normalized.numerator) : `${normalized.numerator}/${normalized.denominator}`; }
function bitLength(value: bigint): number { return (value < 0n ? -value : value).toString(2).length; }
export function rationalBitLength(value: Rational): number { const normalized = canonicalRational(value); return Math.max(bitLength(normalized.numerator), bitLength(normalized.denominator)); }
/** Validate untrusted structural Rational values at the engine boundary. */
export function validateExternalRational(value: Rational, name: string): Rational {
  const normalized = canonicalRational(value, name);
  if (bitLength(normalized.numerator) > MAX_EXTERNAL_RATIONAL_BITS || bitLength(normalized.denominator) > MAX_EXTERNAL_RATIONAL_BITS) {
    throw new RangeError(`${name} exceeds the ${MAX_EXTERNAL_RATIONAL_BITS}-bit diagnostic ceiling`);
  }
  return normalized;
}
import { types } from 'node:util';
