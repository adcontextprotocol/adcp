import { Router } from 'express';
import { createLogger } from '../logger.js';
import { getReferralCode, acceptReferralCode, getAcceptedReferralForOrg } from '../db/referral-codes-db.js';
import { MemberDatabase } from '../db/member-db.js';
import { BrandDatabase } from '../db/brand-db.js';
import { requireAuth } from '../middleware/auth.js';
import { query } from '../db/client.js';

const logger = createLogger('referral-routes');
const memberDb = new MemberDatabase();
const brandDb = new BrandDatabase();

/**
 * Public referral routes (no auth required)
 * Mounted at /api
 */
export function createReferralsRouter(): Router {
  const router = Router();

  // GET /api/referral/:code - Validate a referral code and return referrer + discount info
  // Public endpoint — used by the /join/:code landing page
  router.get('/referral/:code', async (req, res) => {
    try {
      const { code } = req.params;
      const referralCode = await getReferralCode(code);

      if (!referralCode) {
        return res.status(404).json({ error: 'Referral code not found' });
      }

      if (referralCode.status !== 'active') {
        return res.status(410).json({ error: 'Referral code is no longer active' });
      }

      if (referralCode.expires_at && referralCode.expires_at < new Date()) {
        return res.status(410).json({ error: 'Referral code has expired' });
      }

      if (referralCode.max_uses !== null && referralCode.used_count >= referralCode.max_uses) {
        return res.status(410).json({ error: 'Referral code has been fully redeemed' });
      }

      // Fetch member profile for richer landing page experience
      const profile = await memberDb.getProfileByOrgId(referralCode.referrer_org_id);

      let logo_url: string | null = null;
      let brand_color: string | null = null;
      if (profile?.primary_brand_domain) {
        const hosted = await brandDb.getHostedBrandByDomain(profile.primary_brand_domain);
        if (hosted) {
          const bj = hosted.brand_json as Record<string, unknown>;
          const brands = bj.brands as Array<Record<string, unknown>> | undefined;
          const primary = brands?.[0];
          const logos = primary?.logos as Array<Record<string, unknown>> | undefined;
          const colors = primary?.colors as Record<string, unknown> | undefined;
          logo_url = (logos?.[0]?.url as string) || null;
          brand_color = (colors?.primary as string) || null;
        }
        if (!logo_url) {
          const discovered = await brandDb.getDiscoveredBrandByDomain(profile.primary_brand_domain);
          if (discovered) {
            const manifest = discovered.brand_manifest as Record<string, unknown> | undefined;
            const logos = manifest?.logos as Array<Record<string, unknown>> | undefined;
            const colors = manifest?.colors as Record<string, unknown> | undefined;
            logo_url = (logos?.[0]?.url as string) || null;
            brand_color = brand_color || (colors?.primary as string) || null;
          }
        }
      }

      res.json({
        valid: true,
        code: referralCode.code,
        discount_percent: referralCode.discount_percent,
        target_company_name: referralCode.target_company_name,
        referred_by: referralCode.referrer_user_name,
        referrer_org_name: profile?.display_name || null,
        referrer_tagline: profile?.tagline || null,
        referrer_logo_url: logo_url,
        referrer_brand_color: brand_color,
      });
    } catch (error) {
      logger.error({ err: error }, 'Error validating referral code');
      res.status(500).json({ error: 'Failed to validate referral code' });
    }
  });

  // POST /api/referral/:code/accept - Accept an invitation and lock the discount to this account
  // Requires auth — the prospect must be signed in before accepting
  router.post('/referral/:code/accept', requireAuth, async (req, res) => {
    try {
      const { code } = req.params;
      const userId = req.user!.id;

      // Look up the user's primary org
      const userRow = await query<{ primary_organization_id: string | null }>(
        'SELECT primary_organization_id FROM users WHERE workos_user_id = $1',
        [userId]
      );
      const orgId = userRow.rows[0]?.primary_organization_id;
      if (!orgId) {
        return res.status(400).json({ error: 'No organization associated with your account' });
      }

      // Check if this org already has an active accepted referral
      const existing = await getAcceptedReferralForOrg(orgId);
      if (existing) {
        const daysRemaining = existing.days_remaining;
        return res.status(409).json({
          error: 'Your organization has already accepted a referral invitation',
          referral: existing,
          days_remaining: daysRemaining,
        });
      }

      const referral = await acceptReferralCode(code, orgId, userId);

      if (!referral) {
        // Check what went wrong to return the right status
        const referralCode = await getReferralCode(code);
        if (!referralCode) {
          return res.status(404).json({ error: 'Referral code not found' });
        }
        if (referralCode.status !== 'active') {
          return res.status(410).json({ error: 'This referral code is no longer active' });
        }
        if (referralCode.max_uses !== null && referralCode.used_count >= referralCode.max_uses) {
          return res.status(410).json({ error: 'This invitation has already been accepted by someone else' });
        }
        return res.status(410).json({ error: 'This referral code could not be accepted' });
      }

      // Fetch back as AcceptedReferral to get discount_percent and days_remaining
      const accepted = await getAcceptedReferralForOrg(orgId);

      logger.info({ referralId: referral.id, code, orgId }, 'Referral invitation accepted');

      res.json({
        referral: accepted || referral,
        discount_percent: accepted?.discount_percent ?? null,
        days_remaining: accepted?.days_remaining ?? 30,
        expires_at: referral.expires_at,
      });
    } catch (error) {
      logger.error({ err: error }, 'Error accepting referral code');
      res.status(500).json({ error: 'Failed to accept referral invitation' });
    }
  });

  // GET /api/me/referral - Get the current user's active accepted referral (for dashboard badge)
  // Returns null referral if none exists
  router.get('/me/referral', requireAuth, async (req, res) => {
    try {
      const userId = req.user!.id;

      const userRow = await query<{ primary_organization_id: string | null }>(
        'SELECT primary_organization_id FROM users WHERE workos_user_id = $1',
        [userId]
      );
      const orgId = userRow.rows[0]?.primary_organization_id;
      if (!orgId) {
        return res.json({ referral: null });
      }

      const referral = await getAcceptedReferralForOrg(orgId);
      res.json({
        referral: referral || null,
        discount_percent: referral?.discount_percent ?? null,
        days_remaining: referral?.days_remaining ?? null,
        expires_at: referral?.expires_at ?? null,
      });
    } catch (error) {
      logger.error({ err: error }, 'Error fetching referral status');
      res.status(500).json({ error: 'Failed to fetch referral status' });
    }
  });

  return router;
}
