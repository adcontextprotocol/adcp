/**
 * Admin cleanup for junk enrichment records (adcp#9024).
 *
 *   POST /api/admin/brand-registry/enrichment-cleanup
 *
 * Body:
 *   - `domains` (optional): exact domains to remove. Omit it to select
 *     enriched records whose domain is a reserved name or a subdomain.
 *   - `dry_run` (default true): list what would be removed and delete
 *     nothing.
 *   - `confirm`: must be `true` together with `dry_run: false` to delete.
 *
 * A dry run is open to any global admin, including the static admin API
 * key, so ops scripts can watch for junk. A delete needs a human admin
 * session, because every removal is audited against that admin's user id.
 * Selection and the per-record safety predicate live in
 * `services/enrichment-cleanup.ts`.
 */

import type { Request, Router } from 'express';
import { createLogger } from '../../logger.js';
import { requireGlobalAdmin } from '../../middleware/auth.js';
import {
  applyEnrichmentCleanup,
  EnrichmentCleanupInputError,
  normalizeCleanupDomains,
  previewEnrichmentCleanup,
} from '../../services/enrichment-cleanup.js';

const logger = createLogger('admin-brand-registry-cleanup');

/** The admin's user id, or null for an API-key caller with no person behind it. */
function humanAdminId(req: Request): string | null {
  const isStaticAdminKey = (req as Request & { isStaticAdminApiKey?: boolean }).isStaticAdminApiKey === true;
  const userId = req.user?.id;
  if (
    isStaticAdminKey
    || (req as Request & { apiKey?: unknown }).apiKey
    || !userId
    || userId === 'admin_api_key'
    || userId.startsWith('api_key_')
  ) {
    return null;
  }
  return userId;
}

export function setupBrandRegistryCleanupRoutes(apiRouter: Router): void {
  apiRouter.post('/brand-registry/enrichment-cleanup', ...requireGlobalAdmin, async (req, res) => {
    let domains: string[] | undefined;
    try {
      domains = normalizeCleanupDomains(req.body?.domains);
    } catch (err) {
      if (err instanceof EnrichmentCleanupInputError) {
        return res.status(400).json({ error: err.message });
      }
      throw err;
    }

    const dryRun = req.body?.dry_run !== false;

    try {
      if (dryRun) {
        const preview = await previewEnrichmentCleanup({ domains });
        return res.json({ dry_run: true, ...preview });
      }

      if (req.body?.confirm !== true) {
        return res.status(400).json({
          error: 'Confirmation required',
          message: 'Send "confirm": true with "dry_run": false to delete. Run a dry run first to see what would be removed.',
        });
      }

      const actorUserId = humanAdminId(req);
      if (!actorUserId) {
        return res.status(403).json({
          error: 'Human admin session required',
          message: 'Each removal is audited against an admin user, so a cleanup cannot be applied with an API key.',
        });
      }

      const result = await applyEnrichmentCleanup({
        domains,
        actorUserId,
        actorEmail: req.user?.email ?? null,
      });
      return res.json({ dry_run: false, ...result });
    } catch (err) {
      logger.error({ err }, 'Enrichment cleanup failed');
      return res.status(500).json({ error: 'Enrichment cleanup failed' });
    }
  });
}
