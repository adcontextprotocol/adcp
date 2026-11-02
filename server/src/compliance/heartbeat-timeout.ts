/**
 * Timed-out heartbeat visibility (adcp#8268).
 *
 * A hosted heartbeat that exhausts its time budget is recorded
 * non-authoritative, so `isAuthoritativeComplianceRun` keeps it out of the
 * published grade. That is the correct publication rule — partial evidence
 * must not grade an agent — but on its own it makes a consistently slow agent
 * *invisible* instead of visibly degraded: the card keeps rendering the last
 * good run and nobody tells the owner their latest heartbeats are being
 * dropped.
 *
 * This module is the one place that decides what counts as a timed-out
 * heartbeat and how to say so. It is pure, and the registry card renders the
 * `summary` it produces verbatim, so the card, the owner notification, and
 * their tests cannot drift apart.
 */

/** Emitted by the runner when the budget stopped storyboard dispatch. */
const STORYBOARD_COVERAGE_RE =
  /Stopped starting new storyboards after (\d+)\/(\d+) selected storyboard/;

/**
 * Heartbeats long enough to fill this window are reported as "at least N" —
 * past the window the true streak length is unknown, and a chronically slow
 * agent will exceed it (production saw 201 timed-out runs in 17 days).
 */
export const HEARTBEAT_TIMEOUT_STREAK_WINDOW = 20;

/**
 * A heartbeat can run out of time two ways, and the owner cares about neither
 * distinction:
 *
 * - the runner self-limits and returns `completeness = 'timed_out'`;
 * - the runner overshoots its own budget and the worker's hard deadline aborts
 *   it, which records `completeness = 'not_completed'` under this headline.
 *
 * Both leave the published grade stale, so both surface. The worker builds its
 * headline through `heartbeatTimeoutHeadline` so this prefix stays the single
 * definition rather than a string match on prose written somewhere else.
 */
const TIMEOUT_HEADLINE_PREFIX = 'Timed out:';

export function heartbeatTimeoutHeadline(timeoutMs: number): string {
  return `${TIMEOUT_HEADLINE_PREFIX} assessment did not complete within ${timeoutMs / 1000}s`;
}

export interface HeartbeatTimeoutRun {
  id: string;
  tested_at: Date | string;
  completeness?: string | null;
  headline?: string | null;
  total_duration_ms?: number | null;
  provenance_json?: { timeout_ms?: number | null } | null;
  observations_json?: unknown;
}

export interface HeartbeatTimeoutState {
  /** Run that timed out. Audit-only — it never became a published grade. */
  run_id: string;
  timed_out_at: string;
  /** Wall-clock the run actually consumed, when the runner reported it. */
  duration_ms: number | null;
  /** Budget the run was given (`provenance_json.timeout_ms`). */
  timeout_ms: number | null;
  storyboards_completed: number | null;
  storyboards_total: number | null;
  /** How many heartbeats in a row have ended this way, newest first. */
  consecutive: number;
  /** True when the streak filled the lookback window and may be longer. */
  consecutive_capped: boolean;
  /** Published grade this timeout failed to refresh, if there is one. */
  published_at: string | null;
  /** Owner-facing sentence; the card and the notification both render this. */
  summary: string;
}

function coerceObservations(value: unknown): Array<{ message?: unknown }> {
  return Array.isArray(value) ? (value as Array<{ message?: unknown }>) : [];
}

/**
 * Coverage the runner reached before the budget stopped it. Exported because
 * the owner-facing `latest_attempt` projection reads the same observation.
 */
export function parseStoryboardCoverage(observations: unknown): {
  completed: number | null;
  total: number | null;
  message: string | null;
} {
  for (const observation of coerceObservations(observations)) {
    if (!observation || typeof observation !== 'object') continue;
    const message = observation.message;
    if (typeof message !== 'string') continue;
    const match = message.match(STORYBOARD_COVERAGE_RE);
    if (!match) continue;
    const completed = Number(match[1]);
    const total = Number(match[2]);
    const valid = Number.isSafeInteger(completed) && Number.isSafeInteger(total)
      && total > 0 && completed >= 0 && completed <= total;
    return { completed: valid ? completed : null, total: valid ? total : null, message };
  }
  return { completed: null, total: null, message: null };
}

