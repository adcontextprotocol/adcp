import type {
  ModelProvider,
  ModelRequest,
  ModelResponse,
  ModelRespondOptions,
  ModelUsage,
  NormalizedModelEvent,
  PreparedModelInvocation,
} from '../model-providers/model-provider.js';
import { isDeepStrictEqual } from 'node:util';
import {
  GOOGLE_ROUTER_MODEL,
  isGoogleRouterModelRevision,
} from '../model-providers/google-generate-content-provider.js';
import { resolveKnownClaudePricingModel } from '../claude-pricing.js';
import { GOOGLE_GEMINI_3_7_FLASH_PRICING_VERSION } from '../model-cost-pricing.js';
import {
  datedPricingCostUsd,
  datedPricingProfilesForFixedTrace,
  datedPricingReservationCostUsd,
  pricingProfileForCandidate,
  resolveCurrentEvaluationPricingCohort,
  type EvaluationPricingCandidateId,
} from './dated-pricing-cohort.js';
import type { FixedTraceModelResolutionPolicy } from './fixed-trace-suite.js';
import type {
  FixedTraceSettlementDiagnostic,
  FixedTraceSettlementDiagnosticLedger,
} from './fixed-trace-suite.js';
import { createHash } from 'node:crypto';

export interface FixedTraceBudgetPricing {
  inputUsdPerMillionTokens: number;
  outputUsdPerMillionTokens: number;
  /** Null means this provider does not expose a separately billable cache read rate. */
  cacheReadUsdPerMillionTokens?: number | null;
  /** Null means this provider does not expose a separately billable cache write rate. */
  cacheWriteUsdPerMillionTokens?: number | null;
  /** Cache reads and writes have independently recorded provider semantics. */
  cacheReadAccounting?: 'additive' | 'subset' | 'unsupported';
  cacheWriteAccounting?: 'additive' | 'subset' | 'unsupported';
  source: string;
}

export type FixedTraceBudgetRejectionReason =
  | 'budget_exposure_unknown'
  | 'soft_limit_exceeded';

export class FixedTraceBudgetAdmissionError extends Error {
  readonly terminalStatus = 'not_dispatched_budget' as const;

  constructor(
    readonly reason: FixedTraceBudgetRejectionReason,
    readonly prepared: PreparedModelInvocation,
  ) {
    super(reason);
    this.name = 'FixedTraceBudgetAdmissionError';
  }
}

export interface FixedTraceBudgetSnapshot {
  policy: 'soft_admission_target';
  softMaxUsd: number;
  accountedSpendUsd: number;
  reservedUsd: number;
  remainingUsd: number | null;
  dispatchedCalls: number;
  completedCalls: number;
  budgetRejectedCalls: number;
  admissionClosed: boolean;
  exposureUnknown: boolean;
}

/**
 * An evaluator-owned profile records every value used to admit and settle a
 * fixed-trace stage. Callers can select an entry, but cannot manufacture one
 * by supplying a matching-looking policy object or a zero-rate tuple.
 */
interface FixedTraceApprovedPricing extends FixedTraceBudgetPricing {
  readonly candidateId: EvaluationPricingCandidateId;
  readonly profileId: string;
  readonly expectedProvider: ModelProvider['id'];
  readonly expectedModel: string;
  readonly modelResolutionPolicy: FixedTraceModelResolutionPolicy;
}

export function fixedTraceModelResolutionPolicy(
  provider: ModelProvider['id'],
  model: string,
  allowDatedAnthropicRevision = false,
): FixedTraceModelResolutionPolicy {
  if (allowDatedAnthropicRevision && provider === 'anthropic') return 'anthropic_dated_revision_v1';
  return provider === 'google' && model === GOOGLE_ROUTER_MODEL
    ? 'google_router_dated_revision_v1'
    : 'exact_model_identity_v1';
}

const FIXED_TRACE_APPROVED_PRICING = Object.freeze(datedPricingProfilesForFixedTrace().map((profile) => Object.freeze({
  candidateId: profile.candidateId,
  expectedProvider: profile.provider,
  expectedModel: profile.model,
  profileId: profile.profileId,
  inputUsdPerMillionTokens: profile.inputUsdPerMillionTokens,
  outputUsdPerMillionTokens: profile.outputUsdPerMillionTokens,
  cacheReadUsdPerMillionTokens: profile.cacheReadUsdPerMillionTokens,
  cacheWriteUsdPerMillionTokens: profile.cacheWriteUsdPerMillionTokens,
  cacheReadAccounting: profile.cacheReadAccounting,
  cacheWriteAccounting: profile.cacheWriteAccounting,
  source: profile.source,
  modelResolutionPolicy: profile.provider === 'google'
    ? 'google_router_dated_revision_v1' as const
    : 'exact_model_identity_v1' as const,
} satisfies FixedTraceApprovedPricing)));

