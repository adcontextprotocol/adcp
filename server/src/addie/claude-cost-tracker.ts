/**
 * Per-user Anthropic API cost cap (#2790).
 *
 * Tool-call frequency limits (#2784, #2789) bound OUR external API
 * spend (Google Docs, Gemini, Slack) but don't bound Anthropic spend.
 * Each Addie turn is a Claude API call, and an attacker with a
 * compromised account can keep a session running that stays under
 * the tool-call cap while steadily burning dollars on Claude.
 *
 * This module enforces a rolling 24-hour USD budget per user at the
 * claude-client boundary. Callers check the cap at entry, record
 * cost on completion. Like `tool-rate-limiter.ts`, it uses a
 * dependency-injection seam so unit tests don't need a Postgres
 * connection.
 *
 * System users (automated pipelines — newsletter, registry review)
 * are exempt by literal allowlist (see `./system-identities.ts`).
 * Router-layer Claude calls (Haiku for routing decisions) are also
 * exempt because they aren't user-initiated; the cost there is
 * amortized across the workspace.
 *
 * Known trade-offs:
 *
 * - **Check/record race.** The flow is `check → Claude call → record`,
 *   which is TOCTOU. N concurrent requests from one user can all see
 *   the same stale sum and all pass. Worst case a user overshoots
 *   the cap by a factor equal to their concurrency (10 parallel
 *   streams at member_free ≈ $50 instead of $5). Acceptable given
 *   this is a cost-defense gate, not an account-freeze, and the
 *   overshoot self-limits within one window.
 *
 * - **Recording-failure tolerance.** `recordCost` catches DB write
 *   errors and logs them — a sustained DB outage quietly disables
 *   the cap. Alternative behavior (fail the response when we can't
 *   record) would cause user-visible outages from an accounting-layer
 *   issue; logging loudly + alerting on sustained failures is the
 *   documented fallback.
 *
 * - **Charges record even on flagged / truncated responses.** The
 *   tokens went to Anthropic whether or not we liked the result, so
 *   the cost accumulates. Avoids a bypass where an attacker
 *   intentionally triggers truncation to make responses "free".
 */

import { createLogger } from '../logger.js';
import { query } from '../db/client.js';
import { costUsdMicros, type ClaudeUsage } from './claude-pricing.js';
import { SYSTEM_USER_IDS } from './system-identities.js';
import type { MemberContext } from './member-context.js';

const logger = createLogger('addie-cost-tracker');

const MICROS_PER_DOLLAR = 1_000_000;
const WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Per-user daily budgets in USD micros. Tier-aware so anonymous /
 * Explorer users get a smaller ceiling than paying members.
 *
 * Rationales:
 * - `anonymous`: $1/day. Covers a few exploratory chats (Haiku at
 *   ~$0.01/turn, Sonnet at ~$0.05/turn) without enabling a scripted
 *   chat spam that burns real money on our free surface.
 * - `member_free`: $5/day. Free tier with an account — slightly more
 *   trust than anonymous, same floor a real user couldn't reach in
 *   a day of genuine conversational use.
 * - `member_paid`: $25/day. Paying members get a generous ceiling
 *   that's still a real cap — a runaway automated session still
 *   trips it within an hour of sustained abuse.
 */
export const DAILY_BUDGET_USD: Record<'anonymous' | 'member_free' | 'member_paid', number> = {
  anonymous: 1,
  member_free: 5,
  member_paid: 25,
};

const DAILY_BUDGET_MICROS: Record<keyof typeof DAILY_BUDGET_USD, number> = {
  anonymous: DAILY_BUDGET_USD.anonymous * MICROS_PER_DOLLAR,
  member_free: DAILY_BUDGET_USD.member_free * MICROS_PER_DOLLAR,
  member_paid: DAILY_BUDGET_USD.member_paid * MICROS_PER_DOLLAR,
};

export type UserTier = keyof typeof DAILY_BUDGET_USD;

export interface CostCheckResult {
  ok: boolean;
  /** Cents spent in the trailing 24h for the user (rounded from micros). */
  spentCents?: number;
  /** Remaining USD in the budget, floored to 2 decimals. 0 when blocked. */
  remainingUsd?: number;
  /** Milliseconds until the oldest in-window charge falls out. */
  retryAfterMs?: number;
  /** The tier threshold that applies. */
  tier?: UserTier;
}

