/**
 * One-shot re-probe of every agent currently classified as `unknown`.
 *
 * 77% of agents in the public registry render `type: 'unknown'` (issue #3551,
 * Problem 2 in #3538). Before designing the full retry-with-backoff system,
 * we run this script once to learn whether `unknown` is mostly transient
 * (timeouts/network) or mostly dead (NXDOMAIN, connect-refused). The output
 * tells us how to scope the full Problem 2 PR.
 *
 * What it does:
 *   1. Selects every agent where `agent_capabilities_snapshot.inferred_type`
 *      is NULL or the snapshot row is missing entirely.
 *   2. Re-probes each agent with a 30s timeout (vs the crawler's 10s) using
 *      the existing `CapabilityDiscovery.discoverCapabilities` helper — same
 *      probe path the live crawler uses, no parallel implementation.
 *   3. Writes the new snapshot via `AgentSnapshotDatabase.upsertCapabilities`
 *      — same write path as the crawler.
 *   4. Reports a per-type tally + sample of still-unknown URLs.
 *
 * Idempotent: a real run skips agents that have since become classified.
 * `--dry-run` mode probes everything but writes nothing.
 *
 * Note on member_profiles propagation: PR #3541 will export
 * `resolveAgentTypes` from `server/src/routes/member-profiles.ts` so this
 * script can refresh `member_profiles.agents[]` after each agent. As of this
 * branch, that export does not exist on `main`. The script logs a warning
 * and skips that step; once #3541 lands, the dynamic import below resolves
 * and the propagation runs automatically.
 *
 * Usage:
 *   DATABASE_URL=... npx tsx server/scripts/reprobe-unknown-agents.ts --dry-run
 *   DATABASE_URL=... npx tsx server/scripts/reprobe-unknown-agents.ts
 */

import { initializeDatabase, closeDatabase, query } from '../src/db/client.js';
import { AgentSnapshotDatabase } from '../src/db/agent-snapshot-db.js';
import { CapabilityDiscovery } from '../src/capabilities.js';
import type { Agent } from '../src/types.js';

const PROBE_TIMEOUT_MS = 30_000;
const CONCURRENCY = 5;
const STILL_UNKNOWN_SAMPLE = 10;

export type InferredType = 'sales' | 'creative' | 'signals' | 'unknown';

export interface AgentToProbe {
  url: string;
  protocol: 'mcp' | 'a2a';
  name: string;
  hadSnapshot: boolean;
}

export interface ReprobeReport {
  scanned: number;
  newly_classified: { sales: number; creative: number; signals: number; buying: number };
  still_unknown: number;
  still_unknown_sample: string[];
  probe_failed: number;
  dns_failed: number;
  skipped_already_classified: number;
  elapsed_ms: number;
  dry_run: boolean;
}

/** Shape of a single probe outcome — exposed for tests. */
export interface ProbeOutcome {
  url: string;
  inferred: InferredType | null;
  classification: 'classified' | 'still_unknown' | 'probe_failed' | 'dns_failed';
}

/**
 * Pure aggregator. Folds a stream of probe outcomes into a report. Pulled
 * out so the test can pin the report-shape contract without touching the DB
 * or network. The script's main loop calls this with the live outcomes.
 */
export function aggregateOutcomes(
  outcomes: ProbeOutcome[],
  options: { scanned: number; skipped: number; elapsedMs: number; dryRun: boolean },
): ReprobeReport {
  const newly_classified = { sales: 0, creative: 0, signals: 0, buying: 0 };
  const still_unknown_sample: string[] = [];
  let still_unknown = 0;
  let probe_failed = 0;
  let dns_failed = 0;

  for (const o of outcomes) {
    switch (o.classification) {
      case 'classified':
        if (o.inferred === 'sales') newly_classified.sales++;
        else if (o.inferred === 'creative') newly_classified.creative++;
        else if (o.inferred === 'signals') newly_classified.signals++;
        // 'buying' is reserved for future probe paths — never returned today,
        // but the report key is part of the contract for consumers.
        break;
      case 'still_unknown':
        still_unknown++;
        if (still_unknown_sample.length < STILL_UNKNOWN_SAMPLE) {
          still_unknown_sample.push(o.url);
        }
        break;
      case 'probe_failed':
        probe_failed++;
        break;
      case 'dns_failed':
        dns_failed++;
        break;
    }
  }

  return {
    scanned: options.scanned,
    newly_classified,
    still_unknown,
    still_unknown_sample,
    probe_failed,
    dns_failed,
    skipped_already_classified: options.skipped,
    elapsed_ms: options.elapsedMs,
    dry_run: options.dryRun,
  };
}

