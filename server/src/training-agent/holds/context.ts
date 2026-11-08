/**
 * Request-scoped hold plan, read by the two hooks inside the legacy proposal
 * engine (task-handlers.ts):
 *
 * - the committed successor finalize creates takes the hold deadline the
 *   plan chose (`plannedHoldExpiry`), so the stored snapshot, accept_proposal,
 *   and the response agree on `expires_at`;
 * - a draft created for a 3.3 caller gets a flight that reaches the
 *   installments it buys (`installmentFlightEnd`), so a creator-slot purchase
 *   covers the slots its hold lists.
 *
 * Only holds/service.ts opens a plan, and only for callers it serves holds
 * to, so every other request sees the engine exactly as before.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

interface HoldPlanScope {
  /** Hold deadline per finalized source draft. */
  expiresAtBySource?: ReadonlyMap<string, string>;
  /** Extend new drafts' flights over the installments they allocate. */
  installmentFlights?: boolean;
}

const storage = new AsyncLocalStorage<HoldPlanScope>();

export function runWithHoldPlan<T>(scope: HoldPlanScope, fn: () => Promise<T>): Promise<T> {
  return storage.run(scope, fn);
}

/** The hold deadline the active plan chose for this source draft's successor. */
export function plannedHoldExpiry(sourceProposalId: string): string | undefined {
  return storage.getStore()?.expiresAtBySource?.get(sourceProposalId);
}

interface InstallmentLike {
  scheduled_at?: unknown;
  duration_seconds?: unknown;
  status?: unknown;
}

/**
 * The flight end a new draft takes under an active plan: the default end, or
 * later when an allocated product has upcoming installments after it, so the
 * purchase's flight contains every installment it holds. Undefined outside a
 * plan, so the engine keeps its default.
 */
export function installmentFlightEnd(
  products: ReadonlyArray<{ installments?: unknown } | undefined>,
  defaultEndMs: number,
  nowMs: number = Date.now(),
): number | undefined {
  if (!storage.getStore()?.installmentFlights) return undefined;
  let end = defaultEndMs;
  for (const product of products) {
    const installments = Array.isArray(product?.installments) ? product.installments as InstallmentLike[] : [];
    for (const installment of installments) {
      if (typeof installment.scheduled_at !== 'string') continue;
      if (installment.status === 'aired' || installment.status === 'cancelled') continue;
      const at = Date.parse(installment.scheduled_at);
      if (!Number.isFinite(at) || at <= nowMs) continue;
      const duration = typeof installment.duration_seconds === 'number' ? installment.duration_seconds * 1000 : 0;
      end = Math.max(end, at + duration);
    }
  }
  return end;
}