/**
 * Storage interface. Default implementation is Postgres-backed; tests
 * inject an in-memory store.
 */
export interface CostTrackerStore {
  /** Sum of cost_usd_micros for `key` recorded in the last `windowMs`. */
  sumInWindow(key: string, windowMs: number): Promise<{ totalMicros: number; firstAtMs: number | null }>;
  /** Persist one charge. */
  record(key: string, costMicros: number, model: string, usage: ClaudeUsage): Promise<void>;
  /** Test-only: clear all state. */
  reset(): Promise<void>;
}

class PostgresStore implements CostTrackerStore {
  async sumInWindow(key: string, windowMs: number): Promise<{ totalMicros: number; firstAtMs: number | null }> {
    const result = await query<{ total_micros: string | null; first_at: Date | null }>(
      `SELECT COALESCE(SUM(cost_usd_micros), 0)::text AS total_micros, MIN(recorded_at) AS first_at
       FROM addie_token_cost_events
       WHERE scope_key = $1 AND recorded_at > NOW() - ($2::bigint || ' milliseconds')::interval`,
      [key, String(windowMs)],
    );
    const row = result.rows[0];
    return {
      totalMicros: Number(row.total_micros ?? 0),
      firstAtMs: row.first_at ? row.first_at.getTime() : null,
    };
  }

  async record(key: string, costMicros: number, model: string, usage: ClaudeUsage): Promise<void> {
    await query(
      `INSERT INTO addie_token_cost_events (scope_key, cost_usd_micros, model, tokens_input, tokens_output)
       VALUES ($1, $2, $3, $4, $5)`,
      [key, costMicros, model, usage.input_tokens, usage.output_tokens],
    );
  }

  async reset(): Promise<void> {
    await query(`TRUNCATE addie_token_cost_events`);
  }
}

class InMemoryStore implements CostTrackerStore {
  private readonly events = new Map<string, Array<{ atMs: number; micros: number }>>();

  async sumInWindow(key: string, windowMs: number): Promise<{ totalMicros: number; firstAtMs: number | null }> {
    const cutoff = Date.now() - windowMs;
    const recent = (this.events.get(key) ?? []).filter(e => e.atMs > cutoff);
    const totalMicros = recent.reduce((acc, e) => acc + e.micros, 0);
    return { totalMicros, firstAtMs: recent.length > 0 ? recent[0].atMs : null };
  }

  async record(key: string, costMicros: number): Promise<void> {
    const existing = this.events.get(key) ?? [];
    existing.push({ atMs: Date.now(), micros: costMicros });
    this.events.set(key, existing);
  }

  async reset(): Promise<void> {
    this.events.clear();
  }
}

let store: CostTrackerStore = new PostgresStore();

/**
 * Check whether a user has budget for another Claude call. Returns
 * `{ ok: true }` when allowed. System users and callers without a
 * userId are always allowed — those paths represent system automation
 * or unauthenticated anonymous use that isn't a per-user concern.
 *
 * `tier` selects which daily cap to apply. The claude-client caller
 * resolves the tier from member-context (see `resolveUserTier` below).
 */
export async function checkCostCap(
  userId: string | null | undefined,
  tier: UserTier,
): Promise<CostCheckResult> {
  if (!userId) return { ok: true };
  if (SYSTEM_USER_IDS.has(userId)) return { ok: true };

  const budgetMicros = DAILY_BUDGET_MICROS[tier];
  const { totalMicros, firstAtMs } = await store.sumInWindow(userId, WINDOW_MS);
  const remainingMicros = Math.max(0, budgetMicros - totalMicros);

  if (totalMicros >= budgetMicros && firstAtMs !== null) {
    return {
      ok: false,
      spentCents: Math.round(totalMicros / 10_000),
      remainingUsd: 0,
      retryAfterMs: Math.max(0, firstAtMs + WINDOW_MS - Date.now()),
      tier,
    };
  }

  return {
    ok: true,
    spentCents: Math.round(totalMicros / 10_000),
    remainingUsd: remainingMicros / MICROS_PER_DOLLAR,
    tier,
  };
}

/**
 * Record an invocation's cost to the user's daily accumulator. Safe
 * to call without a userId (no-op) so the caller can always invoke
 * it post-response without branching.
 */
