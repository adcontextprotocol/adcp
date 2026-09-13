import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
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
