/**
 * GET  /api/me/brand-claim-suggestion
 * POST /api/me/brand-claim-suggestion/dismiss
 *
 * Drives the dashboard banner + brand-viewer just-in-time prompt for
 * #4744 — "you signed up as alice@scope3.com, want to claim scope3.com?"
 *
 * The endpoints are read-only / state-only. The actual claim runs
 * through /api/me/member-profile/brand-claim/* where DNS proves
 * ownership.
 */

import { Router, type Request, type Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { BrandDatabase } from '../db/brand-db.js';
import {
  getBrandClaimSuggestionForUser,
  getSuggestionForDomain,
  getUserEmailById,
  nudgeKey,
} from '../services/brand-claim-suggestion.js';
import { recordNudgeDismissal } from '../db/user-nudges-db.js';
import { canonicalizeBrandDomain } from '../services/identifier-normalization.js';
import { createLogger } from '../logger.js';

const logger = createLogger('me-brand-claim-suggestion');

export function createBrandClaimSuggestionRouter(config: { brandDb: BrandDatabase }): Router {
  const router = Router();
  const { brandDb } = config;

  // GET /api/me/brand-claim-suggestion — dashboard banner + (optionally)
  // domain-scoped check for the just-in-time prompt. Pass ?domain=… to
  // restrict the suggestion to a specific brand.
  router.get('/brand-claim-suggestion', requireAuth, async (req: Request, res: Response) => {
    try {
      const user = req.user as { id: string; email?: string };
      const email = user.email ?? (await getUserEmailById(user.id));
      if (!email) {
        return res.json({ suggestion: null });
      }

      const scope = typeof req.query.domain === 'string' ? req.query.domain : null;
      let suggestion;
      if (scope) {
        let domain: string;
        try {
          domain = canonicalizeBrandDomain(scope);
        } catch {
          return res.status(400).json({ error: 'Invalid domain' });
        }
        suggestion = await getSuggestionForDomain(user.id, email, domain, { brandDb });
      } else {
        suggestion = await getBrandClaimSuggestionForUser(user.id, email, { brandDb });
      }
      return res.json({ suggestion });
    } catch (error) {
      logger.error({ err: error }, 'Failed to compute brand-claim suggestion');
      return res.status(500).json({ error: 'Failed to compute suggestion' });
    }
  });

  // POST /api/me/brand-claim-suggestion/dismiss — record a 30-day
  // cooldown on the suggestion for this user/domain pair.
  router.post('/brand-claim-suggestion/dismiss', requireAuth, async (req: Request, res: Response) => {
    try {
      const user = req.user as { id: string };
      const rawDomain = typeof req.body?.domain === 'string' ? req.body.domain : null;
      if (!rawDomain) {
        return res.status(400).json({ error: 'domain is required' });
      }
      let domain: string;
      try {
        domain = canonicalizeBrandDomain(rawDomain);
      } catch {
        return res.status(400).json({ error: 'Invalid domain' });
      }
      await recordNudgeDismissal(user.id, nudgeKey(domain));
      return res.json({ success: true, domain });
    } catch (error) {
      logger.error({ err: error }, 'Failed to record brand-claim suggestion dismissal');
      return res.status(500).json({ error: 'Failed to dismiss suggestion' });
    }
  });

  return router;
}
