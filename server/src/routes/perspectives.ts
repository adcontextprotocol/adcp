/**
 * Perspectives routes module
 *
 * Public and user routes for perspectives:
 * - List published perspectives (public)
 * - Get single perspective by slug (public)
 * - Like/unlike perspectives (public)
 * - User's own perspectives (authenticated)
 */

import { Router } from 'express';
import crypto from 'crypto';
import { createLogger } from '../logger.js';
import { requireAuth } from '../middleware/auth.js';
import { getPool } from '../db/client.js';

const logger = createLogger('perspectives-routes');

/**
 * Create public perspectives router
 * Returns a router to be mounted at /api/perspectives
 */
export function createPerspectivesRouter(): Router {
  const router = Router();

  // GET /api/perspectives - List published perspectives (excludes working group posts)
  router.get('/', async (_req, res) => {
    try {
      const pool = getPool();
      const result = await pool.query(
        `SELECT
          id, slug, content_type, title, subtitle, category, excerpt,
          external_url, external_site_name,
          author_name, author_title, featured_image_url,
          published_at, display_order, tags, like_count
        FROM perspectives
        WHERE status = 'published' AND working_group_id IS NULL
        ORDER BY published_at DESC NULLS LAST`
      );

      res.json(result.rows);
    } catch (error) {
      logger.error({ err: error }, 'Get published perspectives error');
      res.status(500).json({
        error: 'Failed to get perspectives',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // GET /api/perspectives/:slug - Get single published perspective by slug
  router.get('/:slug', async (req, res) => {
    try {
      const { slug } = req.params;
      const pool = getPool();
      const result = await pool.query(
        `SELECT
          id, slug, content_type, title, subtitle, category, excerpt,
          content, external_url, external_site_name,
          author_name, author_title, featured_image_url,
          published_at, tags, metadata, like_count, updated_at
        FROM perspectives
        WHERE slug = $1 AND status = 'published'`,
        [slug]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          error: 'Perspective not found',
          message: `No published perspective found with slug ${slug}`
        });
      }

      res.json(result.rows[0]);
    } catch (error) {
      logger.error({ err: error }, 'Get perspective by slug error');
      res.status(500).json({
        error: 'Failed to get perspective',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // POST /api/perspectives/:id/like - Add a like to a perspective
  router.post('/:id/like', async (req, res) => {
    try {
      const { id } = req.params;
      const { fingerprint } = req.body;

      if (!fingerprint) {
        return res.status(400).json({
          error: 'Missing fingerprint',
          message: 'A fingerprint is required to like a perspective'
        });
      }

      const pool = getPool();

      // Get IP hash for rate limiting
      const ip = req.ip || req.socket.remoteAddress || '';
      const ipHash = crypto.createHash('sha256').update(ip).digest('hex').substring(0, 64);

      // Check rate limit (max 50 likes per IP per hour)
      const rateLimitResult = await pool.query(
        `SELECT COUNT(*) as count FROM perspective_likes
         WHERE ip_hash = $1 AND created_at > NOW() - INTERVAL '1 hour'`,
        [ipHash]
      );

      if (parseInt(rateLimitResult.rows[0].count) >= 50) {
        return res.status(429).json({
          error: 'Rate limited',
          message: 'Too many likes. Please try again later.'
        });
      }

      // Insert the like (will fail if already exists due to unique constraint)
      await pool.query(
        `INSERT INTO perspective_likes (perspective_id, fingerprint, ip_hash)
         VALUES ($1, $2, $3)
         ON CONFLICT (perspective_id, fingerprint) DO NOTHING`,
        [id, fingerprint, ipHash]
      );

      // Get updated like count
      const countResult = await pool.query(
        `SELECT like_count FROM perspectives WHERE id = $1`,
        [id]
      );

      res.json({
        success: true,
        like_count: countResult.rows[0]?.like_count || 0
      });
    } catch (error) {
      logger.error({ err: error }, 'Add perspective like error');
      res.status(500).json({
        error: 'Failed to add like',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // DELETE /api/perspectives/:id/like - Remove a like from a perspective
  router.delete('/:id/like', async (req, res) => {
    try {
      const { id } = req.params;
      const { fingerprint } = req.body;

      if (!fingerprint) {
        return res.status(400).json({
          error: 'Missing fingerprint',
          message: 'A fingerprint is required to unlike a perspective'
        });
      }

      const pool = getPool();

      // Delete the like
      await pool.query(
        `DELETE FROM perspective_likes
         WHERE perspective_id = $1 AND fingerprint = $2`,
        [id, fingerprint]
      );

      // Get updated like count
      const countResult = await pool.query(
        `SELECT like_count FROM perspectives WHERE id = $1`,
        [id]
      );

      res.json({
        success: true,
        like_count: countResult.rows[0]?.like_count || 0
      });
    } catch (error) {
      logger.error({ err: error }, 'Remove perspective like error');
      res.status(500).json({
        error: 'Failed to remove like',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  return router;
}

/**
 * Create user perspectives router
 * Returns a router to be mounted at /api/me/perspectives
 */
export function createUserPerspectivesRouter(): Router {
  const router = Router();

  // GET /api/me/perspectives - Get current user's perspectives
  router.get('/', requireAuth, async (req, res) => {
    try {
      const user = req.user!;
      const status = req.query.status as string | undefined;
      const limit = Math.min(parseInt(req.query.limit as string) || 10, 50);

      // Validate status parameter
      const validStatuses = ['draft', 'published', 'archived'];
      if (status && status !== 'all' && !validStatuses.includes(status)) {
        return res.status(400).json({
          error: 'Invalid status',
          message: `status must be one of: ${validStatuses.join(', ')}, or 'all'`,
        });
      }

      const pool = getPool();

      let query = `
        SELECT id, slug, content_type, title, subtitle, category, excerpt,
               external_url, external_site_name, author_name, author_title,
               status, published_at, created_at, updated_at, tags
        FROM perspectives
        WHERE author_user_id = $1 AND working_group_id IS NULL
      `;
      const params: (string | number)[] = [user.id];

      if (status && status !== 'all') {
        query += ` AND status = $${params.length + 1}`;
        params.push(status);
      }

      query += ` ORDER BY created_at DESC LIMIT $${params.length + 1}`;
      params.push(limit);

      const result = await pool.query(query, params);
      res.json(result.rows);
    } catch (error) {
      logger.error({ err: error }, 'GET /api/me/perspectives error');
      res.status(500).json({
        error: 'Failed to get perspectives',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // POST /api/me/perspectives - Create a new perspective (as draft)
  router.post('/', requireAuth, async (req, res) => {
    try {
      const user = req.user!;
      const {
        title,
        content,
        content_type = 'article',
        excerpt,
        external_url,
        external_site_name,
        category,
        tags = [],
        author_name,
      } = req.body;

      if (!title) {
        return res.status(400).json({
          error: 'Missing required fields',
          message: 'title is required',
        });
      }

      // Validate content_type
      const validContentTypes = ['article', 'link'];
      if (!validContentTypes.includes(content_type)) {
        return res.status(400).json({
          error: 'Invalid content_type',
          message: 'content_type must be: article or link',
        });
      }

      // Validate content_type requirements
      if (content_type === 'link' && !external_url) {
        return res.status(400).json({
          error: 'Missing external_url',
          message: 'external_url is required for link type perspectives',
        });
      }

      if (content_type === 'article' && !content) {
        return res.status(400).json({
          error: 'Missing content',
          message: 'content is required for article type perspectives',
        });
      }

      // Generate slug from title
      const baseSlug = title
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '')
        .replace(/\s+/g, '-')
        .substring(0, 100);

      // Add timestamp suffix to make unique
      const slug = `${baseSlug}-${Date.now().toString(36)}`;

      // Use provided author name or derive from user; always use authenticated user's ID
      const finalAuthorName = author_name ||
        (user.firstName && user.lastName
          ? `${user.firstName} ${user.lastName}`
          : user.email?.split('@')[0] || 'Anonymous');

      const pool = getPool();
      const result = await pool.query(
        `INSERT INTO perspectives (
          slug, content_type, title, content, excerpt,
          external_url, external_site_name, category, tags,
          author_name, author_user_id, status
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'draft')
        RETURNING *`,
        [
          slug, content_type, title, content, excerpt,
          external_url, external_site_name, category, tags,
          finalAuthorName, user.id,
        ]
      );

      logger.info({ perspectiveId: result.rows[0].id, userId: user.id, title }, 'User created perspective draft');
      res.status(201).json(result.rows[0]);
    } catch (error) {
      logger.error({ err: error }, 'POST /api/me/perspectives error');
      res.status(500).json({
        error: 'Failed to create perspective',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  return router;
}
