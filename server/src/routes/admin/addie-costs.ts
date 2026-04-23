/**
 * Admin observability for the per-user Addie Anthropic cost cap (#2945,
 * follow-up to #2790 / #2946 / #2950).
 *
 * Exposes the `addie_token_cost_events` table via three read-only endpoints
 * so operators can see who's approaching their daily cap, which scope
 * namespaces dominate spend, and drill into a single scope's event history.
 *
 * Scope-key namespaces (encoded in the leading prefix of `scope_key`):
 *   - `email:<hash>` → inbound email conversation handler (anonymous tier)
 *   - `slack:<userId>` → bolt-app fallback when no WorkOS mapping exists
 *   - `mcp:<sub>` → MCP chat-tool authenticated via OAuth bearer
 *   - `tavus:ip:<ip>` → Tavus voice fallback when thread.user_id missing
 *   - `anon:<hashIp>` → anonymous web chat (legacy / future)
 *   - `user_...` (bare WorkOS id) → authenticated web/slack with mapping
 *   - anything else → `unknown`
 *
 * The `inferred_tier` column reflects the most-lenient cap the caller
 * would have been subject to at the time of the call. For bare WorkOS
 * IDs we join through `organization_memberships` + `organizations` so
 * active-subscription members show `member_paid`; for everyone else we
 * fall back to the namespace-level inference (email/mcp/tavus/anon →
 * anonymous, slack/workos → member_free).
 */

import { Router } from 'express';
import { createLogger } from '../../logger.js';
import { requireAuth, requireAdmin } from '../../middleware/auth.js';
import { getPool } from '../../db/client.js';
import { DAILY_BUDGET_USD } from '../../addie/claude-cost-tracker.js';
import {
  inferDisplayTier,
  microsToUsd,
  NAMESPACE_FALLBACK_TIER,
  type Namespace,
} from './addie-costs-helpers.js';

const logger = createLogger('admin-addie-costs');

const DEFAULT_LEADERBOARD_LIMIT = 50;
const MAX_LEADERBOARD_LIMIT = 200;
const MAX_EVENTS_PER_SCOPE = 200;

/**
 * SQL expression that classifies `<col>` into a namespace label. Must
 * stay in sync with the JS `classifyScopeKey` helper — unit tests pin
 * the JS side, and the SQL uses `ESCAPE '\\'` on the `user\_%` pattern
 * so the default LIKE wildcard on `_` doesn't drift from the JS
 * `startsWith('user_')` semantics.
 */
function namespaceCaseSql(col: string): string {
  return `
    CASE
      WHEN ${col} LIKE 'email:%' THEN 'email'
      WHEN ${col} LIKE 'slack:%' THEN 'slack'
      WHEN ${col} LIKE 'mcp:%' THEN 'mcp'
      WHEN ${col} LIKE 'tavus:ip:%' THEN 'tavus'
      WHEN ${col} LIKE 'anon:%' THEN 'anon'
      WHEN ${col} LIKE 'user\\_%' ESCAPE '\\' THEN 'workos'
      ELSE 'unknown'
    END
  `;
}


