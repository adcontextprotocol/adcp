import { types } from 'node:util';
import { MessageChannel, MessagePort, Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
/**
 * Restricted-score E+M exact-unconditional matched-pair noninferiority
 * diagnostic after Lloyd & Moldovan (2008), Statistics in Medicine 27,
 * 3540-3549, doi:10.1002/sim.3229. This module is diagnostic only; see
 * admission.ts. It does not implement confidence inversion or resizing.
 */
import { evaluateInterval, interval, intervalAdd, intervalDividePositive, intervalMultiply, intervalSubtract, sqrtInterval, type RationalInterval, type RootIsolation } from './algebraic.js';
import type { ExactInferenceCertificate, IndeterminateCertificate } from './certificates.js';
import { MATCHED_PAIR_NI_ADMISSION, type MatchedPairNiAdmission } from './admission.js';
import { canonicalPolynomial, constant, degree, derivative, divideWithRemainder, evaluate, isZero, polynomial, polynomialAdd, polynomialMultiply, polynomialNegate, polynomialPow, polynomialScale, type RationalPolynomial } from './polynomial.js';
import { add, canonicalRational, choose, compare, decimal, divide, equal, multiply, negate, pow, rational, rationalBitLength, subtract, type Rational, ONE, TWO, validateExternalRational, ZERO } from './rational.js';

const MATCHED_PAIR_NI_MAX_N = 25;
// 24 exact dyadic subdivisions give a < 2^-24 nuisance interval while
// bounding BigInt growth for the deliberately small diagnostic ceiling.
const MATCHED_PAIR_NI_MAX_ROOT_BISECTIONS = 24;
const MATCHED_PAIR_NI_MAX_POLYNOMIAL_DEGREE = 25;
/** Intrinsic cap for any engine-root invocation, including a recreated worker. */
const MAX_ENGINE_ROOT_DEGREE = 24;
const MAX_ENGINE_ROOT_COEFFICIENT_BITS = 256;
const MAX_ENGINE_ROOT_OPERATION_UNITS = 100_000;
/** Measured synchronous ceiling for exhaustive rejection-region certification. */
const MATCHED_PAIR_NI_MAX_SIZE_N = 8;
/**
 * Preflight limits prevent legal-but-expensive precision from entering Sturm
 * work. At n=8, 16 bits bounds the exhaustive estimate below the aggregate
 * ceiling; 17 bits and every former 128-bit boundary fail before enumeration.
 */
const MATCHED_PAIR_NI_MAX_MARGIN_BITS_FOR_SIZE = 16;
const MATCHED_PAIR_NI_MAX_MARGIN_BITS_FOR_INFERENCE = 16;
/** Aggregate deterministic E-step comparison-work budget, checked before and during exhaustive work. */
const MATCHED_PAIR_NI_MAX_WORK_UNITS = 1_500_000;
/** Diagnostic CPU deadline checked at deterministic E-step work boundaries. */
const MATCHED_PAIR_NI_MAX_WORK_MILLISECONDS = 12_000;
const MATCHED_PAIR_NI_WORKER_TIMEOUT_MILLISECONDS = 20_000;
/** At most two isolated computations may consume process memory concurrently. */
const MATCHED_PAIR_NI_MAX_CONCURRENT_WORKERS = 2;
/** This is V8 old-space only, not a total RSS/cgroup assertion. */
const MATCHED_PAIR_NI_WORKER_MAX_OLD_SPACE_MB = 64;

/** Never invoke a caller-mutable Array prototype in a worker realm. */
function ownArray<T>(length = 0): T[] { return new Array<T>(length); }
function ownSet<T>(target: T[], index: number, value: T): void {
  Object.defineProperty(target, index, { value, enumerable: true, writable: true, configurable: true });
}
function ownAppend<T>(target: T[], value: T): void { ownSet(target, target.length, value); }

export interface MatchedPairCounts { readonly n11: number; readonly n10: number; readonly n01: number; readonly n00: number; }
export interface ReducedMatchedPairState { readonly n: number; readonly x: number; readonly t: number; }
export interface MatchedPairNiInput { readonly counts: MatchedPairCounts; readonly margin: Rational; readonly alpha: Rational; }
export interface MatchedPairNiSupport {
  readonly operation: 'inference' | 'null_boundary_size';
  readonly supported: boolean;
  readonly reason: 'supported' | 'n_out_of_range' | 'size_n_ceiling' | 'margin_precision_ceiling' | 'aggregate_work_ceiling';
  readonly estimatedWorkUnits: number;
}
export interface MatchedPairNiResult {
  readonly mode: 'restricted_score_e_plus_m' | 'conditional_mcnemar_zero_margin';
  /** Statistical rejection never authorizes Addie or a production decision. */
  readonly admission: MatchedPairNiAdmission;
  readonly diagnostic: Readonly<{
    /** Evidence about H0 only; deliberately not named `reject` or `decision`. */
    statisticalRejectNull: boolean;
    readonly alphaDecision: 'reject_certified' | 'nonreject_certified' | 'indeterminate_alpha_overlap';
    readonly pValue: Readonly<{ lower: Rational; upper: Rational }>;
    readonly certificate?: ExactInferenceCertificate;
    readonly indeterminate?: IndeterminateCertificate;
  }>;
}
type NoRootPromotionField = 'reject' extends keyof MatchedPairNiResult ? never : 'decision' extends keyof MatchedPairNiResult ? never : true;
/** Compile-time sentinel: adding a root promotion decision fails typecheck. */
export const MATCHED_PAIR_NI_NO_ROOT_PROMOTION_FIELD: NoRootPromotionField = true;
function reducedStateCount(n: number): number { return (n + 1) * (n + 2) / 2; }
function estimatedWorkUnits(n: number, precisionBits: number, exhaustiveSize: boolean): number {
  const states = reducedStateCount(n);
  // Each E-step comparison is charged as one unit below. One diagnostic has
  // O(S^2) comparisons; an S-state size envelope has O(S^3), S=(n+1)(n+2)/2.
  return (exhaustiveSize ? states * states * states : states * states) * precisionBits;
}
/**
 * The sole authoritative support predicate.  Its result is deliberately
 * joint: syntax ceilings are not an advertised Cartesian compute domain.
 * Unsupported requests are diagnostic indeterminacy, never a weakened test.
 */
export function matchedPairNiSupport(
  operation: MatchedPairNiSupport['operation'], n: number, margin: Rational,
): MatchedPairNiSupport {
  if (operation !== 'inference' && operation !== 'null_boundary_size') throw new RangeError('Matched-pair NI support operation is invalid');
  if (!Number.isSafeInteger(n) || n < 1 || n > MATCHED_PAIR_NI_MAX_N) {
    return Object.freeze({ operation, supported: false, reason: 'n_out_of_range', estimatedWorkUnits: 0 });
  }
  const normalizedMargin = validateMargin(margin);
  const exhaustiveSize = operation === 'null_boundary_size';
  const bits = rationalBitLength(normalizedMargin);
  const estimate = estimatedWorkUnits(n, bits, exhaustiveSize);
  const precisionLimit = exhaustiveSize ? MATCHED_PAIR_NI_MAX_MARGIN_BITS_FOR_SIZE : MATCHED_PAIR_NI_MAX_MARGIN_BITS_FOR_INFERENCE;
  const reason = exhaustiveSize && n > MATCHED_PAIR_NI_MAX_SIZE_N ? 'size_n_ceiling'
    : bits > precisionLimit ? 'margin_precision_ceiling'
      : estimate > MATCHED_PAIR_NI_MAX_WORK_UNITS ? 'aggregate_work_ceiling' : 'supported';
  return Object.freeze({ operation, supported: reason === 'supported', reason, estimatedWorkUnits: estimate });
}
class WorkBudget {
  private used = 0;
  private readonly deadline = Date.now() + MATCHED_PAIR_NI_MAX_WORK_MILLISECONDS;
  private readonly limit: number;
  constructor(limit: number) { this.limit = limit; }
  charge(units = 1): void {
    this.used += units;
    if (this.used > this.limit || Date.now() > this.deadline) throw new RangeError('Exact E+M aggregate work ceiling exceeded');
  }
}
/* This isolation path is deliberately module-private. A caller-created
 * worker can reproduce this module's dispatch marker, so the marker/port is
 * orchestration rather than authority: every activation is protected first by
 * the same joint input preflight and intrinsic root-operation caps below.
 * The managed launcher additionally supplies its worker termination boundary.
 */
function engineIntegerGcd(left: bigint, right: bigint): bigint {
  let a = left < 0n ? -left : left; let b = right < 0n ? -right : right;
  while (b !== 0n) { const remainder = a % b; a = b; b = remainder; }
  return a;
}
class EngineRootBudget {
  private used = 0;
  charge(units = 1): void {
    this.used += units;
    if (this.used > MAX_ENGINE_ROOT_OPERATION_UNITS) throw new RangeError('Engine root operation ceiling exceeded');
  }
}
function enginePrimitive(value: RationalPolynomial, budget: EngineRootBudget): RationalPolynomial {
  const normalized = canonicalPolynomial(value, 'Engine root polynomial');
  let common = 1n;
  for (let index = 0; index < normalized.length; index++) {
    const coefficient = normalized[index]!;
    budget.charge(); common = common / engineIntegerGcd(common, coefficient.denominator) * coefficient.denominator;
  }
  const integers = ownArray<bigint>(normalized.length);
  let content = 0n;
  for (let index = 0; index < normalized.length; index++) {
    const coefficient = normalized[index]!;
    const integer = coefficient.numerator * (common / coefficient.denominator);
    ownSet(integers, index, integer);
    content = engineIntegerGcd(content, integer);
  }
  const divisor = content || 1n;
  const coefficients = ownArray<Rational>(integers.length);
  for (let index = 0; index < integers.length; index++) ownSet(coefficients, index, rational(integers[index]! / divisor));
  return polynomial(coefficients);
}
function engineSturm(value: RationalPolynomial, budget: EngineRootBudget): readonly RationalPolynomial[] {
  const polynomialValue = enginePrimitive(value, budget);
  if (isZero(polynomialValue)) throw new RangeError('Sturm sequence requires a nonzero polynomial');
  const sequence = ownArray<RationalPolynomial>(0);
  ownAppend(sequence, polynomialValue);
  ownAppend(sequence, enginePrimitive(derivative(polynomialValue), budget));
  while (!isZero(sequence[sequence.length - 1]!)) {
    budget.charge();
    const division = divideWithRemainder(sequence[sequence.length - 2]!, sequence[sequence.length - 1]!);
    const remainder = division[1]!;
    if (isZero(remainder)) break;
    ownAppend(sequence, enginePrimitive(polynomialNegate(remainder), budget));
  }
  return Object.freeze(sequence);
}
function enginePolynomialGcd(left: RationalPolynomial, right: RationalPolynomial, budget: EngineRootBudget): RationalPolynomial {
  let a = enginePrimitive(left, budget); let b = enginePrimitive(right, budget);
  while (!isZero(b)) {
    budget.charge();
    const division = divideWithRemainder(a, b);
    const remainder = division[1]!;
    a = b; b = isZero(remainder) ? remainder : enginePrimitive(remainder, budget);
  }
  return a;
}
function engineSquareFree(value: RationalPolynomial, budget: EngineRootBudget): RationalPolynomial {
  const slope = derivative(value);
  if (isZero(slope)) return value;
  const divisor = enginePolynomialGcd(value, slope, budget);
  const division = divideWithRemainder(value, divisor);
  const quotient = division[0]!; const remainder = division[1]!;
  if (!isZero(remainder)) throw new RangeError('Polynomial square-free division was not exact');
  return enginePrimitive(quotient, budget);
}
function engineVariations(sequence: readonly RationalPolynomial[], at: Rational, budget: EngineRootBudget): number {
  const signs = ownArray<-1 | 1>(0);
  for (let index = 0; index < sequence.length; index++) {
    budget.charge();
    const sign = compare(evaluate(sequence[index]!, at), ZERO);
    if (sign !== 0) ownAppend(signs, sign);
  }
  let changes = 0;
  for (let index = 1; index < signs.length; index++) if (signs[index - 1] !== signs[index]) changes++;
  return changes;
}
function isolateEngineInteriorRoots(value: RationalPolynomial, lower: Rational, upper: Rational, refinementBits: number): RootIsolation {
  const polynomialValue = canonicalPolynomial(value, 'Engine root polynomial');
  const lowerBound = canonicalRational(lower, 'Engine root lower bound'); const upperBound = canonicalRational(upper, 'Engine root upper bound');
  if (compare(lowerBound, upperBound) > 0) throw new RangeError('Root lower bound must not exceed upper bound');
  if (!Number.isSafeInteger(refinementBits) || refinementBits < 1 || refinementBits > MATCHED_PAIR_NI_MAX_ROOT_BISECTIONS) throw new RangeError(`Root refinement bits must be an integer in [1, ${MATCHED_PAIR_NI_MAX_ROOT_BISECTIONS}]`);
  if (degree(polynomialValue) <= 0) return Object.freeze({ exact: Object.freeze([]), intervals: Object.freeze([]), unresolved: false });
  if (degree(polynomialValue) > MAX_ENGINE_ROOT_DEGREE) return Object.freeze({ exact: Object.freeze([]), intervals: Object.freeze([]), unresolved: true });
  for (let index = 0; index < polynomialValue.length; index++) if (rationalBitLength(polynomialValue[index]!) > MAX_ENGINE_ROOT_COEFFICIENT_BITS) return Object.freeze({ exact: Object.freeze([]), intervals: Object.freeze([]), unresolved: true });
  const budget = new EngineRootBudget();
  let distinct: RationalPolynomial; let sequence: readonly RationalPolynomial[];
  try { distinct = engineSquareFree(polynomialValue, budget); sequence = engineSturm(distinct, budget); }
  catch (error) { if (error instanceof RangeError && /operation ceiling/.test(error.message)) return Object.freeze({ exact: Object.freeze([]), intervals: Object.freeze([]), unresolved: true }); throw error; }
  const exact: Rational[] = []; const intervals: RationalInterval[] = []; let unresolved = false;
  const rootsInOpen = (left: Rational, right: Rational): number => engineVariations(sequence, left, budget) - engineVariations(sequence, right, budget) - (compare(evaluate(distinct, right), ZERO) === 0 ? 1 : 0);
  const visit = (left: Rational, right: Rational, depth: number): void => {
    let count: number;
    try { budget.charge(); count = rootsInOpen(left, right); }
    catch (error) { if (error instanceof RangeError && /operation ceiling/.test(error.message)) { unresolved = true; return; } throw error; }
    if (count <= 0) return;
    if (depth >= refinementBits) { if (count === 1) ownAppend(intervals, interval(left, right)); else unresolved = true; return; }
    const middle = divide(add(left, right), TWO);
    if (compare(evaluate(polynomialValue, middle), ZERO) === 0) { ownAppend(exact, middle); visit(left, middle, depth + 1); visit(middle, right, depth + 1); return; }
    visit(left, middle, depth + 1); visit(middle, right, depth + 1);
  };
  visit(lowerBound, upperBound, 0);
  return Object.freeze({ exact: Object.freeze(exact), intervals: Object.freeze(intervals), unresolved });
}
function workBudgetFor(n: number, margin: Rational, _alpha: Rational, exhaustiveSize: boolean): WorkBudget | null {
  const support = matchedPairNiSupport(exhaustiveSize ? 'null_boundary_size' : 'inference', n, margin);
  return support.supported ? new WorkBudget(MATCHED_PAIR_NI_MAX_WORK_UNITS) : null;
}

function inertRecord(value: unknown, name: string, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RangeError(`${name} must be an inert record`);
  let descriptors: PropertyDescriptorMap;
  try {
    if (types.isProxy(value)) throw new TypeError();
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new TypeError();
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch { throw new RangeError(`${name} must not be a Proxy or dynamic object`); }
  if (Reflect.ownKeys(descriptors).length !== fields.length) throw new RangeError(`${name} has unexpected fields`);
  for (let index = 0; index < fields.length; index++) if (!Object.hasOwn(descriptors, fields[index]!)) throw new RangeError(`${name} has unexpected fields`);
  const copy = Object.create(null) as Record<string, unknown>;
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index]!;
    const descriptor = descriptors[field]!;
    if (!Object.hasOwn(descriptor, 'value') || descriptor.get !== undefined || descriptor.set !== undefined) throw new RangeError(`${name} must not contain accessors`);
    Object.defineProperty(copy, field, { value: descriptor.value, enumerable: true, writable: false, configurable: false });
  }
  return Object.freeze(copy);
}
/** Snapshot a plain list without executing getters or consulting it twice. */
function inertList(value: unknown, name: string): readonly unknown[] {
  if (!Array.isArray(value) || types.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) throw new RangeError(`${name} must be an inert array`);
  let descriptors: PropertyDescriptorMap;
  try { descriptors = Object.getOwnPropertyDescriptors(value) as unknown as PropertyDescriptorMap; }
  catch { throw new RangeError(`${name} must not be a Proxy or dynamic array`); }
  const lengthDescriptor = descriptors.length;
  if (!lengthDescriptor || !Object.hasOwn(lengthDescriptor, 'value') || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0) throw new RangeError(`${name} has invalid length`);
  const length = lengthDescriptor.value as number;
  if (Reflect.ownKeys(descriptors).length !== length + 1) throw new RangeError(`${name} must not be sparse or extended`);
  const result: unknown[] = new Array(length);
  for (let index = 0; index < length; index++) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.get !== undefined || descriptor.set !== undefined) throw new RangeError(`${name} must not contain accessors`);
    Object.defineProperty(result, index, { value: descriptor.value, enumerable: true, writable: false, configurable: false });
  }
  return Object.freeze(result);
}
function inertRecordWithOptional(value: unknown, name: string, required: readonly string[], optional: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RangeError(`${name} must be an inert record`);
  let descriptors: PropertyDescriptorMap;
  try {
    if (types.isProxy(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) throw new TypeError();
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch { throw new RangeError(`${name} must not be a Proxy or dynamic object`); }
  const keys = Reflect.ownKeys(descriptors);
  for (let index = 0; index < keys.length; index++) {
    if (typeof keys[index] !== 'string') throw new RangeError(`${name} has unexpected fields`);
    let allowed = false;
    for (let requiredIndex = 0; requiredIndex < required.length; requiredIndex++) if (keys[index] === required[requiredIndex]) { allowed = true; break; }
    if (!allowed) for (let optionalIndex = 0; optionalIndex < optional.length; optionalIndex++) if (keys[index] === optional[optionalIndex]) { allowed = true; break; }
    if (!allowed) throw new RangeError(`${name} has unexpected fields`);
  }
  for (let index = 0; index < required.length; index++) if (!Object.hasOwn(descriptors, required[index]!)) throw new RangeError(`${name} has unexpected fields`);
  const copy = Object.create(null) as Record<string, unknown>;
  const fieldCount = required.length + optional.length;
  for (let index = 0; index < fieldCount; index++) {
    const field = index < required.length ? required[index]! : optional[index - required.length]!;
    const descriptor = descriptors[field];
    if (!descriptor) continue;
    if (!Object.hasOwn(descriptor, 'value') || descriptor.get !== undefined || descriptor.set !== undefined) throw new RangeError(`${name} must not contain accessors`);
    Object.defineProperty(copy, field, { value: descriptor.value, enumerable: true, writable: false, configurable: false });
  }
  return Object.freeze(copy);
}
const normalizedStates = new WeakSet<object>();
const normalizedCounts = new WeakSet<object>();
function canonicalState(state: ReducedMatchedPairState): ReducedMatchedPairState {
  if (typeof state === 'object' && state !== null && normalizedStates.has(state)) return state;
  const copy = inertRecord(state, 'Reduced state', ['n', 'x', 't']);
  finiteCount(copy.n as number, 'n'); finiteCount(copy.x as number, 'x'); finiteCount(copy.t as number, 't');
  const result = Object.freeze({ n: copy.n as number, x: copy.x as number, t: copy.t as number }); normalizedStates.add(result); return result;
}
function canonicalCounts(counts: MatchedPairCounts): MatchedPairCounts {
  if (typeof counts === 'object' && counts !== null && normalizedCounts.has(counts)) return counts;
  const copy = inertRecord(counts, 'Matched-pair counts', ['n11', 'n10', 'n01', 'n00']);
  const fields = ['n11', 'n10', 'n01', 'n00'] as const;
  for (let index = 0; index < fields.length; index++) {
    const name = fields[index]!;
    finiteCount(copy[name] as number, name);
  }
  const result = Object.freeze({ n11: copy.n11 as number, n10: copy.n10 as number, n01: copy.n01 as number, n00: copy.n00 as number }); normalizedCounts.add(result); return result;
}

function finiteCount(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a nonnegative safe integer`);
}
function validateState(state: ReducedMatchedPairState): ReducedMatchedPairState {
  const normalized = canonicalState(state);
  if (normalized.n === 0) throw new RangeError('At least one matched pair is required');
  if (normalized.x > normalized.t || normalized.t > normalized.n) throw new RangeError('Reduced state must satisfy 0 <= x <= t <= n');
  if (normalized.n > MATCHED_PAIR_NI_MAX_N) throw new RangeError(`Diagnostic ceiling is n <= ${MATCHED_PAIR_NI_MAX_N}; no confirmatory sample-size claim is made`);
  return normalized;
}
function validateMargin(margin: Rational): Rational {
  const normalized = validateExternalRational(margin, 'Margin');
  if (compare(normalized, ZERO) < 0 || compare(normalized, ONE) >= 0) throw new RangeError('Margin must be in [0, 1)');
  return normalized;
}
export function reduceMatchedPairCounts(counts: MatchedPairCounts): ReducedMatchedPairState {
  const normalized = canonicalCounts(counts);
  const n = normalized.n11 + normalized.n10 + normalized.n01 + normalized.n00;
  if (!Number.isSafeInteger(n)) throw new RangeError('Total count is not a safe integer');
  if (n === 0 || n > MATCHED_PAIR_NI_MAX_N) throw new RangeError(`Matched-pair total must be in [1, ${MATCHED_PAIR_NI_MAX_N}]`);
  return canonicalState({ n, x: normalized.n10, t: normalized.n10 + normalized.n01 });
}
function validate(state: ReducedMatchedPairState, margin: Rational, alpha: Rational): Readonly<{ state: ReducedMatchedPairState; margin: Rational; alpha: Rational }> {
  const normalizedState = validateState(state); const normalizedMargin = validateMargin(margin); const normalizedAlpha = validateExternalRational(alpha, 'Alpha');
  if (compare(normalizedAlpha, ZERO) <= 0 || compare(normalizedAlpha, ONE) >= 0) throw new RangeError('Alpha must be in (0, 1)');
  return Object.freeze({ state: normalizedState, margin: normalizedMargin, alpha: normalizedAlpha });
}
function snapshotInput(input: MatchedPairNiInput): MatchedPairNiInput {
  const copy = inertRecord(input, 'Matched-pair NI input', ['counts', 'margin', 'alpha']);
  const counts = canonicalCounts(copy.counts as MatchedPairCounts);
  const margin = validateMargin(copy.margin as Rational);
  const alpha = validateExternalRational(copy.alpha as Rational, 'Alpha');
  validate(reduceMatchedPairCounts(counts), margin, alpha);
  return Object.freeze({ counts, margin, alpha });
}
type WorkerTask = 'restricted_score' | 'null_size';
function workerUrl(): URL {
  return new URL(import.meta.url);
}
function hydratePValue(value: unknown, name: string): Readonly<{ lower: Rational; upper: Rational }> {
  const copy = inertRecord(value, name, ['lower', 'upper']);
  // Result coefficients are internal exact arithmetic and can legitimately
  // exceed the 256-bit *input* cap, but remain under the global 8192-bit cap.
  const lower = canonicalRational(copy.lower as Rational, `${name} lower`);
  const upper = canonicalRational(copy.upper as Rational, `${name} upper`);
  if (compare(lower, upper) > 0) throw new RangeError(`${name} is inverted`);
  return Object.freeze({ lower, upper });
}
function hydrateCertificate(value: unknown, pValue: Readonly<{ lower: Rational; upper: Rational }>, input: MatchedPairNiInput): ExactInferenceCertificate {
  const copy = inertRecord(value, 'Worker exact certificate', ['method', 'nullBoundary', 'maximization', 'evaluatedEndpoints', 'stationaryPointCount', 'pValue', 'request', 'safeCeiling', 'exactness']);
  if (copy.method !== 'lloyd_moldovan_2008_restricted_score_e_plus_m' || copy.nullBoundary !== 'theta=-margin' || copy.maximization !== 'rational_sturm_and_interval_bisection' || copy.evaluatedEndpoints !== true || copy.exactness !== 'certified_enclosure_only' || !Number.isSafeInteger(copy.stationaryPointCount) || (copy.stationaryPointCount as number) < 0) throw new RangeError('Worker exact certificate is invalid');
  const certificatePValue = hydratePValue(copy.pValue, 'Worker certificate p-value');
  if (!equal(certificatePValue.lower, pValue.lower) || !equal(certificatePValue.upper, pValue.upper)) throw new RangeError('Worker certificate p-value disagrees with result');
  const request = inertRecord(copy.request, 'Worker certificate request', ['n', 'x', 't', 'margin', 'alpha']);
  const requestedState = validateState(canonicalState({ n: request.n as number, x: request.x as number, t: request.t as number }));
  const observed = reduceMatchedPairCounts(input.counts);
  const requestedMargin = validateExternalRational(request.margin as Rational, 'Worker certificate margin');
  const requestedAlpha = validateExternalRational(request.alpha as Rational, 'Worker certificate alpha');
  if (!stateEquals(requestedState, observed) || !equal(requestedMargin, input.margin) || !equal(requestedAlpha, input.alpha)) throw new RangeError('Worker certificate is not bound to the captured request');
  const ceiling = inertRecord(copy.safeCeiling, 'Worker safe ceiling', ['maxN', 'maxPolynomialDegree', 'maxRootBisections']);
  if (ceiling.maxN !== MATCHED_PAIR_NI_MAX_N || ceiling.maxPolynomialDegree !== MATCHED_PAIR_NI_MAX_POLYNOMIAL_DEGREE || ceiling.maxRootBisections !== MATCHED_PAIR_NI_MAX_ROOT_BISECTIONS) throw new RangeError('Worker safe ceiling is invalid');
  return Object.freeze({ method: copy.method, nullBoundary: copy.nullBoundary, maximization: copy.maximization, evaluatedEndpoints: true, stationaryPointCount: copy.stationaryPointCount as number, pValue, request: Object.freeze({ n: observed.n, x: observed.x, t: observed.t, margin: input.margin, alpha: input.alpha }), safeCeiling: Object.freeze({ maxN: MATCHED_PAIR_NI_MAX_N, maxPolynomialDegree: MATCHED_PAIR_NI_MAX_POLYNOMIAL_DEGREE, maxRootBisections: MATCHED_PAIR_NI_MAX_ROOT_BISECTIONS }), exactness: copy.exactness });
}
function isEngineIndeterminacyReason(value: unknown): value is IndeterminateCertificate['reason'] {
  return value === 'ambiguous_score_ordering' || value === 'ambiguous_e_ordering' || value === 'root_isolation_ceiling' || value === 'complexity_ceiling';
}
function isAlphaDecision(value: unknown): value is MatchedPairNiResult['diagnostic']['alphaDecision'] {
  return value === 'reject_certified' || value === 'nonreject_certified' || value === 'indeterminate_alpha_overlap';
}
function isSizeEnvelopeReason(value: unknown): value is NullBoundarySizeEnvelope['reason'] {
  return isEngineIndeterminacyReason(value) || value === 'overlapping_p_value' || value === 'size_complexity_ceiling';
}
function hydrateIndeterminate(value: unknown): IndeterminateCertificate {
  const copy = inertRecord(value, 'Worker indeterminate certificate', ['method', 'reason', 'reject']);
  if (copy.method !== 'lloyd_moldovan_2008_restricted_score_e_plus_m' || copy.reject !== false || !isEngineIndeterminacyReason(copy.reason)) throw new RangeError('Worker indeterminate certificate is invalid');
  return Object.freeze({ method: copy.method, reason: copy.reason as IndeterminateCertificate['reason'], reject: false });
}
/** Rebuild a worker result from canonical values; structured clone drops freezes. */
function hydrateMatchedPairNiResult(value: unknown, input: MatchedPairNiInput): MatchedPairNiResult {
  const result = inertRecord(value, 'Worker diagnostic result', ['mode', 'admission', 'diagnostic']);
  if (result.mode !== 'restricted_score_e_plus_m' && result.mode !== 'conditional_mcnemar_zero_margin') throw new RangeError('Worker diagnostic mode is invalid');
  const diagnostic = inertRecordWithOptional(result.diagnostic, 'Worker diagnostic', ['statisticalRejectNull', 'alphaDecision', 'pValue'], ['certificate', 'indeterminate']);
  if (typeof diagnostic.statisticalRejectNull !== 'boolean' || !isAlphaDecision(diagnostic.alphaDecision) || (diagnostic.certificate !== undefined && diagnostic.indeterminate !== undefined)) throw new RangeError('Worker diagnostic is invalid');
  const pValue = hydratePValue(diagnostic.pValue, 'Worker diagnostic p-value');
  if (compare(pValue.lower, ZERO) < 0 || compare(pValue.upper, ONE) > 0) throw new RangeError('Worker diagnostic p-value is outside [0, 1]');
  const certificate = diagnostic.certificate === undefined ? undefined : hydrateCertificate(diagnostic.certificate, pValue, input);
  const indeterminate = diagnostic.indeterminate === undefined ? undefined : hydrateIndeterminate(diagnostic.indeterminate);
  const expectedDecision = compare(pValue.upper, input.alpha) <= 0 ? 'reject_certified'
    : compare(pValue.lower, input.alpha) > 0 ? 'nonreject_certified' : 'indeterminate_alpha_overlap';
  if ((diagnostic.alphaDecision === 'reject_certified') !== diagnostic.statisticalRejectNull || diagnostic.alphaDecision !== expectedDecision || (indeterminate !== undefined && diagnostic.statisticalRejectNull) || (result.mode === 'restricted_score_e_plus_m' && certificate === undefined && indeterminate === undefined) || (result.mode === 'conditional_mcnemar_zero_margin' && (certificate !== undefined || indeterminate !== undefined)) || (equal(input.margin, ZERO) !== (result.mode === 'conditional_mcnemar_zero_margin')) || (indeterminate !== undefined && (!equal(pValue.lower, ZERO) || !equal(pValue.upper, ONE)))) throw new RangeError('Worker diagnostic decision is inconsistent');
  if (result.mode === 'conditional_mcnemar_zero_margin') {
    const expected = conditionalMcNemarPValue(reduceMatchedPairCounts(input.counts));
    if (!equal(pValue.lower, expected) || !equal(pValue.upper, expected)) throw new RangeError('Worker conditional result is not bound to the captured counts');
  }
  const alphaDecision = diagnostic.alphaDecision as MatchedPairNiResult['diagnostic']['alphaDecision'];
  const safeDiagnostic = certificate
    ? Object.freeze({ statisticalRejectNull: diagnostic.statisticalRejectNull, alphaDecision, pValue, certificate })
    : indeterminate
      ? Object.freeze({ statisticalRejectNull: diagnostic.statisticalRejectNull, alphaDecision, pValue, indeterminate })
      : Object.freeze({ statisticalRejectNull: diagnostic.statisticalRejectNull, alphaDecision, pValue });
  return Object.freeze({ mode: result.mode, admission: MATCHED_PAIR_NI_ADMISSION, diagnostic: safeDiagnostic });
}
function hydrateStates(value: unknown, name: string, n: number): readonly ReducedMatchedPairState[] {
  const raw = inertList(value, name);
  const states: ReducedMatchedPairState[] = [];
  for (let index = 0; index < raw.length; index++) {
    const state = validateState(canonicalState(raw[index] as ReducedMatchedPairState));
    if (state.n !== n) throw new RangeError(`${name} has a state from another task`);
    ownAppend(states, state);
  }
  return Object.freeze(states);
}
function polynomialEqual(left: RationalPolynomial, right: RationalPolynomial): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) if (!equal(left[index]!, right[index]!)) return false;
  return true;
}
function certificateEqual(left: ExactInferenceCertificate | undefined, right: ExactInferenceCertificate | undefined): boolean {
  return left === undefined || right === undefined ? left === right
    : left.method === right.method && left.nullBoundary === right.nullBoundary && left.maximization === right.maximization && left.evaluatedEndpoints === right.evaluatedEndpoints && left.stationaryPointCount === right.stationaryPointCount && equal(left.pValue.lower, right.pValue.lower) && equal(left.pValue.upper, right.pValue.upper) && stateEquals(left.request, right.request) && equal(left.request.margin, right.request.margin) && equal(left.request.alpha, right.request.alpha) && left.safeCeiling.maxN === right.safeCeiling.maxN && left.safeCeiling.maxPolynomialDegree === right.safeCeiling.maxPolynomialDegree && left.safeCeiling.maxRootBisections === right.safeCeiling.maxRootBisections && left.exactness === right.exactness;
}
function matchedResultEqual(left: MatchedPairNiResult, right: MatchedPairNiResult): boolean {
  return left.mode === right.mode && left.diagnostic.statisticalRejectNull === right.diagnostic.statisticalRejectNull && left.diagnostic.alphaDecision === right.diagnostic.alphaDecision && equal(left.diagnostic.pValue.lower, right.diagnostic.pValue.lower) && equal(left.diagnostic.pValue.upper, right.diagnostic.pValue.upper) && certificateEqual(left.diagnostic.certificate, right.diagnostic.certificate) && left.diagnostic.indeterminate?.reason === right.diagnostic.indeterminate?.reason;
}
function stateKeyIn(states: readonly ReducedMatchedPairState[], key: string): boolean {
  for (let index = 0; index < states.length; index++) if (stateKey(states[index]!) === key) return true;
  return false;
}
function hasDuplicateStateKey(states: readonly ReducedMatchedPairState[]): boolean {
  for (let left = 0; left < states.length; left++) for (let right = left + 1; right < states.length; right++) if (stateKey(states[left]!) === stateKey(states[right]!)) return true;
  return false;
}
function sameStates(left: readonly ReducedMatchedPairState[], right: readonly ReducedMatchedPairState[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) if (!stateEquals(left[index]!, right[index]!)) return false;
  return true;
}
function sizeEnvelopeEqual(left: NullBoundarySizeEnvelope, right: NullBoundarySizeEnvelope): boolean {
  if (left.status !== right.status || left.reason !== right.reason || left.request.n !== right.request.n || !equal(left.request.margin, right.request.margin) || !equal(left.request.alpha, right.request.alpha) || !polynomialEqual(left.lower, right.lower) || !polynomialEqual(left.upper, right.upper) || !sameStates(left.indeterminateStates, right.indeterminateStates) || !sameStates(left.alphaOverlapStates, right.alphaOverlapStates) || left.engineIndeterminacy.length !== right.engineIndeterminacy.length) return false;
  for (let index = 0; index < left.engineIndeterminacy.length; index++) if (left.engineIndeterminacy[index]!.reason !== right.engineIndeterminacy[index]!.reason || !stateEquals(left.engineIndeterminacy[index]!.state, right.engineIndeterminacy[index]!.state)) return false;
  return true;
}
function hydrateSizeEnvelope(value: unknown, n: number, margin: Rational, alpha: Rational): NullBoundarySizeEnvelope {
  const copy = inertRecord(value, 'Worker size envelope', ['status', 'lower', 'upper', 'indeterminateStates', 'engineIndeterminacy', 'alphaOverlapStates', 'reason', 'request']);
  if (copy.status !== 'certified' && copy.status !== 'indeterminate') throw new RangeError('Worker size envelope status is invalid');
  const lower = canonicalPolynomial(copy.lower as RationalPolynomial, 'Worker size lower polynomial');
  const upper = canonicalPolynomial(copy.upper as RationalPolynomial, 'Worker size upper polynomial');
  const request = inertRecord(copy.request, 'Worker size request', ['n', 'margin', 'alpha']);
  if (request.n !== n || !equal(validateExternalRational(request.margin as Rational, 'Worker size request margin'), margin) || !equal(validateExternalRational(request.alpha as Rational, 'Worker size request alpha'), alpha)) throw new RangeError('Worker size envelope is not bound to the captured request');
  const indeterminateStates = hydrateStates(copy.indeterminateStates, 'Worker indeterminate states', n);
  const alphaOverlapStates = hydrateStates(copy.alphaOverlapStates, 'Worker alpha-overlap states', n);
  const rawEngineIndeterminacy = inertList(copy.engineIndeterminacy, 'Worker engine indeterminacy');
  const engineEntries: { state: ReducedMatchedPairState; reason: IndeterminateCertificate['reason'] }[] = [];
  for (let index = 0; index < rawEngineIndeterminacy.length; index++) {
    const entry = rawEngineIndeterminacy[index];
    const item = inertRecord(entry, 'Worker engine indeterminacy entry', ['state', 'reason']);
    if (!isEngineIndeterminacyReason(item.reason)) throw new RangeError('Worker engine indeterminacy reason is invalid');
    const state = validateState(canonicalState(item.state as ReducedMatchedPairState));
    if (state.n !== n) throw new RangeError('Worker engine indeterminacy has a state from another task');
    ownAppend(engineEntries, Object.freeze({ state, reason: item.reason as IndeterminateCertificate['reason'] }));
  }
  const engineIndeterminacy = Object.freeze(engineEntries);
  if (copy.reason !== null && !isSizeEnvelopeReason(copy.reason)) throw new RangeError('Worker size envelope reason is invalid');
  const allStates = enumerateReducedStates(n);
  const engineStates = ownArray<ReducedMatchedPairState>(engineIndeterminacy.length);
  for (let index = 0; index < engineIndeterminacy.length; index++) ownSet(engineStates, index, engineIndeterminacy[index]!.state);
  if (hasDuplicateStateKey(indeterminateStates) || hasDuplicateStateKey(alphaOverlapStates) || hasDuplicateStateKey(engineStates)) throw new RangeError('Worker size envelope state lists are inconsistent');
  for (let index = 0; index < indeterminateStates.length; index++) {
    const key = stateKey(indeterminateStates[index]!);
    if (!stateKeyIn(allStates, key) || (!stateKeyIn(alphaOverlapStates, key) && !stateKeyIn(engineStates, key))) throw new RangeError('Worker size envelope state lists are inconsistent');
  }
  for (let index = 0; index < alphaOverlapStates.length; index++) {
    const key = stateKey(alphaOverlapStates[index]!);
    if (!stateKeyIn(allStates, key) || stateKeyIn(engineStates, key) || !stateKeyIn(indeterminateStates, key)) throw new RangeError('Worker size envelope state lists are inconsistent');
  }
  for (let index = 0; index < engineStates.length; index++) {
    const key = stateKey(engineStates[index]!);
    if (!stateKeyIn(allStates, key) || !stateKeyIn(indeterminateStates, key)) throw new RangeError('Worker size envelope state lists are inconsistent');
  }
  const expectedReason = engineIndeterminacy[0]?.reason ?? (alphaOverlapStates.length > 0 ? 'overlapping_p_value' : null);
  if ((copy.status === 'certified' && (indeterminateStates.length !== 0 || copy.reason !== null || !polynomialEqual(lower, upper))) || (copy.status === 'indeterminate' && (indeterminateStates.length === 0 || copy.reason !== expectedReason))) throw new RangeError('Worker size envelope status is inconsistent');
  // Cheap, independently checkable probability sanity prevents a forged
  // constant such as [2] from becoming a "certified" envelope before the
  // second complete worker recomputation is compared.
  for (let pointIndex = 0; pointIndex < 2; pointIndex++) {
    const point = pointIndex === 0 ? margin : ONE;
    const low = evaluate(lower, point); const high = evaluate(upper, point);
    if (compare(low, ZERO) < 0 || compare(high, ONE) > 0 || compare(low, high) > 0) throw new RangeError('Worker size envelope is not a probability envelope');
  }
  return Object.freeze({ status: copy.status, lower, upper, indeterminateStates, engineIndeterminacy, alphaOverlapStates, reason: copy.reason as NullBoundarySizeEnvelope['reason'], request: Object.freeze({ n, margin, alpha }) });
}
function workerResponse(value: unknown): Readonly<{ ok: boolean; value?: unknown }> {
  const copy = inertRecordWithOptional(value, 'Worker response', ['ok'], ['value']);
  if (typeof copy.ok !== 'boolean' || (copy.ok && !Object.hasOwn(copy, 'value')) || (!copy.ok && Object.hasOwn(copy, 'value'))) throw new RangeError('Worker response is invalid');
  return copy as Readonly<{ ok: boolean; value?: unknown }>;
}
let activeWorkers = 0;
function launchVerifiedWorker<T>(task: WorkerTask, payload: unknown, hydrate: (value: unknown) => T): Promise<T | null> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    let resultSettled = false;
    let handleReleased = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reply: T | null = null;
    const settleResult = (result: T | null): void => {
      if (!resultSettled) {
        resultSettled = true;
        if (timer) clearTimeout(timer);
        resolve(result);
      }
    };
    const releaseHandle = (): void => {
      // A slot represents a live worker handle, not a settled Promise. Never
      // reopen it until exit confirms that the isolate is gone.
      if (!handleReleased) {
        handleReleased = true;
        channel.port1.close();
        activeWorkers--;
      }
    };
    let worker: Worker | undefined;
    try {
      worker = new Worker(workerUrl(), {
        workerData: { exactMatchedPairNiWorker: true, task, payload, authorizationPort: channel.port2 }, transferList: [channel.port2], resourceLimits: { maxOldGenerationSizeMb: MATCHED_PAIR_NI_WORKER_MAX_OLD_SPACE_MB },
        execArgv: import.meta.url.endsWith('.ts') ? ['--import', 'tsx'] : undefined,
      });
    } catch {
      // No worker handle was created, so this reserved slot can be returned.
      releaseHandle();
      settleResult(null);
      return;
    }
    const terminate = (): void => {
      // Termination failure is a conservative result but *not* a handle
      // release. A no-exit worker remains quarantined and consumes its slot.
      void worker!.terminate().catch(() => settleResult(null));
    };
    channel.port1.once('message', (message: unknown) => {
      if (message !== 'exact_matched_pair_ni_ready') terminate();
    });
    channel.port1.once('messageerror', () => terminate());
    timer = setTimeout(() => { terminate(); settleResult(null); }, MATCHED_PAIR_NI_WORKER_TIMEOUT_MILLISECONDS);
    worker.once('message', (message: unknown) => {
      try { const response = workerResponse(message); reply = response.ok ? hydrate(response.value) : null; }
      catch { reply = null; }
      // A response is terminal; do not leave a postMessage-capable worker
      // alive to race a later message or retain resources.
      terminate();
    });
    worker.once('messageerror', () => { reply = null; terminate(); });
    worker.once('error', () => { reply = null; terminate(); });
    worker.once('exit', () => { releaseHandle(); settleResult(reply); });
  });
}
function runBoundedWorker<T>(task: WorkerTask, payload: unknown, hydrate: (value: unknown) => T, equalResult: (left: T, right: T) => boolean, fallback: () => T): Promise<T> {
  // A complete proof is accepted only when two isolated computations of the
  // same captured request agree exactly. There is deliberately no queue.
  if (activeWorkers + 2 > MATCHED_PAIR_NI_MAX_CONCURRENT_WORKERS) return Promise.resolve(fallback());
  activeWorkers += 2;
  const left = launchVerifiedWorker(task, payload, hydrate);
  const right = launchVerifiedWorker(task, payload, hydrate);
  return left.then((leftValue) => right.then((rightValue) => leftValue !== null && rightValue !== null && equalResult(leftValue, rightValue) ? leftValue : fallback()))
    .catch(() => fallback());
}
export function enumerateReducedStates(n: number): readonly ReducedMatchedPairState[] {
  finiteCount(n, 'n');
  if (n === 0 || n > MATCHED_PAIR_NI_MAX_N) throw new RangeError(`Reduced-state enumeration requires n in [1, ${MATCHED_PAIR_NI_MAX_N}]`);
  const states = ownArray<ReducedMatchedPairState>(0);
  for (let t = 0; t <= n; t++) for (let x = 0; x <= t; x++) ownAppend(states, canonicalState({ n, x, t }));
  return Object.freeze(states);
}
function stateEquals(a: ReducedMatchedPairState, b: ReducedMatchedPairState): boolean { return a.n === b.n && a.x === b.x && a.t === b.t; }
function thetaHat(state: ReducedMatchedPairState): Rational { return divide(rational(2 * state.x - state.t), rational(state.n)); }
function phiHat(state: ReducedMatchedPairState): Rational { return divide(rational(state.t), rational(state.n)); }

/** Larger constrained root from the published score statistic's quadratic. */
export function restrictedPhiInterval(state: ReducedMatchedPairState, margin: Rational, squareRootRounds = 56): RationalInterval {
  const normalizedState = validateState(state); const normalizedMargin = validateMargin(margin);
  if (!Number.isSafeInteger(squareRootRounds) || squareRootRounds < 1 || squareRootRounds > 256) throw new RangeError('Square-root rounds must be an integer in [1, 256]');
  const theta = thetaHat(normalizedState);
  const phi = phiHat(normalizedState);
  const theta0 = negate(normalizedMargin);
  const a = add(phi, multiply(theta, theta0));
  const b = subtract(multiply(theta, theta0), multiply(subtract(ONE, phi), pow(theta0, 2)));
  const discriminant = subtract(pow(a, 2), multiply(rational(4), b));
  const root = sqrtInterval(discriminant, squareRootRounds);
  const unconstrained = intervalDividePositive(intervalAdd(interval(a, a), root), interval(TWO, TWO));
  // Bisection encloses the algebraic root, so trim only the harmless spill
  // outside the feasible nuisance interval; a disjoint root is invalid data.
  if (compare(unconstrained.upper, normalizedMargin) < 0 || compare(unconstrained.lower, ONE) > 0) {
    throw new RangeError('Restricted nuisance estimate is outside [margin, 1]');
  }
  return interval(
    compare(unconstrained.lower, normalizedMargin) < 0 ? normalizedMargin : unconstrained.lower,
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
    const division = divideWithRemainder(a, b);
    const remainder = division[1]!;
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
  const normalizedState = validateState(state); const normalizedMargin = validateMargin(margin);
  const coefficient = divide(rational(choose(normalizedState.n, normalizedState.t) * choose(normalizedState.t, normalizedState.x)), pow(TWO, normalizedState.t));
  return polynomialScale(
    polynomialMultiply(
      polynomialMultiply(polynomialPow([negate(normalizedMargin), ONE], normalizedState.x), polynomialPow([normalizedMargin, ONE], normalizedState.t - normalizedState.x)),
      polynomialPow([ONE, negate(ONE)], normalizedState.n - normalizedState.t),
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
  let result = interval(ZERO, ZERO);
  for (let index = 0; index < states.length; index++) result = intervalAdd(result, reducedStateProbabilityInterval(states[index]!, margin, phi));
  return result;
}
/** Engine-private factored maximum; its region derives only from E+M states. */
function maximizeProbabilityRegion(region: RationalPolynomial, states: readonly ReducedMatchedPairState[], margin: Rational) {
  const roots = isolateEngineInteriorRoots(derivative(region), margin, ONE, MATCHED_PAIR_NI_MAX_ROOT_BISECTIONS);
  let lower = evaluate(region, margin); let upper = lower;
  const endpoint = evaluate(region, ONE);
  if (compare(endpoint, lower) > 0) lower = endpoint;
  if (compare(endpoint, upper) > 0) upper = endpoint;
  for (let index = 0; index < roots.exact.length; index++) {
    const value = evaluate(region, roots.exact[index]!);
    if (compare(value, lower) > 0) lower = value;
    if (compare(value, upper) > 0) upper = value;
  }
  for (let index = 0; index < roots.intervals.length; index++) {
    const root = roots.intervals[index]!;
    const factored = probabilityRegionInterval(states, margin, root);
    // A private factorization is accepted only if its outer bounds are also
    // compatible with the independently expanded rational polynomial bound.
    const expanded = evaluateInterval(region, root);
    if (compare(factored.lower, expanded.upper) > 0 || compare(factored.upper, expanded.lower) < 0) {
      throw new RangeError('Factored probability enclosure conflicts with expanded polynomial');
    }
    if (compare(factored.lower, lower) > 0) lower = factored.lower;
    if (compare(factored.upper, upper) > 0) upper = factored.upper;
  }
  return Object.freeze({ lower, upper, stationaryPointCount: roots.exact.length + roots.intervals.length, indeterminate: roots.unresolved });
}
function stateKey(state: ReducedMatchedPairState): string { return `${state.x}:${state.t}`; }
/** Caches the exhaustive E step, keeping the certified result deterministic. */
function buildEStep(states: readonly ReducedMatchedPairState[], margin: Rational, budget: WorkBudget) {
  const phis = new Map<string, RationalInterval>();
  const scores = new Map<string, Score>();
  const ePolynomials = new Map<string, RationalPolynomial | null>();
  const eValues = new Map<string, RationalInterval | null>();
  const probabilities = new Map<string, RationalPolynomial>();
  let orderingAmbiguous = false;
  const phi = (state: ReducedMatchedPairState) => {
    const key = stateKey(state); let value = phis.get(key);
    if (!value) { budget.charge(); value = restrictedPhiInterval(state, margin); phis.set(key, value); }
    return value;
  };
  const scoreFor = (state: ReducedMatchedPairState) => {
    const key = stateKey(state); let value = scores.get(key);
    if (!value) { budget.charge(); value = score(state, margin, phi(state)); scores.set(key, value); }
    return value;
  };
  const order = (a: ReducedMatchedPairState, b: ReducedMatchedPairState): -1 | 0 | 1 | null => {
    budget.charge();
    if (stateEquals(a, b)) return 0;
    const left = scoreFor(a); const right = scoreFor(b);
    if (left.direction !== right.direction) return left.direction < right.direction ? -1 : 1;
    if (left.direction === 0) return 0;
    const coarse = left.direction === 1 ? compareIntervals(left.squared, right.squared) : compareIntervals(right.squared, left.squared);
    return coarse ?? compareScorePrecisely(a, b, margin);
  };
  const ePolynomial = (source: ReducedMatchedPairState): RationalPolynomial | null => {
    budget.charge(states.length);
    const key = stateKey(source);
    if (ePolynomials.has(key)) return ePolynomials.get(key)!;
    // Form all upper score tails once. This is the same E step as a nested
    // enumeration but avoids rebuilding O(states^2) polynomials.
    const ordered = ownArray<ReducedMatchedPairState>(states.length);
    for (let index = 0; index < states.length; index++) ownSet(ordered, index, states[index]!);
    // Stable insertion sort avoids caller-mutable Array.prototype.sort.
    for (let index = 1; index < ordered.length; index++) {
      const current = ordered[index]!;
      let cursor = index - 1;
      while (cursor >= 0) {
        const comparison = order(ordered[cursor]!, current);
        if (comparison === null) { orderingAmbiguous = true; break; }
        if (comparison <= 0) break;
        ownSet(ordered, cursor + 1, ordered[cursor]!);
        cursor--;
      }
      ownSet(ordered, cursor + 1, current);
      if (orderingAmbiguous) break;
    }
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
        if (!probability) { budget.charge(); probability = reducedStateProbabilityPolynomial(member, margin); probabilities.set(memberKey, probability); }
        tail = polynomialAdd(tail, probability);
      }
      for (let index = start; index <= end; index++) ePolynomials.set(stateKey(ordered[index]!), tail);
      end = start - 1;
    }
    return ePolynomials.get(key)!;
  };
  const eValue = (source: ReducedMatchedPairState): RationalInterval | null => {
    budget.charge();
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
  const normalizedState = validateState(state);
  if (normalizedState.t === 0) return ONE;
  let numerator = ZERO;
  for (let x = normalizedState.x; x <= normalizedState.t; x++) numerator = add(numerator, divide(rational(choose(normalizedState.t, x)), pow(TWO, normalizedState.t)));
  return numerator;
}

export function restrictedScoreEM(input: MatchedPairNiInput): Promise<MatchedPairNiResult> {
  const normalized = snapshotInput(input);
  if (!matchedPairNiSupport('inference', reduceMatchedPairCounts(normalized.counts).n, normalized.margin).supported) {
    return Promise.resolve(indeterminate('complexity_ceiling'));
  }
  return runBoundedWorker('restricted_score', normalized, (value) => hydrateMatchedPairNiResult(value, normalized), matchedResultEqual, () => indeterminate('complexity_ceiling'));
}
/** Runs only inside the bounded worker; not a runtime/admission API. */
function restrictedScoreEMWorker(input: MatchedPairNiInput): MatchedPairNiResult {
  if (isMainThread) throw new RangeError('Exact E+M core is worker-only');
  const normalizedInput = snapshotInput(input);
  const observed = reduceMatchedPairCounts(normalizedInput.counts);
  const normalized = validate(observed, normalizedInput.margin, normalizedInput.alpha);
  if (equal(normalized.margin, ZERO)) {
    const p = conditionalMcNemarPValue(observed);
    return Object.freeze({ mode: 'conditional_mcnemar_zero_margin', admission: MATCHED_PAIR_NI_ADMISSION, diagnostic: Object.freeze({ statisticalRejectNull: compare(p, normalized.alpha) <= 0, alphaDecision: compare(p, normalized.alpha) <= 0 ? 'reject_certified' : 'nonreject_certified', pValue: Object.freeze({ lower: p, upper: p }) }) });
  }
  if (!matchedPairNiSupport('inference', normalized.state.n, normalized.margin).supported) return indeterminate('complexity_ceiling');
  const budget = workBudgetFor(normalized.state.n, normalized.margin, normalized.alpha, false);
  if (!budget) return indeterminate('complexity_ceiling');
  try {
    const states = enumerateReducedStates(normalized.state.n);
    const eStep = buildEStep(states, normalized.margin, budget);
    return restrictedScoreEMReduced(normalized.state, normalized.margin, normalized.alpha, states, eStep, budget);
  } catch (error) {
    if (error instanceof RangeError && /ceiling/.test(error.message)) return indeterminate('complexity_ceiling');
    throw error;
  }
}
function restrictedScoreEMReduced(
  observed: ReducedMatchedPairState, margin: Rational, alpha: Rational,
  states: readonly ReducedMatchedPairState[], eStep: ReturnType<typeof buildEStep>, budget: WorkBudget,
): MatchedPairNiResult {
  budget.charge();
  const observedE = eStep.eValue(observed);
  if (!observedE || eStep.hasAmbiguousOrdering()) return indeterminate('ambiguous_score_ordering');
  let region = constant(ZERO);
  const regionStates: ReducedMatchedPairState[] = [];
  for (let stateIndex = 0; stateIndex < states.length; stateIndex++) {
    const state = states[stateIndex]!;
    budget.charge();
    const current = eStep.eValue(state);
    if (!current) return indeterminate('ambiguous_score_ordering');
    if (stateEquals(state, observed) || compare(current.upper, observedE.lower) <= 0) {
      region = polynomialAdd(region, reducedStateProbabilityPolynomial(state, margin));
      ownAppend(regionStates, state);
    }
    else if (compare(current.lower, observedE.upper) <= 0) return indeterminate('ambiguous_e_ordering');
  }
  const maximum = maximizeProbabilityRegion(region, regionStates, margin);
  if (maximum.indeterminate) return indeterminate('root_isolation_ceiling');
  const pValue = Object.freeze({ lower: maximum.lower, upper: maximum.upper });
  const certificate: ExactInferenceCertificate = Object.freeze({
    method: 'lloyd_moldovan_2008_restricted_score_e_plus_m', nullBoundary: 'theta=-margin', maximization: 'rational_sturm_and_interval_bisection',
    evaluatedEndpoints: true, stationaryPointCount: maximum.stationaryPointCount, pValue,
    request: Object.freeze({ n: observed.n, x: observed.x, t: observed.t, margin, alpha }),
    safeCeiling: Object.freeze({ maxN: MATCHED_PAIR_NI_MAX_N, maxPolynomialDegree: MATCHED_PAIR_NI_MAX_POLYNOMIAL_DEGREE, maxRootBisections: MATCHED_PAIR_NI_MAX_ROOT_BISECTIONS }),
    exactness: 'certified_enclosure_only',
  });
  const alphaDecision = compare(pValue.upper, alpha) <= 0 ? 'reject_certified'
    : compare(pValue.lower, alpha) > 0 ? 'nonreject_certified' : 'indeterminate_alpha_overlap';
  return Object.freeze({ mode: 'restricted_score_e_plus_m', admission: MATCHED_PAIR_NI_ADMISSION, diagnostic: Object.freeze({ statisticalRejectNull: alphaDecision === 'reject_certified', alphaDecision, pValue, certificate }) });
}
function indeterminate(reason: IndeterminateCertificate['reason']): MatchedPairNiResult {
  return Object.freeze({ mode: 'restricted_score_e_plus_m', admission: MATCHED_PAIR_NI_ADMISSION, diagnostic: Object.freeze({ statisticalRejectNull: false, alphaDecision: 'indeterminate_alpha_overlap', pValue: Object.freeze({ lower: ZERO, upper: ONE }), indeterminate: Object.freeze({ method: 'lloyd_moldovan_2008_restricted_score_e_plus_m', reason, reject: false }) }) });
}

export interface NullBoundarySizeEnvelope {
  readonly status: 'certified' | 'indeterminate';
  /** Canonical request identity carried across the worker boundary. */
  readonly request: Readonly<{ n: number; margin: Rational; alpha: Rational }>;
  /** Exact lower/upper rejection-region polynomials; never optimistic omission. */
  readonly lower: RationalPolynomial;
  readonly upper: RationalPolynomial;
  readonly indeterminateStates: readonly ReducedMatchedPairState[];
  /** Engine failures are distinct from a determinate p-value spanning alpha. */
  readonly engineIndeterminacy: readonly Readonly<{
    state: ReducedMatchedPairState;
    reason: IndeterminateCertificate['reason'];
  }>[];
  readonly alphaOverlapStates: readonly ReducedMatchedPairState[];
  readonly reason: IndeterminateCertificate['reason'] | 'overlapping_p_value' | 'size_complexity_ceiling' | null;
}
function sizeRequest(n: number, margin: Rational, alpha: Rational): Readonly<{ n: number; margin: Rational; alpha: Rational }> {
  return Object.freeze({ n, margin, alpha });
}
function sizeComplexityEnvelope(n: number, margin: Rational, alpha: Rational, states: readonly ReducedMatchedPairState[]): NullBoundarySizeEnvelope {
  return Object.freeze({ status: 'indeterminate', request: sizeRequest(n, margin, alpha), lower: constant(ZERO), upper: constant(ONE), indeterminateStates: states, engineIndeterminacy: Object.freeze([]), alphaOverlapStates: Object.freeze([]), reason: 'size_complexity_ceiling' });
}
/**
 * Certified null-boundary size envelope. Any unresolved p-value is included
 * in the upper polynomial, never silently discarded from a claimed exact size.
 */
export function nullBoundarySizeEnvelope(n: number, margin: Rational, alpha: Rational): Promise<NullBoundarySizeEnvelope> {
  const normalized = validate({ n, x: 0, t: 0 }, margin, alpha);
  if (equal(normalized.margin, ZERO)) throw new RangeError('Zero margin has conditional McNemar size, not an E+M polynomial');
  const states = enumerateReducedStates(normalized.state.n);
  const fallback = (): NullBoundarySizeEnvelope => sizeComplexityEnvelope(normalized.state.n, normalized.margin, normalized.alpha, states);
  if (!matchedPairNiSupport('null_boundary_size', normalized.state.n, normalized.margin).supported) return Promise.resolve(fallback());
  return runBoundedWorker('null_size', Object.freeze({ n: normalized.state.n, margin: normalized.margin, alpha: normalized.alpha }), (value) => hydrateSizeEnvelope(value, normalized.state.n, normalized.margin, normalized.alpha), sizeEnvelopeEqual, fallback);
}
/** Runs only inside the bounded worker; not a runtime/admission API. */
function nullBoundarySizeEnvelopeWorker(n: number, margin: Rational, alpha: Rational): NullBoundarySizeEnvelope {
  if (isMainThread) throw new RangeError('Exact E+M core is worker-only');
  const normalized = validate({ n, x: 0, t: 0 }, margin, alpha);
  if (equal(normalized.margin, ZERO)) throw new RangeError('Zero margin has conditional McNemar size, not an E+M polynomial');
  const states = enumerateReducedStates(normalized.state.n);
  if (!matchedPairNiSupport('null_boundary_size', normalized.state.n, normalized.margin).supported) {
    return sizeComplexityEnvelope(normalized.state.n, normalized.margin, normalized.alpha, states);
  }
  const budget = workBudgetFor(normalized.state.n, normalized.margin, normalized.alpha, true);
  if (!budget || normalized.state.n > MATCHED_PAIR_NI_MAX_SIZE_N) {
    return sizeComplexityEnvelope(normalized.state.n, normalized.margin, normalized.alpha, states);
  }
  let eStep: ReturnType<typeof buildEStep>;
  try {
    eStep = buildEStep(states, normalized.margin, budget);
  } catch (error) {
    if (!(error instanceof RangeError) || !/ceiling/.test(error.message)) throw error;
    return sizeComplexityEnvelope(normalized.state.n, normalized.margin, normalized.alpha, states);
  }
  let lower = constant(ZERO); let upper = constant(ZERO);
  const indeterminateStates: ReducedMatchedPairState[] = [];
  const engineIndeterminacy: { state: ReducedMatchedPairState; reason: IndeterminateCertificate['reason'] }[] = [];
  const alphaOverlapStates: ReducedMatchedPairState[] = [];
  try {
    for (let stateIndex = 0; stateIndex < states.length; stateIndex++) {
      const state = states[stateIndex]!;
      budget.charge();
      const counts = { n11: normalized.state.n - state.t, n10: state.x, n01: state.t - state.x, n00: 0 };
      const outcome = restrictedScoreEMReduced(reduceMatchedPairCounts(counts), normalized.margin, normalized.alpha, states, eStep, budget);
      const probability = reducedStateProbabilityPolynomial(state, normalized.margin);
      if (outcome.diagnostic.indeterminate) {
        upper = polynomialAdd(upper, probability);
        ownAppend(indeterminateStates, state);
        ownAppend(engineIndeterminacy, Object.freeze({ state, reason: outcome.diagnostic.indeterminate.reason }));
      } else if (outcome.diagnostic.statisticalRejectNull) {
        lower = polynomialAdd(lower, probability);
        upper = polynomialAdd(upper, probability);
      } else if (compare(outcome.diagnostic.pValue.lower, alpha) <= 0) {
        // The actual p-value could be <= alpha inside its certified enclosure.
        // Include it only in the upper size region and advertise the uncertainty.
        upper = polynomialAdd(upper, probability);
        ownAppend(indeterminateStates, state);
        ownAppend(alphaOverlapStates, state);
      }
    }
  } catch (error) {
    if (!(error instanceof RangeError) || !/ceiling/.test(error.message)) throw error;
    return sizeComplexityEnvelope(normalized.state.n, normalized.margin, normalized.alpha, states);
  }
  return Object.freeze({
    status: indeterminateStates.length === 0 ? 'certified' : 'indeterminate', request: sizeRequest(normalized.state.n, normalized.margin, normalized.alpha), lower, upper,
    indeterminateStates: Object.freeze(indeterminateStates),
    engineIndeterminacy: Object.freeze(engineIndeterminacy), alphaOverlapStates: Object.freeze(alphaOverlapStates),
    reason: engineIndeterminacy[0]?.reason ?? (alphaOverlapStates.length > 0 ? 'overlapping_p_value' : null),
  });
}
/** Typed non-admitting contracts: confidence inversion and adaptive resizing are deliberately absent. */
export interface MatchedPairNiConfidenceInversion { readonly status: 'not_implemented_non_admitting'; }
export interface MatchedPairNiAdaptiveResizing { readonly status: 'not_implemented_non_admitting'; }
export const parseMatchedPairNiDecimal = decimal;

/* The only route to the unexported complete-computation cores. The parent
 * always supplies Worker resource limits and terminates at the wall-clock
 * ceiling; importing this module in another worker exposes only the public,
 * bounded API. */
interface EngineWorkerRequest {
  readonly exactMatchedPairNiWorker: true;
  readonly task: WorkerTask;
  readonly payload: MatchedPairNiInput | Readonly<{ n: number; margin: Rational; alpha: Rational }>;
  readonly authorizationPort: MessagePort;
  /** Test-only phase telemetry; never a capability or a policy input. */
  readonly trace?: true;
}
function isEngineWorkerRequest(value: unknown): value is EngineWorkerRequest {
  return Boolean(value && typeof value === 'object' && (value as { exactMatchedPairNiWorker?: unknown }).exactMatchedPairNiWorker === true && (value as { authorizationPort?: unknown }).authorizationPort instanceof MessagePort);
}
if (!isMainThread && isEngineWorkerRequest(workerData)) {
  const request = workerData;
  request.authorizationPort.postMessage('exact_matched_pair_ni_ready');
  // Do not wait on a JavaScript EventEmitter/MessagePort callback here. An
  // arbitrary worker realm can poison Array.prototype before import, and
  // Node listener delivery is outside this module's control. Running the
  // intrinsically bounded core directly makes recreated activation harmless;
  // the parent launcher still enforces the worker wall/resource boundary.
  // Deferral lets a source-test entry install poison after ESM linking but
  // before the imported module's computation closure runs. It is a native
  // microtask boundary, not a caller-provided port/event callback.
  queueMicrotask(() => {
    if (request.trace === true) request.authorizationPort.postMessage('core_start');
    try {
      const value = request.task === 'restricted_score'
        ? restrictedScoreEMWorker(request.payload as MatchedPairNiInput)
        : nullBoundarySizeEnvelopeWorker(
          (request.payload as { n: number }).n,
          (request.payload as { margin: Rational }).margin,
          (request.payload as { alpha: Rational }).alpha,
        );
      if (request.trace === true) request.authorizationPort.postMessage('core_complete');
      request.authorizationPort.close(); parentPort?.postMessage({ ok: true, value });
    } catch {
      request.authorizationPort.close(); parentPort?.postMessage({ ok: false });
    }
  });
}
