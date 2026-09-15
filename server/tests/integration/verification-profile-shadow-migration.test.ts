import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { runAudit } from '../../src/scripts/audit-verification-profile-shadow.js';

const TEST_SCHEMA = `verification_profile_shadow_migration_test_${process.pid}`;
const MIGRATION = readFileSync(
  resolve(__dirname, '../../src/db/migrations/572_verification_profile_shadow_rollout.sql'),
  'utf8',
);
const DIAGNOSTICS_MIGRATION = readFileSync(
  resolve(__dirname, '../../src/db/migrations/576_verification_profile_shadow_diagnostics.sql'),
  'utf8',
);
const ENABLE_COMPARISONS_MIGRATION = readFileSync(
  resolve(__dirname, '../../src/db/migrations/598_enable_verification_profile_comparisons.sql'),
  'utf8',
);

describe.skipIf(!process.env.DATABASE_URL)('verification profile shadow migrations', () => {
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
      CREATE TABLE system_settings_audit (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        key VARCHAR(100) NOT NULL,
        old_value JSONB,
        new_value JSONB NOT NULL,
        changed_by VARCHAR(255),
        changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE agent_compliance_runs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        agent_url TEXT,
        tested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        overall_status TEXT NOT NULL DEFAULT 'unknown',
        tracks_json JSONB NOT NULL DEFAULT '[]'::jsonb,
        dry_run BOOLEAN NOT NULL DEFAULT FALSE,
        is_authoritative BOOLEAN NOT NULL DEFAULT TRUE,
        adcp_version TEXT,
        requested_compliance_target TEXT
      );
      CREATE TABLE discovered_agents (agent_url TEXT PRIMARY KEY);
      CREATE TABLE agent_registry_metadata (
        agent_url TEXT PRIMARY KEY,
        lifecycle_stage TEXT,
        compliance_opt_out BOOLEAN DEFAULT FALSE,
        monitoring_paused BOOLEAN DEFAULT FALSE
      );
      CREATE TABLE member_profiles (agents JSONB NOT NULL DEFAULT '[]'::jsonb);
      CREATE TABLE agent_verification_badges (
        agent_url TEXT NOT NULL,
        role TEXT NOT NULL,
        adcp_version TEXT NOT NULL,
        status TEXT NOT NULL,
        verification_modes TEXT[] NOT NULL
      );
    `);
    const run = await client.query<{ id: string }>(
      'INSERT INTO agent_compliance_runs DEFAULT VALUES RETURNING id',
    );
    sourceRunId = run.rows[0].id;
    await client.query(MIGRATION);
    await client.query(DIAGNOSTICS_MIGRATION);
    await client.query(ENABLE_COMPARISONS_MIGRATION);
  });

  afterAll(async () => {
    if (client) {
      await client.query('RESET search_path');
      await client.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
      client.release();
    }
    await pool?.end();
  });

  it('enables persistent comparison collection with an audit record', async () => {
    await client.query(MIGRATION);
    const setting = await client.query<{
      value: { enabled: boolean; expires_at: string | null };
      updated_by: string;
    }>(
      `SELECT value, updated_by
       FROM system_settings
       WHERE key = 'verification_profile_shadow_rollout'`,
    );
    expect(setting.rows).toEqual([{
      value: { enabled: true, expires_at: null },
      updated_by: 'migration:598_enable_verification_profile_comparisons',
    }]);

    const audit = await client.query<{
      old_value: { enabled: boolean; expires_at: string | null };
      new_value: { enabled: boolean; expires_at: string | null };
      changed_by: string;
    }>(
      `SELECT old_value, new_value, changed_by
       FROM system_settings_audit
       WHERE key = 'verification_profile_shadow_rollout'`,
    );
    expect(audit.rows).toEqual([{
      old_value: { enabled: false, expires_at: null },
      new_value: { enabled: true, expires_at: null },
      changed_by: 'migration:598_enable_verification_profile_comparisons',
    }]);
  });

  it('backfills immutable source provenance before enabling collection', async () => {
    const columns = await client.query<{ column_name: string }>(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = $1
         AND table_name = 'verification_profile_shadow_assessments'`,
      [TEST_SCHEMA],
    );
    expect(columns.rows.map((row) => row.column_name)).toEqual(expect.arrayContaining([
      'source_tested_at',
      'requested_compliance_target',
    ]));
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
         mixed_controller_failure_phase_count, source_tested_at
       ) VALUES (
         $1, 'https://seller.example.test/mcp', 'production', '3.1', 'verification-profiles-v1',
         'passing', 'partial', 'passing', TRUE, 'sandbox', TRUE,
         TRUE, 0, 0, 0, 0,
         10, 9, 1, 1, 2, 0, 0, 0, 1, 0, 0, NOW()
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

  it('accepts NULL recommended_profile for a production agent where both profiles are partial', async () => {
    const run = await client.query<{ id: string }>(
      'INSERT INTO agent_compliance_runs DEFAULT VALUES RETURNING id',
    );
    // deriveVerificationProfileShadowAssessment returns null when neither spec
    // nor sandbox status is 'passing'; the CHECK must not reject that row.
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
         mixed_controller_failure_phase_count, source_tested_at
       ) VALUES (
         $1, 'https://seller.example.test/partial', 'production', 'verification-profiles-v1',
         'partial', 'partial', 'partial', TRUE, NULL, TRUE,
         TRUE, 2, 1, 0, 0,
         10, 9, 1, 1, 2, 2, 1, 0, 1, 0, 0, NOW()
       )`,
      [run.rows[0].id],
    )).resolves.toBeDefined();
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
         mixed_controller_failure_phase_count, source_tested_at
       ) VALUES (
         $1, 'https://seller.example.test/testing', 'testing', 'verification-profiles-v1',
         'passing', 'passing', 'passing', TRUE, 'sandbox', TRUE,
         TRUE, 0, 0, 0, 0,
         1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, NOW()
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

    const expired = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM verification_profile_shadow_assessments
       WHERE source_run_id = $1`,
      [sourceRunId],
    );
    expect(expired.rows[0].count).toBe('0');

    const recent = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM verification_profile_shadow_assessments
       WHERE evaluated_at >= NOW() - INTERVAL '90 days'`,
    );
    expect(recent.rows[0].count).toBe('1');
  });

  it('executes the audit SQL and excludes an incomplete row from decision-ready repeats', async () => {
    await client.query(
      `INSERT INTO agent_registry_metadata (agent_url, lifecycle_stage)
       VALUES ('https://audit.example.test/mcp', 'production')`,
    );
    const firstRun = await client.query<{ id: string }>(
      `INSERT INTO agent_compliance_runs (agent_url, overall_status, tracks_json)
       VALUES ('https://audit.example.test/mcp', 'partial', '[{"track":"core"}]'::jsonb)
       RETURNING id`,
    );
    const secondRun = await client.query<{ id: string }>(
      `INSERT INTO agent_compliance_runs (agent_url, overall_status, tracks_json)
       VALUES ('https://audit.example.test/mcp', 'partial', '[{"track":"core"}]'::jsonb)
       RETURNING id`,
    );
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
         mixed_controller_failure_phase_count, source_tested_at
       ) VALUES
       ($1, 'https://audit.example.test/mcp', 'production', '3.1', 'verification-profiles-v3',
        'partial', 'partial', 'partial', TRUE, NULL, FALSE,
        TRUE, 0, 1, 0, 0,
        10, 9, 0, 0, 0, 0, 0, 0, 0, 0, 0, NOW()),
       ($2, 'https://audit.example.test/mcp', 'production', '3.1', 'verification-profiles-v3',
        'partial', 'partial', 'partial', TRUE, NULL, TRUE,
        TRUE, 0, 1, 0, 0,
        10, 9, 0, 0, 0, 0, 0, 0, 0, 0, 0, NOW())`,
      [firstRun.rows[0].id, secondRun.rows[0].id],
    );

    const report = await runAudit(['--hours=48'], client);

    expect(report.assessed_agents).toBe(1);
    expect(report.agents_with_two_or_more_runs).toBe(1);
    expect(report.agents_with_two_or_more_decision_ready_runs).toBe(0);
    expect(report.agents_with_stable_two_or_more_decision_ready_runs).toBe(0);
  });

  it('excludes audit-only history from both aggregate and per-agent public evidence', async () => {
    await client.query(`
      INSERT INTO agent_registry_metadata (agent_url, lifecycle_stage)
        VALUES ('https://public-profile.example.test/mcp', 'production'),
               ('https://audit-only.example.test/mcp', 'production');
      INSERT INTO agent_compliance_runs (agent_url, tested_at, overall_status, tracks_json, is_authoritative)
        VALUES ('https://public-profile.example.test/mcp', NOW() - INTERVAL '1 hour', 'passing', '[{"track":"core"}]', TRUE),
               ('https://public-profile.example.test/mcp', NOW(), 'failing', '[]', FALSE),
               ('https://audit-only.example.test/mcp', NOW(), 'failing', '[]', FALSE);
    `);
    const report = await runAudit(['--hours=48', '--include-agents'], client);
    expect(report.unassessed_without_public_run).toBe(1);
    expect(report.unassessed_latest_public_run_empty_tracks).toBe(0);
    const agents = report.agents as Array<Record<string, unknown>>;
    expect(agents.find(agent => agent.agent_url === 'https://public-profile.example.test/mcp')).toMatchObject({
      latest_public_status: 'passing', latest_public_run_empty_tracks: false,
    });
    expect(agents.find(agent => agent.agent_url === 'https://audit-only.example.test/mcp')).toMatchObject({
      latest_public_run_at: null, blocking_reasons: ['not_assessed', 'no_public_run'],
    });
  });
});
