/**
 * Per-user, per-tool sliding-window rate limiter for Addie's MCP tool
 * handlers.
 *
 * The HTTP `contentProposeRateLimiter` (middleware) and the function-level
 * limiter inside `proposeContentForUser` (#2767) bound submission paths,
 * but external-facing tools called via the web Addie chat — Google Docs
 * reads, Gemini illustration generation, attachment fetches — can still
 * be scripted at machine speed from a logged-in session.
 *
 * Unlike Slack (naturally bounded by Slack API rates), the web chat has
 * no upstream rate ceiling. This module adds per-tool + global caps per
 * user, a workspace-aggregate cap for shared-cost tools, and exempts
 * system users that legitimately run tool chains on a cadence.
 *
 * State lives in Postgres (`addie_tool_rate_limit_events`) so caps are
 * bounded across multi-instance Fly deploys — prior to #2789 each pod
 * had its own in-process Map, so a user fanned across N pods got N×
 * the advertised cap.
 */

import { createLogger } from '../../logger.js';
import { query } from '../../db/client.js';

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
 * Workspace-aggregate caps for tools that burn an external budget
 * shared across all users (Gemini credits, Google Docs quota, etc).
 * Enforced in addition to the per-user cap — bounds the case where a
 * multi-member workspace collectively drives the tool past a
 * defensible cost ceiling, or where an attacker rotates through
 * compromised user sessions to stay under individual caps.
 *
 * Exported so admin observability (#2796 ops metric) can read the cap
 * value instead of hard-coding it — single source of truth for the
 * ceiling.
 */
export const WORKSPACE_CAPS: Record<string, ToolRateLimitConfig> = {
  // Gemini generation — most expensive tool in the Addie surface.
  // 50/day across the whole workspace keeps monthly spend bounded
  // (~1500 generations/mo max). The per-user 5/month quota + per-user
  // 10/10min tool limit still apply on top.
  generate_perspective_illustration: { windowMs: 24 * 60 * 60 * 1000, max: 50 },
};

/**
 * Literal allowlist of system user identifiers that bypass the limiter.
 * Prefix-matching on `system:` was fragile because member-context can
 * theoretically produce any string for `workos_user_id` (especially in
 * dev mode where identities are cookie-picked). Stick to the ids used
 * by real automated pipelines and nothing else.
 *
 * Sourced from `../system-identities.ts` so the cost-tracker and any
 * future per-user gate use the same list — two Sets in sync across
 * files is a future-drift bug waiting to happen.
 */
import { SYSTEM_USER_IDS } from '../system-identities.js';

export interface RateLimitResult {
  ok: boolean;
  retryAfterMs?: number;
  scope?: 'per_tool' | 'global' | 'workspace';
}

/**
 * Storage backend. The default implementation is Postgres-backed; tests
 * inject an in-memory store so they don't need a DB connection.
 */
export interface RateLimitStore {
  /**
   * Count hits for `key` that occurred in the last `windowMs`, returning
   * the count and the timestamp of the oldest in-window hit (millis
   * since epoch). `null` first-hit means no hits in window.
   */
  countInWindow(key: string, windowMs: number): Promise<{ count: number; firstHitAtMs: number | null }>;
  /** Record a new hit for `key`. */
  record(key: string): Promise<void>;
  /** Remove hits older than `windowMs` for `key`. Opportunistic trim. */
  trim(key: string, windowMs: number): Promise<void>;
  /** Test-only: clear all state. */
  reset(): Promise<void>;
}

class PostgresStore implements RateLimitStore {
  async countInWindow(key: string, windowMs: number): Promise<{ count: number; firstHitAtMs: number | null }> {
    const result = await query<{ count: string; first_hit_at: Date | null }>(
      `SELECT COUNT(*)::text AS count, MIN(hit_at) AS first_hit_at
       FROM addie_tool_rate_limit_events
       WHERE scope_key = $1 AND hit_at > NOW() - ($2::bigint || ' milliseconds')::interval`,
      [key, String(windowMs)],
    );
    const row = result.rows[0];
    return {
      count: Number(row.count),
      firstHitAtMs: row.first_hit_at ? row.first_hit_at.getTime() : null,
    };
  }

  async record(key: string): Promise<void> {
    await query(
      `INSERT INTO addie_tool_rate_limit_events (scope_key) VALUES ($1)`,
      [key],
    );
  }

  async trim(key: string, windowMs: number): Promise<void> {
    await query(
      `DELETE FROM addie_tool_rate_limit_events
       WHERE scope_key = $1 AND hit_at <= NOW() - ($2::bigint || ' milliseconds')::interval`,
      [key, String(windowMs)],
    );
  }

  async reset(): Promise<void> {
    await query(`TRUNCATE addie_tool_rate_limit_events`);
  }
}

class InMemoryStore implements RateLimitStore {
  private readonly hits = new Map<string, number[]>();

  async countInWindow(key: string, windowMs: number): Promise<{ count: number; firstHitAtMs: number | null }> {
    const cutoff = Date.now() - windowMs;
    const recent = (this.hits.get(key) ?? []).filter(t => t > cutoff);
    return {
      count: recent.length,
      firstHitAtMs: recent.length > 0 ? recent[0] : null,
    };
  }

  async record(key: string): Promise<void> {
    const existing = this.hits.get(key) ?? [];
    existing.push(Date.now());
    this.hits.set(key, existing);
  }

  async trim(key: string, windowMs: number): Promise<void> {
    const cutoff = Date.now() - windowMs;
    const recent = (this.hits.get(key) ?? []).filter(t => t > cutoff);
    if (recent.length === 0) this.hits.delete(key);
    else this.hits.set(key, recent);
  }

  async reset(): Promise<void> {
    this.hits.clear();
  }
}

let store: RateLimitStore = new PostgresStore();

/**
 * Check + record an invocation. Returns `{ ok: true }` when allowed, or
 * `{ ok: false, retryAfterMs, scope }` when a cap is hit.
 *
 * `userId` must be a stable identifier for the caller. Pass `null` /
 * `undefined` only for genuinely anonymous / system paths that have
 * been explicitly vetted; otherwise the limiter is bypassed.
 *
 * Three scopes are checked in sequence: per-tool, per-user global,
 * workspace-aggregate (only for tools in WORKSPACE_CAPS). If any scope
 * is over cap, the call is blocked and NO scopes are recorded — so a
 * blocked request doesn't pollute counters for scopes it didn't reach.
 */
export async function checkToolRateLimit(
  toolName: string,
  userId: string | undefined | null,
): Promise<RateLimitResult> {
  // No user context (anonymous tools, startup paths) — skip.
  if (!userId) return { ok: true };
  // Known system automation — exempt via literal allowlist so a
  // member-context that happens to produce a 'system:...' string
  // can't trivially bypass the limiter.
  if (SYSTEM_USER_IDS.has(userId)) return { ok: true };

  const now = Date.now();
  const toolCap = CAPS[toolName] ?? DEFAULT_CAP;

  const perToolKey = `${userId}|${toolName}`;
  const perTool = await store.countInWindow(perToolKey, toolCap.windowMs);
  if (perTool.count >= toolCap.max && perTool.firstHitAtMs !== null) {
    return {
      ok: false,
      retryAfterMs: perTool.firstHitAtMs + toolCap.windowMs - now,
      scope: 'per_tool',
    };
  }

  const globalKey = `${userId}|*`;
  const globalHits = await store.countInWindow(globalKey, GLOBAL_CAP.windowMs);
  if (globalHits.count >= GLOBAL_CAP.max && globalHits.firstHitAtMs !== null) {
    return {
      ok: false,
      retryAfterMs: globalHits.firstHitAtMs + GLOBAL_CAP.windowMs - now,
      scope: 'global',
    };
  }

  const workspaceCap = WORKSPACE_CAPS[toolName];
  let workspaceKey: string | null = null;
  if (workspaceCap) {
    workspaceKey = `__workspace__|${toolName}`;
    const workspaceHits = await store.countInWindow(workspaceKey, workspaceCap.windowMs);
    if (workspaceHits.count >= workspaceCap.max && workspaceHits.firstHitAtMs !== null) {
      return {
        ok: false,
        retryAfterMs: workspaceHits.firstHitAtMs + workspaceCap.windowMs - now,
        scope: 'workspace',
      };
    }
  }

  // All scopes passed — record the hit in each. If one of these fails,
  // let it bubble: failing to record is preferable to silently letting
  // the counter drift.
  await store.record(perToolKey);
  await store.record(globalKey);
  if (workspaceKey) await store.record(workspaceKey);

  return { ok: true };
}

/**
 * Wrap a tool handler with rate limit enforcement. The returned handler
 * checks the cap first, returns a user-facing error string (NOT a
 * thrown error — the LLM needs to surface the message) when exceeded,
 * and otherwise delegates to the original handler.
 */
export function withToolRateLimit<T extends (input: Record<string, unknown>) => Promise<string>>(
  toolName: string,
  userId: string | undefined | null,
  handler: T,
): T {
  return (async (input: Record<string, unknown>) => {
    const check = await checkToolRateLimit(toolName, userId);
    if (!check.ok) {
      const retrySeconds = Math.max(1, Math.ceil((check.retryAfterMs ?? 60000) / 1000));
      logger.warn({ toolName, userId, scope: check.scope, retrySeconds }, 'Addie tool call rate-limited');
      let limit: string;
      if (check.scope === 'workspace') {
        const ws = WORKSPACE_CAPS[toolName];
        limit = `workspace-wide ${toolName} limit (${ws.max} per ${Math.round(ws.windowMs / 3600000)} hour${ws.windowMs >= 7200000 ? 's' : ''})`;
      } else if (check.scope === 'global') {
        limit = `overall Addie tool call limit (${GLOBAL_CAP.max} per ${GLOBAL_CAP.windowMs / 60000} minutes)`;
      } else {
        const cap = CAPS[toolName] ?? DEFAULT_CAP;
        limit = `${toolName} limit (${cap.max} per ${cap.windowMs / 60000} minutes)`;
      }
      return `Rate limit exceeded on the ${limit}. Try again in ~${retrySeconds} seconds.`;
    }
    return handler(input);
  }) as T;
}

/**
 * Test-only: swap the store implementation. Tests pass an InMemoryStore
 * so they don't need a DB. Production code should never call this.
 */
export function __setRateLimitStore(next: RateLimitStore): void {
  store = next;
}

/**
 * Test-only: clear all rate-limit state. Works against whichever store
 * is currently active.
 */
export async function __resetRateLimitHistory(): Promise<void> {
  await store.reset();
}

/**
 * Test-only: expose the in-memory store constructor so tests don't need
 * to import its name directly.
 */
export function __createInMemoryStore(): RateLimitStore {
  return new InMemoryStore();
}
