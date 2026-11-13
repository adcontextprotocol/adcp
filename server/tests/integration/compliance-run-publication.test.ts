import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import * as databaseClient from '../../src/db/client.js';
import { closeDatabase, initializeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { ComplianceDatabase, type RecordComplianceRunInput } from '../../src/db/compliance-db.js';
import {
  claimHeartbeatAgents,
  createHeartbeatProcessIdentity,
  markHeartbeatSuiteStarted,
  releaseHeartbeatClaim,
} from '../../src/addie/jobs/compliance-heartbeat-claims.js';

/** A batch lock comfortably longer than any single test. */
const BATCH_LOCK_MS = 60 * 60 * 1000;

describe.skipIf(!process.env.DATABASE_URL)('compliance publication transaction', () => {
  let pool: Pool;
  const db = new ComplianceDatabase();
  const agentUrl = `https://${randomUUID()}.example.test/mcp`;
  const ownerOrgId = `org_compliance_publication_${randomUUID()}`;
  const ownerSlug = `compliance-publication-${randomUUID()}`;
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
    await pool.query('INSERT INTO organizations (workos_organization_id, name) VALUES ($1, $2)',
      [ownerOrgId, 'Compliance publication test']);
    await pool.query(
      `INSERT INTO member_profiles (workos_organization_id, display_name, slug, agents)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [ownerOrgId, 'Compliance publication test', ownerSlug, JSON.stringify([{ url: agentUrl }])],
    );
    await db.upsertRegistryMetadata(agentUrl, { lifecycle_stage: 'production' });
  }, 180_000);

  afterAll(async () => {
    for (const table of ['agent_compliance_step_diagnostics', 'agent_storyboard_status', 'agent_verification_badges',
      'agent_compliance_status', 'agent_compliance_runs', 'agent_registry_metadata']) {
      // Table names are fixed test constants, never request data.
      await pool.query(`DELETE FROM ${table} WHERE agent_url = $1`, [agentUrl]);
    }
    await pool.query('DELETE FROM organizations WHERE workos_organization_id = $1', [ownerOrgId]);
    await closeDatabase();
  });

  it('backfills discovered agents without rechecking recent runs or overwriting scheduled metadata', async () => {
    const client = await pool.connect();
    const schema = `publication_backfill_${randomUUID().replaceAll('-', '')}`;
    const migration = readFileSync(new URL('../../src/db/migrations/589_compliance_run_publication.sql', import.meta.url), 'utf8');
    const requeueMigration = readFileSync(new URL('../../src/db/migrations/608_agent_registry_requeued_at.sql', import.meta.url), 'utf8');
    const heartbeatClaimMigration = readFileSync(new URL('../../src/db/migrations/622_compliance_heartbeat_claim_ownership.sql', import.meta.url), 'utf8');
    const scheduleStateMigration = readFileSync(new URL('../../src/db/migrations/635_compliance_heartbeat_schedule_state.sql', import.meta.url), 'utf8');
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
          tracks_json JSONB, headline TEXT, dry_run BOOLEAN NOT NULL DEFAULT FALSE,
          triggered_by TEXT NOT NULL DEFAULT 'heartbeat'
        );
        CREATE TABLE agent_contexts (
          organization_id TEXT, agent_url TEXT, last_tested_at TIMESTAMPTZ,
          last_test_passed BOOLEAN, last_test_scenario TEXT, last_test_summary TEXT, total_tests_run INTEGER
        );
        CREATE TABLE discovered_agents (
          agent_url TEXT, expires_at TIMESTAMPTZ,
          discovered_at TIMESTAMPTZ DEFAULT NOW(), last_validated TIMESTAMPTZ
        );
        CREATE TABLE agent_publisher_authorizations (
          agent_url TEXT, source TEXT, discovered_at TIMESTAMPTZ DEFAULT NOW(),
          last_validated TIMESTAMPTZ
        );
        CREATE TABLE agent_verification_badges (agent_url TEXT, status TEXT);
        CREATE TABLE member_profiles (agents JSONB);
        INSERT INTO discovered_agents (agent_url) VALUES ('recent'), ('overdue'), ('never');
        INSERT INTO agent_publisher_authorizations (agent_url, source)
          VALUES ('recent', 'adagents_json'), ('overdue', 'adagents_json'), ('never', 'adagents_json');
        INSERT INTO agent_compliance_status VALUES
          ('recent', NOW() - INTERVAL '1 hour'), ('overdue', NOW() - INTERVAL '49 hours'),
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
      await client.query(requeueMigration);
      await client.query(heartbeatClaimMigration);
      await client.query(scheduleStateMigration);
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
    expect(await db.deferComplianceCheckAfterInconclusiveTarget(agentUrl, 'pre_target_error')).toBe(true);
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

  it('holds a busy suite briefly in the lock, only while its selected claim still holds it', async () => {
    const selectedLockUntil = new Date(Date.now() + BATCH_LOCK_MS);
    const dueCadence = new Date(Date.now() - 10 * 60 * 1000);
    await pool.query(
      `UPDATE agent_registry_metadata
       SET compliance_lock_until = $2, next_compliance_check_at = $3, last_heartbeat_skip_reason = NULL
       WHERE agent_url = $1`,
      [agentUrl, selectedLockUntil, dueCadence],
    );
    expect(await db.deferComplianceCheckAfterContention(agentUrl, selectedLockUntil)).toBe(true);
    const held = await pool.query(
      `SELECT compliance_lock_until, next_compliance_check_at, last_heartbeat_skip_reason,
              EXTRACT(EPOCH FROM compliance_lock_until - NOW()) / 60 AS minutes_held
       FROM agent_registry_metadata WHERE agent_url = $1`,
      [agentUrl],
    );
    expect(Number(held.rows[0].minutes_held)).toBeGreaterThan(4.9);
    expect(Number(held.rows[0].minutes_held)).toBeLessThanOrEqual(5);
    // Contention is not a verdict about the agent: its cadence stays due.
    expect(held.rows[0].next_compliance_check_at).toEqual(dueCadence);
    expect(held.rows[0].last_heartbeat_skip_reason).toBe('execution_fence_busy');
    expect((await db.getAgentsDueForCheck(1000)).some(agent => agent.agent_url === agentUrl)).toBe(false);

    const otherClaim = new Date(Date.now() + 2 * BATCH_LOCK_MS);
    await pool.query('UPDATE agent_registry_metadata SET compliance_lock_until = $2 WHERE agent_url = $1',
      [agentUrl, otherClaim]);
    expect(await db.deferComplianceCheckAfterContention(agentUrl, selectedLockUntil)).toBe(false);
    const current = await pool.query(
      'SELECT compliance_lock_until FROM agent_registry_metadata WHERE agent_url = $1', [agentUrl],
    );
    expect(current.rows[0].compliance_lock_until).toEqual(otherClaim);
    await pool.query('UPDATE agent_registry_metadata SET compliance_lock_until = NULL WHERE agent_url = $1', [agentUrl]);
  });

  it('backs off repeated target failures and resets the streak on requeue and an authoritative run', async () => {
    await db.updateCheckInterval(agentUrl, 6);
    await pool.query(
      `UPDATE agent_registry_metadata
       SET next_compliance_check_at = NOW() + INTERVAL '1 hour', compliance_inconclusive_streak = 0
       WHERE agent_url = $1`,
      [agentUrl],
    );
    const schedule = async () => {
      const result = await pool.query(
        `SELECT compliance_inconclusive_streak AS streak,
                EXTRACT(EPOCH FROM (next_compliance_check_at - NOW())) / 3600 AS hours
         FROM agent_registry_metadata WHERE agent_url = $1`,
        [agentUrl],
      );
      return { streak: result.rows[0].streak as number, hours: Number(result.rows[0].hours) };
    };

    for (const [index, expectedHours] of [6, 12, 24, 48, 48].entries()) {
      expect(await db.deferComplianceCheckAfterInconclusiveTarget(
        agentUrl, 'target_unconfirmed', { exponentialBackoff: true },
      )).toBe(true);
      const current = await schedule();
      expect(current.streak).toBe(Math.min(index + 1, 4));
      expect(current.hours).toBeGreaterThan(expectedHours - 0.1);
      expect(current.hours).toBeLessThanOrEqual(expectedHours);
    }

    const scheduledBeforeIdempotentUpdate = await pool.query(
      'SELECT next_compliance_check_at FROM agent_registry_metadata WHERE agent_url = $1', [agentUrl],
    );
    await db.updateCheckInterval(agentUrl, 6);
    const scheduledAfterIdempotentUpdate = await pool.query(
      'SELECT next_compliance_check_at FROM agent_registry_metadata WHERE agent_url = $1', [agentUrl],
    );
    expect(scheduledAfterIdempotentUpdate.rows).toEqual(scheduledBeforeIdempotentUpdate.rows);
    expect((await schedule()).streak).toBe(4);

    await db.requeueForHeartbeat(agentUrl);
    expect((await schedule()).streak).toBe(0);
    await pool.query(`UPDATE agent_registry_metadata SET next_compliance_check_at = NOW() + INTERVAL '1 hour' WHERE agent_url = $1`,
      [agentUrl]);
    await db.deferComplianceCheckAfterInconclusiveTarget(agentUrl, 'target_unconfirmed', { exponentialBackoff: true });
    await db.recordComplianceRun(input);
    expect((await schedule()).streak).toBe(0);

    await db.updateCheckInterval(agentUrl, 168);
    await pool.query(`UPDATE agent_registry_metadata SET next_compliance_check_at = NOW() + INTERVAL '1 hour' WHERE agent_url = $1`,
      [agentUrl]);
    expect(await db.deferComplianceCheckAfterInconclusiveTarget(
      agentUrl, 'target_unconfirmed', { exponentialBackoff: true },
    )).toBe(true);
    const longInterval = await schedule();
    expect(longInterval.streak).toBe(1);
    expect(longInterval.hours).toBeGreaterThan(167.9);
    expect(longInterval.hours).toBeLessThanOrEqual(168);
  });

  it('excludes metadata-only and expired or stale publisher discovery rows', async () => {
    const url = `https://${randomUUID()}.example.test/mcp`;
    try {
      await db.upsertRegistryMetadata(url, { lifecycle_stage: 'production' });
      await db.requeueForHeartbeat(url);
      const selected = async () => (await db.getAgentsDueForCheck(100000)).some(agent => agent.agent_url === url);
      expect(await selected()).toBe(false);

      // A badge remains public even after its registration disappears. Keep
      // reassessing that URL until badge policy revokes or requalifies it.
      await pool.query(
        `INSERT INTO agent_verification_badges (agent_url, role, adcp_version)
         VALUES ($1, 'signals', '3.1')`,
        [url],
      );
      expect(await selected()).toBe(true);
      await pool.query(`UPDATE agent_verification_badges SET status = 'revoked' WHERE agent_url = $1`, [url]);
      expect(await selected()).toBe(false);

      await pool.query(
        `INSERT INTO discovered_agents (agent_url, source_type, source_domain, expires_at)
         VALUES ($1, 'adagents_json', 'example.test', NOW() - INTERVAL '1 day')`,
        [url],
      );
      await pool.query(
        `INSERT INTO agent_publisher_authorizations (agent_url, publisher_domain, source)
         VALUES ($1, 'example.test', 'adagents_json')`,
        [url],
      );
      expect(await selected()).toBe(false);

      await pool.query(`UPDATE discovered_agents SET expires_at = NOW() + INTERVAL '1 day' WHERE agent_url = $1`, [url]);
      expect(await selected()).toBe(true);

      await pool.query(
        `UPDATE agent_publisher_authorizations
         SET discovered_at = NOW() - INTERVAL '31 days', last_validated = NULL
         WHERE agent_url = $1`,
        [url],
      );
      expect(await selected()).toBe(false);
      await pool.query('UPDATE discovered_agents SET last_validated = NOW() WHERE agent_url = $1', [url]);
      expect(await selected()).toBe(false);
      await pool.query('UPDATE agent_publisher_authorizations SET last_validated = NOW() WHERE agent_url = $1', [url]);
      expect(await selected()).toBe(true);
    } finally {
      await pool.query('DELETE FROM agent_verification_badges WHERE agent_url = $1', [url]);
      await pool.query('DELETE FROM agent_publisher_authorizations WHERE agent_url = $1', [url]);
      await pool.query('DELETE FROM discovered_agents WHERE agent_url = $1', [url]);
      await pool.query('DELETE FROM agent_registry_metadata WHERE agent_url = $1', [url]);
    }
  });

  it('serves explicit requeues ahead of older discovery-only agents', async () => {
    const stale = `https://${randomUUID()}.example.test/mcp`;
    const recent = `https://${randomUUID()}.example.test/mcp`;
    const order = async () => (await db.getAgentsDueForCheck(100000))
      .map(agent => agent.agent_url)
      .filter(url => url === stale || url === recent);
    try {
      await db.upsertRegistryMetadata(stale, { lifecycle_stage: 'production' });
      await db.upsertRegistryMetadata(recent, { lifecycle_stage: 'production' });
      await pool.query(
        `INSERT INTO discovered_agents (agent_url, source_type, source_domain)
         VALUES ($1, 'adagents_json', 'example.test'), ($2, 'adagents_json', 'example.test')`,
        [stale, recent],
      );
      await pool.query(
        `INSERT INTO agent_publisher_authorizations (agent_url, publisher_domain, source)
         VALUES ($1, 'example.test', 'adagents_json'), ($2, 'example.test', 'adagents_json')`,
        [stale, recent],
      );
      await pool.query(
        `INSERT INTO agent_compliance_status (agent_url, status, last_checked_at)
         VALUES ($1, 'passing', NOW() - INTERVAL '3 days'), ($2, 'passing', NOW() - INTERVAL '1 hour')`,
        [stale, recent],
      );
      expect(await order()).toEqual([stale]);

      await db.requeueForHeartbeat(recent);
      expect(await order()).toEqual([recent, stale]);

      await db.recordComplianceRun({ ...input, agent_url: recent });
      expect((await db.getAgentsDueForCheck(100000)).some(agent => agent.agent_url === recent)).toBe(false);
      await db.updateCheckInterval(recent, 6);
      expect(await order()).toEqual([stale]);
    } finally {
      await pool.query('DELETE FROM agent_publisher_authorizations WHERE agent_url = ANY($1::text[])', [[stale, recent]]);
      await pool.query('DELETE FROM discovered_agents WHERE agent_url = ANY($1::text[])', [[stale, recent]]);
      for (const table of ['agent_compliance_step_diagnostics', 'agent_storyboard_status', 'agent_verification_badges',
        'agent_compliance_status', 'agent_compliance_runs', 'agent_registry_metadata']) {
        await pool.query(`DELETE FROM ${table} WHERE agent_url = ANY($1::text[])`, [[stale, recent]]);
      }
    }
  });

  describe('owner-initiated runs leave the heartbeat schedule alone (#7680)', () => {
    const urls: string[] = [];
    const freshAgent = async (options: { withMetadata?: boolean } = {}) => {
      const url = `https://${randomUUID()}.example.test/mcp`;
      urls.push(url);
      // Metadata alone is not a current-agent source (#7844). Register each
      // fixture with the owning profile so due-selection exercises scheduling.
      await pool.query(
        `UPDATE member_profiles SET agents = agents || $2::jsonb
         WHERE workos_organization_id = $1`,
        [ownerOrgId, JSON.stringify([{ url }])],
      );
      if (options.withMetadata ?? true) await db.upsertRegistryMetadata(url, { lifecycle_stage: 'production' });
      return url;
    };
    const schedule = async (url: string) => (await pool.query<{
      next_compliance_check_at: Date | null; requeued_at: Date | null; hours_until_next: number | null;
    }>(
      `SELECT next_compliance_check_at, requeued_at,
              EXTRACT(EPOCH FROM next_compliance_check_at - NOW()) / 3600 AS hours_until_next
       FROM agent_registry_metadata WHERE agent_url = $1`,
      [url],
    )).rows[0];
    const isDue = async (url: string) =>
      (await db.getAgentsDueForCheck(100000)).some(agent => agent.agent_url === url);

    afterAll(async () => {
      for (const table of ['agent_compliance_step_diagnostics', 'agent_storyboard_status', 'agent_verification_badges',
        'agent_compliance_status', 'agent_compliance_runs', 'agent_registry_metadata']) {
        await pool.query(`DELETE FROM ${table} WHERE agent_url = ANY($1::text[])`, [urls]);
      }
    });

    it('keeps a pending requeue when a full-suite owner test publishes', async () => {
      const url = await freshAgent();
      await db.requeueForHeartbeat(url);
      const before = await schedule(url);
      await db.recordComplianceRun({ ...input, agent_url: url, triggered_by: 'owner_test' });

      const after = await schedule(url);
      expect(after.next_compliance_check_at).toBeNull();
      expect(after.requeued_at).toEqual(before.requeued_at);
      expect(after.requeued_at).not.toBeNull();
      expect(await isDue(url)).toBe(true);
      // The owner verdict still publishes to the public card.
      expect((await db.getComplianceStatus(url))?.status).toBe('passing');
    });

    it('consumes the requeue when the heartbeat serving it publishes', async () => {
      const url = await freshAgent();
      await db.requeueForHeartbeat(url);
      await db.recordComplianceRun({ ...input, agent_url: url, triggered_by: 'heartbeat' });

      const after = await schedule(url);
      expect(after.requeued_at).toBeNull();
      expect(Number(after.hours_until_next)).toBeCloseTo(12, 1);
      expect(await isDue(url)).toBe(false);
    });

    it.each(['manual', 'webhook'] as const)('advances the cadence and clears the requeue for %s runs', async (triggeredBy) => {
      const url = await freshAgent();
      await db.requeueForHeartbeat(url);
      await db.recordComplianceRun({ ...input, agent_url: url, triggered_by: triggeredBy });

      const after = await schedule(url);
      expect(after.requeued_at).toBeNull();
      expect(Number(after.hours_until_next)).toBeCloseTo(12, 1);
    });

    it('defaults an unlabelled run to heartbeat scheduling', async () => {
      const url = await freshAgent();
      await db.requeueForHeartbeat(url);
      expect(input.triggered_by).toBeUndefined();
      await db.recordComplianceRun({ ...input, agent_url: url });

      const after = await schedule(url);
      expect(after.requeued_at).toBeNull();
      expect(Number(after.hours_until_next)).toBeCloseTo(12, 1);
    });

    it('does not push a scheduled heartbeat further out when an owner test publishes', async () => {
      const url = await freshAgent();
      await pool.query(
        `UPDATE agent_registry_metadata SET next_compliance_check_at = NOW() + INTERVAL '2 hours' WHERE agent_url = $1`,
        [url],
      );
      const before = await schedule(url);
      await db.recordComplianceRun({ ...input, agent_url: url, triggered_by: 'owner_test' });

      expect((await schedule(url)).next_compliance_check_at).toEqual(before.next_compliance_check_at);
    });

    it('leaves an overdue heartbeat due after an owner test publishes', async () => {
      const url = await freshAgent();
      await pool.query(
        `UPDATE agent_registry_metadata SET next_compliance_check_at = NOW() - INTERVAL '1 hour' WHERE agent_url = $1`,
        [url],
      );
      await db.recordComplianceRun({ ...input, agent_url: url, triggered_by: 'owner_test' });

      expect(await isDue(url)).toBe(true);
    });

    it('leaves a first-ever owner test immediately eligible for an independent heartbeat', async () => {
      const url = await freshAgent({ withMetadata: false });
      expect(await schedule(url)).toBeUndefined();
      expect(await isDue(url)).toBe(true);
      await db.recordComplianceRun({ ...input, agent_url: url, triggered_by: 'owner_test' });

      const after = await schedule(url);
      expect(after).toBeDefined();
      expect(after.next_compliance_check_at).toBeNull();
      expect(await isDue(url)).toBe(true);
    });

    it('still schedules a first-ever heartbeat on the default cadence', async () => {
      const url = await freshAgent({ withMetadata: false });
      await db.recordComplianceRun({ ...input, agent_url: url, triggered_by: 'heartbeat' });

      expect(Number((await schedule(url)).hours_until_next)).toBeCloseTo(12, 1);
    });

    it('leaves scheduling untouched for a scoped (non-authoritative) owner test', async () => {
      const url = await freshAgent();
      await db.requeueForHeartbeat(url);
      await db.recordComplianceRun({
        ...input, agent_url: url, triggered_by: 'owner_test',
        is_authoritative: false, replace_storyboard_statuses: false,
        storyboard_statuses: [{ storyboard_id: 'first', status: 'passing', steps_passed: 1, steps_total: 1 }],
      });

      const after = await schedule(url);
      expect(after.next_compliance_check_at).toBeNull();
      expect(after.requeued_at).not.toBeNull();
    });
  });

  describe('cadence, heartbeat lock and skip deferral are separate states (#7693)', () => {
    const urls: string[] = [];
    const identity = createHeartbeatProcessIdentity(`machine-${randomUUID()}`);
    const registeredAgent = async () => {
      const url = `https://${randomUUID()}.example.test/mcp`;
      urls.push(url);
      await pool.query(
        `UPDATE member_profiles SET agents = agents || $2::jsonb
         WHERE workos_organization_id = $1`,
        [ownerOrgId, JSON.stringify([{ url }])],
      );
      await db.upsertRegistryMetadata(url, { lifecycle_stage: 'production' });
      return url;
    };
    const state = async (url: string) => (await pool.query<{
      next_compliance_check_at: Date | null;
      compliance_lock_until: Date | null;
      compliance_inconclusive_streak: number;
      requeued_at: Date | null;
      last_heartbeat_attempt_at: Date | null;
      last_heartbeat_skip_reason: string | null;
      last_heartbeat_success_at: Date | null;
      hours_until_next: string | null;
    }>(
      `SELECT next_compliance_check_at, compliance_lock_until, compliance_inconclusive_streak, requeued_at,
              last_heartbeat_attempt_at, last_heartbeat_skip_reason, last_heartbeat_success_at,
              EXTRACT(EPOCH FROM next_compliance_check_at - NOW()) / 3600 AS hours_until_next
       FROM agent_registry_metadata WHERE agent_url = $1`,
      [url],
    )).rows[0];
    const isDue = async (url: string) =>
      (await db.getAgentsDueForCheck(100000)).some(agent => agent.agent_url === url);
    const makeDue = async (url: string) => {
      const due = new Date(Date.now() - 10 * 60 * 1000);
      await pool.query('UPDATE agent_registry_metadata SET next_compliance_check_at = $2 WHERE agent_url = $1', [url, due]);
      return due;
    };
    const claim = async (url: string) => {
      const claimed = await claimHeartbeatAgents([url], new Date(Date.now() + BATCH_LOCK_MS), identity.owner);
      expect(claimed.has(url)).toBe(true);
    };

    afterAll(async () => {
      for (const table of ['agent_compliance_step_diagnostics', 'agent_storyboard_status', 'agent_verification_badges',
        'agent_compliance_status', 'agent_compliance_runs', 'agent_registry_metadata']) {
        await pool.query(`DELETE FROM ${table} WHERE agent_url = ANY($1::text[])`, [urls]);
      }
    });

    it('keeps the cadence under an in-flight lock and makes the agent due again once the lock expires', async () => {
      const url = await registeredAgent();
      const dueCadence = await makeDue(url);
      expect(await isDue(url)).toBe(true);

      await claim(url);

      const locked = await state(url);
      expect(locked.next_compliance_check_at).toEqual(dueCadence);
      expect(locked.compliance_lock_until?.getTime()).toBeGreaterThan(Date.now());
      expect(await isDue(url)).toBe(false);

      // A worker that dies holding the lock strands nothing: once it expires
      // the agent is due on the cadence it never lost.
      await pool.query(`UPDATE agent_registry_metadata SET compliance_lock_until = NOW() - INTERVAL '1 second'
        WHERE agent_url = $1`, [url]);
      expect(await isDue(url)).toBe(true);
    });

    it('records a skipped attempt without counting it as a success, then a heartbeat publish clears it', async () => {
      const url = await registeredAgent();
      await db.recordComplianceRun({ ...input, agent_url: url, triggered_by: 'heartbeat' });
      const published = await state(url);
      expect(published.last_heartbeat_success_at).not.toBeNull();
      expect(published.last_heartbeat_attempt_at).toEqual(published.last_heartbeat_success_at);
      expect(published.last_heartbeat_skip_reason).toBeNull();

      await makeDue(url);
      await claim(url);
      await markHeartbeatSuiteStarted(url, identity.owner);
      await db.deferComplianceCheckAfterInconclusiveTarget(url, 'target_unconfirmed', { exponentialBackoff: true });
      await releaseHeartbeatClaim(url, identity.owner);

      const skipped = await state(url);
      expect(skipped.last_heartbeat_skip_reason).toBe('target_unconfirmed');
      expect(skipped.last_heartbeat_attempt_at!.getTime()).toBeGreaterThan(published.last_heartbeat_success_at!.getTime());
      expect(skipped.last_heartbeat_success_at).toEqual(published.last_heartbeat_success_at);
      expect(skipped.compliance_lock_until).toBeNull();
      expect(skipped.compliance_inconclusive_streak).toBe(1);
      expect(Number(skipped.hours_until_next)).toBeCloseTo(12, 1);
      expect(await isDue(url)).toBe(false);

      await makeDue(url);
      await claim(url);
      await db.recordComplianceRun({ ...input, agent_url: url, triggered_by: 'heartbeat' });

      const republished = await state(url);
      expect(republished.last_heartbeat_skip_reason).toBeNull();
      expect(republished.last_heartbeat_success_at!.getTime()).toBeGreaterThan(published.last_heartbeat_success_at!.getTime());
      expect(republished.last_heartbeat_attempt_at).toEqual(republished.last_heartbeat_success_at);
      expect(republished.compliance_lock_until).toBeNull();
      expect(republished.compliance_inconclusive_streak).toBe(0);
    });

    it.each(['owner_test', 'manual'] as const)(
      'leaves the heartbeat lock and success history alone when a %s run publishes',
      async (triggeredBy) => {
        const url = await registeredAgent();
        await makeDue(url);
        await claim(url);
        const before = await state(url);

        await db.recordComplianceRun({ ...input, agent_url: url, triggered_by: triggeredBy });

        const after = await state(url);
        expect(after.compliance_lock_until).toEqual(before.compliance_lock_until);
        expect(after.last_heartbeat_success_at).toBeNull();
        expect(after.last_heartbeat_attempt_at).toBeNull();
      },
    );

    it('lets a requeue placed after the suite started win over the deferral', async () => {
      const url = await registeredAgent();
      await makeDue(url);
      await claim(url);
      await markHeartbeatSuiteStarted(url, identity.owner);
      await db.requeueForHeartbeat(url);

      await db.deferComplianceCheckAfterInconclusiveTarget(url, 'audit_only', { exponentialBackoff: true });
      await releaseHeartbeatClaim(url, identity.owner);

      const after = await state(url);
      expect(after.next_compliance_check_at).toBeNull();
      expect(after.compliance_inconclusive_streak).toBe(0);
      expect(after.last_heartbeat_skip_reason).toBe('audit_only');
      expect(await isDue(url)).toBe(true);
    });

    it('lets a requeue lift a hold no batch owns, but never a live batch claim', async () => {
      const url = await registeredAgent();
      await makeDue(url);
      await claim(url);

      await db.requeueForHeartbeat(url);
      expect((await state(url)).compliance_lock_until!.getTime()).toBeGreaterThan(Date.now());
      expect(await isDue(url)).toBe(false);

      // Crash quarantine: orphan reconciliation leaves the lock with no owner.
      await pool.query(
        `UPDATE agent_registry_metadata
         SET heartbeat_claim_owner = NULL, compliance_lock_until = NOW() + INTERVAL '30 minutes'
         WHERE agent_url = $1`,
        [url],
      );
      expect(await isDue(url)).toBe(false);
      await db.requeueForHeartbeat(url);
      expect((await state(url)).compliance_lock_until).toBeNull();
      expect(await isDue(url)).toBe(true);
    });

    it('serves the oldest independent check first within a tier, not the least recently owner-tested agent', async () => {
      const ownerTested = await registeredAgent();
      const heartbeatChecked = await registeredAgent();
      const neverHeartbeat = await registeredAgent();
      const tier = [ownerTested, heartbeatChecked, neverHeartbeat];
      // Owner tests publish and refresh last_checked_at without being an
      // independent check.
      for (const url of [ownerTested, neverHeartbeat]) {
        await db.recordComplianceRun({ ...input, agent_url: url, triggered_by: 'owner_test' });
      }
      await pool.query(
        `INSERT INTO agent_compliance_status (agent_url, status, last_checked_at)
         VALUES ($1, 'passing', NOW() - INTERVAL '2 days')`,
        [heartbeatChecked],
      );
      await pool.query(
        `UPDATE agent_registry_metadata
         SET next_compliance_check_at = NOW() - INTERVAL '10 minutes',
             last_heartbeat_success_at = CASE agent_url
               WHEN $1 THEN NOW() - INTERVAL '3 days'
               WHEN $2 THEN NOW() - INTERVAL '2 days' END
         WHERE agent_url = ANY($3::text[])`,
        [ownerTested, heartbeatChecked, tier],
      );

      const order = (await db.getAgentsDueForCheck(100000))
        .map(agent => agent.agent_url)
        .filter(url => tier.includes(url));

      expect(order).toEqual([neverHeartbeat, ownerTested, heartbeatChecked]);
    });

    it('answers a requeue placed before the suite started with that attempt\'s backoff', async () => {
      const url = await registeredAgent();
      await makeDue(url);
      await db.requeueForHeartbeat(url);
      await claim(url);
      await markHeartbeatSuiteStarted(url, identity.owner);

      await db.deferComplianceCheckAfterInconclusiveTarget(url, 'audit_only', { exponentialBackoff: true });
      await releaseHeartbeatClaim(url, identity.owner);

      const after = await state(url);
      expect(Number(after.hours_until_next)).toBeCloseTo(12, 1);
      expect(after.compliance_inconclusive_streak).toBe(1);
      // The requeue still orders the agent first once the backoff passes.
      expect(after.requeued_at).not.toBeNull();
      expect(await isDue(url)).toBe(false);
    });
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