/**
 * Heuristic — match Node's DNS / connect-refused error shapes. We classify
 * those as `dns_failed` to separate "agent host is gone" from "agent host is
 * up but refused / timed out the probe" (which goes into `probe_failed`).
 */
export function isDnsOrConnectFailure(errMsg: string | undefined | null): boolean {
  if (!errMsg) return false;
  const m = errMsg.toUpperCase();
  return (
    m.includes('ENOTFOUND') ||
    m.includes('EAI_AGAIN') ||
    m.includes('NXDOMAIN') ||
    m.includes('ECONNREFUSED') ||
    m.includes('EHOSTUNREACH') ||
    m.includes('ENETUNREACH')
  );
}

/**
 * Select every agent we should re-probe.
 *
 * Two source sets unioned:
 *   A) `agent_capabilities_snapshot` rows where `inferred_type IS NULL` —
 *      probed but unclassified. These are the "stuck on unknown" rows.
 *   B) `member_profiles.agents[]` and `discovered_agents` URLs that have NO
 *      snapshot row at all — never been probed.
 *
 * In `--dry-run` we always include set A; in a real run the second pass of
 * the script would naturally see fewer set-A rows because the first pass
 * upserted real types for the ones it could classify (idempotency).
 */
async function selectAgentsToProbe(): Promise<AgentToProbe[]> {
  // (A) Snapshots with NULL inferred_type — reuse the snapshot's known protocol.
  const stuckResult = await query<{
    agent_url: string;
    protocol: 'mcp' | 'a2a' | null;
  }>(
    `SELECT agent_url, protocol
       FROM agent_capabilities_snapshot
      WHERE inferred_type IS NULL`,
  );

  // (B) Registered + discovered agents that have no snapshot row at all.
  // We pull URLs from both sources and exclude ones that already appear in
  // the snapshot table (regardless of inferred_type — set A handles those).
  const missingResult = await query<{ url: string; protocol: string | null; name: string | null }>(
    `WITH known AS (
        SELECT agent_url FROM agent_capabilities_snapshot
      ),
      registered AS (
        SELECT DISTINCT
               (a->>'url')        AS url,
               'mcp'::text        AS protocol,
               (a->>'name')       AS name
          FROM member_profiles mp,
               LATERAL jsonb_array_elements(COALESCE(mp.agents, '[]'::jsonb)) AS a
         WHERE a->>'url' IS NOT NULL
      ),
      discovered AS (
        SELECT da.agent_url AS url,
               da.protocol  AS protocol,
               da.name      AS name
          FROM discovered_agents da
      )
      SELECT url, protocol, name FROM registered
       WHERE url NOT IN (SELECT agent_url FROM known)
      UNION
      SELECT url, protocol, name FROM discovered
       WHERE url NOT IN (SELECT agent_url FROM known)`,
  );

  const seen = new Set<string>();
  const out: AgentToProbe[] = [];

  for (const row of stuckResult.rows) {
    if (seen.has(row.agent_url)) continue;
    seen.add(row.agent_url);
    out.push({
      url: row.agent_url,
      protocol: row.protocol === 'a2a' ? 'a2a' : 'mcp',
      name: row.agent_url,
      hadSnapshot: true,
    });
  }
  for (const row of missingResult.rows) {
    if (seen.has(row.url)) continue;
    seen.add(row.url);
    out.push({
      url: row.url,
      protocol: row.protocol === 'a2a' ? 'a2a' : 'mcp',
      name: row.name || row.url,
      hadSnapshot: false,
    });
  }

  return out;
}

