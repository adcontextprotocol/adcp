/**
 * Diagnose why a specific agent URL isn't being picked up by the
 * compliance-heartbeat queue. Uses the same selector as the heartbeat so
 * the position and due count match what the worker would see.
 *
 * Reports:
 *   - Whether the URL has a discovery record, owner listing, active badge,
 *     or registry metadata row (the metadata row alone is not eligibility)
 *   - Registry metadata (lifecycle_stage, compliance_opt_out, monitoring_paused,
 *     check_interval_hours) — the three filters that exclude rows from the
 *     heartbeat
 *   - Current `agent_compliance_status` row
 *   - The agent's position in the next heartbeat batch
 *
 * Optionally requeues an eligible agent ahead of regular checks.
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
import { ComplianceDatabase } from '../db/compliance-db.js';

const args = process.argv.slice(2);
const agentUrl = args.find(a => !a.startsWith('--')) ?? '';
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
  const complianceDb = new ComplianceDatabase();

  console.log(`\nDiagnosing: ${agentUrl}`);
  console.log('='.repeat(80));

  // 1) Union-source presence
  const sources = await pool.query<{ src: string; agent_url: string }>(
    `SELECT 'discovered_agents record' AS src, agent_url FROM discovered_agents WHERE agent_url = $1
     UNION ALL
     SELECT 'fresh publisher authorization', d.agent_url
       FROM discovered_agents d
       WHERE d.agent_url = $1
         AND (d.expires_at IS NULL OR d.expires_at > NOW())
         AND EXISTS (
           SELECT 1 FROM agent_publisher_authorizations auth
           WHERE auth.agent_url = d.agent_url
             AND auth.source IN ('adagents_json', 'aao_hosted')
             AND GREATEST(auth.discovered_at, auth.last_validated) >= NOW() - INTERVAL '30 days'
         )
     UNION ALL
     SELECT 'agent_registry_metadata (settings)', agent_url FROM agent_registry_metadata WHERE agent_url = $1
     UNION ALL
     SELECT 'member_profiles.agents', a->>'url'
       FROM member_profiles, jsonb_array_elements(agents) a
       WHERE a->>'url' = $1
     UNION ALL
     SELECT DISTINCT 'active/degraded badge', agent_url
       FROM agent_verification_badges
       WHERE agent_url = $1 AND status IN ('active', 'degraded')`,
    [agentUrl],
  );
  console.log('\n[1] Stored records (metadata alone does not make an agent eligible):');
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
    next_compliance_check_at: Date | null;
    compliance_inconclusive_streak: number;
  }>(
    `SELECT lifecycle_stage, compliance_opt_out, monitoring_paused,
            check_interval_hours, monitoring_paused_at, next_compliance_check_at,
            compliance_inconclusive_streak
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
    const interval = m.check_interval_hours ?? 12;
    console.log(`   lifecycle_stage:      ${lifecycle}${['production','testing'].includes(lifecycle) ? '' : ' ✗ excluded (heartbeat only checks production/testing)'}`);
    console.log(`   compliance_opt_out:   ${optOut}${optOut ? ' ✗ excluded' : ''}`);
    console.log(`   monitoring_paused:    ${paused}${paused ? ` ✗ excluded (since ${m.monitoring_paused_at})` : ''}`);
    console.log(`   check_interval_hours: ${interval}`);
    console.log(`   next_check_at:         ${m.next_compliance_check_at?.toISOString() ?? '(due)'}`);
    console.log(`   inconclusive_streak:   ${m.compliance_inconclusive_streak}`);
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
  const dueQueue = await complianceDb.getAgentsDueForCheck(1_000_000);
  const position = dueQueue.findIndex(row => row.agent_url === agentUrl);
  if (position < 0) {
    console.log('   ✗ NOT in due queue (check source freshness, badge, metadata, and schedule)');
  } else {
    console.log(`   position: ${position + 1} (batch size = 10 per heartbeat run)`);
    console.log('   Actual pickup depends on earlier runs and available capacity.');
  }
  console.log(`   total due queue:          ${dueQueue[0]?.eligible_backlog ?? 0}`);

  // 5) Requeue (optional)
  if (requeue) {
    console.log('\n[5] Requeueing (--requeue flag set):');
    await complianceDb.requeueForHeartbeat(agentUrl);
    console.log('   ✓ cleared scheduling delay and backoff; eligible agents are prioritized at a future heartbeat');
  } else {
    console.log('\n[5] Rerun with --requeue to clear the scheduling delay for an eligible agent');
  }

  console.log('');
  await closeDatabase();
}

main().catch((err) => {
  console.error('Diagnostic failed:', err);
  process.exit(1);
});
