/**
 * Per-user Anthropic API cost cap (#2790).
 *
 * Tool-call frequency limits (#2784, #2789) bound OUR external API
 * spend (Google Docs, Gemini, Slack) but don't bound Anthropic spend.
 * Each Addie turn is a Claude API call, and an attacker with a
 * compromised account can keep a session running that stays under
 * the tool-call cap while steadily burning dollars on Claude.
 *
 * This module enforces a calendar-day (UTC midnight) USD budget per
 * user at the claude-client boundary. Callers check the cap at entry,
 * record cost on completion. Like `tool-rate-limiter.ts`, it uses a
 * dependency-injection seam so unit tests don't need a Postgres
 * connection.
 *
 * Calendar-day, not rolling 24h (#6048): the cap was originally a
 * rolling 24h window (`NOW() - interval`), which caused a real
 * incident — `formatCapExceededMessage()` tells users "try again
 * tomorrow", but a user capped at 6pm was still blocked at 8am the
 * next morning because only 14 of the required 24 hours had elapsed.
 * Rolling windows are right for abuse/API-cost defense; human-facing
 * "daily" quotas need to reset at a fixed calendar boundary, matching
 * how every ad-tech daily budget/frequency cap already works.
 *
 * System users (automated pipelines — newsletter, registry review)
 * are exempt by literal allowlist (see `./system-identities.ts`).
 * Router-layer Claude calls (Haiku for routing decisions) are also
 * exempt because they aren't user-initiated; the cost there is
 * amortized across the workspace.
 *
 * Known trade-offs:
 *
 * - **Midnight burst.** A calendar-day boundary (vs. the old rolling
 *   window) lets a user spend up to ~2x the daily budget in the few
 *   seconds straddling UTC midnight (max out at 23:59:59, fresh budget
 *   at 00:00:00). Acceptable given the caps are small in absolute
 *   terms ($3-$25) and this is cost-defense against runaway/abusive
 *   sessions, not hard billing enforcement — every calendar-day ad
 *   budget or frequency cap has this same edge at its reset boundary.
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

import { randomUUID } from 'crypto';
import { createLogger } from '../logger.js';
import { query } from '../db/client.js';
import { TIER_PRESERVING_STATUSES } from '../db/organization-db.js';
import { costUsdMicros, type ClaudeUsage } from './claude-pricing.js';
import { SYSTEM_USER_IDS } from './system-identities.js';
import type { MemberContext } from './member-context.js';

const logger = createLogger('addie-cost-tracker');

const MICROS_PER_DOLLAR = 1_000_000;

/** Start of the current UTC calendar day, as an epoch-ms cutoff. */
function utcMidnightCutoffMs(now: number = Date.now()): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** Milliseconds from now until the next UTC calendar-day boundary. */
function msUntilNextUtcMidnight(now: number = Date.now()): number {
  const d = new Date(now);
  const nextMidnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  return nextMidnight - now;
}

/**
 * Slack sharing metadata may be this old when choosing a public-community
 * cost scope. Ten seconds avoids an uncached conversations.info call on every
 * busy-channel turn while bounding exposure to a recent Slack Connect change.
 */
export const SLACK_COST_CHANNEL_INFO_MAX_AGE_MS = 10_000;

/**
 * Per-scope daily budgets in USD micros. User tiers distinguish member
 * entitlements; public community discussions use a workspace scope.
 *
 * Rationales:
 * - `anonymous`: $3/day. Sized to slightly exceed the per-IP message
 *   rate limit (50/day) at the current Sonnet ~$0.05/turn rate, so the
 *   message-count cap binds first for a legitimate user and the dollar
 *   cap only fires on scripted abuse. Was $1 when anonymous chat was
 *   on Haiku (~$0.01/turn → ~100 turns/day, well above rate limit);
 *   bumped on the Haiku→Sonnet move so legit users don't hit the
 *   dollar ceiling at ~20 turns.
 * - `member_free`: $5/day. Free tier with an account — slightly more
 *   trust than anonymous, same floor a real user couldn't reach in
 *   a day of genuine conversational use.
 * - `member_paid`: $25/day. Paying members get a generous ceiling
 *   that's still a real cap — a runaway automated session still
 *   trips it within an hour of sustained abuse.
 * - `public_community`: $25/day across public, non-shared Slack channels.
 *   Community discussions do not consume a participant's personal budget,
 *   while the workspace ceiling still bounds automated or abusive spend.
 * - `aao_team`: uncapped. AAO staff/admin/team users are operating
 *   the service, not consuming member benefits, so they should not
 *   hit a self-service spend ceiling while doing support or admin work.
 */
export const DAILY_BUDGET_USD = {
  anonymous: 3,
  member_free: 5,
  member_paid: 25,
  public_community: 25,
} as const satisfies Record<'anonymous' | 'member_free' | 'member_paid' | 'public_community', number>;

