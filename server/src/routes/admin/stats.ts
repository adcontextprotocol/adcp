/**
 * Admin dashboard stats routes
 *
 * Provides statistics for the admin dashboard including:
 * - Member and subscription stats
 * - Revenue metrics (MRR, ARR, bookings)
 * - Slack activity
 * - Addie conversation metrics
 * - User engagement scores
 * - Organization lifecycle stages
 */

import { Router } from "express";
import { getPool } from "../../db/client.js";
import { createLogger } from "../../logger.js";
import { requireAuth, requireAdmin } from "../../middleware/auth.js";
import { MemberSearchAnalyticsDatabase } from "../../db/member-search-analytics-db.js";
import { MemberDatabase } from "../../db/member-db.js";

const memberSearchAnalyticsDb = new MemberSearchAnalyticsDatabase();
const memberDb = new MemberDatabase();

const logger = createLogger("admin-stats");

/**
 * Format cents to currency string (no cents, with commas)
 */
function formatCurrency(cents: number): string {
  const dollars = Math.round(cents / 100);
  return `$${dollars.toLocaleString()}`;
}

/**
 * Setup admin stats routes
 */
export function setupStatsRoutes(apiRouter: Router): void {
  // GET /api/admin/stats - Admin dashboard statistics
  apiRouter.get("/stats", requireAuth, requireAdmin, async (req, res) => {
    try {
      const pool = getPool();

      // Run all queries in parallel for better performance
      const [
        memberStats,
        revenueStats,
        mrrStats,
        productRevenue,
        slackStats,
        addieStats,
        addieRatings,
        userStats,
        orgStats,
        recentBookings,
        bookingsByMonth,
        slackByWeek,
        engagementTrends,
        addieTrends,
      ] = await Promise.all([
        // Member counts from organizations
        pool.query(`
          SELECT
            COUNT(*) as total_members,
            COUNT(CASE WHEN subscription_amount IS NOT NULL AND subscription_current_period_end > NOW() AND subscription_canceled_at IS NULL THEN 1 END) as active_subscriptions,
            COUNT(CASE
              WHEN subscription_amount IS NOT NULL
                AND subscription_current_period_end IS NOT NULL
                AND subscription_current_period_end < NOW() + INTERVAL '30 days'
                AND subscription_canceled_at IS NULL
              THEN 1
            END) as expiring_this_month,
            COUNT(CASE WHEN subscription_interval = 'month' AND subscription_amount IS NOT NULL AND subscription_current_period_end > NOW() AND subscription_canceled_at IS NULL THEN 1 END) as monthly_subscriptions,
            COUNT(CASE WHEN subscription_interval = 'year' AND subscription_amount IS NOT NULL AND subscription_current_period_end > NOW() AND subscription_canceled_at IS NULL THEN 1 END) as annual_subscriptions
          FROM organizations
        `),

        // Revenue metrics from revenue_events
        pool.query(`
          SELECT
            COALESCE(SUM(CASE WHEN revenue_type != 'payment_failed' THEN amount_paid ELSE 0 END), 0) as total_revenue,
            COALESCE(SUM(CASE WHEN revenue_type = 'refund' THEN ABS(amount_paid) ELSE 0 END), 0) as total_refunds,
            COALESCE(SUM(CASE
              WHEN revenue_type != 'refund'
                AND revenue_type != 'payment_failed'
                AND paid_at >= date_trunc('month', CURRENT_DATE)
              THEN amount_paid
              ELSE 0
            END), 0) as current_month_revenue,
            COALESCE(SUM(CASE
              WHEN revenue_type != 'refund'
                AND revenue_type != 'payment_failed'
                AND paid_at >= date_trunc('month', CURRENT_DATE - INTERVAL '1 month')
                AND paid_at < date_trunc('month', CURRENT_DATE - INTERVAL '1 month') + (CURRENT_DATE - date_trunc('month', CURRENT_DATE))
              THEN amount_paid
              ELSE 0
            END), 0) as last_month_mtd_revenue,
            COALESCE(SUM(CASE
              WHEN revenue_type = 'subscription_recurring'
              THEN amount_paid
              ELSE 0
            END), 0) as recurring_revenue,
            COALESCE(SUM(CASE
              WHEN revenue_type IN ('one_time', 'subscription_initial')
              THEN amount_paid
              ELSE 0
            END), 0) as one_time_revenue
          FROM revenue_events
        `),

        // MRR from active subscriptions (based on most recent payment per subscription)
        pool.query(`
          WITH active_subscriptions AS (
            SELECT DISTINCT ON (stripe_subscription_id)
              stripe_subscription_id,
              amount_paid,
              billing_interval
            FROM revenue_events
            WHERE stripe_subscription_id IS NOT NULL
              AND revenue_type IN ('subscription_recurring', 'subscription_initial')
              AND period_end > NOW()
            ORDER BY stripe_subscription_id, paid_at DESC
          )
          SELECT
            COALESCE(SUM(CASE
              WHEN billing_interval = 'month' THEN amount_paid
              WHEN billing_interval = 'year' THEN amount_paid / 12.0
              ELSE 0
            END), 0) as mrr
          FROM active_subscriptions
        `),

        // Revenue by product
        pool.query(`
          SELECT
            product_name,
            COUNT(*) as count,
            SUM(amount_paid) as revenue
          FROM revenue_events
          WHERE revenue_type != 'refund'
            AND revenue_type != 'payment_failed'
            AND product_name IS NOT NULL
          GROUP BY product_name
          ORDER BY revenue DESC
        `),

        // Slack stats (consolidated)
        pool.query(`
          SELECT
            COALESCE(SUM(message_count), 0) as total_messages,
            COUNT(DISTINCT slack_user_id) as total_slack_users,
            COUNT(DISTINCT CASE WHEN activity_date >= CURRENT_DATE - INTERVAL '30 days' THEN slack_user_id END) as active_slack_users_30d,
            COALESCE(SUM(CASE WHEN activity_date >= CURRENT_DATE - INTERVAL '7 days' THEN message_count END), 0) as messages_7d,
            COALESCE(SUM(CASE WHEN activity_date >= CURRENT_DATE - INTERVAL '7 days' THEN reaction_count END), 0) as reactions_7d,
            COALESCE(SUM(CASE WHEN activity_date >= CURRENT_DATE - INTERVAL '7 days' THEN thread_reply_count END), 0) as threads_7d
          FROM slack_activity_daily
        `),

        // Addie thread stats
        pool.query(`
          SELECT
            COUNT(*) as total_threads,
            COALESCE(SUM(message_count), 0) as total_messages,
            COUNT(CASE WHEN started_at >= CURRENT_DATE - INTERVAL '30 days' THEN 1 END) as threads_30d
          FROM addie_threads
        `),

        // Addie ratings
        pool.query(`
          SELECT
            COUNT(*) as total_rated,
            COALESCE(AVG(rating), 0) as avg_rating,
            COUNT(CASE WHEN rating >= 4 THEN 1 END) as positive_ratings,
            COUNT(CASE WHEN rating <= 2 THEN 1 END) as negative_ratings
          FROM addie_thread_messages
          WHERE rating IS NOT NULL
        `),

        // User engagement stats
        pool.query(`
          SELECT
            COUNT(*) as total_users,
            COUNT(CASE WHEN engagement_score >= 30 THEN 1 END) as active_users,
            COUNT(CASE WHEN engagement_score >= 60 THEN 1 END) as engaged_users,
            COUNT(CASE WHEN excitement_score >= 75 THEN 1 END) as champions,
            COALESCE(AVG(engagement_score), 0) as avg_engagement
          FROM users
          WHERE engagement_score IS NOT NULL
        `),

        // Org lifecycle stats
        pool.query(`
          SELECT
            COUNT(*) as total_orgs,
            COUNT(CASE WHEN subscription_status = 'active' THEN 1 END) as active_orgs,
            COUNT(CASE WHEN org_lifecycle_stage = 'prospect' THEN 1 END) as prospects,
            COUNT(CASE WHEN org_lifecycle_stage = 'evaluating' THEN 1 END) as evaluating,
            COUNT(CASE WHEN org_lifecycle_stage = 'trial' THEN 1 END) as trials,
            COUNT(CASE WHEN org_lifecycle_stage = 'paying' THEN 1 END) as paying,
            COUNT(CASE WHEN org_lifecycle_stage IN ('evaluating', 'trial') AND engagement_score >= 50 THEN 1 END) as engaged_prospects
          FROM organizations
        `),

        // Recent bookings (last 30 days)
        pool.query(`
          SELECT
            COUNT(*) as booking_count,
            COALESCE(SUM(amount_paid), 0) as booking_revenue
          FROM revenue_events
          WHERE revenue_type IN ('subscription_initial', 'subscription_recurring', 'one_time')
            AND paid_at >= CURRENT_DATE - INTERVAL '30 days'
        `),

        // Bookings by month (last 6 months) for trend chart
        pool.query(`
          SELECT
            TO_CHAR(date_trunc('month', paid_at), 'Mon') as month,
            EXTRACT(MONTH FROM paid_at) as month_num,
            COUNT(*) as count,
            COALESCE(SUM(amount_paid), 0) as revenue
          FROM revenue_events
          WHERE revenue_type IN ('subscription_initial', 'subscription_recurring', 'one_time')
            AND paid_at >= date_trunc('month', CURRENT_DATE - INTERVAL '5 months')
          GROUP BY date_trunc('month', paid_at), TO_CHAR(date_trunc('month', paid_at), 'Mon'), EXTRACT(MONTH FROM paid_at)
          ORDER BY date_trunc('month', paid_at)
        `),

        // Slack activity by week (last 8 weeks) for trend chart
        pool.query(`
          SELECT
            date_trunc('week', activity_date)::date as week_start,
            COALESCE(SUM(message_count), 0) as messages,
            COUNT(DISTINCT slack_user_id) as active_users
          FROM slack_activity_daily
          WHERE activity_date >= CURRENT_DATE - INTERVAL '8 weeks'
          GROUP BY date_trunc('week', activity_date)
          ORDER BY week_start
        `),

        // Engagement trends - current vs previous period (30 days)
        pool.query(`
          SELECT
            COUNT(DISTINCT CASE WHEN activity_date >= CURRENT_DATE - INTERVAL '30 days' THEN slack_user_id END) as active_users_current,
            COUNT(DISTINCT CASE WHEN activity_date >= CURRENT_DATE - INTERVAL '60 days' AND activity_date < CURRENT_DATE - INTERVAL '30 days' THEN slack_user_id END) as active_users_previous,
            COALESCE(SUM(CASE WHEN activity_date >= CURRENT_DATE - INTERVAL '30 days' THEN message_count END), 0) as messages_current,
            COALESCE(SUM(CASE WHEN activity_date >= CURRENT_DATE - INTERVAL '60 days' AND activity_date < CURRENT_DATE - INTERVAL '30 days' THEN message_count END), 0) as messages_previous
          FROM slack_activity_daily
        `),

        // Addie engagement trends
        pool.query(`
          SELECT
            COUNT(CASE WHEN started_at >= CURRENT_DATE - INTERVAL '30 days' THEN 1 END) as threads_current,
            COUNT(CASE WHEN started_at >= CURRENT_DATE - INTERVAL '60 days' AND started_at < CURRENT_DATE - INTERVAL '30 days' THEN 1 END) as threads_previous
          FROM addie_threads
        `),
      ]);

      const members = memberStats.rows[0] || {};
      const revenue = revenueStats.rows[0] || {};
      const mrr = mrrStats.rows[0] || {};
      const slack = slackStats.rows[0] || {};
      const addie = addieStats.rows[0] || {};
      const ratings = addieRatings.rows[0] || {};
      const users = userStats.rows[0] || {};
      const orgs = orgStats.rows[0] || {};
      const bookings = recentBookings.rows[0] || {};
      const engagement = engagementTrends.rows[0] || {};
      const addieT = addieTrends.rows[0] || {};

      res.json({
        // Member stats
        total_members: parseInt(members.total_members) || 0,
        active_subscriptions: parseInt(members.active_subscriptions) || 0,
        expiring_this_month: parseInt(members.expiring_this_month) || 0,
        monthly_subscriptions: parseInt(members.monthly_subscriptions) || 0,
        annual_subscriptions: parseInt(members.annual_subscriptions) || 0,

        // Revenue stats
        total_revenue: formatCurrency(parseInt(revenue.total_revenue) || 0),
        total_refunds: formatCurrency(parseInt(revenue.total_refunds) || 0),
        current_month_revenue: formatCurrency(parseInt(revenue.current_month_revenue) || 0),
        monthly_revenue: formatCurrency(parseInt(revenue.current_month_revenue) || 0), // Alias for dashboard
        last_month_mtd_revenue: formatCurrency(parseInt(revenue.last_month_mtd_revenue) || 0),
        recurring_revenue: formatCurrency(parseInt(revenue.recurring_revenue) || 0),
        one_time_revenue: formatCurrency(parseInt(revenue.one_time_revenue) || 0),

        // MRR and ARR
        mrr: formatCurrency(parseFloat(mrr.mrr) || 0),
        arr: formatCurrency((parseFloat(mrr.mrr) || 0) * 12),

        // Recent bookings
        bookings_30d_count: parseInt(bookings.booking_count) || 0,
        bookings_30d_revenue: formatCurrency(parseInt(bookings.booking_revenue) || 0),

        // Revenue by product
        product_breakdown: productRevenue.rows.map((row: { product_name: string; count: string; revenue: string }) => ({
          product_name: row.product_name,
          count: String(parseInt(row.count) || 0),
          revenue: formatCurrency(parseInt(row.revenue) || 0),
        })),

        // Slack stats
        slack_total_messages: parseInt(slack.total_messages) || 0,
        slack_total_users: parseInt(slack.total_slack_users) || 0,
        slack_active_users_30d: parseInt(slack.active_slack_users_30d) || 0,
        slack_messages_7d: parseInt(slack.messages_7d) || 0,
        slack_reactions_7d: parseInt(slack.reactions_7d) || 0,
        slack_threads_7d: parseInt(slack.threads_7d) || 0,

        // Addie stats
        addie_total_threads: parseInt(addie.total_threads) || 0,
        addie_total_messages: parseInt(addie.total_messages) || 0,
        addie_threads_30d: parseInt(addie.threads_30d) || 0,
        addie_total_rated: parseInt(ratings.total_rated) || 0,
        addie_avg_rating: (parseFloat(ratings.avg_rating) || 0).toFixed(1),
        addie_positive_ratings: parseInt(ratings.positive_ratings) || 0,
        addie_negative_ratings: parseInt(ratings.negative_ratings) || 0,

        // User stats
        total_users: parseInt(users.total_users) || 0,
        active_users: parseInt(users.active_users) || 0,
        engaged_users: parseInt(users.engaged_users) || 0,
        champion_users: parseInt(users.champions) || 0,
        avg_engagement_score: (parseFloat(users.avg_engagement) || 0).toFixed(0),

        // Org stats
        total_orgs: parseInt(orgs.total_orgs) || 0,
        active_orgs: parseInt(orgs.active_orgs) || 0,
        prospects: parseInt(orgs.prospects) || 0,
        evaluating: parseInt(orgs.evaluating) || 0,
        trials: parseInt(orgs.trials) || 0,
        paying_orgs: parseInt(orgs.paying) || 0,
        engaged_prospects: parseInt(orgs.engaged_prospects) || 0,

        // Trend data for charts
        bookings_trend: bookingsByMonth.rows.map((row: { month: string; count: string; revenue: string }) => ({
          month: row.month,
          count: parseInt(row.count) || 0,
          revenue: Math.round((parseInt(row.revenue) || 0) / 100), // dollars, not cents
        })),

        slack_trend: slackByWeek.rows.map((row: { week_start: string; messages: string; active_users: string }) => ({
          week: row.week_start,
          messages: parseInt(row.messages) || 0,
          active_users: parseInt(row.active_users) || 0,
        })),

        // Period-over-period trends (current 30d vs previous 30d)
        trends: {
          active_users: {
            current: parseInt(engagement.active_users_current) || 0,
            previous: parseInt(engagement.active_users_previous) || 0,
          },
          messages: {
            current: parseInt(engagement.messages_current) || 0,
            previous: parseInt(engagement.messages_previous) || 0,
          },
          addie_threads: {
            current: parseInt(addieT.threads_current) || 0,
            previous: parseInt(addieT.threads_previous) || 0,
          },
          revenue: {
            current: parseInt(revenue.current_month_revenue) || 0,
            previous: parseInt(revenue.last_month_mtd_revenue) || 0,
          },
        },
      });
    } catch (error) {
      logger.error({ err: error }, "Error fetching admin stats");
      res.status(500).json({
        error: "Internal server error",
        message: "Unable to fetch admin statistics",
      });
    }
  });

  // GET /api/admin/my-prospects - Get prospects owned by current user
  apiRouter.get("/my-prospects", requireAuth, requireAdmin, async (req, res) => {
    try {
      const pool = getPool();
      const userId = req.user?.id;

      if (!userId) {
        return res.status(401).json({ error: "User not authenticated" });
      }

      // Get all stats in parallel
      const [hotProspects, needsFollowup, recentActivity, counts] = await Promise.all([
        // Hot prospects (engagement >= 30)
        pool.query(`
          SELECT
            o.workos_organization_id as org_id,
            o.name,
            o.email_domain,
            o.engagement_score,
            o.prospect_status,
            o.interest_level
          FROM organizations o
          JOIN org_stakeholders os ON os.organization_id = o.workos_organization_id
          WHERE os.user_id = $1
            AND os.role = 'owner'
            AND o.is_personal IS NOT TRUE
            AND (o.subscription_status IS NULL OR o.subscription_status != 'active')
            AND o.engagement_score >= 30
          ORDER BY o.engagement_score DESC
          LIMIT 5
        `, [userId]),

        // Needs follow-up (stale or overdue)
        pool.query(`
          WITH prospect_activity AS (
            SELECT
              o.workos_organization_id as org_id,
              o.name,
              o.email_domain,
              o.engagement_score,
              ns.description as next_step,
              ns.next_step_due_date,
              (SELECT MAX(activity_date) FROM org_activities WHERE organization_id = o.workos_organization_id) as last_activity,
              EXTRACT(DAY FROM NOW() - COALESCE(
                (SELECT MAX(activity_date) FROM org_activities WHERE organization_id = o.workos_organization_id),
                o.created_at
              )) as days_since_activity
            FROM organizations o
            JOIN org_stakeholders os ON os.organization_id = o.workos_organization_id
            LEFT JOIN LATERAL (
              SELECT description, next_step_due_date
              FROM org_activities
              WHERE organization_id = o.workos_organization_id
                AND is_next_step = TRUE
                AND next_step_completed_at IS NULL
              ORDER BY next_step_due_date ASC NULLS LAST
              LIMIT 1
            ) ns ON true
            WHERE os.user_id = $1
              AND os.role = 'owner'
              AND o.is_personal IS NOT TRUE
              AND (o.subscription_status IS NULL OR o.subscription_status != 'active')
          )
          SELECT *,
            CASE
              WHEN next_step_due_date IS NOT NULL AND next_step_due_date < CURRENT_DATE THEN 'overdue'
              WHEN days_since_activity >= 14 THEN 'stale'
            END as reason
          FROM prospect_activity
          WHERE (next_step_due_date IS NOT NULL AND next_step_due_date < CURRENT_DATE)
             OR days_since_activity >= 14
          ORDER BY
            CASE WHEN next_step_due_date IS NOT NULL AND next_step_due_date < CURRENT_DATE THEN 0 ELSE 1 END,
            days_since_activity DESC NULLS LAST
          LIMIT 5
        `, [userId]),

        // Recent activity on owned prospects
        pool.query(`
          SELECT
            oa.id,
            oa.organization_id as org_id,
            o.name as org_name,
            oa.activity_type,
            oa.description,
            oa.activity_date
          FROM org_activities oa
          JOIN organizations o ON o.workos_organization_id = oa.organization_id
          JOIN org_stakeholders os ON os.organization_id = oa.organization_id
          WHERE os.user_id = $1
            AND os.role = 'owner'
            AND oa.activity_date >= CURRENT_DATE - INTERVAL '30 days'
          ORDER BY oa.activity_date DESC
          LIMIT 5
        `, [userId]),

        // Counts
        pool.query(`
          SELECT
            COUNT(*) as total,
            COUNT(CASE WHEN o.engagement_score >= 30 THEN 1 END) as hot,
            COUNT(CASE
              WHEN EXISTS (
                SELECT 1 FROM org_activities
                WHERE organization_id = o.workos_organization_id
                  AND is_next_step = TRUE
                  AND next_step_completed_at IS NULL
                  AND next_step_due_date < CURRENT_DATE
              )
                OR EXTRACT(DAY FROM NOW() - COALESCE(
                  (SELECT MAX(activity_date) FROM org_activities WHERE organization_id = o.workos_organization_id),
                  o.created_at
                )) >= 14
              THEN 1
            END) as needs_followup
          FROM organizations o
          JOIN org_stakeholders os ON os.organization_id = o.workos_organization_id
          WHERE os.user_id = $1
            AND os.role = 'owner'
            AND o.is_personal IS NOT TRUE
            AND (o.subscription_status IS NULL OR o.subscription_status != 'active')
        `, [userId]),
      ]);

      res.json({
        hot_prospects: hotProspects.rows,
        needs_followup: needsFollowup.rows,
        recent_activity: recentActivity.rows,
        counts: {
          total: parseInt(counts.rows[0]?.total) || 0,
          hot: parseInt(counts.rows[0]?.hot) || 0,
          followup: parseInt(counts.rows[0]?.needs_followup) || 0,
        },
      });
    } catch (error) {
      logger.error({ err: error }, "Error fetching my prospects");
      res.status(500).json({
        error: "Internal server error",
        message: "Unable to fetch prospect data",
      });
    }
  });

  // GET /api/admin/member-search-analytics - Get member search analytics for admin dashboard
  apiRouter.get("/member-search-analytics", requireAuth, requireAdmin, async (req, res) => {
    try {
      const days = parseInt(req.query.days as string) || 30;
      const safeDays = Math.min(Math.max(days, 1), 365);

      // Get global analytics and recent introductions in parallel
      const [globalAnalytics, recentIntroductions] = await Promise.all([
        memberSearchAnalyticsDb.getGlobalAnalytics(safeDays),
        memberSearchAnalyticsDb.getRecentIntroductionsGlobal(20),
      ]);

      // Enrich top_members with profile info
      const enrichedTopMembers = await Promise.all(
        globalAnalytics.top_members.map(async (member) => {
          try {
            const profile = await memberDb.getProfileById(member.member_profile_id);
            return {
              ...member,
              display_name: profile?.display_name || 'Unknown',
              slug: profile?.slug || null,
            };
          } catch {
            return {
              ...member,
              display_name: 'Unknown',
              slug: null,
            };
          }
        })
      );

      // Enrich recent introductions with profile info
      const enrichedIntroductions = await Promise.all(
        recentIntroductions.map(async (intro) => {
          try {
            const profile = await memberDb.getProfileById(intro.member_profile_id);
            return {
              ...intro,
              member_display_name: profile?.display_name || 'Unknown',
              member_slug: profile?.slug || null,
            };
          } catch {
            return {
              ...intro,
              member_display_name: 'Unknown',
              member_slug: null,
            };
          }
        })
      );

      res.json({
        period_days: safeDays,
        summary: {
          total_searches: globalAnalytics.total_searches,
          total_impressions: globalAnalytics.total_impressions,
          total_clicks: globalAnalytics.total_clicks,
          total_intro_requests: globalAnalytics.total_intro_requests,
          total_intros_sent: globalAnalytics.total_intros_sent,
          unique_searchers: globalAnalytics.unique_searchers,
          click_rate: globalAnalytics.total_impressions > 0
            ? ((globalAnalytics.total_clicks / globalAnalytics.total_impressions) * 100).toFixed(1) + '%'
            : '0%',
          intro_rate: globalAnalytics.total_clicks > 0
            ? ((globalAnalytics.total_intro_requests / globalAnalytics.total_clicks) * 100).toFixed(1) + '%'
            : '0%',
        },
        top_queries: globalAnalytics.top_queries,
        top_members: enrichedTopMembers,
        recent_introductions: enrichedIntroductions,
      });
    } catch (error) {
      logger.error({ err: error }, "Error fetching member search analytics");
      res.status(500).json({
        error: "Internal server error",
        message: "Unable to fetch member search analytics",
      });
    }
  });

  // Shared label maps for membership metrics
  const COMPANY_TYPE_LABELS: Record<string, string> = {
    adtech: 'Ad Tech',
    agency: 'Agency',
    brand: 'Brand',
    publisher: 'Publisher',
    data: 'Data & Measurement',
    ai: 'AI & Tech Platforms',
    other: 'Other',
    unknown: 'Unknown',
  };

  const REVENUE_TIER_LABELS: Record<string, string> = {
    under_1m: '<$1M',
    '1m_5m': '$1M-$5M',
    '5m_50m': '$5M-$50M',
    '50m_250m': '$50M-$250M',
    '250m_1b': '$250M-$1B',
    '1b_plus': '$1B+',
    unknown: 'Unknown',
  };

  // Shared SQL fragments for membership metrics
  const PAYING_FILTER = `subscription_status = 'active' AND subscription_canceled_at IS NULL AND subscription_amount > 0`;
  const SUBSCRIBED_FILTER = `subscription_status IN ('active', 'past_due', 'trialing')`;

  // GET /api/admin/membership-metrics - Get membership metrics by company_type × revenue_tier
  // Returns current snapshot using existing category dimensions
  apiRouter.get("/membership-metrics", requireAuth, requireAdmin, async (req, res) => {
    try {
      const pool = getPool();

      // Run all queries in parallel for better performance
      const [byTypeResult, byTierResult, matrixResult, individualsResult, totalsResult] = await Promise.all([
        // Get metrics by company_type
        pool.query(`
          SELECT
            COALESCE(company_type, 'unknown') AS company_type,
            COUNT(*) AS total_orgs,
            COUNT(*) FILTER (WHERE ${PAYING_FILTER}) AS paying_members,
            COUNT(*) FILTER (WHERE ${SUBSCRIBED_FILTER}) AS subscribed,
            COALESCE(SUM(subscription_amount) FILTER (WHERE ${PAYING_FILTER}), 0) AS arr_cents
          FROM organizations
          WHERE is_personal IS NOT TRUE
          GROUP BY company_type
          ORDER BY
            CASE company_type
              WHEN 'adtech' THEN 1
              WHEN 'agency' THEN 2
              WHEN 'brand' THEN 3
              WHEN 'publisher' THEN 4
              WHEN 'data' THEN 5
              WHEN 'ai' THEN 6
              WHEN 'other' THEN 7
              ELSE 8
            END
        `),

        // Get metrics by revenue_tier
        pool.query(`
          SELECT
            COALESCE(revenue_tier, 'unknown') AS revenue_tier,
            COUNT(*) AS total_orgs,
            COUNT(*) FILTER (WHERE ${PAYING_FILTER}) AS paying_members,
            COUNT(*) FILTER (WHERE ${SUBSCRIBED_FILTER}) AS subscribed,
            COALESCE(SUM(subscription_amount) FILTER (WHERE ${PAYING_FILTER}), 0) AS arr_cents
          FROM organizations
          WHERE is_personal IS NOT TRUE
          GROUP BY revenue_tier
          ORDER BY
            CASE revenue_tier
              WHEN 'under_1m' THEN 1
              WHEN '1m_5m' THEN 2
              WHEN '5m_50m' THEN 3
              WHEN '50m_250m' THEN 4
              WHEN '250m_1b' THEN 5
              WHEN '1b_plus' THEN 6
              ELSE 7
            END
        `),

        // Get the full matrix: company_type × revenue_tier
        pool.query(`
          SELECT
            COALESCE(company_type, 'unknown') AS company_type,
            COALESCE(revenue_tier, 'unknown') AS revenue_tier,
            COUNT(*) AS total_orgs,
            COUNT(*) FILTER (WHERE ${PAYING_FILTER}) AS paying_members,
            COUNT(*) FILTER (WHERE ${SUBSCRIBED_FILTER}) AS subscribed,
            COALESCE(SUM(subscription_amount) FILTER (WHERE ${PAYING_FILTER}), 0) AS arr_cents
          FROM organizations
          WHERE is_personal IS NOT TRUE
          GROUP BY company_type, revenue_tier
          ORDER BY company_type, revenue_tier
        `),

        // Get individuals (personal workspaces) separately
        pool.query(`
          SELECT
            COUNT(*) AS total_orgs,
            COUNT(*) FILTER (WHERE ${PAYING_FILTER}) AS paying_members,
            COUNT(*) FILTER (WHERE ${SUBSCRIBED_FILTER}) AS subscribed,
            COALESCE(SUM(subscription_amount) FILTER (WHERE ${PAYING_FILTER}), 0) AS arr_cents
          FROM organizations
          WHERE is_personal = TRUE
        `),

        // Get totals
        pool.query(`
          SELECT
            COUNT(*) AS total_orgs,
            COUNT(*) FILTER (WHERE ${PAYING_FILTER}) AS paying_members,
            COUNT(*) FILTER (WHERE ${SUBSCRIBED_FILTER}) AS subscribed,
            COALESCE(SUM(subscription_amount) FILTER (WHERE ${PAYING_FILTER}), 0) AS arr_cents
          FROM organizations
        `),
      ]);

      const formatRow = (row: { total_orgs: string; paying_members: string; subscribed: string; arr_cents: string }) => ({
        total_orgs: parseInt(row.total_orgs) || 0,
        paying_members: parseInt(row.paying_members) || 0,
        subscribed: parseInt(row.subscribed) || 0,
        arr_cents: parseInt(row.arr_cents) || 0,
        arr_dollars: Math.round((parseInt(row.arr_cents) || 0) / 100),
      });

      res.json({
        by_company_type: byTypeResult.rows.map(row => ({
          company_type: row.company_type,
          label: COMPANY_TYPE_LABELS[row.company_type] || row.company_type,
          ...formatRow(row),
        })),
        by_revenue_tier: byTierResult.rows.map(row => ({
          revenue_tier: row.revenue_tier,
          label: REVENUE_TIER_LABELS[row.revenue_tier] || row.revenue_tier,
          ...formatRow(row),
        })),
        matrix: matrixResult.rows.map(row => ({
          company_type: row.company_type,
          company_type_label: COMPANY_TYPE_LABELS[row.company_type] || row.company_type,
          revenue_tier: row.revenue_tier,
          revenue_tier_label: REVENUE_TIER_LABELS[row.revenue_tier] || row.revenue_tier,
          ...formatRow(row),
        })),
        individuals: formatRow(individualsResult.rows[0] || { total_orgs: '0', paying_members: '0', subscribed: '0', arr_cents: '0' }),
        totals: formatRow(totalsResult.rows[0] || { total_orgs: '0', paying_members: '0', subscribed: '0', arr_cents: '0' }),
        labels: {
          company_types: COMPANY_TYPE_LABELS,
          revenue_tiers: REVENUE_TIER_LABELS,
        },
      });
    } catch (error) {
      logger.error({ err: error }, "Error fetching membership metrics");
      res.status(500).json({
        error: "Internal server error",
        message: "Unable to fetch membership metrics",
      });
    }
  });

  // Escape CSV values to prevent CSV injection and handle special characters
  function escapeCsvValue(value: string | number): string {
    const str = String(value);
    // If value contains comma, quote, newline, or starts with formula chars, escape it
    if (/[,"\n\r]/.test(str) || /^[=+\-@\t\r]/.test(str)) {
      // Wrap in quotes and escape any quotes, prefix formula chars with single quote
      const escaped = str.replace(/"/g, '""');
      const prefixed = /^[=+\-@\t\r]/.test(escaped) ? `'${escaped}` : escaped;
      return `"${prefixed}"`;
    }
    return str;
  }

  // GET /api/admin/membership-metrics/csv - Export membership metrics as CSV
  apiRouter.get("/membership-metrics/csv", requireAuth, requireAdmin, async (req, res) => {
    try {
      const pool = getPool();

      // Get the full matrix for CSV export
      const result = await pool.query(`
        SELECT
          COALESCE(company_type, 'unknown') AS company_type,
          COALESCE(revenue_tier, 'unknown') AS revenue_tier,
          COUNT(*) AS total_orgs,
          COUNT(*) FILTER (WHERE ${PAYING_FILTER}) AS paying_members,
          COUNT(*) FILTER (WHERE ${SUBSCRIBED_FILTER}) AS subscribed,
          ROUND(COALESCE(SUM(subscription_amount) FILTER (WHERE ${PAYING_FILTER}), 0) / 100.0, 2) AS arr_dollars
        FROM organizations
        WHERE is_personal IS NOT TRUE
        GROUP BY company_type, revenue_tier
        ORDER BY
          CASE company_type
            WHEN 'adtech' THEN 1 WHEN 'agency' THEN 2 WHEN 'brand' THEN 3
            WHEN 'publisher' THEN 4 WHEN 'data' THEN 5 WHEN 'ai' THEN 6
            WHEN 'other' THEN 7 ELSE 8
          END,
          CASE revenue_tier
            WHEN 'under_1m' THEN 1 WHEN '1m_5m' THEN 2 WHEN '5m_50m' THEN 3
            WHEN '50m_250m' THEN 4 WHEN '250m_1b' THEN 5 WHEN '1b_plus' THEN 6
            ELSE 7
          END
      `);

      const headers = ['Company Type', 'Revenue Tier', 'Total Orgs', 'Paying Members', 'Subscribed', 'ARR ($)'];
      const rows = result.rows.map(row => [
        escapeCsvValue(COMPANY_TYPE_LABELS[row.company_type] || row.company_type),
        escapeCsvValue(REVENUE_TIER_LABELS[row.revenue_tier] || row.revenue_tier),
        row.total_orgs,
        row.paying_members,
        row.subscribed,
        row.arr_dollars || 0,
      ].join(','));

      const csv = [headers.join(','), ...rows].join('\n');

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="membership-metrics-${new Date().toISOString().split('T')[0]}.csv"`);
      res.send(csv);
    } catch (error) {
      logger.error({ err: error }, "Error exporting membership metrics CSV");
      res.status(500).json({
        error: "Internal server error",
        message: "Unable to export membership metrics",
      });
    }
  });
}
