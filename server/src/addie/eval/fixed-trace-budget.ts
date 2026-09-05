import type {
  ModelProvider,
  ModelRequest,
  ModelResponse,
  ModelRespondOptions,
  ModelUsage,
  NormalizedModelEvent,
  PreparedModelInvocation,
} from '../model-providers/model-provider.js';
import {
  GOOGLE_ROUTER_MODEL,
  isGoogleRouterModelRevision,
} from '../model-providers/google-generate-content-provider.js';
import { GOOGLE_GEMINI_3_7_FLASH_PRICING_VERSION } from '../model-cost-pricing.js';
import type { FixedTraceModelResolutionPolicy } from './fixed-trace-suite.js';

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
 * The caller supplies the stage's closed returned-model policy. A missing
 * policy fails closed: a completed response may be observed, but its cost is
 * not settled at a requested-model rate and no later dispatch is admitted.
 */
/**
 * Immutable, closed returned-model policy for a budgeted stage. This is data,
 * rather than a caller-provided predicate, so a stage cannot authorize a
 * returned model that its recorded control does not price.
 */
export interface FixedTraceResponsePricingPolicy {
  readonly expectedProvider: ModelProvider['id'];
  readonly expectedModel: string;
  readonly pricingProfileId: string;
  readonly modelResolutionPolicy: FixedTraceModelResolutionPolicy;
}

export function fixedTraceModelResolutionPolicy(
  provider: ModelProvider['id'],
  model: string,
): FixedTraceModelResolutionPolicy {
  return provider === 'google' && model === GOOGLE_ROUTER_MODEL
    ? 'google_router_dated_revision_v1'
    : 'exact_model_identity_v1';
}

function validateResponsePricingPolicy(policy: FixedTraceResponsePricingPolicy): void {
  if (
    !policy
    || typeof policy.expectedProvider !== 'string'
    || !policy.expectedProvider.trim()
    || typeof policy.expectedModel !== 'string'
    || !policy.expectedModel.trim()
    || typeof policy.pricingProfileId !== 'string'
    || !policy.pricingProfileId.trim()
    || !['exact_model_identity_v1', 'google_router_dated_revision_v1'].includes(policy.modelResolutionPolicy)
    || policy.modelResolutionPolicy !== fixedTraceModelResolutionPolicy(policy.expectedProvider, policy.expectedModel)
  ) throw new Error('Fixed trace returned-model pricing policy is invalid');
}

export function fixedTraceResponsePricingPolicy(
  expectedProvider: ModelProvider['id'],
  expectedModel: string,
  pricingProfileId: string,
): FixedTraceResponsePricingPolicy {
  const policy = Object.freeze({
    expectedProvider,
    expectedModel,
    pricingProfileId,
    modelResolutionPolicy: fixedTraceModelResolutionPolicy(expectedProvider, expectedModel),
  });
  validateResponsePricingPolicy(policy);
  return policy;
}

export function fixedTraceResponseUsesPricingPolicy(
  policy: FixedTraceResponsePricingPolicy,
  response: ModelResponse,
): boolean {
  if (response.provider !== policy.expectedProvider) return false;
  if (response.model === policy.expectedModel) return true;
  return policy.modelResolutionPolicy === 'google_router_dated_revision_v1'
    && policy.pricingProfileId === GOOGLE_GEMINI_3_7_FLASH_PRICING_VERSION
    && isGoogleRouterModelRevision(response.model);
}

interface Reservation {
  readonly usd: number;
  active: boolean;
}

interface BudgetedProviderBinding {
  readonly budget: FixedTraceBudget;
  readonly pricing: FixedTraceBudgetPricing;
  readonly responsePricingPolicy: FixedTraceResponsePricingPolicy;
  lease: object | null;
}