/**
 * Probe a single agent with the extended 30s timeout. Reuses the live
 * crawler's `discoverCapabilities` so the type-inference logic is identical.
 * Classifies the result for the report aggregator.
 */
async function probeOne(
  agent: AgentToProbe,
  capabilityDiscovery: CapabilityDiscovery,
  snapshotDb: AgentSnapshotDatabase,
  dryRun: boolean,
): Promise<ProbeOutcome> {
  const probeAgent: Agent = {
    name: agent.name,
    url: agent.url,
    type: 'unknown',
    protocol: agent.protocol,
    description: '',
    mcp_endpoint: agent.url,
    contact: { name: '', email: '', website: '' },
    added_date: new Date().toISOString().split('T')[0],
  };

  let profile;
  try {
    profile = await Promise.race([
      capabilityDiscovery.discoverCapabilities(probeAgent),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Probe timeout')), PROBE_TIMEOUT_MS),
      ),
    ]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      url: agent.url,
      inferred: null,
      classification: isDnsOrConnectFailure(msg) ? 'dns_failed' : 'probe_failed',
    };
  }

  const inferred = capabilityDiscovery.inferTypeFromProfile(profile);

  if (!dryRun) {
    await snapshotDb.upsertCapabilities(profile, inferred === 'unknown' ? null : inferred);
  }

  if (inferred !== 'unknown') {
    return { url: agent.url, inferred, classification: 'classified' };
  }

  // Probe completed but returned no classifiable type. If the helper recorded
  // a discovery_error, that's a soft probe failure (HTTP 5xx, OAuth wall,
  // malformed tools list). DNS-shaped errors stay in `dns_failed`; everything
  // else lands in `probe_failed` so we can scope the retry strategy.
  if (profile.discovery_error) {
    return {
      url: agent.url,
      inferred: null,
      classification: isDnsOrConnectFailure(profile.discovery_error) ? 'dns_failed' : 'probe_failed',
    };
  }

  return { url: agent.url, inferred: null, classification: 'still_unknown' };
}

