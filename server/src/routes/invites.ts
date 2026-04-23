/**
 * Public + authed invite acceptance routes.
 *
 *   GET  /api/invite/:token          - public metadata for the invite page
 *   POST /api/invite/:token/accept   - authed: join org, record agreement,
 *                                      store billing address, issue invoice
 */

import { Router, type Request, type Response } from 'express';
import { WorkOS } from '@workos-inc/node';
import { createLogger } from '../logger.js';
import { requireAuth } from '../middleware/auth.js';
import {
  getMembershipInviteByToken,
  markMembershipInviteAccepted,
  inviteStatus,
} from '../db/membership-invites-db.js';
import {
  OrganizationDatabase,
  type BillingAddress,
} from '../db/organization-db.js';
import {
  createAndSendInvoice,
  getProductsForCustomer,
  createCoupon,
} from '../billing/stripe-client.js';
import * as referralDb from '../db/referral-codes-db.js';

const logger = createLogger('invites-routes');
const orgDb = new OrganizationDatabase();

const AUTH_ENABLED = !!(
  process.env.WORKOS_API_KEY &&
  process.env.WORKOS_CLIENT_ID
);
const workos = AUTH_ENABLED
  ? new WorkOS(process.env.WORKOS_API_KEY!, {
      clientId: process.env.WORKOS_CLIENT_ID!,
    })
  : null;

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

  // Authed accept. Body: { billingAddress, agreement_version, marketing_opt_in? }
  router.post('/invite/:token/accept', requireAuth, async (req: Request, res: Response) => {
    try {
      const user = req.user!;
      const { token } = req.params;
      const { billingAddress, agreement_version } = req.body as {
        billingAddress?: BillingAddress;
        agreement_version?: string;
      };

      if (!billingAddress) {
        return res.status(400).json({ error: 'billingAddress is required' });
      }
      if (
        !billingAddress.line1 ||
        !billingAddress.city ||
        !billingAddress.state ||
        !billingAddress.postal_code ||
        !billingAddress.country
      ) {
        return res.status(400).json({ error: 'Incomplete billing address' });
      }
      if (!agreement_version?.trim()) {
        return res.status(400).json({ error: 'agreement_version is required' });
      }

      const invite = await getMembershipInviteByToken(token);
      if (!invite) return res.status(404).json({ error: 'Invite not found' });

      const status = inviteStatus(invite);
      if (status !== 'pending') {
        return res.status(409).json({ error: `Invite is ${status}` });
      }

      const org = await orgDb.getOrganization(invite.workos_organization_id);
      if (!org) {
        return res.status(410).json({ error: 'Organization no longer exists' });
      }

      const customerType = org.is_personal ? 'individual' : 'company';
      const eligible = await getProductsForCustomer({
        customerType,
        category: 'membership',
      });
      const product = eligible.find((p) => p.lookup_key === invite.lookup_key);
      if (!product) {
        return res.status(410).json({
          error: 'Tier no longer available',
          message: 'The membership tier in this invite is no longer available.',
        });
      }

      // Ensure the accepting user is a member of the target org. First user
      // in becomes owner (new-org common case); everyone else is a member.
      if (workos) {
        try {
          const existing = await workos.userManagement.listOrganizationMemberships({
            userId: user.id,
            organizationId: org.workos_organization_id,
          });
          if (!existing.data || existing.data.length === 0) {
            const current = await workos.userManagement.listOrganizationMemberships({
              organizationId: org.workos_organization_id,
            });
            const hasAnyMember = (current.data?.length ?? 0) > 0;
            const roleSlug = hasAnyMember ? 'member' : 'owner';
            try {
              await workos.userManagement.createOrganizationMembership({
                userId: user.id,
                organizationId: org.workos_organization_id,
                roleSlug,
              });
              logger.info(
                {
                  userId: user.id,
                  orgId: org.workos_organization_id,
                  roleSlug,
                },
                'Added user to org via invite accept'
              );
            } catch (membershipErr) {
              const code = (membershipErr as { code?: string }).code;
              if (code === 'organization_membership_already_exists') {
                logger.info({ userId: user.id, orgId: org.workos_organization_id },
                  'Membership already exists (race)');
              } else {
                throw membershipErr;
              }
            }
          }
        } catch (err) {
          logger.error({ err, userId: user.id, orgId: org.workos_organization_id },
            'Failed to ensure org membership on invite accept');
          return res.status(500).json({
            error: 'Could not add you to the organization',
            message: 'Please contact finance@agenticadvertising.org.',
          });
        }
      }

      // Record pending agreement + store billing address on the org.
      await orgDb.updateOrganization(org.workos_organization_id, {
        pending_agreement_version: agreement_version.trim(),
        pending_agreement_accepted_at: new Date(),
        billing_address: billingAddress,
      });

      // Referral discount (if invite carried one).
      let couponId: string | undefined;
      if (invite.referral_code) {
        try {
          const code = await referralDb.getReferralCode(invite.referral_code);
          if (code && code.status === 'active' && code.discount_percent) {
            const coupon = await createCoupon({
              name: `Referral: ${code.code}`,
              percent_off: code.discount_percent,
              duration: 'once',
              max_redemptions: 1,
              metadata: { referral_code: code.code },
            });
            if (coupon) couponId = coupon.coupon_id;
          }
        } catch (err) {
          logger.warn({ err, referral_code: invite.referral_code },
            'Failed to resolve referral coupon — continuing without discount');
        }
      }

      const contactName =
        invite.contact_name ||
        [user.firstName, user.lastName].filter(Boolean).join(' ') ||
        user.email;

      const invoiceResult = await createAndSendInvoice({
        lookupKey: invite.lookup_key,
        companyName: org.name,
        contactName,
        contactEmail: user.email,
        billingAddress,
        workosOrganizationId: org.workos_organization_id,
        couponId: couponId ?? org.stripe_coupon_id ?? undefined,
      });

      if (!invoiceResult) {
        logger.error({ orgId: org.workos_organization_id, lookupKey: invite.lookup_key },
          'createAndSendInvoice returned null on invite accept');
        return res.status(500).json({
          error: 'Failed to issue invoice',
          message:
            "We couldn't issue your invoice. Please contact finance@agenticadvertising.org.",
        });
      }

      const accepted = await markMembershipInviteAccepted(
        token,
        user.id,
        invoiceResult.invoiceId,
      );
      if (!accepted) {
        // Another tab accepted between our check and now. Still OK — the
        // invoice went out; just return a benign response.
        logger.warn({ token: token.slice(0, 8) + '...', userId: user.id },
          'Invite already accepted concurrently');
      }

      // Mark referral as accepted if the invite carried one.
      if (invite.referral_code) {
        try {
          await referralDb.acceptReferralCode(
            invite.referral_code,
            org.workos_organization_id,
            user.id,
          );
        } catch (err) {
          logger.warn({ err, referral_code: invite.referral_code },
            'Failed to record referral acceptance — invoice already sent');
        }
      }

      logger.info(
        {
          token: token.slice(0, 8) + '...',
          orgId: org.workos_organization_id,
          userId: user.id,
          invoiceId: invoiceResult.invoiceId,
        },
        'Membership invite accepted'
      );

      res.json({
        success: true,
        invoice_id: invoiceResult.invoiceId,
        invoice_url: invoiceResult.invoiceUrl,
        organization: { id: org.workos_organization_id, name: org.name },
      });
    } catch (err) {
      logger.error({ err }, 'Error accepting membership invite');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  return router;
}
