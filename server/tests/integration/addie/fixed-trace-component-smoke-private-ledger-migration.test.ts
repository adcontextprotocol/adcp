import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Client, Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fixedTraceComponentSmokeAdmission } from '../../../src/addie/eval/fixed-trace-component-smoke-admission.js';
import { PostgresFixedTraceComponentSmokePrivateLedger, fixedTraceComponentSmokePrivateLedgerPlan } from '../../../src/addie/eval/fixed-trace-component-smoke-private-ledger.js';

const databaseUrl = process.env.DATABASE_URL;
let client: Client | null = null;
let authorizationDigest = '';
const plan = fixedTraceComponentSmokePrivateLedgerPlan()!;
const admission = fixedTraceComponentSmokeAdmission();
const LEGACY_ADMISSION_FINGERPRINT = '731930c18475672a0ec6b44c9ff91fa89d30c441e34af32b536a28258271077d';
const BASE_LEDGER_MIGRATION = readFileSync(new URL('../../../src/db/migrations/582_addie_fixed_trace_component_smoke_private_ledger.sql', import.meta.url), 'utf8');
const REISSUED_GUARD_MIGRATION = readFileSync(new URL('../../../src/db/migrations/583_reissue_addie_fixed_trace_component_smoke_plan_guard.sql', import.meta.url), 'utf8');

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
function uniqueAttemptId() { return `attempt_${createHash('sha256').update(randomUUID()).digest('hex').slice(0, 32)}`; }
function deferred() {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve: () => resolve?.() };
}

async function insertAuthorization(
  subject = client!,
  aggregateAdmissionFingerprint = admission.fingerprints.aggregateAdmission,
) {
  const digest = createHash('sha256').update(randomUUID()).digest('hex');
  await subject.query(
    `INSERT INTO addie_fixed_trace_component_smoke_authorizations
     (authorization_digest,signed_payload_digest,signature_digest,kid,nonce_commitment,grant_version,stage_id,admission_version,aggregate_admission_fingerprint,
      probes,router_cells,generation_cells,total_cells,repetitions,assignments,provider_dispatch_assignments,local_terminal_assignments,pre_dispatch_fault_assignments,
      maximum_planned_invocation_slots,maximum_provider_invocations,reservation_microdollars,provider_ceiling_microdollars,pricing_cohort_digest,issued_at,expires_at,status,consumed_at,reservation_id)
     VALUES ($1,$2,$3,'postgres-ledger-test',$4,'addie-fixed-trace-component-smoke-signed-grant-v1','stage_1_smoke','addie-fixed-trace-component-smoke-admission-v2',
       $7,8,10,11,21,1,168,126,21,21,256,192,2819484,5000000,$5,
       clock_timestamp() - interval '1 minute',clock_timestamp() + interval '1 minute','consumed',clock_timestamp(),$6)`,
    [digest, createHash('sha256').update(`${digest}:payload`).digest('hex'), createHash('sha256').update(`${digest}:signature`).digest('hex'), createHash('sha256').update(`${digest}:nonce`).digest('hex'), admission.pricing.cohortDigest, reservationIdFor(digest), aggregateAdmissionFingerprint],
  );
  return digest;
}

function planForAdmissionFingerprint(aggregateAdmissionFingerprint: string) {
  if (aggregateAdmissionFingerprint === admission.fingerprints.aggregateAdmission) return plan;
  if (aggregateAdmissionFingerprint !== LEGACY_ADMISSION_FINGERPRINT) {
    throw new Error('test only supports the current or migration-582 admission fingerprint');
  }
  return plan.map((entry) => ({
    ...entry,
    assignmentId: createHash('sha256').update(JSON.stringify({
      cellId: entry.cellId,
      domain: 'adcp:addie:fixed-trace-component-smoke:plan-entry:v1\0',
      fingerprint: aggregateAdmissionFingerprint,
      probeId: entry.probeId,
    })).digest('hex'),
  }));
}

