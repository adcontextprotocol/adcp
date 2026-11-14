/**
 * Ownership tracking for compliance heartbeat batch claims.
 *
 * The heartbeat claims every agent in a batch up front by setting
 * compliance_lock_until to the worst-case batch duration. The cadence in
 * next_compliance_check_at is never touched by a claim (#7693). Each claim
 * records which process holds it and when that agent's suite actually started,
 * so a later run can tell an agent that was merely waiting in a dead worker's
 * batch (released immediately) from the agent that was running when the worker
 * died (backed off, and isolated in its next batch).
 *
 * The lock is cleared by whichever path records the agent's outcome (a
 * published heartbeat run or a deferral). A path that records nothing keeps
 * the lock until it expires, so an unexplained failure cannot re-run the same
 * agent on the next tick.
 */

import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { query } from '../../db/client.js';
import type { HeartbeatSkipReason } from '../../db/compliance-db.js';
import { logger as baseLogger } from '../../logger.js';

const logger = baseLogger.child({ module: 'compliance-heartbeat' });

/** Orphan streak at which a repeatedly fatal agent is escalated to #admin-errors. */
const ORPHAN_STREAK_ESCALATION_THRESHOLD = 3;
const ORPHAN_BACKOFF_BASE_MINUTES = 30;
const ORPHAN_BACKOFF_CAP_HOURS = 48;
/** 30 minutes * 2^8 is already past the cap; bounding the exponent keeps the interval arithmetic finite. */
const ORPHAN_BACKOFF_MAX_EXPONENT = 8;
/** Recorded as the attempt's skip reason when the worker died while the agent's suite was running. */
const WORKER_DIED_SKIP_REASON: HeartbeatSkipReason = 'worker_died';

export interface HeartbeatProcessIdentity {
  /** Machine the process runs on; stable across restarts of the same machine. */
  machineId: string;
  /** Unique per process: `${machineId}:${uuid}`. */
  owner: string;
}

export function createHeartbeatProcessIdentity(
  machineId: string = process.env.FLY_MACHINE_ID ?? hostname(),
): HeartbeatProcessIdentity {
  return { machineId, owner: `${machineId}:${randomUUID()}` };
}

export interface OrphanedHeartbeatClaim {
  agentUrl: string;
  /** True when the dead process had started this agent's suite. */
  suiteStarted: boolean;
  orphanStreak: number;
}

/**
 * Release claims left behind by dead processes, before the due-agent query runs.
 *
 * A claim is orphaned when another process owns it and either that process ran
 * on this machine (so it cannot still be alive after a restart) or the claim's
 * lock has already expired. Unstarted claims are released with no penalty. A
 * started claim means the process died while this agent's suite was running:
 * the agent's orphan streak grows and it is quarantined behind an
 * exponentially growing lock, so a poison-pill agent cannot crash the worker
 * every few minutes. The quarantine is a lock rather than a schedule, so the
 * agent's cadence still says when it was really due.
 */
export async function reconcileOrphanedHeartbeatClaims(
  identity: HeartbeatProcessIdentity,
): Promise<OrphanedHeartbeatClaim[]> {
  const result = await query<{ agent_url: string; suite_started: boolean; heartbeat_orphan_streak: number }>(
    `WITH orphaned AS (
       SELECT agent_url, heartbeat_started_at IS NOT NULL AS suite_started
       FROM agent_registry_metadata
       WHERE heartbeat_claim_owner IS NOT NULL
         AND heartbeat_claim_owner <> $1
         AND (starts_with(heartbeat_claim_owner, $2) OR compliance_lock_until < NOW())
       FOR UPDATE
     )
     UPDATE agent_registry_metadata m
     SET heartbeat_orphan_streak = m.heartbeat_orphan_streak + CASE WHEN o.suite_started THEN 1 ELSE 0 END,
         compliance_lock_until = CASE WHEN o.suite_started
           THEN NOW() + LEAST(
             make_interval(hours => ${ORPHAN_BACKOFF_CAP_HOURS}),
             make_interval(mins => ${ORPHAN_BACKOFF_BASE_MINUTES})
               * POWER(2, LEAST(m.heartbeat_orphan_streak, ${ORPHAN_BACKOFF_MAX_EXPONENT}))
           )
           ELSE NULL END,
         last_heartbeat_attempt_at = CASE WHEN o.suite_started THEN NOW() ELSE m.last_heartbeat_attempt_at END,
         last_heartbeat_skip_reason = CASE WHEN o.suite_started THEN $3 ELSE m.last_heartbeat_skip_reason END,
         heartbeat_claim_owner = NULL,
         heartbeat_started_at = NULL
     FROM orphaned o
     WHERE m.agent_url = o.agent_url
     RETURNING m.agent_url, o.suite_started, m.heartbeat_orphan_streak`,
    [identity.owner, `${identity.machineId}:`, WORKER_DIED_SKIP_REASON],
  );

  const orphaned = result.rows.map(row => ({
    agentUrl: row.agent_url,
    suiteStarted: row.suite_started,
    orphanStreak: row.heartbeat_orphan_streak,
  }));

  for (const claim of orphaned) {
    if (!claim.suiteStarted) {
      logger.info(
        { agentUrl: claim.agentUrl },
        'Released compliance heartbeat claim orphaned before the agent suite started',
      );
    } else if (claim.orphanStreak >= ORPHAN_STREAK_ESCALATION_THRESHOLD) {
      logger.error(
        { agentUrl: claim.agentUrl, orphanStreak: claim.orphanStreak },
        'Compliance heartbeat agent suite repeatedly ended with the worker process dying',
      );
    } else {
      logger.warn(
        { agentUrl: claim.agentUrl, orphanStreak: claim.orphanStreak },
        'Compliance heartbeat agent suite ended with the worker process dying; backing off the agent',
      );
    }
  }
  return orphaned;
}

