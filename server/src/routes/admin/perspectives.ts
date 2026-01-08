/**
 * Admin Perspectives routes module
 *
 * Admin-only routes for managing perspectives:
 * - List all perspectives
 * - Get single perspective
 * - Create/update/delete perspectives
 * - Fetch URL metadata for auto-fill
 */

import { Router } from 'express';
import { createLogger } from '../../logger.js';
import { requireAuth, requireAdmin } from '../../middleware/auth.js';
import { getPool } from '../../db/client.js';
import { decodeHtmlEntities } from '../../utils/html-entities.js';
import { queuePerspectiveLink } from '../../addie/services/content-curator.js';

const logger = createLogger('admin-perspectives-routes');

/**
 * Create admin perspectives routes
 * Returns a router to be mounted at /api/admin/perspectives
 */
export function createAdminPerspectivesRouter(): Router {
  const router = Router();

  // GET /api/admin/perspectives - List all perspectives
  router.get('/', requireAuth, requireAdmin, async (_req, res) => {
    try {
      const pool = getPool();
      const result = await pool.query(
        `SELECT * FROM perspectives
         ORDER BY display_order ASC, published_at DESC NULLS LAST, created_at DESC`
      );

      res.json(result.rows);
    } catch (error) {
      logger.error({ err: error }, 'Get all perspectives error');
      res.status(500).json({
        error: 'Failed to get perspectives',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // GET /api/admin/perspectives/:id - Get single perspective
  router.get('/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const pool = getPool();
      const result = await pool.query(
        'SELECT * FROM perspectives WHERE id = $1',
        [id]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          error: 'Perspective not found',
          message: `No perspective found with id ${id}`
        });
      }

      res.json(result.rows[0]);
    } catch (error) {
      logger.error({ err: error }, 'Get perspective error');
      res.status(500).json({
        error: 'Failed to get perspective',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // POST /api/admin/perspectives/fetch-url - Fetch URL metadata for auto-fill
  router.post('/fetch-url', requireAuth, requireAdmin, async (req, res) => {
    try {
      const { url } = req.body;

      if (!url) {
        return res.status(400).json({
          error: 'URL required',
          message: 'Please provide a URL to fetch'
        });
      }

      // Validate URL scheme to prevent SSRF
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(url);
      } catch {
        return res.status(400).json({
          error: 'Invalid URL',
          message: 'Please provide a valid URL'
        });
      }

      if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
        return res.status(400).json({
          error: 'Invalid URL',
          message: 'Only HTTP and HTTPS URLs are allowed'
        });
      }

      // Fetch the page with timeout
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; AgenticAdvertising/1.0)',
          'Accept': 'text/html,application/xhtml+xml'
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(10000), // 10 second timeout
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch URL: ${response.status}`);
      }

      const html = await response.text();

      // Extract metadata from HTML
      const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
      const ogTitleMatch = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)
        || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i);
      const ogDescMatch = html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i)
        || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:description["']/i);
      const descMatch = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)
        || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i);
      const ogSiteMatch = html.match(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i)
        || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:site_name["']/i);

      // Determine title (prefer og:title, then <title>)
      let title = ogTitleMatch?.[1] || titleMatch?.[1] || '';
      title = decodeHtmlEntities(title.trim());

      // Determine description (prefer og:description, then meta description)
      let excerpt = ogDescMatch?.[1] || descMatch?.[1] || '';
      excerpt = decodeHtmlEntities(excerpt.trim());

      // Site name from og:site_name or parse from URL
      let site_name = ogSiteMatch?.[1] || '';
      if (!site_name) {
        try {
          const parsedUrl = new URL(url);
          site_name = parsedUrl.hostname.replace('www.', '');
          // Capitalize first letter
          site_name = site_name.charAt(0).toUpperCase() + site_name.slice(1);
        } catch {
          // ignore URL parse errors
        }
      }
      site_name = decodeHtmlEntities(site_name);

      res.json({
        title,
        excerpt,
        site_name
      });

    } catch (error) {
      logger.error({ err: error }, 'Fetch URL metadata error');
      res.status(500).json({
        error: 'Failed to fetch URL',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  // POST /api/admin/perspectives - Create new perspective
  router.post('/', requireAuth, requireAdmin, async (req, res) => {
    try {
      const {
        slug,
        content_type = 'article',
        title,
        subtitle,
        category,
        excerpt,
        content,
        external_url,
        external_site_name,
        author_name,
        author_title,
        featured_image_url,
        status = 'draft',
        published_at,
        display_order = 0,
        tags = [],
        metadata = {},
      } = req.body;

      const validContentTypes = ['article', 'link'];
      const validStatuses = ['draft', 'published', 'archived'];

      if (!slug || !title) {
        return res.status(400).json({
          error: 'Missing required fields',
          message: 'slug and title are required'
        });
      }

      if (!validContentTypes.includes(content_type)) {
        return res.status(400).json({
          error: 'Invalid content_type',
          message: 'content_type must be: article or link'
        });
      }

      if (!validStatuses.includes(status)) {
        return res.status(400).json({
          error: 'Invalid status',
          message: 'status must be: draft, published, or archived'
        });
      }

      // Validate content_type requirements
      if (content_type === 'link' && !external_url) {
        return res.status(400).json({
          error: 'Missing external_url',
          message: 'external_url is required for link type perspectives'
        });
      }

      const pool = getPool();
      const result = await pool.query(
        `INSERT INTO perspectives (
          slug, content_type, title, subtitle, category, excerpt,
          content, external_url, external_site_name,
          author_name, author_title, featured_image_url,
          status, published_at, display_order, tags, metadata
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
        RETURNING *`,
        [
          slug, content_type, title, subtitle, category, excerpt,
          content, external_url, external_site_name,
          author_name, author_title, featured_image_url,
          status, published_at || null, display_order, tags, metadata
        ]
      );

      const perspective = result.rows[0];

      // Queue external links for Addie's knowledge base when published
      if (perspective.content_type === 'link' && perspective.status === 'published' && perspective.external_url) {
        queuePerspectiveLink({
          id: perspective.id,
          title: perspective.title,
          external_url: perspective.external_url,
          category: perspective.category || 'perspective',
          tags: perspective.tags,
        }).catch(err => {
          logger.warn({ err, perspectiveId: perspective.id }, 'Failed to queue perspective link for indexing');
        });
      }

      res.status(201).json(perspective);
    } catch (error) {
      logger.error({ err: error }, 'Create perspective error');
      // Check for unique constraint violation
      if (error instanceof Error && error.message.includes('duplicate key')) {
        return res.status(400).json({
          error: 'Slug already exists',
          message: 'A perspective with this slug already exists'
        });
      }
      res.status(500).json({
        error: 'Failed to create perspective',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // PUT /api/admin/perspectives/:id - Update perspective
  router.put('/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const {
        slug,
        content_type,
        title,
        subtitle,
        category,
        excerpt,
        content,
        external_url,
        external_site_name,
        author_name,
        author_title,
        featured_image_url,
        status,
        published_at,
        display_order,
        tags,
        metadata,
      } = req.body;

      const validContentTypes = ['article', 'link'];
      const validStatuses = ['draft', 'published', 'archived'];

      if (!slug || !title) {
        return res.status(400).json({
          error: 'Missing required fields',
          message: 'slug and title are required'
        });
      }

      if (content_type && !validContentTypes.includes(content_type)) {
        return res.status(400).json({
          error: 'Invalid content_type',
          message: 'content_type must be: article or link'
        });
      }

      if (status && !validStatuses.includes(status)) {
        return res.status(400).json({
          error: 'Invalid status',
          message: 'status must be: draft, published, or archived'
        });
      }

      // Validate content_type requirements
      if (content_type === 'link' && !external_url) {
        return res.status(400).json({
          error: 'Missing external_url',
          message: 'external_url is required for link type perspectives'
        });
      }

      const pool = getPool();
      const result = await pool.query(
        `UPDATE perspectives SET
          slug = $1,
          content_type = $2,
          title = $3,
          subtitle = $4,
          category = $5,
          excerpt = $6,
          content = $7,
          external_url = $8,
          external_site_name = $9,
          author_name = $10,
          author_title = $11,
          featured_image_url = $12,
          status = $13,
          published_at = $14,
          display_order = $15,
          tags = $16,
          metadata = $17
        WHERE id = $18
        RETURNING *`,
        [
          slug, content_type, title, subtitle, category, excerpt,
          content, external_url, external_site_name,
          author_name, author_title, featured_image_url,
          status, published_at || null, display_order, tags, metadata,
          id
        ]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          error: 'Perspective not found',
          message: `No perspective found with id ${id}`
        });
      }

      const perspective = result.rows[0];

      // Queue external links for indexing when perspective is published
      if (perspective.content_type === 'link' && perspective.status === 'published' && perspective.external_url) {
        queuePerspectiveLink({
          id: perspective.id,
          title: perspective.title,
          external_url: perspective.external_url,
          category: perspective.category || 'perspective',
          tags: perspective.tags,
        }).catch(err => {
          logger.warn({ err, perspectiveId: perspective.id }, 'Failed to queue perspective link for indexing');
        });
      }

      res.json(perspective);
    } catch (error) {
      logger.error({ err: error }, 'Update perspective error');
      // Check for unique constraint violation
      if (error instanceof Error && error.message.includes('duplicate key')) {
        return res.status(400).json({
          error: 'Slug already exists',
          message: 'A perspective with this slug already exists'
        });
      }
      res.status(500).json({
        error: 'Failed to update perspective',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // DELETE /api/admin/perspectives/:id - Delete perspective
  router.delete('/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const pool = getPool();

      const result = await pool.query(
        'DELETE FROM perspectives WHERE id = $1 RETURNING id',
        [id]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          error: 'Perspective not found',
          message: `No perspective found with id ${id}`
        });
      }

      res.json({ success: true, deleted: id });
    } catch (error) {
      logger.error({ err: error }, 'Delete perspective error');
      res.status(500).json({
        error: 'Failed to delete perspective',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  return router;
}
