/**
 * The merge policies that resolve trailing-slash collisions (#7830).
 *
 * Seeded with the shapes production actually has: the root-slash pair
 * (`https://host` vs `https://host/`) and the non-root pair (`/mcp` vs
 * `/mcp/`), across the tables the maintainer's collision listing named —
 * compliance status, registry metadata, verification badges, storyboard
 * status and discovered agents.
 *
 * Each case asserts three things: the right row survives, the composed
 * values are the conservative ones, and every value the merged row does not
 * carry appears in the report. The last one is the "never silently drop a
 * badge or an authorization" guarantee.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { runMigration } from '../../src/scripts/migrate-registry-agent-url-keys.js';

const HOST = 'merge-policy.example';
const ROOT = `https://root.${HOST}`;
const PATHED = `https://pathed.${HOST}/mcp`;

interface MergeReport {
  store: string;
  merges: Array<{
    toKey: string; winnerKey: string; loserKeys: string[];
    merged: Record<string, unknown>;
    drops: Array<{ rowKey: string; column: string; dropped: unknown; kept: unknown }>;
  }>;
}

describe('registry key merge policies (#7830)', () => {
  let pool: Pool;
  const logged: string[] = [];
  let restoreLog: (() => void) | undefined;

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString:
        process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:5432/adcp_test',
    });
    await runMigrations();
  });

  async function clearFixtures() {
    for (const table of [
      'agent_compliance_status', 'agent_registry_metadata', 'agent_verification_badges',
      'agent_storyboard_status', 'discovered_agents', 'agent_health_snapshot',
    ]) {
      await pool.query(`DELETE FROM ${table} WHERE agent_url LIKE $1`, [`%${HOST}%`]);
    }
  }

  beforeEach(async () => {
    await clearFixtures();
    logged.length = 0;
    const original = console.log;
    console.log = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
    restoreLog = () => { console.log = original; };
  });

  afterAll(async () => {
    restoreLog?.();
    await clearFixtures();
    await closeDatabase();
  });

  function report(store: string): MergeReport {
    const parsed = JSON.parse(logged.find(line => line.trimStart().startsWith('{')) as string);
    return (parsed.stores as MergeReport[]).find(entry => entry.store === store)!;
  }

  async function run(store: string, apply: boolean) {
    return runMigration({ apply, stores: [store] });
  }

  it('folds a root-slash pair in agent_compliance_status onto the freshest check', async () => {
    await pool.query(
      `INSERT INTO agent_compliance_status
         (agent_url, status, last_checked_at, last_passed_at, last_failed_at, streak_days, headline)
       VALUES ($1, 'failing', now() - interval '2 days', now() - interval '9 days',
               now() - interval '2 days', 0, 'stale'),
              ($2, 'passing', now(), now(), NULL, 5, 'fresh')`,
      [`${ROOT}/`, ROOT],
    );

    const { blocked } = await run('agent_compliance_status', false);
    expect(blocked).toBe(false);
    const [merge] = report('agent_compliance_status').merges;
    expect(merge.toKey).toBe(ROOT);
    expect(merge.winnerKey).toBe(ROOT);
    expect(merge.loserKeys).toEqual([`${ROOT}/`]);
    // The losing row's status and headline are dropped — and listed.
    expect(merge.drops.map(drop => drop.column)).toEqual(
      expect.arrayContaining(['status', 'headline']));

    await run('agent_compliance_status', true);

    const { rows } = await pool.query<{ agent_url: string; status: string; streak_days: number }>(
      `SELECT agent_url, status, streak_days FROM agent_compliance_status
        WHERE agent_url LIKE $1`, [`%${HOST}%`]);
    // The freshest check decides status and streak; last_failed_at is kept
    // from the other spelling because it is a fact about the agent.
    expect(rows).toEqual([{ agent_url: ROOT, status: 'passing', streak_days: 5 }]);
    const { rows: timestamps } = await pool.query<{ last_failed_at: Date | null }>(
      `SELECT last_failed_at FROM agent_compliance_status WHERE agent_url = $1`, [ROOT]);
    expect(timestamps[0].last_failed_at).not.toBeNull();
  });

  it('folds a non-root pair in agent_registry_metadata conservatively', async () => {
    await pool.query(
      `INSERT INTO agent_registry_metadata
         (agent_url, updated_at, created_at, compliance_opt_out, monitoring_paused,
          check_interval_hours, badge_requalification_generation)
       VALUES ($1, now() - interval '1 day', now() - interval '9 days', false, true, 24, 7),
              ($2, now(), now() - interval '2 days', true, false, 6, 3)`,
      [`${PATHED}/`, PATHED],
    );

    await run('agent_registry_metadata', false);
    const [merge] = report('agent_registry_metadata').merges;
    expect(merge.winnerKey).toBe(PATHED);
    // Every gate takes the conservative value, from whichever row held it.
    expect(merge.merged.compliance_opt_out).toBe(true);
    expect(merge.merged.monitoring_paused).toBe(true);
    expect(merge.merged.check_interval_hours).toBe(6);
    // One past the group maximum, so an in-flight run cannot clear the gate.
    expect(merge.merged.badge_requalification_generation).toBe('8');

    await run('agent_registry_metadata', true);

    const { rows } = await pool.query(
      `SELECT agent_url, compliance_opt_out, monitoring_paused, check_interval_hours,
              badge_requalification_generation, created_at
         FROM agent_registry_metadata WHERE agent_url LIKE $1`, [`%${HOST}%`]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      agent_url: PATHED,
      compliance_opt_out: true,
      monitoring_paused: true,
      check_interval_hours: 6,
      badge_requalification_generation: '8',
    });
  });

  it('keeps the active badge and reports the revoked one it drops', async () => {
    await pool.query(
      `INSERT INTO agent_verification_badges
         (agent_url, role, adcp_version, status, verified_at, created_at)
       VALUES ($1, 'media-buy', '3.2', 'revoked', now(), now() - interval '9 days'),
              ($2, 'media-buy', '3.2', 'active', now() - interval '1 day', now())`,
      [`${PATHED}/`, PATHED],
    );

    await run('agent_verification_badges', false);
    const [merge] = report('agent_verification_badges').merges;
    // Active outranks revoked even though the revoked row is newer.
    expect(merge.winnerKey).toBe(PATHED);
    const statusDrop = merge.drops.find(drop => drop.column === 'status');
    expect(statusDrop).toMatchObject({ dropped: 'revoked', kept: 'active' });

    await run('agent_verification_badges', true);

    const { rows } = await pool.query<{ agent_url: string; status: string }>(
      `SELECT agent_url, status FROM agent_verification_badges WHERE agent_url LIKE $1`,
      [`%${HOST}%`]);
    expect(rows).toEqual([{ agent_url: PATHED, status: 'active' }]);
  });

  it('follows one run when folding agent_storyboard_status', async () => {
    await pool.query(
      `INSERT INTO agent_storyboard_status
         (agent_url, storyboard_id, status, last_tested_at, steps_passed, steps_total,
          first_failure_message)
       VALUES ($1, 'sb-1', 'failing', now() - interval '2 days', 1, 4, 'old failure'),
              ($2, 'sb-1', 'passing', now(), 4, 4, NULL),
              ($1, 'sb-2', 'passing', now(), 2, 2, NULL)`,
      [`${PATHED}/`, PATHED],
    );

    await run('agent_storyboard_status', false);
    const merges = report('agent_storyboard_status').merges;
    // Only sb-1 collides; sb-2 exists under one spelling and is a plain
    // rewrite, not a merge — the scope is (agent_url, storyboard_id).
    expect(merges).toHaveLength(1);
    expect(merges[0].winnerKey).toBe(PATHED);

    await run('agent_storyboard_status', true);

    const { rows } = await pool.query<{
      storyboard_id: string; status: string; steps_passed: number;
      first_failure_message: string | null;
    }>(
      `SELECT storyboard_id, status, steps_passed, first_failure_message
         FROM agent_storyboard_status WHERE agent_url = $1 ORDER BY storyboard_id`, [PATHED]);
    expect(rows).toEqual([
      // The whole winning run, not a splice of two.
      { storyboard_id: 'sb-1', status: 'passing', steps_passed: 4, first_failure_message: null },
      { storyboard_id: 'sb-2', status: 'passing', steps_passed: 2, first_failure_message: null },
    ]);
  });

  it('keeps the earliest discovery and the furthest expiry in discovered_agents', async () => {
    await pool.query(
      `INSERT INTO discovered_agents
         (agent_url, source_type, source_domain, discovered_at, last_validated, expires_at,
          probe_failure_count)
       VALUES ($1, 'adagents_json', $3, now() - interval '9 days', now() - interval '5 days',
               now() + interval '1 day', 4),
              ($2, 'adagents_json', $3, now() - interval '2 days', now(),
               now() + interval '30 days', 0)`,
      [`${ROOT}/`, ROOT, `root.${HOST}`],
    );

    await run('discovered_agents', true);

    const { rows } = await pool.query<{ agent_url: string; probe_failure_count: number }>(
      `SELECT agent_url, probe_failure_count FROM discovered_agents WHERE agent_url LIKE $1`,
      [`%${HOST}%`]);
    // A success against either spelling means the agent answered.
    expect(rows).toEqual([{ agent_url: ROOT, probe_failure_count: 0 }]);
    const { rows: dates } = await pool.query<{ early: boolean; far: boolean }>(
      `SELECT discovered_at < now() - interval '8 days' AS early,
              expires_at > now() + interval '29 days' AS far
         FROM discovered_agents WHERE agent_url = $1`, [ROOT]);
    expect(dates[0]).toEqual({ early: true, far: true });
  });

  it('is idempotent — a second run finds nothing left to fold', async () => {
    await pool.query(
      `INSERT INTO agent_health_snapshot (agent_url, online, checked_at)
       VALUES ($1, false, now() - interval '1 day'), ($2, true, now())`,
      [`${ROOT}/`, ROOT]);

    await run('agent_health_snapshot', true);
    logged.length = 0;
    await run('agent_health_snapshot', true);

    const second = report('agent_health_snapshot');
    expect(second.merges).toEqual([]);
    const { rows } = await pool.query<{ agent_url: string; online: boolean }>(
      `SELECT agent_url, online FROM agent_health_snapshot WHERE agent_url LIKE $1`,
      [`%${HOST}%`]);
    expect(rows).toEqual([{ agent_url: ROOT, online: true }]);
  });
});
