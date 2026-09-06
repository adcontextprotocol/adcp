import {
  fixedTraceComponentSmokeAdmission,
  isFixedTraceComponentSmokeAdmissionManifest,
} from './fixed-trace-component-smoke-admission.js';
import {
  FIXED_TRACE_COMPONENT_SMOKE_PRIVATE_AUTHORITY,
  fixedTraceComponentSmokePrivateAuthorityMatchesAdmission,
  fixedTraceComponentSmokePrivateAuthorityPlan,
  type FixedTraceComponentSmokePrivateAuthorityPlanEntry,
} from './fixed-trace-component-smoke-private-authority.js';

/**
 * Stage 1 has no live construction path. This module is deliberately a pure,
 * declarative preflight contract until custody, a trust root, exact request
 * replay, and provider-continuation bindings are separately provisioned.
 */
export const FIXED_TRACE_COMPONENT_SMOKE_PRIVATE_LIVE_DEFAULT_OFF = true as const;

type ProviderPlanEntry = FixedTraceComponentSmokePrivateAuthorityPlanEntry & Readonly<{
  readonly disposition: 'provider_dispatch';
}>;

export type FixedTraceComponentSmokePrivateLiveSlot = Readonly<{
  /** A non-secret declarative key; it is not a request HMAC. */
  readonly slotKey: string;
  readonly admissionFingerprint: string;
  readonly assignmentId: string;
  readonly probeId: string;
  readonly cellId: string;
  readonly provider: string;
  readonly model: string;
  readonly effort: string;
  readonly invocationOrdinal: number;
  readonly requestReplayBinding: 'unprovisioned_exact_request_tool_replay_binding';
  readonly semanticRequestFingerprint: null;
  readonly providerContinuationBinding: 'not_applicable' | 'unprovisioned_exact_provider_continuation_binding';
}>;

export type FixedTraceComponentSmokePrivateLiveInspection = Readonly<{
  readonly status: 'not_provisioned' | 'refused';
  readonly reason:
    | 'exact_request_tool_replay_binding_unprovisioned'
    | 'exact_provider_continuation_binding_unprovisioned'
    | 'invalid_json_declaration'
    | 'unknown_or_mismatched_slot_declaration';
  readonly slot: FixedTraceComponentSmokePrivateLiveSlot | null;
}>;

const DECLARATION_FIELDS = Object.freeze([
  'admissionFingerprint',
  'assignmentId',
  'cellId',
  'effort',
  'invocationOrdinal',
  'model',
  'probeId',
  'provider',
  'slotKey',
]);

function slotKey(entry: ProviderPlanEntry, invocationOrdinal: number): string {
  // This durable fixture key is intentionally transparent, not a MAC or a
  // substitute for the still-unprovisioned exact replay binding.
  return JSON.stringify([
    FIXED_TRACE_COMPONENT_SMOKE_PRIVATE_AUTHORITY.aggregateAdmissionFingerprint,
    entry.assignmentId,
    entry.probeId,
    entry.cellId,
    entry.provider,
    entry.model,
    entry.effort,
    invocationOrdinal,
  ]);
}

function isProviderPlanEntry(entry: FixedTraceComponentSmokePrivateAuthorityPlanEntry): entry is ProviderPlanEntry {
  return entry.disposition === 'provider_dispatch';
}

function deriveSlots(): readonly FixedTraceComponentSmokePrivateLiveSlot[] {
  const plan = fixedTraceComponentSmokePrivateAuthorityPlan();
  const entries = plan.filter(isProviderPlanEntry);
  const slots = entries.flatMap((entry) => Array.from(
    { length: entry.maximumProviderInvocations },
    (_, index) => {
      const invocationOrdinal = index + 1;
      return Object.freeze({
        slotKey: slotKey(entry, invocationOrdinal),
        admissionFingerprint: FIXED_TRACE_COMPONENT_SMOKE_PRIVATE_AUTHORITY.aggregateAdmissionFingerprint,
        assignmentId: entry.assignmentId,
        probeId: entry.probeId,
        cellId: entry.cellId,
        provider: entry.provider,
        model: entry.model,
        effort: entry.effort,
        invocationOrdinal,
        requestReplayBinding: 'unprovisioned_exact_request_tool_replay_binding' as const,
        semanticRequestFingerprint: null,
        providerContinuationBinding: invocationOrdinal === 1
          ? 'not_applicable' as const
          : 'unprovisioned_exact_provider_continuation_binding' as const,
      });
    },
  ));
  const authority = FIXED_TRACE_COMPONENT_SMOKE_PRIVATE_AUTHORITY;
  if (plan.length !== authority.cardinality.caseCellAssignments
    || entries.length !== authority.cardinality.providerDispatchCaseCellAssignments
    || slots.length !== authority.cardinality.maximumProviderInvocations
    || new Set(slots.map((slot) => slot.slotKey)).size !== slots.length) {
    throw new Error('private component-smoke preflight integrity failure');
  }
  return Object.freeze(slots);
}

