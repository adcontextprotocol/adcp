import { types } from 'node:util';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
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

export const MATCHED_PAIR_NI_MAX_N = 25;
// 24 exact dyadic subdivisions give a < 2^-24 nuisance interval while
// bounding BigInt growth for the deliberately small diagnostic ceiling.
export const MATCHED_PAIR_NI_MAX_ROOT_BISECTIONS = 24;
export const MATCHED_PAIR_NI_MAX_POLYNOMIAL_DEGREE = 25;
/** Measured synchronous ceiling for exhaustive rejection-region certification. */
export const MATCHED_PAIR_NI_MAX_SIZE_N = 8;
/**
 * Preflight limits prevent legal-but-expensive precision from entering Sturm
 * work. At n=8, 16 bits bounds the exhaustive estimate below the aggregate
 * ceiling; 17 bits and every former 128-bit boundary fail before enumeration.
 */
export const MATCHED_PAIR_NI_MAX_MARGIN_BITS_FOR_SIZE = 16;
export const MATCHED_PAIR_NI_MAX_MARGIN_BITS_FOR_INFERENCE = 16;
/** Aggregate deterministic E-step comparison-work budget, checked before and during exhaustive work. */
export const MATCHED_PAIR_NI_MAX_WORK_UNITS = 1_500_000;
/** Diagnostic CPU deadline checked at deterministic E-step work boundaries. */
export const MATCHED_PAIR_NI_MAX_WORK_MILLISECONDS = 12_000;
export const MATCHED_PAIR_NI_WORKER_TIMEOUT_MILLISECONDS = 20_000;
/** At most two isolated computations may consume process memory concurrently. */
export const MATCHED_PAIR_NI_MAX_CONCURRENT_WORKERS = 2;
/** This is V8 old-space only, not a total RSS/cgroup assertion. */
export const MATCHED_PAIR_NI_WORKER_MAX_OLD_SPACE_MB = 64;

export interface MatchedPairCounts { readonly n11: number; readonly n10: number; readonly n01: number; readonly n00: number; }
export interface ReducedMatchedPairState { readonly n: number; readonly x: number; readonly t: number; }
export interface MatchedPairNiInput { readonly counts: MatchedPairCounts; readonly margin: Rational; readonly alpha: Rational; }
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
function exceedsPrecisionBudget(state: ReducedMatchedPairState, margin: Rational, _alpha: Rational, exhaustiveSize = false): boolean {
  const limit = exhaustiveSize ? MATCHED_PAIR_NI_MAX_MARGIN_BITS_FOR_SIZE : MATCHED_PAIR_NI_MAX_MARGIN_BITS_FOR_INFERENCE;
  return rationalBitLength(margin) > limit;
}
function estimatedWorkUnits(n: number, precisionBits: number, exhaustiveSize: boolean): number {
  const states = reducedStateCount(n);
  // Each E-step comparison is charged as one unit below. One diagnostic has
  // O(S^2) comparisons; an S-state size envelope has O(S^3), S=(n+1)(n+2)/2.
  return (exhaustiveSize ? states * states * states : states * states) * precisionBits;
}
class WorkBudget {
  private used = 0;
  private readonly deadline = Date.now() + MATCHED_PAIR_NI_MAX_WORK_MILLISECONDS;
  constructor(private readonly limit: number) {}
  charge(units = 1): void {
    this.used += units;
    if (this.used > this.limit || Date.now() > this.deadline) throw new RangeError('Exact E+M aggregate work ceiling exceeded');
  }
}
/* This isolation path is deliberately module-private. It is reachable only
 * from the managed worker core below, whose full computation has a wall-clock
 * and memory boundary. Public direct isolation stays deadline-bounded in
 * algebraic.ts. */
