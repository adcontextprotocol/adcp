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
 *
 * Counting is bucketed by UTC day: the same rule shown to the same user
 * multiple times in one day counts once. Without this, a Slack user who
 * opens App Home and starts a few Assistant threads in a workday would
 * burn through the suppression threshold without ever consciously
 * reading the prompt.
 *
 * When shown_count crosses the suppression threshold (counted in days,
 * not impressions), sets suppressed_until to NOW() + suppressForDays.
 *
 * Fire-and-forget: callers don't await the result.
 */
export async function recordPromptsShown(
  workosUserId: string,
  ruleIds: string[],
  options: {
    /** Suppress the rule once it's been shown on this many distinct days. */
    suppressAfterShows?: number;
    /** How long to suppress for once the threshold is hit. */
    suppressForDays?: number;
  } = {},
): Promise<void> {
  if (!workosUserId || ruleIds.length === 0) return;
  const suppressAfterShows = options.suppressAfterShows ?? 5;
  const suppressForDays = options.suppressForDays ?? 30;

  try {
    // One bulk upsert via unnest — turns N rule writes into a single
    // round trip. The CASE expressions implement per-day bucketing:
    // shown_count only increments if last_shown_at is NULL or before
    // today (UTC). last_shown_at always advances so callers can tell
    // when the prompt was last surfaced.
    await query(
      `INSERT INTO addie_prompt_telemetry
         (workos_user_id, rule_id, shown_count, last_shown_at)
       SELECT $1, rule_id, 1, NOW()
       FROM unnest($2::text[]) AS rule_id
       ON CONFLICT (workos_user_id, rule_id) DO UPDATE SET
         shown_count = CASE
           WHEN addie_prompt_telemetry.last_shown_at IS NULL
             OR addie_prompt_telemetry.last_shown_at < CURRENT_DATE
           THEN addie_prompt_telemetry.shown_count + 1
           ELSE addie_prompt_telemetry.shown_count
         END,
         last_shown_at = NOW(),
         suppressed_until = CASE
           WHEN (addie_prompt_telemetry.last_shown_at IS NULL
             OR addie_prompt_telemetry.last_shown_at < CURRENT_DATE)
             AND addie_prompt_telemetry.shown_count + 1 >= $3
           THEN NOW() + make_interval(days => $4)
           ELSE addie_prompt_telemetry.suppressed_until
         END`,
      [workosUserId, ruleIds, suppressAfterShows, suppressForDays],
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
