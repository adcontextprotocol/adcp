import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { fixedTraceComponentSmokeAdmission } from './fixed-trace-component-smoke-admission.js';
import { datedPricingCostMicros, datedPricingProfilesForFixedTrace } from './dated-pricing-cohort.js';
import {
  fixedTraceComponentSmokeVerifiedGrantSignatureDigestForLedger,
  isFixedTraceComponentSmokeVerifiedGrant,
  type FixedTraceComponentSmokeVerifiedGrant,
} from './fixed-trace-component-smoke-private-authorization.js';
import { snapshotFixedTraceJson } from './fixed-trace-safe-snapshot.js';

/**
 * No code constructs this ledger in the application. It is a database-only
 * state machine for a later, separately reviewed private one-shot runtime.
 * It has no provider dependency and cannot dispatch anything.
 */
export const FIXED_TRACE_COMPONENT_SMOKE_PRIVATE_LEDGER_IS_CONSTRUCTED = false as const;
/** Domain prefixes that a later isolated runtime must use when HMACing evidence. */
export const FIXED_TRACE_COMPONENT_SMOKE_PREPARED_REQUEST_HMAC_DOMAIN =
  'adcp:addie:fixed-trace-component-smoke:prepared-request:v1\0' as const;
export const FIXED_TRACE_COMPONENT_SMOKE_RESPONSE_HMAC_DOMAIN =
  'adcp:addie:fixed-trace-component-smoke:provider-response:v1\0' as const;

type Admission = ReturnType<typeof fixedTraceComponentSmokeAdmission>;
type Disposition = Admission['privateRuntimePlan'][number]['dispatchDisposition'];
export type FixedTraceComponentSmokeLedgerRefusal =
  | 'grant_not_active' | 'grant_already_consumed' | 'admission_drift'
  | 'unknown_exposure' | 'run_halted' | 'duplicate_attempt_id' | 'intent_required'
  | 'plan_mismatch' | 'cost_exhausted' | 'persistence_uncertain';

export interface FixedTraceComponentSmokeReservation {
  readonly reservationId: string;
  readonly authorizationDigest: string;
  readonly entryCount: 168;
  readonly providerDispatchEntryCount: 126;
  readonly reservationMicrodollars: 2819484;
}
export interface FixedTraceComponentSmokePlanEntry {
  readonly assignmentId: string;
  readonly probeId: string;
  readonly cellId: string;
  readonly disposition: Disposition;
  readonly maximumProviderInvocations: number;
  readonly provider: string;
  readonly model: string;
  readonly effort: string;
  readonly pricingProfileId: string;
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly timeoutMs: number;
  readonly retries: 0;
  readonly reservedMicrodollars: readonly number[];
}
export interface FixedTraceComponentSmokeProviderIntent {
  readonly reservation: FixedTraceComponentSmokeReservation;
  readonly attemptId: string;
  readonly assignmentId: string;
  readonly invocationOrdinal: number;
  /** HMAC of the exact frozen provider request. Never the request itself. */
  readonly preparedRequestHmac: string;
}
export interface FixedTraceComponentSmokeTerminal {
  readonly reservation: FixedTraceComponentSmokeReservation;
  readonly attemptId: string;
  readonly status: 'succeeded' | 'provider_failed' | 'timeout_after_dispatch' | 'malformed_response' | 'identity_mismatch' | 'missing_usage';
  /** HMAC-bound normalized response effect; only successes can be final or continue. */
  readonly responseDisposition: 'final_response' | 'tool_continuation_required' | null;
  readonly usage: Readonly<{ inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; latencyMs: number }> | null;
  readonly returnedIdentity: Readonly<{ provider: string; model: string; effort: string }> | null;
  readonly responseHmac: string | null;
}
export interface FixedTraceComponentSmokeNonDispatchTerminal {
  readonly reservation: FixedTraceComponentSmokeReservation;
  readonly assignmentId: string;
  readonly status: 'local_terminal' | 'pre_dispatch_fault';
}
/** Zero-call assignment outcome used only to close an already halted denominator. */
export interface FixedTraceComponentSmokeNotExecutedAfterHalt {
  readonly reservation: FixedTraceComponentSmokeReservation;
  readonly assignmentId: string;
}
/** One terminal outcome for a provider-dispatch assignment, never an attempt. */
export interface FixedTraceComponentSmokeProviderAssignmentTerminal {
  readonly reservation: FixedTraceComponentSmokeReservation;
  readonly assignmentId: string;
  readonly status: 'provider_completed' | 'provider_failed';
  readonly finalInvocationOrdinal: number;
}
/** Closes a started assignment whose committed provider exposure is ambiguous. */
export interface FixedTraceComponentSmokeProviderUnknownExposure {
  readonly reservation: FixedTraceComponentSmokeReservation;
  readonly assignmentId: string;
}

const HEX = /^[a-f0-9]{64}$/;
const ATTEMPT_ID = /^attempt_[a-f0-9]{32}$/;
const MAX_LATENCY_MS = 86_400_000;

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error('non-canonical number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
  }
  throw new Error('non-canonical value');
}
function sha256(value: unknown): string { return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex'); }
function exactKeys(value: object, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort(); const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
function isHash(value: unknown): value is string { return typeof value === 'string' && HEX.test(value); }
function pgSafeInt(value: unknown, maximum: number): number | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 && value <= maximum ? value : null;
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= maximum ? parsed : null;
}
function safeString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && /^[a-z0-9._:-]+$/i.test(value);
}
function expectedPlanEntry(assignmentId: string): FixedTraceComponentSmokePlanEntry | null {
  return fixedTraceComponentSmokePrivateLedgerPlan()?.find((entry) => entry.assignmentId === assignmentId) ?? null;
}
function pgPlanMatches(row: Record<string, unknown>, expected: FixedTraceComponentSmokePlanEntry): boolean {
  const reservations = row.reserved_microdollars;
  return row.probe_id === expected.probeId && row.cell_id === expected.cellId
    && row.disposition === expected.disposition
    && pgSafeInt(row.maximum_provider_invocations, 2) === expected.maximumProviderInvocations
    && row.requested_provider === expected.provider && row.requested_model === expected.model
    && row.requested_effort === expected.effort && row.pricing_profile_id === expected.pricingProfileId
    && pgSafeInt(row.max_input_tokens, 1_000_000) === expected.maxInputTokens
    && pgSafeInt(row.max_output_tokens, 1_000_000) === expected.maxOutputTokens
    && pgSafeInt(row.timeout_ms, MAX_LATENCY_MS) === expected.timeoutMs
    && pgSafeInt(row.retries, 0) === 0
    && Array.isArray(reservations) && reservations.length === expected.reservedMicrodollars.length
    && reservations.every((value, index) => pgSafeInt(value, 2_819_484) === expected.reservedMicrodollars[index]);
}

