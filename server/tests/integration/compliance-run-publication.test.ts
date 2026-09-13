import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import * as databaseClient from '../../src/db/client.js';
import { closeDatabase, initializeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { ComplianceDatabase, type RecordComplianceRunInput } from '../../src/db/compliance-db.js';

describe.skipIf(!process.env.DATABASE_URL)('compliance publication transaction', () => {
  let pool: Pool;
  const db = new ComplianceDatabase();
  const agentUrl = `https://${randomUUID()}.example.test/mcp`;
  const input: RecordComplianceRunInput = {
    agent_url: agentUrl, lifecycle_stage: 'production', overall_status: 'passing',
    requested_compliance_target: '3.1', adcp_version: '3.1.20',
    tracks_json: [{ track: 'core', status: 'pass', scenario_count: 3, passed_count: 3, duration_ms: 1 }],
    tracks_passed: 1, tracks_failed: 0, tracks_skipped: 0, tracks_partial: 0,
    dry_run: false, completeness: 'complete', is_authoritative: true,
    replace_storyboard_statuses: true,
    storyboard_statuses: ['first', 'second', 'third'].map(storyboard_id => ({
      storyboard_id, status: 'passing', steps_passed: 1, steps_total: 1,
    })),
    agent_profile_json: { specialisms: ['signals-audience-activation'], adcp_supported_versions: ['3.1'] },
    observations_json: [{ message: 'Complete observation' }], notices_json: [],
  };

  beforeAll(async () => {
    pool = initializeDatabase({ connectionString: process.env.DATABASE_URL });
    await runMigrations();
    await db.upsertRegistryMetadata(agentUrl, { lifecycle_stage: 'production' });
  }, 180_000);

  afterAll(async () => {
    for (const table of ['agent_compliance_step_diagnostics', 'agent_storyboard_status', 'agent_verification_badges',
      'agent_compliance_status', 'agent_compliance_runs', 'agent_registry_metadata']) {
      // Table names are fixed test constants, never request data.
      await pool.query(`DELETE FROM ${table} WHERE agent_url = $1`, [agentUrl]);
    }
    await closeDatabase();
  });

  it('backfills discovered agents without rechecking recent runs or overwriting scheduled metadata', async () => {
    const client = await pool.connect();
    const schema = `publication_backfill_${randomUUID().replaceAll('-', '')}`;
    const migration = readFileSync(new URL('../../src/db/migrations/589_compliance_run_publication.sql', import.meta.url), 'utf8');
    const querySpy = vi.spyOn(databaseClient, 'query');
    try {
      await client.query('BEGIN');
      await client.query(`CREATE SCHEMA ${schema}; SET LOCAL search_path TO ${schema}`);
      await client.query(`
        CREATE TABLE agent_registry_metadata (
          agent_url TEXT PRIMARY KEY, lifecycle_stage TEXT DEFAULT 'production',
          check_interval_hours INTEGER NOT NULL DEFAULT 12 CHECK (check_interval_hours BETWEEN 6 AND 168),
          compliance_opt_out BOOLEAN DEFAULT FALSE, monitoring_paused BOOLEAN DEFAULT FALSE
        );
        CREATE TABLE agent_compliance_status (agent_url TEXT PRIMARY KEY, last_checked_at TIMESTAMPTZ);
        CREATE TABLE agent_compliance_runs (
          agent_url TEXT, triggered_org_id TEXT, tested_at TIMESTAMPTZ, overall_status TEXT,
          tracks_json JSONB, headline TEXT, dry_run BOOLEAN NOT NULL DEFAULT FALSE
        );
        CREATE TABLE agent_contexts (
          organization_id TEXT, agent_url TEXT, last_tested_at TIMESTAMPTZ,
          last_test_passed BOOLEAN, last_test_scenario TEXT, last_test_summary TEXT, total_tests_run INTEGER
        );
        CREATE TABLE discovered_agents (agent_url TEXT);
        CREATE TABLE member_profiles (agents JSONB);
        INSERT INTO discovered_agents VALUES ('recent'), ('overdue'), ('never');
        INSERT INTO agent_compliance_status VALUES
          ('recent', NOW() - INTERVAL '1 hour'), ('overdue', NOW() - INTERVAL '13 hours'),
          ('never', NULL), ('existing', NOW() - INTERVAL '1 hour');
        INSERT INTO agent_registry_metadata
          (agent_url, check_interval_hours, compliance_opt_out, monitoring_paused)
          VALUES ('existing', 48, TRUE, TRUE);
      `);
      const before = await client.query('SELECT * FROM agent_compliance_status ORDER BY agent_url');
      await client.query(migration);
      const metadata = await client.query(`
        SELECT m.agent_url, m.check_interval_hours, m.compliance_opt_out, m.monitoring_paused,
          m.next_compliance_check_at = s.last_checked_at + make_interval(hours => m.check_interval_hours) AS cadence_preserved
        FROM agent_registry_metadata m JOIN agent_compliance_status s USING (agent_url) ORDER BY agent_url
      `);
      expect(metadata.rows).toEqual([
        { agent_url: 'existing', check_interval_hours: 48, compliance_opt_out: true, monitoring_paused: true, cadence_preserved: true },
        { agent_url: 'overdue', check_interval_hours: 12, compliance_opt_out: false, monitoring_paused: false, cadence_preserved: true },
        { agent_url: 'recent', check_interval_hours: 12, compliance_opt_out: false, monitoring_paused: false, cadence_preserved: true },
      ]);
      // Re-running the backfill must preserve a scheduler/owner's explicit next check.
      await client.query("UPDATE agent_registry_metadata SET next_compliance_check_at = NOW() + INTERVAL '2 hours' WHERE agent_url = 'existing'");
      const scheduled = await client.query('SELECT * FROM agent_registry_metadata ORDER BY agent_url');
      const backfill = migration.slice(migration.indexOf('INSERT INTO agent_registry_metadata'), migration.indexOf('-- Incomplete suites'));
      await client.query(backfill);
      expect((await client.query('SELECT * FROM agent_registry_metadata ORDER BY agent_url')).rows).toEqual(scheduled.rows);
      expect((await client.query('SELECT * FROM agent_compliance_status ORDER BY agent_url')).rows).toEqual(before.rows);
      // Use the real heartbeat selection query on this transaction's migrated schema.
      querySpy.mockImplementation((sql, values) => client.query(sql, values));
      expect((await db.getAgentsDueForCheck()).map(agent => agent.agent_url)).toEqual(['never', 'overdue']);
    } finally {
      querySpy.mockRestore();
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('persists timed-out audit evidence without changing the complete card, denominator, or badges', async () => {
    const complete = await db.recordComplianceRun(input);
    await db.upsertBadge({ agent_url: agentUrl, role: 'signals', adcp_version: '3.1', verified_specialisms: ['signals-audience-activation'] });
    const snapshot = async () => Promise.all([
      pool.query('SELECT * FROM agent_compliance_status WHERE agent_url = $1', [agentUrl]),
      pool.query('SELECT * FROM agent_storyboard_status WHERE agent_url = $1 ORDER BY storyboard_id', [agentUrl]),
      pool.query('SELECT * FROM agent_verification_badges WHERE agent_url = $1', [agentUrl]),
    ]).then(results => results.map(result => result.rows));
    const before = await snapshot();
    for (const overall_status of ['passing', 'failing'] as const) {
      const partial = await db.recordComplianceRun({
        ...input, completeness: 'timed_out', is_authoritative: true, overall_status,
        headline: 'Partial evidence must stay private',
        tracks_json: [], observations_json: [],
        agent_profile_json: { specialisms: [] },
        storyboard_statuses: [{ storyboard_id: 'first', status: 'failing', steps_passed: 0, steps_total: 1 }],
        step_diagnostics: [{ storyboard_id: 'first', phase_id: 'check', step_id: 'failed', task: 'get_signals',
          step_passed: false, error_text: 'Owner evidence' }],
      });
      expect(partial.run).toMatchObject({ completeness: 'timed_out', is_authoritative: false, dry_run: false });
      expect(partial.statusTransition).toBeNull();
      expect(await snapshot()).toEqual(before);
      expect((await db.getStepDiagnostics(agentUrl, { runId: partial.run.id }))[0].error_text).toBe('Owner evidence');
      expect((await db.getComplianceHistory(agentUrl, 30, { includeDryRuns: true })).some(run => run.id === partial.run.id)).toBe(true);
    }
    expect((await db.getComplianceStatus(agentUrl))?.last_run_id).toBe(complete.run.id);
    expect((await db.bulkGetComplianceStatus([agentUrl])).get(agentUrl)?.last_run_id).toBe(complete.run.id);
    expect((await db.getComplianceStatusWithStoryboardCounts(agentUrl))?.storyboardCounts).toEqual({ passing: 3, total: 3 });
    expect(await db.getStoryboardStatusCounts(agentUrl, { requireRowsForLatestRun: true })).toEqual({ passing: 3, total: 3 });
    expect((await db.getStoryboardStatuses(agentUrl, { requireRowsForLatestRun: true })).length).toBe(3);
    expect((await db.bulkGetStoryboardStatuses([agentUrl])).get(agentUrl)?.length).toBe(3);
    expect((await db.getComplianceHistory(agentUrl)).map(run => run.id)).toEqual([complete.run.id]);
    expect(await db.getLatestObservations(agentUrl)).toEqual(input.observations_json);
    expect(await db.getLatestDeclaredSpecialisms(agentUrl)).toEqual(input.agent_profile_json.specialisms);
  });

  it('keeps scheduler locks and deferrals out of the authoritative timestamp', async () => {
    const before = await db.getComplianceStatus(agentUrl);
    await pool.query(`UPDATE agent_registry_metadata SET next_compliance_check_at = NOW() + INTERVAL '1 hour' WHERE agent_url = $1`, [agentUrl]);
    expect(await db.deferComplianceCheckAfterInconclusiveTarget(agentUrl)).toBe(true);
    expect((await db.getComplianceStatus(agentUrl))?.last_checked_at).toEqual(before?.last_checked_at);
    expect((await db.getAgentsDueForCheck(1000)).some(agent => agent.agent_url === agentUrl)).toBe(false);
    await db.requeueForHeartbeat(agentUrl);
    expect((await db.getComplianceStatus(agentUrl))?.last_checked_at).toEqual(before?.last_checked_at);
    expect((await db.getAgentsDueForCheck(1000)).some(agent => agent.agent_url === agentUrl)).toBe(true);
    await db.recordComplianceRun(input);
    expect((await db.getAgentsDueForCheck(1000)).some(agent => agent.agent_url === agentUrl)).toBe(false);
    const lastComplete = await db.getComplianceStatus(agentUrl);
    await db.updateCheckInterval(agentUrl, 6);
    expect((await db.getAgentsDueForCheck(1000)).some(agent => agent.agent_url === agentUrl)).toBe(true);
    expect((await db.getComplianceStatus(agentUrl))?.last_checked_at).toEqual(lastComplete?.last_checked_at);
  });

  it('uses only complete public profiles for version and specialism fallback', async () => {
    const complete = await db.recordComplianceRun(input);
    const epoch = Date.parse('2030-01-01T00:00:00Z');
    await pool.query('UPDATE agent_compliance_runs SET tested_at = $2 WHERE id = $1',
      [complete.run.id, new Date(epoch)]);
    const cases = [
      { completeness: 'complete', is_authoritative: true, dry_run: true, versions: ['3.0'] },
      { completeness: 'timed_out', is_authoritative: false, dry_run: false, versions: [] },
      { completeness: 'not_completed', is_authoritative: false, dry_run: false, versions: ['3.0'] },
      { completeness: 'complete', is_authoritative: false, dry_run: false, versions: ['3.0'] },
    ];
    for (const [index, row] of cases.entries()) {
      // Historical dry-run rows may be marked authoritative. Insert directly
      // to exercise profile selection independently of public materialization.
      await pool.query(
        `INSERT INTO agent_compliance_runs
           (agent_url, lifecycle_stage, overall_status, tested_at, dry_run,
            completeness, is_authoritative, agent_profile_json)
         VALUES ($1, 'production', 'partial', $2, $3, $4, $5, $6)`,
        [agentUrl, new Date(epoch + (index + 1) * 1000), row.dry_run,
          row.completeness, row.is_authoritative,
          JSON.stringify({ adcp_supported_versions: row.versions, specialisms: [] })],
      );
      expect(await db.getLastKnownSupportedVersions(agentUrl)).toEqual(['3.1']);
      expect(await db.getLatestDeclaredSpecialisms(agentUrl)).toEqual(input.agent_profile_json.specialisms);
    }
    const newer = await db.recordComplianceRun({
      ...input, agent_profile_json: { adcp_supported_versions: ['3.0'], specialisms: [] },
    });
    await pool.query('UPDATE agent_compliance_runs SET tested_at = $2 WHERE id = $1',
      [newer.run.id, new Date(epoch + 10_000)]);
    expect(await db.getLastKnownSupportedVersions(agentUrl)).toEqual(['3.0']);
    expect(await db.getLatestDeclaredSpecialisms(agentUrl)).toEqual([]);
  });
});
