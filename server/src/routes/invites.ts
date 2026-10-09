/**
 * Public + authed invite acceptance routes.
 *
 *   GET  /api/invite/:token          - public metadata for the invite page
 *   POST /api/invite/:token/accept   - authed: temporarily denied
 */

import { Router, type Request, type Response } from 'express';
import { createLogger } from '../logger.js';
import { requireAuth } from '../middleware/auth.js';
import {
  getMembershipInviteByToken,
  inviteStatus,
} from '../db/membership-invites-db.js';
import {
  OrganizationDatabase,
} from '../db/organization-db.js';
import { getProductsForCustomer } from '../billing/stripe-client.js';

const logger = createLogger('invites-routes');
const orgDb = new OrganizationDatabase();

export function createInvitesRouter(): Router {
  const router = Router();

  // Public metadata — callable before login so the landing page can render.
  router.get('/invite/:token', async (req: Request, res: Response) => {
    try {
      const invite = await getMembershipInviteByToken(req.params.token);
      if (!invite) return res.status(404).json({ error: 'Invite not found' });

      const status = inviteStatus(invite);
      const org = await orgDb.getOrganization(invite.workos_organization_id);
      if (!org) return res.status(404).json({ error: 'Organization no longer exists' });

      const customerType = org.is_personal ? 'individual' : 'company';
      const eligible = await getProductsForCustomer({
        customerType,
        category: 'membership',
      });
      const product = eligible.find((p) => p.lookup_key === invite.lookup_key);

      return res.json({
        token: invite.token,
        status,
        org_name: org.name,
        org_is_personal: org.is_personal,
        contact_email: invite.contact_email,
        contact_name: invite.contact_name,
        lookup_key: invite.lookup_key,
        tier_display_name: product?.display_name || invite.lookup_key,
        amount_cents: product?.amount_cents ?? null,
        currency: product?.currency ?? null,
        billing_interval: product?.billing_interval ?? null,
        billing_address: org.billing_address,
        expires_at: invite.expires_at,
        referral_code: invite.referral_code,
      });
    } catch (err) {
      logger.error({ err }, 'Error loading invite metadata');
      return res.status(500).json({ error: 'Internal error' });
    }
  });

  // The existing token does not bind a credential or a durable billing
  // operation. Deny before any lookup, membership write, or billing call.
  // Existing invites/acceptances remain untouched for separate adjudication.
  router.post('/invite/:token/accept', requireAuth, async (_req: Request, res: Response) => {
    return res.status(403).json({
      error: 'organization_onboarding_disabled',
      message: 'Invite acceptance is temporarily unavailable.',
    });
  });

  return router;
}