export async function recordCost(
  userId: string | null | undefined,
  model: string,
  usage: ClaudeUsage,
): Promise<void> {
  if (!userId) return;
  if (SYSTEM_USER_IDS.has(userId)) return;
  const micros = costUsdMicros(model, usage);
  try {
    await store.record(userId, micros, model, usage);
  } catch (err) {
    // Accounting failures shouldn't block the user's response —
    // the call already happened and a dropped accounting row is
    // strictly better than a user-facing error. Log loudly for
    // ops so a broken write path is caught.
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ error: message, userId, model, micros }, 'Failed to record Claude cost event');
  }
}

/**
 * Format a user-facing message when the cap is hit. Surfaces the
 * tier, current spend, and approximate reset time so the user
 * understands what happened.
 */
export function formatCapExceededMessage(result: CostCheckResult): string {
  const tier = result.tier ?? 'anonymous';
  const capUsd = DAILY_BUDGET_USD[tier];
  const spentUsd = ((result.spentCents ?? 0) / 100).toFixed(2);
  // Render the wait as hours when a user trips the cap early in the
  // window — "reset in ~1440 minutes" reads as noise. Minutes only
  // below 2 hours; rounded hours beyond that. The number is already
  // approximate (the user can retry sooner as individual charges
  // drop out), so hours-as-round-numbers is honest.
  const retryMs = result.retryAfterMs ?? 60_000;
  const retryMinutes = Math.max(1, Math.ceil(retryMs / 60_000));
  const humanReset = retryMinutes >= 120
    ? `~${Math.ceil(retryMinutes / 60)} hour${retryMinutes >= 180 ? 's' : ''}`
    : `~${retryMinutes} minute${retryMinutes === 1 ? '' : 's'}`;
  return (
    `You've hit today's Claude API usage cap (${capUsd} USD) — ` +
    `spent ≈ $${spentUsd} in the last 24 hours. ` +
    `The cap resets in ${humanReset}. ` +
    (tier === 'member_paid'
      ? 'Ping the AAO team if you need a higher ceiling for legitimate work.'
      : 'Upgrade your membership at /membership for a higher daily ceiling.')
  );
}

/**
 * Resolve a user's tier for the cost cap from their member context.
 * Callers who don't know the tier (anonymous web chat) pass
 * `'anonymous'` explicitly.
 */
export function resolveUserTier(opts: {
  isAnonymous?: boolean;
  hasActiveSubscription?: boolean;
}): UserTier {
  if (opts.isAnonymous) return 'anonymous';
  return opts.hasActiveSubscription ? 'member_paid' : 'member_free';
}

/**
 * In-memory memo cache for `resolveUserTierFromDb` results. Subscription
 * status changes on the order of days (Stripe webhooks → organizations
 * update), so a 60s stale window is well within tolerance — a paying
 * member briefly seeing member_free after a cancel, or a fresh
 * subscriber seeing member_free for up to 60s after activation, is
 * acceptable. The alternative is ~1 DB probe per Addie turn per active
 * user, which burns connections for a value that rarely changes.
 *
 * Per-process: each worker has its own cache. No coherence needed
 * across workers — staleness is bounded by the TTL. There is no
 * webhook-triggered invalidation hook; Stripe cancellations propagate
 * via the next DB probe after the 60s TTL elapses.
 *
 * Expired entries are lazy-evicted on the next lookup for the same
 * key. Under normal load the cache self-trims at a steady state
 * equal to distinct active users in the last 60s. The lazy sweep
 * inside `writeCachedTier` bounds worst-case growth if the caller
 * graph ever starts passing more transient keys than we expect.
 */
const TIER_CACHE_TTL_MS = 60_000;
const TIER_CACHE_MAX_SIZE = 10_000;
const tierCache = new Map<string, { tier: UserTier; expiresAt: number }>();

function writeCachedTier(userId: string, tier: UserTier): void {
  // When the cache crosses the soft cap, opportunistically sweep
  // expired entries. Bounds memory at worst case O(cap) under any
  // access pattern without paying for eviction on the hot path.
  if (tierCache.size >= TIER_CACHE_MAX_SIZE) {
    const now = Date.now();
    for (const [k, v] of tierCache) {
      if (v.expiresAt <= now) tierCache.delete(k);
    }
    // Pathological burst: 10k distinct users active within the TTL
    // window. Clear oldest half via insertion-order iteration so the
    // cache can resume filling with fresh entries.
    if (tierCache.size >= TIER_CACHE_MAX_SIZE) {
      const keysToDrop = [...tierCache.keys()].slice(0, Math.floor(TIER_CACHE_MAX_SIZE / 2));
      for (const k of keysToDrop) tierCache.delete(k);
    }
  }
  tierCache.set(userId, { tier, expiresAt: Date.now() + TIER_CACHE_TTL_MS });
}

