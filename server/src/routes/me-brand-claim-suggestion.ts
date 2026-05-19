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
  nudgeKey,
} from '../services/brand-claim-suggestion.js';
import { getUserEmailById } from '../db/users-db.js';
import { recordNudgeDismissal } from '../db/user-nudges-db.js';
import { canonicalizeBrandDomain, assertValidBrandDomain } from '../services/identifier-normalization.js';
import { createLogger } from '../logger.js';

const logger = createLogger('me-brand-claim-suggestion');

// Defense in depth — cap the raw domain string before canonicalization so
// a hostile client can't push megabytes of garbage through `normalizeDomain`
// only to be rejected at validation. Real domains are ≤ 253 chars.
const MAX_DOMAIN_LEN = 253;

function parseDomainParam(raw: unknown): { ok: true; domain: string } | { ok: false; error: string } {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_DOMAIN_LEN) {
    return { ok: false, error: 'Invalid domain' };
  }
  let canonical: string;
  try {
    canonical = canonicalizeBrandDomain(raw);
  } catch {
    return { ok: false, error: 'Invalid domain' };
  }
  try {
    assertValidBrandDomain(canonical);
  } catch {
    return { ok: false, error: 'Invalid domain' };
  }
  return { ok: true, domain: canonical };
}

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

      const scope = req.query.domain;
      let suggestion;
      if (typeof scope === 'string' && scope.length > 0) {
        const parsed = parseDomainParam(scope);
        if (!parsed.ok) {
          return res.status(400).json({ error: parsed.error });
        }
        suggestion = await getSuggestionForDomain(user.id, email, parsed.domain, { brandDb });
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
      const parsed = parseDomainParam(req.body?.domain);
      if (!parsed.ok) {
        return res.status(400).json({ error: parsed.error });
      }
      await recordNudgeDismissal(user.id, nudgeKey(parsed.domain));
      return res.json({ success: true, domain: parsed.domain });
    } catch (error) {
      logger.error({ err: error }, 'Failed to record brand-claim suggestion dismissal');
      return res.status(500).json({ error: 'Failed to dismiss suggestion' });
    }
  });

  return router;
}