type CappedTier = keyof typeof DAILY_BUDGET_USD;
const DAILY_BUDGET_MICROS: Record<CappedTier, number> = {
  anonymous: DAILY_BUDGET_USD.anonymous * MICROS_PER_DOLLAR,
  member_free: DAILY_BUDGET_USD.member_free * MICROS_PER_DOLLAR,
  member_paid: DAILY_BUDGET_USD.member_paid * MICROS_PER_DOLLAR,
  public_community: DAILY_BUDGET_USD.public_community * MICROS_PER_DOLLAR,
};

export type UserTier = CappedTier | 'aao_team';

export interface CostCheckResult {
  ok: boolean;
  /** Cents spent in the current UTC calendar day for the user (rounded from micros). */
  spentCents?: number;
  /** Remaining USD in the budget, floored to 2 decimals. 0 when blocked. */
  remainingUsd?: number;
  /** Milliseconds until the daily cap resets at the next UTC midnight. */
  retryAfterMs?: number;
  /** The tier threshold that applies. */
  tier?: UserTier;
  /** True when the normal tier cap was exceeded but a bounded certification reserve allowed the call. */
  usedCertificationReserve?: boolean;
  /** Cross-replica lease held while a reserve-eligible completion call runs. */
  certificationLeaseId?: string;
  /** Another completion call already owns the reserve lease. */
  reserveBusy?: boolean;
}

/**
 * Storage interface. Default implementation is Postgres-backed; tests
 * inject an in-memory store.
 */
export interface CostTrackerStore {
  /** Sum of cost_usd_micros for `key` recorded since the start of the current UTC calendar day. */
  sumSinceUtcMidnight(key: string): Promise<{ totalMicros: number }>;
  /** Persist one charge. */
  record(key: string, costMicros: number, model: string, usage: ClaudeUsage): Promise<void>;
  claimCertificationLease(key: string, leaseId: string): Promise<boolean>;
  renewCertificationLease(key: string, leaseId: string): Promise<boolean>;
  releaseCertificationLease(key: string, leaseId: string): Promise<void>;
  /** Test-only: clear all state. */
  reset(): Promise<void>;
}

class PostgresStore implements CostTrackerStore {
  async sumSinceUtcMidnight(key: string): Promise<{ totalMicros: number }> {
    // Computes the UTC-midnight cutoff from Postgres's own NOW(), not the
    // app server's clock — `record()` below also timestamps via NOW(), so
    // the cutoff and the recorded charges share one clock. Comparing an
    // app-computed epoch-ms cutoff against DB-clock timestamps would let
    // clock skew misplace a charge relative to the boundary — precisely
    // the class of bug #6048 was about.
    const result = await query<{ total_micros: string | null }>(
      `SELECT COALESCE(SUM(cost_usd_micros), 0)::text AS total_micros
       FROM addie_token_cost_events
       WHERE scope_key = $1
         AND recorded_at >= (date_trunc('day', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')`,
      [key],
    );
    const row = result.rows[0];
    return { totalMicros: Number(row.total_micros ?? 0) };
  }

  async record(key: string, costMicros: number, model: string, usage: ClaudeUsage): Promise<void> {
    await query(
      `INSERT INTO addie_token_cost_events (scope_key, cost_usd_micros, model, tokens_input, tokens_output)
       VALUES ($1, $2, $3, $4, $5)`,
      [key, costMicros, model, usage.input_tokens, usage.output_tokens],
    );
  }

