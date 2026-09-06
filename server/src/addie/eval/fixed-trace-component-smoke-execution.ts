import { createHash } from 'node:crypto';
import {
  fixedTraceComponentSmokeAdmission,
  isFixedTraceComponentSmokeAdmissionManifest,
  type FixedTraceComponentSmokeAdmissionManifest,
} from './fixed-trace-component-smoke-admission.js';
import { deepFreezeFixedTrace, snapshotFixedTraceJson } from './fixed-trace-safe-snapshot.js';

/** This boundary has no provider client, credentials, approval text, or default durable backend. */
export const FIXED_TRACE_COMPONENT_SMOKE_GRANT_VERSION =
  'addie-fixed-trace-component-smoke-grant-v1' as const;
/** This checkout is permanently dormant: private deployment wiring is deliberately absent. */
export const FIXED_TRACE_COMPONENT_SMOKE_CURRENT_MODULE_CAN_DISPATCH = false as const;

type Admission = FixedTraceComponentSmokeAdmissionManifest;
type AdmissionCardinality = Admission['cardinality'];
type AdmissionPricing = Admission['pricing'];

/** Derived exclusively from the frozen singleton admission artifact. */
export const FIXED_TRACE_COMPONENT_SMOKE_STAGE_ID =
  fixedTraceComponentSmokeAdmission().stageControls.phaseId;

export interface FixedTraceComponentSmokeAuthorizationGrant {
  readonly version: typeof FIXED_TRACE_COMPONENT_SMOKE_GRANT_VERSION;
  /** Private issuer/ledger handle; never emitted to records or adapters. */
  readonly grantId: string;
  /** Private issuer entropy; never emitted to records or adapters. */
  readonly nonce: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly binding: Readonly<{
    readonly stageId: typeof FIXED_TRACE_COMPONENT_SMOKE_STAGE_ID;
    readonly aggregateAdmissionFingerprint: string;
    readonly cardinality: AdmissionCardinality;
    readonly pricing: AdmissionPricing;
  }>;
}

/** Data an external, access-controlled issuer must bind before minting a grant. */
export interface FixedTraceComponentSmokeGrantIssuanceRequest {
  readonly version: typeof FIXED_TRACE_COMPONENT_SMOKE_GRANT_VERSION;
  readonly stageId: typeof FIXED_TRACE_COMPONENT_SMOKE_STAGE_ID;
  readonly aggregateAdmissionFingerprint: string;
  readonly cardinality: AdmissionCardinality;
  readonly pricing: AdmissionPricing;
}

/** Controlled issuance seam only. This module never invokes or implements it. */
export interface FixedTraceComponentSmokeAuthorizationIssuer {
  issue(request: FixedTraceComponentSmokeGrantIssuanceRequest): Promise<FixedTraceComponentSmokeAuthorizationGrant>;
}

export type FixedTraceComponentSmokeLedgerRefusal =
  | 'grant_not_registered' | 'grant_already_consumed' | 'grant_binding_mismatch' | 'grant_not_active'
  | 'reservation_mismatch' | 'admission_drift' | 'unknown_attempt_exists' | 'duplicate_attempt_id'
  | 'count_exhausted' | 'cost_exhausted' | 'persistence_uncertain';

/** A non-reversible correlation handle, not a grant handle. */
export interface FixedTraceComponentSmokeRunReservation {
  readonly reservationId: string;
  readonly aggregateAdmissionFingerprint: string;
  readonly maximumProviderInvocations: number;
  readonly maximumReservationUsd: number;
}

export interface FixedTraceComponentSmokeAttemptIntent {
  readonly reservation: FixedTraceComponentSmokeRunReservation;
  readonly attemptCorrelationId: string;
  readonly probeId: string;
  readonly cellId: string;
  readonly invocationOrdinal: number;
}

