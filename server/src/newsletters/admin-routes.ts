/**
 * Shared Newsletter Admin Routes
 *
 * Factory that creates admin API routes for any registered newsletter.
 * Handles CRUD, section toggling, custom sections, paste mode,
 * recipient count, cover regeneration, and test sends.
 */

import { randomUUID } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { createLogger } from '../logger.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import type { NewsletterConfig, CustomSection } from './config.js';
import { generateCoverForEdition } from './cover.js';
import { sendMarketingEmail } from '../notifications/email.js';

const logger = createLogger('newsletter-admin');

/** Build the uiConfig payload for the admin page */
function buildUiConfig(config: NewsletterConfig, content: unknown) {
  const c = content as Record<string, unknown>;
  const pool = (c.candidatePool || {}) as Record<string, Array<{ id: string }>>;
  const hasCandidates = Object.values(pool).some(arr => arr && arr.length > 0);

  const sections = (config.sections || []).map(s => {
    const included = (c[s.key] || []) as Array<{ id: string }>;
    const candidates = pool[s.key] || [];
    return {
      key: s.key,
      label: s.label,
      hint: s.hint || null,
      includedCount: s.countFn ? s.countFn(content) : included.length,
      candidateCount: candidates.length,
      supportsItemEdit: s.supportsItemEdit || false,
      layout: s.layout || 'full',
      includedHtml: s.renderHtml(content),
      candidateHtml: candidates.length > 0 ? s.renderHtml({ ...c, [s.key]: candidates } as unknown) : '',
    };
  });

  return {
    id: config.id,
    name: config.name,
    author: config.author,
    icon: config.adminIcon || null,
    palette: config.palette,
    editableFields: config.editableFields,
    hasInstructionEditing: !!config.applyInstruction,
    hasCandidatePool: hasCandidates,
    sections,
  };
}

/** Valid section keys for a config — used to prevent arbitrary property writes */
function getValidSectionKeys(config: NewsletterConfig): Set<string> {
  return new Set((config.sections || []).map(s => s.key));
}

/**
 * Create admin API routes for a newsletter.
 * Mount at: /api/admin/newsletters/:newsletterId/
 */
