/**
 * Provider-neutral custody contract for matched-v4 aggregate cost settlement.
 *
 * Provider billing exports are aggregates, not response-level bills. This
 * module therefore keeps response IDs solely as execution-completeness
 * evidence. It neither fetches a billing source nor assigns provider cost to
 * an individual response.
 */
import type { ModelProviderId } from "../model-providers/model-provider.js";

export interface AddieMatchedV4BilledDispatch {
  readonly provider: ModelProviderId;
  /** Immutable evaluator evidence only; never a provider-billing join key. */
  readonly providerResponseId: string;
  /** Immutable evidence time for the provider dispatch, in UTC ISO-8601. */
  readonly dispatchedAt: string;
}

/** The native grouping available from each provider's authoritative source. */
export type AddieMatchedV4NativeBillingGranularity =
  | "openai_daily_project_line_item"
  | "anthropic_time_api_key_workspace_model"
  | "google_cloud_billing_account_project_service_sku_time_resource";

/**
 * An optional aggregate subdivision copied from a native export. A protected
 * adapter may include this only where its authenticated native source actually
 * supplies the corresponding dimension: `model` for Anthropic or `line_item`
 * for OpenAI. Google breakdowns are omitted until SKU/resource granularity has
 * its own native contract. It is never a per-response amount.
 */
export interface AddieMatchedV4ProviderBillingBreakdown {
  readonly dimension: "model" | "line_item";
  readonly id: string;
  readonly providerReportedCostMicros: number;
}

/**
 * A future protected adapter's normalized receipt for one provider and one
 * dedicated evaluation scope. There must be exactly one complete retained
 * native export receipt per provider in an evaluation. `nativeExportIdentity`
 * identifies the provider report/query/export itself;
 * `authenticatedNativeSourceSha256` commits its retained native bytes. Neither
 * field makes a caller-supplied object trusted.
 */
export interface AddieMatchedV4ProviderBillingSettlementReceipt {
  readonly kind: "addie_matched_v4_provider_billing_settlement_receipt";
  readonly version: 2;
  readonly provider: ModelProviderId;
  readonly nativeGranularity: AddieMatchedV4NativeBillingGranularity;
  readonly nativeExportIdentity: string;
  readonly authenticatedNativeSourceSha256: string;
  readonly dedicatedScopeId: string;
  /** Inclusive UTC coverage bounds reported by the provider-native export. */
  readonly coverageStartedAt: string;
  readonly coverageEndedAt: string;
  /**
   * UTC finality determined by protected custody under its provider-specific
   * lag/stability policy. It is not asserted to be provider-reported.
   */
  readonly settledThroughAt: string;
  /** Only USD can be represented safely by this microdollar contract. */
  readonly currency: "USD";
  /** Integer provider-reported aggregate USD microdollars for this scope/window. */
  readonly providerReportedAggregateCostMicros: number;
  /** Present only when native data supplies a complete model or line-item split. */
  readonly breakdown?: readonly AddieMatchedV4ProviderBillingBreakdown[];
  /**
   * The protected custody process's isolation finding, not a billing join.
   * It may be set only after the dedicated key/project/workspace has been
   * checked for extra traffic across the covered window.
   */
  readonly scopeIsolation:
    "exclusive_dedicated_scope" | "extra_or_shared_traffic";
}

/**
 * Contract captured inside a future protected capability. Dispatch IDs prove
 * complete execution, while settlement is attached to the isolated scope and
 * complete settled UTC window.
 */
export interface AddieMatchedV4BillingReconciliationTarget {
  readonly dispatches: readonly AddieMatchedV4BilledDispatch[];
  readonly dedicatedScopeByProvider: Readonly<
    Partial<Record<ModelProviderId, string>>
  >;
  /** Inclusive UTC bounds of the evaluator run. */
  readonly runStartedAt: string;
  readonly runEndedAt: string;
}

export type AddieMatchedV4BillingProjectionIssue =
  | "invalid_contract_input"
  | "execution_completeness_failed"
  | "missing_provider_receipt"
  | "unexpected_provider_receipt"
  | "duplicate_provider_receipt"
  | "malformed_receipt"
  | "wrong_dedicated_scope"
  | "coverage_not_complete"
  | "settlement_not_final"
  | "scope_isolation_failed"
  | "duplicate_native_export"
  | "unsupported_currency"
  | "unsafe_aggregate_total";

/**
 * Diagnostic structural validation only. A valid result does not authenticate
 * the source, issue a capability, settle cost, or permit promotion.
 */
export interface AddieMatchedV4BillingProjectionValidation {
  readonly valid: boolean;
  readonly issues: readonly AddieMatchedV4BillingProjectionIssue[];
}

/**
 * Current executable paths cannot settle cost. A later reviewed protected
 * adapter may introduce an internally issued capability, but must not expose a
 * caller-constructible route to a promotable result.
 */
