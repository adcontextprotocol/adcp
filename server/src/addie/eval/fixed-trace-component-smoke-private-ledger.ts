import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { fixedTraceComponentSmokeAdmission } from './fixed-trace-component-smoke-admission.js';
import {
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

type Admission = ReturnType<typeof fixedTraceComponentSmokeAdmission>;
type Disposition = Admission['privateRuntimePlan'][number]['dispatchDisposition'];
export type FixedTraceComponentSmokeLedgerRefusal =
  | 'grant_not_active' | 'grant_already_consumed' | 'admission_drift'
  | 'unknown_exposure' | 'run_halted' | 'duplicate_attempt_id' | 'intent_required'
  | 'plan_mismatch' | 'persistence_uncertain';

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
  readonly usage: Readonly<{ inputTokens: number; outputTokens: number; costMicrodollars: number; latencyMs: number }> | null;
  readonly returnedIdentity: Readonly<{ provider: string; model: string; effort: string }> | null;
  readonly responseHmac: string | null;
}
export interface FixedTraceComponentSmokeNonDispatchTerminal {
  readonly reservation: FixedTraceComponentSmokeReservation;
  readonly assignmentId: string;
  readonly status: 'local_terminal' | 'pre_dispatch_fault';
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
function safeString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && /^[a-z0-9._:-]+$/i.test(value);
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
    && total === 2_819_484 && nonDispatchValid ? Object.freeze(plan) : null;
}