/**
 * The complete live approval surface. It is intentionally inspectable for
 * audits, but policy objects remain module-branded and cannot be minted from
 * these descriptive values.
 */
export function fixedTraceApprovedPricingProfiles(): readonly Readonly<{
  expectedProvider: ModelProvider['id'];
  expectedModel: string;
  profileId: string;
  source: string;
}>[] {
  return FIXED_TRACE_APPROVED_PRICING.map((entry) => Object.freeze({
    expectedProvider: entry.expectedProvider,
    expectedModel: entry.expectedModel,
    profileId: entry.profileId,
    source: entry.source,
  }));
}

/** Opaque, module-branded policy produced only from the approved registry. */
export interface FixedTraceResponsePricingPolicy {
  readonly expectedProvider: ModelProvider['id'];
  readonly expectedModel: string;
  readonly pricingProfileId: string;
  readonly modelResolutionPolicy: FixedTraceModelResolutionPolicy;
}

const approvedResponsePricingPolicies = new WeakMap<
  FixedTraceResponsePricingPolicy,
  FixedTraceApprovedPricing
>();

function sameApprovedPricing(
  entry: FixedTraceApprovedPricing,
  pricing: FixedTraceBudgetPricing & { readonly profileId: string },
): boolean {
  return entry.profileId === pricing.profileId
    && entry.inputUsdPerMillionTokens === pricing.inputUsdPerMillionTokens
    && entry.outputUsdPerMillionTokens === pricing.outputUsdPerMillionTokens
    && entry.cacheReadUsdPerMillionTokens === pricing.cacheReadUsdPerMillionTokens
    && entry.cacheWriteUsdPerMillionTokens === pricing.cacheWriteUsdPerMillionTokens
    && entry.cacheReadAccounting === pricing.cacheReadAccounting
    && entry.cacheWriteAccounting === pricing.cacheWriteAccounting
    && entry.source === pricing.source;
}

function approvedResponsePricing(
  policy: FixedTraceResponsePricingPolicy,
): FixedTraceApprovedPricing {
  const approved = approvedResponsePricingPolicies.get(policy);
  if (!approved) throw new Error('Fixed trace returned-model pricing policy is not evaluator approved');
  return approved;
}

export function fixedTraceResponsePricingPolicy(
  expectedProvider: ModelProvider['id'],
  expectedModel: string,
  pricing: FixedTraceBudgetPricing & { readonly profileId: string },
): FixedTraceResponsePricingPolicy {
  return fixedTraceResponsePricingPolicyForResolution(
    expectedProvider,
    expectedModel,
    pricing,
    fixedTraceModelResolutionPolicy(expectedProvider, expectedModel),
  );
}

/** The only policy constructor that permits dated Anthropic full-suite receipts. */
export function fixedTraceDirectFullSuiteResponsePricingPolicy(
  expectedProvider: ModelProvider['id'],
  expectedModel: string,
  pricing: FixedTraceBudgetPricing & { readonly profileId: string },
): FixedTraceResponsePricingPolicy {
  return fixedTraceResponsePricingPolicyForResolution(
    expectedProvider,
    expectedModel,
    pricing,
    fixedTraceModelResolutionPolicy(expectedProvider, expectedModel, true),
  );
}

function fixedTraceResponsePricingPolicyForResolution(
  expectedProvider: ModelProvider['id'],
  expectedModel: string,
  pricing: FixedTraceBudgetPricing & { readonly profileId: string },
  modelResolutionPolicy: FixedTraceModelResolutionPolicy,
): FixedTraceResponsePricingPolicy {
  const approved = FIXED_TRACE_APPROVED_PRICING.find((entry) => (
    entry.expectedProvider === expectedProvider
    && entry.expectedModel === expectedModel
    && entry.modelResolutionPolicy === fixedTraceModelResolutionPolicy(expectedProvider, expectedModel)
    && sameApprovedPricing(entry, pricing)
  ));
  if (!approved) throw new Error('Fixed trace pricing profile is not evaluator approved');
  const currentCohort = resolveCurrentEvaluationPricingCohort(new Date(), [approved.candidateId]);
  if (currentCohort.status !== 'available') {
    throw new Error('Fixed trace pricing profile is not currently effective');
  }
  const current = pricingProfileForCandidate(currentCohort.cohort, approved.candidateId);
  if (current.profileId !== approved.profileId || !sameApprovedPricing(approved, current)) {
    throw new Error('Fixed trace pricing profile does not match the current cohort');
  }
  const policy = Object.freeze({
    expectedProvider: approved.expectedProvider,
    expectedModel: approved.expectedModel,
    pricingProfileId: approved.profileId,
    modelResolutionPolicy,
  });
  approvedResponsePricingPolicies.set(policy, approved);
  return policy;
}

