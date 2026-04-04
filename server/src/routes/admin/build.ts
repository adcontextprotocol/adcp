/**
 * The Build — Admin API Routes
 *
 * CRUD for Sage's contributor briefing editions.
 * Mirrors the digest admin routes pattern.
 */

import { Router, type Request, type Response } from 'express';
import { createLogger } from '../../logger.js';
import { requireAuth, requireAdmin } from '../../middleware/auth.js';
import {
  getCurrentBuildEdition,
  getRecentBuildEditions,
  createBuildEdition,
  updateBuildContent,
  approveBuildEdition,
  type BuildContent,
} from '../../db/build-db.js';
import { buildBuildContent, hasBuildMinimumContent, generateBuildSubject } from '../../newsletters/the-build/builder.js';
import { renderBuildEmail } from '../../newsletters/the-build/template.js';
import { sendMarketingEmail } from '../../notifications/email.js';

const logger = createLogger('admin-build');

export function setupBuildAdminRoutes(apiRouter: Router): void {
  // GET /api/admin/build/current
  apiRouter.get('/build/current', requireAuth, requireAdmin, async (_req: Request, res: Response) => {
    try {
      const edition = await getCurrentBuildEdition();
      if (!edition) {
        return res.json({ digest: null });
      }
      const subject = generateBuildSubject(edition.content);
      res.json({ digest: edition, subject });
    } catch (error) {
      logger.error({ err: error }, 'Failed to get current Build edition');
      res.status(500).json({ error: 'Failed to get current Build edition' });
    }
  });

  // GET /api/admin/build/list
  apiRouter.get('/build/list', requireAuth, requireAdmin, async (_req: Request, res: Response) => {
    try {
      const editions = await getRecentBuildEditions(12);
      res.json({ editions });
    } catch (error) {
      logger.error({ err: error }, 'Failed to list Build editions');
      res.status(500).json({ error: 'Failed to list Build editions' });
    }
  });

  // POST /api/admin/build/generate
  apiRouter.post('/build/generate', requireAuth, requireAdmin, async (req: Request, res: Response) => {
    try {
      const existing = await getCurrentBuildEdition();
      if (existing) {
        const subject = generateBuildSubject(existing.content);
        return res.status(409).json({ error: 'A Build edition already exists for this cycle. Edit it instead.', digest: existing, subject });
      }

      const content = await buildBuildContent();
      if (!hasBuildMinimumContent(content)) {
        return res.status(422).json({ error: 'Not enough content for The Build this cycle.' });
      }

      const editionDate = new Date().toISOString().split('T')[0];
      const edition = await createBuildEdition(editionDate, content);
      if (!edition) {
        return res.status(409).json({ error: 'Edition was created by another process.' });
      }

      const subject = generateBuildSubject(content);
      logger.info({ editionDate, user: req.user?.email }, 'Build draft generated via admin');
      res.json({ digest: edition, subject });
    } catch (error) {
      logger.error({ err: error }, 'Failed to generate Build edition');
      res.status(500).json({ error: 'Failed to generate Build edition' });
    }
  });

  // POST /api/admin/build/:id/edit — direct field edit
  apiRouter.post('/build/:id/edit', requireAuth, requireAdmin, async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return res.status(400).json({ error: 'Invalid edition ID' });

      const edition = await getCurrentBuildEdition();
      if (!edition || edition.id !== id) {
        return res.status(404).json({ error: 'Edition not found' });
      }
      if (edition.status !== 'draft') {
        return res.status(400).json({ error: 'Can only edit draft editions' });
      }

      const { field, value } = req.body;
      const EDITABLE = ['statusLine', 'editorsNote', 'emailSubject'];
      if (!field || !EDITABLE.includes(field)) {
        return res.status(400).json({ error: `Field not editable. Allowed: ${EDITABLE.join(', ')}` });
      }
      const coerced = value != null ? String(value) : undefined;
      if (coerced && coerced.length > 10000) {
        return res.status(400).json({ error: 'Value too long (max 10000 characters)' });
      }

      const content = { ...edition.content } as BuildContent;
      (content as unknown as Record<string, unknown>)[field] = coerced;

      const updated = await updateBuildContent(id, content);
      if (!updated) return res.status(500).json({ error: 'Failed to update edition' });

      const subject = generateBuildSubject(updated.content);
      res.json({ digest: updated, subject });
    } catch (error) {
      logger.error({ err: error }, 'Failed to edit Build edition');
      res.status(500).json({ error: 'Failed to edit Build edition' });
    }
  });

  // POST /api/admin/build/:id/approve
  apiRouter.post('/build/:id/approve', requireAuth, requireAdmin, async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return res.status(400).json({ error: 'Invalid edition ID' });

      const approvedBy = req.user?.email || 'admin';
      const updated = await approveBuildEdition(id, approvedBy);
      if (!updated) {
        return res.status(404).json({ error: 'Edition not found or not in draft status' });
      }

      logger.info({ id, user: approvedBy }, 'Build edition approved via admin');
      res.json({ digest: updated });
    } catch (error) {
      logger.error({ err: error }, 'Failed to approve Build edition');
      res.status(500).json({ error: 'Failed to approve Build edition' });
    }
  });

  // POST /api/admin/build/:id/test-send
  apiRouter.post('/build/:id/test-send', requireAuth, requireAdmin, async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return res.status(400).json({ error: 'Invalid edition ID' });

      const { email } = req.body;
      if (!email || typeof email !== 'string' || !email.includes('@') || email.length > 254 || email.indexOf('@') < 1 || email.indexOf('@') === email.length - 1) {
        return res.status(400).json({ error: 'Valid email address required' });
      }

      const edition = await getCurrentBuildEdition();
      if (!edition || edition.id !== id) {
        return res.status(404).json({ error: 'Edition not found' });
      }

      const editionDate = new Date(edition.edition_date).toISOString().split('T')[0];
      const subject = generateBuildSubject(edition.content);
      const { html, text } = renderBuildEmail(edition.content, 'test', editionDate, 'both', undefined);

      await sendMarketingEmail({
        to: email,
        subject: `[TEST] ${subject}`,
        htmlContent: html,
        textContent: text,
        category: 'the_build',
        workosUserId: req.user?.id || 'admin',
      });

      logger.info({ email, editionDate, user: req.user?.email }, 'Build test email sent');
      res.json({ success: true, email });
    } catch (error) {
      logger.error({ err: error }, 'Failed to send Build test email');
      res.status(500).json({ error: 'Failed to send test email' });
    }
  });
}
