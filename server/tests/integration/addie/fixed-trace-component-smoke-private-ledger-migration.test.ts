import { createHash, randomUUID } from 'node:crypto';
import { Client, Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fixedTraceComponentSmokeAdmission } from '../../../src/addie/eval/fixed-trace-component-smoke-admission.js';
import { PostgresFixedTraceComponentSmokePrivateLedger, fixedTraceComponentSmokePrivateLedgerPlan } from '../../../src/addie/eval/fixed-trace-component-smoke-private-ledger.js';

const databaseUrl = process.env.DATABASE_URL;
let client: Client | null = null;
let authorizationDigest = '';
const plan = fixedTraceComponentSmokePrivateLedgerPlan()!;
const admission = fixedTraceComponentSmokeAdmission();

async function rejects(statement: string, values: unknown[] = [], subject = client!) {
  await subject.query('SAVEPOINT private_ledger_expected_failure');
  try {
    await subject.query(statement, values);
  } catch (error) {
    await subject.query('ROLLBACK TO SAVEPOINT private_ledger_expected_failure');
    return error;
  }
  await subject.query('ROLLBACK TO SAVEPOINT private_ledger_expected_failure');
  throw new Error('statement unexpectedly succeeded');
}

function reservationIdFor(digest: string) {
  return `reservation_${createHash('sha256').update(JSON.stringify({ authorizationDigest: digest, domain: 'adcp:addie:fixed-trace-component-smoke:reservation:v1\0' })).digest('hex').slice(0, 32)}`;
}
function reservationFor(digest: string) {
  return { authorizationDigest: digest, reservationId: reservationIdFor(digest), entryCount: 168 as const, providerDispatchEntryCount: 126 as const, reservationMicrodollars: 2_819_484 as const };
}

async function seedExactPlan(subject = client!, alterFirstModel = false) {
  const digest = createHash('sha256').update(randomUUID()).digest('hex');
  await subject.query(
    `INSERT INTO addie_fixed_trace_component_smoke_authorizations
     (authorization_digest,signed_payload_digest,signature_digest,kid,nonce_commitment,grant_version,stage_id,admission_version,aggregate_admission_fingerprint,
      probes,router_cells,generation_cells,total_cells,repetitions,assignments,provider_dispatch_assignments,local_terminal_assignments,pre_dispatch_fault_assignments,
      maximum_planned_invocation_slots,maximum_provider_invocations,reservation_microdollars,provider_ceiling_microdollars,pricing_cohort_digest,issued_at,expires_at,status,consumed_at,reservation_id)
     VALUES ($1,$2,$3,'postgres-ledger-test',$4,'addie-fixed-trace-component-smoke-signed-grant-v1','stage_1_smoke','addie-fixed-trace-component-smoke-admission-v2',
       '731930c18475672a0ec6b44c9ff91fa89d30c441e34af32b536a28258271077d',8,10,11,21,1,168,126,21,21,256,192,2819484,5000000,$5,
       clock_timestamp() - interval '1 minute',clock_timestamp() + interval '1 minute','consumed',clock_timestamp(),$6)`,
    [digest, createHash('sha256').update(`${digest}:payload`).digest('hex'), createHash('sha256').update(`${digest}:signature`).digest('hex'), createHash('sha256').update(`${digest}:nonce`).digest('hex'), admission.pricing.cohortDigest, reservationIdFor(digest)],
  );
  for (const [index, entry] of plan.entries()) {
    await subject.query(
      `INSERT INTO addie_fixed_trace_component_smoke_run_plan
       (authorization_digest,assignment_id,probe_id,cell_id,disposition,maximum_provider_invocations,requested_provider,requested_model,requested_effort,pricing_profile_id,max_input_tokens,max_output_tokens,timeout_ms,retries,reserved_microdollars)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,0,$14)`,
      [digest, entry.assignmentId, entry.probeId, entry.cellId, entry.disposition, entry.maximumProviderInvocations, entry.provider,
        index === 0 && alterFirstModel ? `${entry.model}-forged` : entry.model, entry.effort, entry.pricingProfileId,
        entry.maxInputTokens, entry.maxOutputTokens, entry.timeoutMs, entry.reservedMicrodollars],
    );
  }
  return digest;
}

function dispatchEntry(offset = 0) { return plan.filter((entry) => entry.disposition === 'provider_dispatch')[offset]!; }
async function insertIntent(subject: Client, digest: string, entry = dispatchEntry(), suffix = 'e', ordinal = 1) {
  const token = suffix.length === 1 ? suffix.repeat(32) : suffix;
  return subject.query(
    `INSERT INTO addie_fixed_trace_component_smoke_attempts
     (attempt_id,authorization_digest,assignment_id,invocation_ordinal,status,prepared_request_hmac)
     VALUES ($1,$2,$3,$4,'intent_recorded',$5)`,
    [`attempt_${token}`, digest, entry.assignmentId, ordinal, 'f'.repeat(64)],
  );
}

