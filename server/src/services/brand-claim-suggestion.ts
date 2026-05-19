/**
 * Brand-claim suggestion (#4744).
 *
 * "You signed up as alice@scope3.com — want to claim scope3.com?"
 *
 * Locates a brand in the registry that matches the user's verified email
 * domain and tells the caller whether the suggestion should fire on the
 * dashboard banner or as the just-in-time prompt on /brand/view.
 *
 * Trust model: this is a *nudge*, not a claim. The DNS challenge at
 * /api/me/member-profile/brand-claim/* is the actual trust boundary. We
 * just point users at it when their signup hints they might control the
 * domain.
 *
 * Suppression rules:
 *   - Free email domains (gmail, etc.) never suggest — `getCompanyDomain`
 *     filters those out at the source.
 *   - Verified ownership by the user's *own* org: nothing to claim,
 *     already done.
 *   - Verified ownership by *another* org: claim would collision-fail at
 *     the DNS step. Don't waste a nudge on a guaranteed dead end.
 *   - User dismissed in the last 30 days: respect the cooldown.
 */

import { query } from '../db/client.js';
import { BrandDatabase } from '../db/brand-db.js';
import { getCompanyDomain } from '../utils/email-domain.js';
import { canonicalizeBrandDomain } from './identifier-normalization.js';
import { resolvePrimaryOrganization } from '../db/users-db.js';
import { getNudgeDismissal } from '../db/user-nudges-db.js';
import { createLogger } from '../logger.js';

const logger = createLogger('brand-claim-suggestion');

export const DISMISSAL_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export interface BrandClaimSuggestion {
  domain: string;
  brand_name: string | null;
  /** True when the suggestion is fresh (no recent dismissal). */
  active: boolean;
  /** Set when the user dismissed within the cooldown window. */
  dismissed_at?: Date;
  /** Deep-link to the brand-builder claim flow (#4742). */
  claim_url: string;
  /** Deep-link to view the brand. */
  view_url: string;
}

export interface BrandClaimSuggestionContext {
  brandDb: BrandDatabase;
}

/**
 * Return a brand-claim suggestion for the given user, or null when no
 * suggestion applies. The shape is the same for "suggestion exists but
 * was recently dismissed" and "suggestion exists and is active" — the
 * `active` boolean tells the caller which UI state to render. Null
 * means "no suggestion at all" (free email, already verified by user's
 * org, claimed by someone else, no matching brand).
 */
export async function getBrandClaimSuggestionForUser(
  workosUserId: string,
  email: string,
  ctx: BrandClaimSuggestionContext,
): Promise<BrandClaimSuggestion | null> {
  const rawDomain = getCompanyDomain(email);
  if (!rawDomain) return null;

  let domain: string;
  try {
    domain = canonicalizeBrandDomain(rawDomain);
  } catch (err) {
    logger.debug({ err, rawDomain }, 'brand-claim suggestion: domain canonicalization failed');
    return null;
  }
  if (!domain) return null;

  const brand = await ctx.brandDb.getDiscoveredBrandByDomain(domain);
  if (!brand) return null;

  // Already verified by some org — caller's org or another.
  if (brand.domain_verified && brand.workos_organization_id) {
    let callerOrgId: string | null = null;
    try {
      callerOrgId = await resolvePrimaryOrganization(workosUserId);
    } catch (err) {
      logger.warn({ err, workosUserId }, 'brand-claim suggestion: failed to resolve caller org');
    }
    if (callerOrgId && callerOrgId === brand.workos_organization_id) {
      // Caller's own org already owns it — nothing to suggest.
      return null;
    }
    // Owned by another org. DNS challenge would collision-fail. Skip.
    return null;
  }

  const dismissal = await getNudgeDismissal(workosUserId, nudgeKey(domain));
  const active = !dismissal
    || (Date.now() - new Date(dismissal.dismissed_at).getTime()) >= DISMISSAL_COOLDOWN_MS;

  return {
    domain,
    brand_name: brand.brand_name ?? null,
    active,
    dismissed_at: dismissal?.dismissed_at,
    claim_url: `/brand/builder?domain=${encodeURIComponent(domain)}`,
    view_url: `/brand/view/${encodeURIComponent(domain)}`,
  };
}

/**
 * Same lookup, scoped to a specific domain — used by the brand-viewer
 * just-in-time prompt. Returns the suggestion only when the requested
 * domain matches the user's verified email domain AND the standard
 * suggestion-applicability rules hold.
 */
export async function getSuggestionForDomain(
  workosUserId: string,
  email: string,
  requestedDomain: string,
  ctx: BrandClaimSuggestionContext,
): Promise<BrandClaimSuggestion | null> {
  const rawDomain = getCompanyDomain(email);
  if (!rawDomain) return null;
  let userDomain: string;
  try {
    userDomain = canonicalizeBrandDomain(rawDomain);
  } catch {
    return null;
  }
  if (userDomain !== requestedDomain) return null;

  return getBrandClaimSuggestionForUser(workosUserId, email, ctx);
}

export function nudgeKey(domain: string): string {
  return `brand_claim_suggestion:${domain}`;
}

/**
 * Lookup the user's email from the canonical users table. Used by the
 * dashboard endpoint where the auth middleware exposes user.id but the
 * full WorkOS user object isn't necessarily attached.
 */
export async function getUserEmailById(workosUserId: string): Promise<string | null> {
  const result = await query<{ email: string }>(
    `SELECT email FROM users WHERE workos_user_id = $1`,
    [workosUserId],
  );
  return result.rows[0]?.email ?? null;
}