// This is deliberately not an instance field or a public predicate. The
// diagnostic artifact accepts only the exact wrapper that owns this private
// binding; a subclass must not be able to claim ledger ownership while
// replacing the dispatch path.
const budgetedProviderBindings = new WeakMap<object, BudgetedProviderBinding>();
const exclusiveBudgetLeases = new WeakMap<FixedTraceBudget, object>();

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function snapshotPricing(pricing: FixedTraceBudgetPricing): FixedTraceBudgetPricing {
  return Object.freeze({ ...pricing });
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
  const { inputTokens, outputTokens } = usage;
  if (
    !Number.isSafeInteger(inputTokens)
    || inputTokens < 0
    || !Number.isSafeInteger(outputTokens)
    || outputTokens < 0
  ) throw new Error('Fixed trace budget usage is invalid');
  const cacheReadTokens = usage.cacheReadTokens ?? 0;
  const cacheWriteTokens = usage.cacheWriteTokens ?? 0;
  if (
    !Number.isSafeInteger(cacheReadTokens) || cacheReadTokens < 0
    || !Number.isSafeInteger(cacheWriteTokens) || cacheWriteTokens < 0
  ) throw new Error('Fixed trace cache usage is invalid');
  const readAccounting = pricing.cacheReadAccounting ?? 'unsupported';
  const writeAccounting = pricing.cacheWriteAccounting ?? 'unsupported';
  if (cacheReadTokens > 0 && readAccounting === 'unsupported') throw new Error('Fixed trace cache read accounting is unavailable');
  if (cacheWriteTokens > 0 && writeAccounting === 'unsupported') throw new Error('Fixed trace cache write accounting is unavailable');
  if (readAccounting === 'subset' && cacheReadTokens > inputTokens) throw new Error('Fixed trace subset cache read usage is invalid');
  // A subset read and additive write (Google's profile) is valid. Two subset
  // buckets must jointly fit the provider's normalized input total.
  if (readAccounting === 'subset' && writeAccounting === 'subset' && cacheReadTokens + cacheWriteTokens > inputTokens) {
    throw new Error('Fixed trace subset cache usage is invalid');
  }
  if (cacheReadTokens > 0 && pricing.cacheReadUsdPerMillionTokens == null) {
    throw new Error('Fixed trace cache read pricing is unavailable');
  }
  if (cacheWriteTokens > 0 && pricing.cacheWriteUsdPerMillionTokens == null) {
    throw new Error('Fixed trace cache write pricing is unavailable');
  }
  return (
    (inputTokens
      - (readAccounting === 'subset' ? cacheReadTokens : 0)
      - (writeAccounting === 'subset' ? cacheWriteTokens : 0)) * pricing.inputUsdPerMillionTokens
    + outputTokens * pricing.outputUsdPerMillionTokens
    + cacheReadTokens * (pricing.cacheReadUsdPerMillionTokens ?? 0)
    + cacheWriteTokens * (pricing.cacheWriteUsdPerMillionTokens ?? 0)
  ) / 1_000_000;
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
    // Request bytes are a deliberately high token bound for the request. An
    // additive cache bucket is separately billable, so reserve that same
    // bound for each such bucket as well. Subset buckets are already covered
    // by inputTokens. This keeps the pre-dispatch reserve conservative under
    // the recorded, fingerprinted cache formula.
    const inputTokens = requestBytes(prepared);
    const usd = fixedTraceEstimatedCostUsd({
      inputTokens,
      outputTokens: maxOutputTokens,
      cacheReadTokens: pricing.cacheReadAccounting === 'additive' ? inputTokens : 0,
      cacheWriteTokens: pricing.cacheWriteAccounting === 'additive' ? inputTokens : 0,
    }, pricing);
    if (this.accountedSpendUsd + this.reservedUsd + usd > this.softMaxUsd) {
      this.admissionClosed = true;
      this.budgetRejectedCalls++;
      throw new FixedTraceBudgetAdmissionError('soft_limit_exceeded', prepared);
    }
    this.reservedUsd += usd;
    return { usd, active: true };
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
    this.release(reservation);
    this.accountedSpendUsd += actualUsd;
    this.completedCalls++;
  }

  cancel(reservation: Reservation): void {
    this.release(reservation);
  }

  markExposureUnknown(reservation: Reservation): void {
    this.release(reservation);
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

  private requireActive(reservation: Reservation): void {
    if (!reservation.active) throw new Error('Fixed trace budget reservation is inactive');
  }

  private release(reservation: Reservation): void {
    this.requireActive(reservation);
    reservation.active = false;
    this.reservedUsd = Math.max(0, this.reservedUsd - reservation.usd);
  }
}

/** Model-provider decorator that applies a shared budget at the dispatch edge. */
export class BudgetedFixedTraceProvider implements ModelProvider {
  readonly id: ModelProvider['id'];
  readonly capabilities: ModelProvider['capabilities'];
  readonly deriveProviderToolReceipt?: ModelProvider['deriveProviderToolReceipt'];

