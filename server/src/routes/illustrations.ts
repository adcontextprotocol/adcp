/**
 * Illustration Routes
 *
 * API endpoints for generating, serving, and managing perspective illustrations.
 */

import { Router, type Request, type Response } from 'express';
import { createLogger } from '../logger.js';
import * as illustrationDb from '../db/illustration-db.js';
import { generateIllustration } from '../services/illustration-generator.js';
import { getPool } from '../db/client.js';

const logger = createLogger('illustrations');

export function createIllustrationRouter(): Router {
  const router = Router();

  // GET /api/illustrations/:id/image.png - Serve illustration image as PNG
  router.get('/:id/image.png', async (req: Request, res: Response) => {
    try {
      const data = await illustrationDb.getIllustrationData(req.params.id);
      if (!data) {
        return res.status(404).send('Not found');
      }

      res.set('Content-Type', 'image/png');
      res.set('Cache-Control', 'public, max-age=31536000, immutable');
      res.send(data);
    } catch (err) {
      logger.error({ err }, 'Failed to serve illustration');
      res.status(500).json({ error: 'Failed to serve illustration' });
    }
  });

  // POST /api/illustrations/generate - Generate illustration for a perspective
  // Requires auth: user must be an author of the perspective
  router.post('/generate', async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      if (!user) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      const { perspectiveSlug, authorDescription } = req.body;
      if (!perspectiveSlug || typeof perspectiveSlug !== 'string') {
        return res.status(400).json({ error: 'perspectiveSlug is required' });
      }

      // Validate slug format to prevent injection
      if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(perspectiveSlug) || perspectiveSlug.length > 200) {
        return res.status(400).json({ error: 'Invalid slug format' });
      }

      // Look up perspective — the slug is user-provided but authorization
      // is enforced below via isAuthorOfPerspective (not bypassed by slug choice)
      const perspective = await illustrationDb.getPerspectiveWithIllustration(perspectiveSlug);
      if (!perspective) {
        return res.status(404).json({ error: 'Perspective not found' });
      }

      // Verify user is an author of this perspective
      const isAuthor = await illustrationDb.isAuthorOfPerspective(perspective.id, user.id);
      if (!isAuthor) {
        return res.status(403).json({ error: 'Only the article author can generate illustrations' });
      }

      // Check rate limit
      const monthlyCount = await illustrationDb.countMonthlyGenerations(user.id);
      if (monthlyCount >= 5) {
        return res.status(429).json({
          error: 'Monthly illustration limit reached (5 per month)',
          count: monthlyCount,
        });
      }

      // Generate the illustration
      const { imageBuffer, promptUsed } = await generateIllustration({
        title: perspective.title,
        category: perspective.category || undefined,
        authorDescription: authorDescription || undefined,
      });

      // Store in database
      const illustration = await illustrationDb.createIllustration({
        perspective_id: perspective.id,
        image_data: imageBuffer,
        prompt_used: promptUsed,
        author_description: authorDescription || undefined,
        status: 'generated',
      });

      res.json({
        id: illustration.id,
        status: illustration.status,
        preview_url: `/api/illustrations/${illustration.id}/image.png`,
      });
    } catch (err) {
      logger.error({ err }, 'Failed to generate illustration');
      res.status(500).json({ error: 'Failed to generate illustration' });
    }
  });

  // POST /api/illustrations/:id/approve - Approve and set as active
  router.post('/:id/approve', async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      if (!user) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      const illustration = await illustrationDb.getIllustrationById(req.params.id);
      if (!illustration) {
        return res.status(404).json({ error: 'Illustration not found' });
      }

      // Verify user is an author of this perspective
      const pool = getPool();
      const authCheck = await pool.query(
        `SELECT 1 FROM content_authors WHERE perspective_id = $1 AND user_id = $2`,
        [illustration.perspective_id, user.id]
      );
      if (authCheck.rows.length === 0) {
        return res.status(403).json({ error: 'Only the article author can approve illustrations' });
      }

      const approved = await illustrationDb.approveIllustration(
        illustration.id,
        illustration.perspective_id
      );

      res.json({ illustration: approved });
    } catch (err) {
      logger.error({ err }, 'Failed to approve illustration');
      res.status(500).json({ error: 'Failed to approve illustration' });
    }
  });

  // DELETE /api/illustrations/:id - Reject/remove illustration
  router.delete('/:id', async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      if (!user) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      const illustration = await illustrationDb.getIllustrationById(req.params.id);
      if (!illustration) {
        return res.status(404).json({ error: 'Illustration not found' });
      }

      // Verify user is an author of this perspective
      const pool = getPool();
      const authCheck = await pool.query(
        `SELECT 1 FROM content_authors WHERE perspective_id = $1 AND user_id = $2`,
        [illustration.perspective_id, user.id]
      );
      if (authCheck.rows.length === 0) {
        return res.status(403).json({ error: 'Only the article author can delete illustrations' });
      }

      await illustrationDb.rejectIllustration(req.params.id);
      res.json({ success: true });
    } catch (err) {
      logger.error({ err }, 'Failed to remove illustration');
      res.status(500).json({ error: 'Failed to remove illustration' });
    }
  });

  return router;
}
