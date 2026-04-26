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
  clicked_count: number;
  last_clicked_at: Date | null;
}

/**
 * Read all telemetry rows for a single user. Returned as a map keyed by
 * rule_id for cheap lookup in the evaluator.
 */
export async function getTelemetryForUser(
  workosUserId: string,
): Promise<Map<string, PromptTelemetryRow>> {
  const result = await query<PromptTelemetryRow>(
    `SELECT rule_id, shown_count, last_shown_at, suppressed_until,
            clicked_count, last_clicked_at
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
      clicked_count: Number(row.clicked_count ?? 0),
      last_clicked_at: row.last_clicked_at ? new Date(row.last_clicked_at) : null,
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
 * Record a click on a single rule. Increments clicked_count and sets
 * last_clicked_at. Also clears suppressed_until — a click is the user
 * acting on the prompt, so we should re-evaluate normally rather than
 * keep suppressing.
 *
 * clicked_count is bucketed by UTC day to match recordPromptsShown's
 * bucketing — without this, a user who clicks twice in one day would
 * push the rule's CTR above 100%. last_clicked_at always advances.
 *
 * Fire-and-forget: callers don't await the result.
 */
export async function recordPromptClicked(
  workosUserId: string,
  ruleId: string,
): Promise<void> {
  if (!workosUserId || !ruleId) return;
  try {
    await query(
      `INSERT INTO addie_prompt_telemetry
         (workos_user_id, rule_id, shown_count, last_shown_at,
          clicked_count, last_clicked_at)
       VALUES ($1, $2, 0, NULL, 1, NOW())
       ON CONFLICT (workos_user_id, rule_id) DO UPDATE SET
         clicked_count = CASE
           WHEN addie_prompt_telemetry.last_clicked_at IS NULL
             OR addie_prompt_telemetry.last_clicked_at < CURRENT_DATE
           THEN addie_prompt_telemetry.clicked_count + 1
           ELSE addie_prompt_telemetry.clicked_count
         END,
         last_clicked_at = NOW(),
         suppressed_until = NULL`,
      [workosUserId, ruleId],
    );
  } catch (error) {
    logger.warn({ error, workosUserId, ruleId }, 'Failed to record prompt click');
  }
}

export interface RuleMetricsRow {
  rule_id: string;
  distinct_users_shown: number;
  total_shown: number;
  total_clicked: number;
  ctr: number;
  distinct_users_suppressed: number;
  /** Fraction (0–1) of users-who-saw-the-rule who are currently suppressed. */
  suppression_rate: number;
  last_shown_at: Date | null;
  last_clicked_at: Date | null;
}

/**
 * Per-rule aggregate metrics for the admin dashboard.
 *
 * - total_shown: sum of shown_count across users (UTC-day-bucketed).
 * - total_clicked: sum of clicked_count (also UTC-day-bucketed).
 * - distinct_users_shown: users who saw the rule at least once.
 * - distinct_users_suppressed: users currently in a suppression window.
 * - suppression_rate: fraction of shown users currently suppressed —
 *   the headline "is this prompt wearing out its welcome" signal.
 * - ctr: total_clicked / total_shown (0 when no shows).
 */
export async function getRuleMetrics(): Promise<RuleMetricsRow[]> {
  const result = await query<{
    rule_id: string;
    distinct_users_shown: string;
    total_shown: string;
    total_clicked: string;
    distinct_users_suppressed: string;
    last_shown_at: Date | null;
    last_clicked_at: Date | null;
  }>(
    `SELECT
       rule_id,
       COUNT(DISTINCT workos_user_id)::text AS distinct_users_shown,
       SUM(shown_count)::text AS total_shown,
       SUM(clicked_count)::text AS total_clicked,
       COUNT(DISTINCT workos_user_id) FILTER (WHERE suppressed_until > NOW())::text
         AS distinct_users_suppressed,
       MAX(last_shown_at) AS last_shown_at,
       MAX(last_clicked_at) AS last_clicked_at
     FROM addie_prompt_telemetry
     GROUP BY rule_id
     ORDER BY total_shown DESC`,
  );
  return result.rows.map((r) => {
    const totalShown = parseInt(r.total_shown || '0', 10);
    const totalClicked = parseInt(r.total_clicked || '0', 10);
    const distinctShown = parseInt(r.distinct_users_shown || '0', 10);
    const distinctSuppressed = parseInt(r.distinct_users_suppressed || '0', 10);
    return {
      rule_id: r.rule_id,
      distinct_users_shown: distinctShown,
      total_shown: totalShown,
      total_clicked: totalClicked,
      ctr: totalShown > 0 ? totalClicked / totalShown : 0,
      distinct_users_suppressed: distinctSuppressed,
      suppression_rate: distinctShown > 0 ? distinctSuppressed / distinctShown : 0,
      last_shown_at: r.last_shown_at ? new Date(r.last_shown_at) : null,
      last_clicked_at: r.last_clicked_at ? new Date(r.last_clicked_at) : null,
    };
  });
}

/**
 * Reset telemetry for a user — used by tests and for admin debugging.
 */
export async function resetTelemetryForUser(workosUserId: string): Promise<void> {
  await query(`DELETE FROM addie_prompt_telemetry WHERE workos_user_id = $1`, [
    workosUserId,
  ]);
}