export function fixedTraceResponseUsesPricingPolicy(
  policy: FixedTraceResponsePricingPolicy,
  response: Pick<ModelResponse, 'provider' | 'model'>,
): boolean {
  const approved = approvedResponsePricing(policy);
  if (response.provider !== policy.expectedProvider) return false;
  if (response.model === policy.expectedModel) return true;
  if (policy.modelResolutionPolicy === 'anthropic_dated_revision_v1' && response.provider === 'anthropic') {
    return resolveKnownClaudePricingModel(response.model) === policy.expectedModel;
  }
  return policy.modelResolutionPolicy === 'google_router_dated_revision_v1'
    && approved.profileId === GOOGLE_GEMINI_3_7_FLASH_PRICING_VERSION
    && isGoogleRouterModelRevision(response.model);
}

interface Reservation {
  readonly usd: number;
  active: boolean;
  /** Set only when an exclusive diagnostic pre-reserved the whole run. */
  readonly wholeRun: WholeRunReservation | null;
}

interface WholeRunReservation {
  readonly usd: number;
  remainingUsd: number;
  active: boolean;
}

interface BudgetedProviderBinding {
  readonly budget: FixedTraceBudget;
  readonly pricing: FixedTraceBudgetPricing & { readonly profileId: string };
  readonly responsePricingPolicy: FixedTraceResponsePricingPolicy;
  readonly delegate: BudgetedDelegateIdentity;
  lease: object | null;
  dispatchSequence: number;
  settlementDiagnostics: FixedTraceSettlementDiagnostic[];
}

interface BudgetedDelegateIdentity {
  readonly delegate: ModelProvider;
  readonly id: ModelProvider['id'];
  readonly capabilities: ModelProvider['capabilities'];
  readonly prepare: ModelProvider['prepare'];
  readonly respond: ModelProvider['respond'];
  readonly snapshotResponse?: ModelProvider['snapshotResponse'];
  readonly deriveProviderToolReceipt?: ModelProvider['deriveProviderToolReceipt'];
}

// This is deliberately not an instance field or a public predicate. The
// diagnostic artifact accepts only the exact wrapper that owns this private
// binding; a subclass must not be able to claim ledger ownership while
// replacing the dispatch path.
const budgetedProviderBindings = new WeakMap<object, BudgetedProviderBinding>();
const exclusiveBudgetLeases = new WeakMap<FixedTraceBudget, object>();
const exclusiveCloneIdentities = new WeakMap<object, BudgetedDelegateIdentity>();
const FIXED_TRACE_SETTLEMENT_DIAGNOSTIC_LIMIT = 8;
const FIXED_TRACE_SETTLEMENT_FINGERPRINT_DOMAIN = 'adcp:addie:fixed-trace:settlement-diagnostic:v1\0';

function settlementErrorFingerprint(
  reason: FixedTraceSettlementDiagnostic['reason'],
): string {
  // A diagnostic artifact can be retained beyond the local execution logs.
  // Fingerprint only our closed category, never provider-owned error text.
  return createHash('sha256')
    .update(FIXED_TRACE_SETTLEMENT_FINGERPRINT_DOMAIN, 'utf8')
    .update(reason, 'utf8')
    .digest('hex');
}

function recordSettlementDiagnostic(
  provider: object,
  dispatchSequence: number,
  reason: FixedTraceSettlementDiagnostic['reason'],
): void {
  const binding = budgetedProviderBindings.get(provider);
  if (!binding) throw new Error('Fixed trace budget wrapper binding is unavailable');
  binding.settlementDiagnostics.push(Object.freeze({
    dispatchSequence,
    status: 'exposure_unknown',
    reason,
    errorFingerprintSha256: settlementErrorFingerprint(reason),
  }));
  if (binding.settlementDiagnostics.length > FIXED_TRACE_SETTLEMENT_DIAGNOSTIC_LIMIT) {
    binding.settlementDiagnostics.splice(0, binding.settlementDiagnostics.length - FIXED_TRACE_SETTLEMENT_DIAGNOSTIC_LIMIT);
  }
}

/**
 * Capture an opaque cursor before entering a provider stage. It is meaningful
 * only for the frozen budget wrapper; ordinary providers deliberately report
 * an empty ledger so the runner remains usable in local-only tests.
 */
export function fixedTraceSettlementDiagnosticCursor(provider: ModelProvider): number {
  return budgetedProviderBindings.get(provider)?.dispatchSequence ?? 0;
}

