import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';

const TEST_SCHEMA = `verification_profile_shadow_migration_test_${process.pid}`;
const MIGRATION = readFileSync(
  resolve(__dirname, '../../src/db/migrations/571_verification_profile_shadow_rollout.sql'),
  'utf8',
);

describe.skipIf(!process.env.DATABASE_URL)('migration 571: verification profile shadow rollout', () => {
  let pool: Pool;
  let client: PoolClient;
  let sourceRunId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    client = await pool.connect();
    await client.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    await client.query(`CREATE SCHEMA ${TEST_SCHEMA}`);
    await client.query(`SET search_path TO ${TEST_SCHEMA}, public`);
    await client.query(`
      CREATE TABLE system_settings (
        key VARCHAR(100) PRIMARY KEY,
        value JSONB NOT NULL,
        description TEXT,
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        updated_by VARCHAR(255)
      );
      CREATE TABLE agent_compliance_runs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid()
      );
    `);
    const run = await client.query<{ id: string }>(
      'INSERT INTO agent_compliance_runs DEFAULT VALUES RETURNING id',
    );
    sourceRunId = run.rows[0].id;
    await client.query(MIGRATION);
  });

  afterAll(async () => {
    if (client) {
      await client.query('RESET search_path');
      await client.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
      client.release();
    }
    await pool?.end();
  });

  it('starts collection disabled and remains idempotent', async () => {
    await client.query(MIGRATION);
    const setting = await client.query<{ value: { enabled: boolean; expires_at: string | null } }>(
      `SELECT value FROM system_settings WHERE key = 'verification_profile_shadow_rollout'`,
    );
    expect(setting.rows).toEqual([{ value: { enabled: false, expires_at: null } }]);
  });

  it('accepts a bounded production assessment without raw request or response columns', async () => {
    await client.query(
      `INSERT INTO verification_profile_shadow_assessments (
         source_run_id, agent_url, lifecycle_stage, adcp_version, policy_version,
         current_public_status, proposed_spec_status, proposed_sandbox_status,
         sandbox_eligible, recommended_profile, run_complete,
         bundle_evidence_present, failing_bundle_count,
         incomplete_bundle_count, sandbox_unresolved_bundle_count,
         unattributed_failure_count,
         selected_storyboard_count, applicable_phase_count,
         controller_gap_phase_count, controller_gap_step_count,
         controller_cascade_step_count, observed_failure_count,
         sandbox_observable_failure_count, non_controller_gap_step_count,
         controller_missing_storyboard_count, other_missing_storyboard_count,
         mixed_controller_failure_phase_count
       ) VALUES (
         $1, 'https://seller.example.test/mcp', 'production', '3.1', 'verification-profiles-v1',
         'passing', 'partial', 'passing', TRUE, 'sandbox', TRUE,
         TRUE, 0, 0, 0, 0,
         10, 9, 1, 1, 2, 0, 0, 0, 1, 0, 0
       )`,
      [sourceRunId],
    );

    const columns = await client.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'verification_profile_shadow_assessments'`,
      [TEST_SCHEMA],
    );
    const names = columns.rows.map((row) => row.column_name);
    expect(names).not.toEqual(expect.arrayContaining([
      'request', 'response', 'request_jsonb', 'response_jsonb', 'auth', 'token', 'headers',
    ]));
  });

  it('rejects Sandbox outcomes for a non-production lifecycle', async () => {
    const anotherRun = await client.query<{ id: string }>(
      'INSERT INTO agent_compliance_runs DEFAULT VALUES RETURNING id',
    );
    await expect(client.query(
      `INSERT INTO verification_profile_shadow_assessments (
         source_run_id, agent_url, lifecycle_stage, policy_version,
         current_public_status, proposed_spec_status, proposed_sandbox_status,
         sandbox_eligible, recommended_profile, run_complete,
         bundle_evidence_present, failing_bundle_count,
         incomplete_bundle_count, sandbox_unresolved_bundle_count,
         unattributed_failure_count,
         selected_storyboard_count, applicable_phase_count,
         controller_gap_phase_count, controller_gap_step_count,
         controller_cascade_step_count, observed_failure_count,
         sandbox_observable_failure_count, non_controller_gap_step_count,
         controller_missing_storyboard_count, other_missing_storyboard_count,
         mixed_controller_failure_phase_count
       ) VALUES (
         $1, 'https://seller.example.test/testing', 'testing', 'verification-profiles-v1',
         'passing', 'passing', 'passing', TRUE, 'sandbox', TRUE,
         TRUE, 0, 0, 0, 0,
         1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0
       )`,
      [anotherRun.rows[0].id],
    )).rejects.toThrow();
  });

  it('prunes only rows older than the fixed 90-day retention window', async () => {
    await client.query(
      `UPDATE verification_profile_shadow_assessments
       SET evaluated_at = NOW() - INTERVAL '91 days'
       WHERE source_run_id = $1`,
      [sourceRunId],
    );
    const pruned = await client.query<{ pruned_count: string }>(
      `SELECT prune_verification_profile_shadow_assessments() AS pruned_count`,
    );
    expect(Number(pruned.rows[0].pruned_count)).toBe(1);

    const remaining = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM verification_profile_shadow_assessments`,
    );
    expect(remaining.rows[0].count).toBe('0');
  });
});
