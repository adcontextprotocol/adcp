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

  return { pageRouter, apiRouter };
}
