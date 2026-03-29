/**
 * Perspective illustration admin routes
 *
 * Generate AI editorial illustrations for published perspectives
 * that don't have one yet. Uses Gemini to generate images.
 */

import { Router } from 'express';
import { createLogger } from '../../logger.js';
import { requireAuth, requireAdmin } from '../../middleware/auth.js';
import { getPool } from '../../db/client.js';
import * as illustrationDb from '../../db/illustration-db.js';
import { generateIllustration } from '../../services/illustration-generator.js';

const logger = createLogger('admin-illustrations');

// Gemini calls take 5-15s each; cap batch to avoid HTTP timeouts
const MAX_BATCH = 5;

export function setupIllustrationRoutes(apiRouter: Router): void {

  // GET /api/admin/illustrations/pending - List perspectives missing illustrations
  apiRouter.get('/illustrations/pending', requireAuth, requireAdmin, async (_req, res) => {
    try {
      const pool = getPool();
      const { rows } = await pool.query<{
        id: string;
        slug: string;
        title: string;
        category: string | null;
        excerpt: string | null;
        published_at: string | null;
      }>(
        `SELECT id, slug, title, category, excerpt, published_at
         FROM perspectives
         WHERE status = 'published' AND illustration_id IS NULL
         ORDER BY published_at DESC`
      );
      res.json({ count: rows.length, perspectives: rows });
    } catch (err) {
      logger.error({ err }, 'Failed to list pending illustrations');
      res.status(500).json({ error: 'Failed to list pending illustrations' });
    }
  });

  // POST /api/admin/illustrations/generate - Generate illustrations for perspectives missing one
  // Optional body: { slugs: string[] } to limit to specific perspectives
  // Processes at most MAX_BATCH per request to avoid HTTP timeouts
  apiRouter.post('/illustrations/generate', requireAuth, requireAdmin, async (req, res) => {
    try {
      if (!process.env.GEMINI_API_KEY) {
        return res.status(503).json({ error: 'GEMINI_API_KEY is not configured' });
      }

      const requestedSlugs: unknown = req.body?.slugs;
      if (requestedSlugs !== undefined) {
        if (!Array.isArray(requestedSlugs) || !requestedSlugs.every(s => typeof s === 'string')) {
          return res.status(400).json({ error: 'slugs must be an array of strings' });
        }
      }

      const pool = getPool();
      let sql = `SELECT id, slug, title, category, excerpt
                 FROM perspectives
                 WHERE status = 'published' AND illustration_id IS NULL`;
      const params: unknown[] = [];

      if (Array.isArray(requestedSlugs) && requestedSlugs.length > 0) {
        sql += ` AND slug = ANY($1)`;
        params.push(requestedSlugs);
      }

      sql += ` ORDER BY published_at DESC`;

      const { rows: allRows } = await pool.query<{
        id: string;
        slug: string;
        title: string;
        category: string | null;
        excerpt: string | null;
      }>(sql, params);

      if (allRows.length === 0) {
        return res.json({ message: 'All published perspectives already have illustrations', generated: 0, remaining: 0, results: [] });
      }

      const batch = allRows.slice(0, MAX_BATCH);
      const results: Array<{ slug: string; title: string; status: 'ok' | 'error'; sizeKB?: number; error?: string }> = [];

      for (const perspective of batch) {
        try {
          logger.info({ slug: perspective.slug }, 'Generating illustration');

          const { imageBuffer, promptUsed } = await generateIllustration({
            title: perspective.title,
            category: perspective.category || undefined,
            excerpt: perspective.excerpt || undefined,
          });

          const illustration = await illustrationDb.createIllustration({
            perspective_id: perspective.id,
            image_data: imageBuffer,
            prompt_used: promptUsed,
            status: 'approved',
          });

          await illustrationDb.approveIllustration(illustration.id, perspective.id);

          results.push({
            slug: perspective.slug,
            title: perspective.title,
            status: 'ok',
            sizeKB: Math.round(imageBuffer.length / 1024),
          });

          logger.info({ slug: perspective.slug, sizeKB: Math.round(imageBuffer.length / 1024) }, 'Illustration generated and approved');
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.error({ err, slug: perspective.slug }, 'Failed to generate illustration');
          results.push({ slug: perspective.slug, title: perspective.title, status: 'error', error: message });
        }
      }

      const generated = results.filter(r => r.status === 'ok').length;
      const remaining = allRows.length - generated;
      res.json({ generated, total: allRows.length, remaining, results });
    } catch (err) {
      logger.error({ err }, 'Failed to generate illustrations');
      res.status(500).json({ error: 'Failed to generate illustrations' });
    }
  });

  // POST /api/admin/illustrations/regenerate/:slug - Regenerate illustration for a specific perspective
  apiRouter.post('/illustrations/regenerate/:slug', requireAuth, requireAdmin, async (req, res) => {
    try {
      if (!process.env.GEMINI_API_KEY) {
        return res.status(503).json({ error: 'GEMINI_API_KEY is not configured' });
      }

      const { slug } = req.params;
      const pool = getPool();

      const { rows } = await pool.query<{
        id: string;
        title: string;
        category: string | null;
        excerpt: string | null;
      }>(
        `SELECT id, title, category, excerpt FROM perspectives WHERE slug = $1 AND status = 'published'`,
        [slug]
      );

      if (rows.length === 0) {
        return res.status(404).json({ error: 'Published perspective not found' });
      }

      const perspective = rows[0];

      const { imageBuffer, promptUsed } = await generateIllustration({
        title: perspective.title,
        category: perspective.category || undefined,
        excerpt: perspective.excerpt || undefined,
      });

      const illustration = await illustrationDb.createIllustration({
        perspective_id: perspective.id,
        image_data: imageBuffer,
        prompt_used: promptUsed,
        status: 'approved',
      });

      await illustrationDb.approveIllustration(illustration.id, perspective.id);

      res.json({
        slug,
        title: perspective.title,
        illustrationId: illustration.id,
        sizeKB: Math.round(imageBuffer.length / 1024),
      });
    } catch (err) {
      logger.error({ err, slug: req.params.slug }, 'Failed to regenerate illustration');
      res.status(500).json({ error: 'Failed to regenerate illustration' });
    }
  });
}