/** Terminal records are categorical: no prompt, output, key, provider error, grant id, or nonce. */
export interface FixedTraceComponentSmokeAttemptTerminal {
  readonly reservation: FixedTraceComponentSmokeRunReservation;
  readonly attemptCorrelationId: string;
  readonly outcome: 'succeeded' | 'provider_failed';
}

/**
 * A private implementation must atomically reserve, consume, revalidate the
 * grant against its own trusted clock, and detect unresolved prior intents.
 * Ambiguous commit/read state is a refusal, never a retry.
 */
export interface FixedTraceComponentSmokeExecutionLedger {
  readonly durability: 'private_durable_atomic' | 'test_memory_only';
  reserveAndConsume(input: Readonly<{ grant: FixedTraceComponentSmokeAuthorizationGrant; admission: Admission }>): Promise<
    | Readonly<{ status: 'reserved'; reservation: FixedTraceComponentSmokeRunReservation }>
    | Readonly<{ status: 'refused'; reason: FixedTraceComponentSmokeLedgerRefusal }>
  >;
  recordAttemptIntent(input: FixedTraceComponentSmokeAttemptIntent): Promise<
    | Readonly<{ status: 'recorded' }>
    | Readonly<{ status: 'refused'; reason: 'duplicate_attempt_id' | 'count_exhausted' | 'cost_exhausted' | 'admission_drift' | 'persistence_uncertain' }>
  >;
  recordAttemptTerminal(input: FixedTraceComponentSmokeAttemptTerminal): Promise<
    | Readonly<{ status: 'recorded' }>
    | Readonly<{ status: 'refused'; reason: 'persistence_uncertain' | 'admission_drift' }>
  >;
}

export interface FixedTraceComponentSmokeRuntimeEnablement {
  readonly mode: 'private_runtime_enabled';
  readonly stageId: typeof FIXED_TRACE_COMPONENT_SMOKE_STAGE_ID;
  readonly aggregateAdmissionFingerprint: string;
}
export const FIXED_TRACE_COMPONENT_SMOKE_RUNTIME_DISABLED = Object.freeze({ mode: 'disabled' } as const);

/** Adapter input intentionally contains no grant or reservation secret. */
export interface FixedTraceComponentSmokeProviderAssignment {
  readonly attemptCorrelationId: string;
  readonly probeId: string;
  readonly cellId: string;
  readonly role: 'router' | 'generation';
  readonly provider: string;
  readonly model: string;
  readonly effort: string;
  readonly invocationOrdinal: number;
}
export interface FixedTraceComponentSmokeProviderAdapter {
  invoke(assignment: FixedTraceComponentSmokeProviderAssignment): Promise<void>;
}
export type FixedTraceComponentSmokeExecutionResult =
  | Readonly<{ status: 'refused'; reason: string }>
  | Readonly<{ status: 'completed'; providerInvocations: number }>
  | Readonly<{ status: 'provider_failed'; providerInvocations: number }>;

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('non-finite canonical value');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  throw new Error('non-JSON canonical value');
}

