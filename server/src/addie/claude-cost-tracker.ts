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
 * are exempt by literal allowlist. Router-layer Claude calls (Haiku
 * for routing decisions) are also exempt because they aren't
 * user-initiated; the cost there is amortized across the workspace.
 */

import { createLogger } from '../logger.js';
import { query } from '../db/client.js';
import { costUsdMicros, type ClaudeUsage } from './claude-pricing.js';

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

/**
 * Literal allowlist — identical list to `tool-rate-limiter.ts`'s
 * SYSTEM_USER_IDS by design. A prefix match on `system:` would be
 * fragile for the same reason documented there: dev-mode cookies can
 * produce arbitrary `workos_user_id` strings.
 */
const SYSTEM_USER_IDS = new Set<string>([
  'system:addie',
  'system:sage',
  'system:scope3_seed',
  'system:logo-service',
  'system:google-alias-merge',
]);

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
  const retryMinutes = Math.max(1, Math.ceil((result.retryAfterMs ?? 60000) / 60000));
  const tier = result.tier ?? 'anonymous';
  const capUsd = DAILY_BUDGET_USD[tier];
  const spentUsd = ((result.spentCents ?? 0) / 100).toFixed(2);
  return (
    `You've hit today's Claude API usage cap (${capUsd} USD) — ` +
    `spent ≈ $${spentUsd} in the last 24 hours. ` +
    `The cap resets in ~${retryMinutes} minute${retryMinutes === 1 ? '' : 's'}. ` +
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