function engineIntegerGcd(left: bigint, right: bigint): bigint {
  let a = left < 0n ? -left : left; let b = right < 0n ? -right : right;
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}
function enginePrimitive(value: RationalPolynomial): RationalPolynomial {
  const normalized = canonicalPolynomial(value, 'Engine root polynomial');
  let common = 1n;
  for (const coefficient of normalized) common = common / engineIntegerGcd(common, coefficient.denominator) * coefficient.denominator;
  const integers = normalized.map((coefficient) => coefficient.numerator * (common / coefficient.denominator));
  const content = integers.reduce((result, coefficient) => engineIntegerGcd(result, coefficient), 0n) || 1n;
  return polynomial(integers.map((coefficient) => rational(coefficient / content)));
}
function engineSturm(value: RationalPolynomial): readonly RationalPolynomial[] {
  const polynomialValue = enginePrimitive(value);
  if (isZero(polynomialValue)) throw new RangeError('Sturm sequence requires a nonzero polynomial');
  const sequence: RationalPolynomial[] = [polynomialValue, enginePrimitive(derivative(polynomialValue))];
  while (!isZero(sequence[sequence.length - 1]!)) {
    const [, remainder] = divideWithRemainder(sequence[sequence.length - 2]!, sequence[sequence.length - 1]!);
    if (isZero(remainder)) break;
    sequence.push(enginePrimitive(polynomialNegate(remainder)));
  }
  return Object.freeze(sequence);
}
function enginePolynomialGcd(left: RationalPolynomial, right: RationalPolynomial): RationalPolynomial {
  let a = enginePrimitive(left); let b = enginePrimitive(right);
  while (!isZero(b)) {
    const [, remainder] = divideWithRemainder(a, b);
    a = b; b = isZero(remainder) ? remainder : enginePrimitive(remainder);
  }
  return a;
}
function engineSquareFree(value: RationalPolynomial): RationalPolynomial {
  const slope = derivative(value);
  if (isZero(slope)) return value;
  const divisor = enginePolynomialGcd(value, slope);
  const [quotient, remainder] = divideWithRemainder(value, divisor);
  if (!isZero(remainder)) throw new RangeError('Polynomial square-free division was not exact');
  return enginePrimitive(quotient);
}
function engineVariations(sequence: readonly RationalPolynomial[], at: Rational): number {
  const signs = sequence.map((item) => compare(evaluate(item, at), ZERO)).filter((item) => item !== 0);
  return signs.reduce((total, item, index) => total + (index > 0 && signs[index - 1] !== item ? 1 : 0), 0);
}
function isolateEngineInteriorRoots(value: RationalPolynomial, lower: Rational, upper: Rational, refinementBits: number): RootIsolation {
  const polynomialValue = canonicalPolynomial(value, 'Engine root polynomial');
  const lowerBound = canonicalRational(lower, 'Engine root lower bound'); const upperBound = canonicalRational(upper, 'Engine root upper bound');
  if (compare(lowerBound, upperBound) > 0) throw new RangeError('Root lower bound must not exceed upper bound');
  if (!Number.isSafeInteger(refinementBits) || refinementBits < 1 || refinementBits > MATCHED_PAIR_NI_MAX_ROOT_BISECTIONS) throw new RangeError(`Root refinement bits must be an integer in [1, ${MATCHED_PAIR_NI_MAX_ROOT_BISECTIONS}]`);
  if (degree(polynomialValue) <= 0) return Object.freeze({ exact: Object.freeze([]), intervals: Object.freeze([]), unresolved: false });
  const distinct = engineSquareFree(polynomialValue); const sequence = engineSturm(distinct);
  const exact: Rational[] = []; const intervals: RationalInterval[] = []; let unresolved = false;
  const rootsInOpen = (left: Rational, right: Rational): number => engineVariations(sequence, left) - engineVariations(sequence, right) - (compare(evaluate(distinct, right), ZERO) === 0 ? 1 : 0);
  const visit = (left: Rational, right: Rational, depth: number): void => {
    const count = rootsInOpen(left, right);
    if (count <= 0) return;
    if (depth >= refinementBits) { if (count === 1) intervals.push(interval(left, right)); else unresolved = true; return; }
    const middle = divide(add(left, right), TWO);
    if (compare(evaluate(polynomialValue, middle), ZERO) === 0) { exact.push(middle); visit(left, middle, depth + 1); visit(middle, right, depth + 1); return; }
    visit(left, middle, depth + 1); visit(middle, right, depth + 1);
  };
  visit(lowerBound, upperBound, 0);
  return Object.freeze({ exact: Object.freeze(exact), intervals: Object.freeze(intervals), unresolved });
}
function workBudgetFor(n: number, margin: Rational, _alpha: Rational, exhaustiveSize: boolean): WorkBudget | null {
  // Alpha is only compared after the exact p-value has been certified; it
  // does not enter score/root arithmetic, so nuisance-margin bits govern work.
  const bits = rationalBitLength(margin);
  const estimate = estimatedWorkUnits(n, bits, exhaustiveSize);
  return estimate > MATCHED_PAIR_NI_MAX_WORK_UNITS ? null : new WorkBudget(MATCHED_PAIR_NI_MAX_WORK_UNITS);
}