/** Uses the build-check PostgreSQL database after normal migrations; no provider path exists. */
describe.skipIf(!databaseUrl)('private ledger migration on PostgreSQL', () => {
  beforeAll(async () => { client = new Client({ connectionString: databaseUrl }); await client.connect(); });
  beforeEach(async () => { await client!.query('BEGIN'); authorizationDigest = await seedExactPlan(); });
  afterEach(async () => { await client!.query('ROLLBACK'); });
  afterAll(async () => { await client?.end().catch(() => undefined); });

  it('uses the migrated 71-character pricing digest contract and bounded database TTL', async () => {
    const result = await client!.query<{ character_maximum_length: number | null }>("SELECT character_maximum_length FROM information_schema.columns WHERE table_name = 'addie_fixed_trace_component_smoke_authorizations' AND column_name = 'pricing_cohort_digest'");
    expect(result.rows).toEqual([{ character_maximum_length: 71 }]);
    await expect(rejects("UPDATE addie_fixed_trace_component_smoke_authorizations SET expires_at = issued_at + interval '16 minutes' WHERE authorization_digest = $1", [authorizationDigest])).resolves.toBeInstanceOf(Error);
  });

  it('rejects an initially forged full plan despite matching aggregate cardinality', async () => {
    await seedExactPlan(client!, true);
    await expect(rejects('SET CONSTRAINTS addie_fixed_trace_component_smoke_plan_exact IMMEDIATE')).resolves.toBeInstanceOf(Error);
  });

  it('permits only consumed intent insertion and rejects direct terminal insertion', async () => {
    await expect(rejects(`INSERT INTO addie_fixed_trace_component_smoke_attempts (attempt_id,authorization_digest,assignment_id,invocation_ordinal,status,prepared_request_hmac,response_hmac,returned_provider,returned_model,returned_effort,input_tokens,output_tokens,actual_cost_microdollars,latency_ms,terminal_at) VALUES ($1,$2,$3,1,'succeeded',$4,$5,$6,$7,$8,0,0,0,0,clock_timestamp())`, [`attempt_${'d'.repeat(32)}`, authorizationDigest, dispatchEntry().assignmentId, 'f'.repeat(64), '1'.repeat(64), dispatchEntry().provider, dispatchEntry().model, dispatchEntry().effort])).resolves.toBeInstanceOf(Error);
    await client!.query("UPDATE addie_fixed_trace_component_smoke_authorizations SET status = 'halted' WHERE authorization_digest = $1", [authorizationDigest]);
    await expect(rejects(`INSERT INTO addie_fixed_trace_component_smoke_attempts (attempt_id,authorization_digest,assignment_id,invocation_ordinal,status,prepared_request_hmac) VALUES ($1,$2,$3,1,'intent_recorded',$4)`, [`attempt_${'a'.repeat(32)}`, authorizationDigest, dispatchEntry().assignmentId, 'f'.repeat(64)])).resolves.toBeInstanceOf(Error);
    const unknown = await seedExactPlan();
    await client!.query("UPDATE addie_fixed_trace_component_smoke_authorizations SET status = 'unknown_exposure', unknown_exposure_at = clock_timestamp() WHERE authorization_digest = $1", [unknown]);
    await expect(rejects(`INSERT INTO addie_fixed_trace_component_smoke_attempts (attempt_id,authorization_digest,assignment_id,invocation_ordinal,status,prepared_request_hmac) VALUES ($1,$2,$3,1,'intent_recorded',$4)`, [`attempt_${'b'.repeat(32)}`, unknown, dispatchEntry().assignmentId, 'f'.repeat(64)])).resolves.toBeInstanceOf(Error);
  });

  it('enforces ordinal reservation and immutable direct SQL state', async () => {
    await insertIntent(client!, authorizationDigest);
    const attemptId = `attempt_${'e'.repeat(32)}`;
    await expect(rejects('UPDATE addie_fixed_trace_component_smoke_attempts SET actual_cost_microdollars = 99999999 WHERE attempt_id = $1', [attemptId])).resolves.toBeInstanceOf(Error);
    await expect(rejects("UPDATE addie_fixed_trace_component_smoke_attempts SET status = 'intent_recorded' WHERE attempt_id = $1", [attemptId])).resolves.toBeInstanceOf(Error);
    await expect(rejects('DELETE FROM addie_fixed_trace_component_smoke_attempts WHERE attempt_id = $1', [attemptId])).resolves.toBeInstanceOf(Error);
    await expect(rejects("UPDATE addie_fixed_trace_component_smoke_run_plan SET requested_model = 'changed' WHERE authorization_digest = $1", [authorizationDigest])).resolves.toBeInstanceOf(Error);
  });

  it('enforces contiguous ordinal sequencing and refuses a concurrent second open intent', async () => {
    const generation = plan.find((entry) => entry.disposition === 'provider_dispatch' && entry.maximumProviderInvocations === 2)!;
    await expect(rejects(`INSERT INTO addie_fixed_trace_component_smoke_attempts (attempt_id,authorization_digest,assignment_id,invocation_ordinal,status,prepared_request_hmac) VALUES ($1,$2,$3,2,'intent_recorded',$4)`, [`attempt_${'1'.repeat(32)}`, authorizationDigest, generation.assignmentId, 'f'.repeat(64)])).resolves.toBeInstanceOf(Error);
    await insertIntent(client!, authorizationDigest, generation, '2');
    await expect(rejects(`INSERT INTO addie_fixed_trace_component_smoke_attempts (attempt_id,authorization_digest,assignment_id,invocation_ordinal,status,prepared_request_hmac) VALUES ($1,$2,$3,2,'intent_recorded',$4)`, [`attempt_${'3'.repeat(32)}`, authorizationDigest, generation.assignmentId, 'f'.repeat(64)])).resolves.toBeInstanceOf(Error);
    await client!.query("UPDATE addie_fixed_trace_component_smoke_attempts SET status = 'succeeded', response_disposition = 'final_response', response_hmac = $2, returned_provider = $3, returned_model = $4, returned_effort = $5, input_tokens = 0, output_tokens = 0, cache_read_tokens = 0, cache_write_tokens = 0, actual_cost_microdollars = 0, latency_ms = 0, terminal_at = clock_timestamp() WHERE attempt_id = $1", [`attempt_${'2'.repeat(32)}`, '2'.repeat(64), generation.provider, generation.model, generation.effort]);
    await expect(rejects(`INSERT INTO addie_fixed_trace_component_smoke_attempts (attempt_id,authorization_digest,assignment_id,invocation_ordinal,status,prepared_request_hmac) VALUES ($1,$2,$3,2,'intent_recorded',$4)`, [`attempt_${'4'.repeat(32)}`, authorizationDigest, generation.assignmentId, 'f'.repeat(64)])).resolves.toBeInstanceOf(Error);
    await expect(rejects("UPDATE addie_fixed_trace_component_smoke_attempts SET status = 'succeeded', response_disposition = 'final_response', response_hmac = $2, returned_provider = 'wrong', returned_model = 'wrong', returned_effort = 'wrong', input_tokens = 0, output_tokens = 0, actual_cost_microdollars = 0, latency_ms = 0, terminal_at = clock_timestamp() WHERE attempt_id = $1", [`attempt_${'2'.repeat(32)}`, '2'.repeat(64)])).resolves.toBeInstanceOf(Error);
  });

  it('rejects mismatched identity and mismatched actual-cost settlement while each attempt is still open', async () => {
    const first = dispatchEntry(4);
    await insertIntent(client!, authorizationDigest, first, 'a');
    await expect(rejects("UPDATE addie_fixed_trace_component_smoke_attempts SET status = 'succeeded', response_disposition = 'final_response', response_hmac = $2, returned_provider = 'wrong', returned_model = 'wrong', returned_effort = 'wrong', input_tokens = 0, output_tokens = 0, actual_cost_microdollars = 0, latency_ms = 0, terminal_at = clock_timestamp() WHERE attempt_id = $1", [`attempt_${'a'.repeat(32)}`, 'a'.repeat(64)])).resolves.toBeInstanceOf(Error);
    expect((await client!.query('SELECT status FROM addie_fixed_trace_component_smoke_attempts WHERE attempt_id = $1', [`attempt_${'a'.repeat(32)}`])).rows).toEqual([{ status: 'intent_recorded' }]);
    await client!.query("UPDATE addie_fixed_trace_component_smoke_attempts SET status = 'succeeded', response_disposition = 'final_response', response_hmac = $2, returned_provider = $3, returned_model = $4, returned_effort = $5, input_tokens = 0, output_tokens = 0, cache_read_tokens = 0, cache_write_tokens = 0, actual_cost_microdollars = 0, latency_ms = 0, terminal_at = clock_timestamp() WHERE attempt_id = $1", [`attempt_${'a'.repeat(32)}`, 'a'.repeat(64), first.provider, first.model, first.effort]);
    const second = dispatchEntry(5);
    await insertIntent(client!, authorizationDigest, second, 'b');
    await expect(rejects("UPDATE addie_fixed_trace_component_smoke_attempts SET status = 'provider_failed', response_hmac = $2, returned_provider = 'wrong', returned_model = 'wrong', returned_effort = 'wrong', input_tokens = 0, output_tokens = 0, actual_cost_microdollars = 1, latency_ms = 0, terminal_at = clock_timestamp() WHERE attempt_id = $1", [`attempt_${'b'.repeat(32)}`, 'b'.repeat(64)])).resolves.toBeInstanceOf(Error);
    expect((await client!.query('SELECT status FROM addie_fixed_trace_component_smoke_attempts WHERE attempt_id = $1', [`attempt_${'b'.repeat(32)}`])).rows).toEqual([{ status: 'intent_recorded' }]);
  });

  it('rejects contradictory terminal receipt accounting evidence at the database boundary', async () => {
    const entry = dispatchEntry(7);
    const attemptId = `attempt_${'d'.repeat(32)}`;
    await insertIntent(client!, authorizationDigest, entry, 'd');
    await expect(rejects("UPDATE addie_fixed_trace_component_smoke_attempts SET status = 'identity_mismatch', response_hmac = $2, returned_provider = $3, returned_model = $4, returned_effort = $5, input_tokens = 0, output_tokens = 0, cache_read_tokens = 0, cache_write_tokens = 0, latency_ms = 0, terminal_at = clock_timestamp() WHERE attempt_id = $1", [attemptId, 'd'.repeat(64), entry.provider, entry.model, entry.effort])).resolves.toBeInstanceOf(Error);
    await expect(rejects("UPDATE addie_fixed_trace_component_smoke_attempts SET status = 'succeeded', response_disposition = 'final_response', response_hmac = $2, returned_provider = $3, returned_model = $4, returned_effort = $5, input_tokens = 0, output_tokens = 0, cache_read_tokens = 0, cache_write_tokens = 0, actual_cost_microdollars = 0, observed_cost_microdollars = 0, latency_ms = 0, terminal_at = clock_timestamp() WHERE attempt_id = $1", [attemptId, 'd'.repeat(64), entry.provider, entry.model, entry.effort])).resolves.toBeInstanceOf(Error);
    await expect(rejects("UPDATE addie_fixed_trace_component_smoke_attempts SET status = 'provider_failed', response_hmac = NULL, returned_provider = NULL, returned_model = NULL, returned_effort = NULL, input_tokens = NULL, output_tokens = NULL, cache_read_tokens = NULL, cache_write_tokens = NULL, actual_cost_microdollars = NULL, observed_cost_microdollars = NULL, latency_ms = NULL, terminal_at = clock_timestamp() WHERE attempt_id = $1", [attemptId])).resolves.toBeInstanceOf(Error);
    expect((await client!.query('SELECT status FROM addie_fixed_trace_component_smoke_attempts WHERE attempt_id = $1', [attemptId])).rows).toEqual([{ status: 'intent_recorded' }]);
  });

  it('derives exact profile pricing and integer rounding at the database boundary', async () => {
    const vectors = [
      ['anthropic-standard-2026-09:claude-haiku-4-5', 1, 0, 1, 1, 3],
      ['anthropic-standard-2026-09:claude-sonnet-5', 1, 0, 1, 1, 5],
      ['openai-gpt-5.6-luna-standard-2026-09-05', 2, 0, 1, 1, 1],
      ['google-gemini-3.7-flash-through-2026-12-31', 1, 0, 1, 0, 1],
    ] as const;
    for (const [index, [profileId, input, output, cacheRead, cacheWrite, expectedCost]] of vectors.entries()) {
      const entry = plan.find((candidate) => candidate.disposition === 'provider_dispatch' && candidate.pricingProfileId === profileId)!;
      const suffix = (index + 1).toString(16);
      const attemptId = `attempt_${suffix.repeat(32)}`;
      await insertIntent(client!, authorizationDigest, entry, suffix);
      await expect(rejects("UPDATE addie_fixed_trace_component_smoke_attempts SET status = 'succeeded', response_disposition = 'final_response', response_hmac = $2, returned_provider = $3, returned_model = $4, returned_effort = $5, input_tokens = $6, output_tokens = $7, cache_read_tokens = $8, cache_write_tokens = $9, actual_cost_microdollars = $10, latency_ms = 0, terminal_at = clock_timestamp() WHERE attempt_id = $1", [attemptId, suffix.repeat(64), entry.provider, entry.model, entry.effort, input, output, cacheRead, cacheWrite, expectedCost + 1])).resolves.toBeInstanceOf(Error);
      await client!.query("UPDATE addie_fixed_trace_component_smoke_attempts SET status = 'succeeded', response_disposition = 'final_response', response_hmac = $2, returned_provider = $3, returned_model = $4, returned_effort = $5, input_tokens = $6, output_tokens = $7, cache_read_tokens = $8, cache_write_tokens = $9, actual_cost_microdollars = $10, latency_ms = 0, terminal_at = clock_timestamp() WHERE attempt_id = $1", [attemptId, suffix.repeat(64), entry.provider, entry.model, entry.effort, input, output, cacheRead, cacheWrite, expectedCost]);
    }
    const entry = dispatchEntry(10);
    await insertIntent(client!, authorizationDigest, entry, 'f');
    await expect(rejects("UPDATE addie_fixed_trace_component_smoke_attempts SET status = 'invalid_limits', response_hmac = $2, returned_provider = $3, returned_model = $4, returned_effort = $5, input_tokens = 0, output_tokens = 0, cache_read_tokens = 0, cache_write_tokens = 0, observed_cost_microdollars = NULL, latency_ms = 0, terminal_at = clock_timestamp() WHERE attempt_id = $1", [`attempt_${'f'.repeat(32)}`, 'f'.repeat(64), entry.provider, entry.model, entry.effort])).resolves.toBeInstanceOf(Error);
  });

  it('application terminalization uses the locked aggregate CTE on PostgreSQL', async () => {
    const entry = dispatchEntry(11);
    const attemptId = `attempt_${'c'.repeat(31)}d`;
    await client!.query('COMMIT');
    const pool = new Pool({ connectionString: databaseUrl });
    try {
      const ledger = new PostgresFixedTraceComponentSmokePrivateLedger(pool);
      expect(await ledger.recordProviderIntent({ reservation: reservationFor(authorizationDigest), attemptId, assignmentId: entry.assignmentId, invocationOrdinal: 1, preparedRequestHmac: 'c'.repeat(64) })).toEqual({ status: 'recorded' });
      expect(await ledger.recordTerminal({ reservation: reservationFor(authorizationDigest), attemptId, status: 'succeeded', responseDisposition: 'final_response', responseHmac: 'd'.repeat(64), returnedIdentity: { provider: entry.provider, model: entry.model, effort: entry.effort }, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, latencyMs: 0 } })).toEqual({ status: 'recorded' });
      expect((await client!.query('SELECT status, actual_cost_microdollars FROM addie_fixed_trace_component_smoke_attempts WHERE attempt_id = $1', [attemptId])).rows).toEqual([{ status: 'succeeded', actual_cost_microdollars: '0' }]);
    } finally {
      await pool.end();
      await client!.query('BEGIN');
    }
  });

  it.each([
    ['provider_failed', 'unknown_exposure', "status = 'provider_failed', response_hmac = $2, returned_provider = $3, returned_model = $4, returned_effort = $5, input_tokens = 0, output_tokens = 0, cache_read_tokens = 0, cache_write_tokens = 0, actual_cost_microdollars = 0, latency_ms = 0"],
    ['malformed_response', 'unknown_exposure', "status = 'malformed_response', response_hmac = $2"],
    ['identity_mismatch', 'unknown_exposure', "status = 'identity_mismatch', response_hmac = $2, returned_provider = 'other', returned_model = 'other', returned_effort = 'other', input_tokens = 0, output_tokens = 0, cache_read_tokens = 0, cache_write_tokens = 0, latency_ms = 0"],
    ['missing_usage', 'unknown_exposure', "status = 'missing_usage', response_hmac = $2, returned_provider = $3, returned_model = $4, returned_effort = $5"],
    ['timeout_after_dispatch', 'unknown_exposure', "status = 'timeout_after_dispatch'"],
    ['invalid_limits', 'halted', "status = 'invalid_limits', response_hmac = $2, returned_provider = $3, returned_model = $4, returned_effort = $5, input_tokens = 0, output_tokens = 0, cache_read_tokens = 0, cache_write_tokens = 0, observed_cost_microdollars = 0, latency_ms = 0"],
    ['pricing_unavailable', 'unknown_exposure', "status = 'pricing_unavailable'"],
    ['unknown_exposure', 'unknown_exposure', "status = 'unknown_exposure'"],
  ] as const)('makes direct-SQL %s terminal nondispatchable', async (status, expectedAuthorizationStatus, assignment) => {
    const digest = await seedExactPlan(client!);
    const entry = dispatchEntry(12);
    const suffix = `${({ provider_failed: '1', malformed_response: '2', identity_mismatch: '3', missing_usage: '4', timeout_after_dispatch: '5', invalid_limits: '6', pricing_unavailable: '7', unknown_exposure: '8' } as Record<string, string>)[status]}`;
    const attemptId = `attempt_${suffix.repeat(32)}`;
    await insertIntent(client!, digest, entry, suffix);
    const values: unknown[] = [attemptId];
    if (assignment.includes('$2')) values.push('e'.repeat(64));
    if (assignment.includes('$3')) values.push(entry.provider);
    if (assignment.includes('$4')) values.push(entry.model);
    if (assignment.includes('$5')) values.push(entry.effort);
    await client!.query(`UPDATE addie_fixed_trace_component_smoke_attempts SET ${assignment}, terminal_at = clock_timestamp() WHERE attempt_id = $1`, values);
    expect((await client!.query('SELECT status FROM addie_fixed_trace_component_smoke_authorizations WHERE authorization_digest = $1', [digest])).rows).toEqual([{ status: expectedAuthorizationStatus }]);
    await expect(rejects("INSERT INTO addie_fixed_trace_component_smoke_attempts (attempt_id,authorization_digest,assignment_id,invocation_ordinal,status,prepared_request_hmac) VALUES ($1,$2,$3,1,'intent_recorded',$4)", [`attempt_${'f'.repeat(32)}`, digest, dispatchEntry(13).assignmentId, 'f'.repeat(64)])).resolves.toBeInstanceOf(Error);
    if (status === 'provider_failed') {
      await client!.query("UPDATE addie_fixed_trace_component_smoke_run_plan SET assignment_outcome = 'provider_failed', assignment_terminal_at = clock_timestamp(), assignment_final_invocation_ordinal = 1 WHERE authorization_digest = $1 AND assignment_id = $2", [digest, entry.assignmentId]);
      expect((await client!.query('SELECT assignment_outcome FROM addie_fixed_trace_component_smoke_run_plan WHERE authorization_digest = $1 AND assignment_id = $2', [digest, entry.assignmentId])).rows).toEqual([{ assignment_outcome: 'provider_failed' }]);
    }
  });

  it('idempotently recovers a committed provider failure after unknown exposure has already committed', async () => {
    const entry = dispatchEntry(6);
    await insertIntent(client!, authorizationDigest, entry, 'c');
    await client!.query("UPDATE addie_fixed_trace_component_smoke_attempts SET status = 'provider_failed', response_hmac = $2, returned_provider = $3, returned_model = $4, returned_effort = $5, input_tokens = 0, output_tokens = 0, cache_read_tokens = 0, cache_write_tokens = 0, actual_cost_microdollars = 0, latency_ms = 0, terminal_at = clock_timestamp() WHERE attempt_id = $1", [`attempt_${'c'.repeat(32)}`, 'c'.repeat(64), entry.provider, entry.model, entry.effort]);
    await client!.query('COMMIT');
    const pool = new Pool({ connectionString: databaseUrl });
    try {
      const ledger = new PostgresFixedTraceComponentSmokePrivateLedger(pool);
      expect(await ledger.recordUnknownExposure(reservationFor(authorizationDigest))).toEqual({ status: 'recorded' });
      expect(await ledger.recordUnknownExposure(reservationFor(authorizationDigest))).toEqual({ status: 'recorded' });
    } finally {
      await pool.end();
      await client!.query('BEGIN');
    }
    expect((await client!.query('SELECT assignment_outcome FROM addie_fixed_trace_component_smoke_run_plan WHERE authorization_digest = $1 AND assignment_id = $2', [authorizationDigest, entry.assignmentId])).rows).toEqual([{ assignment_outcome: 'provider_failed' }]);
  });

  it('settles an admitted maximum-ordinal continuation as a halt with observed cost', async () => {
    const router = dispatchEntry();
    await insertIntent(client!, authorizationDigest, router, '5');
    await client!.query("UPDATE addie_fixed_trace_component_smoke_attempts SET status = 'succeeded', response_disposition = 'tool_continuation_required', response_hmac = $2, returned_provider = $3, returned_model = $4, returned_effort = $5, input_tokens = 0, output_tokens = 0, cache_read_tokens = 0, cache_write_tokens = 0, actual_cost_microdollars = 0, latency_ms = 0, terminal_at = clock_timestamp() WHERE attempt_id = $1", [`attempt_${'5'.repeat(32)}`, '5'.repeat(64), router.provider, router.model, router.effort]);
    expect((await client!.query('SELECT status, actual_cost_microdollars, observed_cost_microdollars FROM addie_fixed_trace_component_smoke_attempts WHERE attempt_id = $1', [`attempt_${'5'.repeat(32)}`])).rows).toEqual([{ status: 'invalid_limits', actual_cost_microdollars: null, observed_cost_microdollars: '0' }]);
    expect((await client!.query('SELECT status FROM addie_fixed_trace_component_smoke_authorizations WHERE authorization_digest = $1', [authorizationDigest])).rows).toEqual([{ status: 'halted' }]);
    await client!.query("UPDATE addie_fixed_trace_component_smoke_run_plan SET assignment_outcome = 'provider_failed', assignment_terminal_at = clock_timestamp(), assignment_final_invocation_ordinal = 1 WHERE authorization_digest = $1 AND assignment_id = $2", [authorizationDigest, router.assignmentId]);
  });

  it('serializes direct concurrent intents and closes a started ambiguous assignment without receipt evidence', async () => {
    await client!.query('COMMIT');
    const contender = new Client({ connectionString: databaseUrl });
    await contender.connect();
    const started = dispatchEntry();
    try {
      await client!.query('BEGIN');
      await insertIntent(client!, authorizationDigest, started, '6');
      let settled = false;
      const competing = insertIntent(contender, authorizationDigest, dispatchEntry(1), '7').then(() => { settled = true; }, () => { settled = true; });
      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(settled).toBe(false);
      await client!.query('COMMIT');
      await competing;
      expect(settled).toBe(true);
      await client!.query('BEGIN');
      await client!.query("UPDATE addie_fixed_trace_component_smoke_authorizations SET status = 'unknown_exposure', unknown_exposure_at = clock_timestamp() WHERE authorization_digest = $1", [authorizationDigest]);
      await client!.query("UPDATE addie_fixed_trace_component_smoke_attempts SET status = 'unknown_exposure', terminal_at = clock_timestamp() WHERE attempt_id = $1", [`attempt_${'6'.repeat(32)}`]);
      await client!.query("UPDATE addie_fixed_trace_component_smoke_run_plan SET assignment_outcome = 'provider_unknown_exposure', assignment_terminal_at = clock_timestamp(), assignment_final_invocation_ordinal = 1 WHERE authorization_digest = $1 AND assignment_id = $2", [authorizationDigest, started.assignmentId]);
      expect((await client!.query('SELECT status, assignment_outcome FROM addie_fixed_trace_component_smoke_authorizations a JOIN addie_fixed_trace_component_smoke_run_plan p USING (authorization_digest) WHERE a.authorization_digest = $1 AND p.assignment_id = $2', [authorizationDigest, started.assignmentId])).rows).toEqual([{ status: 'unknown_exposure', assignment_outcome: 'provider_unknown_exposure' }]);
      for (const entry of plan.filter((entry) => entry.assignmentId !== started.assignmentId)) {
        await client!.query("UPDATE addie_fixed_trace_component_smoke_run_plan SET assignment_outcome = 'not_executed_after_halt', assignment_terminal_at = clock_timestamp() WHERE authorization_digest = $1 AND assignment_id = $2", [authorizationDigest, entry.assignmentId]);
      }
      expect((await client!.query('SELECT status, count(*) FILTER (WHERE assignment_outcome IS NOT NULL)::int AS outcomes FROM addie_fixed_trace_component_smoke_authorizations a JOIN addie_fixed_trace_component_smoke_run_plan p USING (authorization_digest) WHERE a.authorization_digest = $1 GROUP BY status', [authorizationDigest])).rows).toEqual([{ status: 'unknown_exposure', outcomes: 168 }]);
    } finally { await contender.end(); }
  });

  it('keeps one assignment outcome separate from invocation attempts and closes halted omissions', async () => {
    const generation = plan.find((entry) => entry.disposition === 'provider_dispatch' && entry.maximumProviderInvocations === 2)!;
    await expect(rejects("UPDATE addie_fixed_trace_component_smoke_run_plan SET assignment_outcome = 'provider_completed', assignment_terminal_at = clock_timestamp(), assignment_final_invocation_ordinal = 1 WHERE authorization_digest = $1 AND assignment_id = $2", [authorizationDigest, generation.assignmentId])).resolves.toBeInstanceOf(Error);
    await insertIntent(client!, authorizationDigest, generation);
    await client!.query("UPDATE addie_fixed_trace_component_smoke_attempts SET status = 'succeeded', response_disposition = 'tool_continuation_required', response_hmac = $2, returned_provider = $3, returned_model = $4, returned_effort = $5, input_tokens = 0, output_tokens = 0, cache_read_tokens = 0, cache_write_tokens = 0, actual_cost_microdollars = 0, latency_ms = 0, terminal_at = clock_timestamp() WHERE attempt_id = $1", [`attempt_${'e'.repeat(32)}`, '1'.repeat(64), generation.provider, generation.model, generation.effort]);
    await expect(rejects("UPDATE addie_fixed_trace_component_smoke_run_plan SET assignment_outcome = 'provider_completed', assignment_terminal_at = clock_timestamp(), assignment_final_invocation_ordinal = 1 WHERE authorization_digest = $1 AND assignment_id = $2", [authorizationDigest, generation.assignmentId])).resolves.toBeInstanceOf(Error);
    await insertIntent(client!, authorizationDigest, generation, '8', 2);
    await client!.query("UPDATE addie_fixed_trace_component_smoke_attempts SET status = 'succeeded', response_disposition = 'final_response', response_hmac = $2, returned_provider = $3, returned_model = $4, returned_effort = $5, input_tokens = 0, output_tokens = 0, cache_read_tokens = 0, cache_write_tokens = 0, actual_cost_microdollars = 0, latency_ms = 0, terminal_at = clock_timestamp() WHERE attempt_id = $1", [`attempt_${'8'.repeat(32)}`, '3'.repeat(64), generation.provider, generation.model, generation.effort]);
    await client!.query("UPDATE addie_fixed_trace_component_smoke_run_plan SET assignment_outcome = 'provider_completed', assignment_terminal_at = clock_timestamp(), assignment_final_invocation_ordinal = 2 WHERE authorization_digest = $1 AND assignment_id = $2", [authorizationDigest, generation.assignmentId]);
    const router = dispatchEntry();
    await insertIntent(client!, authorizationDigest, router, '7');
    await client!.query("UPDATE addie_fixed_trace_component_smoke_attempts SET status = 'succeeded', response_disposition = 'final_response', response_hmac = $2, returned_provider = $3, returned_model = $4, returned_effort = $5, input_tokens = 0, output_tokens = 0, cache_read_tokens = 0, cache_write_tokens = 0, actual_cost_microdollars = 0, latency_ms = 0, terminal_at = clock_timestamp() WHERE attempt_id = $1", [`attempt_${'7'.repeat(32)}`, '2'.repeat(64), router.provider, router.model, router.effort]);
    await client!.query("UPDATE addie_fixed_trace_component_smoke_run_plan SET assignment_outcome = 'provider_completed', assignment_terminal_at = clock_timestamp(), assignment_final_invocation_ordinal = 1 WHERE authorization_digest = $1 AND assignment_id = $2", [authorizationDigest, router.assignmentId]);
    await expect(rejects("UPDATE addie_fixed_trace_component_smoke_run_plan SET assignment_outcome = 'provider_completed', assignment_terminal_at = clock_timestamp(), assignment_final_invocation_ordinal = 1 WHERE authorization_digest = $1 AND assignment_id = $2", [authorizationDigest, router.assignmentId])).resolves.toBeInstanceOf(Error);
    const finalFirst = plan.filter((entry) => entry.disposition === 'provider_dispatch' && entry.maximumProviderInvocations === 2)[1]!;
    await insertIntent(client!, authorizationDigest, finalFirst, '9');
    await client!.query("UPDATE addie_fixed_trace_component_smoke_attempts SET status = 'succeeded', response_disposition = 'final_response', response_hmac = $2, returned_provider = $3, returned_model = $4, returned_effort = $5, input_tokens = 0, output_tokens = 0, cache_read_tokens = 0, cache_write_tokens = 0, actual_cost_microdollars = 0, latency_ms = 0, terminal_at = clock_timestamp() WHERE attempt_id = $1", [`attempt_${'9'.repeat(32)}`, '4'.repeat(64), finalFirst.provider, finalFirst.model, finalFirst.effort]);
    await client!.query("UPDATE addie_fixed_trace_component_smoke_run_plan SET assignment_outcome = 'provider_completed', assignment_terminal_at = clock_timestamp(), assignment_final_invocation_ordinal = 1 WHERE authorization_digest = $1 AND assignment_id = $2", [authorizationDigest, finalFirst.assignmentId]);
    await expect(rejects(`INSERT INTO addie_fixed_trace_component_smoke_attempts (attempt_id,authorization_digest,assignment_id,invocation_ordinal,status,prepared_request_hmac) VALUES ($1,$2,$3,2,'intent_recorded',$4)`, [`attempt_${'0'.repeat(32)}`, authorizationDigest, finalFirst.assignmentId, 'f'.repeat(64)])).resolves.toBeInstanceOf(Error);
    await client!.query("UPDATE addie_fixed_trace_component_smoke_authorizations SET status = 'halted' WHERE authorization_digest = $1", [authorizationDigest]);
    const local = plan.find((entry) => entry.disposition === 'local_terminal')!;
    const untouchedProvider = dispatchEntry(2);
    await client!.query("UPDATE addie_fixed_trace_component_smoke_run_plan SET assignment_outcome = 'not_executed_after_halt', assignment_terminal_at = clock_timestamp() WHERE authorization_digest = $1 AND assignment_id = $2", [authorizationDigest, local.assignmentId]);
    await client!.query("UPDATE addie_fixed_trace_component_smoke_run_plan SET assignment_outcome = 'not_executed_after_halt', assignment_terminal_at = clock_timestamp() WHERE authorization_digest = $1 AND assignment_id = $2", [authorizationDigest, untouchedProvider.assignmentId]);
    await expect(rejects("UPDATE addie_fixed_trace_component_smoke_run_plan SET assignment_outcome = 'not_executed_after_halt', assignment_terminal_at = clock_timestamp() WHERE authorization_digest = $1 AND assignment_id = $2", [authorizationDigest, generation.assignmentId])).resolves.toBeInstanceOf(Error);
  });

  it('serializes a concurrent intent behind unknown exposure and refuses it after the lock releases', async () => {
    await client!.query('COMMIT');
    const contender = new Client({ connectionString: databaseUrl });
    await contender.connect();
    try {
      await client!.query('BEGIN');
      await client!.query('SELECT 1 FROM addie_fixed_trace_component_smoke_authorizations WHERE authorization_digest = $1 FOR UPDATE', [authorizationDigest]);
      let settled = false;
      const competing = insertIntent(contender, authorizationDigest, dispatchEntry(1), '9').then(() => { settled = true; }, () => { settled = true; });
      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(settled).toBe(false);
      await client!.query("UPDATE addie_fixed_trace_component_smoke_authorizations SET status = 'unknown_exposure', unknown_exposure_at = clock_timestamp() WHERE authorization_digest = $1", [authorizationDigest]);
      await client!.query('COMMIT');
      await competing;
      expect(settled).toBe(true);
      const attempts = await contender.query('SELECT count(*)::int AS count FROM addie_fixed_trace_component_smoke_attempts WHERE authorization_digest = $1', [authorizationDigest]);
      expect(attempts.rows).toEqual([{ count: 0 }]);
    } finally { await contender.end(); await client!.query('BEGIN'); }
  });

  it('serializes the final two assignment outcomes and transitions the denominator to completed', async () => {
    await expect(rejects("UPDATE addie_fixed_trace_component_smoke_authorizations SET status = 'completed' WHERE authorization_digest = $1", [authorizationDigest])).resolves.toBeInstanceOf(Error);
    const finalTwo = plan.filter((entry) => entry.disposition !== 'provider_dispatch').slice(0, 2);
    let index = 0;
    for (const entry of plan) {
      if (finalTwo.some((remaining) => remaining.assignmentId === entry.assignmentId)) continue;
      if (entry.disposition === 'provider_dispatch') {
        const token = (++index).toString(16).padStart(32, '0');
        await insertIntent(client!, authorizationDigest, entry, token);
        await client!.query("UPDATE addie_fixed_trace_component_smoke_attempts SET status = 'succeeded', response_disposition = 'final_response', response_hmac = $2, returned_provider = $3, returned_model = $4, returned_effort = $5, input_tokens = 0, output_tokens = 0, cache_read_tokens = 0, cache_write_tokens = 0, actual_cost_microdollars = 0, latency_ms = 0, terminal_at = clock_timestamp() WHERE attempt_id = $1", [`attempt_${token}`, 'a'.repeat(64), entry.provider, entry.model, entry.effort]);
        await client!.query("UPDATE addie_fixed_trace_component_smoke_run_plan SET assignment_outcome = 'provider_completed', assignment_terminal_at = clock_timestamp(), assignment_final_invocation_ordinal = 1 WHERE authorization_digest = $1 AND assignment_id = $2", [authorizationDigest, entry.assignmentId]);
      } else {
        await client!.query('UPDATE addie_fixed_trace_component_smoke_run_plan SET assignment_outcome = $3, assignment_terminal_at = clock_timestamp() WHERE authorization_digest = $1 AND assignment_id = $2', [authorizationDigest, entry.assignmentId, entry.disposition]);
      }
    }
    await client!.query('COMMIT');
    const first = new Client({ connectionString: databaseUrl });
    const second = new Client({ connectionString: databaseUrl });
    await first.connect(); await second.connect();
    try {
      await first.query('BEGIN'); await second.query('BEGIN');
      await first.query('UPDATE addie_fixed_trace_component_smoke_run_plan SET assignment_outcome = $3, assignment_terminal_at = clock_timestamp() WHERE authorization_digest = $1 AND assignment_id = $2', [authorizationDigest, finalTwo[0]!.assignmentId, finalTwo[0]!.disposition]);
      let settled = false;
      const closeSecond = second.query('UPDATE addie_fixed_trace_component_smoke_run_plan SET assignment_outcome = $3, assignment_terminal_at = clock_timestamp() WHERE authorization_digest = $1 AND assignment_id = $2', [authorizationDigest, finalTwo[1]!.assignmentId, finalTwo[1]!.disposition]).then(() => { settled = true; });
      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(settled).toBe(false);
      await first.query('COMMIT');
      await closeSecond;
      await second.query('COMMIT');
    } finally {
      await first.end(); await second.end(); await client!.query('BEGIN');
    }
    expect((await client!.query('SELECT status FROM addie_fixed_trace_component_smoke_authorizations WHERE authorization_digest = $1', [authorizationDigest])).rows).toEqual([{ status: 'completed' }]);
    await expect(rejects(`INSERT INTO addie_fixed_trace_component_smoke_attempts (attempt_id,authorization_digest,assignment_id,invocation_ordinal,status,prepared_request_hmac) VALUES ($1,$2,$3,1,'intent_recorded',$4)`, [`attempt_${'f'.repeat(32)}`, authorizationDigest, dispatchEntry().assignmentId, 'f'.repeat(64)])).resolves.toBeInstanceOf(Error);
  });
});