export interface AddieMatchedV4ProviderBillingReconciliationCapability {
  reconcile(
    receipts: readonly AddieMatchedV4ProviderBillingSettlementReceipt[],
  ): AddieMatchedV4BillingReconciliation;
}

export interface AddieMatchedV4BillingReconciliation {
  readonly status: "cost_settlement_pending";
  readonly reason: "untrusted_billing_receipt";
}

const PROVIDERS: readonly ModelProviderId[] = ["anthropic", "openai", "google"];

const GRANULARITY_BY_PROVIDER: Readonly<
  Record<ModelProviderId, AddieMatchedV4NativeBillingGranularity>
> = Object.freeze({
  openai: "openai_daily_project_line_item",
  anthropic: "anthropic_time_api_key_workspace_model",
  google: "google_cloud_billing_account_project_service_sku_time_resource",
});

/** Google requires its own SKU/resource-native breakdown contract. */
const BREAKDOWN_DIMENSION_BY_PROVIDER: Readonly<
  Partial<
    Record<ModelProviderId, AddieMatchedV4ProviderBillingBreakdown["dimension"]>
  >
> = Object.freeze({
  openai: "line_item",
  anthropic: "model",
});

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function utcMilliseconds(value: unknown): number | undefined {
  if (typeof value !== "string" || !value.endsWith("Z")) return undefined;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return undefined;
  return new Date(milliseconds).toISOString() === value
    ? milliseconds
    : undefined;
}

function isProvider(value: unknown): value is ModelProviderId {
  return (
    typeof value === "string" && PROVIDERS.includes(value as ModelProviderId)
  );
}

function isSha256(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length === 64 &&
    /^[a-f0-9]{64}$/i.test(value)
  );
}

