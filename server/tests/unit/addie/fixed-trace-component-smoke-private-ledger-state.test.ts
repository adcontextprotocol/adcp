import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  PostgresFixedTraceComponentSmokePrivateLedger,
  fixedTraceComponentSmokePrivateLedgerPlan,
  type FixedTraceComponentSmokePlanEntry,
} from '../../../src/addie/eval/fixed-trace-component-smoke-private-ledger.js';

const digest = 'a'.repeat(64);
const reservation = Object.freeze({
  authorizationDigest: digest,
  reservationId: `reservation_${createHash('sha256').update(JSON.stringify({ authorizationDigest: digest, domain: 'adcp:addie:fixed-trace-component-smoke:reservation:v1\0' })).digest('hex').slice(0, 32)}`,
  entryCount: 168 as const,
  providerDispatchEntryCount: 126 as const,
  reservationMicrodollars: 2_819_484 as const,
});
const dispatch = fixedTraceComponentSmokePrivateLedgerPlan()!.find((entry) => entry.disposition === 'provider_dispatch')!;

type StoredAttempt = { id: string; assignmentId: string; ordinal: number; status: string; cost: number | null; returnedProvider: string | null; responseHmac: string | null };

/** Strict deterministic fake: every SQL statement is modelled or rejected. */
class StrictLedgerClient {
  readonly calls: Array<{ sql: string; params: unknown[] | undefined }> = [];
  readonly attempts = new Map<string, StoredAttempt>();
  authStatus = 'consumed';
  priorSpend: string | null = null;
  constructor(private readonly entry: FixedTraceComponentSmokePlanEntry = dispatch) {}
  private planRow() {
    return {
      probe_id: this.entry.probeId, cell_id: this.entry.cellId, disposition: this.entry.disposition,
      maximum_provider_invocations: String(this.entry.maximumProviderInvocations), requested_provider: this.entry.provider,
      requested_model: this.entry.model, requested_effort: this.entry.effort, pricing_profile_id: this.entry.pricingProfileId,
      max_input_tokens: String(this.entry.maxInputTokens), max_output_tokens: String(this.entry.maxOutputTokens),
      timeout_ms: String(this.entry.timeoutMs), retries: '0', reserved_microdollars: this.entry.reservedMicrodollars.map(String),
    };
  }
  async query(sql: string, params?: unknown[]) {
    this.calls.push({ sql, params });
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rowCount: 0, rows: [] };
    if (sql.startsWith('SELECT status, reservation_microdollars')) return { rowCount: 1, rows: [{ status: this.authStatus, reservation_microdollars: '2819484', provider_ceiling_microdollars: '5000000' }] };
    if (sql.startsWith('SELECT status FROM addie_fixed_trace_component_smoke_authorizations')) return { rowCount: 1, rows: [{ status: this.authStatus }] };
    if (sql.startsWith('SELECT 1 FROM addie_fixed_trace_component_smoke_attempts') && sql.includes("status = 'intent_recorded'")) return { rowCount: [...this.attempts.values()].some((attempt) => attempt.status === 'intent_recorded') ? 1 : 0, rows: [] };
    if (sql.includes('FROM addie_fixed_trace_component_smoke_run_plan') && sql.includes('FOR UPDATE') && !sql.includes('FROM addie_fixed_trace_component_smoke_attempts a')) return { rowCount: 1, rows: [this.planRow()] };
    if (sql.startsWith('SELECT 1 FROM addie_fixed_trace_component_smoke_attempts WHERE attempt_id')) return { rowCount: this.attempts.has(params![0] as string) ? 1 : 0, rows: [] };
    if (sql.startsWith('SELECT 1 FROM addie_fixed_trace_component_smoke_attempts WHERE authorization_digest')) {
      return { rowCount: [...this.attempts.values()].some((attempt) => attempt.assignmentId === params![1] && attempt.ordinal === params![2]) ? 1 : 0, rows: [] };
    }
    if (sql.startsWith('INSERT INTO addie_fixed_trace_component_smoke_attempts')) {
      this.attempts.set(params![0] as string, { id: params![0] as string, assignmentId: params![2] as string, ordinal: params![3] as number, status: 'intent_recorded', cost: null, returnedProvider: null, responseHmac: null });
      return { rowCount: 1, rows: [] };
    }
    if (sql.includes('FROM addie_fixed_trace_component_smoke_attempts a')) {
      const attempt = this.attempts.get(params![0] as string);
      return attempt ? { rowCount: 1, rows: [{ assignment_id: attempt.assignmentId, status: attempt.status, invocation_ordinal: String(attempt.ordinal), ...this.planRow() }] } : { rowCount: 0, rows: [] };
    }
    if (sql.startsWith('SELECT COALESCE(SUM(actual_cost_microdollars)')) {
      const spent = this.priorSpend ?? String([...this.attempts.values()].reduce((sum, attempt) => sum + (attempt.cost ?? 0), 0));
      return { rowCount: 1, rows: [{ spent }] };
    }
    if (sql.startsWith('UPDATE addie_fixed_trace_component_smoke_attempts')) {
      const attempt = this.attempts.get(params![0] as string)!;
      attempt.status = params![2] as string;
      attempt.cost = sql.includes('actual_cost_microdollars = NULL') ? null : params![7] as number | null;
      attempt.responseHmac = (sql.includes('actual_cost_microdollars = NULL') ? params![8] : params![9]) as string | null;
      attempt.returnedProvider = (sql.includes('actual_cost_microdollars = NULL') ? params![9] : params![10]) as string | null;
      return { rowCount: 1, rows: [] };
    }
    if (sql.startsWith('UPDATE addie_fixed_trace_component_smoke_authorizations')) {
      this.authStatus = sql.includes("SET status = 'unknown_exposure'") ? 'unknown_exposure' : params![1] as string;
      return { rowCount: 1, rows: [] };
    }
    throw new Error(`unrecognised strict-fake SQL: ${sql.replace(/\s+/g, ' ').slice(0, 120)}`);
  }
  release() {}
}