function sameJson(left: unknown, right: unknown): boolean {
  try {
    return canonicalJson(snapshotFixedTraceJson(left, 'execution binding'))
      === canonicalJson(snapshotFixedTraceJson(right, 'execution binding'));
  } catch { return false; }
}
function hasExactKeys(value: object, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

/** Separate issuer-owned grammars prevent a bearer-shaped value crossing either boundary. */
function isIssuerGrantId(value: unknown): value is string {
  return typeof value === 'string' && /^grant_[a-f0-9]{32}$/.test(value);
}
function isIssuerNonce(value: unknown): value is string {
  return typeof value === 'string' && /^nonce_[a-f0-9]{32}$/.test(value);
}
function safeCorrelationId(value: unknown): value is string {
  return typeof value === 'string' && /^attempt_[a-f0-9]{32}$/.test(value);
}
function exactIsoInstant(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}
function exactAdmissionReady(admission: unknown): admission is Admission {
  if (!isFixedTraceComponentSmokeAdmissionManifest(admission)) return false;
  const manifest = admission as Admission;
  return manifest.status === 'ready_for_explicit_paid_authorization'
    && manifest.stageControls.phaseId === FIXED_TRACE_COMPONENT_SMOKE_STAGE_ID
    && manifest.pricing.maximumReservationUsd !== null
    && manifest.pricing.maximumReservationUsd <= manifest.pricing.providerCeilingUsd
    && manifest.dispatch.defaultOff === true && manifest.dispatch.currentModuleCanDispatch === false
    && manifest.dispatch.ambientEnvironmentAuthority === false
    && manifest.evidence.permanentlyNonPromotable === true
    && manifest.evidence.permittedClaims === 'mechanical_feasibility_only'
    && manifest.denominator.unknownExposure === 'included_and_spend_reserved';
}

export function fixedTraceComponentSmokeGrantIssuanceRequest(
  admission: Admission = fixedTraceComponentSmokeAdmission(),
): FixedTraceComponentSmokeGrantIssuanceRequest | null {
  if (!exactAdmissionReady(admission)) return null;
  return deepFreezeFixedTrace({
    version: FIXED_TRACE_COMPONENT_SMOKE_GRANT_VERSION, stageId: FIXED_TRACE_COMPONENT_SMOKE_STAGE_ID,
    aggregateAdmissionFingerprint: admission.fingerprints.aggregateAdmission,
    cardinality: admission.cardinality, pricing: admission.pricing,
  });
}

/** Rejects malformed, future-issued, expired, altered, and unbound issuer output. */
export function isFixedTraceComponentSmokeAuthorizationGrant(
  value: unknown, admission: Admission = fixedTraceComponentSmokeAdmission(), now: Date,
): value is FixedTraceComponentSmokeAuthorizationGrant {
  if (!exactAdmissionReady(admission) || !(now instanceof Date) || !Number.isFinite(now.valueOf())) return false;
  try {
    const grant = snapshotFixedTraceJson(value, 'component smoke authorization grant') as Record<string, unknown>;
    if (!hasExactKeys(grant, ['binding', 'expiresAt', 'grantId', 'issuedAt', 'nonce', 'version'])) return false;
    if (grant.version !== FIXED_TRACE_COMPONENT_SMOKE_GRANT_VERSION
      || !isIssuerGrantId(grant.grantId) || !isIssuerNonce(grant.nonce)
      || !exactIsoInstant(grant.issuedAt) || !exactIsoInstant(grant.expiresAt)
      || Date.parse(grant.issuedAt as string) > now.valueOf()
      || Date.parse(grant.issuedAt as string) >= Date.parse(grant.expiresAt as string)
      || Date.parse(grant.expiresAt as string) <= now.valueOf()) return false;
    if (!grant.binding || typeof grant.binding !== 'object'
      || !hasExactKeys(grant.binding, ['aggregateAdmissionFingerprint', 'cardinality', 'pricing', 'stageId'])) return false;
    const binding = grant.binding as Record<string, unknown>;
    return binding.stageId === FIXED_TRACE_COMPONENT_SMOKE_STAGE_ID
      && binding.aggregateAdmissionFingerprint === admission.fingerprints.aggregateAdmission
      && sameJson(binding.cardinality, admission.cardinality)
      && sameJson(binding.pricing, admission.pricing);
  } catch { return false; }
}

function exactRuntimeEnablement(value: unknown, admission: Admission): value is FixedTraceComponentSmokeRuntimeEnablement {
  try {
    const enablement = snapshotFixedTraceJson(value, 'component smoke runtime enablement') as Record<string, unknown>;
    return hasExactKeys(enablement, ['aggregateAdmissionFingerprint', 'mode', 'stageId'])
      && enablement.mode === 'private_runtime_enabled'
      && enablement.stageId === FIXED_TRACE_COMPONENT_SMOKE_STAGE_ID
      && enablement.aggregateAdmissionFingerprint === admission.fingerprints.aggregateAdmission;
  } catch { return false; }
}

function reservationIdFor(grant: FixedTraceComponentSmokeAuthorizationGrant, admission: Admission): string {
  return `reservation_${createHash('sha256').update(canonicalJson({
    domain: 'adcp:addie:fixed-trace-component-smoke:reservation-correlation:v1\0',
    grantId: grant.grantId, nonce: grant.nonce, aggregateAdmissionFingerprint: admission.fingerprints.aggregateAdmission,
  }), 'utf8').digest('hex').slice(0, 32)}`;
}
function exactReservation(value: unknown, grant: FixedTraceComponentSmokeAuthorizationGrant, admission: Admission): value is FixedTraceComponentSmokeRunReservation {
  const maximumReservationUsd = admission.pricing.maximumReservationUsd;
  if (maximumReservationUsd === null) return false;
  try {
    const reservation = snapshotFixedTraceJson(value, 'component smoke reservation') as Record<string, unknown>;
    return hasExactKeys(reservation, ['aggregateAdmissionFingerprint', 'maximumProviderInvocations', 'maximumReservationUsd', 'reservationId'])
      && reservation.reservationId === reservationIdFor(grant, admission)
      && reservation.aggregateAdmissionFingerprint === admission.fingerprints.aggregateAdmission
      && reservation.maximumProviderInvocations === admission.cardinality.maximumProviderInvocations
      && reservation.maximumReservationUsd === maximumReservationUsd;
  } catch { return false; }
}

const RESERVE_REFUSALS = new Set<FixedTraceComponentSmokeLedgerRefusal>([
  'grant_not_registered', 'grant_already_consumed', 'grant_binding_mismatch', 'grant_not_active', 'reservation_mismatch',
  'admission_drift', 'unknown_attempt_exists', 'duplicate_attempt_id', 'count_exhausted', 'cost_exhausted', 'persistence_uncertain',
]);
const INTENT_REFUSALS = new Set(['duplicate_attempt_id', 'count_exhausted', 'cost_exhausted', 'admission_drift', 'persistence_uncertain']);
const TERMINAL_REFUSALS = new Set(['persistence_uncertain', 'admission_drift']);

/** Snapshot and exact-validate every untrusted ledger response before dereferencing it. */
export function parseFixedTraceComponentSmokeReserveResult(value: unknown):
  | Readonly<{ status: 'reserved'; reservation: unknown }>
  | Readonly<{ status: 'refused'; reason: FixedTraceComponentSmokeLedgerRefusal }>
  | null {
  try {
    const result = snapshotFixedTraceJson(value, 'reserve-and-consume result') as Record<string, unknown>;
    if (hasExactKeys(result, ['reservation', 'status']) && result.status === 'reserved') {
      return deepFreezeFixedTrace({ status: 'reserved' as const, reservation: result.reservation });
    }
    if (hasExactKeys(result, ['reason', 'status']) && result.status === 'refused'
      && typeof result.reason === 'string' && RESERVE_REFUSALS.has(result.reason as FixedTraceComponentSmokeLedgerRefusal)) {
      return deepFreezeFixedTrace({ status: 'refused' as const, reason: result.reason as FixedTraceComponentSmokeLedgerRefusal });
    }
  } catch { /* fail closed */ }
  return null;
}
function parseRecordedResult(value: unknown, boundary: string, refusals: ReadonlySet<string>):
  | Readonly<{ status: 'recorded' }> | Readonly<{ status: 'refused'; reason: string }> | null {
  try {
    const result = snapshotFixedTraceJson(value, boundary) as Record<string, unknown>;
    if (hasExactKeys(result, ['status']) && result.status === 'recorded') return deepFreezeFixedTrace({ status: 'recorded' as const });
    if (hasExactKeys(result, ['reason', 'status']) && result.status === 'refused'
      && typeof result.reason === 'string' && refusals.has(result.reason)) {
      return deepFreezeFixedTrace({ status: 'refused' as const, reason: result.reason });
    }
  } catch { /* fail closed */ }
  return null;
}
export function parseFixedTraceComponentSmokeIntentResult(value: unknown) {
  return parseRecordedResult(value, 'attempt-intent result', INTENT_REFUSALS);
}
export function parseFixedTraceComponentSmokeTerminalResult(value: unknown) {
  return parseRecordedResult(value, 'attempt-terminal result', TERMINAL_REFUSALS);
}

/** Deterministic serial test double. It cannot satisfy production durability. */
export class InMemoryFixedTraceComponentSmokeExecutionLedger implements FixedTraceComponentSmokeExecutionLedger {
  readonly durability = 'test_memory_only' as const;
  private readonly issued = new Map<string, FixedTraceComponentSmokeAuthorizationGrant>();
  private readonly consumed = new Set<string>();
  /** Grant IDs remain private map keys; persisted record values never contain them. */
  private readonly reservations = new Map<string, FixedTraceComponentSmokeRunReservation>();
  private readonly intents = new Map<string, FixedTraceComponentSmokeAttemptIntent>();
  private readonly terminals = new Map<string, FixedTraceComponentSmokeAttemptTerminal>();
  private chain: Promise<void> = Promise.resolve();
  constructor(private readonly trustedNow: () => Date) {}

  seedIssuedGrant(grant: FixedTraceComponentSmokeAuthorizationGrant): void {
    const copied = snapshotFixedTraceJson(grant, 'seed grant') as Record<string, unknown>;
    if (!hasExactKeys(copied, ['binding', 'expiresAt', 'grantId', 'issuedAt', 'nonce', 'version'])
      || !isIssuerGrantId(copied.grantId) || !isIssuerNonce(copied.nonce)
      || !exactIsoInstant(copied.issuedAt) || !exactIsoInstant(copied.expiresAt)
      || Date.parse(copied.issuedAt as string) >= Date.parse(copied.expiresAt as string)
      || !copied.binding || typeof copied.binding !== 'object'
      || !hasExactKeys(copied.binding, ['aggregateAdmissionFingerprint', 'cardinality', 'pricing', 'stageId'])) {
      throw new Error('In-memory ledger refuses a malformed grant seed');
    }
    const admission = fixedTraceComponentSmokeAdmission();
    const binding = copied.binding as Record<string, unknown>;
    if (copied.version !== FIXED_TRACE_COMPONENT_SMOKE_GRANT_VERSION
      || binding.stageId !== FIXED_TRACE_COMPONENT_SMOKE_STAGE_ID
      || binding.aggregateAdmissionFingerprint !== admission.fingerprints.aggregateAdmission
      || !sameJson(binding.cardinality, admission.cardinality) || !sameJson(binding.pricing, admission.pricing)) {
      throw new Error('In-memory ledger refuses a grant seed with unbound data');
    }
    this.issued.set(copied.grantId as string, deepFreezeFixedTrace({
      version: copied.version, grantId: copied.grantId, nonce: copied.nonce,
      issuedAt: copied.issuedAt, expiresAt: copied.expiresAt,
      binding: { stageId: binding.stageId, aggregateAdmissionFingerprint: binding.aggregateAdmissionFingerprint,
        cardinality: admission.cardinality, pricing: admission.pricing },
    }) as FixedTraceComponentSmokeAuthorizationGrant);
  }
  snapshotForTest(): Readonly<{ readonly consumedGrantCount: number; readonly intents: readonly FixedTraceComponentSmokeAttemptIntent[]; readonly terminals: readonly FixedTraceComponentSmokeAttemptTerminal[] }> {
    return deepFreezeFixedTrace({ consumedGrantCount: this.consumed.size, intents: [...this.intents.values()], terminals: [...this.terminals.values()] });
  }
  private serial<T>(operation: () => T | Promise<T>): Promise<T> {
    const next = this.chain.then(operation, operation);
    this.chain = next.then(() => undefined, () => undefined);
    return next;
  }
  async reserveAndConsume(input: Readonly<{ grant: FixedTraceComponentSmokeAuthorizationGrant; admission: Admission }>) {
    return this.serial(() => {
      if (!exactAdmissionReady(input.admission)) return { status: 'refused' as const, reason: 'admission_drift' as const };
      const registered = this.issued.get(input.grant.grantId);
      if (!registered) return { status: 'refused' as const, reason: 'grant_not_registered' as const };
      if (!sameJson(registered, input.grant)) return { status: 'refused' as const, reason: 'grant_binding_mismatch' as const };
      let now: Date;
      try { now = this.trustedNow(); } catch { return { status: 'refused' as const, reason: 'persistence_uncertain' as const }; }
      if (!(now instanceof Date) || !Number.isFinite(now.valueOf()) || !isFixedTraceComponentSmokeAuthorizationGrant(registered, input.admission, now)) {
        return { status: 'refused' as const, reason: 'grant_not_active' as const };
      }
      const previousReservation = this.reservations.get(input.grant.grantId);
      if (previousReservation) {
        if (previousReservation.aggregateAdmissionFingerprint !== input.admission.fingerprints.aggregateAdmission) return { status: 'refused' as const, reason: 'persistence_uncertain' as const };
        if ([...this.intents.values()].some((intent) => intent.reservation.reservationId === previousReservation.reservationId && !this.terminals.has(intent.attemptCorrelationId))) {
          return { status: 'refused' as const, reason: 'unknown_attempt_exists' as const };
        }
      }
      if (this.consumed.has(input.grant.grantId)) return { status: 'refused' as const, reason: 'grant_already_consumed' as const };
      if (!sameJson(input.grant.binding.cardinality, input.admission.cardinality)
        || !sameJson(input.grant.binding.pricing, input.admission.pricing)
        || input.grant.binding.aggregateAdmissionFingerprint !== input.admission.fingerprints.aggregateAdmission) return { status: 'refused' as const, reason: 'reservation_mismatch' as const };
      const maximumReservationUsd = input.admission.pricing.maximumReservationUsd;
      if (maximumReservationUsd === null || maximumReservationUsd > input.admission.pricing.providerCeilingUsd) return { status: 'refused' as const, reason: 'cost_exhausted' as const };
      const reservation = deepFreezeFixedTrace({ reservationId: reservationIdFor(input.grant, input.admission),
        aggregateAdmissionFingerprint: input.admission.fingerprints.aggregateAdmission,
        maximumProviderInvocations: input.admission.cardinality.maximumProviderInvocations, maximumReservationUsd });
      this.consumed.add(input.grant.grantId);
      this.reservations.set(input.grant.grantId, reservation);
      return { status: 'reserved' as const, reservation };
    });
  }
  async recordAttemptIntent(input: FixedTraceComponentSmokeAttemptIntent) {
    return this.serial(() => {
      let copied: Record<string, unknown>;
      try { copied = snapshotFixedTraceJson(input, 'attempt intent') as Record<string, unknown>; } catch { return { status: 'refused' as const, reason: 'persistence_uncertain' as const }; }
      if (!hasExactKeys(copied, ['attemptCorrelationId', 'cellId', 'invocationOrdinal', 'probeId', 'reservation'])
        || !safeCorrelationId(copied.attemptCorrelationId) || typeof copied.probeId !== 'string' || typeof copied.cellId !== 'string'
        || !Number.isSafeInteger(copied.invocationOrdinal) || (copied.invocationOrdinal as number) < 1) return { status: 'refused' as const, reason: 'admission_drift' as const };
      const reservation = [...this.reservations.values()].find((candidate) => candidate.reservationId === input.reservation.reservationId);
      if (!reservation || !sameJson(reservation, input.reservation)) return { status: 'refused' as const, reason: 'admission_drift' as const };
      if (this.intents.has(input.attemptCorrelationId)) return { status: 'refused' as const, reason: 'duplicate_attempt_id' as const };
      const count = [...this.intents.values()].filter((intent) => intent.reservation.reservationId === reservation.reservationId).length;
      if (count >= reservation.maximumProviderInvocations) return { status: 'refused' as const, reason: 'count_exhausted' as const };
      if (reservation.maximumReservationUsd < 0) return { status: 'refused' as const, reason: 'cost_exhausted' as const };
      this.intents.set(copied.attemptCorrelationId as string, deepFreezeFixedTrace({ reservation,
        attemptCorrelationId: copied.attemptCorrelationId, probeId: copied.probeId, cellId: copied.cellId,
        invocationOrdinal: copied.invocationOrdinal }) as FixedTraceComponentSmokeAttemptIntent);
      return { status: 'recorded' as const };
    });
  }
  async recordAttemptTerminal(input: FixedTraceComponentSmokeAttemptTerminal) {
    return this.serial(() => {
      let copied: Record<string, unknown>;
      try { copied = snapshotFixedTraceJson(input, 'attempt terminal') as Record<string, unknown>; } catch { return { status: 'refused' as const, reason: 'persistence_uncertain' as const }; }
      if (!hasExactKeys(copied, ['attemptCorrelationId', 'outcome', 'reservation']) || !safeCorrelationId(copied.attemptCorrelationId)
        || (copied.outcome !== 'succeeded' && copied.outcome !== 'provider_failed')) return { status: 'refused' as const, reason: 'admission_drift' as const };
      const intent = this.intents.get(input.attemptCorrelationId);
      if (!intent || !sameJson(intent.reservation, input.reservation) || this.terminals.has(input.attemptCorrelationId)) return { status: 'refused' as const, reason: 'admission_drift' as const };
      this.terminals.set(copied.attemptCorrelationId as string, deepFreezeFixedTrace({ reservation: intent.reservation,
        attemptCorrelationId: copied.attemptCorrelationId, outcome: copied.outcome }) as FixedTraceComponentSmokeAttemptTerminal);
      return { status: 'recorded' as const };
    });
  }
}

function assignmentsFor(admission: Admission, reservation: FixedTraceComponentSmokeRunReservation): readonly FixedTraceComponentSmokeProviderAssignment[] | null {
  const cells = new Map(admission.cells.map((cell) => [cell.id, cell]));
  const assignments: FixedTraceComponentSmokeProviderAssignment[] = [];
  for (const probe of admission.probes) for (const control of admission.stageControls.controls) {
    const cell = cells.get(control.cellId);
    if (!cell || cell.role !== control.role) return null;
    for (let ordinal = 1; ordinal <= control.maxInvocationsPerCase; ordinal += 1) {
      const attemptCorrelationId = `attempt_${createHash('sha256').update(canonicalJson({
        domain: 'adcp:addie:fixed-trace-component-smoke:provider-attempt-correlation:v1\0', reservationId: reservation.reservationId,
        probeId: probe.id, cellId: cell.id, invocationOrdinal: ordinal,
      }), 'utf8').digest('hex').slice(0, 32)}`;
      assignments.push(Object.freeze({ attemptCorrelationId, probeId: probe.id, cellId: cell.id, role: cell.role,
        provider: cell.provider, model: cell.model, effort: cell.effort, invocationOrdinal: ordinal }));
    }
  }
  const uniqueAttempts = new Set(assignments.map((assignment) => assignment.attemptCorrelationId));
  return assignments.length === admission.cardinality.maximumProviderInvocations && uniqueAttempts.size === assignments.length
    ? Object.freeze(assignments) : null;
}

/** Dormant orchestrator: grant + enablement + durable ledger + adapter are all required, and this module still refuses before their use. */
export async function runFixedTraceComponentSmoke(input: Readonly<{
  readonly grant: unknown; readonly ledger?: FixedTraceComponentSmokeExecutionLedger;
  readonly adapter?: FixedTraceComponentSmokeProviderAdapter; readonly runtimeEnablement?: unknown;
  readonly now: Date; readonly admission?: Admission;
}>): Promise<FixedTraceComponentSmokeExecutionResult> {
  const suppliedAdmission = input.admission ?? fixedTraceComponentSmokeAdmission();
  if (!exactAdmissionReady(suppliedAdmission)) return { status: 'refused', reason: 'admission_not_ready' };
  const admission = fixedTraceComponentSmokeAdmission();
  if (!isFixedTraceComponentSmokeAuthorizationGrant(input.grant, admission, input.now)) return { status: 'refused', reason: 'invalid_grant' };
  const grant = deepFreezeFixedTrace(snapshotFixedTraceJson(input.grant, 'validated component smoke authorization grant')) as FixedTraceComponentSmokeAuthorizationGrant;
  if (!exactRuntimeEnablement(input.runtimeEnablement, admission)) return { status: 'refused', reason: 'runtime_not_enabled' };
  if (!FIXED_TRACE_COMPONENT_SMOKE_CURRENT_MODULE_CAN_DISPATCH) return { status: 'refused', reason: 'private_durable_runtime_unavailable' };
  if (!input.ledger || input.ledger.durability !== 'private_durable_atomic') return { status: 'refused', reason: 'durable_ledger_required' };
  if (!input.adapter) return { status: 'refused', reason: 'provider_adapter_required' };
  let reserved;
  try { reserved = parseFixedTraceComponentSmokeReserveResult(await input.ledger.reserveAndConsume({ grant, admission })); } catch { return { status: 'refused', reason: 'persistence_uncertain' }; }
  if (!reserved) return { status: 'refused', reason: 'persistence_uncertain' };
  if (reserved.status !== 'reserved') return { status: 'refused', reason: reserved.reason };
  if (!exactReservation(reserved.reservation, grant, admission)) return { status: 'refused', reason: 'reservation_mismatch' };
  const assignments = assignmentsFor(admission, reserved.reservation as FixedTraceComponentSmokeRunReservation);
  if (!assignments) return { status: 'refused', reason: 'assignment_drift' };
  let providerInvocations = 0;
  for (const assignment of assignments) {
    let intent;
    try { intent = parseFixedTraceComponentSmokeIntentResult(await input.ledger.recordAttemptIntent({ reservation: reserved.reservation as FixedTraceComponentSmokeRunReservation, attemptCorrelationId: assignment.attemptCorrelationId, probeId: assignment.probeId, cellId: assignment.cellId, invocationOrdinal: assignment.invocationOrdinal })); } catch { return { status: 'refused', reason: 'persistence_uncertain' }; }
    if (!intent) return { status: 'refused', reason: 'persistence_uncertain' };
    if (intent.status !== 'recorded') return { status: 'refused', reason: intent.reason };
    let outcome: FixedTraceComponentSmokeAttemptTerminal['outcome'] = 'succeeded';
    try { await input.adapter.invoke(assignment); providerInvocations += 1; } catch { outcome = 'provider_failed'; providerInvocations += 1; }
    let terminal;
    try { terminal = parseFixedTraceComponentSmokeTerminalResult(await input.ledger.recordAttemptTerminal({ reservation: reserved.reservation as FixedTraceComponentSmokeRunReservation, attemptCorrelationId: assignment.attemptCorrelationId, outcome })); } catch { return { status: 'refused', reason: 'persistence_uncertain' }; }
    if (!terminal) return { status: 'refused', reason: 'persistence_uncertain' };
    if (terminal.status !== 'recorded') return { status: 'refused', reason: terminal.reason };
    if (outcome === 'provider_failed') return { status: 'provider_failed', providerInvocations };
  }
  return { status: 'completed', providerInvocations: assignments.length };
}