export function setupAddieCostRoutes(apiRouter: Router): void {
  // GET /api/admin/addie-costs/summary — workspace-wide aggregates.
  // Returns 24h + 7d totals plus a per-namespace breakdown so operators
  // can see at a glance whether a namespace is driving spend (e.g., a
  // runaway email loop dominating the `email:` bucket).
  apiRouter.get('/addie-costs/summary', requireAuth, requireAdmin, async (_req, res) => {
    try {
      const pool = getPool();

      const [totalsRow, namespaceRows] = await Promise.all([
        pool.query<{
          total_24h: string | null;
          total_7d: string | null;
          events_24h: string;
          events_7d: string;
          scopes_24h: string;
        }>(
          `SELECT
             COALESCE(SUM(CASE WHEN recorded_at > NOW() - INTERVAL '24 hours' THEN cost_usd_micros ELSE 0 END), 0)::text AS total_24h,
             COALESCE(SUM(CASE WHEN recorded_at > NOW() - INTERVAL '7 days'  THEN cost_usd_micros ELSE 0 END), 0)::text AS total_7d,
             COUNT(*) FILTER (WHERE recorded_at > NOW() - INTERVAL '24 hours')::text AS events_24h,
             COUNT(*) FILTER (WHERE recorded_at > NOW() - INTERVAL '7 days')::text  AS events_7d,
             COUNT(DISTINCT scope_key) FILTER (WHERE recorded_at > NOW() - INTERVAL '24 hours')::text AS scopes_24h
           FROM addie_token_cost_events
           WHERE recorded_at > NOW() - INTERVAL '7 days'`,
        ),
        pool.query<{
          namespace: Namespace;
          unique_scopes: string;
          total_micros: string;
          event_count: string;
        }>(
          `SELECT
             ${namespaceCaseSql('scope_key')} AS namespace,
             COUNT(DISTINCT scope_key)::text AS unique_scopes,
             SUM(cost_usd_micros)::text AS total_micros,
             COUNT(*)::text AS event_count
           FROM addie_token_cost_events
           WHERE recorded_at > NOW() - INTERVAL '24 hours'
           GROUP BY 1
           ORDER BY SUM(cost_usd_micros) DESC`,
        ),
      ]);

      const totals = totalsRow.rows[0] ?? {
        total_24h: '0',
        total_7d: '0',
        events_24h: '0',
        events_7d: '0',
        scopes_24h: '0',
      };

      res.json({
        window_24h: {
          spent_usd: microsToUsd(Number(totals.total_24h ?? 0)),
          events: Number(totals.events_24h),
          unique_scopes: Number(totals.scopes_24h),
        },
        window_7d: {
          spent_usd: microsToUsd(Number(totals.total_7d ?? 0)),
          events: Number(totals.events_7d),
        },
        by_namespace: namespaceRows.rows.map(row => ({
          namespace: row.namespace,
          unique_scopes: Number(row.unique_scopes),
          events: Number(row.event_count),
          spent_usd: microsToUsd(Number(row.total_micros)),
          fallback_tier: NAMESPACE_FALLBACK_TIER[row.namespace],
          fallback_cap_usd: DAILY_BUDGET_USD[NAMESPACE_FALLBACK_TIER[row.namespace]],
        })),
      });
    } catch (err) {
      logger.error({ err }, 'Failed to load Addie cost summary');
      res.status(500).json({ error: 'Failed to load summary' });
    }
  });

  // GET /api/admin/addie-costs/leaderboard — top spenders in a window.
  // Joins bare WorkOS scope keys back to users + orgs so operators can
  // tell at a glance which real members are approaching their cap; other
  // namespaces (email hash, mcp sub, tavus ip) stay opaque by design.
  apiRouter.get('/addie-costs/leaderboard', requireAuth, requireAdmin, async (req, res) => {
    try {
      const pool = getPool();
      const rawLimit = Number(req.query.limit);
      const limit = Number.isFinite(rawLimit) && rawLimit > 0
        ? Math.min(rawLimit, MAX_LEADERBOARD_LIMIT)
        : DEFAULT_LEADERBOARD_LIMIT;
      const windowParam = req.query.window;
      if (windowParam !== undefined && windowParam !== '24h' && windowParam !== '7d') {
        return res.status(400).json({ error: 'window must be 24h or 7d' });
      }
      const windowHours = windowParam === '7d' ? 24 * 7 : 24;

      // Aggregate per-scope spend FIRST in a CTE, then join to user/org
      // metadata via a LATERAL subquery that picks one membership per
      // user (active-subscription preferred). This is critical: a flat
      // LEFT JOIN organization_memberships would multiply rows for users
      // in multiple orgs and the SUM would double-count before GROUP BY
      // collapsed them.
      const { rows } = await pool.query<{
        scope_key: string;
        namespace: Namespace;
        total_micros: string;
        event_count: string;
        first_at: Date;
        last_at: Date;
        models: string[];
        member_first_name: string | null;
        member_last_name: string | null;
        member_email: string | null;
        org_name: string | null;
        org_has_active_subscription: boolean | null;
      }>(
        `WITH scope_totals AS (
           SELECT
             scope_key,
             SUM(cost_usd_micros) AS total_micros,
             COUNT(*) AS event_count,
             MIN(recorded_at) AS first_at,
             MAX(recorded_at) AS last_at,
             ARRAY_AGG(DISTINCT model) AS models
           FROM addie_token_cost_events
           WHERE recorded_at > NOW() - make_interval(hours => $1::int)
           GROUP BY scope_key
           ORDER BY SUM(cost_usd_micros) DESC
           LIMIT $2
         )
         SELECT
           t.scope_key,
           ${namespaceCaseSql('t.scope_key')} AS namespace,
           t.total_micros::text AS total_micros,
           t.event_count::text AS event_count,
           t.first_at,
           t.last_at,
           t.models,
           u.first_name AS member_first_name,
           u.last_name  AS member_last_name,
           u.email      AS member_email,
           best_org.name AS org_name,
           best_org.has_active_subscription AS org_has_active_subscription
         FROM scope_totals t
         LEFT JOIN users u ON u.workos_user_id = t.scope_key
         LEFT JOIN LATERAL (
           SELECT
             o.name,
             (o.subscription_status = 'active' AND o.subscription_canceled_at IS NULL) AS has_active_subscription
           FROM organization_memberships om
           JOIN organizations o ON o.workos_organization_id = om.workos_organization_id
           WHERE om.workos_user_id = t.scope_key
           ORDER BY
             CASE WHEN o.subscription_status = 'active' AND o.subscription_canceled_at IS NULL THEN 0 ELSE 1 END
           LIMIT 1
         ) best_org ON true
         ORDER BY t.total_micros DESC`,
        [windowHours, limit],
      );

      const leaderboard = rows.map(row => {
        const namespace = row.namespace;
        const inferredTier = inferDisplayTier(namespace, row.org_has_active_subscription);
        const capUsd = DAILY_BUDGET_USD[inferredTier];
        const spentUsd = microsToUsd(Number(row.total_micros));
        const percentOfCap = capUsd > 0 ? Math.round((spentUsd / capUsd) * 1000) / 10 : 0;

        const displayName = [row.member_first_name, row.member_last_name].filter(Boolean).join(' ').trim() || null;

        return {
          scope_key: row.scope_key,
          namespace,
          spent_usd: spentUsd,
          event_count: Number(row.event_count),
          first_at: row.first_at.toISOString(),
          last_at: row.last_at.toISOString(),
          models: row.models,
          inferred_tier: inferredTier,
          cap_usd: capUsd,
          percent_of_cap: percentOfCap,
          member_name: displayName,
          member_email: row.member_email,
          org_name: row.org_name,
          has_active_subscription: row.org_has_active_subscription,
        };
      });

      res.json({ window_hours: windowHours, limit, count: leaderboard.length, leaderboard });
    } catch (err) {
      logger.error({ err }, 'Failed to load Addie cost leaderboard');
      res.status(500).json({ error: 'Failed to load leaderboard' });
    }
  });

  // GET /api/admin/addie-costs/scope/:scopeKey/events — drill-in.
  // Returns recent events for a single scope so ops can see model mix,
  // spike timing, and token volume. Scope keys can contain `:` so the
  // param is URL-decoded by Express before we use it.
  apiRouter.get('/addie-costs/scope/:scopeKey/events', requireAuth, requireAdmin, async (req, res) => {
    try {
      const scopeKey = req.params.scopeKey;
      // Charset + length guard — scope keys in practice are
      // alphanumeric plus `:`, `.`, `_`, `-`; a hostile or accidental
      // value with control characters won't break the parameterized
      // query but shouldn't reach our logs either.
      if (!scopeKey || scopeKey.length > 256 || !/^[A-Za-z0-9:_.\-]+$/.test(scopeKey)) {
        return res.status(400).json({ error: 'Invalid scope key' });
      }
      const pool = getPool();

      const { rows } = await pool.query<{
        recorded_at: Date;
        model: string;
        tokens_input: number;
        tokens_output: number;
        cost_usd_micros: string;
      }>(
        `SELECT recorded_at, model, tokens_input, tokens_output, cost_usd_micros::text
         FROM addie_token_cost_events
         WHERE scope_key = $1
         ORDER BY recorded_at DESC
         LIMIT $2`,
        [scopeKey, MAX_EVENTS_PER_SCOPE],
      );

      // Audit log: scope-events is the narrowest query in the set —
      // an admin pulling per-user event detail (including for opaque
      // `email:<hash>` keys they could compute offline) should leave a
      // trail. Log aggregation alerts can watch this event if the view
      // is ever opened to a broader admin pool.
      logger.info(
        {
          event: 'admin_addie_cost_scope_inspected',
          scopeKey,
          eventCount: rows.length,
          adminUserId: (req as unknown as { user?: { id?: string } }).user?.id,
        },
        'Admin inspected Addie cost scope detail',
      );

      res.json({
        scope_key: scopeKey,
        count: rows.length,
        events: rows.map(row => ({
          recorded_at: row.recorded_at.toISOString(),
          model: row.model,
          tokens_input: row.tokens_input,
          tokens_output: row.tokens_output,
          cost_usd: microsToUsd(Number(row.cost_usd_micros)),
        })),
      });
    } catch (err) {
      logger.error({ err, scopeKey: req.params.scopeKey }, 'Failed to load scope events');
      res.status(500).json({ error: 'Failed to load events' });
    }
  });
}