function isSafeMicrodollarTotal(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function addIssue(
  issues: Set<AddieMatchedV4BillingProjectionIssue>,
  issue: AddieMatchedV4BillingProjectionIssue,
): void {
  issues.add(issue);
}

/**
 * Checks the shape and declared relationships of a proposed aggregate receipt
 * set. It deliberately accepts `unknown` so malformed untrusted input cannot
 * throw. Its result is not authority and is intentionally unused by promotion.
 */
export function validateAddieMatchedV4ProviderBillingSettlementProjection(
  target: unknown,
  receipts: unknown,
): AddieMatchedV4BillingProjectionValidation {
  const issues = new Set<AddieMatchedV4BillingProjectionIssue>();
  try {
    if (!isRecord(target) || !Array.isArray(target.dispatches)) {
      addIssue(issues, "invalid_contract_input");
      return Object.freeze({
        valid: false,
        issues: Object.freeze([...issues]),
      });
    }
    const runStartedAt = utcMilliseconds(target.runStartedAt);
    const runEndedAt = utcMilliseconds(target.runEndedAt);
    if (
      runStartedAt === undefined ||
      runEndedAt === undefined ||
      runStartedAt > runEndedAt ||
      !isRecord(target.dedicatedScopeByProvider)
    ) {
      addIssue(issues, "invalid_contract_input");
    }

    const expectedProviders = new Set<ModelProviderId>();
    const dispatchKeys = new Set<string>();
    for (const dispatch of target.dispatches) {
      if (
        !isRecord(dispatch) ||
        !isProvider(dispatch.provider) ||
        !nonEmptyString(dispatch.providerResponseId)
      ) {
        addIssue(issues, "execution_completeness_failed");
        continue;
      }
      const dispatchedAt = utcMilliseconds(dispatch.dispatchedAt);
      if (
        dispatchedAt === undefined ||
        runStartedAt === undefined ||
        runEndedAt === undefined ||
        dispatchedAt < runStartedAt ||
        dispatchedAt > runEndedAt
      ) {
        addIssue(issues, "execution_completeness_failed");
      }
      const dispatchKey = `${dispatch.provider}:${dispatch.providerResponseId}`;
      if (dispatchKeys.has(dispatchKey))
        addIssue(issues, "execution_completeness_failed");
      dispatchKeys.add(dispatchKey);
      expectedProviders.add(dispatch.provider);
    }
    if (expectedProviders.size === 0) {
      addIssue(issues, "execution_completeness_failed");
    }

    if (!Array.isArray(receipts)) {
      addIssue(issues, "invalid_contract_input");
      return Object.freeze({
        valid: false,
        issues: Object.freeze([...issues]),
      });
    }

    const receiptProviders = new Set<ModelProviderId>();
    const receiptCountByProvider = new Map<ModelProviderId, number>();
    const nativeExports = new Set<string>();
    const nativeSources = new Set<string>();
    for (const receipt of receipts) {
      if (
        !isRecord(receipt) ||
        receipt.kind !==
          "addie_matched_v4_provider_billing_settlement_receipt" ||
        receipt.version !== 2 ||
        !isProvider(receipt.provider) ||
        !nonEmptyString(receipt.nativeExportIdentity) ||
        !isSha256(receipt.authenticatedNativeSourceSha256) ||
        !nonEmptyString(receipt.dedicatedScopeId)
      ) {
        addIssue(issues, "malformed_receipt");
        continue;
      }
      const provider = receipt.provider;
      receiptProviders.add(provider);
      const receiptCount = (receiptCountByProvider.get(provider) ?? 0) + 1;
      receiptCountByProvider.set(provider, receiptCount);
      if (receiptCount > 1) {
        addIssue(issues, "duplicate_provider_receipt");
      }
      const nativeExportKey = `${provider}:${receipt.nativeExportIdentity}`;
      const nativeSourceSha256 =
        receipt.authenticatedNativeSourceSha256.toLowerCase();
      if (
        nativeExports.has(nativeExportKey) ||
        nativeSources.has(nativeSourceSha256)
      ) {
        addIssue(issues, "duplicate_native_export");
      }
      nativeExports.add(nativeExportKey);
      nativeSources.add(nativeSourceSha256);
      if (receipt.nativeGranularity !== GRANULARITY_BY_PROVIDER[provider]) {
        addIssue(issues, "malformed_receipt");
      }
      const scope = isRecord(target.dedicatedScopeByProvider)
        ? target.dedicatedScopeByProvider[provider]
        : undefined;
      if (!nonEmptyString(scope) || scope !== receipt.dedicatedScopeId) {
        addIssue(issues, "wrong_dedicated_scope");
      }
      const coverageStartedAt = utcMilliseconds(receipt.coverageStartedAt);
      const coverageEndedAt = utcMilliseconds(receipt.coverageEndedAt);
      const settledThroughAt = utcMilliseconds(receipt.settledThroughAt);
      if (
        coverageStartedAt === undefined ||
        coverageEndedAt === undefined ||
        coverageStartedAt > coverageEndedAt ||
        runStartedAt === undefined ||
        runEndedAt === undefined ||
        coverageStartedAt > runStartedAt ||
        coverageEndedAt < runEndedAt
      ) {
        addIssue(issues, "coverage_not_complete");
      }
      if (
        settledThroughAt === undefined ||
        coverageEndedAt === undefined ||
        settledThroughAt < coverageEndedAt
      ) {
        addIssue(issues, "settlement_not_final");
      }
      if (receipt.scopeIsolation !== "exclusive_dedicated_scope") {
        addIssue(issues, "scope_isolation_failed");
      }
      if (receipt.currency !== "USD") addIssue(issues, "unsupported_currency");
      if (
        !isSafeMicrodollarTotal(receipt.providerReportedAggregateCostMicros)
      ) {
        addIssue(issues, "unsafe_aggregate_total");
      }
      if (receipt.breakdown !== undefined) {
        const supportedDimension = BREAKDOWN_DIMENSION_BY_PROVIDER[provider];
        if (
          supportedDimension === undefined ||
          !Array.isArray(receipt.breakdown) ||
          receipt.breakdown.length === 0
        ) {
          addIssue(issues, "malformed_receipt");
        } else {
          const breakdownKeys = new Set<string>();
          let breakdownTotal = 0;
          for (const entry of receipt.breakdown) {
            if (
              !isRecord(entry) ||
              entry.dimension !== supportedDimension ||
              !nonEmptyString(entry.id) ||
              !isSafeMicrodollarTotal(entry.providerReportedCostMicros)
            ) {
              addIssue(issues, "malformed_receipt");
              continue;
            }
            const key = `${entry.dimension}:${entry.id}`;
            if (breakdownKeys.has(key)) addIssue(issues, "malformed_receipt");
            breakdownKeys.add(key);
            breakdownTotal += entry.providerReportedCostMicros;
          }
          if (
            !Number.isSafeInteger(breakdownTotal) ||
            breakdownTotal !== receipt.providerReportedAggregateCostMicros
          ) {
            addIssue(issues, "unsafe_aggregate_total");
          }
        }
      }
    }
    for (const provider of expectedProviders) {
      if (!receiptProviders.has(provider))
        addIssue(issues, "missing_provider_receipt");
    }
    for (const provider of receiptProviders) {
      if (!expectedProviders.has(provider))
        addIssue(issues, "unexpected_provider_receipt");
    }
  } catch {
    addIssue(issues, "invalid_contract_input");
  }
  return Object.freeze({
    valid: issues.size === 0,
    issues: Object.freeze([...issues]),
  });
}

/**
 * All caller-constructible/raw inputs fail closed. This intentionally does not
 * invoke the diagnostic validator: even a structurally perfect projection
 * cannot authenticate a native source or unlock cost-aware promotion.
 */
export function reconcileAddieMatchedV4ProviderBilling(
  _target: unknown,
  _receipts: unknown,
): AddieMatchedV4BillingReconciliation {
  return Object.freeze({
    status: "cost_settlement_pending",
    reason: "untrusted_billing_receipt",
  });
}
