/**
 * Latest content routes module
 *
 * Public routes for the "The Latest" section that displays curated content
 * from notification channels as website sections.
 */

import { Router, type Request, type Response } from "express";
import { createLogger } from "../logger.js";
import { serveHtmlWithConfig } from "../utils/html-config.js";
import {
  getWebsiteChannels,
  getChannelByWebsiteSlug,
  type NotificationChannel,
} from "../db/notification-channels-db.js";
import { query } from "../db/client.js";
import { getTrendingCompanies, getArticlesByEntity, getArticlesByOrganization } from "../addie/services/entity-linker.js";
import { getArticleComments, addWebComment } from "../addie/services/article-comments.js";
import { optionalAuth, requireAuth } from "../middleware/auth.js";

const logger = createLogger("latest-routes");

// Article type for API responses
interface LatestArticle {
  id: number;
  title: string;
  source_url: string;
  summary: string | null;
  addie_notes: string | null;
  quality_score: number | null;
  relevance_tags: string[];
  feed_name: string | null;
  published_at: string | null;
  created_at: string;
  comment_count?: number;
  view_count?: number;
  trending_score?: number;
}

// Entity type for article responses
interface ArticleEntity {
  entity_type: string;
  entity_name: string;
  organization_id: string | null;
  is_primary: boolean;
}

// Section type for API responses
interface LatestSection {
  slug: string;
  name: string;
  description: string;
  article_count: number;
}

/**
 * Create latest content routes
 */