function formatReport(report: ReprobeReport): string {
  const lines: string[] = [];
  lines.push('');
  lines.push(`Mode:                          ${report.dry_run ? 'DRY RUN (no writes)' : 'WRITE'}`);
  lines.push(`Agents scanned:                ${report.scanned}`);
  lines.push(`Skipped (already classified):  ${report.skipped_already_classified}`);
  lines.push(`Newly classified — sales:      ${report.newly_classified.sales}`);
  lines.push(`Newly classified — creative:   ${report.newly_classified.creative}`);
  lines.push(`Newly classified — signals:    ${report.newly_classified.signals}`);
  lines.push(`Newly classified — buying:     ${report.newly_classified.buying}`);
  lines.push(`Still unknown:                 ${report.still_unknown}`);
  lines.push(`Probe failed (HTTP/timeout):   ${report.probe_failed}`);
  lines.push(`DNS / connect refused:         ${report.dns_failed}`);
  lines.push(`Elapsed:                       ${(report.elapsed_ms / 1000).toFixed(1)}s`);
  if (report.still_unknown_sample.length > 0) {
    lines.push('');
    lines.push(`Still-unknown sample (first ${report.still_unknown_sample.length}):`);
    for (const url of report.still_unknown_sample) {
      lines.push(`  ${url}`);
    }
  }
  return lines.join('\n');
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');

  initializeDatabase({ connectionString: process.env.DATABASE_URL || '' });

  const snapshotDb = new AgentSnapshotDatabase();
  const capabilityDiscovery = new CapabilityDiscovery();

  // PR #3541 (export of resolveAgentTypes) has not landed on main yet.
  // We try the import dynamically; if it fails we skip the member_profiles
  // propagation step. See the file header for the upgrade path.
  let resolveAgentTypes: ((agents: unknown) => Promise<unknown>) | null = null;
  try {
    const mod: unknown = await import('../src/routes/member-profiles.js');
    const candidate = (mod as { resolveAgentTypes?: unknown }).resolveAgentTypes;
    if (typeof candidate === 'function') {
      resolveAgentTypes = candidate as (agents: unknown) => Promise<unknown>;
    }
  } catch {
    // intentional: dynamic import may be unavailable in some test envs
  }
  if (!resolveAgentTypes) {
    console.warn(
      '[warn] resolveAgentTypes not exported from member-profiles.ts — skipping ' +
        'member_profiles.agents[] refresh. Land #3541 to enable it.',
    );
  }

  console.log(`[reprobe] timeout=${PROBE_TIMEOUT_MS}ms concurrency=${CONCURRENCY} mode=${dryRun ? 'dry-run' : 'write'}`);

  const start = Date.now();
  const candidates = await selectAgentsToProbe();
  console.log(`[reprobe] candidates=${candidates.length}`);

  const outcomes: ProbeOutcome[] = [];
  let skipped = 0;

  for (let i = 0; i < candidates.length; i += CONCURRENCY) {
    const batch = candidates.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (agent) => {
        // Idempotency on real runs: a candidate from a previous pass may have
        // been classified by a parallel crawler tick between selection and
        // probe. Re-check the snapshot row and skip if it's now non-null.
        if (!dryRun && agent.hadSnapshot) {
          const snaps = await snapshotDb.bulkGetCapabilities([agent.url]);
          const cur = snaps.get(agent.url);
          if (cur && cur.inferred_type) {
            skipped++;
            return null;
          }
        }
        return probeOne(agent, capabilityDiscovery, snapshotDb, dryRun);
      }),
    );

    for (let j = 0; j < results.length; j++) {
      const r = results[j];
      const agent = batch[j];
      if (r.status === 'fulfilled') {
        if (r.value !== null) outcomes.push(r.value);
      } else {
        const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
        outcomes.push({
          url: agent.url,
          inferred: null,
          classification: isDnsOrConnectFailure(msg) ? 'dns_failed' : 'probe_failed',
        });
      }
    }

    // Optional: refresh member_profiles.agents[] for newly-classified URLs.
    // Best-effort, keyed off the agent URLs that just changed type.
    if (!dryRun && resolveAgentTypes) {
      const flipped = new Set(
        outcomes
          .slice(-batch.length)
          .filter((o) => o.classification === 'classified')
          .map((o) => o.url),
      );
      if (flipped.size > 0) {
        try {
          const profiles = await query<{ id: string; agents: unknown }>(
            `SELECT id, agents
               FROM member_profiles
              WHERE EXISTS (
                      SELECT 1
                        FROM jsonb_array_elements(COALESCE(agents, '[]'::jsonb)) AS a
                       WHERE a->>'url' = ANY($1)
                    )`,
            [Array.from(flipped)],
          );
          for (const row of profiles.rows) {
            const next = await resolveAgentTypes(row.agents);
            await query(
              `UPDATE member_profiles SET agents = $1, updated_at = NOW() WHERE id = $2`,
              [JSON.stringify(next), row.id],
            );
          }
        } catch (err) {
          console.warn(
            `[warn] resolveAgentTypes propagation failed for batch: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
  }

  const report = aggregateOutcomes(outcomes, {
    scanned: candidates.length,
    skipped,
    elapsedMs: Date.now() - start,
    dryRun,
  });

  console.log(formatReport(report));
  console.log('\n' + JSON.stringify(report));

  await closeDatabase();
}

// Only execute when run directly (not when imported by tests).
const isDirectRun =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  process.argv[1].endsWith('reprobe-unknown-agents.ts');

if (isDirectRun) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