export function createNewsletterAdminRoutes(config: NewsletterConfig): Router {
  const router = Router();
  const validSectionKeys = getValidSectionKeys(config);

  // ─── List & Get ───────────────────────────────────────────────────

  router.get('/editions', requireAuth, requireAdmin, async (_req: Request, res: Response) => {
    try {
      const editions = await config.db.getRecent(20);
      res.json({ editions });
    } catch (err) {
      logger.error({ error: err, newsletterId: config.id }, 'Failed to list editions');
      res.status(500).json({ error: 'Failed to list editions' });
    }
  });

  router.get('/editions/current', requireAuth, requireAdmin, async (_req: Request, res: Response) => {
    try {
      const edition = await config.db.getCurrent();
      if (!edition) {
        return res.json({ digest: null, uiConfig: null });
      }
      const subject = config.generateSubject(edition.content);
      const uiConfig = buildUiConfig(config, edition.content);
      res.json({ digest: edition, subject, uiConfig });
    } catch (err) {
      logger.error({ error: err, newsletterId: config.id }, 'Failed to get current edition');
      res.status(500).json({ error: 'Failed to get current edition' });
    }
  });

  // ─── Generate ─────────────────────────────────────────────────────

  router.post('/editions/generate', requireAuth, requireAdmin, async (req: Request, res: Response) => {
    try {
      const existing = await config.db.getCurrent();
      if (existing) {
        const subject = config.generateSubject(existing.content);
        const uiConfig = buildUiConfig(config, existing.content);
        return res.status(409).json({ error: 'Edition already exists for this cycle.', digest: existing, subject, uiConfig });
      }

      const content = await config.buildContent();
      if (!config.hasMinimumContent(content)) {
        return res.status(422).json({ error: 'Not enough content for this cycle.' });
      }

      const editionDate = new Date().toISOString().split('T')[0];
      const edition = await config.db.createEdition(editionDate, content);
      if (!edition) {
        return res.status(409).json({ error: 'Edition was created by another process.' });
      }

      // Generate cover image (non-blocking)
      try {
        const subject = config.generateSubject(content);
        const statusLine = (content as Record<string, unknown>).statusLine as string
          || (content as Record<string, unknown>).openingTake as string || '';
        const dateFlavor = (content as Record<string, unknown>).dateFlavor as string | undefined;
        const coverResult = await generateCoverForEdition(
          config, edition.id, subject, statusLine, editionDate, dateFlavor,
        );
        if (coverResult) {
          (content as Record<string, unknown>).coverImageUrl = coverResult.coverImageUrl;
          await config.db.updateContent(edition.id, content);
        }
      } catch (err) {
        logger.warn({ error: err, newsletterId: config.id }, 'Failed to generate cover — proceeding without');
      }

      const subject = config.generateSubject(content);
      const uiConfig = buildUiConfig(config, content);
      logger.info({ editionDate, newsletterId: config.id, user: req.user?.email }, 'Draft generated via admin');
      res.json({ digest: edition, subject, uiConfig });
    } catch (err) {
      logger.error({ error: err, newsletterId: config.id }, 'Failed to generate edition');
      res.status(500).json({ error: 'Failed to generate edition' });
    }
  });

  // ─── Regenerate ───────────────────────────────────────────────────

  router.post('/editions/:id/regenerate', requireAuth, requireAdmin, async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return res.status(400).json({ error: 'Invalid edition ID' });

      const edition = await config.db.getCurrent();
      if (!edition || edition.id !== id) return res.status(404).json({ error: 'Edition not found' });
      if (edition.status !== 'draft') return res.status(400).json({ error: 'Can only regenerate draft editions' });

      const content = await config.buildContent();

      // Preserve editorial additions
      const old = edition.content as Record<string, unknown>;
      const next = content as Record<string, unknown>;
      if (old.editorsNote) next.editorsNote = old.editorsNote;
      if (old.emailSubject) next.emailSubject = old.emailSubject;
      if (old.customSections) next.customSections = old.customSections;
      if (old.hiddenSections) next.hiddenSections = old.hiddenSections;
      if (old.dismissedIds) {
        next.dismissedIds = old.dismissedIds;
        // Filter dismissed items out of the new candidate pool
        const dismissed = new Set(old.dismissedIds as string[]);
        const pool = next.candidatePool as Record<string, Array<{ id: string }>> | undefined;
        if (pool) {
          for (const key of Object.keys(pool)) {
            pool[key] = pool[key].filter(item => !dismissed.has(item.id));
          }
        }
      }

      const updated = await config.db.updateContent(id, content);
      if (!updated) return res.status(500).json({ error: 'Failed to update edition' });

      const subject = config.generateSubject(updated.content);
      const uiConfig = buildUiConfig(config, updated.content);
      logger.info({ id, newsletterId: config.id, user: req.user?.email }, 'Edition regenerated via admin');
      res.json({ digest: updated, subject, uiConfig });
    } catch (err) {
      logger.error({ error: err, newsletterId: config.id }, 'Failed to regenerate edition');
      res.status(500).json({ error: 'Failed to regenerate edition' });
    }
  });

  // ─── Edit ─────────────────────────────────────────────────────────

  router.post('/editions/:id/edit', requireAuth, requireAdmin, async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return res.status(400).json({ error: 'Invalid edition ID' });

      const edition = await config.db.getCurrent();
      if (!edition || edition.id !== id) return res.status(404).json({ error: 'Edition not found' });
      if (edition.status !== 'draft') return res.status(400).json({ error: 'Can only edit draft editions' });

      const { field, value, instruction } = req.body;

      // LLM instruction-based editing
      if (instruction && typeof instruction === 'string') {
        if (instruction.length > 2000) {
          return res.status(400).json({ error: 'Instruction too long (max 2000 characters)' });
        }
        if (!config.applyInstruction) {
          return res.status(400).json({ error: 'This newsletter does not support instruction-based editing.' });
        }
        const editorName = req.user?.email || 'admin';
        const result = await config.applyInstruction(edition.content, instruction, editorName);
        const updated = await config.db.updateContent(id, result.content);
        if (!updated) return res.status(500).json({ error: 'Failed to update edition' });
        const subject = config.generateSubject(updated.content);
        const uiConfig = buildUiConfig(config, updated.content);
        return res.json({ digest: updated, subject, uiConfig, summary: result.summary });
      }

      // Direct field edit
      if (!field || !config.editableFields.includes(field)) {
        return res.status(400).json({ error: `Field not editable. Allowed: ${config.editableFields.join(', ')}` });
      }
      if (typeof value === 'string' && value.length > 10000) {
        return res.status(400).json({ error: 'Value too long (max 10000 characters)' });
      }

      const content = edition.content as Record<string, unknown>;
      content[field] = value != null ? String(value) : undefined;

      const updated = await config.db.updateContent(id, content);
      if (!updated) return res.status(500).json({ error: 'Failed to update edition' });

      const subject = config.generateSubject(updated.content);
      const uiConfig = buildUiConfig(config, updated.content);
      res.json({ digest: updated, subject, uiConfig });
    } catch (err) {
      logger.error({ error: err, newsletterId: config.id }, 'Failed to edit edition');
      res.status(500).json({ error: 'Failed to edit edition' });
    }
  });

  // ─── Approve ──────────────────────────────────────────────────────

  router.post('/editions/:id/approve', requireAuth, requireAdmin, async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return res.status(400).json({ error: 'Invalid edition ID' });

      const approvedBy = req.user?.email || 'admin';
      const updated = await config.db.approve(id, approvedBy);
      if (!updated) return res.status(404).json({ error: 'Edition not found or not in draft status' });

      logger.info({ id, newsletterId: config.id, user: approvedBy }, 'Edition approved via admin');
      res.json({ digest: updated });
    } catch (err) {
      logger.error({ error: err, newsletterId: config.id }, 'Failed to approve edition');
      res.status(500).json({ error: 'Failed to approve edition' });
    }
  });

  // ─── Cover Regeneration ───────────────────────────────────────────

  router.post('/editions/:id/regenerate-cover', requireAuth, requireAdmin, async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return res.status(400).json({ error: 'Invalid edition ID' });

      if (!process.env.GEMINI_API_KEY) {
        return res.status(503).json({ error: 'GEMINI_API_KEY is not configured' });
      }

      const edition = await config.db.getCurrent();
      if (!edition || edition.id !== id) return res.status(404).json({ error: 'Edition not found' });
      if (edition.status !== 'draft') return res.status(400).json({ error: 'Can only regenerate cover for draft editions' });

      const content = edition.content as Record<string, unknown>;
      const editionDate = new Date(edition.edition_date).toISOString().split('T')[0];
      const subject = config.generateSubject(edition.content);
      const statusLine = (content.statusLine || content.openingTake || '') as string;

      const coverResult = await generateCoverForEdition(
        config, id, subject, statusLine, editionDate, content.dateFlavor as string | undefined,
      );
      if (!coverResult) return res.status(500).json({ error: 'Failed to store cover image' });

      content.coverImageUrl = coverResult.coverImageUrl;
      await config.db.updateContent(id, content);

      logger.info({ id, newsletterId: config.id, user: req.user?.email }, 'Cover regenerated via admin');
      res.json({ success: true, coverImageUrl: coverResult.coverImageUrl });
    } catch (err) {
      logger.error({ error: err, newsletterId: config.id }, 'Failed to regenerate cover');
      res.status(500).json({ error: 'Failed to regenerate cover image' });
    }
  });

  // ─── Test Send ────────────────────────────────────────────────────

  router.post('/editions/:id/test-send', requireAuth, requireAdmin, async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return res.status(400).json({ error: 'Invalid edition ID' });

      const { email } = req.body;
      if (!email || typeof email !== 'string' || !email.includes('@') || email.length > 254) {
        return res.status(400).json({ error: 'Valid email address required' });
      }

      const edition = await config.db.getCurrent();
      if (!edition || edition.id !== id) return res.status(404).json({ error: 'Edition not found' });

      const editionDate = new Date(edition.edition_date).toISOString().split('T')[0];
      const subject = config.generateSubject(edition.content);
      const { html, text } = config.renderEmail(edition.content, 'test', editionDate, 'both', undefined);

      await sendMarketingEmail({
        to: email,
        subject: `[TEST] ${subject}`,
        htmlContent: html,
        textContent: text,
        category: config.emailCategory,
        workosUserId: req.user?.id || 'admin',
        from: config.fromEmail,
      });

      logger.info({ email, id, newsletterId: config.id, user: req.user?.email }, 'Test email sent');
      res.json({ success: true, email });
    } catch (err) {
      logger.error({ error: err, newsletterId: config.id }, 'Failed to send test email');
      res.status(500).json({ error: 'Failed to send test email' });
    }
  });

  // ─── Recipient Count ──────────────────────────────────────────────

  router.get('/recipients/count', requireAuth, requireAdmin, async (_req: Request, res: Response) => {
    try {
      const recipients = await config.db.getRecipients();
      const emailCount = recipients.length;
      const slackCount = recipients.filter(r => r.has_slack).length;
      res.json({ emailCount, slackCount, total: emailCount });
    } catch (err) {
      logger.error({ error: err, newsletterId: config.id }, 'Failed to get recipient count');
      res.status(500).json({ error: 'Failed to get recipient count' });
    }
  });

  // ─── Section Toggle ───────────────────────────────────────────────

  router.post('/editions/:id/toggle-section', requireAuth, requireAdmin, async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return res.status(400).json({ error: 'Invalid edition ID' });

      const edition = await config.db.getCurrent();
      if (!edition || edition.id !== id) return res.status(404).json({ error: 'Edition not found' });
      if (edition.status !== 'draft') return res.status(400).json({ error: 'Can only edit draft editions' });

      const { section, visible } = req.body;
      const validKeys = (config.sections || []).map(s => s.key);
      if (!section || !validKeys.includes(section)) {
        return res.status(400).json({ error: `Invalid section. Valid: ${validKeys.join(', ')}` });
      }

      const content = edition.content as Record<string, unknown>;
      const hidden = new Set((content.hiddenSections as string[]) || []);
      if (visible) { hidden.delete(section); } else { hidden.add(section); }
      content.hiddenSections = [...hidden];

      const updated = await config.db.updateContent(id, content);
      if (!updated) return res.status(500).json({ error: 'Failed to update edition' });

      const subject = config.generateSubject(updated.content);
      const uiConfig = buildUiConfig(config, updated.content);
      res.json({ digest: updated, subject, uiConfig });
    } catch (err) {
      logger.error({ error: err, newsletterId: config.id }, 'Failed to toggle section');
      res.status(500).json({ error: 'Failed to toggle section' });
    }
  });

  // ─── Cherry-Pick: Include Item ──────────────────────────────────

  router.post('/editions/:id/include-item', requireAuth, requireAdmin, async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return res.status(400).json({ error: 'Invalid edition ID' });

      const edition = await config.db.getCurrent();
      if (!edition || edition.id !== id) return res.status(404).json({ error: 'Edition not found' });
      if (edition.status !== 'draft') return res.status(400).json({ error: 'Can only edit draft editions' });

      const { sectionKey, itemId } = req.body;
      if (!sectionKey || typeof sectionKey !== 'string' || !validSectionKeys.has(sectionKey)) {
        return res.status(400).json({ error: `Invalid sectionKey. Valid: ${[...validSectionKeys].join(', ')}` });
      }
      if (!itemId || typeof itemId !== 'string') return res.status(400).json({ error: 'itemId must be a non-empty string' });

      const content = edition.content as Record<string, unknown>;
      const pool = (content.candidatePool || {}) as Record<string, Array<{ id: string }>>;
      const candidates = pool[sectionKey];
      if (!candidates) return res.status(400).json({ error: `No candidate pool for section: ${sectionKey}` });

      const item = candidates.find(c => c.id === itemId);
      if (!item) return res.status(404).json({ error: 'Item not found in candidate pool' });

      // Move from pool to included array
      pool[sectionKey] = candidates.filter(c => c.id !== itemId);
      const included = (content[sectionKey] || []) as Array<{ id: string }>;
      if (!included.some(i => i.id === itemId)) {
        included.push(item);
      }
      content[sectionKey] = included;
      content.candidatePool = pool;

      const updated = await config.db.updateContent(id, content);
      if (!updated) return res.status(500).json({ error: 'Failed to update edition' });

      const subject = config.generateSubject(updated.content);
      const uiConfig = buildUiConfig(config, updated.content);
      res.json({ digest: updated, subject, uiConfig });
    } catch (err) {
      logger.error({ error: err, newsletterId: config.id }, 'Failed to include item');
      res.status(500).json({ error: 'Failed to include item' });
    }
  });

  // ─── Cherry-Pick: Dismiss Item ────────────────────────────────────

  router.post('/editions/:id/dismiss-item', requireAuth, requireAdmin, async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return res.status(400).json({ error: 'Invalid edition ID' });

      const edition = await config.db.getCurrent();
      if (!edition || edition.id !== id) return res.status(404).json({ error: 'Edition not found' });
      if (edition.status !== 'draft') return res.status(400).json({ error: 'Can only edit draft editions' });

      const { sectionKey, itemId } = req.body;
      if (!sectionKey || typeof sectionKey !== 'string' || !validSectionKeys.has(sectionKey)) {
        return res.status(400).json({ error: `Invalid sectionKey. Valid: ${[...validSectionKeys].join(', ')}` });
      }
      if (!itemId || typeof itemId !== 'string') return res.status(400).json({ error: 'itemId must be a non-empty string' });

      const content = edition.content as Record<string, unknown>;

      // Remove from candidate pool
      const pool = (content.candidatePool || {}) as Record<string, Array<{ id: string }>>;
      if (pool[sectionKey]) {
        pool[sectionKey] = pool[sectionKey].filter(c => c.id !== itemId);
        content.candidatePool = pool;
      }

      // Also remove from included if it was there
      const included = (content[sectionKey] || []) as Array<{ id: string }>;
      content[sectionKey] = included.filter(i => i.id !== itemId);

      // Track as dismissed
      const dismissed = new Set((content.dismissedIds as string[]) || []);
      dismissed.add(itemId);
      content.dismissedIds = [...dismissed];

      const updated = await config.db.updateContent(id, content);
      if (!updated) return res.status(500).json({ error: 'Failed to update edition' });

      const subject = config.generateSubject(updated.content);
      const uiConfig = buildUiConfig(config, updated.content);
      res.json({ digest: updated, subject, uiConfig });
    } catch (err) {
      logger.error({ error: err, newsletterId: config.id }, 'Failed to dismiss item');
      res.status(500).json({ error: 'Failed to dismiss item' });
    }
  });

  // ─── Cherry-Pick: Remove from Included (back to pool) ────────────

  router.post('/editions/:id/uninclude-item', requireAuth, requireAdmin, async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return res.status(400).json({ error: 'Invalid edition ID' });

      const edition = await config.db.getCurrent();
      if (!edition || edition.id !== id) return res.status(404).json({ error: 'Edition not found' });
      if (edition.status !== 'draft') return res.status(400).json({ error: 'Can only edit draft editions' });

      const { sectionKey, itemId } = req.body;
      if (!sectionKey || typeof sectionKey !== 'string' || !validSectionKeys.has(sectionKey)) {
        return res.status(400).json({ error: `Invalid sectionKey. Valid: ${[...validSectionKeys].join(', ')}` });
      }
      if (!itemId || typeof itemId !== 'string') return res.status(400).json({ error: 'itemId must be a non-empty string' });

      const content = edition.content as Record<string, unknown>;
      const included = (content[sectionKey] || []) as Array<{ id: string }>;
      const item = included.find(i => i.id === itemId);
      if (!item) return res.status(404).json({ error: 'Item not in included list' });

      // Move back to candidate pool
      content[sectionKey] = included.filter(i => i.id !== itemId);
      const pool = (content.candidatePool || {}) as Record<string, Array<{ id: string }>>;
      if (!pool[sectionKey]) pool[sectionKey] = [];
      pool[sectionKey].push(item);
      content.candidatePool = pool;

      const updated = await config.db.updateContent(id, content);
      if (!updated) return res.status(500).json({ error: 'Failed to update edition' });

      const subject = config.generateSubject(updated.content);
      const uiConfig = buildUiConfig(config, updated.content);
      res.json({ digest: updated, subject, uiConfig });
    } catch (err) {
      logger.error({ error: err, newsletterId: config.id }, 'Failed to uninclude item');
      res.status(500).json({ error: 'Failed to uninclude item' });
    }
  });

  // ─── Cherry-Pick: Include All (bulk) ──────────────────────────────

  router.post('/editions/:id/include-all', requireAuth, requireAdmin, async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return res.status(400).json({ error: 'Invalid edition ID' });

      const edition = await config.db.getCurrent();
      if (!edition || edition.id !== id) return res.status(404).json({ error: 'Edition not found' });
      if (edition.status !== 'draft') return res.status(400).json({ error: 'Can only edit draft editions' });

      const { sectionKey } = req.body;
      if (!sectionKey || typeof sectionKey !== 'string' || !validSectionKeys.has(sectionKey)) {
        return res.status(400).json({ error: `Invalid sectionKey. Valid: ${[...validSectionKeys].join(', ')}` });
      }

      const content = edition.content as Record<string, unknown>;
      const pool = (content.candidatePool || {}) as Record<string, Array<{ id: string }>>;
      const candidates = pool[sectionKey] || [];
      const included = (content[sectionKey] || []) as Array<{ id: string }>;
      const existingIds = new Set(included.map(i => i.id));

      for (const item of candidates) {
        if (!existingIds.has(item.id)) included.push(item);
      }
      content[sectionKey] = included;
      pool[sectionKey] = [];
      content.candidatePool = pool;

      const updated = await config.db.updateContent(id, content);
      if (!updated) return res.status(500).json({ error: 'Failed to update edition' });

      const subject = config.generateSubject(updated.content);
      const uiConfig = buildUiConfig(config, updated.content);
      res.json({ digest: updated, subject, uiConfig });
    } catch (err) {
      logger.error({ error: err, newsletterId: config.id }, 'Failed to include all items');
      res.status(500).json({ error: 'Failed to include all items' });
    }
  });

  // ─── Custom Sections ──────────────────────────────────────────────

  router.post('/editions/:id/custom-sections', requireAuth, requireAdmin, async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return res.status(400).json({ error: 'Invalid edition ID' });

      const edition = await config.db.getCurrent();
      if (!edition || edition.id !== id) return res.status(404).json({ error: 'Edition not found' });
      if (edition.status !== 'draft') return res.status(400).json({ error: 'Can only edit draft editions' });

      const { sectionId, title, body, position } = req.body;
      if (!body || typeof body !== 'string') return res.status(400).json({ error: 'body is required' });
      if (body.length > 10000) return res.status(400).json({ error: 'Section body too long (max 10000 characters)' });

      const content = edition.content as Record<string, unknown>;
      const sections = [...((content.customSections as CustomSection[]) || [])];

      if (sectionId) {
        const idx = sections.findIndex(s => s.id === sectionId);
        if (idx < 0) return res.status(404).json({ error: 'Custom section not found' });
        sections[idx] = { ...sections[idx], title: title || '', body, position: position ?? sections[idx].position };
      } else {
        sections.push({ id: `custom_${randomUUID()}`, title: title || '', body, position: position ?? sections.length });
      }
      content.customSections = sections;

      const updated = await config.db.updateContent(id, content);
      if (!updated) return res.status(500).json({ error: 'Failed to update edition' });

      const subject = config.generateSubject(updated.content);
      const uiConfig = buildUiConfig(config, updated.content);
      res.json({ digest: updated, subject, uiConfig });
    } catch (err) {
      logger.error({ error: err, newsletterId: config.id }, 'Failed to save custom section');
      res.status(500).json({ error: 'Failed to save custom section' });
    }
  });

  router.delete('/editions/:id/custom-sections/:sectionId', requireAuth, requireAdmin, async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return res.status(400).json({ error: 'Invalid edition ID' });

      const edition = await config.db.getCurrent();
      if (!edition || edition.id !== id) return res.status(404).json({ error: 'Edition not found' });
      if (edition.status !== 'draft') return res.status(400).json({ error: 'Can only edit draft editions' });

      const content = edition.content as Record<string, unknown>;
      content.customSections = ((content.customSections as CustomSection[]) || []).filter(s => s.id !== req.params.sectionId);

      const updated = await config.db.updateContent(id, content);
      if (!updated) return res.status(500).json({ error: 'Failed to update edition' });

      const subject = config.generateSubject(updated.content);
      const uiConfig = buildUiConfig(config, updated.content);
      res.json({ digest: updated, subject, uiConfig });
    } catch (err) {
      logger.error({ error: err, newsletterId: config.id }, 'Failed to delete custom section');
      res.status(500).json({ error: 'Failed to delete custom section' });
    }
  });

  // ─── Paste Content ────────────────────────────────────────────────

  router.post('/editions/:id/paste-content', requireAuth, requireAdmin, async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return res.status(400).json({ error: 'Invalid edition ID' });

      const edition = await config.db.getCurrent();
      if (!edition || edition.id !== id) return res.status(404).json({ error: 'Edition not found' });
      if (edition.status !== 'draft') return res.status(400).json({ error: 'Can only edit draft editions' });

      const { statusLine, body, emailSubject } = req.body;
      if (!body || typeof body !== 'string') return res.status(400).json({ error: 'body is required' });
      if (body.length > 50000) return res.status(400).json({ error: 'Content too long (max 50000 characters)' });

      const content = edition.content as Record<string, unknown>;
      content.pastedContent = body;
      if (statusLine) content.statusLine = statusLine;
      if ((content as Record<string, unknown>).openingTake !== undefined && statusLine) {
        content.openingTake = statusLine;
      }
      if (emailSubject) content.emailSubject = emailSubject;

      const updated = await config.db.updateContent(id, content);
      if (!updated) return res.status(500).json({ error: 'Failed to update edition' });

      const subject = config.generateSubject(updated.content);
      const uiConfig = buildUiConfig(config, updated.content);
      logger.info({ id, newsletterId: config.id, user: req.user?.email }, 'Content pasted via admin');
      res.json({ digest: updated, subject, uiConfig });
    } catch (err) {
      logger.error({ error: err, newsletterId: config.id }, 'Failed to paste content');
      res.status(500).json({ error: 'Failed to paste content' });
    }
  });

  // Clear pasted content (revert to auto-generated)
  router.delete('/editions/:id/paste-content', requireAuth, requireAdmin, async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return res.status(400).json({ error: 'Invalid edition ID' });

      const edition = await config.db.getCurrent();
      if (!edition || edition.id !== id) return res.status(404).json({ error: 'Edition not found' });
      if (edition.status !== 'draft') return res.status(400).json({ error: 'Can only edit draft editions' });

      const content = edition.content as Record<string, unknown>;
      delete content.pastedContent;

      const updated = await config.db.updateContent(id, content);
      if (!updated) return res.status(500).json({ error: 'Failed to update edition' });

      const subject = config.generateSubject(updated.content);
      const uiConfig = buildUiConfig(config, updated.content);
      res.json({ digest: updated, subject, uiConfig });
    } catch (err) {
      logger.error({ error: err, newsletterId: config.id }, 'Failed to clear pasted content');
      res.status(500).json({ error: 'Failed to clear pasted content' });
    }
  });

  // ─── Item-Level Operations ────────────────────────────────────────

  router.post('/editions/:id/sections/:key/items/:index/edit', requireAuth, requireAdmin, async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id, 10);
      const index = parseInt(req.params.index, 10);
      if (isNaN(id) || isNaN(index)) return res.status(400).json({ error: 'Invalid ID or index' });

      const ops = config.itemOperations?.[req.params.key];
      if (!ops) return res.status(404).json({ error: 'Section does not support item editing' });

      const edition = await config.db.getCurrent();
      if (!edition || edition.id !== id) return res.status(404).json({ error: 'Edition not found' });
      if (edition.status !== 'draft') return res.status(400).json({ error: 'Can only edit draft editions' });

      const editorName = req.user?.email || 'admin';
      const content = ops.editItem(edition.content, index, req.body, editorName);

      const updated = await config.db.updateContent(id, content);
      if (!updated) return res.status(500).json({ error: 'Failed to update edition' });

      const subject = config.generateSubject(updated.content);
      const uiConfig = buildUiConfig(config, updated.content);
      res.json({ digest: updated, subject, uiConfig });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to edit item';
      logger.error({ error: err, newsletterId: config.id }, msg);
      res.status(400).json({ error: msg });
    }
  });

  router.delete('/editions/:id/sections/:key/items/:index', requireAuth, requireAdmin, async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id, 10);
      const index = parseInt(req.params.index, 10);
      if (isNaN(id) || isNaN(index)) return res.status(400).json({ error: 'Invalid ID or index' });

      const ops = config.itemOperations?.[req.params.key];
      if (!ops) return res.status(404).json({ error: 'Section does not support item deletion' });

      const edition = await config.db.getCurrent();
      if (!edition || edition.id !== id) return res.status(404).json({ error: 'Edition not found' });
      if (edition.status !== 'draft') return res.status(400).json({ error: 'Can only edit draft editions' });

      const editorName = req.user?.email || 'admin';
      const content = ops.deleteItem(edition.content, index, editorName);

      const updated = await config.db.updateContent(id, content);
      if (!updated) return res.status(500).json({ error: 'Failed to update edition' });

      const subject = config.generateSubject(updated.content);
      const uiConfig = buildUiConfig(config, updated.content);
      res.json({ digest: updated, subject, uiConfig });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to delete item';
      logger.error({ error: err, newsletterId: config.id }, msg);
      res.status(400).json({ error: msg });
    }
  });

  router.post('/editions/:id/sections/:key/items/reorder', requireAuth, requireAdmin, async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return res.status(400).json({ error: 'Invalid edition ID' });

      const ops = config.itemOperations?.[req.params.key];
      if (!ops) return res.status(404).json({ error: 'Section does not support reordering' });

      const edition = await config.db.getCurrent();
      if (!edition || edition.id !== id) return res.status(404).json({ error: 'Edition not found' });
      if (edition.status !== 'draft') return res.status(400).json({ error: 'Can only edit draft editions' });

      const { indices } = req.body;
      if (!Array.isArray(indices)) return res.status(400).json({ error: 'indices array is required' });

      const editorName = req.user?.email || 'admin';
      const content = ops.reorderItems(edition.content, indices, editorName);

      const updated = await config.db.updateContent(id, content);
      if (!updated) return res.status(500).json({ error: 'Failed to update edition' });

      const subject = config.generateSubject(updated.content);
      const uiConfig = buildUiConfig(config, updated.content);
      res.json({ digest: updated, subject, uiConfig });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to reorder items';
      logger.error({ error: err, newsletterId: config.id }, msg);
      res.status(400).json({ error: msg });
    }
  });

  return router;
}
