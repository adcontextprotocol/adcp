import {
  fixedTraceComponentSmokeAdmission,
  type FixedTraceComponentSmokeAdmissionManifest,
} from './fixed-trace-component-smoke-admission.js';
import { snapshotFixedTraceJson } from './fixed-trace-safe-snapshot.js';

/** Integer accounting avoids floating-point budget comparisons. */
export const FIXED_TRACE_MICRODOLLARS_PER_USD = 1_000_000 as const;
export const FIXED_TRACE_API_BUDGET_LADDER_VERSION =
  'addie-fixed-trace-api-budget-ladder-v2' as const;

const FIXED_TRACE_V2_SMOKE_ADMISSION_FINGERPRINT =
  '817ab57d30cc89dab4a81016f5c826857b8dc2a83e2f73aa0b7eb9c82f0b5d71' as const;
const FIXED_TRACE_V2_SMOKE_PRICING_COHORT_DIGEST =
  'sha256:e8c5736fb62ef4b5c7219401e2f765be7e5a8527472babf54b29ec27539f94e7' as const;
const FIXED_TRACE_V2_SMOKE_PRICING_CHECKED_AT = '2026-09-05T23:55:26.000Z' as const;

/** Fail closed if a same-sized but different smoke admission is substituted. */
export function assertFixedTraceV2SmokeIdentity(
  admission: Pick<FixedTraceComponentSmokeAdmissionManifest, 'status' | 'cardinality' | 'pricing' | 'fingerprints'>,
): void {
  if (admission.status !== 'ready_for_explicit_paid_authorization') throw new Error('pinned v2 component-smoke admission is not ready for explicit paid authorization');
  if (admission.fingerprints.aggregateAdmission !== FIXED_TRACE_V2_SMOKE_ADMISSION_FINGERPRINT) throw new Error('pinned v2 component-smoke aggregate admission fingerprint changed');
  if (admission.cardinality.maximumProviderInvocations !== 192) throw new Error('pinned v2 component-smoke provider-call ceiling changed');
  if (admission.pricing.reservationMicrodollars !== 2_819_484) throw new Error('pinned v2 component-smoke reservation changed');
  if (admission.pricing.providerCeilingUsd !== 5) throw new Error('pinned v2 component-smoke USD ceiling changed');
  if (admission.pricing.cohortDigest !== FIXED_TRACE_V2_SMOKE_PRICING_COHORT_DIGEST || admission.pricing.checkedAt !== FIXED_TRACE_V2_SMOKE_PRICING_CHECKED_AT) throw new Error('pinned v2 component-smoke pricing cohort changed');
}

const smoke = fixedTraceComponentSmokeAdmission();
assertFixedTraceV2SmokeIdentity(smoke);
const smokeCalls = smoke.cardinality.maximumProviderInvocations;
const smokeReservation = smoke.pricing.reservationMicrodollars;

/** Planning data only; private authority must attest a later release. */
export const FIXED_TRACE_API_BUDGET_LADDER = Object.freeze({
  version: FIXED_TRACE_API_BUDGET_LADDER_VERSION,
  status: 'not_admitted_pending_private_verified_tranche_authority',
  hardCumulativeCeilingMicrodollars: 700_000_000,
  accountingUnit: 'integer_microdollars',
  ledger: 'private_verified_immutable_cumulative_ledger_required_before_every_dispatch',
  tranches: Object.freeze([
    Object.freeze({
      id: 'tranche_1_component_smoke',
      status: 'separate_v2_admission_preserved_not_authorized_here',
      v2AdmissionFingerprint: smoke.fingerprints.aggregateAdmission,
      v2PricingCohortDigest: smoke.pricing.cohortDigest,
      maximumProviderCalls: smokeCalls,
      maximumCostMicrodollars: 5_000_000,
      reservedMaximumMicrodollars: smokeReservation,
      stopRules: Object.freeze([
        'stop_before_dispatch_when_reservation_exceeds_cap',
        'stop_on_unknown_exposure_or_missing_usage',
        'stop_on_deterministic_or_safety_failure',
      ]),
    }),
    ...(['tranche_2_model_judge_calibration', 'tranche_3_exploratory_and_architecture_diagnostic', 'tranche_4_reviewed_follow_up'] as const).map((id) => Object.freeze({
      id,
      status: 'not_admitted_requires_own_private_verified_cap_and_reconciled_ledger',
      maximumProviderCalls: null,
      maximumCostMicrodollars: null,
      reservedMaximumMicrodollars: null,
      stopRules: Object.freeze([
        'no_automatic_release_of_unspent_ceiling',
        'require_prior_reconciled_observed_reserved_and_unknown_exposure',
        'require_own_private_verified_call_and_cost_cap_before_dispatch',
        'prohibit_overlapping_or_in_flight_releases',
      ]),
    })),
  ]),
  noPerConfigurationSpendAssumption: true,
} as const);