export function createLatestRouter(): {
  pageRouter: Router;
  apiRouter: Router;
} {
  const pageRouter = Router();
  const apiRouter = Router();

  // =========================================================================
  // PAGE ROUTES (mounted at /)
  // =========================================================================

  // Landing page showing all sections
  pageRouter.get("/latest", (req, res) => {
    serveHtmlWithConfig(req, res, "latest/index.html").catch((err) => {
      logger.error({ err }, "Error serving latest landing page");
      res.status(500).send("Internal server error");
    });
  });

  // Section detail page
  pageRouter.get("/latest/:slug", (req, res) => {
    serveHtmlWithConfig(req, res, "latest/section.html").catch((err) => {
      logger.error({ err }, "Error serving latest section page");
      res.status(500).send("Internal server error");
    });
  });

  // =========================================================================
  // API ROUTES (mounted at /api)
  // =========================================================================

  /**
   * GET /api/latest/sections
   * List all website sections with article counts
   */
  apiRouter.get("/latest/sections", async (req: Request, res: Response) => {
    try {
      const channels = await getWebsiteChannels();

      // Get article counts for each channel
      const sections: LatestSection[] = await Promise.all(
        channels.map(async (channel) => {
          const countResult = await query<{ count: string }>(
            `SELECT COUNT(*) as count
             FROM addie_knowledge k
             WHERE k.fetch_status = 'success'
               AND k.publication_status != 'rejected'
               AND (
                 -- Check human override first, then AI routing
                 $1 = ANY(COALESCE(k.human_routing_override, k.notification_channel_ids))
               )
               AND COALESCE(k.human_quality_override, k.quality_score) >= COALESCE(($2::jsonb->>'min_quality')::int, 0)`,
            [channel.slack_channel_id, JSON.stringify(channel.fallback_rules)]
          );

          return {
            slug: channel.website_slug!,
            name: channel.name,
            description: channel.description,
            article_count: parseInt(countResult.rows[0]?.count || "0", 10),
          };
        })
      );

      res.json({ sections });
    } catch (error) {
      logger.error({ error }, "Error fetching latest sections");
      res.status(500).json({ error: "Failed to fetch sections" });
    }
  });

  /**
   * GET /api/latest/sections/:slug
   * Get section details by slug
   */
  apiRouter.get("/latest/sections/:slug", async (req: Request, res: Response) => {
    try {
      const { slug } = req.params;
      const channel = await getChannelByWebsiteSlug(slug);

      if (!channel) {
        return res.status(404).json({ error: "Section not found" });
      }

      // Get article count
      const countResult = await query<{ count: string }>(
        `SELECT COUNT(*) as count
         FROM addie_knowledge k
         WHERE k.fetch_status = 'success'
           AND k.publication_status != 'rejected'
           AND (
             $1 = ANY(COALESCE(k.human_routing_override, k.notification_channel_ids))
           )
           AND COALESCE(k.human_quality_override, k.quality_score) >= COALESCE(($2::jsonb->>'min_quality')::int, 0)`,
        [channel.slack_channel_id, JSON.stringify(channel.fallback_rules)]
      );

      const section: LatestSection = {
        slug: channel.website_slug!,
        name: channel.name,
        description: channel.description,
        article_count: parseInt(countResult.rows[0]?.count || "0", 10),
      };

      res.json({ section });
    } catch (error) {
      logger.error({ error }, "Error fetching section details");
      res.status(500).json({ error: "Failed to fetch section" });
    }
  });

  /**
   * GET /api/latest/sections/:slug/articles
   * Get paginated articles for a section
   */
  apiRouter.get("/latest/sections/:slug/articles", async (req: Request, res: Response) => {
    try {
      const { slug } = req.params;
      const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 20, 1), 50);
      const offset = Math.max(parseInt(req.query.offset as string) || 0, 0);

      const channel = await getChannelByWebsiteSlug(slug);

      if (!channel) {
        return res.status(404).json({ error: "Section not found" });
      }

      // Get articles routed to this channel
      const result = await query<LatestArticle & { human_quality_override: number | null }>(
        `SELECT
           k.id,
           k.title,
           k.source_url,
           k.summary,
           k.addie_notes,
           COALESCE(k.human_quality_override, k.quality_score) as quality_score,
           k.relevance_tags,
           f.name as feed_name,
           k.published_at,
           k.created_at
         FROM addie_knowledge k
         LEFT JOIN perspectives p ON k.source_url = p.external_url
         LEFT JOIN industry_feeds f ON p.feed_id = f.id
         WHERE k.fetch_status = 'success'
           AND k.publication_status != 'rejected'
           AND (
             $1 = ANY(COALESCE(k.human_routing_override, k.notification_channel_ids))
           )
           AND COALESCE(k.human_quality_override, k.quality_score) >= COALESCE(($2::jsonb->>'min_quality')::int, 0)
         ORDER BY
           CASE WHEN k.publication_status = 'featured' THEN 0 ELSE 1 END,
           COALESCE(k.published_at, k.created_at) DESC
         LIMIT $3 OFFSET $4`,
        [channel.slack_channel_id, JSON.stringify(channel.fallback_rules), limit, offset]
      );

      // Get total count for pagination
      const countResult = await query<{ count: string }>(
        `SELECT COUNT(*) as count
         FROM addie_knowledge k
         WHERE k.fetch_status = 'success'
           AND k.publication_status != 'rejected'
           AND (
             $1 = ANY(COALESCE(k.human_routing_override, k.notification_channel_ids))
           )
           AND COALESCE(k.human_quality_override, k.quality_score) >= COALESCE(($2::jsonb->>'min_quality')::int, 0)`,
        [channel.slack_channel_id, JSON.stringify(channel.fallback_rules)]
      );

      const total = parseInt(countResult.rows[0]?.count || "0", 10);

      res.json({
        articles: result.rows,
        pagination: {
          total,
          limit,
          offset,
          has_more: offset + result.rows.length < total,
        },
      });
    } catch (error) {
      logger.error({ error }, "Error fetching section articles");
      res.status(500).json({ error: "Failed to fetch articles" });
    }
  });

  /**
   * GET /api/latest/featured
   * Get featured/recent articles across all sections
   */
  apiRouter.get("/latest/featured", async (req: Request, res: Response) => {
    try {
      const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 10, 1), 20);

      // Get recent high-quality articles from any website-enabled channel
      const result = await query<LatestArticle & { section_slug: string; section_name: string }>(
        `SELECT
           k.id,
           k.title,
           k.source_url,
           k.summary,
           k.addie_notes,
           COALESCE(k.human_quality_override, k.quality_score) as quality_score,
           k.relevance_tags,
           f.name as feed_name,
           k.published_at,
           k.created_at,
           nc.website_slug as section_slug,
           nc.name as section_name
         FROM addie_knowledge k
         LEFT JOIN perspectives p ON k.source_url = p.external_url
         LEFT JOIN industry_feeds f ON p.feed_id = f.id
         CROSS JOIN LATERAL (
           SELECT nc.*
           FROM notification_channels nc
           WHERE nc.website_enabled = true
             AND nc.is_active = true
             AND nc.slack_channel_id = ANY(COALESCE(k.human_routing_override, k.notification_channel_ids))
           LIMIT 1
         ) nc
         WHERE k.fetch_status = 'success'
           AND k.publication_status != 'rejected'
           AND COALESCE(k.human_quality_override, k.quality_score) >= 3
         ORDER BY
           CASE WHEN k.publication_status = 'featured' THEN 0 ELSE 1 END,
           COALESCE(k.published_at, k.created_at) DESC
         LIMIT $1`,
        [limit]
      );

      res.json({ articles: result.rows });
    } catch (error) {
      logger.error({ error }, "Error fetching featured articles");
      res.status(500).json({ error: "Failed to fetch featured articles" });
    }
  });

  // =========================================================================
  // TRENDING TAB ENDPOINTS
  // =========================================================================

  /**
   * GET /api/latest/trending
   * Get trending articles (by trending_score)
   */
  apiRouter.get("/latest/trending", async (req: Request, res: Response) => {
    try {
      const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 20, 1), 50);
      const offset = Math.max(parseInt(req.query.offset as string) || 0, 0);

      const result = await query<LatestArticle & { section_slug: string; section_name: string }>(
        `SELECT
           k.id,
           k.title,
           k.source_url,
           k.summary,
           k.addie_notes,
           COALESCE(k.human_quality_override, k.quality_score) as quality_score,
           k.relevance_tags,
           f.name as feed_name,
           k.published_at,
           k.created_at,
           k.comment_count,
           k.trending_score,
           nc.website_slug as section_slug,
           nc.name as section_name
         FROM addie_knowledge k
         LEFT JOIN perspectives p ON k.source_url = p.external_url
         LEFT JOIN industry_feeds f ON p.feed_id = f.id
         LEFT JOIN LATERAL (
           SELECT nc.*
           FROM notification_channels nc
           WHERE nc.website_enabled = true
             AND nc.is_active = true
             AND nc.slack_channel_id = ANY(COALESCE(k.human_routing_override, k.notification_channel_ids))
           LIMIT 1
         ) nc ON true
         WHERE k.fetch_status = 'success'
           AND k.publication_status != 'rejected'
           AND k.created_at > NOW() - INTERVAL '7 days'
         ORDER BY k.trending_score DESC NULLS LAST
         LIMIT $1 OFFSET $2`,
        [limit, offset]
      );

      res.json({ articles: result.rows });
    } catch (error) {
      logger.error({ error }, "Error fetching trending articles");
      res.status(500).json({ error: "Failed to fetch trending articles" });
    }
  });

  /**
   * GET /api/latest/trending-companies
   * Get trending companies for sidebar
   */
  apiRouter.get("/latest/trending-companies", async (req: Request, res: Response) => {
    try {
      const days = Math.min(Math.max(parseInt(req.query.days as string) || 7, 1), 30);
      const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 10, 1), 20);

      const companies = await getTrendingCompanies(days, limit);
      res.json({ companies });
    } catch (error) {
      logger.error({ error }, "Error fetching trending companies");
      res.status(500).json({ error: "Failed to fetch trending companies" });
    }
  });

  // =========================================================================
  // WATCH TAB ENDPOINTS (requires auth)
  // =========================================================================

  /**
   * GET /api/latest/watch
   * Get user's saved articles
   */
  apiRouter.get("/latest/watch", requireAuth, async (req: Request, res: Response) => {
    try {
      const user = req.user!;
      const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 20, 1), 50);
      const offset = Math.max(parseInt(req.query.offset as string) || 0, 0);

      const result = await query<LatestArticle & { saved_at: string }>(
        `SELECT
           k.id,
           k.title,
           k.source_url,
           k.summary,
           k.addie_notes,
           COALESCE(k.human_quality_override, k.quality_score) as quality_score,
           k.relevance_tags,
           f.name as feed_name,
           k.published_at,
           k.created_at,
           k.comment_count,
           w.created_at as saved_at
         FROM user_watchlist w
         JOIN addie_knowledge k ON k.id = w.knowledge_id
         LEFT JOIN perspectives p ON k.source_url = p.external_url
         LEFT JOIN industry_feeds f ON p.feed_id = f.id
         WHERE w.workos_user_id = $1
         ORDER BY w.created_at DESC
         LIMIT $2 OFFSET $3`,
        [user.id, limit, offset]
      );

      res.json({ articles: result.rows });
    } catch (error) {
      logger.error({ error }, "Error fetching watch list");
      res.status(500).json({ error: "Failed to fetch watch list" });
    }
  });

  /**
   * POST /api/latest/watch/:knowledgeId
   * Save an article to watch list
   */
  apiRouter.post("/latest/watch/:knowledgeId", requireAuth, async (req: Request, res: Response) => {
    try {
      const user = req.user!;
      const knowledgeId = parseInt(req.params.knowledgeId);
      if (isNaN(knowledgeId)) {
        return res.status(400).json({ error: "Invalid article ID" });
      }

      await query(
        `INSERT INTO user_watchlist (workos_user_id, knowledge_id)
         VALUES ($1, $2)
         ON CONFLICT (workos_user_id, knowledge_id) DO NOTHING`,
        [user.id, knowledgeId]
      );

      res.json({ success: true });
    } catch (error) {
      logger.error({ error }, "Error saving article to watch list");
      res.status(500).json({ error: "Failed to save article" });
    }
  });

  /**
   * DELETE /api/latest/watch/:knowledgeId
   * Remove an article from watch list
   */
  apiRouter.delete("/latest/watch/:knowledgeId", requireAuth, async (req: Request, res: Response) => {
    try {
      const user = req.user!;
      const knowledgeId = parseInt(req.params.knowledgeId);
      if (isNaN(knowledgeId)) {
        return res.status(400).json({ error: "Invalid article ID" });
      }

      await query(
        `DELETE FROM user_watchlist
         WHERE workos_user_id = $1 AND knowledge_id = $2`,
        [user.id, knowledgeId]
      );

      res.json({ success: true });
    } catch (error) {
      logger.error({ error }, "Error removing article from watch list");
      res.status(500).json({ error: "Failed to remove article" });
    }
  });

  // =========================================================================
  // CALENDAR TAB ENDPOINT
  // =========================================================================

  /**
   * GET /api/latest/calendar
   * Get articles grouped by publication date
   */
  apiRouter.get("/latest/calendar", async (req: Request, res: Response) => {
    try {
      const year = parseInt(req.query.year as string) || new Date().getFullYear();
      const month = parseInt(req.query.month as string) || new Date().getMonth() + 1;

      // Get article counts by day for the given month
      const result = await query<{ date: string; count: string }>(
        `SELECT
           DATE(COALESCE(k.published_at, k.created_at)) as date,
           COUNT(*) as count
         FROM addie_knowledge k
         WHERE k.fetch_status = 'success'
           AND k.publication_status != 'rejected'
           AND EXTRACT(YEAR FROM COALESCE(k.published_at, k.created_at)) = $1
           AND EXTRACT(MONTH FROM COALESCE(k.published_at, k.created_at)) = $2
         GROUP BY DATE(COALESCE(k.published_at, k.created_at))
         ORDER BY date`,
        [year, month]
      );

      const days = result.rows.map(row => ({
        date: row.date,
        article_count: parseInt(row.count, 10),
      }));

      res.json({ year, month, days });
    } catch (error) {
      logger.error({ error }, "Error fetching calendar data");
      res.status(500).json({ error: "Failed to fetch calendar data" });
    }
  });

  /**
   * GET /api/latest/calendar/:date
   * Get articles for a specific date
   */
  apiRouter.get("/latest/calendar/:date", async (req: Request, res: Response) => {
    try {
      const { date } = req.params;
      const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 20, 1), 50);

      const result = await query<LatestArticle>(
        `SELECT
           k.id,
           k.title,
           k.source_url,
           k.summary,
           k.addie_notes,
           COALESCE(k.human_quality_override, k.quality_score) as quality_score,
           k.relevance_tags,
           f.name as feed_name,
           k.published_at,
           k.created_at,
           k.comment_count
         FROM addie_knowledge k
         LEFT JOIN perspectives p ON k.source_url = p.external_url
         LEFT JOIN industry_feeds f ON p.feed_id = f.id
         WHERE k.fetch_status = 'success'
           AND k.publication_status != 'rejected'
           AND DATE(COALESCE(k.published_at, k.created_at)) = $1::date
         ORDER BY COALESCE(k.published_at, k.created_at) DESC
         LIMIT $2`,
        [date, limit]
      );

      res.json({ date, articles: result.rows });
    } catch (error) {
      logger.error({ error }, "Error fetching calendar articles");
      res.status(500).json({ error: "Failed to fetch articles for date" });
    }
  });

  // =========================================================================
  // ENTITY ENDPOINTS
  // =========================================================================

  /**
   * GET /api/latest/entities/:name/articles
   * Get articles mentioning a specific entity
   */
  apiRouter.get("/latest/entities/:name/articles", async (req: Request, res: Response) => {
    try {
      const { name } = req.params;
      const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 20, 1), 50);
      const offset = Math.max(parseInt(req.query.offset as string) || 0, 0);

      const articles = await getArticlesByEntity(decodeURIComponent(name), limit, offset);
      res.json({ entity_name: name, articles });
    } catch (error) {
      logger.error({ error }, "Error fetching entity articles");
      res.status(500).json({ error: "Failed to fetch entity articles" });
    }
  });

  /**
   * GET /api/latest/organizations/:id/articles
   * Get articles mentioning a specific organization
   */
  apiRouter.get("/latest/organizations/:id/articles", async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 20, 1), 50);
      const offset = Math.max(parseInt(req.query.offset as string) || 0, 0);

      const articles = await getArticlesByOrganization(id, limit, offset);
      res.json({ organization_id: id, articles });
    } catch (error) {
      logger.error({ error }, "Error fetching organization articles");
      res.status(500).json({ error: "Failed to fetch organization articles" });
    }
  });

  // =========================================================================
  // COMMENT ENDPOINTS
  // =========================================================================

  /**
   * GET /api/latest/articles/:id/comments
   * Get comments for an article (merged from Slack + web)
   */
  apiRouter.get("/latest/articles/:id/comments", async (req: Request, res: Response) => {
    try {
      const knowledgeId = parseInt(req.params.id);
      if (isNaN(knowledgeId)) {
        return res.status(400).json({ error: "Invalid article ID" });
      }

      const comments = await getArticleComments(knowledgeId);
      res.json({ comments });
    } catch (error) {
      logger.error({ error }, "Error fetching article comments");
      res.status(500).json({ error: "Failed to fetch comments" });
    }
  });

  /**
   * POST /api/latest/articles/:id/comments
   * Add a comment to an article (requires auth)
   */
  apiRouter.post("/latest/articles/:id/comments", requireAuth, async (req: Request, res: Response) => {
    try {
      const user = req.user!;
      const knowledgeId = parseInt(req.params.id);
      if (isNaN(knowledgeId)) {
        return res.status(400).json({ error: "Invalid article ID" });
      }

      const { content } = req.body;
      if (!content || typeof content !== 'string' || content.trim().length === 0) {
        return res.status(400).json({ error: "Comment content is required" });
      }

      const displayName = user.firstName && user.lastName
        ? `${user.firstName} ${user.lastName}`
        : user.email;

      const comment = await addWebComment(
        knowledgeId,
        user.id,
        displayName,
        content.trim()
      );

      res.json({ comment });
    } catch (error) {
      logger.error({ error }, "Error adding article comment");
      res.status(500).json({ error: "Failed to add comment" });
    }
  });

  // =========================================================================
  // ARTICLE DETAIL ENDPOINT
  // =========================================================================

  /**
   * GET /api/latest/articles/:id
   * Get single article with entities
   */
  apiRouter.get("/latest/articles/:id", optionalAuth, async (req: Request, res: Response) => {
    try {
      const knowledgeId = parseInt(req.params.id);
      if (isNaN(knowledgeId)) {
        return res.status(400).json({ error: "Invalid article ID" });
      }

      // Get article
      const articleResult = await query<LatestArticle & { content: string }>(
        `SELECT
           k.id,
           k.title,
           k.source_url,
           k.summary,
           k.content,
           k.addie_notes,
           COALESCE(k.human_quality_override, k.quality_score) as quality_score,
           k.relevance_tags,
           f.name as feed_name,
           k.published_at,
           k.created_at,
           k.comment_count,
           k.view_count,
           k.trending_score
         FROM addie_knowledge k
         LEFT JOIN perspectives p ON k.source_url = p.external_url
         LEFT JOIN industry_feeds f ON p.feed_id = f.id
         WHERE k.id = $1
           AND k.fetch_status = 'success'`,
        [knowledgeId]
      );

      if (articleResult.rows.length === 0) {
        return res.status(404).json({ error: "Article not found" });
      }

      // Increment view count and update trending score
      await query(
        `UPDATE addie_knowledge
         SET view_count = COALESCE(view_count, 0) + 1,
             trending_score = COALESCE(comment_count, 0) + COALESCE(view_count, 0) + 1
         WHERE id = $1`,
        [knowledgeId]
      );

      // Get entities
      const entitiesResult = await query<ArticleEntity>(
        `SELECT entity_type, entity_name, organization_id, is_primary
         FROM article_entities
         WHERE knowledge_id = $1
         ORDER BY is_primary DESC, mention_count DESC`,
        [knowledgeId]
      );

      // Check if user has saved this article
      let is_saved = false;
      if (req.user) {
        const savedResult = await query<{ id: number }>(
          `SELECT id FROM user_watchlist
           WHERE workos_user_id = $1 AND knowledge_id = $2`,
          [req.user.id, knowledgeId]
        );
        is_saved = savedResult.rows.length > 0;
      }

      res.json({
        ...articleResult.rows[0],
        entities: entitiesResult.rows,
        is_saved,
      });
    } catch (error) {
      logger.error({ error }, "Error fetching article detail");
      res.status(500).json({ error: "Failed to fetch article" });
    }
  });

  /**
   * POST /api/latest/articles/:id/view
   * Record a view for an article (for tracking clicks from list)
   */
  apiRouter.post("/latest/articles/:id/view", async (req: Request, res: Response) => {
    try {
      const knowledgeId = parseInt(req.params.id);
      if (isNaN(knowledgeId)) {
        return res.status(400).json({ error: "Invalid article ID" });
      }

      // Increment view count and update trending score
      await query(
        `UPDATE addie_knowledge
         SET view_count = COALESCE(view_count, 0) + 1,
             trending_score = COALESCE(comment_count, 0) + COALESCE(view_count, 0) + 1
         WHERE id = $1 AND fetch_status = 'success'`,
        [knowledgeId]
      );

      res.json({ success: true });
    } catch (error) {
      logger.error({ error }, "Error recording article view");
      res.status(500).json({ error: "Failed to record view" });
    }
  });

  // =========================================================================
  // FULL ARTICLE SEARCH WITH FILTERS
  // =========================================================================

  /**
   * GET /api/latest/articles
   * Full-featured article search with filters
   */
  apiRouter.get("/latest/articles", async (req: Request, res: Response) => {
    try {
      const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 20, 1), 50);
      const offset = Math.max(parseInt(req.query.offset as string) || 0, 0);

      // Build WHERE clauses based on filters
      const conditions: string[] = [
        "k.fetch_status = 'success'",
        "k.publication_status != 'rejected'",
      ];
      const params: (string | number | string[])[] = [];
      let paramIndex = 1;

      // Section filter
      if (req.query.section) {
        const channel = await getChannelByWebsiteSlug(req.query.section as string);
        if (channel) {
          conditions.push(`$${paramIndex} = ANY(COALESCE(k.human_routing_override, k.notification_channel_ids))`);
          params.push(channel.slack_channel_id);
          paramIndex++;
        }
      }

      // Date range filter
      if (req.query.date_from) {
        conditions.push(`COALESCE(k.published_at, k.created_at) >= $${paramIndex}::date`);
        params.push(req.query.date_from as string);
        paramIndex++;
      }
      if (req.query.date_to) {
        conditions.push(`COALESCE(k.published_at, k.created_at) <= $${paramIndex}::date`);
        params.push(req.query.date_to as string);
        paramIndex++;
      }

      // Quality filter
      if (req.query.min_quality) {
        const minQuality = parseInt(req.query.min_quality as string);
        if (!isNaN(minQuality)) {
          conditions.push(`COALESCE(k.human_quality_override, k.quality_score) >= $${paramIndex}`);
          params.push(minQuality);
          paramIndex++;
        }
      }

      // Tags filter
      if (req.query.tags) {
        const tags = (req.query.tags as string).split(',').map(t => t.trim()).filter(Boolean);
        if (tags.length > 0) {
          conditions.push(`k.relevance_tags && $${paramIndex}::text[]`);
          params.push(tags);
          paramIndex++;
        }
      }

      // Organization filter
      if (req.query.org_id) {
        conditions.push(`EXISTS (
          SELECT 1 FROM article_entities ae
          WHERE ae.knowledge_id = k.id AND ae.organization_id = $${paramIndex}
        )`);
        params.push(req.query.org_id as string);
        paramIndex++;
      }

      // Full-text search
      if (req.query.q) {
        conditions.push(`(
          k.title ILIKE $${paramIndex} OR
          k.summary ILIKE $${paramIndex} OR
          k.addie_notes ILIKE $${paramIndex}
        )`);
        params.push(`%${req.query.q}%`);
        paramIndex++;
      }

      // Sort order
      let orderBy = "COALESCE(k.published_at, k.created_at) DESC";
      if (req.query.sort === 'quality') {
        orderBy = "COALESCE(k.human_quality_override, k.quality_score) DESC NULLS LAST";
      } else if (req.query.sort === 'trending') {
        orderBy = "k.trending_score DESC NULLS LAST";
      }

      // Add pagination params
      const limitIndex = paramIndex;
      const offsetIndex = paramIndex + 1;
      params.push(limit);
      params.push(offset);

      const whereClause = conditions.join(' AND ');

      const result = await query<LatestArticle>(
        `SELECT
           k.id,
           k.title,
           k.source_url,
           k.summary,
           k.addie_notes,
           COALESCE(k.human_quality_override, k.quality_score) as quality_score,
           k.relevance_tags,
           f.name as feed_name,
           k.published_at,
           k.created_at,
           k.comment_count,
           k.trending_score
         FROM addie_knowledge k
         LEFT JOIN perspectives p ON k.source_url = p.external_url
         LEFT JOIN industry_feeds f ON p.feed_id = f.id
         WHERE ${whereClause}
         ORDER BY ${orderBy}
         LIMIT $${limitIndex} OFFSET $${offsetIndex}`,
        params
      );

      // Get total count (without pagination)
      const countParams = params.slice(0, -2); // Remove limit and offset
      const countResult = await query<{ count: string }>(
        `SELECT COUNT(*) as count
         FROM addie_knowledge k
         WHERE ${whereClause}`,
        countParams
      );

      const total = parseInt(countResult.rows[0]?.count || "0", 10);

      res.json({
        articles: result.rows,
        pagination: {
          total,
          limit,
          offset,
          has_more: offset + result.rows.length < total,
        },
      });
    } catch (error) {
      logger.error({ error }, "Error searching articles");
      res.status(500).json({ error: "Failed to search articles" });
    }
  });

  // =========================================================================
  // PAGE ROUTES (additional)
  // =========================================================================

  // Article detail page
  pageRouter.get("/latest/article/:id", (req, res) => {
    serveHtmlWithConfig(req, res, "latest/article.html").catch((err) => {
      logger.error({ err }, "Error serving article detail page");
      res.status(500).send("Internal server error");
    });
  });

  // Calendar page
  pageRouter.get("/latest/calendar", (req, res) => {
    serveHtmlWithConfig(req, res, "latest/calendar.html").catch((err) => {
      logger.error({ err }, "Error serving calendar page");
      res.status(500).send("Internal server error");
    });
  });

  return { pageRouter, apiRouter };
}
