import type {
  ModelProvider,
  ModelRequest,
  ModelRespondOptions,
  ModelUsage,
  NormalizedModelEvent,
  PreparedModelInvocation,
} from '../model-providers/model-provider.js';

export interface FixedTraceBudgetPricing {
  inputUsdPerMillionTokens: number;
  outputUsdPerMillionTokens: number;
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

interface Reservation {
  readonly usd: number;
  active: boolean;
}

function validatePricing(pricing: FixedTraceBudgetPricing): void {
  if (
    !Number.isFinite(pricing.inputUsdPerMillionTokens)
    || pricing.inputUsdPerMillionTokens < 0
    || !Number.isFinite(pricing.outputUsdPerMillionTokens)
    || pricing.outputUsdPerMillionTokens < 0
    || !pricing.source.trim()
  ) throw new Error('Fixed trace budget pricing is invalid');
}

function requestBytes(prepared: PreparedModelInvocation): number {
  return Buffer.byteLength(JSON.stringify(prepared.providerRequest), 'utf8');
}

function costUsd(
  inputTokens: number,
  outputTokens: number,
  pricing: FixedTraceBudgetPricing,
): number {
  if (
    !Number.isSafeInteger(inputTokens)
    || inputTokens < 0
    || !Number.isSafeInteger(outputTokens)
    || outputTokens < 0
  ) throw new Error('Fixed trace budget usage is invalid');
  return (
    inputTokens * pricing.inputUsdPerMillionTokens
    + outputTokens * pricing.outputUsdPerMillionTokens
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
  ): Reservation {
    validatePricing(pricing);
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
    const usd = costUsd(requestBytes(prepared), maxOutputTokens, pricing);
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
    const actualUsd = costUsd(usage.inputTokens, usage.outputTokens, pricing);
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

  constructor(
    private readonly delegate: ModelProvider,
    private readonly budget: FixedTraceBudget,
    private readonly pricing: FixedTraceBudgetPricing,
  ) {
    validatePricing(pricing);
    this.id = delegate.id;
    this.capabilities = delegate.capabilities;
    if (delegate.deriveProviderToolReceipt) {
      this.deriveProviderToolReceipt = delegate.deriveProviderToolReceipt.bind(delegate);
    }
  }

  prepare(request: ModelRequest): PreparedModelInvocation {
    return this.delegate.prepare(request);
  }

  async *respond(
    request: ModelRequest,
    options: ModelRespondOptions = {},
  ): AsyncIterable<NormalizedModelEvent> {
    let reservation: Reservation | null = null;
    let dispatchStarted = false;
    let settled = false;
    try {
      for await (const event of this.delegate.respond(request, {
        ...options,
        beforeDispatch: async (prepared) => {
          reservation = this.budget.reserve(prepared, request.maxOutputTokens, this.pricing);
          try {
            await options.beforeDispatch?.(prepared);
          } catch (error) {
            this.budget.cancel(reservation);
            reservation = null;
            throw error;
          }
          this.budget.markDispatched(reservation);
          dispatchStarted = true;
        },
      })) {
        if (event.type === 'response_complete') {
          if (!reservation || !dispatchStarted) {
            throw new Error('Fixed trace provider completed without dispatch admission');
          }
          this.budget.complete(reservation, event.response.usage, this.pricing);
          settled = true;
        }
        yield event;
      }
    } finally {
      if (reservation && !settled) {
        if (dispatchStarted) this.budget.markExposureUnknown(reservation);
        else this.budget.cancel(reservation);
      }
    }
  }
}