/** Return the bounded, redacted settlement receipts emitted after `cursor`. */
export function fixedTraceSettlementDiagnosticLedger(
  provider: ModelProvider,
  cursor: number,
): FixedTraceSettlementDiagnosticLedger {
  if (!Number.isSafeInteger(cursor) || cursor < 0) {
    throw new RangeError('Fixed trace settlement diagnostic cursor is invalid');
  }
  const binding = budgetedProviderBindings.get(provider);
  if (!binding) return Object.freeze({
    fromDispatchExclusive: cursor,
    throughDispatch: cursor,
    truncated: false,
    entries: Object.freeze([]),
  });
  const oldestRetained = binding.settlementDiagnostics[0]?.dispatchSequence;
  return Object.freeze({
    fromDispatchExclusive: cursor,
    throughDispatch: binding.dispatchSequence,
    truncated: oldestRetained !== undefined && cursor < oldestRetained - 1,
    entries: Object.freeze(binding.settlementDiagnostics
      .filter((entry) => entry.dispatchSequence > cursor)
      .map((entry) => Object.freeze({ ...entry }))),
  });
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function snapshotPricing<T extends FixedTraceBudgetPricing>(pricing: T): T {
  return Object.freeze({ ...pricing }) as T;
}

function snapshotDelegateIdentity(delegate: ModelProvider): BudgetedDelegateIdentity {
  // Read all mutable delegate surface once. Lease cloning reuses this sealed
  // identity rather than re-reading a delegate getter after preflight.
  const id = delegate.id;
  const capabilities = deepFreeze(structuredClone(delegate.capabilities)) as ModelProvider['capabilities'];
  const prepare = delegate.prepare;
  const respond = delegate.respond;
  const snapshotResponse = delegate.snapshotResponse;
  const deriveProviderToolReceipt = delegate.deriveProviderToolReceipt;
  if (typeof id !== 'string' || !id.trim() || typeof prepare !== 'function' || typeof respond !== 'function') {
    throw new Error('Fixed trace budget delegate identity is invalid');
  }
  return Object.freeze({
    delegate,
    id,
    capabilities,
    prepare: prepare.bind(delegate),
    respond: respond.bind(delegate),
    snapshotResponse: snapshotResponse?.bind(delegate),
    deriveProviderToolReceipt: deriveProviderToolReceipt?.bind(delegate),
  });
}

function samePricing(left: FixedTraceBudgetPricing, right: FixedTraceBudgetPricing): boolean {
  return left.inputUsdPerMillionTokens === right.inputUsdPerMillionTokens
    && left.outputUsdPerMillionTokens === right.outputUsdPerMillionTokens
    && left.cacheReadUsdPerMillionTokens === right.cacheReadUsdPerMillionTokens
    && left.cacheWriteUsdPerMillionTokens === right.cacheWriteUsdPerMillionTokens
    && left.cacheReadAccounting === right.cacheReadAccounting
    && left.cacheWriteAccounting === right.cacheWriteAccounting
    && left.source === right.source;
}

function sameResponsePricingPolicy(
  left: FixedTraceResponsePricingPolicy,
  right: FixedTraceResponsePricingPolicy,
): boolean {
  return left.expectedProvider === right.expectedProvider
    && left.expectedModel === right.expectedModel
    && left.pricingProfileId === right.pricingProfileId
    && left.modelResolutionPolicy === right.modelResolutionPolicy;
}

export function validateFixedTracePricing(pricing: FixedTraceBudgetPricing): void {
  if (
    !Number.isFinite(pricing.inputUsdPerMillionTokens)
    || pricing.inputUsdPerMillionTokens < 0
    || !Number.isFinite(pricing.outputUsdPerMillionTokens)
    || pricing.outputUsdPerMillionTokens < 0
    || !pricing.source.trim()
  ) throw new Error('Fixed trace budget pricing is invalid');
  for (const rate of [pricing.cacheReadUsdPerMillionTokens, pricing.cacheWriteUsdPerMillionTokens]) {
    if (rate !== undefined && rate !== null && (!Number.isFinite(rate) || rate < 0)) {
      throw new Error('Fixed trace cache pricing is invalid');
    }
  }
}

function requestBytes(prepared: PreparedModelInvocation): number {
  return Buffer.byteLength(JSON.stringify(prepared.providerRequest), 'utf8');
}

/**
 * Cache usage is provider-profiled: Anthropic reports additive cache buckets,
 * while some providers report buckets contained in input. Unknown semantics
 * fail closed instead of applying a provider-specific subtraction globally.
 */
export function fixedTraceEstimatedCostUsd(
  usage: ModelUsage,
  pricing: FixedTraceBudgetPricing,
): number {
  validateFixedTracePricing(pricing);
  try {
    return datedPricingCostUsd(pricing, usage);
  } catch (error) {
    // Keep fixed-trace's established error contract while delegating the
    // category arithmetic itself to the dated-profile accounting model.
    const message = error instanceof Error ? error.message : '';
    if (message === 'Invalid input token count' || message === 'Invalid output token count') {
      throw new Error('Fixed trace budget usage is invalid');
    }
    if (message === 'Invalid cache-read token count' || message === 'Invalid cache-write token count') {
      throw new Error('Fixed trace cache usage is invalid');
    }
    if (message === 'Cache-read pricing is unavailable') throw new Error('Fixed trace cache read accounting is unavailable');
    if (message === 'Cache-write pricing is unavailable') throw new Error('Fixed trace cache write accounting is unavailable');
    if (message.startsWith('Subset cache-')) throw new Error('Fixed trace subset cache usage is invalid');
    throw error;
  }
}

/**
 * Shared, serial admission state for a live fixed-trace run.
 *
 * Input bytes are used as a conservative token upper bound and the full output
 * allowance is reserved before dispatch. A dispatched call without terminal
 * usage makes total exposure unknowable, so every later call is refused.
 */
export class FixedTraceBudget {
  private accountedSpendUsd = 0;
  private reservedUsd = 0;
  private dispatchedCalls = 0;
  private completedCalls = 0;
  private budgetRejectedCalls = 0;
  private admissionClosed = false;
  private exposureUnknown = false;
  private wholeRunReservation: WholeRunReservation | null = null;

  constructor(readonly softMaxUsd: number) {
    if (!Number.isFinite(softMaxUsd) || softMaxUsd <= 0) {
      throw new RangeError('Fixed trace soft budget must be positive');
    }
  }

  reserve(
    prepared: PreparedModelInvocation,
    maxOutputTokens: number,
    pricing: FixedTraceBudgetPricing,
    lease?: object,
  ): Reservation {
    validateFixedTracePricing(pricing);
    const exclusiveLease = exclusiveBudgetLeases.get(this);
    if (exclusiveLease !== undefined && lease !== exclusiveLease) {
      throw new Error('Fixed trace budget is reserved for an exclusive diagnostic run');
    }
    if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1) {
      throw new RangeError('Fixed trace output reserve must be a positive integer');
    }
    if (this.exposureUnknown) {
      this.budgetRejectedCalls++;
      throw new FixedTraceBudgetAdmissionError('budget_exposure_unknown', prepared);
    }
    if (this.admissionClosed) {
      this.budgetRejectedCalls++;
      throw new FixedTraceBudgetAdmissionError('soft_limit_exceeded', prepared);
    }
    // Request bytes are a deliberately high token bound for the request.
    // The common dated-pricing helper includes every additive bucket and the
    // highest-cost mutually-exclusive subset bucket (including an OpenAI
    // cache write whose replacement rate exceeds ordinary input).
    const inputTokens = requestBytes(prepared);
    const usd = datedPricingReservationCostUsd(pricing, inputTokens, maxOutputTokens);
    const wholeRun = this.wholeRunReservation;
    if (wholeRun !== null) {
      if (!wholeRun.active || usd - wholeRun.remainingUsd > Number.EPSILON * Math.max(1, wholeRun.usd)) {
        this.admissionClosed = true;
        this.budgetRejectedCalls++;
        throw new FixedTraceBudgetAdmissionError('soft_limit_exceeded', prepared);
      }
      // The complete diagnostic was admitted before its selector/output were
      // consumed. Individual calls consume that escrow rather than reserving
      // it again, so a fully admitted run cannot self-reject mid-cell.
      wholeRun.remainingUsd = Math.max(0, wholeRun.remainingUsd - usd);
      return { usd, active: true, wholeRun };
    }
    if (this.accountedSpendUsd + this.reservedUsd + usd > this.softMaxUsd) {
      this.admissionClosed = true;
      this.budgetRejectedCalls++;
      throw new FixedTraceBudgetAdmissionError('soft_limit_exceeded', prepared);
    }
    this.reservedUsd += usd;
    return { usd, active: true, wholeRun: null };
  }

  markDispatched(reservation: Reservation): void {
    this.requireActive(reservation);
    this.dispatchedCalls++;
  }

  complete(
    reservation: Reservation,
    usage: ModelUsage,
    pricing: FixedTraceBudgetPricing,
  ): void {
    const actualUsd = fixedTraceEstimatedCostUsd(usage, pricing);
    this.settle(reservation);
    this.accountedSpendUsd += actualUsd;
    this.completedCalls++;
  }

  cancel(reservation: Reservation): void {
    this.requireActive(reservation);
    reservation.active = false;
    if (reservation.wholeRun !== null) {
      reservation.wholeRun.remainingUsd += reservation.usd;
    } else {
      this.reservedUsd = Math.max(0, this.reservedUsd - reservation.usd);
    }
  }

  markExposureUnknown(reservation: Reservation): void {
    this.settle(reservation);
    this.exposureUnknown = true;
  }

  snapshot(): FixedTraceBudgetSnapshot {
    return Object.freeze({
      policy: 'soft_admission_target',
      softMaxUsd: this.softMaxUsd,
      accountedSpendUsd: this.accountedSpendUsd,
      reservedUsd: this.reservedUsd,
      remainingUsd: this.exposureUnknown
        ? null
        : Math.max(0, this.softMaxUsd - this.accountedSpendUsd - this.reservedUsd),
      dispatchedCalls: this.dispatchedCalls,
      completedCalls: this.completedCalls,
      budgetRejectedCalls: this.budgetRejectedCalls,
      admissionClosed: this.admissionClosed,
      exposureUnknown: this.exposureUnknown,
    });
  }

  /** Reserve the exact reviewed ceiling for one exclusive diagnostic run. */
  claimWholeRunReservation(usd: number): WholeRunReservation {
    if (!Number.isFinite(usd) || usd <= 0) {
      throw new RangeError('Fixed trace whole-run reservation must be positive');
    }
    if (this.wholeRunReservation !== null || this.accountedSpendUsd + this.reservedUsd + usd > this.softMaxUsd) {
      throw new RangeError('Fixed trace soft budget is below the required whole-run reservation');
    }
    const reservation: WholeRunReservation = { usd, remainingUsd: usd, active: true };
    this.wholeRunReservation = reservation;
    this.reservedUsd += usd;
    return reservation;
  }

  releaseWholeRunReservation(reservation: WholeRunReservation): void {
    if (this.wholeRunReservation !== reservation || !reservation.active) {
      throw new Error('Fixed trace whole-run reservation is inactive');
    }
    reservation.active = false;
    this.reservedUsd = Math.max(0, this.reservedUsd - reservation.remainingUsd);
    reservation.remainingUsd = 0;
  }

  private requireActive(reservation: Reservation): void {
    if (!reservation.active) throw new Error('Fixed trace budget reservation is inactive');
  }

  private settle(reservation: Reservation): void {
    this.requireActive(reservation);
    reservation.active = false;
    this.reservedUsd = Math.max(0, this.reservedUsd - reservation.usd);
  }
}

