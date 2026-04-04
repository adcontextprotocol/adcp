/**
 * Shared Newsletter Admin Routes
 *
 * Factory that creates admin API routes for any registered newsletter.
 * Handles CRUD, editing, approval, and test sends.
 */

import { Router, type Request, type Response } from 'express';
import { createLogger } from '../logger.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import type { NewsletterConfig } from './config.js';

const logger = createLogger('newsletter-admin');

/**
 * Create admin API routes for a newsletter.
 * Mount at: /api/admin/newsletters/:newsletterId/
 */
export function createNewsletterAdminRoutes(config: NewsletterConfig): Router {
  const router = Router();

  // GET /editions — list recent editions
  router.get('/editions', requireAuth, requireAdmin, async (_req: Request, res: Response) => {
    try {
      const editions = await config.db.getRecent(20);
      res.json({ editions });
    } catch (err) {
      logger.error({ error: err, newsletterId: config.id }, 'Failed to list editions');
      res.status(500).json({ error: 'Failed to list editions' });
    }
  });

  // GET /editions/current — get current week's edition
  router.get('/editions/current', requireAuth, requireAdmin, async (_req: Request, res: Response) => {
    try {
      const edition = await config.db.getCurrent();
      if (!edition) {
        return res.status(404).json({ error: 'No current edition found' });
      }
      const subject = config.generateSubject(edition.content);
      res.json({ digest: edition, subject, newsletter: { id: config.id, name: config.name, author: config.author } });
    } catch (err) {
      logger.error({ error: err, newsletterId: config.id }, 'Failed to get current edition');
      res.status(500).json({ error: 'Failed to get current edition' });
    }
  });

  // POST /editions/generate — build a new draft
  router.post('/editions/generate', requireAuth, requireAdmin, async (_req: Request, res: Response) => {
    try {
      const editionDate = new Date().toISOString().split('T')[0];
      const existing = await config.db.getByDate(editionDate);
      if (existing) {
        return res.status(409).json({ error: 'Edition already exists for today', edition: existing });
      }

      const content = await config.buildContent();
      if (!config.hasMinimumContent(content)) {
        return res.status(422).json({ error: 'Not enough content to generate an edition' });
      }

      const edition = await config.db.createEdition(editionDate, content);
      if (!edition) {
        return res.status(500).json({ error: 'Failed to create edition' });
      }

      const subject = config.generateSubject(edition.content);
      res.json({ digest: edition, subject });
    } catch (err) {
      logger.error({ error: err, newsletterId: config.id }, 'Failed to generate edition');
      res.status(500).json({ error: 'Failed to generate edition' });
    }
  });

  // POST /editions/:id/edit — edit content (direct field or LLM instruction)
  router.post('/editions/:id/edit', requireAuth, requireAdmin, async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return res.status(400).json({ error: 'Invalid edition ID' });

      const edition = await config.db.getCurrent();
      if (!edition || edition.id !== id) {
        return res.status(404).json({ error: 'Edition not found' });
      }
      if (edition.status !== 'draft') {
        return res.status(400).json({ error: 'Can only edit draft editions' });
      }

      const { field, value } = req.body;
      if (!field || !config.editableFields.includes(field)) {
        return res.status(400).json({ error: `Field not editable. Allowed: ${config.editableFields.join(', ')}` });
      }

      if (typeof value === 'string' && value.length > 10000) {
        return res.status(400).json({ error: 'Value too long (max 10000 characters)' });
      }

      const content = edition.content as Record<string, unknown>;
      content[field] = value;

      const updated = await config.db.updateContent(id, content);
      if (!updated) {
        return res.status(500).json({ error: 'Failed to update edition' });
      }

      const subject = config.generateSubject(updated.content);
      res.json({ digest: updated, subject });
    } catch (err) {
      logger.error({ error: err, newsletterId: config.id }, 'Failed to edit edition');
      res.status(500).json({ error: 'Failed to edit edition' });
    }
  });

  // POST /editions/:id/approve — approve for sending
  router.post('/editions/:id/approve', requireAuth, requireAdmin, async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return res.status(400).json({ error: 'Invalid edition ID' });

      const approvedBy = req.user?.id || 'admin';
      const updated = await config.db.approve(id, approvedBy);
      if (!updated) {
        return res.status(404).json({ error: 'Edition not found or not in draft status' });
      }

      res.json({ digest: updated });
    } catch (err) {
      logger.error({ error: err, newsletterId: config.id }, 'Failed to approve edition');
      res.status(500).json({ error: 'Failed to approve edition' });
    }
  });

  return router;
}
