/**
 * Admin moderation queue for registry submissions (adcp#8338).
 *
 *   GET  /admin/registry-review                        — the page
 *   GET  /api/admin/registry-review/queue              — queue + backlog
 *   GET  /api/admin/registry-review/backlog            — backlog signal only
 *   POST /api/admin/registry-review/records/:entityType/:domain — approve | reject
 *   POST /api/admin/registry-review/items/:itemId      — approve | revert
 *
 * Why this exists: since #8337 the automated registry review fails safe.
 * An unparseable verdict, an out-of-contract verdict, or a failed model
 * call (an Anthropic outage, or a deployment with no `ANTHROPIC_API_KEY`)
 * all leave the submission pending rather than publishing it. The
 * moderator Slack channel was the only queue, so an outage could build a
 * backlog behind a message nobody re-read.
 *
 * Two shapes of work, two endpoints, because their preconditions differ:
 *
 *  - **Pending records** are keyed by `(entity_type, domain)` and are
 *    gated on `review_status = 'pending'`. That guard is what keeps this
 *    endpoint from being a way to delete a live, approved registry record.
 *  - **Flagged edits** are keyed by queue item, because the revert target
 *    is the revision the reviewer formed its verdict over. #8337 fixed
 *    those semantics — undoing edit N restores revision N — so the
 *    revision comes from the stored item and is never client-supplied.
 *    Moderators who want to roll back to some other revision use the
 *    existing `/api/brands/discovered/:domain/rollback` route.
 */

import type { Request, Response, Router } from 'express';
import { createLogger } from '../../logger.js';
import { requireGlobalAdmin } from '../../middleware/auth.js';
import { serveHtmlWithConfig } from '../../utils/html-config.js';
import { BrandDatabase } from '../../db/brand-db.js';
import { PropertyDatabase } from '../../db/property-db.js';
import {
  getOpenRegistryReviewItem,
  getRegistryReviewBacklog,
  listRegistryReviewQueue,
  reopenRegistryReviewItem,
  resolveOpenRegistryReviewItemsForRecord,
  resolveRegistryReviewItem,
  type RegistryEntityType,
  type RegistryReviewModerator,
} from '../../db/registry-review-queue-db.js';
import { notifyRegistryReviewResolved } from '../../notifications/registry.js';
import { isUuid } from '../../utils/uuid.js';

const logger = createLogger('admin-registry-review');

const DOMAIN_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
const MAX_DOMAIN_LENGTH = 253;
const NOTE_MAX = 500;

const brandDb = new BrandDatabase();
const propertyDb = new PropertyDatabase();

/**
 * Moderation is attributable or it does not happen.
 *
 * `requireAdmin` accepts the static `ADMIN_API_KEY` for internal tooling,
 * which has no human behind it — the same reason
 * `/api/brands/discovered/:domain/rollback` refuses key-authenticated
 * callers. Reads stay open to it so ops scripts can watch the backlog.
 */
function resolveModerator(req: Request, res: Response): RegistryReviewModerator | null {
  const isStaticAdminKey = (req as Request & { isStaticAdminApiKey?: boolean }).isStaticAdminApiKey === true;
  const userId = req.user?.id;
  if (
    isStaticAdminKey
    || (req as Request & { apiKey?: unknown }).apiKey
    || !userId
    || userId === 'admin_api_key'
    || userId.startsWith('api_key_')
  ) {
    res.status(403).json({
      error: 'Human admin session required',
      message: 'Registry moderation actions are recorded against a moderator identity, so they cannot be taken with an API key.',
    });
    return null;
  }
  return { user_id: userId, email: req.user?.email ?? null };
}

function parseEntityType(value: string): RegistryEntityType | null {
  return value === 'brand' || value === 'property' ? value : null;
}

function parseDomain(raw: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  const domain = decoded.trim().toLowerCase();
  if (!domain || domain.length > MAX_DOMAIN_LENGTH || !DOMAIN_PATTERN.test(domain)) return null;
  return domain;
}

function parseNote(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, NOTE_MAX) : undefined;
}

function moderatorName(req: Request): string | undefined {
  const user = req.user as (Request['user'] & { displayName?: string }) | undefined;
  return user?.displayName || undefined;
}

