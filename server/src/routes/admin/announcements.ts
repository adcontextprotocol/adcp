/**
 * Admin "Announcements" backlog page.
 *
 * Gives the editorial team a single surface to see what's waiting on
 * them across all orgs: pending-review drafts, Slack-posted-waiting-
 * on-LinkedIn, fully done, and skipped. Counterpart to the Workflow B
 * Stage 2/3 Slack buttons — no actions live here, but every row links
 * to the account detail page where the Mark-LinkedIn button lives.
 *
 * Page:   GET  /admin/announcements
 * API:    GET  /api/admin/announcements
 */

import { Router, Request, Response } from 'express';
import { createLogger } from '../../logger.js';
import { requireAuth, requireAdmin } from '../../middleware/auth.js';
import { serveHtmlWithConfig } from '../../utils/html-config.js';
import { loadAnnouncementBacklog } from '../../addie/jobs/announcement-handlers.js';

const logger = createLogger('admin-announcements');

export function setupAnnouncementsRoutes(
  pageRouter: Router,
  apiRouter: Router,
): void {
  pageRouter.get(
    '/admin/announcements',
    requireAuth,
    requireAdmin,
    (req, res) => {
      serveHtmlWithConfig(req, res, 'admin-announcements.html').catch((err) => {
        logger.error({ err }, 'Error serving announcements page');
        res.status(500).send('Internal server error');
      });
    },
  );

  apiRouter.get(
    '/announcements',
    requireAuth,
    requireAdmin,
    async (_req: Request, res: Response) => {
      try {
        const rows = await loadAnnouncementBacklog();
        // Derive per-row state and counts server-side for convenience;
        // client still filters/sorts but doesn't have to compute.
        const shaped = rows.map((r) => ({
          organization_id: r.organization_id,
          org_name: r.org_name,
          membership_tier: r.membership_tier,
          profile_slug: r.profile_slug,
          draft_posted_at: r.draft_posted_at.toISOString(),
          slack_posted_at: r.slack_posted_at?.toISOString() ?? null,
          linkedin_marked_at: r.linkedin_marked_at?.toISOString() ?? null,
          skipped_at: r.skipped_at?.toISOString() ?? null,
          slack_posted: r.slack_posted,
          linkedin_posted: r.linkedin_posted,
          skipped: r.skipped,
          is_backfill: r.is_backfill,
          visual_source: r.visual_source,
          state: deriveState(r),
        }));

        const counts = {
          all: shaped.length,
          pending_review: shaped.filter((r) => r.state === 'pending_review').length,
          li_pending: shaped.filter((r) => r.state === 'li_pending').length,
          done: shaped.filter((r) => r.state === 'done').length,
          skipped: shaped.filter((r) => r.state === 'skipped').length,
        };

        res.json({ counts, rows: shaped });
      } catch (err) {
        logger.error({ err }, 'Failed to load announcement backlog');
        res.status(500).json({ error: 'Failed to load announcement backlog' });
      }
    },
  );
}

/**
 * State bucket for the backlog table + filter tabs.
 *
 *  - `pending_review` — draft posted, neither channel posted, not skipped
 *  - `li_pending`     — slack posted, LinkedIn not yet marked, not skipped
 *  - `done`           — both channels posted
 *  - `skipped`        — skip row recorded, regardless of what came before
 *
 * Skipped takes precedence over slack/LI in case of a data anomaly (e.g.,
 * a skip row written after a slack post — shouldn't happen because the
 * Stage 2 skip handler refuses that transition, but render defensively).
 */
function deriveState(row: {
  slack_posted: boolean;
  linkedin_posted: boolean;
  skipped: boolean;
}): 'pending_review' | 'li_pending' | 'done' | 'skipped' {
  if (row.skipped) return 'skipped';
  if (row.slack_posted && row.linkedin_posted) return 'done';
  if (row.slack_posted) return 'li_pending';
  return 'pending_review';
}