/**
 * Claim due agents for this process. Returns the URLs actually claimed.
 *
 * Re-checks both the lock and the cadence: another worker may have claimed or
 * finished an agent between selection and this claim.
 */
export async function claimHeartbeatAgents(
  agentUrls: string[],
  lockUntil: Date,
  owner: string,
): Promise<Set<string>> {
  if (agentUrls.length === 0) return new Set();
  const claimed = await query<{ agent_url: string }>(
    `INSERT INTO agent_registry_metadata (agent_url, compliance_lock_until, heartbeat_claim_owner, heartbeat_started_at)
     SELECT unnest($1::text[]), $2::timestamptz, $3, NULL
     ON CONFLICT (agent_url) DO UPDATE SET
       compliance_lock_until = EXCLUDED.compliance_lock_until,
       heartbeat_claim_owner = EXCLUDED.heartbeat_claim_owner,
       heartbeat_started_at = NULL
     WHERE (agent_registry_metadata.compliance_lock_until IS NULL
         OR agent_registry_metadata.compliance_lock_until < NOW())
       AND (agent_registry_metadata.next_compliance_check_at IS NULL
         OR agent_registry_metadata.next_compliance_check_at < NOW())
     RETURNING agent_url`,
    [agentUrls, lockUntil, owner],
  );
  return new Set(claimed.rows.map(row => row.agent_url));
}

/** Record that this agent's suite is now running under this process's claim. */
export async function markHeartbeatSuiteStarted(agentUrl: string, owner: string): Promise<void> {
  await query(
    `UPDATE agent_registry_metadata
     SET heartbeat_started_at = NOW()
     WHERE agent_url = $1 AND heartbeat_claim_owner = $2`,
    [agentUrl, owner],
  );
}

/**
 * Release this process's claim on one agent. A started suite that reaches this
 * point means the process survived the agent, so its orphan streak resets.
 * The lock and the cadence are left to whichever path recorded the agent's
 * outcome; when none did, the lock stays until it expires.
 */
export async function releaseHeartbeatClaim(agentUrl: string, owner: string): Promise<void> {
  await query(
    `UPDATE agent_registry_metadata
     SET heartbeat_orphan_streak = CASE WHEN heartbeat_started_at IS NOT NULL THEN 0 ELSE heartbeat_orphan_streak END,
         heartbeat_claim_owner = NULL,
         heartbeat_started_at = NULL
     WHERE agent_url = $1 AND heartbeat_claim_owner = $2`,
    [agentUrl, owner],
  );
}

/**
 * Release agents this batch claimed but never started, making them eligible on
 * the next tick instead of waiting out the batch lock. Their cadence is kept:
 * they were due when claimed.
 */
export async function releaseUnstartedHeartbeatClaims(agentUrls: string[], owner: string): Promise<number> {
  if (agentUrls.length === 0) return 0;
  const released = await query(
    `UPDATE agent_registry_metadata
     SET heartbeat_claim_owner = NULL,
         compliance_lock_until = NULL
     WHERE agent_url = ANY($1::text[])
       AND heartbeat_claim_owner = $2
       AND heartbeat_started_at IS NULL`,
    [agentUrls, owner],
  );
  return released.rowCount ?? 0;
}

/**
 * Keep a previously fatal agent from sharing a batch, so a further crash is
 * attributable to it alone. A suspect at the head of the selection runs by
 * itself; a suspect further down truncates the batch before it.
 */
export function isolateSuspectAgents<T extends { heartbeat_orphan_streak: number }>(selected: T[]): T[] {
  if (selected.length === 0) return selected;
  if (selected[0].heartbeat_orphan_streak > 0) return [selected[0]];
  const firstSuspect = selected.findIndex(agent => agent.heartbeat_orphan_streak > 0);
  return firstSuspect < 0 ? selected : selected.slice(0, firstSuspect);
}
