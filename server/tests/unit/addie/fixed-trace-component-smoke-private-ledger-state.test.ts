import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  PostgresFixedTraceComponentSmokePrivateLedger,
  fixedTraceComponentSmokePrivateLedgerPlan,
  type FixedTraceComponentSmokePlanEntry,
} from '../../../src/addie/eval/fixed-trace-component-smoke-private-ledger.js';
import { datedPricingCostMicros, datedPricingProfilesForFixedTrace } from '../../../src/addie/eval/dated-pricing-cohort.js';

const digest = 'a'.repeat(64);
const reservation = Object.freeze({
  authorizationDigest: digest,
  reservationId: `reservation_${createHash('sha256').update(JSON.stringify({ authorizationDigest: digest, domain: 'adcp:addie:fixed-trace-component-smoke:reservation:v1\0' })).digest('hex').slice(0, 32)}`,
  entryCount: 168 as const,
  providerDispatchEntryCount: 126 as const,
  reservationMicrodollars: 2_819_484 as const,
});
const dispatch = fixedTraceComponentSmokePrivateLedgerPlan()!.find((entry) => entry.disposition === 'provider_dispatch')!;

type StoredAttempt = { id: string; assignmentId: string; ordinal: number; status: string; responseDisposition: string | null; cost: number | null; observedCost: number | null; returnedProvider: string | null; responseHmac: string | null };

