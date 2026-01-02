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
                AND paid_at < date_trunc('month', CURRENT_DATE)
              THEN amount_paid
              ELSE 0
            END), 0) as last_month_revenue,
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

        // MRR from active subscriptions
        pool.query(`
          SELECT
            COALESCE(SUM(CASE
              WHEN subscription_interval = 'month'
              THEN subscription_amount
              WHEN subscription_interval = 'year'
              THEN subscription_amount / 12.0
              ELSE 0
            END), 0) as mrr
          FROM organizations
          WHERE subscription_amount IS NOT NULL
            AND subscription_current_period_end > NOW()
            AND subscription_canceled_at IS NULL
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
        last_month_revenue: formatCurrency(parseInt(revenue.last_month_revenue) || 0),
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
            previous: parseInt(revenue.last_month_revenue) || 0,
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
}