/** Derives, rather than accepts, the exact 168-entry admitted plan. */
export function fixedTraceComponentSmokePrivateLedgerPlan(): readonly FixedTraceComponentSmokePlanEntry[] | null {
  const admission = fixedTraceComponentSmokeAdmission();
  if (admission.status !== 'ready_for_explicit_paid_authorization'
    || admission.fingerprints.aggregateAdmission !== '731930c18475672a0ec6b44c9ff91fa89d30c441e34af32b536a28258271077d'
    || admission.cardinality.caseCellAssignments !== 168
    || admission.cardinality.providerDispatchCaseCellAssignments !== 126
    || admission.cardinality.preDispatchFaultCaseCellAssignments !== 21
    || admission.cardinality.maximumProviderInvocations !== 192
    || admission.pricing.reservationMicrodollars !== 2_819_484
    || admission.pricing.providerCeilingUsd !== 5) return null;
  const cells = new Map(admission.cells.map((cell) => [cell.id, cell]));
  const entries = admission.privateRuntimePlan.map((entry) => {
    const cell = cells.get(entry.cellId);
    if (!cell || entry.maximumProviderInvocations !== entry.perAttemptReservationMicrodollars.length || entry.sdkAutomaticRetries !== 0) return null;
    return Object.freeze({
      assignmentId: sha256({ domain: 'adcp:addie:fixed-trace-component-smoke:plan-entry:v1\0', fingerprint: admission.fingerprints.aggregateAdmission, probeId: entry.probeId, cellId: entry.cellId }),
      probeId: entry.probeId, cellId: entry.cellId, disposition: entry.dispatchDisposition,
      maximumProviderInvocations: entry.maximumProviderInvocations, provider: cell.provider, model: cell.model, effort: cell.effort,
      pricingProfileId: entry.pricingProfileId, maxInputTokens: entry.maxInputTokensPerInvocation,
      maxOutputTokens: entry.maxOutputTokensPerInvocation, timeoutMs: entry.timeoutMs, retries: 0 as const,
      reservedMicrodollars: Object.freeze([...entry.perAttemptReservationMicrodollars]),
    });
  });
  if (entries.some((entry) => entry === null)) return null;
  const plan = entries as FixedTraceComponentSmokePlanEntry[];
  const total = plan.reduce((sum, entry) => sum + entry.reservedMicrodollars.reduce((subtotal, micros) => subtotal + micros, 0), 0);
  const dispatch = plan.filter((entry) => entry.disposition === 'provider_dispatch');
  const nonDispatchValid = plan.filter((entry) => entry.disposition !== 'provider_dispatch')
    .every((entry) => entry.maximumProviderInvocations === 0 && entry.reservedMicrodollars.length === 0);
  return plan.length === 168 && new Set(plan.map((entry) => entry.assignmentId)).size === 168
    && dispatch.length === 126 && dispatch.reduce((sum, entry) => sum + entry.maximumProviderInvocations, 0) === 192
    && total === 2_819_484 && plan.every((entry) => entry.reservedMicrodollars.every((micros) => Number.isSafeInteger(micros) && micros > 0 && micros <= 2_819_484))
    && nonDispatchValid ? Object.freeze(plan) : null;
}

function reservationIdForAuthorizationDigest(authorizationDigest: string): string {
  return `reservation_${sha256({ domain: 'adcp:addie:fixed-trace-component-smoke:reservation:v1\0', authorizationDigest }).slice(0, 32)}`;
}
function reservationFor(grant: FixedTraceComponentSmokeVerifiedGrant): FixedTraceComponentSmokeReservation {
  return Object.freeze({ reservationId: reservationIdForAuthorizationDigest(grant.grantDigest),
    authorizationDigest: grant.grantDigest, entryCount: 168, providerDispatchEntryCount: 126, reservationMicrodollars: 2_819_484 });
}
function result(status: 'reserved', reservation: FixedTraceComponentSmokeReservation): Readonly<{ status: 'reserved'; reservation: FixedTraceComponentSmokeReservation }>;
function result(status: 'recorded'): Readonly<{ status: 'recorded' }>;
function result(status: 'refused', reason: FixedTraceComponentSmokeLedgerRefusal): Readonly<{ status: 'refused'; reason: FixedTraceComponentSmokeLedgerRefusal }>;
function result(status: string, value?: unknown) { return status === 'reserved' ? Object.freeze({ status, reservation: value }) : status === 'recorded' ? Object.freeze({ status }) : Object.freeze({ status, reason: value }); }

/**
 * Checked-out-client only implementation.  Every mutating method has one
 * transaction and never retries a statement, a transaction, or a commit.
 */