/** Model-provider decorator that applies a shared budget at the dispatch edge. */
export class BudgetedFixedTraceProvider implements ModelProvider {
  readonly id: ModelProvider['id'];
  readonly capabilities: ModelProvider['capabilities'];
  readonly snapshotResponse?: ModelProvider['snapshotResponse'];
  readonly deriveProviderToolReceipt?: ModelProvider['deriveProviderToolReceipt'];

  readonly #delegate: BudgetedDelegateIdentity;
  readonly #budget: FixedTraceBudget;
  readonly #pricing: FixedTraceBudgetPricing & { readonly profileId: string };
  readonly #responsePricingPolicy: FixedTraceResponsePricingPolicy;

  constructor(
    delegate: ModelProvider,
    budget: FixedTraceBudget,
    pricing: FixedTraceBudgetPricing & { readonly profileId: string },
    responsePricingPolicy: FixedTraceResponsePricingPolicy,
    cloneIdentityToken?: object,
  ) {
    const approvedPricing = approvedResponsePricing(responsePricingPolicy);
    if (!sameApprovedPricing(approvedPricing, pricing)) {
      throw new Error('Fixed trace budget pricing does not match its evaluator-approved policy');
    }
    const clonedIdentity = cloneIdentityToken === undefined
      ? undefined
      : exclusiveCloneIdentities.get(cloneIdentityToken);
    if (cloneIdentityToken !== undefined && !clonedIdentity) {
      throw new Error('Fixed trace budget clone identity is unavailable');
    }
    const delegateIdentity = clonedIdentity ?? snapshotDelegateIdentity(delegate);
    if (delegateIdentity.id !== responsePricingPolicy.expectedProvider) {
      throw new Error('Fixed trace budget delegate identity does not match its pricing policy');
    }
    this.#delegate = delegateIdentity;
    this.#budget = budget;
    this.#pricing = snapshotPricing(approvedPricing);
    this.#responsePricingPolicy = responsePricingPolicy;
    this.id = delegateIdentity.id;
    this.capabilities = delegateIdentity.capabilities;
    if (delegateIdentity.snapshotResponse) {
      this.snapshotResponse = delegateIdentity.snapshotResponse;
    }
    if (delegateIdentity.deriveProviderToolReceipt) {
      this.deriveProviderToolReceipt = delegateIdentity.deriveProviderToolReceipt;
    }
    budgetedProviderBindings.set(this, {
      budget,
      pricing: this.#pricing,
      responsePricingPolicy: this.#responsePricingPolicy,
      delegate: delegateIdentity,
      lease: null,
      dispatchSequence: 0,
      settlementDiagnostics: [],
    });
    // A diagnostic run retains these exact wrapper objects by reference. Lock
    // their own properties now, before untrusted provider code can resume.
    Object.freeze(this);
  }

