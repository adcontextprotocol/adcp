import { Router, type Request, type Response } from 'express';
import DOMPurify from 'isomorphic-dompurify';
import { createLogger } from '../../logger.js';
import { requireAuth, requireAdmin } from '../../middleware/auth.js';
import {
  getDigestByDate,
  getCurrentWeekDigest,
  getRecentDigests,
  updateDigestContent,
  approveDigest,
  setDigestCoverImage,
  isLegacyContent,
  type DigestContent,
} from '../../db/digest-db.js';
import { generateIllustration } from '../../services/illustration-generator.js';
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
          has_cover_image: current.has_cover_image,
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
          has_cover_image: d.has_cover_image,
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
        // Skip legacy or already-sent digests — generate fresh for today
        if (isLegacyContent(existing.content) || existing.status === 'sent') {
          logger.info({ digestId: existing.id, status: existing.status, isLegacy: isLegacyContent(existing.content) }, 'Skipping old/legacy digest, generating fresh');
        } else {
          // Current-format draft exists — offer to edit
          const subject = generateDigestSubject(existing.content as DigestContent);
          return res.status(409).json({ error: 'A digest already exists. Edit it instead.', digest: existing, subject });
        }
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

  // POST /api/admin/digests/:id/regenerate - Rebuild draft content from scratch
  apiRouter.post('/digests/:id/regenerate', requireAuth, requireAdmin, async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return res.status(400).json({ error: 'Invalid digest ID' });

      const digest = await getCurrentWeekDigest();
      if (!digest || digest.id !== id) {
        return res.status(404).json({ error: 'Digest not found' });
      }
      if (digest.status !== 'draft') {
        return res.status(400).json({ error: 'Can only regenerate draft editions' });
      }

      const content = await buildDigestContent();
      // Preserve editor's note and custom subject if they were manually set
      if (digest.content && !isLegacyContent(digest.content)) {
        const old = digest.content as DigestContent;
        if (old.editorsNote) content.editorsNote = old.editorsNote;
        if (old.emailSubject) content.emailSubject = old.emailSubject;
      }

      const updated = await updateDigestContent(id, content);
      if (!updated) {
        return res.status(500).json({ error: 'Failed to update digest' });
      }

      const subject = generateDigestSubject(content);
      logger.info({ digestId: id, user: req.user?.email }, 'Digest regenerated via admin');
      res.json({ digest: updated, subject });
    } catch (error) {
      logger.error({ err: error }, 'Failed to regenerate digest');
      res.status(500).json({ error: 'Failed to regenerate digest' });
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
          case 'editorsNote': {
            const raw = value ? String(value) : '';
            content.editorsNote = raw
              ? DOMPurify.sanitize(raw, {
                  ALLOWED_TAGS: ['p', 'br', 'strong', 'b', 'em', 'i', 'a', 'ul', 'ol', 'li'],
                  ALLOWED_ATTR: ['href', 'target', 'rel'],
                })
              : undefined;
            break;
          }
          case 'emailSubject':
            content.emailSubject = value ? String(value) : undefined;
            break;
          case 'shareableTake':
            content.shareableTake = value ? String(value) : undefined;
            break;
          case 'dateFlavor':
            content.dateFlavor = value ? String(value).slice(0, 300) : undefined;
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

  // POST /api/admin/digests/:id/articles/reorder - Reorder articles by index array
  apiRouter.post('/digests/:id/articles/reorder', requireAuth, requireAdmin, async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return res.status(400).json({ error: 'Invalid digest ID' });

      const digest = await getCurrentWeekDigest();
      if (!digest || digest.id !== id) return res.status(404).json({ error: 'Digest not found' });
      if (digest.status !== 'draft') return res.status(400).json({ error: 'Can only reorder draft articles' });
      if (isLegacyContent(digest.content)) return res.status(400).json({ error: 'Legacy format' });

      const content = digest.content as DigestContent;
      const { indices } = req.body;
      if (!Array.isArray(indices) || indices.length !== content.whatToWatch.length) {
        return res.status(400).json({ error: `Expected ${content.whatToWatch.length} indices` });
      }
      // Validate indices are a valid permutation (no duplicates, all in range)
      const unique = new Set(indices);
      if (unique.size !== indices.length || indices.some((i: number) => !Number.isInteger(i) || i < 0 || i >= content.whatToWatch.length)) {
        return res.status(400).json({ error: 'Indices must be a permutation of 0..' + (content.whatToWatch.length - 1) });
      }

      const reordered = indices.map((i: number) => content.whatToWatch[i]);

      content.whatToWatch = reordered;
      const updated = await updateDigestContent(id, content);
      if (!updated) return res.status(500).json({ error: 'Failed to reorder' });

      const subject = generateDigestSubject(updated.content as DigestContent);
      res.json({ digest: updated, subject });
    } catch (error) {
      logger.error({ err: error }, 'Failed to reorder articles');
      res.status(500).json({ error: 'Failed to reorder articles' });
    }
  });

  // POST /api/admin/digests/:id/regenerate-cover - Regenerate the cover image
  apiRouter.post('/digests/:id/regenerate-cover', requireAuth, requireAdmin, async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return res.status(400).json({ error: 'Invalid digest ID' });

      if (!process.env.GEMINI_API_KEY) {
        return res.status(503).json({ error: 'GEMINI_API_KEY is not configured' });
      }

      const digest = await getCurrentWeekDigest();
      if (!digest || digest.id !== id) {
        return res.status(404).json({ error: 'Digest not found or not current' });
      }
      if (digest.status !== 'draft') {
        return res.status(400).json({ error: 'Can only regenerate cover for draft editions' });
      }
      if (isLegacyContent(digest.content)) {
        return res.status(400).json({ error: 'Cannot generate cover for legacy digest' });
      }

      const content = digest.content as DigestContent;
      const editionDate = new Date(digest.edition_date).toISOString().split('T')[0];
      const subject = generateDigestSubject(content);
      const BASE_URL = process.env.BASE_URL || 'https://agenticadvertising.org';

      const { imageBuffer, promptUsed } = await generateIllustration({
        title: subject,
        category: 'The Prompt',
        excerpt: content.openingTake,
        editionDate,
        dateFlavor: content.dateFlavor,
      });

      await setDigestCoverImage(id, imageBuffer, promptUsed);
      content.coverImageUrl = `${BASE_URL}/digest/${editionDate}/cover.png`;
      await updateDigestContent(id, content);

      logger.info({ digestId: id, user: req.user?.email, sizeKB: (imageBuffer.length / 1024).toFixed(0) }, 'Cover image regenerated via admin');
      res.json({ success: true, coverImageUrl: content.coverImageUrl });
    } catch (error) {
      logger.error({ err: error }, 'Failed to regenerate cover image');
      res.status(500).json({ error: 'Failed to regenerate cover image' });
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
        from: 'Addie from AgenticAdvertising.org <addie@updates.agenticadvertising.org>',
      });

      logger.info({ id, email, sentBy: req.user?.email }, 'Digest test email sent');
      res.json({ success: true, email });
    } catch (error) {
      logger.error({ err: error }, 'Failed to send test email');
      res.status(500).json({ error: 'Failed to send test email' });
    }
  });
}
