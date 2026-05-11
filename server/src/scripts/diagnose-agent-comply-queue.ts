/**
 * Diagnose why a specific agent URL isn't being picked up by the
 * compliance-heartbeat queue. Mirrors the logic in
 * `db/compliance-db.ts:getAgentsDueForCheck` so the output matches what
 * the heartbeat would see.
 *
 * Reports:
 *   - Whether the URL appears in each of the three union sources
 *     (`discovered_agents`, `agent_registry_metadata`, `member_profiles.agents`)
 *   - Registry metadata (lifecycle_stage, compliance_opt_out, monitoring_paused,
 *     check_interval_hours) — the three filters that exclude rows from the
 *     heartbeat
 *   - Current `agent_compliance_status` row
 *   - The agent's position in the next heartbeat batch
 *
 * Optionally requeues the agent by clearing its `last_checked_at` so the
 * next heartbeat tick picks it up first.
 *
 * Usage (dev):
 *   npx tsx server/src/scripts/diagnose-agent-comply-queue.ts <agent-url>
 *   npx tsx server/src/scripts/diagnose-agent-comply-queue.ts <agent-url> --requeue
 *
 * Usage (prod):
 *   fly ssh console -a adcp-docs -C 'node /app/dist/scripts/diagnose-agent-comply-queue.js <agent-url>'
 *   fly ssh console -a adcp-docs -C 'node /app/dist/scripts/diagnose-agent-comply-queue.js <agent-url> --requeue'
 */

import { initializeDatabase, getPool, closeDatabase } from '../db/client.js';
import { getDatabaseConfig } from '../config.js';

const args = process.argv.slice(2);
const agentUrl = args.find(a => !a.startsWith('--'));
const requeue = args.includes('--requeue');

if (!agentUrl) {
  console.error('Usage: diagnose-agent-comply-queue.ts <agent-url> [--requeue]');
  process.exit(1);
}