/** Strict deterministic fake: every SQL statement is modelled or rejected. */
class StrictLedgerClient {
  readonly calls: Array<{ sql: string; params: unknown[] | undefined }> = [];
  readonly attempts = new Map<string, StoredAttempt>();
  readonly assignmentOutcomes = new Map<string, string>();
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
    if (sql.startsWith('SELECT attempt_id FROM addie_fixed_trace_component_smoke_attempts')
      || sql.startsWith('SELECT p.assignment_id FROM addie_fixed_trace_component_smoke_run_plan')) return { rowCount: 0, rows: [] };
    if (sql.startsWith('SELECT status, reservation_microdollars')) return { rowCount: 1, rows: [{ status: this.authStatus, reservation_microdollars: '2819484', provider_ceiling_microdollars: '5000000' }] };
    if (sql.startsWith('SELECT status FROM addie_fixed_trace_component_smoke_authorizations')) return { rowCount: 1, rows: [{ status: this.authStatus }] };
    if (sql.startsWith('SELECT 1 FROM addie_fixed_trace_component_smoke_attempts') && sql.includes("status = 'intent_recorded'")) return { rowCount: [...this.attempts.values()].some((attempt) => attempt.status === 'intent_recorded') ? 1 : 0, rows: [] };
    if (sql.startsWith('SELECT status, response_disposition FROM addie_fixed_trace_component_smoke_attempts')) {
      const attempt = [...this.attempts.values()].find((entry) => entry.assignmentId === params![1] && entry.ordinal === params![2]);
      return attempt ? { rowCount: 1, rows: [{ status: attempt.status, response_disposition: attempt.responseDisposition }] } : { rowCount: 0, rows: [] };
    }
    if (sql.includes('FROM addie_fixed_trace_component_smoke_run_plan') && sql.includes('FOR UPDATE') && !sql.includes('FROM addie_fixed_trace_component_smoke_attempts a')) return { rowCount: 1, rows: [this.planRow()] };
    if (sql.startsWith('UPDATE addie_fixed_trace_component_smoke_run_plan')) return { rowCount: 1, rows: [] };
    if (sql.startsWith('SELECT 1 FROM addie_fixed_trace_component_smoke_attempts WHERE attempt_id')) return { rowCount: this.attempts.has(params![0] as string) ? 1 : 0, rows: [] };
    if (sql.startsWith('SELECT 1 FROM addie_fixed_trace_component_smoke_attempts WHERE authorization_digest')) {
      const started = [...this.attempts.values()].some((attempt) => attempt.assignmentId === params![1]
        && (!sql.includes('invocation_ordinal') || attempt.ordinal === params![2]));
      return { rowCount: started ? 1 : 0, rows: [] };
    }
    if (sql.startsWith('INSERT INTO addie_fixed_trace_component_smoke_attempts')) {
      this.attempts.set(params![0] as string, { id: params![0] as string, assignmentId: params![2] as string, ordinal: params![3] as number, status: 'intent_recorded', responseDisposition: null, cost: null, observedCost: null, returnedProvider: null, responseHmac: null });
      return { rowCount: 1, rows: [] };
    }
    if (sql.includes('FROM addie_fixed_trace_component_smoke_attempts a')) {
      const attempt = this.attempts.get(params![0] as string);
      return attempt ? { rowCount: 1, rows: [{ assignment_id: attempt.assignmentId, status: attempt.status, invocation_ordinal: String(attempt.ordinal), ...this.planRow() }] } : { rowCount: 0, rows: [] };
    }
    if (sql.startsWith('WITH locked_attempts AS') && sql.includes('actual_cost_microdollars')
      || sql.startsWith('SELECT COALESCE(SUM(actual_cost_microdollars)')) {
      const spent = this.priorSpend ?? String([...this.attempts.values()].reduce((sum, attempt) => sum + (attempt.cost ?? 0), 0));
      return { rowCount: 1, rows: [{ spent }] };
    }
    if (sql.startsWith('WITH assignment_attempts AS') || sql.startsWith('SELECT count(*)::bigint AS count')) {
      const matches = [...this.attempts.values()].filter((attempt) => attempt.assignmentId === params![1] && attempt.ordinal <= params![2] as number);
      const last = [...matches].sort((left, right) => right.ordinal - left.ordinal)[0];
      return { rowCount: 1, rows: [{ count: String(matches.length), open: matches.some((attempt) => attempt.status === 'intent_recorded'), failures: matches.some((attempt) => attempt.status !== 'succeeded'), last_response_disposition: last?.responseDisposition ?? null }] };
    }
    if (sql.startsWith('UPDATE addie_fixed_trace_component_smoke_attempts') && sql.includes("WHERE authorization_digest = $1 AND status = 'intent_recorded'")) {
      for (const attempt of this.attempts.values()) if (attempt.status === 'intent_recorded') {
        attempt.status = 'unknown_exposure'; attempt.responseDisposition = null; attempt.cost = null; attempt.observedCost = null; attempt.responseHmac = null; attempt.returnedProvider = null;
      }
      return { rowCount: 1, rows: [] };
    }
    if (sql.startsWith('WITH started AS (')) {
      for (const attempt of this.attempts.values()) {
        if (this.assignmentOutcomes.has(attempt.assignmentId)) continue;
        this.assignmentOutcomes.set(attempt.assignmentId,
          attempt.status === 'unknown_exposure' || attempt.responseDisposition === 'tool_continuation_required'
            ? 'provider_unknown_exposure' : attempt.status === 'succeeded' ? 'provider_completed' : 'provider_failed');
      }
      return { rowCount: 1, rows: [] };
    }
    if (sql.startsWith('UPDATE addie_fixed_trace_component_smoke_attempts')) {
      const attempt = this.attempts.get(params![0] as string)!;
      attempt.status = params![2] as string;
      attempt.responseDisposition = sql.includes('actual_cost_microdollars = NULL') ? null : params![3] as string | null;
      attempt.cost = sql.includes('actual_cost_microdollars = NULL') ? null : params![8] as number | null;
      attempt.observedCost = sql.includes('actual_cost_microdollars = NULL') ? params![7] as number | null : null;
      attempt.responseHmac = (sql.includes('actual_cost_microdollars = NULL') ? params![9] : params![10]) as string | null;
      attempt.returnedProvider = (sql.includes('actual_cost_microdollars = NULL') ? params![10] : params![11]) as string | null;
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
  const status = overrides.status ?? 'succeeded';
  return {
    reservation, attemptId: `attempt_${'1'.repeat(32)}`, status, responseDisposition: status === 'succeeded' ? 'final_response' : null, responseHmac: 'c'.repeat(64),
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
  ])('settles %s overruns rather than leaving an open intent', async (_name, usage) => {
    const client = new StrictLedgerClient(); const subject = ledger(client);
    await subject.recordProviderIntent(intent());
    expect(await subject.recordTerminal(terminal({ usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, latencyMs: 0, ...usage } }))).toEqual({ status: 'refused', reason: 'plan_mismatch' });
    expect(client.authStatus).toBe('halted');
    expect(client.attempts.get(`attempt_${'1'.repeat(32)}`)?.status).toBe('invalid_limits');
    expect(client.attempts.get(`attempt_${'1'.repeat(32)}`)?.observedCost).toEqual(expect.any(Number));
  });

  it('permits additive cache at the independent max-input boundary', async () => {
    const client = new StrictLedgerClient(); const subject = ledger(client);
    expect(await subject.recordProviderIntent(intent())).toEqual({ status: 'recorded' });
    expect(await subject.recordTerminal(terminal({
      usage: { inputTokens: dispatch.maxInputTokens, outputTokens: 0, cacheReadTokens: 1, cacheWriteTokens: 1, latencyMs: 0 },
    }))).toEqual({ status: 'recorded' });
    expect(client.authStatus).toBe('consumed');
  });

  it.each([
    ['anthropic-standard-2026-09:claude-haiku-4-5', { inputTokens: 1, outputTokens: 0, cacheReadTokens: 1, cacheWriteTokens: 1 }, 3],
    ['anthropic-standard-2026-09:claude-sonnet-5', { inputTokens: 1, outputTokens: 0, cacheReadTokens: 1, cacheWriteTokens: 1 }, 5],
    ['openai-gpt-5.6-luna-standard-2026-09-05', { inputTokens: 2, outputTokens: 0, cacheReadTokens: 1, cacheWriteTokens: 1 }, 1],
    ['google-gemini-3.7-flash-through-2026-12-31', { inputTokens: 1, outputTokens: 0, cacheReadTokens: 1, cacheWriteTokens: 0 }, 1],
  ])('uses exact rounded microdollar pricing for %s', (profileId, usage, expectedMicros) => {
    const profile = datedPricingProfilesForFixedTrace().find((candidate) => candidate.profileId === profileId)!;
    expect(datedPricingCostMicros(profile, usage)).toBe(expectedMicros);
  });

  it('poisons an authorization with an unresolved intent and maps response failures to unknown exposure', async () => {
    const client = new StrictLedgerClient(); const subject = ledger(client);
    await subject.recordProviderIntent(intent());
    expect(await subject.recordProviderIntent(intent(`attempt_${'2'.repeat(32)}`))).toEqual({ status: 'refused', reason: 'unknown_exposure' });
    expect(client.authStatus).toBe('unknown_exposure');
    expect(client.attempts.get(`attempt_${'1'.repeat(32)}`)?.status).toBe('unknown_exposure');
    const failed = new StrictLedgerClient(); const failedLedger = ledger(failed);
    await failedLedger.recordProviderIntent(intent());
    expect(await failedLedger.recordTerminal(terminal({ status: 'provider_failed' }))).toEqual({ status: 'recorded' });
    expect(failed.authStatus).toBe('unknown_exposure');
  });

  it('never reports durable poisoning when standalone recovery refuses', async () => {
    const client = new StrictLedgerClient(); const subject = ledger(client);
    await subject.recordProviderIntent(intent());
    // This simulates an independently failed recovery transaction. The
    // caller must receive uncertainty, not a false durable-poison result.
    (subject as unknown as { recordUnknownExposure: () => Promise<unknown> }).recordUnknownExposure = async () =>
      ({ status: 'refused', reason: 'persistence_uncertain' });
    expect(await subject.recordProviderIntent(intent(`attempt_${'2'.repeat(32)}`))).toEqual({ status: 'refused', reason: 'persistence_uncertain' });
    expect(client.authStatus).toBe('consumed');
    expect(client.attempts.get(`attempt_${'1'.repeat(32)}`)?.status).toBe('intent_recorded');
  });

  it('locks the target attempt then authorization before reading spend', async () => {
    const client = new StrictLedgerClient(); const subject = ledger(client);
    await subject.recordProviderIntent(intent());
    expect(await subject.recordTerminal(terminal())).toEqual({ status: 'recorded' });
    const target = client.calls.findIndex(({ sql }) => sql.includes('FROM addie_fixed_trace_component_smoke_attempts a'));
    const authorization = client.calls.findIndex(({ sql }) => sql.startsWith('SELECT status, reservation_microdollars'));
    const spend = client.calls.findIndex(({ sql }) => sql.includes('SUM(actual_cost_microdollars)'));
    expect(target).toBeGreaterThanOrEqual(0);
    expect(authorization).toBeGreaterThan(target);
    expect(spend).toBeGreaterThan(authorization);
  });

  it('requires a succeeded continuation predecessor before ordinal two', async () => {
    const generation = fixedTraceComponentSmokePrivateLedgerPlan()!.find((entry) => entry.disposition === 'provider_dispatch' && entry.maximumProviderInvocations === 2)!;
    const client = new StrictLedgerClient(generation); const subject = ledger(client);
    const second = { ...intent(`attempt_${'2'.repeat(32)}`, 2), assignmentId: generation.assignmentId };
    expect(await subject.recordProviderIntent(second)).toEqual({ status: 'refused', reason: 'intent_required' });
    client.attempts.set(`attempt_${'1'.repeat(32)}`, { id: `attempt_${'1'.repeat(32)}`, assignmentId: generation.assignmentId, ordinal: 1, status: 'succeeded', responseDisposition: 'final_response', cost: 0, observedCost: null, returnedProvider: generation.provider, responseHmac: 'c'.repeat(64) });
    expect(await subject.recordProviderIntent(second)).toEqual({ status: 'refused', reason: 'intent_required' });
    client.attempts.get(`attempt_${'1'.repeat(32)}`)!.responseDisposition = 'tool_continuation_required';
    expect(await subject.recordProviderIntent(second)).toEqual({ status: 'recorded' });
  });

  it('fail-stops a continuation at generation ordinal two while retaining observed usage cost', async () => {
    const generation = fixedTraceComponentSmokePrivateLedgerPlan()!.find((entry) => entry.disposition === 'provider_dispatch' && entry.maximumProviderInvocations === 2)!;
    const client = new StrictLedgerClient(generation); const subject = ledger(client);
    client.attempts.set(`attempt_${'1'.repeat(32)}`, { id: `attempt_${'1'.repeat(32)}`, assignmentId: generation.assignmentId, ordinal: 1, status: 'succeeded', responseDisposition: 'tool_continuation_required', cost: 0, observedCost: null, returnedProvider: generation.provider, responseHmac: 'c'.repeat(64) });
    await subject.recordProviderIntent({ ...intent(`attempt_${'2'.repeat(32)}`, 2), assignmentId: generation.assignmentId });
    expect(await subject.recordTerminal({ ...terminal({ attemptId: `attempt_${'2'.repeat(32)}`, responseDisposition: 'tool_continuation_required' }), returnedIdentity: { provider: generation.provider, model: generation.model, effort: generation.effort } })).toEqual({ status: 'refused', reason: 'plan_mismatch' });
    expect(client.authStatus).toBe('halted');
    expect(client.attempts.get(`attempt_${'2'.repeat(32)}`)).toMatchObject({ status: 'invalid_limits', cost: null, observedCost: expect.any(Number) });
  });

  it('closes an explicitly ambiguous open intent as an unknown provider assignment outcome', async () => {
    const client = new StrictLedgerClient(); const subject = ledger(client);
    await subject.recordProviderIntent(intent());
    expect(await subject.recordUnknownExposure(reservation)).toEqual({ status: 'recorded' });
    expect(client.authStatus).toBe('unknown_exposure');
    expect(client.attempts.get(`attempt_${'1'.repeat(32)}`)).toMatchObject({ status: 'unknown_exposure', responseHmac: null, cost: null });
    expect(client.assignmentOutcomes.get(dispatch.assignmentId)).toBe('provider_unknown_exposure');
  });

  it('uses complete-plan, then attempts, then authorization recovery locking', async () => {
    const client = new StrictLedgerClient(); const subject = ledger(client);
    await subject.recordProviderIntent(intent());
    expect(await subject.recordUnknownExposure(reservation)).toEqual({ status: 'recorded' });
    const planSet = client.calls.findIndex(({ sql }) => sql.startsWith('SELECT assignment_id FROM addie_fixed_trace_component_smoke_run_plan'));
    const attempts = client.calls.findIndex(({ sql }, index) => index > planSet && sql.startsWith('SELECT attempt_id FROM addie_fixed_trace_component_smoke_attempts'));
    const authorization = client.calls.findIndex(({ sql }, index) => index > attempts && sql.startsWith('SELECT status FROM addie_fixed_trace_component_smoke_authorizations'));
    expect(planSet).toBeGreaterThanOrEqual(0);
    expect(attempts).toBeGreaterThan(planSet);
    expect(authorization).toBeGreaterThan(attempts);
  });

  it('idempotently recovers a committed known provider failure after its unknown-exposure commit response is lost', async () => {
    const client = new StrictLedgerClient(); const subject = ledger(client);
    client.authStatus = 'unknown_exposure';
    client.attempts.set(`attempt_${'4'.repeat(32)}`, { id: `attempt_${'4'.repeat(32)}`, assignmentId: dispatch.assignmentId, ordinal: 1, status: 'provider_failed', responseDisposition: null, cost: 0, observedCost: null, returnedProvider: dispatch.provider, responseHmac: 'c'.repeat(64) });
    expect(await subject.recordUnknownExposure(reservation)).toEqual({ status: 'recorded' });
    expect(client.assignmentOutcomes.get(dispatch.assignmentId)).toBe('provider_failed');
    expect(await subject.recordUnknownExposure(reservation)).toEqual({ status: 'recorded' });
    expect(client.assignmentOutcomes.get(dispatch.assignmentId)).toBe('provider_failed');
  });

  it.each([
    ['timeout_after_dispatch', { usage: null, responseHmac: null, returnedIdentity: null }],
    ['malformed_response', { usage: null, responseHmac: 'd'.repeat(64), returnedIdentity: null }],
    ['missing_usage', { usage: null, responseHmac: 'd'.repeat(64), returnedIdentity: { provider: dispatch.provider, model: dispatch.model, effort: dispatch.effort } }],
    ['identity_mismatch', { usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, latencyMs: 0 }, responseHmac: 'd'.repeat(64), returnedIdentity: { provider: 'other', model: 'other', effort: 'other' } }],
  ])('preserves status-specific receipt evidence and fail-stops %s', async (status, receipt) => {
    const client = new StrictLedgerClient(); const subject = ledger(client);
    await subject.recordProviderIntent(intent());
    expect(await subject.recordTerminal(terminal({ status, ...receipt }))).toEqual(
      status === 'identity_mismatch' ? { status: 'refused', reason: 'plan_mismatch' } : { status: 'recorded' },
    );
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

  it('closes only an unstarted assignment as a zero-call post-halt denominator outcome', async () => {
    const client = new StrictLedgerClient(); const subject = ledger(client);
    client.authStatus = 'halted';
    expect(await subject.recordNotExecutedAfterHalt({ reservation, assignmentId: dispatch.assignmentId })).toEqual({ status: 'recorded' });
    expect(await subject.recordNotExecutedAfterHalt({ reservation, assignmentId: dispatch.assignmentId, status: 'not_executed_after_halt' })).toEqual({ status: 'refused', reason: 'plan_mismatch' });
    const started = new StrictLedgerClient(); started.authStatus = 'unknown_exposure';
    started.attempts.set(`attempt_${'2'.repeat(32)}`, { id: `attempt_${'2'.repeat(32)}`, assignmentId: dispatch.assignmentId, ordinal: 1, status: 'intent_recorded', responseDisposition: null, cost: null, observedCost: null, returnedProvider: null, responseHmac: null });
    expect(await ledger(started).recordNotExecutedAfterHalt({ reservation, assignmentId: dispatch.assignmentId })).toEqual({ status: 'refused', reason: 'plan_mismatch' });
  });

  it('requires a final-response disposition before a provider assignment can close', async () => {
    const generation = fixedTraceComponentSmokePrivateLedgerPlan()!.find((entry) => entry.disposition === 'provider_dispatch' && entry.maximumProviderInvocations === 2)!;
    const client = new StrictLedgerClient(generation); const subject = ledger(client);
    client.attempts.set(`attempt_${'3'.repeat(32)}`, { id: `attempt_${'3'.repeat(32)}`, assignmentId: generation.assignmentId, ordinal: 1, status: 'succeeded', responseDisposition: 'tool_continuation_required', cost: 0, observedCost: null, returnedProvider: generation.provider, responseHmac: 'c'.repeat(64) });
    const completion = { reservation, assignmentId: generation.assignmentId, status: 'provider_completed' as const, finalInvocationOrdinal: 1 };
    expect(await subject.recordProviderAssignmentTerminal(completion)).toEqual({ status: 'refused', reason: 'intent_required' });
    client.attempts.get(`attempt_${'3'.repeat(32)}`)!.responseDisposition = 'final_response';
    expect(await subject.recordProviderAssignmentTerminal(completion)).toEqual({ status: 'recorded' });
  });
});