  prepare(request: ModelRequest): PreparedModelInvocation {
    this.assertRequestIdentity(request);
    const prepared = this.#delegate.prepare(request);
    this.assertPreparedIdentity(prepared);
    return prepared;
  }

  async *respond(
    request: ModelRequest,
    options: ModelRespondOptions = {},
  ): AsyncIterable<NormalizedModelEvent> {
    this.assertRequestIdentity(request);
    const lease = budgetedProviderBindings.get(this)?.lease;
    let reservation: Reservation | null = null;
    let dispatchStarted = false;
    let settled = false;
    let dispatchSequence: number | null = null;
    let interruptedReason: FixedTraceSettlementDiagnostic['reason'] = 'response_stream_interrupted';
    try {
      for await (const event of this.#delegate.respond(request, {
        ...options,
        beforeDispatch: async (prepared) => {
          this.assertPreparedIdentity(prepared);
          reservation = this.#budget.reserve(prepared, request.maxOutputTokens, this.#pricing, lease ?? undefined);
          try {
            await options.beforeDispatch?.(prepared);
          } catch (error) {
            this.#budget.cancel(reservation);
            reservation = null;
            throw error;
          }
          this.#budget.markDispatched(reservation);
          dispatchStarted = true;
          const binding = budgetedProviderBindings.get(this);
          if (!binding) throw new Error('Fixed trace budget wrapper binding is unavailable');
          dispatchSequence = ++binding.dispatchSequence;
        },
      })) {
        if (event.type === 'response_complete') {
          if (!reservation || !dispatchStarted) {
            throw new Error('Fixed trace provider completed without dispatch admission');
          }
          // The delegate still owns `event.response` and may mutate it when
          // the iterator resumes after this yield. An adapter may preserve
          // opaque same-provider continuation state while snapshotting, but
          // it may not alter the canonical response it supplied.
          // Capture the canonical value before invoking an adapter hook. The
          // hook is permitted to transfer opaque continuation state into its
          // own clone, never to mutate the delegate-owned response or change
          // the usage that is settled below.
          const canonicalResponse = structuredClone(event.response);
          const snapshot = this.#delegate.snapshotResponse
            ? this.#delegate.snapshotResponse(event.response)
            : structuredClone(event.response);
          if (!isDeepStrictEqual(snapshot, canonicalResponse)) {
            interruptedReason = 'response_processing_failed';
            throw new Error('Fixed trace provider response snapshot differs from its terminal response');
          }
          const response = deepFreeze(snapshot);
          if (fixedTraceResponseUsesPricingPolicy(this.#responsePricingPolicy, response)) {
            try {
              this.#budget.complete(reservation, response.usage, this.#pricing);
            } catch {
              // Preserve the frozen returned provider/model for downstream
              // evidence while closing admission: a malformed or absent usage
              // block means this dispatch cannot be settled at any rate.
              this.#budget.markExposureUnknown(reservation);
              recordSettlementDiagnostic(this, dispatchSequence!, 'usage_or_cost_settlement_failed');
            }
          } else {
            // Do not settle an unapproved returned identity at the requested
            // model's rate. The response remains visible to the runner, which
            // records unknown cost and fails its stage contract; the shared
            // ledger closes before any subsequent provider call.
            this.#budget.markExposureUnknown(reservation);
            recordSettlementDiagnostic(this, dispatchSequence!, 'identity_policy_rejected');
          }
          settled = true;
          yield { type: 'response_complete', response };
          continue;
        }
        yield event;
      }
    } finally {
      if (reservation && !settled) {
        if (dispatchStarted) {
          this.#budget.markExposureUnknown(reservation);
          recordSettlementDiagnostic(this, dispatchSequence!, interruptedReason);
        }
        else this.#budget.cancel(reservation);
      }
    }
  }

  private assertRequestIdentity(request: ModelRequest): void {
    if (request.model !== this.#responsePricingPolicy.expectedModel) {
      throw new Error('Fixed trace budget request model does not match its pricing policy');
    }
  }

  private assertPreparedIdentity(prepared: PreparedModelInvocation): void {
    if (
      prepared.provider !== this.id
      || prepared.model !== this.#responsePricingPolicy.expectedModel
    ) throw new Error('Fixed trace budget prepared invocation identity does not match its pricing policy');
  }

  static cloneForExclusiveDiagnosticRun(
    source: BudgetedFixedTraceProvider,
    lease: object,
  ): BudgetedFixedTraceProvider {
    const binding = budgetedProviderBindings.get(source);
    if (!binding) throw new Error('Fixed trace budget wrapper binding is unavailable');
    const cloneIdentityToken = Object.freeze({});
    exclusiveCloneIdentities.set(cloneIdentityToken, binding.delegate);
    let clone: BudgetedFixedTraceProvider;
    try {
      clone = new BudgetedFixedTraceProvider(
        binding.delegate.delegate,
        binding.budget,
        binding.pricing,
        binding.responsePricingPolicy,
        cloneIdentityToken,
      );
    } finally {
      exclusiveCloneIdentities.delete(cloneIdentityToken);
    }
    const cloneBinding = budgetedProviderBindings.get(clone);
    if (!cloneBinding) throw new Error('Fixed trace budget wrapper binding is unavailable');
    cloneBinding.lease = lease;
    return clone;
  }
}