function intent(id = `attempt_${'1'.repeat(32)}`, ordinal = 1) {
  return { reservation, attemptId: id, assignmentId: dispatch.assignmentId, invocationOrdinal: ordinal, preparedRequestHmac: 'b'.repeat(64) };
}
function terminal(overrides: Record<string, unknown> = {}) {
  return {
    reservation, attemptId: `attempt_${'1'.repeat(32)}`, status: 'succeeded', responseHmac: 'c'.repeat(64),
    returnedIdentity: { provider: dispatch.provider, model: dispatch.model, effort: dispatch.effort },
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, latencyMs: 0 }, ...overrides,
  };
}
function ledger(client: StrictLedgerClient) { return new PostgresFixedTraceComponentSmokePrivateLedger({ connect: async () => client } as never); }

describe('private ledger state machine', () => {
  it('records a provider intent and terminal using realistic pg int8 and int8[] strings', async () => {
    const client = new StrictLedgerClient();
    expect(await ledger(client).recordProviderIntent(intent())).toEqual({ status: 'recorded' });
    expect(await ledger(client).recordTerminal(terminal())).toEqual({ status: 'recorded' });
    expect(client.attempts.get(`attempt_${'1'.repeat(32)}`)).toMatchObject({ status: 'succeeded', returnedProvider: dispatch.provider, responseHmac: 'c'.repeat(64) });
  });

  it.each([
    ['input', { inputTokens: dispatch.maxInputTokens + 1 }],
    ['output', { outputTokens: dispatch.maxOutputTokens + 1 }],
    ['timeout', { latencyMs: dispatch.timeoutMs + 1 }],
    ['cache input', { inputTokens: dispatch.maxInputTokens, cacheReadTokens: 1 }],
  ])('settles %s overruns rather than leaving an open intent', async (_name, usage) => {
    const client = new StrictLedgerClient(); const subject = ledger(client);
    await subject.recordProviderIntent(intent());
    expect(await subject.recordTerminal(terminal({ usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, latencyMs: 0, ...usage } }))).toEqual({ status: 'refused', reason: 'plan_mismatch' });
    expect(client.authStatus).toBe('halted');
    expect(client.attempts.get(`attempt_${'1'.repeat(32)}`)?.status).toBe('invalid_limits');
  });

  it('poisons an authorization with an unresolved intent and maps response failures to unknown exposure', async () => {
    const client = new StrictLedgerClient(); const subject = ledger(client);
    await subject.recordProviderIntent(intent());
    expect(await subject.recordProviderIntent(intent(`attempt_${'2'.repeat(32)}`))).toEqual({ status: 'refused', reason: 'unknown_exposure' });
    expect(client.authStatus).toBe('unknown_exposure');
    const failed = new StrictLedgerClient(); const failedLedger = ledger(failed);
    await failedLedger.recordProviderIntent(intent());
    expect(await failedLedger.recordTerminal(terminal({ status: 'provider_failed' }))).toEqual({ status: 'recorded' });
    expect(failed.authStatus).toBe('unknown_exposure');
  });

  it.each([
    ['timeout_after_dispatch', { usage: null, responseHmac: null, returnedIdentity: null }],
    ['malformed_response', { usage: null, responseHmac: 'd'.repeat(64), returnedIdentity: null }],
    ['missing_usage', { usage: null, responseHmac: 'd'.repeat(64), returnedIdentity: { provider: dispatch.provider, model: dispatch.model, effort: dispatch.effort } }],
    ['identity_mismatch', { usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, latencyMs: 0 }, responseHmac: 'd'.repeat(64), returnedIdentity: { provider: 'other', model: 'other', effort: 'other' } }],
  ])('preserves status-specific receipt evidence and fail-stops %s', async (status, receipt) => {
    const client = new StrictLedgerClient(); const subject = ledger(client);
    await subject.recordProviderIntent(intent());
    expect(await subject.recordTerminal(terminal({ status, ...receipt }))).toEqual({ status: 'recorded' });
    expect(client.authStatus).toBe('unknown_exposure');
    expect(client.attempts.get(`attempt_${'1'.repeat(32)}`)?.responseHmac).toBe(receipt.responseHmac);
  });

  it('settles a pricing-profile mismatch as unknown exposure rather than zero-cost success', async () => {
    const altered = { ...dispatch, pricingProfileId: 'missing-profile' };
    const client = new StrictLedgerClient(); const subject = ledger(client);
    await subject.recordProviderIntent(intent());
    (client as unknown as { entry: FixedTraceComponentSmokePlanEntry }).entry = altered;
    expect(await subject.recordTerminal(terminal())).toEqual({ status: 'refused', reason: 'plan_mismatch' });
    expect(client.authStatus).toBe('unknown_exposure');
    expect(client.attempts.get(`attempt_${'1'.repeat(32)}`)?.status).toBe('pricing_unavailable');
  });

  it('settles aggregate one-over accounting failures from a pg int8 SUM', async () => {
    const client = new StrictLedgerClient(); client.priorSpend = '2819484'; const subject = ledger(client);
    await subject.recordProviderIntent(intent());
    expect(await subject.recordTerminal(terminal({ usage: { inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, latencyMs: 0 } }))).toEqual({ status: 'refused', reason: 'cost_exhausted' });
    expect(client.authStatus).toBe('halted');
  });
});
