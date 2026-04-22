/**
 * In-process per-user, per-tool sliding-window rate limiter for Addie's
 * MCP tool handlers.
 *
 * The HTTP `contentProposeRateLimiter` (middleware) and the function-level
 * limiter inside `proposeContentForUser` (#2767) bound submission paths,
 * but external-facing tools called via the web Addie chat — Google Docs
 * reads, Gemini illustration generation, attachment fetches — can still
 * be scripted at machine speed from a logged-in session.
 *
 * Unlike Slack (naturally bounded by Slack API rates), the web chat has
 * no upstream rate ceiling. This module adds per-tool + global caps per
 * user, surfaces a clear error when exceeded, and exempts system users
 * (`system:*` — newsletter pipeline, digest publisher) that legitimately
 * run tool chains on a cadence.
 *
 * Part of #2755.
 */

import { createLogger } from '../../logger.js';

const logger = createLogger('addie-tool-rate-limit');

export interface ToolRateLimitConfig {
  /** Rolling window length in milliseconds. */
  windowMs: number;
  /** Max invocations per user in the window. */
  max: number;
}

/**
 * Per-tool caps. Default applies to any tool not listed here.
 *
 * The rationale for each budget:
 * - `read_google_doc`: external Google Docs API calls. Expensive for us
 *   (API quota) and Google (our shared refresh token). 20 in 10 min is
 *   generous for a human; a looping attacker hits the wall fast.
 * - `attach_content_asset`: fetches an external URL, buffers up to 50MB.
 *   Same 20/10min.
 * - `generate_perspective_illustration`: Gemini call + image storage.
 *   Per-account quota already exists downstream (admin-illustrations
 *   route), but wrap this one tighter here — it's the most expensive
 *   tool in the Addie surface. 10/10min is still plenty for a real
 *   reviewer.
 * - default: 60/10min. Covers DB-read tools (list_pending_content,
 *   search_*, etc.) and lets a human have a conversational session
 *   without hitting walls.
 * - global: 200/10min across ALL tools per user. Final safety net
 *   against a runaway that stays under every per-tool cap.
 */
const CAPS: Record<string, ToolRateLimitConfig> = {
  read_google_doc: { windowMs: 10 * 60 * 1000, max: 20 },
  attach_content_asset: { windowMs: 10 * 60 * 1000, max: 20 },
  generate_perspective_illustration: { windowMs: 10 * 60 * 1000, max: 10 },
};
const DEFAULT_CAP: ToolRateLimitConfig = { windowMs: 10 * 60 * 1000, max: 60 };
const GLOBAL_CAP: ToolRateLimitConfig = { windowMs: 10 * 60 * 1000, max: 200 };

/**
 * Longest window across all caps — used as the GC staleness cutoff so
 * entries aren't prematurely dropped if a future tool gets a longer
 * window than the global cap.
 */
const MAX_WINDOW_MS = Math.max(
  GLOBAL_CAP.windowMs,
  DEFAULT_CAP.windowMs,
  ...Object.values(CAPS).map(c => c.windowMs),
);

/**
 * Literal allowlist of system user identifiers that bypass the limiter.
 * Prefix-matching on `system:` was fragile because member-context can
 * theoretically produce any string for `workos_user_id` (especially in
 * dev mode where identities are cookie-picked). Stick to the ids used
 * by real automated pipelines and nothing else.
 */
const SYSTEM_USER_IDS = new Set<string>([
  'system:addie',
  'system:sage',
  'system:scope3_seed',
  'system:logo-service',
  'system:google-alias-merge',
]);

/**
 * Per-user history. Key is `${userId}|${toolName}` for per-tool tracking
 * and `${userId}|*` for the global counter.
 */
const history = new Map<string, number[]>();

export interface RateLimitResult {
  ok: boolean;
  retryAfterMs?: number;
  scope?: 'per_tool' | 'global';
}

