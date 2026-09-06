import { createHash, randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixedTraceComponentSmokeAdmission } from '../../../src/addie/eval/fixed-trace-component-smoke-admission.js';
import { fixedTraceComponentSmokePrivateLedgerPlan } from '../../../src/addie/eval/fixed-trace-component-smoke-private-ledger.js';

const databaseUrl = process.env.DATABASE_URL;
let client: Client | null = null;
let authorizationDigest = '';
const plan = fixedTraceComponentSmokePrivateLedgerPlan()!;
const admission = fixedTraceComponentSmokeAdmission();

async function rejects(statement: string, values: unknown[] = []) {
  await client!.query('SAVEPOINT private_ledger_expected_failure');
  try {
    await client!.query(statement, values);
  } catch (error) {
    await client!.query('ROLLBACK TO SAVEPOINT private_ledger_expected_failure');
    return error;
  }
  await client!.query('ROLLBACK TO SAVEPOINT private_ledger_expected_failure');
  throw new Error('statement unexpectedly succeeded');
}

async function seedExactPlan() {
  authorizationDigest = createHash('sha256').update(randomUUID()).digest('hex');
  const reservationId = `reservation_${createHash('sha256').update(authorizationDigest).digest('hex').slice(0, 32)}`;
  await client!.query(
    `INSERT INTO addie_fixed_trace_component_smoke_authorizations
     (authorization_digest,signed_payload_digest,signature_digest,kid,nonce_commitment,grant_version,stage_id,admission_version,aggregate_admission_fingerprint,
      probes,router_cells,generation_cells,total_cells,repetitions,assignments,provider_dispatch_assignments,local_terminal_assignments,pre_dispatch_fault_assignments,
      maximum_planned_invocation_slots,maximum_provider_invocations,reservation_microdollars,provider_ceiling_microdollars,pricing_cohort_digest,issued_at,expires_at,status,consumed_at,reservation_id)
     VALUES ($1,$2,$3,'postgres-ledger-test',$4,'addie-fixed-trace-component-smoke-signed-grant-v1','stage_1_smoke','addie-fixed-trace-component-smoke-admission-v2',
       '731930c18475672a0ec6b44c9ff91fa89d30c441e34af32b536a28258271077d',8,10,11,21,1,168,126,21,21,256,192,2819484,5000000,$5,
       clock_timestamp() - interval '1 minute',clock_timestamp() + interval '1 minute','consumed',clock_timestamp(),$6)`,
    [authorizationDigest, 'b'.repeat(64), 'c'.repeat(64), 'd'.repeat(64), admission.pricing.cohortDigest, reservationId],
  );
  for (const entry of plan) {
    await client!.query(
      `INSERT INTO addie_fixed_trace_component_smoke_run_plan
       (authorization_digest,assignment_id,probe_id,cell_id,disposition,maximum_provider_invocations,requested_provider,requested_model,requested_effort,pricing_profile_id,max_input_tokens,max_output_tokens,timeout_ms,retries,reserved_microdollars)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,0,$14)`,
      [authorizationDigest, entry.assignmentId, entry.probeId, entry.cellId, entry.disposition, entry.maximumProviderInvocations, entry.provider, entry.model, entry.effort, entry.pricingProfileId, entry.maxInputTokens, entry.maxOutputTokens, entry.timeoutMs, entry.reservedMicrodollars],
    );
  }
  await client!.query('SET CONSTRAINTS addie_fixed_trace_component_smoke_plan_exact IMMEDIATE');
}

/** Uses the build-check PostgreSQL database after normal migrations; no provider path exists. */
describe.skipIf(!databaseUrl)('private ledger migration on PostgreSQL', () => {
  beforeAll(async () => {
    client = new Client({ connectionString: databaseUrl });
    await client.connect();
    await client.query('BEGIN');
    await seedExactPlan();
  });
  afterAll(async () => { if (client) { await client.query('ROLLBACK').catch(() => undefined); await client.end().catch(() => undefined); } });

  it('uses the migrated 71-character pricing digest contract and bounded database TTL', async () => {
    const result = await client!.query<{ character_maximum_length: number | null }>(
      "SELECT character_maximum_length FROM information_schema.columns WHERE table_name = 'addie_fixed_trace_component_smoke_authorizations' AND column_name = 'pricing_cohort_digest'",
    );
    expect(result.rows).toEqual([{ character_maximum_length: 71 }]);
    await expect(rejects("UPDATE addie_fixed_trace_component_smoke_authorizations SET expires_at = issued_at + interval '16 minutes' WHERE authorization_digest = $1", [authorizationDigest])).resolves.toBeInstanceOf(Error);
  });

  it('enforces exact plan counts and immutable direct SQL state', async () => {
    const local = plan.find((entry) => entry.disposition === 'local_terminal')!;
    await client!.query(
      "UPDATE addie_fixed_trace_component_smoke_run_plan SET non_dispatch_status = 'local_terminal', non_dispatch_terminal_at = clock_timestamp() WHERE authorization_digest = $1 AND assignment_id = $2",
      [authorizationDigest, local.assignmentId],
    );
    await expect(rejects("UPDATE addie_fixed_trace_component_smoke_run_plan SET requested_model = 'changed' WHERE authorization_digest = $1", [authorizationDigest])).resolves.toBeInstanceOf(Error);
    await expect(rejects('DELETE FROM addie_fixed_trace_component_smoke_run_plan WHERE authorization_digest = $1', [authorizationDigest])).resolves.toBeInstanceOf(Error);
    await client!.query("UPDATE addie_fixed_trace_component_smoke_authorizations SET status = 'halted' WHERE authorization_digest = $1", [authorizationDigest]);
    await expect(rejects("UPDATE addie_fixed_trace_component_smoke_authorizations SET status = 'consumed' WHERE authorization_digest = $1", [authorizationDigest])).resolves.toBeInstanceOf(Error);
  });

  it('enforces ordinal reservation and direct attempt monotonicity', async () => {
    const entry = plan.find((candidate) => candidate.disposition === 'provider_dispatch')!;
    const attemptId = `attempt_${'e'.repeat(32)}`;
    const insert = (id: string, ordinal: number, cost: number) => client!.query(
      `INSERT INTO addie_fixed_trace_component_smoke_attempts
       (attempt_id,authorization_digest,assignment_id,invocation_ordinal,status,prepared_request_hmac,response_hmac,returned_provider,returned_model,returned_effort,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,actual_cost_microdollars,latency_ms,terminal_at)
       VALUES ($1,$2,$3,$4,'succeeded',$5,$6,$7,$8,$9,0,0,0,0,$10,0,clock_timestamp())`,
      [id, authorizationDigest, entry.assignmentId, ordinal, 'f'.repeat(64), '1'.repeat(64), entry.provider, entry.model, entry.effort, cost],
    );
    await insert(attemptId, 1, entry.reservedMicrodollars[0]!);
    await expect(rejects('UPDATE addie_fixed_trace_component_smoke_attempts SET actual_cost_microdollars = actual_cost_microdollars + 1 WHERE attempt_id = $1', [attemptId])).resolves.toBeInstanceOf(Error);
    await expect(rejects("UPDATE addie_fixed_trace_component_smoke_attempts SET status = 'intent_recorded', terminal_at = NULL WHERE attempt_id = $1", [attemptId])).resolves.toBeInstanceOf(Error);
    await expect(rejects('DELETE FROM addie_fixed_trace_component_smoke_attempts WHERE attempt_id = $1', [attemptId])).resolves.toBeInstanceOf(Error);
  });
});