const budgetedFixedTraceProviderPrepare = BudgetedFixedTraceProvider.prototype.prepare;
const budgetedFixedTraceProviderRespond = BudgetedFixedTraceProvider.prototype.respond;
Object.freeze(BudgetedFixedTraceProvider.prototype);
Object.freeze(BudgetedFixedTraceProvider);

/**
 * Authenticate the non-overridable ledger wrapper used by diagnostics.
 * `instanceof` and public binding predicates are intentionally insufficient:
 * subclasses can replace `respond` and bypass settlement.
 */
export function isTrustedBudgetedFixedTraceProvider(
  provider: ModelProvider,
  budget: FixedTraceBudget,
  pricing: FixedTraceBudgetPricing & { readonly profileId: string },
  responsePricingPolicy: FixedTraceResponsePricingPolicy,
): boolean {
  const binding = budgetedProviderBindings.get(provider);
  if (
    binding?.budget !== budget
    || !samePricing(binding.pricing, pricing)
    || !sameResponsePricingPolicy(binding.responsePricingPolicy, responsePricingPolicy)
  ) return false;
  if (Object.getPrototypeOf(provider) !== BudgetedFixedTraceProvider.prototype) return false;
  if ((provider as unknown as { constructor: unknown }).constructor !== BudgetedFixedTraceProvider) return false;
  return Object.isFrozen(provider)
    && provider.prepare === budgetedFixedTraceProviderPrepare
    && provider.respond === budgetedFixedTraceProviderRespond;
}

