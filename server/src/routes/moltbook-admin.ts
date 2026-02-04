/**
 * Moltbook Admin Routes
 *
 * Admin routes for viewing Addie's Moltbook activity, decisions, and configuration.
 */

import { Router } from "express";
import { createLogger } from "../logger.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";
import { serveHtmlWithConfig } from "../utils/html-config.js";
import {
  getActivityStats,
  getRecentDecisions,
  getDecisionStats,
  getRecentActivityWithDecisions,
  type DecisionType,
  type DecisionOutcome,
} from "../db/moltbook-db.js";
import { runMoltbookEngagementJob, SEARCH_TERMS } from "../addie/jobs/moltbook-engagement.js";
import { runMoltbookPosterJob } from "../addie/jobs/moltbook-poster.js";
import { query } from "../db/client.js";
import { searchPosts, getSubmolts, getFeed, isMoltbookEnabled } from "../addie/services/moltbook-service.js";

const logger = createLogger("moltbook-admin-routes");

// Valid enum values for input validation
const VALID_DECISION_TYPES = ['relevance', 'comment', 'upvote', 'reply', 'share', 'follow'] as const;
const VALID_OUTCOMES = ['engaged', 'skipped'] as const;

// Helper for parsing bounded positive integers
function parsePositiveInt(value: unknown, defaultValue: number, maxValue: number): number {
  if (typeof value !== 'string') return defaultValue;
  const parsed = parseInt(value, 10);
  if (isNaN(parsed) || parsed < 0) return defaultValue;
  return Math.min(parsed, maxValue);
}

/**
 * Create Moltbook admin routes
 * Returns separate routers for page routes (/admin/moltbook) and API routes (/api/admin/moltbook/*)
 */