/** Whole seconds, so "654321ms" renders as "654s" rather than a float. */
function seconds(ms: number | null): number | null {
  return typeof ms === 'number' && Number.isFinite(ms) && ms >= 0 ? Math.round(ms / 1000) : null;
}

export function isHeartbeatTimeoutRun(run: Pick<HeartbeatTimeoutRun, 'completeness' | 'headline'>): boolean {
  if (run.completeness === 'timed_out') return true;
  return run.completeness === 'not_completed'
    && typeof run.headline === 'string'
    && run.headline.startsWith(TIMEOUT_HEADLINE_PREFIX);
}

function toIso(value: Date | string): string | null {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Describe the timeout in one sentence. Every input is runner- or
 * platform-generated (timestamps, budgets, storyboard counts) — no agent
 * response text reaches this string, so it is safe in a Slack DM title.
 */
export function describeHeartbeatTimeout(input: {
  timed_out_at: string;
  duration_ms: number | null;
  timeout_ms: number | null;
  storyboards_completed: number | null;
  storyboards_total: number | null;
  consecutive: number;
  consecutive_capped?: boolean;
}): string {
  const ranFor = seconds(input.duration_ms);
  const budget = seconds(input.timeout_ms);
  const parts = [`Last heartbeat timed out at ${input.timed_out_at}`];
  if (ranFor !== null && budget !== null) parts.push(`after ${ranFor}s of its ${budget}s budget`);
  else if (ranFor !== null) parts.push(`after ${ranFor}s`);
  else if (budget !== null) parts.push(`at its ${budget}s budget`);
  if (input.storyboards_completed !== null && input.storyboards_total !== null) {
    parts.push(`(${input.storyboards_completed}/${input.storyboards_total} storyboards completed)`);
  }
  let summary = `${parts.join(' ')}.`;
  if (input.consecutive > 1) {
    const count = input.consecutive_capped ? `at least ${input.consecutive}` : String(input.consecutive);
    summary += ` ${count} heartbeats in a row have timed out.`;
  }
  summary += ' The published compliance result was not updated.';
  return summary;
}

/**
 * Project the owner-facing timeout state from the agent's recent heartbeat
 * runs, newest first. Returns null when the newest heartbeat did not run out
 * of time — a later good run clears the state without any extra bookkeeping.
 */
export function projectHeartbeatTimeout(
  recentHeartbeatRuns: readonly HeartbeatTimeoutRun[],
  options: { publishedAt?: Date | string | null; windowLimit?: number } = {},
): HeartbeatTimeoutState | null {
  const latest = recentHeartbeatRuns[0];
  if (!latest || !isHeartbeatTimeoutRun(latest)) return null;
  const timedOutAt = toIso(latest.tested_at);
  if (!timedOutAt) return null;

  let consecutive = 0;
  for (const run of recentHeartbeatRuns) {
    if (!isHeartbeatTimeoutRun(run)) break;
    consecutive++;
  }
  // Every row we were given is part of the streak and the caller asked for a
  // full window, so the real streak may run past what we can see.
  const consecutiveCapped = options.windowLimit !== undefined
    && consecutive === recentHeartbeatRuns.length
    && recentHeartbeatRuns.length >= options.windowLimit;

  const coverage = parseStoryboardCoverage(latest.observations_json);
  const durationMs = finiteNumber(latest.total_duration_ms);
  const timeoutMs = finiteNumber(latest.provenance_json?.timeout_ms);
  const publishedAt = options.publishedAt ? toIso(options.publishedAt) : null;

  return {
    run_id: latest.id,
    timed_out_at: timedOutAt,
    duration_ms: durationMs,
    timeout_ms: timeoutMs,
    storyboards_completed: coverage.completed,
    storyboards_total: coverage.total,
    consecutive,
    consecutive_capped: consecutiveCapped,
    published_at: publishedAt,
    summary: describeHeartbeatTimeout({
      timed_out_at: timedOutAt,
      duration_ms: durationMs,
      timeout_ms: timeoutMs,
      storyboards_completed: coverage.completed,
      storyboards_total: coverage.total,
      consecutive,
      consecutive_capped: consecutiveCapped,
    }),
  };
}
