/**
 * Addie suggested-prompts telemetry.
 *
 * Tracks how many times each rule has been shown to each user so the
 * evaluator can suppress rules that have been ignored. The actual
 * suppression decision is made in the application layer; this module
 * only persists the counters.
 */

import { query } from './client.js';
import { createLogger } from '../logger.js';

const logger = createLogger('addie-prompt-telemetry-db');

export interface PromptTelemetryRow {
  rule_id: string;
  shown_count: number;
  last_shown_at: Date | null;
  suppressed_until: Date | null;
}

/**
 * Read all telemetry rows for a single user. Returned as a map keyed by
 * rule_id for cheap lookup in the evaluator.
 */
export async function getTelemetryForUser(
  workosUserId: string,
): Promise<Map<string, PromptTelemetryRow>> {
  const result = await query<PromptTelemetryRow>(
    `SELECT rule_id, shown_count, last_shown_at, suppressed_until
       FROM addie_prompt_telemetry
       WHERE workos_user_id = $1`,
    [workosUserId],
  );
  const map = new Map<string, PromptTelemetryRow>();
  for (const row of result.rows) {
    map.set(row.rule_id, {
      rule_id: row.rule_id,
      shown_count: Number(row.shown_count),
      last_shown_at: row.last_shown_at ? new Date(row.last_shown_at) : null,
      suppressed_until: row.suppressed_until ? new Date(row.suppressed_until) : null,
    });
  }
  return map;
}

/**
 * Increment shown_count for a batch of rules just shown to the user.
 * Sets last_shown_at to NOW(). When shown_count crosses the suppression
 * threshold, sets suppressed_until.
 *
 * Fire-and-forget: callers don't await the result.
 */
export async function recordPromptsShown(
  workosUserId: string,
  ruleIds: string[],
  options: {
    /** Suppress the rule once it's been shown this many times. */
    suppressAfterShows?: number;
    /** How long to suppress for once the threshold is hit. */
    suppressForDays?: number;
  } = {},
): Promise<void> {
  if (!workosUserId || ruleIds.length === 0) return;
  const suppressAfterShows = options.suppressAfterShows ?? 5;
  const suppressForDays = options.suppressForDays ?? 30;

  try {
    // Upsert each rule's row. We don't bulk-insert because the suppression
    // calc needs the prior shown_count to decide whether to set
    // suppressed_until on this write.
    await Promise.all(
      ruleIds.map((ruleId) =>
        query(
          `INSERT INTO addie_prompt_telemetry
             (workos_user_id, rule_id, shown_count, last_shown_at)
           VALUES ($1, $2, 1, NOW())
           ON CONFLICT (workos_user_id, rule_id) DO UPDATE SET
             shown_count = addie_prompt_telemetry.shown_count + 1,
             last_shown_at = NOW(),
             suppressed_until = CASE
               WHEN addie_prompt_telemetry.shown_count + 1 >= $3
                 THEN NOW() + ($4 || ' days')::interval
               ELSE addie_prompt_telemetry.suppressed_until
             END`,
          [workosUserId, ruleId, suppressAfterShows, String(suppressForDays)],
        ),
      ),
    );
  } catch (error) {
    logger.warn({ error, workosUserId, ruleIds }, 'Failed to record prompt telemetry');
  }
}

/**
 * Reset telemetry for a user — used by tests and for admin debugging.
 */
export async function resetTelemetryForUser(workosUserId: string): Promise<void> {
  await query(`DELETE FROM addie_prompt_telemetry WHERE workos_user_id = $1`, [
    workosUserId,
  ]);
}