  readonly #delegate: ModelProvider;
  readonly #budget: FixedTraceBudget;
  readonly #pricing: FixedTraceBudgetPricing;
  readonly #responsePricingPolicy: FixedTraceResponsePricingPolicy;

  constructor(
    delegate: ModelProvider,
    budget: FixedTraceBudget,
    pricing: FixedTraceBudgetPricing,
    responsePricingPolicy: FixedTraceResponsePricingPolicy,
  ) {
    validateFixedTracePricing(pricing);
    validateResponsePricingPolicy(responsePricingPolicy);
    this.#delegate = delegate;
    this.#budget = budget;
    this.#pricing = snapshotPricing(pricing);
    this.#responsePricingPolicy = Object.freeze({ ...responsePricingPolicy });
    this.id = delegate.id;
    this.capabilities = delegate.capabilities;
    if (delegate.deriveProviderToolReceipt) {
      this.deriveProviderToolReceipt = delegate.deriveProviderToolReceipt.bind(delegate);
    }
    budgetedProviderBindings.set(this, {
      budget,
      pricing: this.#pricing,
      responsePricingPolicy: this.#responsePricingPolicy,
      lease: null,
    });
    // A diagnostic run retains these exact wrapper objects by reference. Lock
    // their own properties now, before untrusted provider code can resume.
    Object.freeze(this);
  }

  prepare(request: ModelRequest): PreparedModelInvocation {
    return this.#delegate.prepare(request);
  }

  async *respond(
    request: ModelRequest,
    options: ModelRespondOptions = {},
  ): AsyncIterable<NormalizedModelEvent> {
    const lease = budgetedProviderBindings.get(this)?.lease;
    let reservation: Reservation | null = null;
    let dispatchStarted = false;
    let settled = false;
    try {
      for await (const event of this.#delegate.respond(request, {
        ...options,
        beforeDispatch: async (prepared) => {
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
        },
      })) {
        if (event.type === 'response_complete') {
          if (!reservation || !dispatchStarted) {
            throw new Error('Fixed trace provider completed without dispatch admission');
          }
          // The delegate still owns `event.response` and may mutate it when
          // the iterator resumes after this yield. One evaluator-owned frozen
          // snapshot is therefore the sole terminal response used for
          // approval, settlement, and the outward event.
          const response = deepFreeze(structuredClone(event.response));
          if (fixedTraceResponseUsesPricingPolicy(this.#responsePricingPolicy, response)) {
            this.#budget.complete(reservation, response.usage, this.#pricing);
          } else {
            // Do not settle an unapproved returned identity at the requested
            // model's rate. The response remains visible to the runner, which
            // records unknown cost and fails its stage contract; the shared
            // ledger closes before any subsequent provider call.
            this.#budget.markExposureUnknown(reservation);
          }
          settled = true;
          yield { type: 'response_complete', response };
          continue;
        }
        yield event;
      }
    } finally {
      if (reservation && !settled) {
        if (dispatchStarted) this.#budget.markExposureUnknown(reservation);
        else this.#budget.cancel(reservation);
      }
    }
  }

  static cloneForExclusiveDiagnosticRun(
    source: BudgetedFixedTraceProvider,
    lease: object,
  ): BudgetedFixedTraceProvider {
    const clone = new BudgetedFixedTraceProvider(
      source.#delegate,
      source.#budget,
      source.#pricing,
      source.#responsePricingPolicy,
    );
    const binding = budgetedProviderBindings.get(clone);
    if (!binding) throw new Error('Fixed trace budget wrapper binding is unavailable');
    binding.lease = lease;
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
  pricing: FixedTraceBudgetPricing,
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
  // Cloning has no asynchronous boundary. Complete it before publishing the
  // lease so a malformed wrapper cannot leave an otherwise pristine ledger
  // permanently claimed.
  exclusiveBudgetLeases.set(budget, lease);
  return Object.freeze({
    providerFor(provider: ModelProvider): BudgetedFixedTraceProvider {
      const clone = clones.get(provider);
      if (!clone) throw new Error('Fixed trace diagnostic provider is missing from its exclusive lease');
      return clone;
    },
  });
}