export type FixedTraceApiBudgetTrancheId =
  (typeof FIXED_TRACE_API_BUDGET_LADDER.tranches)[number]['id'];

/** Structural input only; its authorization digest is never verified here. */
export interface FixedTraceUnverifiedTrancheLedgerShape {
  readonly trancheId: FixedTraceApiBudgetTrancheId;
  /** A reference only. This public module cannot establish its authenticity. */
  readonly unverifiedAuthorizationReferenceDigest: string;
  readonly declaredMaximumProviderCalls: number;
  readonly declaredCapMicrodollars: number;
  readonly priorReconciledObservedMicrodollars: number;
  readonly priorOutstandingReservedMicrodollars: number;
  readonly priorUnknownExposureMicrodollars: number;
  readonly currentTrancheReservedMicrodollars: number;
  readonly observedProviderCalls: number;
}

const ledgerKeys = [
  'currentTrancheReservedMicrodollars', 'declaredCapMicrodollars',
  'declaredMaximumProviderCalls', 'observedProviderCalls',
  'priorOutstandingReservedMicrodollars', 'priorReconciledObservedMicrodollars',
  'priorUnknownExposureMicrodollars', 'trancheId',
  'unverifiedAuthorizationReferenceDigest',
] as const;
const isMicrodollars = (value: unknown) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
const exactKeys = (value: Record<string, unknown>, keys: readonly string[], label: string) => {
  if (Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) throw new Error(`${label} has extra or missing fields`);
};

/** Structural safety check only; success never creates verified authority. */
export function assertFixedTraceUnverifiedTrancheLedgerShape(value: unknown): void {
  const entry = snapshotFixedTraceJson(value, 'fixed-trace unverified tranche ledger');
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('fixed-trace unverified tranche ledger must be an object');
  const record = entry as Record<string, unknown>;
  exactKeys(record, ledgerKeys, 'fixed-trace unverified tranche ledger');
  const tranche = FIXED_TRACE_API_BUDGET_LADDER.tranches.find((item) => item.id === record.trancheId);
  if (!tranche || typeof record.unverifiedAuthorizationReferenceDigest !== 'string' || !/^[a-f0-9]{64}$/.test(record.unverifiedAuthorizationReferenceDigest)
    || typeof record.declaredMaximumProviderCalls !== 'number' || !Number.isSafeInteger(record.declaredMaximumProviderCalls) || record.declaredMaximumProviderCalls < 1
    || ![record.declaredCapMicrodollars, record.priorReconciledObservedMicrodollars,
      record.priorOutstandingReservedMicrodollars, record.priorUnknownExposureMicrodollars,
      record.currentTrancheReservedMicrodollars, record.observedProviderCalls].every(isMicrodollars)) throw new Error('fixed-trace unverified tranche ledger has invalid values');
  const checked = record as unknown as FixedTraceUnverifiedTrancheLedgerShape;
  if (checked.observedProviderCalls > checked.declaredMaximumProviderCalls) throw new Error('fixed-trace unverified tranche ledger exceeds declared call cap');
  if (checked.currentTrancheReservedMicrodollars > checked.declaredCapMicrodollars) throw new Error('fixed-trace unverified tranche ledger exceeds tranche cost cap');
  if (tranche.maximumProviderCalls !== null && checked.declaredMaximumProviderCalls !== tranche.maximumProviderCalls) throw new Error('fixed-trace unverified tranche ledger conflicts with pinned call cap');
  if (tranche.maximumCostMicrodollars !== null && checked.declaredCapMicrodollars !== tranche.maximumCostMicrodollars) throw new Error('fixed-trace unverified tranche ledger conflicts with pinned cost cap');
  const priorExposure = checked.priorReconciledObservedMicrodollars + checked.priorOutstandingReservedMicrodollars + checked.priorUnknownExposureMicrodollars;
  if (priorExposure + checked.declaredCapMicrodollars > FIXED_TRACE_API_BUDGET_LADDER.hardCumulativeCeilingMicrodollars) throw new Error('fixed-trace unverified tranche ledger exceeds cumulative ceiling');
  if (tranche.maximumCostMicrodollars === null && (checked.priorOutstandingReservedMicrodollars !== 0 || checked.priorUnknownExposureMicrodollars !== 0)) throw new Error('fixed-trace unverified tranche ledger has overlapping or unknown prior exposure');
}