function inertRecord(value: unknown, name: string, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RangeError(`${name} must be an inert record`);
  let descriptors: PropertyDescriptorMap;
  try {
    if (types.isProxy(value)) throw new TypeError();
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new TypeError();
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch { throw new RangeError(`${name} must not be a Proxy or dynamic object`); }
  if (Reflect.ownKeys(descriptors).length !== fields.length || fields.some((field) => !Object.hasOwn(descriptors, field))) throw new RangeError(`${name} has unexpected fields`);
  const copy = Object.create(null) as Record<string, unknown>;
  for (const field of fields) {
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
  const allowed = new Set([...required, ...optional]);
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== 'string' || !allowed.has(key)) || required.some((field) => !Object.hasOwn(descriptors, field))) throw new RangeError(`${name} has unexpected fields`);
  const copy = Object.create(null) as Record<string, unknown>;
  for (const field of [...required, ...optional]) {
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
  for (const name of ['n11', 'n10', 'n01', 'n00'] as const) finiteCount(copy[name] as number, name);
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
function hydrateCertificate(value: unknown, pValue: Readonly<{ lower: Rational; upper: Rational }>): ExactInferenceCertificate {
  const copy = inertRecord(value, 'Worker exact certificate', ['method', 'nullBoundary', 'maximization', 'evaluatedEndpoints', 'stationaryPointCount', 'pValue', 'safeCeiling', 'exactness']);
  if (copy.method !== 'lloyd_moldovan_2008_restricted_score_e_plus_m' || copy.nullBoundary !== 'theta=-margin' || copy.maximization !== 'rational_sturm_and_interval_bisection' || copy.evaluatedEndpoints !== true || copy.exactness !== 'certified_enclosure_only' || !Number.isSafeInteger(copy.stationaryPointCount) || (copy.stationaryPointCount as number) < 0) throw new RangeError('Worker exact certificate is invalid');
  const certificatePValue = hydratePValue(copy.pValue, 'Worker certificate p-value');
  if (!equal(certificatePValue.lower, pValue.lower) || !equal(certificatePValue.upper, pValue.upper)) throw new RangeError('Worker certificate p-value disagrees with result');
  const ceiling = inertRecord(copy.safeCeiling, 'Worker safe ceiling', ['maxN', 'maxPolynomialDegree', 'maxRootBisections']);
  if (ceiling.maxN !== MATCHED_PAIR_NI_MAX_N || ceiling.maxPolynomialDegree !== MATCHED_PAIR_NI_MAX_POLYNOMIAL_DEGREE || ceiling.maxRootBisections !== MATCHED_PAIR_NI_MAX_ROOT_BISECTIONS) throw new RangeError('Worker safe ceiling is invalid');
  return Object.freeze({ method: copy.method, nullBoundary: copy.nullBoundary, maximization: copy.maximization, evaluatedEndpoints: true, stationaryPointCount: copy.stationaryPointCount as number, pValue, safeCeiling: Object.freeze({ maxN: MATCHED_PAIR_NI_MAX_N, maxPolynomialDegree: MATCHED_PAIR_NI_MAX_POLYNOMIAL_DEGREE, maxRootBisections: MATCHED_PAIR_NI_MAX_ROOT_BISECTIONS }), exactness: copy.exactness });
}
function hydrateIndeterminate(value: unknown): IndeterminateCertificate {
  const copy = inertRecord(value, 'Worker indeterminate certificate', ['method', 'reason', 'reject']);
  if (copy.method !== 'lloyd_moldovan_2008_restricted_score_e_plus_m' || copy.reject !== false || !['ambiguous_score_ordering', 'ambiguous_e_ordering', 'root_isolation_ceiling', 'complexity_ceiling'].includes(copy.reason as string)) throw new RangeError('Worker indeterminate certificate is invalid');
  return Object.freeze({ method: copy.method, reason: copy.reason as IndeterminateCertificate['reason'], reject: false });
}
/** Rebuild a worker result from canonical values; structured clone drops freezes. */
function hydrateMatchedPairNiResult(value: unknown, input: MatchedPairNiInput): MatchedPairNiResult {
  const result = inertRecord(value, 'Worker diagnostic result', ['mode', 'admission', 'diagnostic']);
  if (result.mode !== 'restricted_score_e_plus_m' && result.mode !== 'conditional_mcnemar_zero_margin') throw new RangeError('Worker diagnostic mode is invalid');
  const diagnostic = inertRecordWithOptional(result.diagnostic, 'Worker diagnostic', ['statisticalRejectNull', 'alphaDecision', 'pValue'], ['certificate', 'indeterminate']);
  if (typeof diagnostic.statisticalRejectNull !== 'boolean' || !['reject_certified', 'nonreject_certified', 'indeterminate_alpha_overlap'].includes(diagnostic.alphaDecision as string) || (diagnostic.certificate !== undefined && diagnostic.indeterminate !== undefined)) throw new RangeError('Worker diagnostic is invalid');
  const pValue = hydratePValue(diagnostic.pValue, 'Worker diagnostic p-value');
  if (compare(pValue.lower, ZERO) < 0 || compare(pValue.upper, ONE) > 0) throw new RangeError('Worker diagnostic p-value is outside [0, 1]');
  const certificate = diagnostic.certificate === undefined ? undefined : hydrateCertificate(diagnostic.certificate, pValue);
  const indeterminate = diagnostic.indeterminate === undefined ? undefined : hydrateIndeterminate(diagnostic.indeterminate);
  const expectedDecision = compare(pValue.upper, input.alpha) <= 0 ? 'reject_certified'
    : compare(pValue.lower, input.alpha) > 0 ? 'nonreject_certified' : 'indeterminate_alpha_overlap';
  if ((diagnostic.alphaDecision === 'reject_certified') !== diagnostic.statisticalRejectNull || diagnostic.alphaDecision !== expectedDecision || (indeterminate !== undefined && diagnostic.statisticalRejectNull) || (result.mode === 'restricted_score_e_plus_m' && certificate === undefined && indeterminate === undefined) || (result.mode === 'conditional_mcnemar_zero_margin' && (certificate !== undefined || indeterminate !== undefined)) || (equal(input.margin, ZERO) !== (result.mode === 'conditional_mcnemar_zero_margin')) || (indeterminate !== undefined && (!equal(pValue.lower, ZERO) || !equal(pValue.upper, ONE)))) throw new RangeError('Worker diagnostic decision is inconsistent');
  return Object.freeze({ mode: result.mode, admission: MATCHED_PAIR_NI_ADMISSION, diagnostic: Object.freeze({ statisticalRejectNull: diagnostic.statisticalRejectNull, alphaDecision: diagnostic.alphaDecision as MatchedPairNiResult['diagnostic']['alphaDecision'], pValue, ...(certificate ? { certificate } : {}), ...(indeterminate ? { indeterminate } : {}) }) });
}
function hydrateStates(value: unknown, name: string): readonly ReducedMatchedPairState[] {
  return Object.freeze(inertList(value, name).map((state) => canonicalState(state as ReducedMatchedPairState)));
}
function polynomialEqual(left: RationalPolynomial, right: RationalPolynomial): boolean {
  return left.length === right.length && left.every((coefficient, index) => equal(coefficient, right[index]!));
}
function stateKeySet(states: readonly ReducedMatchedPairState[]): Set<string> { return new Set(states.map((state) => stateKey(state))); }
function hydrateSizeEnvelope(value: unknown, n: number): NullBoundarySizeEnvelope {
  const copy = inertRecord(value, 'Worker size envelope', ['status', 'lower', 'upper', 'indeterminateStates', 'engineIndeterminacy', 'alphaOverlapStates', 'reason']);
  if (copy.status !== 'certified' && copy.status !== 'indeterminate') throw new RangeError('Worker size envelope status is invalid');
  const lower = canonicalPolynomial(copy.lower as RationalPolynomial, 'Worker size lower polynomial');
  const upper = canonicalPolynomial(copy.upper as RationalPolynomial, 'Worker size upper polynomial');
  const indeterminateStates = hydrateStates(copy.indeterminateStates, 'Worker indeterminate states');
  const alphaOverlapStates = hydrateStates(copy.alphaOverlapStates, 'Worker alpha-overlap states');
  const engineIndeterminacy = Object.freeze(inertList(copy.engineIndeterminacy, 'Worker engine indeterminacy').map((entry) => {
    const item = inertRecord(entry, 'Worker engine indeterminacy entry', ['state', 'reason']);
    if (!['ambiguous_score_ordering', 'ambiguous_e_ordering', 'root_isolation_ceiling', 'complexity_ceiling'].includes(item.reason as string)) throw new RangeError('Worker engine indeterminacy reason is invalid');
    return Object.freeze({ state: canonicalState(item.state as ReducedMatchedPairState), reason: item.reason as IndeterminateCertificate['reason'] });
  }));
  if (copy.reason !== null && !['ambiguous_score_ordering', 'ambiguous_e_ordering', 'root_isolation_ceiling', 'complexity_ceiling', 'overlapping_p_value', 'size_complexity_ceiling'].includes(copy.reason as string)) throw new RangeError('Worker size envelope reason is invalid');
  const allStates = stateKeySet(enumerateReducedStates(n));
  const indeterminateKeys = stateKeySet(indeterminateStates); const overlapKeys = stateKeySet(alphaOverlapStates); const engineKeys = stateKeySet(engineIndeterminacy.map((entry) => entry.state));
  if (indeterminateKeys.size !== indeterminateStates.length || overlapKeys.size !== alphaOverlapStates.length || engineKeys.size !== engineIndeterminacy.length || [...indeterminateKeys, ...overlapKeys, ...engineKeys].some((key) => !allStates.has(key)) || [...overlapKeys].some((key) => engineKeys.has(key)) || [...indeterminateKeys].some((key) => !overlapKeys.has(key) && !engineKeys.has(key)) || [...overlapKeys, ...engineKeys].some((key) => !indeterminateKeys.has(key))) throw new RangeError('Worker size envelope state lists are inconsistent');
  const expectedReason = engineIndeterminacy[0]?.reason ?? (alphaOverlapStates.length > 0 ? 'overlapping_p_value' : null);
  if ((copy.status === 'certified' && (indeterminateStates.length !== 0 || copy.reason !== null || !polynomialEqual(lower, upper))) || (copy.status === 'indeterminate' && (indeterminateStates.length === 0 || copy.reason !== expectedReason))) throw new RangeError('Worker size envelope status is inconsistent');
  return Object.freeze({ status: copy.status, lower, upper, indeterminateStates, engineIndeterminacy, alphaOverlapStates, reason: copy.reason as NullBoundarySizeEnvelope['reason'] });
}
function workerResponse(value: unknown): Readonly<{ ok: boolean; value?: unknown }> {
  const copy = inertRecordWithOptional(value, 'Worker response', ['ok'], ['value']);
  if (typeof copy.ok !== 'boolean' || (copy.ok && !Object.hasOwn(copy, 'value')) || (!copy.ok && Object.hasOwn(copy, 'value'))) throw new RangeError('Worker response is invalid');
  return copy as Readonly<{ ok: boolean; value?: unknown }>;
}
let activeWorkers = 0;
function runBoundedWorker<T>(task: WorkerTask, payload: unknown, hydrate: (value: unknown) => T, fallback: () => T): Promise<T> {
  return new Promise((resolve) => {
    // There is deliberately no unbounded queue: a saturated caller gets
    // conservative evidence immediately instead of an unbounded wait.
    if (activeWorkers >= MATCHED_PAIR_NI_MAX_CONCURRENT_WORKERS) { resolve(fallback()); return; }
    activeWorkers++;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: T): void => {
      if (!settled) { settled = true; if (timer) clearTimeout(timer); activeWorkers--; resolve(result); }
    };
    let worker: Worker;
    try {
      worker = new Worker(workerUrl(), {
        workerData: Object.freeze({ exactMatchedPairNiWorker: true, task, payload }), resourceLimits: { maxOldGenerationSizeMb: MATCHED_PAIR_NI_WORKER_MAX_OLD_SPACE_MB },
        execArgv: import.meta.url.endsWith('.ts') ? ['--import', 'tsx'] : undefined,
      });
    } catch { finish(fallback()); return; }
    timer = setTimeout(() => { void worker.terminate().finally(() => finish(fallback())); }, MATCHED_PAIR_NI_WORKER_TIMEOUT_MILLISECONDS);
    worker.once('message', (message: unknown) => {
      try { const response = workerResponse(message); finish(response.ok ? hydrate(response.value) : fallback()); }
      catch { finish(fallback()); }
    });
    worker.once('error', () => finish(fallback()));
    worker.once('exit', () => finish(fallback()));
  });
}
export function enumerateReducedStates(n: number): readonly ReducedMatchedPairState[] {
  finiteCount(n, 'n');
  if (n === 0 || n > MATCHED_PAIR_NI_MAX_N) throw new RangeError(`Reduced-state enumeration requires n in [1, ${MATCHED_PAIR_NI_MAX_N}]`);
  return Object.freeze(Array.from({ length: n + 1 }, (_, t) => Array.from({ length: t + 1 }, (_, x) => canonicalState({ n, x, t }))).flat());
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
    const [, remainder] = divideWithRemainder(a, b);
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
  return states.reduce((result, state) => intervalAdd(result, reducedStateProbabilityInterval(state, margin, phi)), interval(ZERO, ZERO));
}
/** Engine-private factored maximum; its region derives only from E+M states. */
function maximizeProbabilityRegion(region: RationalPolynomial, states: readonly ReducedMatchedPairState[], margin: Rational) {
  const roots = isolateEngineInteriorRoots(derivative(region), margin, ONE, MATCHED_PAIR_NI_MAX_ROOT_BISECTIONS);
  let lower = evaluate(region, margin); let upper = lower;
  for (const point of [ONE, ...roots.exact]) {
    const value = evaluate(region, point);
    if (compare(value, lower) > 0) lower = value;
    if (compare(value, upper) > 0) upper = value;
  }
  for (const root of roots.intervals) {
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
    const ordered = [...states];
    ordered.sort((a, b) => {
      const value = order(a, b);
      if (value === null) { orderingAmbiguous = true; return 0; }
      return value;
    });
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
  return runBoundedWorker('restricted_score', normalized, (value) => hydrateMatchedPairNiResult(value, normalized), () => indeterminate('complexity_ceiling'));
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
  if (exceedsPrecisionBudget(normalized.state, normalized.margin, normalized.alpha)) return indeterminate('complexity_ceiling');
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
  for (const state of states) {
    budget.charge();
    const current = eStep.eValue(state);
    if (!current) return indeterminate('ambiguous_score_ordering');
    if (stateEquals(state, observed) || compare(current.upper, observedE.lower) <= 0) {
      region = polynomialAdd(region, reducedStateProbabilityPolynomial(state, margin));
      regionStates.push(state);
    }
    else if (compare(current.lower, observedE.upper) <= 0) return indeterminate('ambiguous_e_ordering');
  }
  const maximum = maximizeProbabilityRegion(region, regionStates, margin);
  if (maximum.indeterminate) return indeterminate('root_isolation_ceiling');
  const pValue = Object.freeze({ lower: maximum.lower, upper: maximum.upper });
  const certificate: ExactInferenceCertificate = Object.freeze({
    method: 'lloyd_moldovan_2008_restricted_score_e_plus_m', nullBoundary: 'theta=-margin', maximization: 'rational_sturm_and_interval_bisection',
    evaluatedEndpoints: true, stationaryPointCount: maximum.stationaryPointCount, pValue,
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
/**
 * Certified null-boundary size envelope. Any unresolved p-value is included
 * in the upper polynomial, never silently discarded from a claimed exact size.
 */
export function nullBoundarySizeEnvelope(n: number, margin: Rational, alpha: Rational): Promise<NullBoundarySizeEnvelope> {
  const normalized = validate({ n, x: 0, t: 0 }, margin, alpha);
  if (equal(normalized.margin, ZERO)) throw new RangeError('Zero margin has conditional McNemar size, not an E+M polynomial');
  const states = enumerateReducedStates(normalized.state.n);
  const fallback = (): NullBoundarySizeEnvelope => Object.freeze({
    status: 'indeterminate', lower: constant(ZERO), upper: constant(ONE), indeterminateStates: states,
    engineIndeterminacy: Object.freeze([]), alphaOverlapStates: Object.freeze([]), reason: 'size_complexity_ceiling',
  });
  return runBoundedWorker('null_size', Object.freeze({ n: normalized.state.n, margin: normalized.margin, alpha: normalized.alpha }), (value) => hydrateSizeEnvelope(value, normalized.state.n), fallback);
}
/** Runs only inside the bounded worker; not a runtime/admission API. */
function nullBoundarySizeEnvelopeWorker(n: number, margin: Rational, alpha: Rational): NullBoundarySizeEnvelope {
  if (isMainThread) throw new RangeError('Exact E+M core is worker-only');
  const normalized = validate({ n, x: 0, t: 0 }, margin, alpha);
  if (equal(normalized.margin, ZERO)) throw new RangeError('Zero margin has conditional McNemar size, not an E+M polynomial');
  const states = enumerateReducedStates(normalized.state.n);
  if (exceedsPrecisionBudget(normalized.state, normalized.margin, normalized.alpha, true)) {
    return Object.freeze({ status: 'indeterminate', lower: constant(ZERO), upper: constant(ONE), indeterminateStates: states, engineIndeterminacy: Object.freeze([]), alphaOverlapStates: Object.freeze([]), reason: 'size_complexity_ceiling' });
  }
  const budget = workBudgetFor(normalized.state.n, normalized.margin, normalized.alpha, true);
  if (!budget || normalized.state.n > MATCHED_PAIR_NI_MAX_SIZE_N) {
    return Object.freeze({ status: 'indeterminate', lower: constant(ZERO), upper: constant(ONE), indeterminateStates: states, engineIndeterminacy: Object.freeze([]), alphaOverlapStates: Object.freeze([]), reason: 'size_complexity_ceiling' });
  }
  let eStep: ReturnType<typeof buildEStep>;
  try {
    eStep = buildEStep(states, normalized.margin, budget);
  } catch (error) {
    if (!(error instanceof RangeError) || !/ceiling/.test(error.message)) throw error;
    return Object.freeze({ status: 'indeterminate', lower: constant(ZERO), upper: constant(ONE), indeterminateStates: states, engineIndeterminacy: Object.freeze([]), alphaOverlapStates: Object.freeze([]), reason: 'size_complexity_ceiling' });
  }
  let lower = constant(ZERO); let upper = constant(ZERO);
  const indeterminateStates: ReducedMatchedPairState[] = [];
  const engineIndeterminacy: { state: ReducedMatchedPairState; reason: IndeterminateCertificate['reason'] }[] = [];
  const alphaOverlapStates: ReducedMatchedPairState[] = [];
  try {
    for (const state of states) {
      budget.charge();
      const counts = { n11: normalized.state.n - state.t, n10: state.x, n01: state.t - state.x, n00: 0 };
      const outcome = restrictedScoreEMReduced(reduceMatchedPairCounts(counts), normalized.margin, normalized.alpha, states, eStep, budget);
      const probability = reducedStateProbabilityPolynomial(state, normalized.margin);
      if (outcome.diagnostic.indeterminate) {
        upper = polynomialAdd(upper, probability);
        indeterminateStates.push(state);
        engineIndeterminacy.push(Object.freeze({ state, reason: outcome.diagnostic.indeterminate.reason }));
      } else if (outcome.diagnostic.statisticalRejectNull) {
        lower = polynomialAdd(lower, probability);
        upper = polynomialAdd(upper, probability);
      } else if (compare(outcome.diagnostic.pValue.lower, alpha) <= 0) {
        // The actual p-value could be <= alpha inside its certified enclosure.
        // Include it only in the upper size region and advertise the uncertainty.
        upper = polynomialAdd(upper, probability);
        indeterminateStates.push(state);
        alphaOverlapStates.push(state);
      }
    }
  } catch (error) {
    if (!(error instanceof RangeError) || !/ceiling/.test(error.message)) throw error;
    return Object.freeze({ status: 'indeterminate', lower: constant(ZERO), upper: constant(ONE), indeterminateStates: states, engineIndeterminacy: Object.freeze([]), alphaOverlapStates: Object.freeze([]), reason: 'size_complexity_ceiling' });
  }
  return Object.freeze({
    status: indeterminateStates.length === 0 ? 'certified' : 'indeterminate', lower, upper,
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
}
function isEngineWorkerRequest(value: unknown): value is EngineWorkerRequest {
  return Boolean(value && typeof value === 'object' && (value as { exactMatchedPairNiWorker?: unknown }).exactMatchedPairNiWorker === true);
}
if (!isMainThread && isEngineWorkerRequest(workerData)) {
  try {
    const request = workerData;
    const value = request.task === 'restricted_score'
      ? restrictedScoreEMWorker(request.payload as MatchedPairNiInput)
      : nullBoundarySizeEnvelopeWorker(
        (request.payload as { n: number }).n,
        (request.payload as { margin: Rational }).margin,
        (request.payload as { alpha: Rational }).alpha,
      );
    parentPort?.postMessage({ ok: true, value });
  } catch {
    parentPort?.postMessage({ ok: false });
  }
}