export interface FixedTraceBudgetDiagnosticLease {
  providerFor(provider: ModelProvider): BudgetedFixedTraceProvider;
  /** Return unspent whole-run escrow after every admitted call has settled. */
  releaseWholeRunReservation(): void;
}

/**
 * Claim an unused ledger for one diagnostic artifact and replace caller-held
 * wrappers with private, frozen per-run clones. This makes the ledger's call
 * counts exclusive to the artifact even when a caller retains the original
 * wrapper or budget reference.
 */
export function claimFixedTraceBudgetDiagnosticLease(
  budget: FixedTraceBudget,
  providers: readonly ModelProvider[],
  verifyClones?: (lease: FixedTraceBudgetDiagnosticLease) => void,
  wholeRunReservationUsd?: number,
): FixedTraceBudgetDiagnosticLease {
  const snapshot = budget.snapshot();
  if (
    snapshot.accountedSpendUsd !== 0
    || snapshot.reservedUsd !== 0
    || snapshot.dispatchedCalls !== 0
    || snapshot.completedCalls !== 0
    || snapshot.budgetRejectedCalls !== 0
    || snapshot.admissionClosed
    || snapshot.exposureUnknown
    || exclusiveBudgetLeases.has(budget)
  ) throw new Error('Fixed trace diagnostic budget must be pristine and exclusively claimed');

  const lease = Object.freeze({});
  const clones = new Map<ModelProvider, BudgetedFixedTraceProvider>();
  for (const provider of providers) {
    if (clones.has(provider)) continue;
    const binding = budgetedProviderBindings.get(provider);
    if (!binding || !isTrustedBudgetedFixedTraceProvider(
      provider,
      budget,
      binding.pricing,
      binding.responsePricingPolicy,
    )) {
      throw new Error('Fixed trace diagnostic provider is not an authenticated budget wrapper');
    }
    clones.set(provider, BudgetedFixedTraceProvider.cloneForExclusiveDiagnosticRun(
      provider as BudgetedFixedTraceProvider,
      lease,
    ));
  }
  let wholeRunReservation: WholeRunReservation | null = null;
  const diagnosticLease = Object.freeze({
    providerFor(provider: ModelProvider): BudgetedFixedTraceProvider {
      const clone = clones.get(provider);
      if (!clone) throw new Error('Fixed trace diagnostic provider is missing from its exclusive lease');
      return clone;
    },
    releaseWholeRunReservation(): void {
      if (wholeRunReservation !== null) {
        budget.releaseWholeRunReservation(wholeRunReservation);
        wholeRunReservation = null;
      }
    },
  });
  for (const [source, clone] of clones) {
    const sourceBinding = budgetedProviderBindings.get(source);
    const cloneBinding = budgetedProviderBindings.get(clone);
    if (
      !sourceBinding
      || !cloneBinding
      || cloneBinding.delegate !== sourceBinding.delegate
      || !isTrustedBudgetedFixedTraceProvider(
        clone,
        budget,
        sourceBinding.pricing,
        sourceBinding.responsePricingPolicy,
      )
    ) throw new Error('Fixed trace diagnostic clone identity is not authenticated');
  }
  // Diagnostic plans can additionally validate their cloned stages here. The
  // callback has no asynchronous boundary and runs before the lease becomes
  // visible to the shared ledger.
  verifyClones?.(diagnosticLease);
  if (wholeRunReservationUsd !== undefined) {
    wholeRunReservation = budget.claimWholeRunReservation(wholeRunReservationUsd);
  }
  // Cloning has no asynchronous boundary. Complete it before publishing the
  // lease so a malformed wrapper cannot leave an otherwise pristine ledger
  // permanently claimed.
  exclusiveBudgetLeases.set(budget, lease);
  return diagnosticLease;
}