export function createMoltbookAdminRouter(): { pageRouter: Router; apiRouter: Router } {
  const pageRouter = Router();
  const apiRouter = Router();

  // =========================================================================
  // PAGE ROUTES (mounted at /admin/moltbook)
  // =========================================================================

  pageRouter.get("/", requireAuth, requireAdmin, (req, res) => {
    serveHtmlWithConfig(req, res, "admin-moltbook.html").catch((err) => {
      logger.error({ err }, "Error serving Moltbook admin page");
      res.status(500).send("Internal server error");
    });
  });

  // =========================================================================
  // STATS API (mounted at /api/admin/moltbook)
  // =========================================================================

  // GET /api/admin/moltbook/stats - Get overall activity and decision stats
  apiRouter.get("/stats", requireAuth, requireAdmin, async (req, res) => {
    try {
      const [activityStats, decisionStats] = await Promise.all([
        getActivityStats(),
        getDecisionStats(7),
      ]);

      res.json({
        activity: activityStats,
        decisions: decisionStats,
      });
    } catch (error) {
      logger.error({ err: error }, "Error fetching Moltbook stats");
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // =========================================================================
  // ACTIVITY API
  // =========================================================================

  // GET /api/admin/moltbook/activity - Get recent activity with linked decisions
  apiRouter.get("/activity", requireAuth, requireAdmin, async (req, res) => {
    try {
      const limit = parsePositiveInt(req.query.limit, 50, 200);
      const activities = await getRecentActivityWithDecisions(limit);
      res.json({ activities });
    } catch (error) {
      logger.error({ err: error }, "Error fetching Moltbook activity");
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // =========================================================================
  // DECISIONS API
  // =========================================================================

  // GET /api/admin/moltbook/decisions - Get recent decisions with filtering
  apiRouter.get("/decisions", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { type, outcome } = req.query;
      const limit = parsePositiveInt(req.query.limit, 50, 200);
      const offset = parsePositiveInt(req.query.offset, 0, 10000);

      // Validate enum values
      const validatedType = typeof type === 'string' && VALID_DECISION_TYPES.includes(type as DecisionType)
        ? type as DecisionType
        : undefined;
      const validatedOutcome = typeof outcome === 'string' && VALID_OUTCOMES.includes(outcome as DecisionOutcome)
        ? outcome as DecisionOutcome
        : undefined;

      const decisions = await getRecentDecisions({
        limit,
        offset,
        decisionType: validatedType,
        outcome: validatedOutcome,
      });
      res.json({ decisions });
    } catch (error) {
      logger.error({ err: error }, "Error fetching Moltbook decisions");
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // =========================================================================
  // CONFIGURATION API
  // =========================================================================

  // GET /api/admin/moltbook/config - Get current configuration and rate limit status
  apiRouter.get("/config", requireAuth, requireAdmin, async (req, res) => {
    try {
      // Get rate limit status from the database
      const [recentPosts, todayComments, todayUpvotes] = await Promise.all([
        query<{ count: string }>(
          `SELECT COUNT(*) as count FROM moltbook_activity
           WHERE activity_type = 'post' AND created_at > NOW() - INTERVAL '30 minutes'`
        ),
        query<{ count: string }>(
          `SELECT COUNT(*) as count FROM moltbook_activity
           WHERE activity_type = 'comment' AND created_at > CURRENT_DATE`
        ),
        query<{ count: string }>(
          `SELECT COUNT(*) as count FROM moltbook_activity
           WHERE activity_type = 'upvote' AND created_at > CURRENT_DATE`
        ),
      ]);

      res.json({
        searchTerms: SEARCH_TERMS,
        rateLimits: {
          posts: {
            windowMinutes: 30,
            limit: 1,
            current: parseInt(recentPosts.rows[0].count),
          },
          comments: {
            windowSeconds: 20,
            dailyLimit: 50,
            currentDaily: parseInt(todayComments.rows[0].count),
          },
          upvotes: {
            dailyLimit: 20,
            currentDaily: parseInt(todayUpvotes.rows[0].count),
          },
        },
        schedules: {
          poster: { intervalHours: 2, description: 'Posts curated articles' },
          engagement: { intervalHours: 1, description: 'Searches for threads, comments, gives karma' },
        },
        enabled: isMoltbookEnabled(),
      });
    } catch (error) {
      logger.error({ err: error }, "Error fetching Moltbook config");
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // =========================================================================
  // MANUAL TRIGGERS
  // =========================================================================

  // POST /api/admin/moltbook/trigger/engagement - Manually run engagement job
  apiRouter.post("/trigger/engagement", requireAuth, requireAdmin, async (req, res) => {
    try {
      const adminEmail = req.user?.email || 'unknown';
      logger.info({ admin: adminEmail }, "Manual trigger: Moltbook engagement job");

      const result = await runMoltbookEngagementJob({ limit: 5 });
      res.json({ success: true, result });
    } catch (error) {
      logger.error({ err: error }, "Error running Moltbook engagement job");
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /api/admin/moltbook/trigger/poster - Manually run poster job
  apiRouter.post("/trigger/poster", requireAuth, requireAdmin, async (req, res) => {
    try {
      const adminEmail = req.user?.email || 'unknown';
      logger.info({ admin: adminEmail }, "Manual trigger: Moltbook poster job");

      const result = await runMoltbookPosterJob({ limit: 1 });
      res.json({ success: true, result });
    } catch (error) {
      logger.error({ err: error }, "Error running Moltbook poster job");
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // =========================================================================
  // DEBUG/TEST ENDPOINTS
  // =========================================================================

  // GET /api/admin/moltbook/test/submolts - List all available submolts
  apiRouter.get("/test/submolts", requireAuth, requireAdmin, async (_req, res) => {
    try {
      const submolts = await getSubmolts();
      res.json({ submolts });
    } catch (error) {
      logger.error({ err: error }, "Error fetching submolts");
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /api/admin/moltbook/test/search?q=<term> - Test search with a specific term
  // Note: These test endpoints count against the 100 req/min rate limit
  apiRouter.get("/test/search", requireAuth, requireAdmin, async (req, res) => {
    try {
      const rawQ = typeof req.query.q === 'string' ? req.query.q : 'advertising';
      const q = rawQ.substring(0, 200);
      const limit = parsePositiveInt(req.query.limit, 10, 50);

      logger.debug({ q, limit }, "Testing Moltbook search");
      const result = await searchPosts(q, limit);

      res.json({
        query: q,
        resultCount: result.posts.length,
        posts: result.posts.map(p => ({
          id: p.id,
          title: p.title,
          submolt: p.submolt,
          author: p.author.name,
          score: p.score,
          commentCount: p.comment_count,
          createdAt: p.created_at,
        })),
        similarityScores: result.similarity_scores,
      });
    } catch (error) {
      logger.error({ err: error }, "Error testing Moltbook search");
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /api/admin/moltbook/test/feed?submolt=<name>&sort=<hot|new|top> - Get feed from a submolt
  apiRouter.get("/test/feed", requireAuth, requireAdmin, async (req, res) => {
    try {
      const submolt = typeof req.query.submolt === 'string' ? req.query.submolt : undefined;
      const sort = req.query.sort === 'new' || req.query.sort === 'top' || req.query.sort === 'rising'
        ? req.query.sort
        : 'hot';
      const limit = parsePositiveInt(req.query.limit, 25, 50);

      logger.info({ submolt, sort, limit }, "Testing Moltbook feed");
      const result = await getFeed(sort, submolt, limit);

      res.json({
        submolt: submolt || '(all)',
        sort,
        resultCount: result.posts.length,
        posts: result.posts.map(p => ({
          id: p.id,
          title: p.title,
          submolt: p.submolt,
          author: p.author.name,
          score: p.score,
          commentCount: p.comment_count,
          createdAt: p.created_at,
        })),
      });
    } catch (error) {
      logger.error({ err: error }, "Error testing Moltbook feed");
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return { pageRouter, apiRouter };
}
