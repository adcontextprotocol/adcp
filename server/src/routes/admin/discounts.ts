/**
 * Discount management routes
 * Handles granting/removing discounts from organizations and creating Stripe promotion codes
 */

import { Router } from 'express';
import { createLogger } from '../../logger.js';
import { requireAuth, requireAdmin } from '../../middleware/auth.js';
import { OrganizationDatabase } from '../../db/organization-db.js';
import { createOrgDiscount, createCoupon, createPromotionCode } from '../../billing/stripe-client.js';

const orgDb = new OrganizationDatabase();
const logger = createLogger('admin-discounts');

export function setupDiscountRoutes(apiRouter: Router): void {
  // POST /api/admin/organizations/:orgId/discount - Grant a discount to an organization
  apiRouter.post(
    '/organizations/:orgId/discount',
    requireAuth,
    requireAdmin,
    async (req, res) => {
      try {
        const { orgId } = req.params;
        const {
          discount_percent,
          discount_amount_cents,
          reason,
          create_stripe_coupon,
          coupon_duration,
        } = req.body;

        // Validate inputs
        if (!reason) {
          return res.status(400).json({ error: 'Reason is required' });
        }

        if (discount_percent === undefined && discount_amount_cents === undefined) {
          return res.status(400).json({
            error: 'Either discount_percent or discount_amount_cents is required',
          });
        }

        if (discount_percent !== undefined && discount_amount_cents !== undefined) {
          return res.status(400).json({
            error: 'Provide either discount_percent OR discount_amount_cents, not both',
          });
        }

        if (discount_percent !== undefined) {
          if (typeof discount_percent !== 'number' || discount_percent < 1 || discount_percent > 100) {
            return res.status(400).json({
              error: 'discount_percent must be a number between 1 and 100',
            });
          }
        }

        if (discount_amount_cents !== undefined) {
          if (typeof discount_amount_cents !== 'number' || discount_amount_cents < 1) {
            return res.status(400).json({
              error: 'discount_amount_cents must be a positive integer',
            });
          }
        }

        // Get the organization
        const org = await orgDb.getOrganization(orgId);
        if (!org) {
          return res.status(404).json({ error: 'Organization not found' });
        }

        let stripe_coupon_id: string | null = null;
        let stripe_promotion_code: string | null = null;

        // Create Stripe coupon if requested
        if (create_stripe_coupon) {
          const stripeDiscount = await createOrgDiscount(orgId, org.name, {
            percent_off: discount_percent,
            amount_off_cents: discount_amount_cents,
            duration: coupon_duration || 'forever',
            reason,
          });

          if (stripeDiscount) {
            stripe_coupon_id = stripeDiscount.coupon_id;
            stripe_promotion_code = stripeDiscount.promotion_code;
          }
        }

        // Update the organization
        await orgDb.setDiscount(orgId, {
          discount_percent: discount_percent ?? null,
          discount_amount_cents: discount_amount_cents ?? null,
          reason,
          granted_by: req.user!.email,
          stripe_coupon_id,
          stripe_promotion_code,
        });

        logger.info(
          {
            orgId,
            orgName: org.name,
            discountPercent: discount_percent,
            discountAmountCents: discount_amount_cents,
            grantedBy: req.user!.email,
            stripePromoCode: stripe_promotion_code,
          },
          'Granted discount to organization'
        );

        // Return updated org
        const updatedOrg = await orgDb.getOrganization(orgId);
        if (!updatedOrg) {
          return res.status(404).json({ error: 'Organization not found after update' });
        }

        res.json({
          success: true,
          message: stripe_promotion_code
            ? `Discount granted with promotion code: ${stripe_promotion_code}`
            : 'Discount granted (no Stripe promotion code created)',
          organization: {
            workos_organization_id: updatedOrg.workos_organization_id,
            name: updatedOrg.name,
            discount_percent: updatedOrg.discount_percent,
            discount_amount_cents: updatedOrg.discount_amount_cents,
            discount_reason: updatedOrg.discount_reason,
            discount_granted_by: updatedOrg.discount_granted_by,
            discount_granted_at: updatedOrg.discount_granted_at,
            stripe_coupon_id: updatedOrg.stripe_coupon_id,
            stripe_promotion_code: updatedOrg.stripe_promotion_code,
          },
        });
      } catch (error) {
        logger.error({ err: error }, 'Error granting discount');
        res.status(500).json({ error: 'Failed to grant discount' });
      }
    }
  );

  // DELETE /api/admin/organizations/:orgId/discount - Remove discount from an organization
  apiRouter.delete(
    '/organizations/:orgId/discount',
    requireAuth,
    requireAdmin,
    async (req, res) => {
      try {
        const { orgId } = req.params;

        const org = await orgDb.getOrganization(orgId);
        if (!org) {
          return res.status(404).json({ error: 'Organization not found' });
        }

        await orgDb.removeDiscount(orgId);

        logger.info(
          { orgId, orgName: org.name, removedBy: req.user!.email },
          'Removed discount from organization'
        );

        res.json({
          success: true,
          message: 'Discount removed',
        });
      } catch (error) {
        logger.error({ err: error }, 'Error removing discount');
        res.status(500).json({ error: 'Failed to remove discount' });
      }
    }
  );

  // GET /api/admin/discounts - List all organizations with active discounts
  apiRouter.get('/discounts', requireAuth, requireAdmin, async (req, res) => {
    try {
      const orgsWithDiscounts = await orgDb.listOrganizationsWithDiscounts();

      res.json({
        success: true,
        organizations: orgsWithDiscounts,
      });
    } catch (error) {
      logger.error({ err: error }, 'Error listing discounts');
      res.status(500).json({ error: 'Failed to list discounts' });
    }
  });

  // POST /api/admin/coupons - Create a standalone Stripe coupon/promotion code
  apiRouter.post('/coupons', requireAuth, requireAdmin, async (req, res) => {
    try {
      const {
        name,
        code,
        percent_off,
        amount_off_cents,
        duration,
        duration_in_months,
        max_redemptions,
      } = req.body;

      // Validate inputs
      if (!name) {
        return res.status(400).json({ error: 'Name is required' });
      }

      if (percent_off === undefined && amount_off_cents === undefined) {
        return res.status(400).json({
          error: 'Either percent_off or amount_off_cents is required',
        });
      }

      if (percent_off !== undefined && amount_off_cents !== undefined) {
        return res.status(400).json({
          error: 'Provide either percent_off OR amount_off_cents, not both',
        });
      }

      if (percent_off !== undefined) {
        if (typeof percent_off !== 'number' || percent_off < 1 || percent_off > 100) {
          return res.status(400).json({
            error: 'percent_off must be a number between 1 and 100',
          });
        }
      }

      if (amount_off_cents !== undefined) {
        if (typeof amount_off_cents !== 'number' || amount_off_cents < 1) {
          return res.status(400).json({
            error: 'amount_off_cents must be a positive integer',
          });
        }
      }

      if (duration === 'repeating' && !duration_in_months) {
        return res.status(400).json({
          error: 'duration_in_months is required when duration is "repeating"',
        });
      }

      // Create the coupon
      const coupon = await createCoupon({
        name,
        percent_off,
        amount_off_cents,
        duration: duration || 'once',
        duration_in_months,
        max_redemptions,
        metadata: {
          created_by: req.user!.email,
        },
      });

      if (!coupon) {
        return res.status(500).json({ error: 'Failed to create coupon in Stripe' });
      }

      let promoCode = null;

      // Create promotion code if a code was provided
      if (code) {
        promoCode = await createPromotionCode({
          coupon_id: coupon.coupon_id,
          code,
          max_redemptions,
          metadata: {
            created_by: req.user!.email,
          },
        });

        if (!promoCode) {
          return res.status(500).json({
            error: 'Coupon created but failed to create promotion code',
            coupon,
          });
        }
      }

      logger.info(
        {
          couponId: coupon.coupon_id,
          code: promoCode?.code,
          createdBy: req.user!.email,
        },
        'Created standalone coupon'
      );

      res.json({
        success: true,
        coupon: {
          coupon_id: coupon.coupon_id,
          name: coupon.name,
        },
        promotion_code: promoCode
          ? {
              promotion_code_id: promoCode.promotion_code_id,
              code: promoCode.code,
            }
          : null,
      });
    } catch (error) {
      logger.error({ err: error }, 'Error creating coupon');
      res.status(500).json({ error: 'Failed to create coupon' });
    }
  });
}