/**
 * Resolve the right tier for a scope-key userId by looking up the
 * subscription status of a bare WorkOS user id. Non-WorkOS scope keys
 * (`slack:...`, `email:...`, etc.) can't resolve a real subscription
 * at call time, so they stay `member_free` regardless of the underlying
 * person's membership — upgrading those paths would need the caller to
 * have already mapped to a WorkOS id and passed *that* here. DB errors
 * fall back to `member_free` so a transient outage doesn't accidentally
 * grant the $25/day ceiling to unverified callers.
 *
 * The SQL predicate here (`subscription_status = 'active' AND
 * subscription_canceled_at IS NULL`) matches `MEMBER_FILTER` in
 * `db/org-filters.ts` — the two must stay in sync so admin views and
 * the cap agree on who counts as a paying member. Trialing / past_due /
 * comped-$0 states all correctly fall through to `member_free`; if
 * future policy promotes any of those, update `MEMBER_FILTER` first.
 *
 * This is the async, DB-touching counterpart to the pure
 * `resolveUserTier` above — the `FromDb` suffix is deliberate so a
 * call site can tell at a glance that this one awaits the database.
 * Results are memoized for 60 seconds per userId to keep the hot path
 * off the DB on repeated calls from the same user in a conversation.
 */
export async function resolveUserTierFromDb(userId: string | null | undefined): Promise<UserTier> {
  if (!userId || !userId.startsWith('user_')) return 'member_free';

  const now = Date.now();
  const cached = tierCache.get(userId);
  if (cached && cached.expiresAt > now) return cached.tier;

  try {
    const { rows } = await query<{ exists: 1 }>(
      `SELECT 1 AS exists
         FROM organization_memberships om
         JOIN organizations o ON o.workos_organization_id = om.workos_organization_id
        WHERE om.workos_user_id = $1
          AND o.subscription_status = 'active'
          AND o.subscription_canceled_at IS NULL
        LIMIT 1`,
      [userId],
    );
    const tier: UserTier = rows.length > 0 ? 'member_paid' : 'member_free';
    writeCachedTier(userId, tier);
    return tier;
  } catch (err) {
    logger.warn(
      { err, userId },
      'Failed to resolve user tier — defaulting to member_free',
    );
    // Don't cache errors — a transient DB issue shouldn't make a
    // member see member_free for a full TTL. Next call retries.
    return 'member_free';
  }
}

/**
 * Build a complete cost-scope `{ userId, tier }` for Slack-originated
 * callers. Collapses the 2-line prelude that was duplicated at every
 * Slack site: resolve the WorkOS id (preferred) with a `slack:${id}`
 * fallback, then probe the DB for subscription tier. Keeps the
 * scope-key fallback shape in one place so future renames of the
 * `slack:` namespace only touch one line.
 *
 * Accepts `Pick<MemberContext, 'workos_user'>` rather than the full
 * `MemberContext` shape — the helper only reads `workos_user`, so
 * accepting a narrower structural type keeps the dependency minimal
 * while still tracking shape changes in `member-context.ts`.
 */
export async function buildSlackCostScope(
  memberContext: Pick<MemberContext, 'workos_user'> | null | undefined,
  slackUserId: string,
): Promise<{ userId: string; tier: UserTier }> {
  const userId = memberContext?.workos_user?.workos_user_id ?? `slack:${slackUserId}`;
  const tier = await resolveUserTierFromDb(userId);
  return { userId, tier };
}

/**
 * Test-only: clear the tier-resolution memo cache. Unit tests that
 * drive the DB probe need a clean cache between runs so an earlier
 * test's memoized result doesn't leak into the next.
 */
export function __clearTierCache(): void {
  tierCache.clear();
}

/**
 * Test-only: swap the store implementation. Tests pass an
 * InMemoryStore so they don't need a DB connection.
 */
export function __setCostTrackerStore(next: CostTrackerStore): void {
  store = next;
}

/** Test-only helper. */
export async function __resetCostTrackerHistory(): Promise<void> {
  await store.reset();
}

/** Test-only factory. */
export function __createInMemoryCostStore(): CostTrackerStore {
  return new InMemoryStore();
}