/**
 * Check + record an invocation. Returns { ok: true } when allowed, or
 * `{ ok: false, retryAfterMs, scope }` when the per-tool or global cap
 * is hit.
 *
 * `userId` must be a stable identifier for the caller. Pass `null` /
 * `undefined` only for genuinely anonymous / system paths that have
 * been explicitly vetted; otherwise the limiter is bypassed.
 */
export function checkToolRateLimit(toolName: string, userId: string | undefined | null): RateLimitResult {
  // No user context (anonymous tools, startup paths) — skip.
  if (!userId) return { ok: true };
  // Known system automation — exempt via literal allowlist so a
  // member-context that happens to produce a 'system:...' string
  // can't trivially bypass the limiter.
  if (SYSTEM_USER_IDS.has(userId)) return { ok: true };

  const now = Date.now();
  const toolCap = CAPS[toolName] ?? DEFAULT_CAP;

  const perToolKey = `${userId}|${toolName}`;
  const perToolCutoff = now - toolCap.windowMs;
  const perToolHistory = (history.get(perToolKey) ?? []).filter(t => t > perToolCutoff);
  if (perToolHistory.length >= toolCap.max) {
    return {
      ok: false,
      retryAfterMs: perToolHistory[0] + toolCap.windowMs - now,
      scope: 'per_tool',
    };
  }

  const globalKey = `${userId}|*`;
  const globalCutoff = now - GLOBAL_CAP.windowMs;
  const globalHistory = (history.get(globalKey) ?? []).filter(t => t > globalCutoff);
  if (globalHistory.length >= GLOBAL_CAP.max) {
    return {
      ok: false,
      retryAfterMs: globalHistory[0] + GLOBAL_CAP.windowMs - now,
      scope: 'global',
    };
  }

  // Record the invocation in both tracks
  perToolHistory.push(now);
  globalHistory.push(now);
  history.set(perToolKey, perToolHistory);
  history.set(globalKey, globalHistory);

  // Opportunistic GC once the map gets large
  if (history.size > 2000) {
    // Use the longest window across all caps to decide staleness so
    // we don't drop entries mid-window for any tracked counter.
    const cutoff = now - MAX_WINDOW_MS;
    for (const [key, entries] of history) {
      const recent = entries.filter(t => t > cutoff);
      if (recent.length === 0) history.delete(key);
      else history.set(key, recent);
    }
  }

  return { ok: true };
}

/**
 * Wrap a tool handler with rate limit enforcement. The returned handler
 * checks the cap first, returns a user-facing error string (NOT a
 * thrown error — the LLM needs to surface the message) when exceeded,
 * and otherwise delegates to the original handler.
 *
 * Use at handler-creation time: `handlers.set(name, withToolRateLimit(name, userId, originalHandler))`.
 */
export function withToolRateLimit<T extends (input: Record<string, unknown>) => Promise<string>>(
  toolName: string,
  userId: string | undefined | null,
  handler: T,
): T {
  return (async (input: Record<string, unknown>) => {
    const check = checkToolRateLimit(toolName, userId);
    if (!check.ok) {
      const retrySeconds = Math.max(1, Math.ceil((check.retryAfterMs ?? 60000) / 1000));
      logger.warn({ toolName, userId, scope: check.scope, retrySeconds }, 'Addie tool call rate-limited');
      const limit = check.scope === 'global'
        ? `overall Addie tool call limit (${GLOBAL_CAP.max} per ${GLOBAL_CAP.windowMs / 60000} minutes)`
        : `${toolName} limit (${(CAPS[toolName] ?? DEFAULT_CAP).max} per ${(CAPS[toolName] ?? DEFAULT_CAP).windowMs / 60000} minutes)`;
      return `Rate limit exceeded on the ${limit}. Try again in ~${retrySeconds} seconds.`;
    }
    return handler(input);
  }) as T;
}

/**
 * Test-only: clear the history map. Exposed so tests can reset state
 * between cases without waiting out the window.
 */
export function __resetRateLimitHistory(): void {
  history.clear();
}