export function setupRegistryReviewRoutes(pageRouter: Router, apiRouter: Router): void {
  pageRouter.get('/registry-review', ...requireGlobalAdmin, (req, res) => {
    serveHtmlWithConfig(req, res, 'admin-registry-review.html').catch((err) => {
      logger.error({ err }, 'Error serving registry review page');
      res.status(500).send('Internal server error');
    });
  });

  // GET /api/admin/registry-review/queue — the queue plus the backlog
  // signal, so the page renders both from one round-trip.
  apiRouter.get('/registry-review/queue', ...requireGlobalAdmin, async (req, res) => {
    try {
      const rawLimit = parseInt(String(req.query.limit ?? ''), 10);
      const rawOffset = parseInt(String(req.query.offset ?? ''), 10);
      const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 200) : 50;
      const offset = Number.isFinite(rawOffset) ? Math.max(rawOffset, 0) : 0;

      const [items, backlog] = await Promise.all([
        listRegistryReviewQueue({ limit, offset }),
        getRegistryReviewBacklog(),
      ]);

      return res.json({ items, backlog, limit, offset });
    } catch (error) {
      logger.error({ err: error }, 'Failed to list the registry review queue');
      return res.status(500).json({ error: 'Failed to list the registry review queue' });
    }
  });

  // GET /api/admin/registry-review/backlog — count + oldest age. Separate
  // from the queue so operational checks can poll it without paying for
  // the per-record joins.
  apiRouter.get('/registry-review/backlog', ...requireGlobalAdmin, async (_req, res) => {
    try {
      return res.json(await getRegistryReviewBacklog());
    } catch (error) {
      logger.error({ err: error }, 'Failed to read the registry review backlog');
      return res.status(500).json({ error: 'Failed to read the registry review backlog' });
    }
  });

  // POST /api/admin/registry-review/records/:entityType/:domain
  // Publish or remove a record that is still waiting on review.
  apiRouter.post('/registry-review/records/:entityType/:domain', ...requireGlobalAdmin, async (req, res) => {
    const entityType = parseEntityType(req.params.entityType);
    const domain = parseDomain(req.params.domain);
    const action = req.body?.action;

    if (!entityType) return res.status(400).json({ error: 'entityType must be brand or property' });
    if (!domain) return res.status(400).json({ error: 'Invalid domain' });
    if (action !== 'approve' && action !== 'reject') {
      return res.status(400).json({ error: 'action must be approve or reject' });
    }

    const moderator = resolveModerator(req, res);
    if (!moderator) return;
    const note = parseNote(req.body?.note);

    try {
      // The pending guard is the authorization boundary for `reject`:
      // without it this endpoint would delete live registry records.
      const record = entityType === 'brand'
        ? await brandDb.getDiscoveredBrandByDomain(domain)
        : await propertyDb.getHostedPropertyByDomain(domain);

      if (!record) {
        return res.status(404).json({ error: 'Record not found' });
      }
      // A null `review_status` is a pre-#205 row, which the registry
      // treats as approved — so it is not this endpoint's to delete.
      if (record.review_status !== 'pending') {
        return res.status(409).json({
          error: 'Record is not pending review',
          review_status: record.review_status ?? 'approved',
        });
      }

      if (action === 'approve') {
        const approved = entityType === 'brand'
          ? await brandDb.approveBrand(domain)
          : await propertyDb.approveProperty(domain);
        if (!approved) {
          return res.status(404).json({ error: 'Record not found' });
        }
      } else {
        const removed = entityType === 'brand'
          ? await brandDb.deleteDiscoveredBrand(domain, {
              actor_user_id: moderator.user_id,
              source: 'admin_registry_review_reject',
            })
          : await propertyDb.deleteHostedPropertyByDomain(domain);
        if (!removed) {
          return res.status(404).json({ error: 'Record not found' });
        }
      }

      const resolution = action === 'approve' ? 'approved' as const : 'rejected' as const;
      // Best effort: the record state is already changed, so a failure
      // here must not report the action as failed. The queue reads
      // `review_status`, so the entry disappears either way.
      let resolvedItems = 0;
      try {
        resolvedItems = await resolveOpenRegistryReviewItemsForRecord(
          entityType, domain, resolution, moderator, note,
        );
      } catch (err) {
        logger.error({ err, domain, entityType }, 'Failed to close review queue items after a record decision');
      }

      logger.info(
        { domain, entityType, action, moderator: moderator.user_id, resolvedItems },
        'Registry review record decision',
      );

      notifyRegistryReviewResolved({
        entity_type: entityType,
        domain,
        action: resolution,
        moderator_email: moderator.email ?? undefined,
        moderator_name: moderatorName(req),
        note,
      }).catch((err) => logger.error({ err, domain }, 'Registry review resolution notification failed'));

      return res.json({ success: true, entity_type: entityType, domain, resolution, resolved_items: resolvedItems });
    } catch (error) {
      logger.error({ err: error, domain, entityType, action }, 'Registry review record decision failed');
      return res.status(500).json({ error: 'Failed to record the decision' });
    }
  });

  // POST /api/admin/registry-review/items/:itemId
  // Accept or revert a live edit an inconclusive review left behind.
  apiRouter.post('/registry-review/items/:itemId', ...requireGlobalAdmin, async (req, res) => {
    const itemId = req.params.itemId;
    const action = req.body?.action;

    if (!isUuid(itemId)) return res.status(400).json({ error: 'Invalid item id' });
    if (action !== 'approve' && action !== 'revert') {
      return res.status(400).json({ error: 'action must be approve or revert' });
    }

    const moderator = resolveModerator(req, res);
    if (!moderator) return;
    const note = parseNote(req.body?.note);

    try {
      const item = await getOpenRegistryReviewItem(itemId);
      if (!item) {
        return res.status(404).json({ error: 'Queue item not found or already resolved' });
      }
      if (item.submission_kind !== 'edit') {
        return res.status(409).json({
          error: 'This item is a pending record. Use the record endpoint to approve or reject it.',
        });
      }
      if (action === 'revert' && !(Number(item.revision_number) >= 1)) {
        return res.status(409).json({ error: 'No revision is recorded for this edit, so it cannot be reverted' });
      }

      const resolution = action === 'approve' ? 'approved' as const : 'reverted' as const;
      // Claim first: two moderators clicking the same revert race here
      // rather than both rolling the record back.
      const claimed = await resolveRegistryReviewItem(itemId, resolution, moderator, note);
      if (!claimed) {
        return res.status(409).json({ error: 'Queue item was already resolved' });
      }

      let restoredRevision: number | undefined;
      if (action === 'revert') {
        // Revision N holds the state before edit N, so undoing edit N
        // means restoring revision N (adcp#8337). The number comes from
        // the stored item, never from the request body.
        const toRevision = Number(item.revision_number);
        try {
          if (item.entity_type === 'brand') {
            await brandDb.rollbackBrand(item.domain, toRevision, {
              user_id: moderator.user_id,
              email: moderator.email ?? undefined,
              name: moderatorName(req) || moderator.email || moderator.user_id,
            });
          } else {
            await propertyDb.rollbackProperty(item.domain, toRevision, {
              user_id: moderator.user_id,
              email: moderator.email ?? undefined,
              name: moderatorName(req) || moderator.email || moderator.user_id,
            });
          }
          restoredRevision = toRevision;
        } catch (revertError) {
          // The claim has to come off: an item marked reverted by a
          // revert that never happened is how live vandalism gets closed
          // as handled.
          await reopenRegistryReviewItem(itemId).catch((err) =>
            logger.error({ err, itemId }, 'Failed to reopen review item after a failed revert'));
          logger.error({ err: revertError, itemId, domain: item.domain }, 'Registry review revert failed');
          return res.status(500).json({ error: 'Failed to revert the edit' });
        }
      }

      logger.info(
        { itemId, domain: item.domain, entityType: item.entity_type, action, moderator: moderator.user_id },
        'Registry review edit decision',
      );

      notifyRegistryReviewResolved({
        entity_type: item.entity_type,
        domain: item.domain,
        action: resolution,
        moderator_email: moderator.email ?? undefined,
        moderator_name: moderatorName(req),
        restored_revision: restoredRevision,
        note,
      }).catch((err) => logger.error({ err, itemId }, 'Registry review resolution notification failed'));

      return res.json({
        success: true,
        item_id: itemId,
        entity_type: item.entity_type,
        domain: item.domain,
        resolution,
        restored_revision: restoredRevision ?? null,
      });
    } catch (error) {
      logger.error({ err: error, itemId, action }, 'Registry review edit decision failed');
      return res.status(500).json({ error: 'Failed to record the decision' });
    }
  });
}