const SLOTS = deriveSlots();

/** Returns immutable accounting slots only; it cannot prepare or dispatch a request. */
export function fixedTraceComponentSmokePrivateLiveSlots(): readonly FixedTraceComponentSmokePrivateLiveSlot[] {
  return SLOTS;
}

/**
 * Returns the pinned plan's explicit provisioning gap. An admitted manifest
 * is necessary but cannot stand in for a captured request replay fingerprint,
 * keyed request MAC, or provider continuation state.
 */
export function fixedTraceComponentSmokePrivateLivePreflight(): FixedTraceComponentSmokePrivateLiveInspection {
  const admission = fixedTraceComponentSmokeAdmission();
  if (!isFixedTraceComponentSmokeAdmissionManifest(admission)
    || !fixedTraceComponentSmokePrivateAuthorityMatchesAdmission(admission)
    || admission.fingerprints.aggregateAdmission !== FIXED_TRACE_COMPONENT_SMOKE_PRIVATE_AUTHORITY.aggregateAdmissionFingerprint
    || admission.cardinality.caseCellAssignments !== 168
    || admission.cardinality.maximumProviderInvocations !== 192
    || admission.pricing.reservationMicrodollars !== 2_819_484) {
    return Object.freeze({ status: 'refused', reason: 'unknown_or_mismatched_slot_declaration', slot: null });
  }
  return Object.freeze({
    status: 'not_provisioned',
    reason: 'exact_request_tool_replay_binding_unprovisioned',
    slot: null,
  });
}

function hasExactDeclarationKeys(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === DECLARATION_FIELDS.length
    && keys.every((key, index) => key === DECLARATION_FIELDS[index]);
}

/**
 * Inspect one JSON-text slot declaration. Object inputs are rejected before
 * property access, so this contract never invokes caller getters or callbacks.
 * It accepts no request, receipt, credential, grant, or persistence handle.
 */
export function inspectFixedTraceComponentSmokePrivateLiveSlotJson(jsonText: unknown): FixedTraceComponentSmokePrivateLiveInspection {
  if (typeof jsonText !== 'string' || jsonText.length > 16_384) {
    return Object.freeze({ status: 'refused', reason: 'invalid_json_declaration', slot: null });
  }
  let declaration: unknown;
  try {
    declaration = JSON.parse(jsonText);
  } catch {
    return Object.freeze({ status: 'refused', reason: 'invalid_json_declaration', slot: null });
  }
  if (!declaration || typeof declaration !== 'object' || Array.isArray(declaration)) {
    return Object.freeze({ status: 'refused', reason: 'invalid_json_declaration', slot: null });
  }
  const candidate = declaration as Record<string, unknown>;
  if (!hasExactDeclarationKeys(candidate)
    || typeof candidate.slotKey !== 'string'
    || typeof candidate.admissionFingerprint !== 'string'
    || typeof candidate.assignmentId !== 'string'
    || typeof candidate.probeId !== 'string'
    || typeof candidate.cellId !== 'string'
    || typeof candidate.provider !== 'string'
    || typeof candidate.model !== 'string'
    || typeof candidate.effort !== 'string'
    || !Number.isSafeInteger(candidate.invocationOrdinal)) {
    return Object.freeze({ status: 'refused', reason: 'invalid_json_declaration', slot: null });
  }
  const slot = SLOTS.find((known) => known.slotKey === candidate.slotKey
    && known.admissionFingerprint === candidate.admissionFingerprint
    && known.assignmentId === candidate.assignmentId
    && known.probeId === candidate.probeId
    && known.cellId === candidate.cellId
    && known.provider === candidate.provider
    && known.model === candidate.model
    && known.effort === candidate.effort
    && known.invocationOrdinal === candidate.invocationOrdinal) ?? null;
  if (!slot) return Object.freeze({ status: 'refused', reason: 'unknown_or_mismatched_slot_declaration', slot: null });
  return Object.freeze({
    status: 'not_provisioned',
    reason: slot.invocationOrdinal === 1
      ? 'exact_request_tool_replay_binding_unprovisioned'
      : 'exact_provider_continuation_binding_unprovisioned',
    slot,
  });
}

/** Production remains hard-null pending a separately reviewed custody and provider-access slice. */
export function createFixedTraceComponentSmokePrivateLiveCoordinator(): null {
  return null;
}