export class PostgresFixedTraceComponentSmokePrivateLedger {
  constructor(private readonly pool: Pick<Pool, 'connect'>) {}

  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let began = false;
    try {
      await client.query('BEGIN'); began = true;
      const output = await work(client);
      await client.query('COMMIT');
      return output;
    } catch (error) {
      if (began) await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  async reserveAndConsume(grant: FixedTraceComponentSmokeVerifiedGrant): Promise<Readonly<{ status: 'reserved'; reservation: FixedTraceComponentSmokeReservation }> | Readonly<{ status: 'refused'; reason: FixedTraceComponentSmokeLedgerRefusal }>> {
    const plan = fixedTraceComponentSmokePrivateLedgerPlan();
    const signatureDigest = fixedTraceComponentSmokeVerifiedGrantSignatureDigestForLedger(grant);
    if (!plan || !isFixedTraceComponentSmokeVerifiedGrant(grant) || !signatureDigest || !isHash(grant.grantDigest) || !isHash(grant.signedPayloadDigest) || !isHash(grant.payload.nonceCommitment)) return result('refused', 'admission_drift');
    const reservation = reservationFor(grant);
    try {
      return await this.transaction(async (client) => {
        const inserted = await client.query<{ authorization_digest: string }>(
          `INSERT INTO addie_fixed_trace_component_smoke_authorizations (
             authorization_digest, signed_payload_digest, signature_digest, kid, nonce_commitment, grant_version,
             stage_id, admission_version, aggregate_admission_fingerprint, probes, router_cells, generation_cells, total_cells, repetitions, assignments,
             provider_dispatch_assignments, local_terminal_assignments, pre_dispatch_fault_assignments,
             maximum_planned_invocation_slots, maximum_provider_invocations, reservation_microdollars, provider_ceiling_microdollars,
             pricing_cohort_digest, issued_at, expires_at, status, consumed_at, reservation_id
           )
           SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24::timestamptz,$25::timestamptz,'consumed',clock_timestamp(),$26
           WHERE $24::timestamptz <= clock_timestamp() AND $25::timestamptz > clock_timestamp()
           ON CONFLICT (authorization_digest) DO NOTHING
           RETURNING authorization_digest`,
          [grant.grantDigest, grant.signedPayloadDigest, signatureDigest, grant.payload.kid, grant.payload.nonceCommitment,
            grant.payload.grantVersion, grant.payload.stageId, grant.payload.admissionVersion, grant.payload.aggregateAdmissionFingerprint,
            grant.payload.cardinality.probes, grant.payload.cardinality.routerCells, grant.payload.cardinality.generationCells,
            grant.payload.cardinality.totalCells, grant.payload.cardinality.repetitions, grant.payload.cardinality.caseCellAssignments,
            grant.payload.cardinality.providerDispatchCaseCellAssignments, grant.payload.cardinality.localTerminalCaseCellAssignments,
            grant.payload.cardinality.preDispatchFaultCaseCellAssignments, grant.payload.cardinality.maximumPlannedInvocationSlots,
            grant.payload.cardinality.maximumProviderInvocations, grant.payload.reservationMicrodollars,
            grant.payload.providerCeilingMicrodollars, grant.payload.pricingCohortDigest, grant.payload.issuedAt,
            grant.payload.expiresAt, reservation.reservationId],
        );
        if (inserted.rowCount !== 1) {
          const existing = await client.query<{ status: string; expires_at: string }>(
            'SELECT status, expires_at FROM addie_fixed_trace_component_smoke_authorizations WHERE authorization_digest = $1 FOR UPDATE', [grant.grantDigest]);
          if (existing.rowCount !== 1) return result('refused', 'persistence_uncertain');
          if (existing.rows[0]!.status === 'unknown_exposure') return result('refused', 'unknown_exposure');
          return result('refused', 'grant_already_consumed');
        }
        for (const entry of plan) {
          await client.query(
            `INSERT INTO addie_fixed_trace_component_smoke_run_plan
             (authorization_digest, assignment_id, probe_id, cell_id, disposition, maximum_provider_invocations,
              requested_provider, requested_model, requested_effort, pricing_profile_id, max_input_tokens,
              max_output_tokens, timeout_ms, retries, reserved_microdollars)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
            [grant.grantDigest, entry.assignmentId, entry.probeId, entry.cellId, entry.disposition, entry.maximumProviderInvocations,
              entry.provider, entry.model, entry.effort, entry.pricingProfileId, entry.maxInputTokens, entry.maxOutputTokens,
              entry.timeoutMs, entry.retries, entry.reservedMicrodollars],
          );
        }
        return result('reserved', reservation);
      });
    } catch { return result('refused', 'persistence_uncertain'); }
  }

  async recordProviderIntent(input: unknown): Promise<Readonly<{ status: 'recorded' }> | Readonly<{ status: 'refused'; reason: FixedTraceComponentSmokeLedgerRefusal }>> {
    const parsed = parseProviderIntent(input);
    if (!parsed) return result('refused', 'plan_mismatch');
    try {
      return await this.transaction(async (client) => {
        const plan = await client.query<Record<string, unknown>>(
          `SELECT probe_id, cell_id, disposition, maximum_provider_invocations, requested_provider, requested_model,
                  requested_effort, pricing_profile_id, max_input_tokens, max_output_tokens, timeout_ms, retries,
                  reserved_microdollars
             FROM addie_fixed_trace_component_smoke_run_plan
            WHERE authorization_digest = $1 AND assignment_id = $2 FOR UPDATE`,
          [parsed.reservation.authorizationDigest, parsed.assignmentId]);
        const expected = expectedPlanEntry(parsed.assignmentId);
        if (!expected || plan.rowCount !== 1 || !pgPlanMatches(plan.rows[0]!, expected)
          || expected.disposition !== 'provider_dispatch' || parsed.invocationOrdinal > expected.maximumProviderInvocations) return result('refused', 'plan_mismatch');
        const unresolved = await client.query('SELECT 1 FROM addie_fixed_trace_component_smoke_attempts WHERE authorization_digest = $1 AND status = \'intent_recorded\' LIMIT 1', [parsed.reservation.authorizationDigest]);
        if (unresolved.rowCount !== 0) {
          await this.closeOpenIntentsAsUnknownExposure(client, parsed.reservation);
          return result('refused', 'unknown_exposure');
        }
        if (parsed.invocationOrdinal > 1) {
          const predecessor = await client.query<{ status: string; response_disposition: string | null }>(
            'SELECT status, response_disposition FROM addie_fixed_trace_component_smoke_attempts WHERE authorization_digest = $1 AND assignment_id = $2 AND invocation_ordinal = $3 FOR UPDATE',
            [parsed.reservation.authorizationDigest, parsed.assignmentId, parsed.invocationOrdinal - 1],
          );
          if (predecessor.rowCount !== 1 || predecessor.rows[0]!.status !== 'succeeded'
            || predecessor.rows[0]!.response_disposition !== 'tool_continuation_required') return result('refused', 'intent_required');
        }
        const duplicate = await client.query('SELECT 1 FROM addie_fixed_trace_component_smoke_attempts WHERE attempt_id = $1 FOR UPDATE', [parsed.attemptId]);
        if (duplicate.rowCount !== 0) return result('refused', 'duplicate_attempt_id');
        const slot = await client.query('SELECT 1 FROM addie_fixed_trace_component_smoke_attempts WHERE authorization_digest = $1 AND assignment_id = $2 AND invocation_ordinal = $3 FOR UPDATE', [parsed.reservation.authorizationDigest, parsed.assignmentId, parsed.invocationOrdinal]);
        if (slot.rowCount !== 0) return result('refused', 'duplicate_attempt_id');
        const auth = await client.query<{ status: string }>('SELECT status FROM addie_fixed_trace_component_smoke_authorizations WHERE authorization_digest = $1 AND reservation_id = $2 FOR UPDATE', [parsed.reservation.authorizationDigest, parsed.reservation.reservationId]);
        if (auth.rowCount !== 1) return result('refused', 'grant_already_consumed');
        if (auth.rows[0]!.status === 'unknown_exposure') return result('refused', 'unknown_exposure');
        if (auth.rows[0]!.status === 'halted') return result('refused', 'run_halted');
        if (auth.rows[0]!.status !== 'consumed') return result('refused', 'admission_drift');
        await client.query(
          `INSERT INTO addie_fixed_trace_component_smoke_attempts
           (attempt_id, authorization_digest, assignment_id, invocation_ordinal, status, prepared_request_hmac)
           VALUES ($1,$2,$3,$4,'intent_recorded',$5)`,
          [parsed.attemptId, parsed.reservation.authorizationDigest, parsed.assignmentId, parsed.invocationOrdinal, parsed.preparedRequestHmac],
        );
        return result('recorded');
      });
    } catch { return result('refused', 'persistence_uncertain'); }
  }

  async recordTerminal(input: unknown): Promise<Readonly<{ status: 'recorded' }> | Readonly<{ status: 'refused'; reason: FixedTraceComponentSmokeLedgerRefusal }>> {
    const parsed = parseTerminal(input);
    if (!parsed) return result('refused', 'plan_mismatch');
    try {
      return await this.transaction(async (client) => {
        const attempt = await client.query<{ assignment_id: string; status: string; invocation_ordinal: unknown; probe_id: unknown; cell_id: unknown; disposition: unknown; maximum_provider_invocations: unknown; retries: unknown; requested_provider: string; requested_model: string; requested_effort: string; pricing_profile_id: string; max_input_tokens: unknown; max_output_tokens: unknown; timeout_ms: unknown; reserved_microdollars: unknown[] }>(
          `SELECT a.assignment_id, a.status, a.invocation_ordinal, p.probe_id, p.cell_id, p.disposition, p.maximum_provider_invocations, p.retries,
                  p.requested_provider, p.requested_model, p.requested_effort, p.pricing_profile_id, p.max_input_tokens, p.max_output_tokens, p.timeout_ms, p.reserved_microdollars
           FROM addie_fixed_trace_component_smoke_attempts a
           JOIN addie_fixed_trace_component_smoke_run_plan p ON p.authorization_digest = a.authorization_digest AND p.assignment_id = a.assignment_id
           WHERE a.attempt_id = $1 AND a.authorization_digest = $2 FOR UPDATE OF a`, [parsed.attemptId, parsed.reservation.authorizationDigest]);
        if (attempt.rowCount !== 1 || attempt.rows[0]!.status !== 'intent_recorded') return result('refused', 'intent_required');
        const row = attempt.rows[0]!;
        const expected = expectedPlanEntry(row.assignment_id);
        if (!expected || !pgPlanMatches(row as unknown as Record<string, unknown>, expected)) return this.settlePostIntentFailure(client, parsed, 'pricing_unavailable', 'unknown_exposure');
        if (parsed.usage && (parsed.returnedIdentity?.provider !== row.requested_provider
          || parsed.returnedIdentity?.model !== row.requested_model
          || parsed.returnedIdentity?.effort !== row.requested_effort)) return this.settlePostIntentFailure(client, parsed, 'identity_mismatch', 'unknown_exposure');
        const ordinal = pgSafeInt(row.invocation_ordinal, 2);
        const maxInput = pgSafeInt(row.max_input_tokens, 1_000_000);
        const maxOutput = pgSafeInt(row.max_output_tokens, 1_000_000);
        const timeout = pgSafeInt(row.timeout_ms, MAX_LATENCY_MS);
        if (ordinal === null || maxInput === null || maxOutput === null || timeout === null) return this.settlePostIntentFailure(client, parsed, 'pricing_unavailable', 'unknown_exposure');
        const reservedForOrdinal = pgSafeInt(row.reserved_microdollars[ordinal - 1], 2_819_484);
        const maximumInvocations = pgSafeInt(row.maximum_provider_invocations, 2);
        const profile = datedPricingProfilesForFixedTrace().find((candidate) => candidate.profileId === row.pricing_profile_id);
        if (parsed.usage && (!profile || profile.provider !== row.requested_provider || profile.model !== row.requested_model)) return this.settlePostIntentFailure(client, parsed, 'pricing_unavailable', 'unknown_exposure');
        let spent: number | null = null;
        try { spent = parsed.usage ? datedPricingCostMicros(profile!, parsed.usage) : null; } catch { return this.settlePostIntentFailure(client, parsed, 'pricing_unavailable', 'unknown_exposure'); }
        if (parsed.status === 'succeeded' && parsed.responseDisposition === 'tool_continuation_required'
          && (maximumInvocations === null || ordinal === maximumInvocations)) {
          return this.settlePostIntentFailure(client, parsed, 'invalid_limits', 'halted', 'plan_mismatch', spent);
        }
        // A complete receipt remains accounting evidence even if it breaches a
        // pinned input/output/timeout limit. Never replace known exposure with
        // NULL merely because this one-shot run must halt.
        const additiveCacheOverLimit = parsed.usage !== null && profile !== undefined && (
          (profile.cacheReadAccounting === 'additive' && parsed.usage.cacheReadTokens > maxInput)
          || (profile.cacheWriteAccounting === 'additive' && parsed.usage.cacheWriteTokens > maxInput)
        );
        if (parsed.usage && (parsed.usage.inputTokens > maxInput || additiveCacheOverLimit
          || parsed.usage.outputTokens > maxOutput || parsed.usage.latencyMs > timeout)) return this.settlePostIntentFailure(client, parsed, 'invalid_limits', 'halted', 'plan_mismatch', spent);
        // PostgreSQL forbids FOR UPDATE directly on an aggregate. Lock the
        // contributing rows first; the authorization row above serializes all
        // settlements, and this preserves a real checked-out-client boundary.
        const prior = await client.query<{ spent: unknown }>(
          `WITH locked_attempts AS (
             SELECT actual_cost_microdollars
               FROM addie_fixed_trace_component_smoke_attempts
              WHERE authorization_digest = $1
              FOR UPDATE
           )
           SELECT COALESCE(SUM(actual_cost_microdollars), 0)::bigint AS spent
             FROM locked_attempts`,
          [parsed.reservation.authorizationDigest],
        );
        const auth = await client.query<{ status: string; reservation_microdollars: unknown; provider_ceiling_microdollars: unknown }>('SELECT status, reservation_microdollars, provider_ceiling_microdollars FROM addie_fixed_trace_component_smoke_authorizations WHERE authorization_digest = $1 AND reservation_id = $2 FOR UPDATE', [parsed.reservation.authorizationDigest, parsed.reservation.reservationId]);
        if (auth.rowCount !== 1) return result('refused', 'grant_already_consumed');
        if (auth.rows[0]!.status === 'unknown_exposure') return result('refused', 'unknown_exposure');
        if (auth.rows[0]!.status === 'halted') return result('refused', 'run_halted');
        if (auth.rows[0]!.status !== 'consumed') return result('refused', 'admission_drift');
        const priorSpent = prior.rowCount === 1 ? pgSafeInt(prior.rows[0]!.spent, 5_000_000) : null;
        const reservationLimit = pgSafeInt(auth.rows[0]!.reservation_microdollars, 2_819_484);
        const providerLimit = pgSafeInt(auth.rows[0]!.provider_ceiling_microdollars, 5_000_000);
        if (reservedForOrdinal === null || priorSpent === null || reservationLimit === null || providerLimit === null
          || (spent !== null && (spent > reservedForOrdinal || priorSpent + spent > reservationLimit || priorSpent + spent > providerLimit))) {
          return this.settlePostIntentFailure(client, parsed, 'invalid_limits', 'halted', 'cost_exhausted', spent);
        }
        await client.query(
          `UPDATE addie_fixed_trace_component_smoke_attempts
          SET status = $3, response_disposition = $4, input_tokens = $5, output_tokens = $6, cache_read_tokens = $7, cache_write_tokens = $8, actual_cost_microdollars = $9, latency_ms = $10, response_hmac = $11,
               returned_provider = $12, returned_model = $13, returned_effort = $14, terminal_at = clock_timestamp()
           WHERE attempt_id = $1 AND authorization_digest = $2`,
          [parsed.attemptId, parsed.reservation.authorizationDigest, parsed.status, parsed.responseDisposition, parsed.usage?.inputTokens ?? null,
            parsed.usage?.outputTokens ?? null, parsed.usage?.cacheReadTokens ?? null, parsed.usage?.cacheWriteTokens ?? null,
            parsed.usage ? spent : null, parsed.usage?.latencyMs ?? null, parsed.responseHmac,
            parsed.returnedIdentity?.provider ?? null, parsed.returnedIdentity?.model ?? null, parsed.returnedIdentity?.effort ?? null],
        );
        if (parsed.status !== 'succeeded') {
          await client.query(
            `UPDATE addie_fixed_trace_component_smoke_authorizations
             SET status = $2::varchar, unknown_exposure_at = CASE WHEN $2::varchar = 'unknown_exposure' THEN clock_timestamp() ELSE NULL END
             WHERE authorization_digest = $1 AND reservation_id = $3 AND status = 'consumed'`,
            [parsed.reservation.authorizationDigest, 'unknown_exposure', parsed.reservation.reservationId],
          );
        }
        return result('recorded');
      });
    } catch { return result('refused', 'persistence_uncertain'); }
  }

  /** A committed intent is never left open on any later validation failure. */
  private async settlePostIntentFailure(
    client: PoolClient,
    parsed: FixedTraceComponentSmokeTerminal,
    terminalStatus: 'invalid_limits' | 'pricing_unavailable' | 'identity_mismatch',
    authorizationStatus: 'halted' | 'unknown_exposure',
    refusal: FixedTraceComponentSmokeLedgerRefusal = 'plan_mismatch',
    observedCostMicrodollars: number | null = null,
  ): Promise<Readonly<{ status: 'refused'; reason: FixedTraceComponentSmokeLedgerRefusal }>> {
    await client.query(
      `UPDATE addie_fixed_trace_component_smoke_attempts
          SET status = $3, input_tokens = $4, output_tokens = $5, cache_read_tokens = $6, cache_write_tokens = $7,
              actual_cost_microdollars = NULL, observed_cost_microdollars = $8, latency_ms = $9, response_hmac = $10, returned_provider = $11,
              returned_model = $12, returned_effort = $13, terminal_at = clock_timestamp()
        WHERE attempt_id = $1 AND authorization_digest = $2 AND status = 'intent_recorded'`,
      [parsed.attemptId, parsed.reservation.authorizationDigest, terminalStatus, parsed.usage?.inputTokens ?? null,
        parsed.usage?.outputTokens ?? null, parsed.usage?.cacheReadTokens ?? null, parsed.usage?.cacheWriteTokens ?? null, observedCostMicrodollars,
        parsed.usage?.latencyMs ?? null, parsed.responseHmac, parsed.returnedIdentity?.provider ?? null,
        parsed.returnedIdentity?.model ?? null, parsed.returnedIdentity?.effort ?? null],
    );
    await client.query(
      `UPDATE addie_fixed_trace_component_smoke_authorizations
          SET status = $2::varchar, unknown_exposure_at = CASE WHEN $2::varchar = 'unknown_exposure' THEN clock_timestamp() ELSE NULL END
        WHERE authorization_digest = $1 AND reservation_id = $3 AND status = 'consumed'`,
      [parsed.reservation.authorizationDigest, authorizationStatus, parsed.reservation.reservationId],
    );
    return result('refused', refusal);
  }

  /** Must be called after every post-intent ambiguity; it permanently halts the run. */
  async recordUnknownExposure(reservation: FixedTraceComponentSmokeReservation): Promise<Readonly<{ status: 'recorded' }> | Readonly<{ status: 'refused'; reason: FixedTraceComponentSmokeLedgerRefusal }>> {
    if (!exactReservation(reservation)) return result('refused', 'plan_mismatch');
    try {
      return await this.transaction(async (client) => {
        const changed = await this.closeOpenIntentsAsUnknownExposure(client, reservation);
        return changed ? result('recorded') : result('refused', 'unknown_exposure');
      });
    } catch { return result('refused', 'persistence_uncertain'); }
  }

  /**
   * Turns every still-open committed intent into categorical ambiguity before
   * closing its corresponding assignment.  It records no invented receipt,
  * usage, identity, response HMAC, or cost.
  */
  private async closeOpenIntentsAsUnknownExposure(client: PoolClient, reservation: FixedTraceComponentSmokeReservation): Promise<boolean> {
    // Direct attempt/plan mutations acquire their target row before the
    // authorization in row triggers. Acquire all recovery targets first too;
    // subsequent updates reuse these locks and cannot form auth->target cycles.
    await client.query(
      `SELECT attempt_id FROM addie_fixed_trace_component_smoke_attempts
        WHERE authorization_digest = $1 FOR UPDATE`,
      [reservation.authorizationDigest],
    );
    await client.query(
      `SELECT p.assignment_id FROM addie_fixed_trace_component_smoke_run_plan AS p
        WHERE p.authorization_digest = $1 AND p.assignment_outcome IS NULL
          AND EXISTS (SELECT 1 FROM addie_fixed_trace_component_smoke_attempts a
                       WHERE a.authorization_digest = p.authorization_digest AND a.assignment_id = p.assignment_id)
        FOR UPDATE OF p`,
      [reservation.authorizationDigest],
    );
    const authorization = await client.query<{ status: string }>(
      `SELECT status FROM addie_fixed_trace_component_smoke_authorizations
        WHERE authorization_digest = $1 AND reservation_id = $2 FOR UPDATE`,
      [reservation.authorizationDigest, reservation.reservationId],
    );
    if (authorization.rowCount !== 1
      || (authorization.rows[0]!.status !== 'consumed' && authorization.rows[0]!.status !== 'unknown_exposure')) return false;
    if (authorization.rows[0]!.status === 'consumed') await client.query(
      `UPDATE addie_fixed_trace_component_smoke_authorizations SET status = 'unknown_exposure', unknown_exposure_at = clock_timestamp()
       WHERE authorization_digest = $1 AND reservation_id = $2 AND status = 'consumed'`,
      [reservation.authorizationDigest, reservation.reservationId],
    );
    await client.query(
      `UPDATE addie_fixed_trace_component_smoke_attempts
          SET status = 'unknown_exposure', response_disposition = NULL, response_hmac = NULL,
              returned_provider = NULL, returned_model = NULL, returned_effort = NULL,
              input_tokens = NULL, output_tokens = NULL, cache_read_tokens = NULL, cache_write_tokens = NULL,
              actual_cost_microdollars = NULL, observed_cost_microdollars = NULL, latency_ms = NULL,
              terminal_at = clock_timestamp()
        WHERE authorization_digest = $1 AND status = 'intent_recorded'`,
      [reservation.authorizationDigest],
    );
    await client.query(
      `WITH started AS (
         SELECT authorization_digest, assignment_id, max(invocation_ordinal) AS final_ordinal,
                bool_or(status = 'unknown_exposure') AS ambiguous,
                bool_or(status <> 'succeeded') AS failed,
                (array_agg(response_disposition ORDER BY invocation_ordinal DESC))[1] AS last_disposition
           FROM addie_fixed_trace_component_smoke_attempts
          WHERE authorization_digest = $1
          GROUP BY authorization_digest, assignment_id
       )
       UPDATE addie_fixed_trace_component_smoke_run_plan AS p
          SET assignment_outcome = CASE
                WHEN started.ambiguous OR started.last_disposition <> 'final_response' THEN 'provider_unknown_exposure'
                WHEN started.failed THEN 'provider_failed'
                ELSE 'provider_completed' END,
              assignment_terminal_at = clock_timestamp(), assignment_final_invocation_ordinal = started.final_ordinal
         FROM started
        WHERE p.authorization_digest = started.authorization_digest AND p.assignment_id = started.assignment_id
          AND p.assignment_outcome IS NULL`,
      [reservation.authorizationDigest],
    );
    return true;
  }

  /** Local and pre-dispatch terminal plan entries accept no HMAC, cost, or invocation claim. */
  async recordNonDispatchTerminal(input: unknown): Promise<Readonly<{ status: 'recorded' }> | Readonly<{ status: 'refused'; reason: FixedTraceComponentSmokeLedgerRefusal }>> {
    const parsed = parseNonDispatchTerminal(input);
    if (!parsed) return result('refused', 'plan_mismatch');
    try {
      return await this.transaction(async (client) => {
        const expected = expectedPlanEntry(parsed.assignmentId);
        const plan = await client.query<Record<string, unknown>>(
          `SELECT probe_id, cell_id, disposition, maximum_provider_invocations, requested_provider, requested_model,
                  requested_effort, pricing_profile_id, max_input_tokens, max_output_tokens, timeout_ms, retries,
                  reserved_microdollars
             FROM addie_fixed_trace_component_smoke_run_plan
            WHERE authorization_digest = $1 AND assignment_id = $2 FOR UPDATE`,
          [parsed.reservation.authorizationDigest, parsed.assignmentId],
        );
        if (!expected || plan.rowCount !== 1 || !pgPlanMatches(plan.rows[0]!, expected)
          || expected.disposition !== parsed.status) return result('refused', 'plan_mismatch');
        const auth = await client.query<{ status: string }>('SELECT status FROM addie_fixed_trace_component_smoke_authorizations WHERE authorization_digest = $1 AND reservation_id = $2 FOR UPDATE', [parsed.reservation.authorizationDigest, parsed.reservation.reservationId]);
        if (auth.rowCount !== 1) return result('refused', 'grant_already_consumed');
        if (auth.rows[0]!.status === 'unknown_exposure') return result('refused', 'unknown_exposure');
        if (auth.rows[0]!.status === 'halted') return result('refused', 'run_halted');
        const updated = await client.query(
          `UPDATE addie_fixed_trace_component_smoke_run_plan
          SET assignment_outcome = $3, assignment_terminal_at = clock_timestamp()
           WHERE authorization_digest = $1 AND assignment_id = $2 AND disposition = $3 AND assignment_outcome IS NULL`,
          [parsed.reservation.authorizationDigest, parsed.assignmentId, parsed.status],
        );
        return updated.rowCount === 1 ? result('recorded') : result('refused', 'plan_mismatch');
      });
    } catch { return result('refused', 'persistence_uncertain'); }
  }

  /**
   * Closes an unstarted assignment after permanent halt without claiming an
   * intent, provider invocation, HMAC, receipt, or cost. It remains a failed
   * denominator entry, never a provider attempt terminal.
   */
  async recordNotExecutedAfterHalt(input: unknown): Promise<Readonly<{ status: 'recorded' }> | Readonly<{ status: 'refused'; reason: FixedTraceComponentSmokeLedgerRefusal }>> {
    const parsed = parseNotExecutedAfterHalt(input);
    if (!parsed) return result('refused', 'plan_mismatch');
    try {
      return await this.transaction(async (client) => {
        const expected = expectedPlanEntry(parsed.assignmentId);
        const plan = await client.query<Record<string, unknown>>(
          `SELECT probe_id, cell_id, disposition, maximum_provider_invocations, requested_provider, requested_model,
                  requested_effort, pricing_profile_id, max_input_tokens, max_output_tokens, timeout_ms, retries,
                  reserved_microdollars
             FROM addie_fixed_trace_component_smoke_run_plan
            WHERE authorization_digest = $1 AND assignment_id = $2 FOR UPDATE`,
          [parsed.reservation.authorizationDigest, parsed.assignmentId],
        );
        if (!expected || plan.rowCount !== 1 || !pgPlanMatches(plan.rows[0]!, expected)) return result('refused', 'plan_mismatch');
        const started = await client.query('SELECT 1 FROM addie_fixed_trace_component_smoke_attempts WHERE authorization_digest = $1 AND assignment_id = $2 LIMIT 1 FOR UPDATE', [parsed.reservation.authorizationDigest, parsed.assignmentId]);
        if (started.rowCount !== 0) return result('refused', 'plan_mismatch');
        const auth = await client.query<{ status: string }>('SELECT status FROM addie_fixed_trace_component_smoke_authorizations WHERE authorization_digest = $1 AND reservation_id = $2 FOR UPDATE', [parsed.reservation.authorizationDigest, parsed.reservation.reservationId]);
        if (auth.rowCount !== 1) return result('refused', 'grant_already_consumed');
        if (auth.rows[0]!.status !== 'halted' && auth.rows[0]!.status !== 'unknown_exposure') return result('refused', 'run_halted');
        const updated = await client.query(
          `UPDATE addie_fixed_trace_component_smoke_run_plan
              SET assignment_outcome = 'not_executed_after_halt', assignment_terminal_at = clock_timestamp()
            WHERE authorization_digest = $1 AND assignment_id = $2 AND assignment_outcome IS NULL`,
          [parsed.reservation.authorizationDigest, parsed.assignmentId],
        );
        return updated.rowCount === 1 ? result('recorded') : result('refused', 'plan_mismatch');
      });
    } catch { return result('refused', 'persistence_uncertain'); }
  }

  /**
   * Records the single denominator outcome for a provider assignment only
   * after its contiguous terminal invocation evidence is durable. Completion
   * requires the last started ordinal to carry a final-response disposition;
   * a continuation requires the next eligible ordinal first. Neither case is
   * a provider-attempt terminal itself.
   */
  async recordProviderAssignmentTerminal(input: unknown): Promise<Readonly<{ status: 'recorded' }> | Readonly<{ status: 'refused'; reason: FixedTraceComponentSmokeLedgerRefusal }>> {
    const parsed = parseProviderAssignmentTerminal(input);
    if (!parsed) return result('refused', 'plan_mismatch');
    try {
      return await this.transaction(async (client) => {
        const plan = await client.query<Record<string, unknown>>(
          `SELECT probe_id, cell_id, disposition, maximum_provider_invocations, requested_provider, requested_model,
                  requested_effort, pricing_profile_id, max_input_tokens, max_output_tokens, timeout_ms, retries,
                  reserved_microdollars
             FROM addie_fixed_trace_component_smoke_run_plan
            WHERE authorization_digest = $1 AND assignment_id = $2 FOR UPDATE`,
          [parsed.reservation.authorizationDigest, parsed.assignmentId],
        );
        const expected = expectedPlanEntry(parsed.assignmentId);
        if (!expected || plan.rowCount !== 1 || !pgPlanMatches(plan.rows[0]!, expected) || expected.disposition !== 'provider_dispatch'
          || parsed.finalInvocationOrdinal > expected.maximumProviderInvocations) return result('refused', 'plan_mismatch');
        const evidence = await client.query<{ count: unknown; open: unknown; failures: unknown; last_response_disposition: unknown }>(
          `WITH locked_attempts AS (
             SELECT status, response_disposition, invocation_ordinal
               FROM addie_fixed_trace_component_smoke_attempts
              WHERE authorization_digest = $1 AND assignment_id = $2 AND invocation_ordinal <= $3
              FOR UPDATE
           )
           SELECT count(*)::bigint AS count, bool_or(status = 'intent_recorded') AS open,
                  bool_or(status <> 'succeeded') AS failures,
                  (array_agg(response_disposition ORDER BY invocation_ordinal DESC))[1] AS last_response_disposition
             FROM locked_attempts`,
          [parsed.reservation.authorizationDigest, parsed.assignmentId, parsed.finalInvocationOrdinal],
        );
        const row = evidence.rows[0];
        const count = row ? pgSafeInt(row.count, 2) : null;
        if (count !== parsed.finalInvocationOrdinal || row?.open === true
          || (parsed.status === 'provider_completed' && (row?.failures === true || row?.last_response_disposition !== 'final_response'))
          || (parsed.status === 'provider_failed' && row?.failures !== true)) return result('refused', 'intent_required');
        const auth = await client.query<{ status: string }>('SELECT status FROM addie_fixed_trace_component_smoke_authorizations WHERE authorization_digest = $1 AND reservation_id = $2 FOR UPDATE', [parsed.reservation.authorizationDigest, parsed.reservation.reservationId]);
        if (auth.rowCount !== 1) return result('refused', 'grant_already_consumed');
        if (auth.rows[0]!.status !== 'consumed' && !(auth.rows[0]!.status === 'unknown_exposure' && parsed.status === 'provider_failed')) return result('refused', auth.rows[0]!.status === 'unknown_exposure' ? 'unknown_exposure' : 'run_halted');
        const updated = await client.query(
          `UPDATE addie_fixed_trace_component_smoke_run_plan
              SET assignment_outcome = $3, assignment_terminal_at = clock_timestamp(), assignment_final_invocation_ordinal = $4
            WHERE authorization_digest = $1 AND assignment_id = $2 AND assignment_outcome IS NULL`,
          [parsed.reservation.authorizationDigest, parsed.assignmentId, parsed.status, parsed.finalInvocationOrdinal],
        );
        return updated.rowCount === 1 ? result('recorded') : result('refused', 'plan_mismatch');
      });
    } catch { return result('refused', 'persistence_uncertain'); }
  }
}

function exactReservation(value: unknown): value is FixedTraceComponentSmokeReservation {
  try {
    const object = snapshotFixedTraceJson(value, 'private ledger reservation') as Record<string, unknown>;
    return exactKeys(object, ['authorizationDigest', 'entryCount', 'providerDispatchEntryCount', 'reservationId', 'reservationMicrodollars'])
      && typeof object.reservationId === 'string' && /^reservation_[a-f0-9]{32}$/.test(object.reservationId)
      && isHash(object.authorizationDigest) && object.reservationId === reservationIdForAuthorizationDigest(object.authorizationDigest)
      && object.entryCount === 168 && object.providerDispatchEntryCount === 126 && object.reservationMicrodollars === 2_819_484;
  } catch { return false; }
}
function parseProviderIntent(value: unknown): FixedTraceComponentSmokeProviderIntent | null {
  try {
    const object = snapshotFixedTraceJson(value, 'provider intent') as Record<string, unknown>;
    if (!exactKeys(object, ['assignmentId', 'attemptId', 'invocationOrdinal', 'preparedRequestHmac', 'reservation'])
      || !exactReservation(object.reservation) || typeof object.attemptId !== 'string' || !ATTEMPT_ID.test(object.attemptId)
      || !isHash(object.assignmentId) || !Number.isSafeInteger(object.invocationOrdinal) || (object.invocationOrdinal as number) < 1 || !isHash(object.preparedRequestHmac)) return null;
    return Object.freeze(object) as unknown as FixedTraceComponentSmokeProviderIntent;
  } catch { return null; }
}
function parseTerminal(value: unknown): FixedTraceComponentSmokeTerminal | null {
  try {
    const object = snapshotFixedTraceJson(value, 'provider terminal') as Record<string, unknown>;
    const statuses = new Set(['succeeded', 'provider_failed', 'timeout_after_dispatch', 'malformed_response', 'identity_mismatch', 'missing_usage']);
    if (!exactKeys(object, ['attemptId', 'reservation', 'responseDisposition', 'responseHmac', 'returnedIdentity', 'status', 'usage']) || !exactReservation(object.reservation)
      || typeof object.attemptId !== 'string' || !ATTEMPT_ID.test(object.attemptId) || typeof object.status !== 'string' || !statuses.has(object.status)) return null;
    const usageIsExact = object.usage !== null && typeof object.usage === 'object'
      && exactKeys(object.usage, ['cacheReadTokens', 'cacheWriteTokens', 'inputTokens', 'latencyMs', 'outputTokens'])
      && [
        (object.usage as Record<string, unknown>).inputTokens, (object.usage as Record<string, unknown>).outputTokens,
        (object.usage as Record<string, unknown>).cacheReadTokens, (object.usage as Record<string, unknown>).cacheWriteTokens,
        (object.usage as Record<string, unknown>).latencyMs,
      ].every((entry, index) => Number.isSafeInteger(entry) && (entry as number) >= 0
        && (index === 4 ? (entry as number) <= MAX_LATENCY_MS : (entry as number) <= 1_000_000))
      && ((object.usage as Record<string, unknown>).latencyMs as number) <= MAX_LATENCY_MS;
    const responseBearing = object.status === 'succeeded' || object.status === 'provider_failed'
      || object.status === 'malformed_response' || object.status === 'identity_mismatch' || object.status === 'missing_usage';
    if (responseBearing && !isHash(object.responseHmac)) return null;
    if (object.status === 'succeeded' && object.responseDisposition !== 'final_response' && object.responseDisposition !== 'tool_continuation_required') return null;
    if (object.status !== 'succeeded' && object.responseDisposition !== null) return null;
    if (object.status === 'timeout_after_dispatch' && (object.usage !== null || object.responseHmac !== null || object.returnedIdentity !== null)) return null;
    if ((object.status === 'succeeded' || object.status === 'provider_failed' || object.status === 'identity_mismatch')
      && (!usageIsExact || !exactIdentity(object.returnedIdentity))) return null;
    if (object.status === 'malformed_response' && (object.usage !== null || object.returnedIdentity !== null)) return null;
    if (object.status === 'missing_usage' && (object.usage !== null || !exactIdentity(object.returnedIdentity))) return null;
    return Object.freeze(object) as unknown as FixedTraceComponentSmokeTerminal;
  } catch { return null; }
}
function exactIdentity(value: unknown): value is Readonly<{ provider: string; model: string; effort: string }> {
  try {
    const object = snapshotFixedTraceJson(value, 'returned provider identity') as Record<string, unknown>;
    return exactKeys(object, ['effort', 'model', 'provider']) && safeString(object.provider, 32)
      && safeString(object.model, 128) && safeString(object.effort, 64);
  } catch { return false; }
}
function parseNonDispatchTerminal(value: unknown): FixedTraceComponentSmokeNonDispatchTerminal | null {
  try {
    const object = snapshotFixedTraceJson(value, 'non-dispatch terminal') as Record<string, unknown>;
    if (!exactKeys(object, ['assignmentId', 'reservation', 'status']) || !exactReservation(object.reservation)
      || !isHash(object.assignmentId) || (object.status !== 'local_terminal' && object.status !== 'pre_dispatch_fault')) return null;
    return Object.freeze(object) as unknown as FixedTraceComponentSmokeNonDispatchTerminal;
  } catch { return null; }
}
function parseNotExecutedAfterHalt(value: unknown): FixedTraceComponentSmokeNotExecutedAfterHalt | null {
  try {
    const object = snapshotFixedTraceJson(value, 'post-halt assignment omission') as Record<string, unknown>;
    if (!exactKeys(object, ['assignmentId', 'reservation']) || !exactReservation(object.reservation) || !isHash(object.assignmentId)) return null;
    return Object.freeze(object) as unknown as FixedTraceComponentSmokeNotExecutedAfterHalt;
  } catch { return null; }
}
function parseProviderAssignmentTerminal(value: unknown): FixedTraceComponentSmokeProviderAssignmentTerminal | null {
  try {
    const object = snapshotFixedTraceJson(value, 'provider assignment terminal') as Record<string, unknown>;
    if (!exactKeys(object, ['assignmentId', 'finalInvocationOrdinal', 'reservation', 'status']) || !exactReservation(object.reservation)
      || !isHash(object.assignmentId) || !Number.isSafeInteger(object.finalInvocationOrdinal) || (object.finalInvocationOrdinal as number) < 1
      || (object.status !== 'provider_completed' && object.status !== 'provider_failed')) return null;
    return Object.freeze(object) as unknown as FixedTraceComponentSmokeProviderAssignmentTerminal;
  } catch { return null; }
}
