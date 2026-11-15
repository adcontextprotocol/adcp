/**
 * Admin cleanup for junk enrichment records (adcp#9024).
 *
 *   POST /api/admin/brand-registry/enrichment-cleanup
 *
 * Body:
 *   - `domains`: exact domains. Optional for a dry run (omit it to scan the
 *     registry by criteria); required to delete, and should be the list the
 *     dry run returned.
 *   - `mode`: `criteria` (the domain must be a reserved name or a subdomain)
 *     or `explicit_list` (any listed enriched record). Defaults to `criteria`
 *     without `domains` and `explicit_list` with them.
 *   - `dry_run` (default true): list what would be removed, delete nothing.
 *   - `confirm`: must be `true` together with `dry_run: false` to delete.
 *
 * A dry run is open to any global admin, including the static admin API
 * key, so ops scripts can watch for junk. A delete needs a human admin
 * session, because every removal is audited against that admin's user id,
 * and removes only listed domains that still qualify. Selection and the
 * per-record safety predicate live in `services/enrichment-cleanup.ts`.
 */

import type { Router } from 'express';
import { createLogger } from '../../logger.js';
import { requireGlobalAdmin } from '../../middleware/auth.js';
import {
  applyEnrichmentCleanup,
  EnrichmentCleanupInputError,
  normalizeCleanupDomains,
  parseCleanupMode,
  previewEnrichmentCleanup,
} from '../../services/enrichment-cleanup.js';
import { humanAdminUserId } from './human-admin.js';

const logger = createLogger('admin-brand-registry-cleanup');

export function setupBrandRegistryCleanupRoutes(apiRouter: Router): void {
  apiRouter.post('/brand-registry/enrichment-cleanup', ...requireGlobalAdmin, async (req, res) => {
    let domains: string[] | undefined;
    let mode: ReturnType<typeof parseCleanupMode>;
    try {
      domains = normalizeCleanupDomains(req.body?.domains);
      mode = parseCleanupMode(req.body?.mode, domains !== undefined);
      if (mode === 'explicit_list' && !domains) {
        throw new EnrichmentCleanupInputError('explicit_list mode needs a domains list');
      }
    } catch (err) {
      if (err instanceof EnrichmentCleanupInputError) {
        return res.status(400).json({ error: err.message });
      }
      throw err;
    }

    const dryRun = req.body?.dry_run !== false;

    try {
      if (dryRun) {
        const preview = await previewEnrichmentCleanup({ domains, mode });
        return res.json({ dry_run: true, ...preview });
      }

      if (req.body?.confirm !== true) {
        return res.status(400).json({
          error: 'Confirmation required',
          message: 'Send "confirm": true with "dry_run": false to delete. Run a dry run first to see what would be removed.',
        });
      }

      if (!domains) {
        return res.status(400).json({
          error: 'Domains required',
          message: 'A delete removes only the domains you list. Send the "candidates" domains from the dry run as "domains".',
        });
      }

      const actorUserId = humanAdminUserId(req);
      if (!actorUserId) {
        return res.status(403).json({
          error: 'Human admin session required',
          message: 'Each removal is audited against an admin user, so a cleanup cannot be applied with an API key.',
        });
      }

      const result = await applyEnrichmentCleanup({
        domains,
        mode,
        actorUserId,
        actorEmail: req.user?.email ?? null,
      });
      return res.json({ dry_run: false, ...result });
    } catch (err) {
      if (err instanceof EnrichmentCleanupInputError) {
        return res.status(400).json({ error: err.message });
      }
      logger.error({ err }, 'Enrichment cleanup failed');
      return res.status(500).json({ error: 'Enrichment cleanup failed' });
    }
  });
}
