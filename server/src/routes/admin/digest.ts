import { Router, type Request, type Response } from 'express';
import { createLogger } from '../../logger.js';
import { requireAuth, requireAdmin } from '../../middleware/auth.js';
import {
  getDigestByDate,
  getCurrentWeekDigest,
  getRecentDigests,
  updateDigestContent,
  approveDigest,
  isLegacyContent,
  type DigestContent,
} from '../../db/digest-db.js';
import { applyDigestEdit } from '../../addie/services/digest-editor.js';
import { buildDigestContent, hasMinimumContent, generateDigestSubject } from '../../addie/services/digest-builder.js';
import { createDigest } from '../../db/digest-db.js';
import { renderDigestEmail, type DigestSegment } from '../../addie/templates/weekly-digest.js';
import { sendMarketingEmail } from '../../notifications/email.js';

const logger = createLogger('admin-digest');

export function setupDigestAdminRoutes(apiRouter: Router): void {
  // GET /api/admin/digests - List recent digests
  apiRouter.get('/digests', requireAuth, requireAdmin, async (_req: Request, res: Response) => {
    try {
      const current = await getCurrentWeekDigest();
      const sent = await getRecentDigests(12);

      // Combine current draft (if any) with sent history
      const digests = [];
      if (current && current.status !== 'sent') {
        digests.push({
          id: current.id,
          edition_date: current.edition_date,
          status: current.status,
          approved_by: current.approved_by,
          approved_at: current.approved_at,
          send_stats: current.send_stats,
          created_at: current.created_at,
          is_legacy: isLegacyContent(current.content),
        });
      }
      for (const d of sent) {
        digests.push({
          id: d.id,
          edition_date: d.edition_date,
          status: d.status,
          approved_by: d.approved_by,
          approved_at: d.approved_at,
          send_stats: d.send_stats,
          created_at: d.created_at,
          is_legacy: isLegacyContent(d.content),
        });
      }

      res.json({ digests });
    } catch (error) {
      logger.error({ err: error }, 'Failed to list digests');
      res.status(500).json({ error: 'Failed to list digests' });
    }
  });

  // GET /api/admin/digests/current - Get current week's digest with full content
  apiRouter.get('/digests/current', requireAuth, requireAdmin, async (_req: Request, res: Response) => {
    try {
      const digest = await getCurrentWeekDigest();
      if (!digest) {
        return res.json({ digest: null });
      }
      if (isLegacyContent(digest.content)) {
        return res.json({ digest: null, error: 'Current digest uses legacy format' });
      }
      const subject = generateDigestSubject(digest.content);
      res.json({ digest, subject });
    } catch (error) {
      logger.error({ err: error }, 'Failed to get current digest');
      res.status(500).json({ error: 'Failed to get current digest' });
    }
  });

  // GET /api/admin/digests/:date - Get digest by date with full content
  apiRouter.get('/digests/:date', requireAuth, requireAdmin, async (req: Request, res: Response) => {
    try {
      const { date } = req.params;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD.' });
      }
      const digest = await getDigestByDate(date);
      if (!digest) {
        return res.status(404).json({ error: 'Digest not found' });
      }
      const subject = isLegacyContent(digest.content) ? '' : generateDigestSubject(digest.content);
      res.json({ digest, subject });
    } catch (error) {
      logger.error({ err: error }, 'Failed to get digest');
      res.status(500).json({ error: 'Failed to get digest' });
    }
  });

  // POST /api/admin/digests/generate - Generate a new draft for this week
  apiRouter.post('/digests/generate', requireAuth, requireAdmin, async (req: Request, res: Response) => {
    try {
      const existing = await getCurrentWeekDigest();
      if (existing) {
        return res.status(409).json({ error: 'A digest already exists for this week. Edit it instead.' });
      }

      const content = await buildDigestContent();
      if (!hasMinimumContent(content)) {
        return res.status(422).json({ error: 'Not enough content for a digest this week.' });
      }

      const editionDate = new Date().toISOString().split('T')[0];
      const digest = await createDigest(editionDate, content);
      if (!digest) {
        return res.status(409).json({ error: 'Digest was created by another process.' });
      }

      const subject = generateDigestSubject(content);
      logger.info({ editionDate, user: req.user?.email }, 'Digest draft generated via admin');
      res.json({ digest, subject });
    } catch (error) {
      logger.error({ err: error }, 'Failed to generate digest');
      res.status(500).json({ error: 'Failed to generate digest' });
    }
  });

  // POST /api/admin/digests/:id/edit - Apply an edit instruction
  apiRouter.post('/digests/:id/edit', requireAuth, requireAdmin, async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) {
        return res.status(400).json({ error: 'Invalid digest ID' });
      }

      const { field, value, instruction } = req.body;
      const editorName = req.user?.email || 'admin';

      // Input length limits
      if (typeof value === 'string' && value.length > 10000) {
        return res.status(400).json({ error: 'Value too long (max 10000 characters)' });
      }
      if (typeof instruction === 'string' && instruction.length > 2000) {
        return res.status(400).json({ error: 'Instruction too long (max 2000 characters)' });
      }

      // Direct field edit (from inline editing)
      if (field && value !== undefined) {
        const digest = await getCurrentWeekDigest();
        if (!digest || digest.id !== id) {
          return res.status(404).json({ error: 'Digest not found or not current' });
        }
        if (isLegacyContent(digest.content)) {
          return res.status(400).json({ error: 'Cannot edit legacy digest' });
        }

        const content = { ...digest.content } as DigestContent;
        const editEntry = {
          editedBy: editorName,
          editedAt: new Date().toISOString(),
          description: `Updated ${field}`,
        };
        content.editHistory = [...(content.editHistory || []), editEntry];

        switch (field) {
          case 'openingTake':
            content.openingTake = String(value);
            break;
          case 'editorsNote':
            content.editorsNote = value ? String(value) : undefined;
            break;
          case 'emailSubject':
            content.emailSubject = value ? String(value) : undefined;
            break;
          case 'shareableTake':
            content.shareableTake = value ? String(value) : undefined;
            break;
          default:
            return res.status(400).json({ error: `Unknown field: ${field}` });
        }

        const updated = await updateDigestContent(id, content);
        if (!updated) {
          return res.status(409).json({ error: 'Digest is no longer a draft' });
        }

        const subject = generateDigestSubject(updated.content as DigestContent);
        res.json({ digest: updated, subject, summary: `Updated ${field}` });
        return;
      }

      // LLM-assisted edit (from instruction textarea)
      if (!instruction || typeof instruction !== 'string') {
        return res.status(400).json({ error: 'Provide either field+value or instruction' });
      }

      const digest = await getCurrentWeekDigest();
      if (!digest || digest.id !== id) {
        return res.status(404).json({ error: 'Digest not found or not current' });
      }
      if (isLegacyContent(digest.content)) {
        return res.status(400).json({ error: 'Cannot edit legacy digest' });
      }

      const result = await applyDigestEdit(digest.content, instruction, editorName);
      const updated = await updateDigestContent(id, result.content);
      if (!updated) {
        return res.status(409).json({ error: 'Digest is no longer a draft' });
      }

      const subject = generateDigestSubject(result.content);
      logger.info({ id, editedBy: editorName, instruction: instruction.slice(0, 100) }, 'Digest edited via admin');
      res.json({ digest: updated, subject, summary: result.summary });
    } catch (error) {
      logger.error({ err: error }, 'Failed to edit digest');
      res.status(500).json({ error: 'Failed to edit digest' });
    }
  });

  // POST /api/admin/digests/:id/approve - Approve a draft for sending
  apiRouter.post('/digests/:id/approve', requireAuth, requireAdmin, async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) {
        return res.status(400).json({ error: 'Invalid digest ID' });
      }
      const approvedBy = req.user?.email || 'admin';
      const result = await approveDigest(id, approvedBy);
      if (!result) {
        return res.status(409).json({ error: 'Digest is not in draft status' });
      }
      logger.info({ id, approvedBy }, 'Digest approved via admin');
      res.json({ digest: result });
    } catch (error) {
      logger.error({ err: error }, 'Failed to approve digest');
      res.status(500).json({ error: 'Failed to approve digest' });
    }
  });

  // POST /api/admin/digests/:id/articles/:index/edit - Edit a specific article
  apiRouter.post('/digests/:id/articles/:index/edit', requireAuth, requireAdmin, async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id, 10);
      const index = parseInt(req.params.index, 10);
      if (isNaN(id) || isNaN(index)) {
        return res.status(400).json({ error: 'Invalid ID or index' });
      }

      const { title, summary, whyItMatters, url } = req.body;
      const editorName = req.user?.email || 'admin';

      const digest = await getCurrentWeekDigest();
      if (!digest || digest.id !== id) {
        return res.status(404).json({ error: 'Digest not found or not current' });
      }
      if (isLegacyContent(digest.content)) {
        return res.status(400).json({ error: 'Cannot edit legacy digest' });
      }

      const content = { ...digest.content } as DigestContent;
      if (index < 0 || index >= content.whatToWatch.length) {
        return res.status(400).json({ error: 'Article index out of range' });
      }

      const article = { ...content.whatToWatch[index] };
      if (title !== undefined) article.title = String(title);
      if (summary !== undefined) article.summary = String(summary);
      if (whyItMatters !== undefined) article.whyItMatters = String(whyItMatters);
      if (url !== undefined) {
        const urlStr = String(url);
        if (urlStr && !urlStr.startsWith('https://') && !urlStr.startsWith('http://')) {
          return res.status(400).json({ error: 'Article URL must use HTTP(S)' });
        }
        article.url = urlStr;
      }
      content.whatToWatch = [...content.whatToWatch];
      content.whatToWatch[index] = article;

      content.editHistory = [...(content.editHistory || []), {
        editedBy: editorName,
        editedAt: new Date().toISOString(),
        description: `Edited article "${article.title.slice(0, 40)}"`,
      }];

      const updated = await updateDigestContent(id, content);
      if (!updated) {
        return res.status(409).json({ error: 'Digest is no longer a draft' });
      }

      const subject = generateDigestSubject(updated.content as DigestContent);
      res.json({ digest: updated, subject });
    } catch (error) {
      logger.error({ err: error }, 'Failed to edit article');
      res.status(500).json({ error: 'Failed to edit article' });
    }
  });

  // DELETE /api/admin/digests/:id/articles/:index - Remove an article
  apiRouter.delete('/digests/:id/articles/:index', requireAuth, requireAdmin, async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id, 10);
      const index = parseInt(req.params.index, 10);
      if (isNaN(id) || isNaN(index)) {
        return res.status(400).json({ error: 'Invalid ID or index' });
      }

      const editorName = req.user?.email || 'admin';
      const digest = await getCurrentWeekDigest();
      if (!digest || digest.id !== id) {
        return res.status(404).json({ error: 'Digest not found or not current' });
      }
      if (isLegacyContent(digest.content)) {
        return res.status(400).json({ error: 'Cannot edit legacy digest' });
      }

      const content = { ...digest.content } as DigestContent;
      if (index < 0 || index >= content.whatToWatch.length) {
        return res.status(400).json({ error: 'Article index out of range' });
      }

      const removed = content.whatToWatch[index];
      content.whatToWatch = content.whatToWatch.filter((_, i) => i !== index);
      content.editHistory = [...(content.editHistory || []), {
        editedBy: editorName,
        editedAt: new Date().toISOString(),
        description: `Removed article "${removed.title.slice(0, 40)}"`,
      }];

      const updated = await updateDigestContent(id, content);
      if (!updated) {
        return res.status(409).json({ error: 'Digest is no longer a draft' });
      }

      const subject = generateDigestSubject(updated.content as DigestContent);
      res.json({ digest: updated, subject });
    } catch (error) {
      logger.error({ err: error }, 'Failed to remove article');
      res.status(500).json({ error: 'Failed to remove article' });
    }
  });

  // POST /api/admin/digests/:id/test-send - Send a test email to a specific address
  apiRouter.post('/digests/:id/test-send', requireAuth, requireAdmin, async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) {
        return res.status(400).json({ error: 'Invalid digest ID' });
      }

      const { email } = req.body;
      if (!email || typeof email !== 'string' || email.length > 254 || !email.includes('@') || email.includes(' ') || email.includes('\n') || email.includes('\r')) {
        return res.status(400).json({ error: 'Valid email address required' });
      }

      const digest = await getCurrentWeekDigest();
      if (!digest || digest.id !== id) {
        return res.status(404).json({ error: 'Digest not found' });
      }
      if (isLegacyContent(digest.content)) {
        return res.status(400).json({ error: 'Cannot send legacy digest' });
      }

      const content = digest.content;
      const editionDate = new Date(digest.edition_date).toISOString().split('T')[0];
      const subject = `[TEST] ${generateDigestSubject(content)}`;
      const segment: DigestSegment = 'both';
      const { html, text } = renderDigestEmail(content, 'test', editionDate, segment, 'Test');

      await sendMarketingEmail({
        to: email,
        subject,
        htmlContent: html,
        textContent: text,
        category: 'weekly_digest',
        workosUserId: req.user?.id || 'admin',
      });

      logger.info({ id, email, sentBy: req.user?.email }, 'Digest test email sent');
      res.json({ success: true, email });
    } catch (error) {
      logger.error({ err: error }, 'Failed to send test email');
      res.status(500).json({ error: 'Failed to send test email' });
    }
  });
}