async function seedExactPlan(
  subject = client!,
  alterFirstModel = false,
  aggregateAdmissionFingerprint = admission.fingerprints.aggregateAdmission,
) {
  const digest = await insertAuthorization(subject, aggregateAdmissionFingerprint);
  for (const [index, entry] of planForAdmissionFingerprint(aggregateAdmissionFingerprint).entries()) {
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

async function withLedgerMigrationSchema(work: (subject: Client) => Promise<void>) {
  const schema = `fixed_trace_smoke_guard_${process.pid}_${randomUUID().replaceAll('-', '')}`;
  const isolated = new Client({ connectionString: databaseUrl });
  await isolated.connect();
  try {
    await isolated.query(`CREATE SCHEMA ${schema}`);
    await isolated.query(`SET search_path TO ${schema}, public`);
    await isolated.query(BASE_LEDGER_MIGRATION);
    await work(isolated);
  } finally {
    await isolated.query('RESET search_path').catch(() => undefined);
    await isolated.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
    await isolated.end();
  }
}

function dispatchEntry(offset = 0) { return plan.filter((entry) => entry.disposition === 'provider_dispatch')[offset]!; }
function dispatchEntryFor(aggregateAdmissionFingerprint: string) {
  return planForAdmissionFingerprint(aggregateAdmissionFingerprint)
    .find((entry) => entry.disposition === 'provider_dispatch')!;
}
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

  it('applies the reissued guard to a clean schema and accepts the current exact plan', async () => {
    await withLedgerMigrationSchema(async (isolated) => {
      await isolated.query(REISSUED_GUARD_MIGRATION);
      await isolated.query('BEGIN');
      const currentAuthorization = await seedExactPlan(isolated);
      await isolated.query('SET CONSTRAINTS addie_fixed_trace_component_smoke_plan_exact IMMEDIATE');
      await isolated.query('COMMIT');
      await expect(insertIntent(isolated, currentAuthorization)).resolves.toBeDefined();
      const guard = await isolated.query<{ definition: string }>(
        "SELECT pg_get_functiondef('addie_fixed_trace_component_smoke_check_plan_group(character)'::regprocedure) AS definition",
      );
      expect(guard.rows[0]?.definition).toContain('c9b2b82185f4723cb8059e0c2064d946d825939ef84b813d3df8f3ef11656530');
      expect(guard.rows[0]?.definition).toContain(admission.fingerprints.aggregateAdmission);
    });
  });

  it('upgrades a migration-582 schema without discarding legacy authority and fails it closed', async () => {
    await withLedgerMigrationSchema(async (isolated) => {
      // Commit the full exact migration-582 plan before the reissue. Its
      // deferred plan trigger will not fire again after the upgrade.
      await isolated.query('BEGIN');
      const legacyAuthorization = await seedExactPlan(isolated, false, LEGACY_ADMISSION_FINGERPRINT);
      await isolated.query('SET CONSTRAINTS addie_fixed_trace_component_smoke_plan_exact IMMEDIATE');
      await isolated.query('COMMIT');
      await isolated.query(REISSUED_GUARD_MIGRATION);
      expect((await isolated.query(
        'SELECT aggregate_admission_fingerprint FROM addie_fixed_trace_component_smoke_authorizations WHERE authorization_digest = $1',
        [legacyAuthorization],
      )).rows).toEqual([{ aggregate_admission_fingerprint: LEGACY_ADMISSION_FINGERPRINT }]);
      expect((await isolated.query(
        'SELECT count(*)::int AS count FROM addie_fixed_trace_component_smoke_run_plan WHERE authorization_digest = $1',
        [legacyAuthorization],
      )).rows).toEqual([{ count: 168 }]);
      await expect(isolated.query(
        'SELECT addie_fixed_trace_component_smoke_check_plan_group($1)', [legacyAuthorization],
      )).rejects.toThrow('fixed-trace component smoke plan is not the admitted exact plan');
      await isolated.query('BEGIN');
      const currentAuthorization = await seedExactPlan(isolated);
      await isolated.query('SET CONSTRAINTS addie_fixed_trace_component_smoke_plan_exact IMMEDIATE');
      await isolated.query('COMMIT');
      await expect(insertIntent(isolated, legacyAuthorization, dispatchEntryFor(LEGACY_ADMISSION_FINGERPRINT), 'l')).rejects.toThrow('fixed-trace component smoke plan is not the admitted exact plan');
      await expect(insertIntent(isolated, currentAuthorization, undefined, 'c')).resolves.toBeDefined();
    });
  });

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
    const attemptId = uniqueAttemptId();
    await client!.query('COMMIT');
    const pool = new Pool({ connectionString: databaseUrl });
    try {
      const ledger = new PostgresFixedTraceComponentSmokePrivateLedger(pool);
      expect(await ledger.recordProviderIntent({ reservation: reservationFor(authorizationDigest), attemptId, assignmentId: entry.assignmentId, invocationOrdinal: 1, preparedRequestHmac: 'c'.repeat(64) })).toEqual({ status: 'recorded' });
      expect(await ledger.recordTerminal({ reservation: reservationFor(authorizationDigest), attemptId, status: 'succeeded', responseDisposition: 'final_response', responseHmac: 'd'.repeat(64), returnedIdentity: { provider: entry.provider, model: entry.model, effort: entry.effort }, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, latencyMs: 0 } })).toEqual({ status: 'recorded' });
      expect(await ledger.recordProviderAssignmentTerminal({ reservation: reservationFor(authorizationDigest), assignmentId: entry.assignmentId, status: 'provider_completed', finalInvocationOrdinal: 1 })).toEqual({ status: 'recorded' });
      expect((await client!.query('SELECT status, actual_cost_microdollars FROM addie_fixed_trace_component_smoke_attempts WHERE attempt_id = $1', [attemptId])).rows).toEqual([{ status: 'succeeded', actual_cost_microdollars: '0' }]);
      expect((await client!.query('SELECT assignment_outcome FROM addie_fixed_trace_component_smoke_run_plan WHERE authorization_digest = $1 AND assignment_id = $2', [authorizationDigest, entry.assignmentId])).rows).toEqual([{ assignment_outcome: 'provider_completed' }]);
    } finally {
      await pool.end();
      await client!.query('BEGIN');
    }
  });

  it('atomically terminalizes all 168 assignments when a committed intent acknowledgement is lost', async () => {
    const entry = dispatchEntry(12);
    const attemptId = uniqueAttemptId();
    await client!.query('COMMIT');
    const pool = new Pool({ connectionString: databaseUrl });
    try {
      const ledger = new PostgresFixedTraceComponentSmokePrivateLedger(pool);
      // The durable write succeeds, but the caller deliberately discards its
      // acknowledgement as though the response was lost before dispatch.
      expect(await ledger.recordProviderIntent({ reservation: reservationFor(authorizationDigest), attemptId, assignmentId: entry.assignmentId, invocationOrdinal: 1, preparedRequestHmac: 'c'.repeat(64) })).toEqual({ status: 'recorded' });
      expect(await ledger.recordUnknownExposure(reservationFor(authorizationDigest))).toEqual({ status: 'recorded' });
      expect((await client!.query(
        `SELECT assignment_outcome, count(*)::int AS count
           FROM addie_fixed_trace_component_smoke_run_plan
          WHERE authorization_digest = $1 GROUP BY assignment_outcome ORDER BY assignment_outcome`,
        [authorizationDigest],
      )).rows).toEqual([
        { assignment_outcome: 'not_executed_after_halt', count: 167 },
        { assignment_outcome: 'provider_unknown_exposure', count: 1 },
      ]);
      expect((await client!.query(
        'SELECT count(*)::int AS count FROM addie_fixed_trace_component_smoke_run_plan WHERE authorization_digest = $1 AND assignment_outcome IS NULL',
        [authorizationDigest],
      )).rows).toEqual([{ count: 0 }]);
      expect((await client!.query('SELECT status FROM addie_fixed_trace_component_smoke_authorizations WHERE authorization_digest = $1', [authorizationDigest])).rows).toEqual([{ status: 'unknown_exposure' }]);
    } finally { await pool.end(); await client!.query('BEGIN'); }
  });

  it('uses target-plan then authorization order against a direct outcome writer', async () => {
    const entry = dispatchEntry(15);
    const attemptId = uniqueAttemptId();
    await insertIntent(client!, authorizationDigest, entry, attemptId.slice('attempt_'.length));
    await client!.query("UPDATE addie_fixed_trace_component_smoke_attempts SET status = 'succeeded', response_disposition = 'final_response', response_hmac = $2, returned_provider = $3, returned_model = $4, returned_effort = $5, input_tokens = 0, output_tokens = 0, cache_read_tokens = 0, cache_write_tokens = 0, actual_cost_microdollars = 0, latency_ms = 0, terminal_at = clock_timestamp() WHERE attempt_id = $1", [attemptId, 'a'.repeat(64), entry.provider, entry.model, entry.effort]);
    await client!.query('COMMIT');
    const pool = new Pool({ connectionString: databaseUrl });
    try {
      const ledger = new PostgresFixedTraceComponentSmokePrivateLedger(pool);
      await client!.query('BEGIN');
      await client!.query('SELECT assignment_id FROM addie_fixed_trace_component_smoke_run_plan WHERE authorization_digest = $1 AND assignment_id = $2 FOR UPDATE', [authorizationDigest, entry.assignmentId]);
      let settled = false;
      const application = ledger.recordProviderAssignmentTerminal({ reservation: reservationFor(authorizationDigest), assignmentId: entry.assignmentId, status: 'provider_completed', finalInvocationOrdinal: 1 }).then((outcome) => { settled = true; return outcome; });
      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(settled).toBe(false);
      await client!.query("UPDATE addie_fixed_trace_component_smoke_run_plan SET assignment_outcome = 'provider_completed', assignment_terminal_at = clock_timestamp(), assignment_final_invocation_ordinal = 1 WHERE authorization_digest = $1 AND assignment_id = $2", [authorizationDigest, entry.assignmentId]);
      await client!.query('COMMIT');
      expect(await application).toEqual({ status: 'refused', reason: 'plan_mismatch' });
    } finally { await pool.end(); await client!.query('BEGIN'); }
  });

  it('serializes application terminalization with standalone recovery after a prior terminal', async () => {
    const prior = dispatchEntry(16);
    const open = dispatchEntry(17);
    const priorId = uniqueAttemptId();
    const openId = uniqueAttemptId();
    await insertIntent(client!, authorizationDigest, prior, priorId.slice('attempt_'.length));
    await client!.query("UPDATE addie_fixed_trace_component_smoke_attempts SET status = 'succeeded', response_disposition = 'final_response', response_hmac = $2, returned_provider = $3, returned_model = $4, returned_effort = $5, input_tokens = 0, output_tokens = 0, cache_read_tokens = 0, cache_write_tokens = 0, actual_cost_microdollars = 0, latency_ms = 0, terminal_at = clock_timestamp() WHERE attempt_id = $1", [priorId, 'a'.repeat(64), prior.provider, prior.model, prior.effort]);
    await insertIntent(client!, authorizationDigest, open, openId.slice('attempt_'.length));
    await client!.query('COMMIT');
    const pool = new Pool({ connectionString: databaseUrl, max: 2 });
    try {
      const ledger = new PostgresFixedTraceComponentSmokePrivateLedger(pool);
      const [terminal, recovery] = await Promise.all([
        ledger.recordTerminal({ reservation: reservationFor(authorizationDigest), attemptId: openId, status: 'succeeded', responseDisposition: 'final_response', responseHmac: 'b'.repeat(64), returnedIdentity: { provider: open.provider, model: open.model, effort: open.effort }, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, latencyMs: 0 } }),
        ledger.recordUnknownExposure(reservationFor(authorizationDigest)),
      ]);
      expect(terminal.status === 'recorded' || (terminal.status === 'refused' && (terminal.reason === 'intent_required' || terminal.reason === 'unknown_exposure'))).toBe(true);
      expect(recovery).toEqual({ status: 'recorded' });
      expect((await client!.query("SELECT a.status, count(*) FILTER (WHERE t.status = 'intent_recorded')::int AS open FROM addie_fixed_trace_component_smoke_authorizations a JOIN addie_fixed_trace_component_smoke_attempts t USING (authorization_digest) WHERE a.authorization_digest = $1 GROUP BY a.status", [authorizationDigest])).rows).toEqual([{ status: 'unknown_exposure', open: 0 }]);
    } finally { await pool.end(); await client!.query('BEGIN'); }
  });

  it('runs provider-intent recovery independently of a concurrent standalone recovery', async () => {
    const open = dispatchEntry(18);
    const target = dispatchEntry(19);
    const openId = uniqueAttemptId();
    await insertIntent(client!, authorizationDigest, open, openId.slice('attempt_'.length));
    await client!.query('COMMIT');
    const pool = new Pool({ connectionString: databaseUrl, max: 2 });
    try {
      const ledger = new PostgresFixedTraceComponentSmokePrivateLedger(pool);
      const [intent, recovery] = await Promise.all([
        ledger.recordProviderIntent({ reservation: reservationFor(authorizationDigest), attemptId: uniqueAttemptId(), assignmentId: target.assignmentId, invocationOrdinal: 1, preparedRequestHmac: 'c'.repeat(64) }),
        ledger.recordUnknownExposure(reservationFor(authorizationDigest)),
      ]);
      expect(intent).toEqual({ status: 'refused', reason: 'unknown_exposure' });
      expect(recovery).toEqual({ status: 'recorded' });
      expect((await client!.query("SELECT a.status, count(*) FILTER (WHERE t.status = 'intent_recorded')::int AS open FROM addie_fixed_trace_component_smoke_authorizations a JOIN addie_fixed_trace_component_smoke_attempts t USING (authorization_digest) WHERE a.authorization_digest = $1 GROUP BY a.status", [authorizationDigest])).rows).toEqual([{ status: 'unknown_exposure', open: 0 }]);
    } finally { await pool.end(); await client!.query('BEGIN'); }
  });

  it('releases provider-intent target locking before standalone recovery after the precheck race', async () => {
    const target = dispatchEntry(20);
    const opened = dispatchEntry(21);
    const precheckRead = deferred();
    const releasePrecheck = deferred();
    let blocked = false;
    await client!.query('COMMIT');
    const pool = new Pool({ connectionString: databaseUrl, max: 2 });
    const controlledPool = {
      connect: async () => {
        const connection = await pool.connect();
        const mutable = connection as unknown as { query: (sql: string, values?: readonly unknown[]) => Promise<unknown> };
        const query = mutable.query.bind(connection);
        mutable.query = async (sql, values) => {
          const output = await query(sql, values);
          if (!blocked && sql.startsWith('SELECT 1 FROM addie_fixed_trace_component_smoke_attempts') && sql.includes("status = 'intent_recorded'")) {
            blocked = true;
            precheckRead.resolve();
            await releasePrecheck.promise;
          }
          return output;
        };
        return connection;
      },
    };
    const contender = new Client({ connectionString: databaseUrl });
    await contender.connect();
    try {
      const ledger = new PostgresFixedTraceComponentSmokePrivateLedger(controlledPool as never);
      const pendingIntent = ledger.recordProviderIntent({ reservation: reservationFor(authorizationDigest), attemptId: uniqueAttemptId(), assignmentId: target.assignmentId, invocationOrdinal: 1, preparedRequestHmac: 'c'.repeat(64) });
      await precheckRead.promise;
      // This committed intent is deliberately injected after the initial
      // precheck but before the target plan lock is acquired.
      await insertIntent(contender, authorizationDigest, opened, uniqueAttemptId().slice('attempt_'.length));
      const recovery = ledger.recordUnknownExposure(reservationFor(authorizationDigest));
      releasePrecheck.resolve();
      expect(await recovery).toEqual({ status: 'recorded' });
      expect(await pendingIntent).toEqual({ status: 'refused', reason: 'unknown_exposure' });
      expect((await client!.query("SELECT a.status, count(*) FILTER (WHERE t.status = 'intent_recorded')::int AS open FROM addie_fixed_trace_component_smoke_authorizations a LEFT JOIN addie_fixed_trace_component_smoke_attempts t USING (authorization_digest) WHERE a.authorization_digest = $1 GROUP BY a.status", [authorizationDigest])).rows).toEqual([{ status: 'unknown_exposure', open: 0 }]);
    } finally { await contender.end(); await pool.end(); await client!.query('BEGIN'); }
  });

  it('reports recovery lock failure as uncertainty and never claims durable poisoning', async () => {
    const open = dispatchEntry(22);
    const later = dispatchEntry(23);
    const openId = uniqueAttemptId();
    await client!.query('COMMIT');
    await insertIntent(client!, authorizationDigest, open, openId.slice('attempt_'.length));
    const blocker = new Client({ connectionString: databaseUrl });
    await blocker.connect();
    const pool = new Pool({ connectionString: databaseUrl, max: 1 });
    let acquisitions = 0;
    const timeoutRecoveryPool = {
      connect: async () => {
        const connection = await pool.connect();
        acquisitions += 1;
        if (acquisitions !== 2) return connection;
        const mutable = connection as unknown as { query: (sql: string, values?: readonly unknown[]) => Promise<unknown> };
        const query = mutable.query.bind(connection);
        mutable.query = async (sql, values) => {
          const output = await query(sql, values);
          if (sql === 'BEGIN') await query("SET LOCAL lock_timeout = '50ms'");
          return output;
        };
        return connection;
      },
    };
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT attempt_id FROM addie_fixed_trace_component_smoke_attempts WHERE attempt_id = $1 FOR UPDATE', [openId]);
      const ledger = new PostgresFixedTraceComponentSmokePrivateLedger(timeoutRecoveryPool as never);
      expect(await ledger.recordProviderIntent({ reservation: reservationFor(authorizationDigest), attemptId: uniqueAttemptId(), assignmentId: later.assignmentId, invocationOrdinal: 1, preparedRequestHmac: 'c'.repeat(64) })).toEqual({ status: 'refused', reason: 'persistence_uncertain' });
      expect((await client!.query("SELECT a.status, count(*) FILTER (WHERE t.status = 'intent_recorded')::int AS open FROM addie_fixed_trace_component_smoke_authorizations a JOIN addie_fixed_trace_component_smoke_attempts t USING (authorization_digest) WHERE a.authorization_digest = $1 GROUP BY a.status", [authorizationDigest])).rows).toEqual([{ status: 'consumed', open: 1 }]);
      await blocker.query('ROLLBACK');
      const cleanPool = new Pool({ connectionString: databaseUrl });
      try {
        const cleanLedger = new PostgresFixedTraceComponentSmokePrivateLedger(cleanPool);
        expect(await cleanLedger.recordProviderIntent({ reservation: reservationFor(authorizationDigest), attemptId: uniqueAttemptId(), assignmentId: later.assignmentId, invocationOrdinal: 1, preparedRequestHmac: 'd'.repeat(64) })).toEqual({ status: 'refused', reason: 'unknown_exposure' });
      } finally { await cleanPool.end(); }
      expect((await client!.query("SELECT a.status, count(*) FILTER (WHERE t.status = 'intent_recorded')::int AS open FROM addie_fixed_trace_component_smoke_authorizations a LEFT JOIN addie_fixed_trace_component_smoke_attempts t USING (authorization_digest) WHERE a.authorization_digest = $1 GROUP BY a.status", [authorizationDigest])).rows).toEqual([{ status: 'unknown_exposure', open: 0 }]);
    } finally { await blocker.query('ROLLBACK').catch(() => undefined); await blocker.end(); await pool.end(); await client!.query('BEGIN'); }
  });

  it('gates a direct intent behind complete-plan recovery before its attempt snapshot', async () => {
    // Three transactions: holder locks the last plan row; recovery consequently
    // owns every earlier immutable plan row; a direct SQL INSERT on one of
    // those rows must wait and then reject after recovery marks the run unknown.
    const ordered = [...plan].sort((left, right) => left.assignmentId.localeCompare(right.assignmentId));
    const held = ordered.at(-1)!;
    const inserted = ordered.find((entry) => entry.disposition === 'provider_dispatch' && entry.assignmentId < held.assignmentId)!;
    await client!.query('COMMIT');
    const holder = new Client({ connectionString: databaseUrl });
    const direct = new Client({ connectionString: databaseUrl });
    const pool = new Pool({ connectionString: databaseUrl, max: 1 });
    await holder.connect(); await direct.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT assignment_id FROM addie_fixed_trace_component_smoke_run_plan WHERE authorization_digest = $1 AND assignment_id = $2 FOR UPDATE', [authorizationDigest, held.assignmentId]);
      const recovery = new PostgresFixedTraceComponentSmokePrivateLedger(pool).recordUnknownExposure(reservationFor(authorizationDigest));
      let recoverySettled = false;
      void recovery.then(() => { recoverySettled = true; });
      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(recoverySettled).toBe(false);
      let directSettled = false;
      const directInsert = insertIntent(direct, authorizationDigest, inserted, uniqueAttemptId().slice('attempt_'.length))
        .then(() => undefined, (error: unknown) => error)
        .then((outcome) => { directSettled = true; return outcome; });
      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(directSettled).toBe(false);
      await holder.query('COMMIT');
      expect(await recovery).toEqual({ status: 'recorded' });
      expect(await directInsert).toBeInstanceOf(Error);
      expect((await client!.query('SELECT status FROM addie_fixed_trace_component_smoke_authorizations WHERE authorization_digest = $1', [authorizationDigest])).rows).toEqual([{ status: 'unknown_exposure' }]);
      expect((await client!.query('SELECT count(*)::int AS count FROM addie_fixed_trace_component_smoke_attempts WHERE authorization_digest = $1', [authorizationDigest])).rows).toEqual([{ count: 0 }]);
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      await holder.end(); await direct.end(); await pool.end(); await client!.query('BEGIN');
    }
  });

  it('serializes a reverse-order multi-outcome writer before recovery locks any plan target', async () => {
    const positioned = plan.map((entry, index) => ({ entry, index })).filter(({ entry }) => entry.disposition === 'provider_dispatch');
    const earlier = positioned[0]!;
    const later = positioned.at(-1)!;
    const earlierAttempt = uniqueAttemptId();
    const laterAttempt = uniqueAttemptId();
    for (const [entry, attemptId] of [[earlier.entry, earlierAttempt], [later.entry, laterAttempt]] as const) {
      await insertIntent(client!, authorizationDigest, entry, attemptId.slice('attempt_'.length));
      await client!.query("UPDATE addie_fixed_trace_component_smoke_attempts SET status = 'succeeded', response_disposition = 'final_response', response_hmac = $2, returned_provider = $3, returned_model = $4, returned_effort = $5, input_tokens = 0, output_tokens = 0, cache_read_tokens = 0, cache_write_tokens = 0, actual_cost_microdollars = 0, latency_ms = 0, terminal_at = clock_timestamp() WHERE attempt_id = $1", [attemptId, 'a'.repeat(64), entry.provider, entry.model, entry.effort]);
    }
    await client!.query('COMMIT');
    const writer = new Client({ connectionString: databaseUrl });
    const pool = new Pool({ connectionString: databaseUrl, max: 1 });
    await writer.connect();
    try {
      await writer.query('BEGIN');
      // The old recovery sequence could lock `earlier` while waiting for
      // `later`; a bounded writer lock exposes that cycle as a failure.
      await writer.query("SET LOCAL lock_timeout = '400ms'");
      await writer.query("UPDATE addie_fixed_trace_component_smoke_run_plan SET assignment_outcome = 'provider_completed', assignment_terminal_at = clock_timestamp(), assignment_final_invocation_ordinal = 1 WHERE authorization_digest = $1 AND assignment_id = $2", [authorizationDigest, later.entry.assignmentId]);
      const recovery = new PostgresFixedTraceComponentSmokePrivateLedger(pool).recordUnknownExposure(reservationFor(authorizationDigest));
      await new Promise((resolve) => setTimeout(resolve, 75));
      // Reversed physical-order target. The recovery table gate has not yet
      // taken either row, so this cannot wait behind a recovery row lock.
      await writer.query("UPDATE addie_fixed_trace_component_smoke_run_plan SET assignment_outcome = 'provider_completed', assignment_terminal_at = clock_timestamp(), assignment_final_invocation_ordinal = 1 WHERE authorization_digest = $1 AND assignment_id = $2", [authorizationDigest, earlier.entry.assignmentId]);
      await writer.query('COMMIT');
      expect(await recovery).toEqual({ status: 'recorded' });
      expect((await client!.query('SELECT status FROM addie_fixed_trace_component_smoke_authorizations WHERE authorization_digest = $1', [authorizationDigest])).rows).toEqual([{ status: 'unknown_exposure' }]);
      expect((await client!.query('SELECT assignment_outcome FROM addie_fixed_trace_component_smoke_run_plan WHERE authorization_digest = $1 AND assignment_id IN ($2,$3) ORDER BY assignment_id', [authorizationDigest, earlier.entry.assignmentId, later.entry.assignmentId])).rows).toEqual([{ assignment_outcome: 'provider_completed' }, { assignment_outcome: 'provider_completed' }]);
    } finally {
      await writer.query('ROLLBACK').catch(() => undefined);
      await writer.end(); await pool.end(); await client!.query('BEGIN');
    }
  });

  it('blocks an application outcome at the recovery table gate before it locks its target', async () => {
    const entry = plan.find((candidate) => candidate.disposition === 'local_terminal')!;
    const recoveryAtPlanSet = deferred();
    const releaseRecovery = deferred();
    let blocked = false;
    await client!.query('COMMIT');
    const pool = new Pool({ connectionString: databaseUrl, max: 2 });
    const recoveryPool = {
      connect: async () => {
        const connection = await pool.connect();
        const mutable = connection as unknown as { query: (sql: string, values?: readonly unknown[]) => Promise<unknown> };
        const query = mutable.query.bind(connection);
        mutable.query = async (sql, values) => {
          if (!blocked && sql.startsWith('SELECT assignment_id FROM addie_fixed_trace_component_smoke_run_plan')) {
            blocked = true;
            recoveryAtPlanSet.resolve();
            await releaseRecovery.promise;
          }
          return query(sql, values);
        };
        return connection;
      },
    };
    try {
      const recoveryLedger = new PostgresFixedTraceComponentSmokePrivateLedger(recoveryPool as never);
      const applicationLedger = new PostgresFixedTraceComponentSmokePrivateLedger(pool);
      const recovery = recoveryLedger.recordUnknownExposure(reservationFor(authorizationDigest));
      await recoveryAtPlanSet.promise;
      let applicationSettled = false;
      const application = applicationLedger.recordNonDispatchTerminal({ reservation: reservationFor(authorizationDigest), assignmentId: entry.assignmentId, status: 'local_terminal' })
        .then((outcome) => { applicationSettled = true; return outcome; });
      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(applicationSettled).toBe(false);
      releaseRecovery.resolve();
      expect(await recovery).toEqual({ status: 'recorded' });
      expect(await application).toEqual({ status: 'refused', reason: 'unknown_exposure' });
    } finally { await pool.end(); await client!.query('BEGIN'); }
  });

  it('application terminalizes a known provider failure after its fail-stop transition', async () => {
    const entry = dispatchEntry(14);
    const attemptId = uniqueAttemptId();
    await client!.query('COMMIT');
    const pool = new Pool({ connectionString: databaseUrl });
    try {
      const ledger = new PostgresFixedTraceComponentSmokePrivateLedger(pool);
      expect(await ledger.recordProviderIntent({ reservation: reservationFor(authorizationDigest), attemptId, assignmentId: entry.assignmentId, invocationOrdinal: 1, preparedRequestHmac: 'b'.repeat(64) })).toEqual({ status: 'recorded' });
      expect(await ledger.recordTerminal({ reservation: reservationFor(authorizationDigest), attemptId, status: 'provider_failed', responseDisposition: null, responseHmac: 'c'.repeat(64), returnedIdentity: { provider: entry.provider, model: entry.model, effort: entry.effort }, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, latencyMs: 0 } })).toEqual({ status: 'recorded' });
      expect(await ledger.recordProviderAssignmentTerminal({ reservation: reservationFor(authorizationDigest), assignmentId: entry.assignmentId, status: 'provider_failed', finalInvocationOrdinal: 1 })).toEqual({ status: 'recorded' });
      expect((await client!.query('SELECT status FROM addie_fixed_trace_component_smoke_authorizations WHERE authorization_digest = $1', [authorizationDigest])).rows).toEqual([{ status: 'unknown_exposure' }]);
    } finally { await pool.end(); await client!.query('BEGIN'); }
  });

  it('settles parser-maximum Google usage as priceable invalid_limits instead of leaving an open intent', async () => {
    const entry = plan.find((candidate) => candidate.disposition === 'provider_dispatch' && candidate.pricingProfileId === 'google-gemini-3.7-flash-through-2026-12-31')!;
    const attemptId = uniqueAttemptId();
    await client!.query('COMMIT');
    const pool = new Pool({ connectionString: databaseUrl });
    try {
      const ledger = new PostgresFixedTraceComponentSmokePrivateLedger(pool);
      expect(await ledger.recordProviderIntent({ reservation: reservationFor(authorizationDigest), attemptId, assignmentId: entry.assignmentId, invocationOrdinal: 1, preparedRequestHmac: 'a'.repeat(64) })).toEqual({ status: 'recorded' });
      expect(await ledger.recordTerminal({ reservation: reservationFor(authorizationDigest), attemptId, status: 'succeeded', responseDisposition: 'final_response', responseHmac: 'b'.repeat(64), returnedIdentity: { provider: entry.provider, model: entry.model, effort: entry.effort }, usage: { inputTokens: 0, outputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0, latencyMs: 0 } })).toEqual({ status: 'refused', reason: 'plan_mismatch' });
      expect((await client!.query('SELECT status, observed_cost_microdollars FROM addie_fixed_trace_component_smoke_attempts WHERE attempt_id = $1', [attemptId])).rows).toEqual([{ status: 'invalid_limits', observed_cost_microdollars: '3750000' }]);
      expect((await client!.query('SELECT status FROM addie_fixed_trace_component_smoke_authorizations WHERE authorization_digest = $1', [authorizationDigest])).rows).toEqual([{ status: 'halted' }]);
    } finally { await pool.end(); await client!.query('BEGIN'); }
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