async function main(): Promise<void> {
  const dbConfig = getDatabaseConfig();
  if (!dbConfig) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }
  initializeDatabase(dbConfig);
  const pool = getPool();

  console.log(`\nDiagnosing: ${agentUrl}`);
  console.log('='.repeat(80));

  // 1) Union-source presence
  const sources = await pool.query<{ src: string; agent_url: string }>(
    `SELECT 'discovered_agents' AS src, agent_url FROM discovered_agents WHERE agent_url = $1
     UNION ALL
     SELECT 'agent_registry_metadata', agent_url FROM agent_registry_metadata WHERE agent_url = $1
     UNION ALL
     SELECT 'member_profiles.agents', a->>'url'
       FROM member_profiles, jsonb_array_elements(agents) a
       WHERE a->>'url' = $1`,
    [agentUrl],
  );
  console.log('\n[1] Union-source presence (heartbeat reads from any of these):');
  if (sources.rows.length === 0) {
    console.log('   ✗ NOT FOUND in any source — heartbeat cannot see this agent');
  } else {
    for (const row of sources.rows) console.log(`   ✓ ${row.src}`);
  }

  // 2) Metadata filters
  const meta = await pool.query<{
    lifecycle_stage: string | null;
    compliance_opt_out: boolean | null;
    monitoring_paused: boolean | null;
    check_interval_hours: number | null;
    monitoring_paused_at: Date | null;
  }>(
    `SELECT lifecycle_stage, compliance_opt_out, monitoring_paused,
            check_interval_hours, monitoring_paused_at
       FROM agent_registry_metadata WHERE agent_url = $1`,
    [agentUrl],
  );
  console.log('\n[2] Registry metadata (filters):');
  if (meta.rows.length === 0) {
    console.log('   (no row — defaults: lifecycle=production, opt_out=false, paused=false, interval=12h)');
  } else {
    const m = meta.rows[0];
    const lifecycle = m.lifecycle_stage ?? 'production';
    const optOut = m.compliance_opt_out ?? false;
    const paused = m.monitoring_paused ?? false;
    const interval = m.check_interval_hours ?? (lifecycle === 'testing' ? 24 : 12);
    console.log(`   lifecycle_stage:      ${lifecycle}${['production','testing'].includes(lifecycle) ? '' : ' ✗ excluded (heartbeat only checks production/testing)'}`);
    console.log(`   compliance_opt_out:   ${optOut}${optOut ? ' ✗ excluded' : ''}`);
    console.log(`   monitoring_paused:    ${paused}${paused ? ` ✗ excluded (since ${m.monitoring_paused_at})` : ''}`);
    console.log(`   check_interval_hours: ${interval}`);
  }

  // 3) Current status
  const status = await pool.query<{
    agent_url: string;
    status: string;
    last_checked_at: Date | null;
  }>(
    `SELECT agent_url, status, last_checked_at
       FROM agent_compliance_status WHERE agent_url = $1`,
    [agentUrl],
  );
  console.log('\n[3] agent_compliance_status:');
  if (status.rows.length === 0) {
    console.log('   (no row — will be created on first heartbeat run)');
  } else {
    const s = status.rows[0];
    const lc = s.last_checked_at ? new Date(s.last_checked_at) : null;
    const ageHours = lc ? Math.round((Date.now() - lc.getTime()) / 3_600_000) : null;
    console.log(`   status:          ${s.status}`);
    console.log(`   last_checked_at: ${lc?.toISOString() ?? '(null)'}${ageHours !== null ? ` (${ageHours}h ago)` : ''}`);
  }

  // 4) Position in next heartbeat batch
  console.log('\n[4] Next heartbeat batch position:');
  const positionResult = await pool.query<{
    agent_url: string;
    last_checked_at: Date | null;
    position: number;
  }>(
    `WITH known_agents AS (
       SELECT agent_url FROM discovered_agents
       UNION
       SELECT agent_url FROM agent_registry_metadata
       UNION
       SELECT (a->>'url') AS agent_url
         FROM member_profiles, jsonb_array_elements(agents) a
         WHERE a->>'url' IS NOT NULL
     ),
     due_queue AS (
       SELECT
         ka.agent_url,
         s.last_checked_at,
         ROW_NUMBER() OVER (ORDER BY s.last_checked_at ASC NULLS FIRST, ka.agent_url ASC) AS position
       FROM known_agents ka
       LEFT JOIN agent_registry_metadata m ON m.agent_url = ka.agent_url
       LEFT JOIN agent_compliance_status s ON s.agent_url = ka.agent_url
       WHERE
         COALESCE(m.lifecycle_stage, 'production') IN ('production', 'testing')
         AND COALESCE(m.compliance_opt_out, FALSE) = FALSE
         AND COALESCE(m.monitoring_paused, FALSE) = FALSE
         AND (
           s.last_checked_at IS NULL
           OR s.last_checked_at < NOW() - make_interval(hours => COALESCE(m.check_interval_hours,
             CASE WHEN COALESCE(m.lifecycle_stage, 'production') = 'testing' THEN 24 ELSE 12 END
           ))
         )
     )
     SELECT agent_url, last_checked_at, position FROM due_queue WHERE agent_url = $1`,
    [agentUrl],
  );
  if (positionResult.rows.length === 0) {
    console.log('   ✗ NOT in due queue (filtered out by metadata or not due yet)');
  } else {
    const p = positionResult.rows[0];
    console.log(`   position: ${p.position} (batch size = 10 per heartbeat tick)`);
    const ticks = Math.ceil(p.position / 10);
    console.log(`   estimated ticks until pickup: ${ticks} (~${ticks}h)`);
  }

  // Total queue length for context
  const queueLen = await pool.query<{ total: string }>(
    `WITH known_agents AS (
       SELECT agent_url FROM discovered_agents
       UNION
       SELECT agent_url FROM agent_registry_metadata
       UNION
       SELECT (a->>'url') AS agent_url
         FROM member_profiles, jsonb_array_elements(agents) a
         WHERE a->>'url' IS NOT NULL
     )
     SELECT COUNT(*)::text AS total
       FROM known_agents ka
       LEFT JOIN agent_registry_metadata m ON m.agent_url = ka.agent_url
       LEFT JOIN agent_compliance_status s ON s.agent_url = ka.agent_url
       WHERE
         COALESCE(m.lifecycle_stage, 'production') IN ('production', 'testing')
         AND COALESCE(m.compliance_opt_out, FALSE) = FALSE
         AND COALESCE(m.monitoring_paused, FALSE) = FALSE
         AND (
           s.last_checked_at IS NULL
           OR s.last_checked_at < NOW() - make_interval(hours => COALESCE(m.check_interval_hours,
             CASE WHEN COALESCE(m.lifecycle_stage, 'production') = 'testing' THEN 24 ELSE 12 END
           ))
         )`,
  );
  console.log(`   total due queue:          ${queueLen.rows[0].total}`);

  // 5) Requeue (optional)
  if (requeue) {
    console.log('\n[5] Requeueing (--requeue flag set):');
    const result = await pool.query(
      `UPDATE agent_compliance_status SET last_checked_at = NULL WHERE agent_url = $1`,
      [agentUrl],
    );
    if (result.rowCount === 0) {
      console.log('   (no agent_compliance_status row to update — will be created on next run)');
    } else {
      console.log(`   ✓ cleared last_checked_at — agent will be picked up next heartbeat tick`);
    }
  } else {
    console.log('\n[5] Rerun with --requeue to clear last_checked_at and force pickup on next tick');
  }

  console.log('');
  await closeDatabase();
}

main().catch((err) => {
  console.error('Diagnostic failed:', err);
  process.exit(1);
});
