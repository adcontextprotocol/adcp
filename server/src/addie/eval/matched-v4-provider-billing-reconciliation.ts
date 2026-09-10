/**
 * Provider-neutral custody for matched-v4 billed-cost reconciliation.
 *
 * This deliberately does not fetch a price page, call a billing API, or turn
 * normalized token counts into a bill. A protected operator obtains the
 * provider's own export outside the evaluator, then this module checks whether
 * that export covers exactly the response IDs retained in immutable evidence.
 */
import type { ModelProviderId } from "../model-providers/model-provider.js";

export interface AddieMatchedV4BilledDispatch {
  readonly provider: ModelProviderId;
  readonly providerResponseId: string;
  /** Immutable evidence time for the provider dispatch, in UTC ISO-8601. */
  readonly dispatchedAt: string;
}

export interface AddieMatchedV4ProviderBillingLine {
  readonly providerResponseId: string;
  /** Integer microdollars as reported by the provider; never a local estimate. */
  readonly billedCostMicros: number;
}

/**
 * The protected billing-export adapter may produce this normalized projection
 * only after retaining its provider-native source and provenance externally.
 * An invoice or aggregate with no per-response correlation is intentionally
 * not this shape and remains pending rather than being guessed into one.
 */
export interface AddieMatchedV4ProviderBillingExport {
  readonly kind: "addie_matched_v4_provider_billing_export";
  readonly version: 1;
  readonly provider: ModelProviderId;
  readonly exportId: string;
  readonly accountScopeId: string;
  readonly coverageStartedAt: string;
  readonly coverageEndedAt: string;
  readonly currency: "USD";
  /** SHA-256 of the independently retained provider-native source. */
  readonly sourceSha256: string;
  readonly lines: readonly AddieMatchedV4ProviderBillingLine[];
}

export interface AddieMatchedV4BillingReconciliation {
  readonly status: "reconciled" | "cost_settlement_pending";
  readonly reason?:
    | "untrusted_billing_export"
    | "missing_provider_export"
    | "invalid_provider_export"
    | "account_scope_mismatch"
    | "coverage_window_mismatch"
    | "missing_billed_dispatch"
    | "unexpected_billed_dispatch"
    | "duplicate_billed_dispatch";
  readonly billedCostMicros?: number;
  readonly exports?: readonly Readonly<{
    provider: ModelProviderId;
    exportId: string;
    accountScopeId: string;
    sourceSha256: string;
  }>[];
}

/**
 * Contract that a future protected adapter must seal from retained evaluator
 * evidence. The dispatch timestamp must be within the run window and within
 * the matching provider export's coverage before it can be settled.
 */
export interface AddieMatchedV4BillingReconciliationTarget {
  readonly dispatches: readonly AddieMatchedV4BilledDispatch[];
  readonly accountScopeByProvider: Readonly<
    Partial<Record<ModelProviderId, string>>
  >;
  /** Inclusive UTC bounds; a protected adapter must reject any dispatch outside them. */
  readonly runStartedAt: string;
  readonly runEndedAt: string;
}

/** The sealed adapter owns both the exact billing join and its run window. */
export interface AddieMatchedV4ProviderBillingReconciliationCapability {
  /**
   * This is issued only after the protected adapter has authenticated and
   * retained provider-native sources. It captures the evaluator dispatches,
   * dedicated account scopes, and run window; callers cannot supply them to
   * this method.
   */
  reconcile(
    exports: readonly AddieMatchedV4ProviderBillingExport[],
  ): AddieMatchedV4BillingReconciliation;
}

function pending(
  reason: NonNullable<AddieMatchedV4BillingReconciliation["reason"]>,
): AddieMatchedV4BillingReconciliation {
  return Object.freeze({ status: "cost_settlement_pending", reason });
}

/**
 * Reconcile immutable evaluator response IDs with provider-authoritative cost
 * lines. It accepts no pricing profile, token usage, caller-supplied total, or
 * tolerance. Until a protected adapter can authenticate provider-native
 * sources and issue the capability above, every serializable projection is
 * intentionally pending.
 */
export function reconcileAddieMatchedV4ProviderBilling(
  _dispatches: readonly AddieMatchedV4BilledDispatch[],
  _exports: readonly AddieMatchedV4ProviderBillingExport[],
): AddieMatchedV4BillingReconciliation {
  // A serializable projection has no evidence that its source was a protected
  // provider export. Only the adapter-issued capability below owns the
  // immutable evaluator dispatch list, account scope, and coverage window.
  return pending("untrusted_billing_export");
}