function reservationFor(grant: FixedTraceComponentSmokeVerifiedGrant): FixedTraceComponentSmokeReservation {
  return Object.freeze({ reservationId: `reservation_${sha256({ domain: 'adcp:addie:fixed-trace-component-smoke:reservation:v1\0', authorizationDigest: grant.grantDigest }).slice(0, 32)}`,
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
    if (!plan || !isFixedTraceComponentSmokeVerifiedGrant(grant) || !isHash(grant.grantDigest) || !isHash(grant.signedPayloadDigest) || !isHash(grant.payload.nonceCommitment)) return result('refused', 'admission_drift');
    const reservation = reservationFor(grant);
    try {
      return await this.transaction(async (client) => {
        const inserted = await client.query<{ authorization_digest: string }>(
          `INSERT INTO addie_fixed_trace_component_smoke_authorizations (
             authorization_digest, signed_payload_digest, signature, kid, nonce_commitment, grant_version,
             stage_id, admission_version, aggregate_admission_fingerprint, probes, router_cells, generation_cells, total_cells, repetitions, assignments,
             provider_dispatch_assignments, local_terminal_assignments, pre_dispatch_fault_assignments,
             maximum_planned_invocation_slots, maximum_provider_invocations, reservation_microdollars, provider_ceiling_microdollars,
             pricing_cohort_digest, issued_at, expires_at, status, consumed_at, reservation_id
           )
           SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24::timestamptz,$25::timestamptz,'consumed',clock_timestamp(),$26
           WHERE $24::timestamptz <= clock_timestamp() AND $25::timestamptz > clock_timestamp()
           ON CONFLICT (authorization_digest) DO NOTHING
           RETURNING authorization_digest`,
          [grant.grantDigest, grant.signedPayloadDigest, grant.signature, grant.payload.kid, grant.payload.nonceCommitment,
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
        const auth = await client.query<{ status: string }>('SELECT status FROM addie_fixed_trace_component_smoke_authorizations WHERE authorization_digest = $1 FOR UPDATE', [parsed.reservation.authorizationDigest]);
        if (auth.rowCount !== 1) return result('refused', 'grant_already_consumed');
        if (auth.rows[0]!.status === 'unknown_exposure') return result('refused', 'unknown_exposure');
        if (auth.rows[0]!.status === 'halted') return result('refused', 'run_halted');
        if (auth.rows[0]!.status !== 'consumed') return result('refused', 'admission_drift');
        const plan = await client.query<{ disposition: string; maximum_provider_invocations: number }>(
          'SELECT disposition, maximum_provider_invocations FROM addie_fixed_trace_component_smoke_run_plan WHERE authorization_digest = $1 AND assignment_id = $2 FOR UPDATE', [parsed.reservation.authorizationDigest, parsed.assignmentId]);
        if (plan.rowCount !== 1 || plan.rows[0]!.disposition !== 'provider_dispatch' || parsed.invocationOrdinal > plan.rows[0]!.maximum_provider_invocations) return result('refused', 'plan_mismatch');
        const duplicate = await client.query('SELECT 1 FROM addie_fixed_trace_component_smoke_attempts WHERE attempt_id = $1 FOR UPDATE', [parsed.attemptId]);
        if (duplicate.rowCount !== 0) return result('refused', 'duplicate_attempt_id');
        const slot = await client.query('SELECT 1 FROM addie_fixed_trace_component_smoke_attempts WHERE authorization_digest = $1 AND assignment_id = $2 AND invocation_ordinal = $3 FOR UPDATE', [parsed.reservation.authorizationDigest, parsed.assignmentId, parsed.invocationOrdinal]);
        if (slot.rowCount !== 0) return result('refused', 'duplicate_attempt_id');
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
        const auth = await client.query<{ status: string }>('SELECT status FROM addie_fixed_trace_component_smoke_authorizations WHERE authorization_digest = $1 FOR UPDATE', [parsed.reservation.authorizationDigest]);
        if (auth.rowCount !== 1) return result('refused', 'grant_already_consumed');
        if (auth.rows[0]!.status === 'unknown_exposure') return result('refused', 'unknown_exposure');
        if (auth.rows[0]!.status === 'halted') return result('refused', 'run_halted');
        if (auth.rows[0]!.status !== 'consumed') return result('refused', 'admission_drift');
        const attempt = await client.query<{ status: string; requested_provider: string; requested_model: string; requested_effort: string }>(
          `SELECT a.status, p.requested_provider, p.requested_model, p.requested_effort
           FROM addie_fixed_trace_component_smoke_attempts a
           JOIN addie_fixed_trace_component_smoke_run_plan p ON p.authorization_digest = a.authorization_digest AND p.assignment_id = a.assignment_id
           WHERE a.attempt_id = $1 AND a.authorization_digest = $2 FOR UPDATE`, [parsed.attemptId, parsed.reservation.authorizationDigest]);
        if (attempt.rowCount !== 1 || attempt.rows[0]!.status !== 'intent_recorded') return result('refused', 'intent_required');
        if (parsed.status === 'succeeded' && (parsed.returnedIdentity?.provider !== attempt.rows[0]!.requested_provider
          || parsed.returnedIdentity?.model !== attempt.rows[0]!.requested_model
          || parsed.returnedIdentity?.effort !== attempt.rows[0]!.requested_effort)) return result('refused', 'plan_mismatch');
        await client.query(
          `UPDATE addie_fixed_trace_component_smoke_attempts
           SET status = $3, input_tokens = $4, output_tokens = $5, actual_cost_microdollars = $6, latency_ms = $7, response_hmac = $8, terminal_at = clock_timestamp()
           WHERE attempt_id = $1 AND authorization_digest = $2`,
          [parsed.attemptId, parsed.reservation.authorizationDigest, parsed.status, parsed.usage?.inputTokens ?? null,
            parsed.usage?.outputTokens ?? null, parsed.usage?.costMicrodollars ?? null, parsed.usage?.latencyMs ?? null, parsed.responseHmac],
        );
        if (parsed.status !== 'succeeded') {
          await client.query(
            `UPDATE addie_fixed_trace_component_smoke_authorizations
             SET status = $2, unknown_exposure_at = CASE WHEN $2 = 'unknown_exposure' THEN clock_timestamp() ELSE NULL END
             WHERE authorization_digest = $1`,
            [parsed.reservation.authorizationDigest, parsed.status === 'timeout_after_dispatch' ? 'unknown_exposure' : 'halted'],
          );
        }
        return result('recorded');
      });
    } catch { return result('refused', 'persistence_uncertain'); }
  }

  /** Must be called after every post-intent ambiguity; it permanently halts the run. */
  async recordUnknownExposure(reservation: FixedTraceComponentSmokeReservation): Promise<Readonly<{ status: 'recorded' }> | Readonly<{ status: 'refused'; reason: FixedTraceComponentSmokeLedgerRefusal }>> {
    if (!exactReservation(reservation)) return result('refused', 'plan_mismatch');
    try {
      return await this.transaction(async (client) => {
        const changed = await client.query(
          `UPDATE addie_fixed_trace_component_smoke_authorizations SET status = 'unknown_exposure', unknown_exposure_at = clock_timestamp()
           WHERE authorization_digest = $1 AND status = 'consumed'`, [reservation.authorizationDigest]);
        return changed.rowCount === 1 ? result('recorded') : result('refused', 'unknown_exposure');
      });
    } catch { return result('refused', 'persistence_uncertain'); }
  }

  /** Local and pre-dispatch terminal plan entries accept no HMAC, cost, or invocation claim. */
  async recordNonDispatchTerminal(input: unknown): Promise<Readonly<{ status: 'recorded' }> | Readonly<{ status: 'refused'; reason: FixedTraceComponentSmokeLedgerRefusal }>> {
    const parsed = parseNonDispatchTerminal(input);
    if (!parsed) return result('refused', 'plan_mismatch');
    try {
      return await this.transaction(async (client) => {
        const auth = await client.query<{ status: string }>('SELECT status FROM addie_fixed_trace_component_smoke_authorizations WHERE authorization_digest = $1 FOR UPDATE', [parsed.reservation.authorizationDigest]);
        if (auth.rowCount !== 1) return result('refused', 'grant_already_consumed');
        if (auth.rows[0]!.status === 'unknown_exposure') return result('refused', 'unknown_exposure');
        if (auth.rows[0]!.status === 'halted') return result('refused', 'run_halted');
        const updated = await client.query(
          `UPDATE addie_fixed_trace_component_smoke_run_plan
           SET non_dispatch_status = $3, non_dispatch_terminal_at = clock_timestamp()
           WHERE authorization_digest = $1 AND assignment_id = $2 AND disposition = $3 AND non_dispatch_status IS NULL`,
          [parsed.reservation.authorizationDigest, parsed.assignmentId, parsed.status],
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
      && isHash(object.authorizationDigest) && object.entryCount === 168 && object.providerDispatchEntryCount === 126 && object.reservationMicrodollars === 2_819_484;
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
    if (!exactKeys(object, ['attemptId', 'reservation', 'responseHmac', 'returnedIdentity', 'status', 'usage']) || !exactReservation(object.reservation)
      || typeof object.attemptId !== 'string' || !ATTEMPT_ID.test(object.attemptId) || typeof object.status !== 'string' || !statuses.has(object.status)) return null;
    if (object.status === 'succeeded' && (object.usage === null || !isHash(object.responseHmac) || !exactIdentity(object.returnedIdentity))) return null;
    if (object.status !== 'succeeded' && (object.responseHmac !== null || object.returnedIdentity !== null)) return null;
    if (object.usage === null) return Object.freeze(object) as unknown as FixedTraceComponentSmokeTerminal;
    if (!object.usage || typeof object.usage !== 'object' || !exactKeys(object.usage, ['costMicrodollars', 'inputTokens', 'latencyMs', 'outputTokens'])) return null;
    const usage = object.usage as Record<string, unknown>;
    if (![usage.inputTokens, usage.outputTokens, usage.costMicrodollars, usage.latencyMs].every((entry) => Number.isSafeInteger(entry) && (entry as number) >= 0)
      || (usage.latencyMs as number) > MAX_LATENCY_MS || (usage.costMicrodollars as number) > 2_819_484) return null;
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