  async claimCertificationLease(key: string, leaseId: string): Promise<boolean> {
    const result = await query(
      `INSERT INTO certification_completion_leases (scope_key, lease_id, expires_at)
       VALUES ($1, $2, NOW() + INTERVAL '10 minutes')
       ON CONFLICT (scope_key) DO UPDATE SET
         lease_id = EXCLUDED.lease_id,
         expires_at = EXCLUDED.expires_at,
         created_at = NOW()
       WHERE certification_completion_leases.expires_at < NOW()
       RETURNING lease_id`,
      [key, leaseId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async releaseCertificationLease(key: string, leaseId: string): Promise<void> {
    await query(
      `DELETE FROM certification_completion_leases WHERE scope_key = $1 AND lease_id = $2`,
      [key, leaseId],
    );
  }

  async renewCertificationLease(key: string, leaseId: string): Promise<boolean> {
    const result = await query(
      `UPDATE certification_completion_leases
       SET expires_at = NOW() + INTERVAL '10 minutes'
       WHERE scope_key = $1 AND lease_id = $2`,
      [key, leaseId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async reset(): Promise<void> {
    await query(`TRUNCATE addie_token_cost_events`);
  }
}

class InMemoryStore implements CostTrackerStore {
  private readonly events = new Map<string, Array<{ atMs: number; micros: number }>>();
  private readonly certificationLeases = new Map<string, string>();

  async sumSinceUtcMidnight(key: string): Promise<{ totalMicros: number }> {
    const cutoff = utcMidnightCutoffMs();
    const recent = (this.events.get(key) ?? []).filter(e => e.atMs >= cutoff);
    const totalMicros = recent.reduce((acc, e) => acc + e.micros, 0);
    return { totalMicros };
  }

  async record(key: string, costMicros: number): Promise<void> {
    const existing = this.events.get(key) ?? [];
    existing.push({ atMs: Date.now(), micros: costMicros });
    this.events.set(key, existing);
  }

  async claimCertificationLease(key: string, leaseId: string): Promise<boolean> {
    if (this.certificationLeases.has(key)) return false;
    this.certificationLeases.set(key, leaseId);
    return true;
  }

  async releaseCertificationLease(key: string, leaseId: string): Promise<void> {
    if (this.certificationLeases.get(key) === leaseId) this.certificationLeases.delete(key);
  }

  async renewCertificationLease(key: string, leaseId: string): Promise<boolean> {
    return this.certificationLeases.get(key) === leaseId;
  }

  async reset(): Promise<void> {
    this.events.clear();
    this.certificationLeases.clear();
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
  options?: { certificationReserveUsd?: number },
): Promise<CostCheckResult> {
  if (!userId) return { ok: true };
  if (SYSTEM_USER_IDS.has(userId)) return { ok: true };
  if (tier === 'aao_team') return { ok: true, tier };

  const baseBudgetMicros = DAILY_BUDGET_MICROS[tier];
  const reserveMicros = Math.max(0, options?.certificationReserveUsd ?? 0) * MICROS_PER_DOLLAR;
  const budgetMicros = baseBudgetMicros + reserveMicros;
  const { totalMicros } = await store.sumSinceUtcMidnight(userId);
  const remainingMicros = Math.max(0, budgetMicros - totalMicros);
  const usedCertificationReserve = reserveMicros > 0 && totalMicros >= baseBudgetMicros;

  if (totalMicros >= budgetMicros) {
    // #6048 secondary risk: a Slack caller without a resolved WorkOS
    // mapping is forced to `member_free` ($5/day) by
    // `resolveUserTierFromDb` regardless of their real subscription
    // tier, so a paying member can hit a cap 5x tighter than expected.
    // Log it so an unmapped-identity cap-exceeded is diagnosable from
    // the scope key alone, without re-deriving this from an escalation.
    if (tier === 'member_free' && userId.startsWith('slack:')) {
      logger.warn(
        { userId, tier, spentCents: Math.round(totalMicros / 10_000) },
        'Slack user hit member_free cost cap on an unmapped scope key — real tier could not be resolved from WorkOS',
      );
    }
    return {
      ok: false,
      spentCents: Math.round(totalMicros / 10_000),
      remainingUsd: 0,
      retryAfterMs: msUntilNextUtcMidnight(),
      tier,
      usedCertificationReserve,
    };
  }

  let certificationLeaseId: string | undefined;
  if (reserveMicros > 0 && usedCertificationReserve) {
    certificationLeaseId = randomUUID();
    if (!await store.claimCertificationLease(userId, certificationLeaseId)) {
      return {
        ok: false,
        spentCents: Math.round(totalMicros / 10_000),
        remainingUsd: remainingMicros / MICROS_PER_DOLLAR,
        tier,
        reserveBusy: true,
      };
    }
  }

  return {
    ok: true,
    spentCents: Math.round(totalMicros / 10_000),
    remainingUsd: remainingMicros / MICROS_PER_DOLLAR,
    tier,
    usedCertificationReserve,
    certificationLeaseId,
  };
}

export async function releaseCertificationReserve(
  userId: string | null | undefined,
  leaseId: string | undefined,
): Promise<void> {
  if (!userId || !leaseId) return;
  try {
    await store.releaseCertificationLease(userId, leaseId);
  } catch (error) {
    logger.error({ error, userId }, 'Failed to release certification completion lease');
  }
}

export async function renewCertificationReserve(
  userId: string | null | undefined,
  leaseId: string | undefined,
): Promise<boolean> {
  if (!userId || !leaseId) return false;
  try {
    return await store.renewCertificationLease(userId, leaseId);
  } catch (error) {
    logger.error({ error, userId }, 'Failed to renew certification completion lease');
    return false;
  }
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
  if (result.reserveBusy) {
    return 'A certification completion reply is already processing. Please wait a moment and reload this conversation.';
  }
  const tier = result.tier ?? 'anonymous';
  const retryHours = result.retryAfterMs == null
    ? null
    : Math.max(1, Math.ceil(result.retryAfterMs / (60 * 60 * 1000)));
  const retryMessage = retryHours == null
    ? 'Please try again when your rolling daily limit resets.'
    : `Please try again in about ${retryHours} ${retryHours === 1 ? 'hour' : 'hours'}.`;
  if (tier === 'aao_team') {
    return 'AAO team usage is uncapped.';
  }
  if (tier === 'public_community') {
    return (
      `Public Addie discussions have reached today's community conversation capacity. ` +
      `${retryMessage} Ping the AgenticAdvertising.org team if the discussion is time-sensitive.`
    );
  }
  return (
    `You've reached your daily conversation limit with Addie. ` +
    `${retryMessage} ` +
    (tier === 'member_paid'
      ? 'Ping the AgenticAdvertising.org team if you need a higher ceiling for legitimate work.'
      : 'Upgrade your membership at https://agenticadvertising.org/dashboard/membership for a higher daily limit.')
  );
}

/**
 * Resolve a user's tier for the cost cap from their member context.
 * Callers who don't know the tier (anonymous web chat) pass
 * `'anonymous'` explicitly.
 */
export function resolveUserTier(opts: {
  isAnonymous?: boolean;
  isAAOTeam?: boolean;
  hasActiveSubscription?: boolean;
}): UserTier {
  if (opts.isAnonymous) return 'anonymous';
  if (opts.isAAOTeam) return 'aao_team';
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
 * have already mapped to a WorkOS id and passed *that* here. AAO team
 * members (`aao-admin` governance group or AgenticAdvertising.org org
 * membership) return `aao_team`, which is uncapped at the cost-gate
 * boundary but still recorded for spend observability. DB errors fall
 * back to `member_free` so a transient outage doesn't accidentally grant
 * the $25/day ceiling or uncapped staff access to unverified callers.
 *
 * The SQL predicate here uses `TIER_PRESERVING_STATUSES`
 * (active/past_due/trialing) so the cap agrees with billing entitlement
 * policy. `past_due` keeps paid headroom during Stripe dunning instead
 * of framing the member as unpaid mid-retry.
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
    const { rows } = await query<{
      is_aao_team: boolean;
      has_entitled_subscription: boolean;
    }>(
      `SELECT
          (
            EXISTS (
              SELECT 1
                FROM working_groups wg
                JOIN working_group_memberships wgm ON wgm.working_group_id = wg.id
               WHERE wg.slug = 'aao-admin'
                 AND wg.status = 'active'
                 AND wgm.workos_user_id = $1
                 AND wgm.status = 'active'
            )
            OR EXISTS (
              SELECT 1
                FROM organization_memberships om
                JOIN organizations o ON o.workos_organization_id = om.workos_organization_id
               WHERE om.workos_user_id = $1
                 AND LOWER(o.name) = 'agenticadvertising.org'
            )
          ) AS is_aao_team,
          EXISTS (
            SELECT 1
              FROM organization_memberships om
              JOIN organizations o ON o.workos_organization_id = om.workos_organization_id
             WHERE om.workos_user_id = $1
               AND o.subscription_status = ANY($2::text[])
               AND o.subscription_canceled_at IS NULL
          ) AS has_entitled_subscription`,
      [userId, TIER_PRESERVING_STATUSES],
    );
    const row = rows[0];
    const tier = resolveUserTier({
      isAAOTeam: row?.is_aao_team === true,
      hasActiveSubscription: row?.has_entitled_subscription === true,
    });
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

export interface SlackChannelCostContext {
  channelId: string;
  isPrivate: boolean | undefined;
  isShared: boolean | undefined;
  isOrgShared: boolean | undefined;
  isPendingExtShared?: boolean;
}

export interface SlackCostOptions {
  costScope: { userId: string; tier: UserTier };
}

/**
 * Choose the Claude cost-control options for a Slack conversation.
 * Public, non-shared channel discussions benefit the whole community,
 * so they use a bounded workspace scope instead of one participant's
 * personal daily cap. The resulting shared-fate ceiling is intentional:
 * it bounds total community spend, and exhaustion pauses all public-channel
 * discussions rather than charging or blocking one participant personally.
 * DMs, private/shared channels, reactions, and unresolved privacy remain
 * user-scoped.
 */
export async function buildSlackCostOptions(
  memberContext: Pick<MemberContext, 'workos_user'> | null | undefined,
  slackUserId: string,
  channelContext?: SlackChannelCostContext,
): Promise<SlackCostOptions> {
  const isPublicCommunityDiscussion = channelContext !== undefined &&
    channelContext.channelId.trim().length > 0 &&
    channelContext.isPrivate === false &&
    channelContext.isShared === false &&
    channelContext.isOrgShared === false &&
    channelContext.isPendingExtShared !== true;

  if (isPublicCommunityDiscussion) {
    return {
      costScope: {
        userId: 'slack-public-community',
        tier: 'public_community',
      },
    };
  }
  return { costScope: await buildSlackCostScope(memberContext, slackUserId) };
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
