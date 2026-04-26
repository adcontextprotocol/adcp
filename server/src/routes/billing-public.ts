/**
 * Public Billing routes module
 *
 * This module contains public-facing billing API routes.
 * Unlike billing.ts (admin routes), these are accessible to authenticated users
 * and some are even public (invoice request).
 */

import { Router, type Request, type Response } from "express";
import { createLogger } from "../logger.js";
import { requireAuth } from "../middleware/auth.js";
import {
  getProductsForCustomer,
  createAndSendInvoice,
  getInvoiceableProducts,
  createCheckoutSession,
  createCoupon,
  getPendingInvoices,
  createStripeCustomer,
  createCustomerSession,
  type BillingProduct,
  type InvoiceRequestData,
  type CheckoutSessionData,
} from "../billing/stripe-client.js";
import * as referralDb from "../db/referral-codes-db.js";
import { sanitizeBillingAddress } from "../billing/billing-address.js";
import {
  blockIfActiveSubscription,
  type ActiveSubscriptionBlock,
} from "../billing/active-subscription-guard.js";
import { withOrgIntakeLock } from "../billing/org-intake-lock.js";
import {
  OrganizationDatabase,
  type CompanyType,
  type RevenueTier,
  type Organization,
  VALID_REVENUE_TIERS,
} from "../db/organization-db.js";
import {
  mapIndustryToCompanyType,
  mapRevenueToTier,
} from "../services/lusha.js";
import { listEscalationsForUser } from "../db/escalation-db.js";
import { COMPANY_TYPE_VALUES } from "../config/company-types.js";
import { notifyInvoiceSent } from "../notifications/billing.js";
import { WorkOS } from "@workos-inc/node";

const logger = createLogger("billing-public-routes");
const orgDb = new OrganizationDatabase();

// Initialize WorkOS client only if authentication is enabled
const AUTH_ENABLED = !!(
  process.env.WORKOS_API_KEY &&
  process.env.WORKOS_CLIENT_ID &&
  process.env.WORKOS_COOKIE_PASSWORD &&
  process.env.WORKOS_COOKIE_PASSWORD.length >= 32
);

const workos = AUTH_ENABLED
  ? new WorkOS(process.env.WORKOS_API_KEY!, {
      clientId: process.env.WORKOS_CLIENT_ID!,
    })
  : null;

// Dev mode configuration - must match http.ts pattern
const DEV_USER_EMAIL = process.env.DEV_USER_EMAIL;
const DEV_USER_ID = process.env.DEV_USER_ID;
const DEV_MODE_ENABLED = !!(DEV_USER_EMAIL && DEV_USER_ID);

interface DevUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  isMember: boolean;
  isAdmin: boolean;
  organizationId: string;
  organizationName: string;
}

// Match user IDs from auth.ts DEV_USERS
const DEV_USERS: Record<string, DevUser> = {
  member: {
    id: "user_dev_member_001",
    email: "member@test.local",
    firstName: "Member",
    lastName: "User",
    isMember: true,
    isAdmin: false,
    organizationId: "org_dev_company_001",
    organizationName: "Dev Company (Member)",
  },
  nonmember: {
    id: "user_dev_nonmember_001",
    email: "visitor@test.local",
    firstName: "Visitor",
    lastName: "User",
    isMember: false,
    isAdmin: false,
    organizationId: "org_dev_personal_001",
    organizationName: "Dev Personal Workspace",
  },
  admin: {
    id: "user_dev_admin_001",
    email: "admin@test.local",
    firstName: "Admin",
    lastName: "Tester",
    isMember: true,
    isAdmin: true,
    organizationId: "org_dev_company_001",
    organizationName: "Dev Company (Member)",
  },
};

function isDevModeEnabled(): boolean {
  return DEV_MODE_ENABLED;
}

function getDevUser(req: Request): DevUser | null {
  if (!DEV_MODE_ENABLED) return null;
  // Check header first (for API testing), then cookie (for browser)
  const devUserType =
    (req.headers["x-dev-user"] as string) ||
    (req.cookies?.["dev-session"] as string);
  return DEV_USERS[devUserType] || null;
}

/**
 * Create public billing routes
 * Returns a router to be mounted at /api
 */
export function createPublicBillingRouter(): Router {
  const router = Router();

  // =========================================================================
  // PUBLIC BILLING PRODUCT ROUTES (mounted at /api)
  // =========================================================================

  // GET /api/billing-products - Get available billing products
  // Query params:
  //   customer_type: 'company' | 'individual' - filter by customer type
  //   revenue_tier: string - filter by revenue tier
  //   category: string - filter by category (membership, sponsorship, event)
  //   invoiceable_only: 'true' - only return products that can be invoiced
  router.get("/billing-products", async (req: Request, res: Response) => {
    try {
      const customerType = req.query.customer_type as
        | "company"
        | "individual"
        | undefined;
      const revenueTier = req.query.revenue_tier as string | undefined;
      const category = req.query.category as string | undefined;
      const invoiceableOnly = req.query.invoiceable_only === "true";

      const products = await getProductsForCustomer({
        customerType,
        revenueTier,
        category,
        invoiceableOnly,
      });

      // Group by category for easier frontend consumption
      const grouped: Record<string, BillingProduct[]> = {};
      for (const product of products) {
        if (!grouped[product.category]) {
          grouped[product.category] = [];
        }
        grouped[product.category].push(product);
      }

      res.json({
        products,
        by_category: grouped,
      });
    } catch (error) {
      logger.error({ err: error }, "Error fetching billing products");
      res.status(500).json({
        error: "Failed to fetch products",
        message: "An unexpected error occurred. Please try again.",
      });
    }
  });

  // POST /api/invoice-request - Issue a Stripe invoice for the caller's org.
  //
  // Requires:
  //   - Authenticated user who is a member of `orgId`
  //   - `lookupKey` for a membership product eligible for that org type
  //   - `billingAddress` (stored on the org for future invoices)
  //   - The org has accepted the membership agreement for this tier —
  //     either previously (via /api/organizations/:orgId/pending-agreement)
  //     or inline via the `agreement_version` field in this request body.
  //
  // This replaces the old unauthenticated contact-form version, which could
  // create orphaned Stripe customers (free-text email → new customer with no
  // workos_organization_id metadata → webhook couldn't link payment to an org).
  router.post("/invoice-request", requireAuth, async (req: Request, res: Response) => {
    try {
      const user = req.user!;
      const { orgId, lookupKey, billingAddress, referral_code, agreement_version } =
        req.body as {
          orgId: string;
          lookupKey: string;
          billingAddress: {
            line1: string;
            line2?: string;
            city: string;
            state: string;
            postal_code: string;
            country: string;
          };
          referral_code?: string;
          agreement_version?: string;
        };

      if (!orgId || !lookupKey || !billingAddress) {
        return res.status(400).json({
          error: "Missing required fields",
          message: "Please provide orgId, lookupKey, and billingAddress",
        });
      }

      const sanitizedAddress = sanitizeBillingAddress(billingAddress);
      if (!sanitizedAddress) {
        return res.status(400).json({
          error: "Incomplete billing address",
          message: "Please provide line1, city, state, postal_code, and country (each ≤ 200 chars)",
        });
      }

      if (!lookupKey.startsWith("aao_")) {
        logger.warn({ lookupKey }, 'Invoice request rejected: invalid lookup key prefix');
        return res.status(400).json({
          error: "Invalid product",
          message: "Invalid product selection",
        });
      }

      const org = await orgDb.getOrganization(orgId);
      if (!org) {
        return res.status(404).json({
          error: "Organization not found",
          message: "The specified organization does not exist",
        });
      }

      const isDevUserInvoice =
        isDevModeEnabled() &&
        Object.values(DEV_USERS).some((du) => du.id === user.id) &&
        orgId.startsWith("org_dev_");

      if (!isDevUserInvoice) {
        const membership = await workos?.userManagement.listOrganizationMemberships({
          userId: user.id,
          organizationId: orgId,
        });
        if (!membership?.data?.length) {
          return res.status(403).json({
            error: "Access denied",
            message: "You are not a member of this organization",
          });
        }
      }

      // Refuse if the org already has an active subscription. Tier changes go
      // through the Stripe Customer Portal, not this intake route. The
      // requester is an authenticated member of the org (verified above), so
      // it's safe to surface the portal URL.
      const activeBlock = await blockIfActiveSubscription(orgId, orgDb, {
        customerPortalReturnUrl: `${req.protocol}://${req.get('host')}/dashboard/membership`,
      });
      if (activeBlock) {
        return res.status(activeBlock.status).json(activeBlock.body);
      }

      // Product must be eligible for this org type (individual → personal
      // workspace, company → non-personal org).
      const customerType = org.is_personal ? 'individual' : 'company';
      const eligibleProducts = await getProductsForCustomer({
        customerType,
        category: 'membership',
      });
      const product = eligibleProducts.find((p) => p.lookup_key === lookupKey);
      if (!product) {
        return res.status(400).json({
          error: "Product not available",
          message: "This membership tier is not available for your organization.",
        });
      }

      // Agreement gate. If the caller is accepting inline we validate the
      // version against the currently-published agreement. If they're
      // relying on a previous acceptance we use whatever was stored on the
      // org. Either way, store the acceptance as "pending"; the webhook on
      // invoice.paid / subscription.created records it permanently.
      let pendingVersion = org.pending_agreement_version;
      if (agreement_version?.trim()) {
        const currentAgreement = await orgDb.getCurrentAgreementByType('membership');
        if (!currentAgreement || agreement_version.trim() !== currentAgreement.version) {
          return res.status(400).json({
            error: "Agreement version mismatch",
            message:
              "The membership agreement has changed. Please reload and accept the current version.",
            current_version: currentAgreement?.version ?? null,
          });
        }
        pendingVersion = currentAgreement.version;
      }
      if (!pendingVersion) {
        return res.status(400).json({
          error: "Membership agreement required",
          message:
            "Please accept the membership agreement before requesting an invoice.",
          required: "agreement_version",
        });
      }

      // Atomic: record (or re-affirm) the pending agreement + store the
      // billing address in a single UPDATE so a partial failure can't leave
      // one set without the other.
      await orgDb.updateOrganization(orgId, {
        pending_agreement_version: pendingVersion,
        pending_agreement_accepted_at: new Date(),
        pending_agreement_user_id: user.id,
        billing_address: sanitizedAddress,
      });

      // Referral discount (same logic as checkout).
      let invoiceCouponId: string | undefined;
      let validatedInvoiceReferralCode: Awaited<ReturnType<typeof referralDb.getReferralCode>> = null;

      if (referral_code) {
        validatedInvoiceReferralCode = await referralDb.getReferralCode(referral_code);

        if (!validatedInvoiceReferralCode || validatedInvoiceReferralCode.status !== 'active') {
          return res.status(400).json({ error: 'Invalid or expired referral code' });
        }

        if (validatedInvoiceReferralCode.expires_at && validatedInvoiceReferralCode.expires_at < new Date()) {
          return res.status(400).json({ error: 'Referral code has expired' });
        }

        if (validatedInvoiceReferralCode.max_uses !== null && validatedInvoiceReferralCode.used_count >= validatedInvoiceReferralCode.max_uses) {
          return res.status(400).json({ error: 'Referral code has been fully redeemed' });
        }

        if (validatedInvoiceReferralCode.discount_percent) {
          const coupon = await createCoupon({
            name: `Referral: ${validatedInvoiceReferralCode.code}`,
            percent_off: validatedInvoiceReferralCode.discount_percent,
            duration: 'once',
            max_redemptions: 1,
            metadata: { referral_code: validatedInvoiceReferralCode.code },
          });
          if (coupon) {
            invoiceCouponId = coupon.coupon_id;
          }
        }
      }

      const displayName =
        [user.firstName, user.lastName].filter(Boolean).join(' ') || user.email;

      const invoiceData: InvoiceRequestData = {
        companyName: org.name,
        contactName: displayName,
        contactEmail: user.email,
        billingAddress: sanitizedAddress,
        lookupKey,
        workosOrganizationId: orgId,
        couponId: invoiceCouponId ?? org.stripe_coupon_id ?? undefined,
      };

      logger.info({ orgId, lookupKey, userId: user.id }, 'Invoice request received');

      // Lock + re-guard + Stripe write must be atomic per-org. The early
      // `blockIfActiveSubscription` above handles the common case fast; this
      // section closes the millisecond race where two concurrent intakes both
      // pass that early check before either has minted a sub.
      const intake = await withOrgIntakeLock<
        | { kind: 'block'; block: ActiveSubscriptionBlock }
        | { kind: 'invoiceFailed' }
        | { kind: 'success'; invoiceResult: NonNullable<Awaited<ReturnType<typeof createAndSendInvoice>>> }
      >(orgId, async () => {
        const racedBlock = await blockIfActiveSubscription(orgId, orgDb, {
          customerPortalReturnUrl: `${req.protocol}://${req.get('host')}/dashboard/membership`,
        });
        if (racedBlock) return { kind: 'block', block: racedBlock };
        const invoiceResult = await createAndSendInvoice(invoiceData);
        if (!invoiceResult) return { kind: 'invoiceFailed' };
        return { kind: 'success', invoiceResult };
      });

      if (intake.kind === 'block') {
        return res.status(intake.block.status).json(intake.block.body);
      }
      if (intake.kind === 'invoiceFailed') {
        return res.status(500).json({
          error: "Failed to create invoice",
          message:
            "Could not create or send invoice. Please contact finance@agenticadvertising.org for assistance.",
        });
      }
      const result = intake.invoiceResult;

      if (validatedInvoiceReferralCode) {
        try {
          await referralDb.redeemReferralCodeForInvoice(
            validatedInvoiceReferralCode.code,
            org.name,
            user.email,
          );
        } catch (err) {
          logger.warn({ err, referral_code, orgId }, 'Failed to record referral for invoice — continuing');
        }
      }

      logger.info(
        { invoiceId: result.invoiceId, orgId, lookupKey, userId: user.id },
        "Invoice request processed successfully"
      );

      notifyInvoiceSent({
        organizationName: org.name,
        contactEmail: user.email,
        contactName: displayName,
        amount: product.amount_cents,
        currency: product.currency,
        productName: product.display_name,
        invoiceId: result.invoiceId,
      }).catch((err) =>
        logger.error({ err }, "Failed to send billing channel notification for invoice request")
      );

      res.json({
        success: true,
        message: `Invoice sent to ${user.email}. Please check your email for payment instructions.`,
        invoiceId: result.invoiceId,
        invoiceUrl: result.invoiceUrl,
      });
    } catch (error) {
      logger.error({ err: error }, "Invoice request error");
      res.status(500).json({
        error: "Failed to process invoice request",
        message: "An unexpected error occurred. Please try again or contact support.",
      });
    }
  });

  // POST /api/checkout-session - Create a Stripe Checkout session (requires auth)
  router.post(
    "/checkout-session",
    requireAuth,
    async (req: Request, res: Response) => {
      try {
        const user = req.user!;
        const { priceId, orgId, referral_code } = req.body as {
          priceId: string;
          orgId: string;
          referral_code?: string;
        };

        if (!priceId || !orgId) {
          return res.status(400).json({
            error: "Missing required fields",
            message: "Please provide priceId and orgId",
          });
        }

        // Get organization to check if user has access
        const org = await orgDb.getOrganization(orgId);
        if (!org) {
          return res.status(404).json({
            error: "Organization not found",
            message: "The specified organization does not exist",
          });
        }

        // Validate that the requested product is available for this org type.
        // This endpoint handles membership checkout only; event and sponsorship
        // purchases use separate flows.
        const customerType = org.is_personal ? 'individual' : 'company';
        const eligibleProducts = await getProductsForCustomer({
          customerType,
          category: 'membership',
        });
        if (!eligibleProducts.some(p => p.price_id === priceId)) {
          return res.status(400).json({
            error: "Product not available",
            message: "This membership tier is not available for your organization. Please select a different tier.",
          });
        }

        // Dev mode: skip WorkOS membership check for dev orgs
        const isDevUserCheckout =
          isDevModeEnabled() &&
          Object.values(DEV_USERS).some((du) => du.id === user.id) &&
          orgId.startsWith("org_dev_");
        if (!isDevUserCheckout) {
          // Check user membership in organization
          const membership =
            await workos?.userManagement.listOrganizationMemberships({
              userId: user.id,
              organizationId: orgId,
            });

          if (!membership?.data?.length) {
            return res.status(403).json({
              error: "Access denied",
              message: "You are not a member of this organization",
            });
          }
        }

        const host = req.get("host");
        const protocol = req.protocol;
        const baseUrl = `${protocol}://${host}`;

        // Refuse if the org already has an active subscription. Tier changes go
        // through the Stripe Customer Portal, not this checkout intake. The
        // requester is a verified org member, so the portal URL is safe to
        // include.
        const activeBlock = await blockIfActiveSubscription(orgId, orgDb, {
          customerPortalReturnUrl: `${baseUrl}/dashboard/membership`,
        });
        if (activeBlock) {
          return res.status(activeBlock.status).json(activeBlock.body);
        }

        // Determine referral discount to apply at checkout.
        // Priority 1: accepted referral (prospect already accepted invitation — use that discount)
        // Priority 2: referral_code in request body (for direct checkout without going through /join)
        let referralCouponId: string | undefined;
        let acceptedReferral: Awaited<ReturnType<typeof referralDb.getAcceptedReferralForOrg>> = null;
        let validatedReferralCode: Awaited<ReturnType<typeof referralDb.getReferralCode>> = null;

        const orgAlreadyHasDiscount = !!(
          org.stripe_coupon_id ||
          org.stripe_promotion_code ||
          org.discount_percent ||
          org.discount_amount_cents
        );

        // Check for a pre-accepted referral first
        acceptedReferral = await referralDb.getAcceptedReferralForOrg(orgId);

        if (acceptedReferral) {
          // Prospect already accepted an invitation — apply that discount
          if (acceptedReferral.discount_percent && !orgAlreadyHasDiscount) {
            const coupon = await createCoupon({
              name: `Referral: ${acceptedReferral.referral_code}`,
              percent_off: acceptedReferral.discount_percent,
              duration: 'once',
              max_redemptions: 1,
              metadata: { referral_code: acceptedReferral.referral_code },
            });
            if (coupon) {
              referralCouponId = coupon.coupon_id;
            }
          }
        } else if (referral_code) {
          // No pre-accepted referral; try the code from the request body (fallback path)
          validatedReferralCode = await referralDb.getReferralCode(referral_code);

          if (!validatedReferralCode || validatedReferralCode.status !== 'active') {
            return res.status(400).json({ error: 'Invalid or expired referral code' });
          }

          if (validatedReferralCode.expires_at && validatedReferralCode.expires_at < new Date()) {
            return res.status(400).json({ error: 'Referral code has expired' });
          }

          if (validatedReferralCode.max_uses !== null && validatedReferralCode.used_count >= validatedReferralCode.max_uses) {
            return res.status(400).json({ error: 'Referral code has been fully redeemed' });
          }

          if (validatedReferralCode.discount_percent && !orgAlreadyHasDiscount) {
            const coupon = await createCoupon({
              name: `Referral: ${validatedReferralCode.code}`,
              percent_off: validatedReferralCode.discount_percent,
              duration: 'once',
              max_redemptions: 1,
              metadata: { referral_code: validatedReferralCode.code },
            });
            if (coupon) {
              referralCouponId = coupon.coupon_id;
            }
          }
        }

        const checkoutData: CheckoutSessionData = {
          priceId,
          customerId: org.stripe_customer_id || undefined,
          customerEmail: org.stripe_customer_id ? undefined : user.email,
          successUrl: `${baseUrl}/dashboard?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
          cancelUrl: `${baseUrl}/dashboard?checkout=cancelled`,
          workosOrganizationId: orgId,
          workosUserId: user.id,
          isPersonalWorkspace: org.is_personal || false,
          // Priority: org coupon > referral coupon > org promo code > allow manual entry
          couponId: org.stripe_coupon_id || referralCouponId || undefined,
          promotionCode: !org.stripe_coupon_id && !referralCouponId ? (org.stripe_promotion_code || undefined) : undefined,
        };

        const result = await createCheckoutSession(checkoutData);

        // For the fallback code path (user entered a code at checkout rather than accepting
        // on the landing page), consume the code now. This increments used_count before
        // payment completes — the same tradeoff as the original invoice flow. A user who
        // abandons checkout will have consumed a single-use code. The pre-accepted path
        // (above) avoids this because the code is consumed at /join/:code accept time.
        if (validatedReferralCode && result) {
          try {
            await referralDb.acceptReferralCode(validatedReferralCode.code, orgId, user.id);
          } catch (err) {
            logger.warn({ err, referral_code, orgId }, 'Failed to record referral at checkout — continuing');
          }
        }

        if (!result) {
          return res.status(500).json({
            error: "Failed to create checkout session",
            message: "Stripe is not configured. Please contact support.",
          });
        }

        logger.info(
          {
            sessionId: result.sessionId,
            orgId,
            userId: user.id,
            priceId,
          },
          "Checkout session created"
        );

        res.json({
          success: true,
          sessionId: result.sessionId,
          url: result.url,
        });
      } catch (error) {
        logger.error({ err: error }, "Checkout session creation error");
        res.status(500).json({
          error: "Failed to create checkout session",
        });
      }
    }
  );

  // GET /api/organizations/:orgId/billing - Get billing info
  router.get(
    "/organizations/:orgId/billing",
    requireAuth,
    async (req: Request, res: Response) => {
      try {
        const user = req.user!;
        const { orgId } = req.params;

        // Dev mode: return mock billing data based on dev user type and actual org
        const devUser = isDevModeEnabled() ? getDevUser(req) : null;
        if (devUser) {
          // Look up the actual org to get is_personal flag
          const devOrg = await orgDb.getOrganization(orgId);
          if (!devOrg) {
            return res.status(404).json({ error: "Organization not found" });
          }
          const isPersonal = devOrg.is_personal || false;

          if (devUser.isMember && !isPersonal) {
            // Company org with active membership
            return res.json({
              subscription: {
                status: "active",
                product_id: "prod_dev_membership",
                product_name: "Company Membership (Dev)",
                lookup_key: "aao_membership_builder_3000",
                amount_cents: 300000,
                current_period_end: Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60, // 1 year from now
                cancel_at_period_end: false,
              },
              stripe_customer_id: "cus_dev_mock",
              customer_session_secret: null,
              company_type: "adtech",
              revenue_tier: "5m_50m",
              is_personal: false,
              pending_invoices: [],
              suggested_company_type: "adtech",
              suggested_revenue_tier: "5m_50m",
            });
          } else if (devUser.isMember && isPersonal) {
            // Personal workspace with active individual membership
            return res.json({
              subscription: {
                status: "active",
                product_id: "prod_dev_individual",
                product_name: "Individual Membership (Dev)",
                lookup_key: "aao_membership_professional_250",
                amount_cents: 25000,
                current_period_end: Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60,
                cancel_at_period_end: false,
              },
              stripe_customer_id: "cus_dev_mock",
              customer_session_secret: null,
              company_type: null,
              revenue_tier: null,
              is_personal: true,
              pending_invoices: [],
              suggested_company_type: null,
              suggested_revenue_tier: null,
            });
          } else {
            // Non-member dev user - no subscription
            return res.json({
              subscription: null,
              stripe_customer_id: "cus_dev_mock",
              customer_session_secret: null,
              company_type: null,
              revenue_tier: null,
              is_personal: isPersonal,
              pending_invoices: [],
              suggested_company_type: null,
              suggested_revenue_tier: null,
            });
          }
        }

        // Get organization from database
        let org = await orgDb.getOrganization(orgId);
        if (!org) {
          // Dev mode: skip WorkOS sync for dev orgs
          if (DEV_MODE_ENABLED && orgId.startsWith("org_dev_")) {
            return res.status(404).json({
              error: "Organization not found",
              message: "The requested organization does not exist in local database",
            });
          }
          // Organization not in local DB - try to sync from WorkOS on-demand
          try {
            const workosOrg = await workos!.organizations.getOrganization(orgId);
            if (workosOrg) {
              org = await orgDb.createOrganization({
                workos_organization_id: workosOrg.id,
                name: workosOrg.name,
              });
              logger.info(
                { orgId, name: workosOrg.name },
                "On-demand synced organization from WorkOS"
              );
            }
          } catch (syncError) {
            logger.warn(
              { orgId, err: syncError },
              "Failed to sync organization from WorkOS on-demand"
            );
          }
        }

        if (!org) {
          return res.status(404).json({
            error: "Organization not found",
            message: "The requested organization does not exist",
          });
        }

        // Dev mode: skip membership check for dev orgs (dev users own all dev orgs)
        const isDevUserBilling =
          isDevModeEnabled() &&
          Object.values(DEV_USERS).some((du) => du.id === user.id) &&
          orgId.startsWith("org_dev_");
        if (!isDevUserBilling) {
          // Verify user is a member of this organization
          const memberships =
            await workos!.userManagement.listOrganizationMemberships({
              userId: user.id,
              organizationId: orgId,
            });

          if (memberships.data.length === 0) {
            return res.status(403).json({
              error: "Access denied",
              message: "You are not a member of this organization",
            });
          }
        }

        // Get subscription info - if this fails, we want to know about it
        const subscriptionInfo = await orgDb.getSubscriptionInfo(orgId);

        if (subscriptionInfo === null) {
          // Stripe API call failed - this is an error, not "no subscription"
          return res.status(500).json({
            error: "Failed to fetch subscription info from Stripe",
            message: "Unable to retrieve billing information. Please try again.",
          });
        }

        // Ensure Stripe customer exists before showing pricing table
        // This is critical: if we don't create the customer first, Stripe Pricing Table
        // will create one without workos_organization_id metadata, breaking the linkage
        const stripeCustomerId = await orgDb.getOrCreateStripeCustomer(orgId, () =>
          createStripeCustomer({
            email: user.email,
            name: org.name,
            metadata: { workos_organization_id: orgId },
          })
        );

        if (!stripeCustomerId) {
          logger.error({ orgId }, "Failed to create Stripe customer for pricing table");
        }

        // Create customer session for pricing table
        let customerSessionSecret = null;
        if (stripeCustomerId) {
          customerSessionSecret = await createCustomerSession(stripeCustomerId);
        }

        // Get pending invoices if customer exists
        let pendingInvoices: Awaited<ReturnType<typeof getPendingInvoices>> = [];
        if (stripeCustomerId) {
          try {
            pendingInvoices = await getPendingInvoices(stripeCustomerId);
          } catch (err) {
            logger.warn(
              { err, orgId, stripeCustomerId },
              "Error fetching pending invoices"
            );
          }
        }

        // Calculate suggested values from enrichment data for prefilling the profile modal
        // These are only used as suggestions when company_type or revenue_tier are not yet set
        const orgWithEnrichment = org as Organization & {
          enrichment_industry?: string;
          enrichment_sub_industry?: string;
          enrichment_revenue?: number;
        };

        const suggestedCompanyType = mapIndustryToCompanyType(
          orgWithEnrichment.enrichment_industry || undefined,
          orgWithEnrichment.enrichment_sub_industry || undefined
        );
        const suggestedRevenueTier = mapRevenueToTier(
          orgWithEnrichment.enrichment_revenue
        );

        res.json({
          subscription: subscriptionInfo,
          stripe_customer_id: stripeCustomerId || null,
          customer_session_secret: customerSessionSecret,
          company_type: org.company_type || null,
          revenue_tier: org.revenue_tier || null,
          is_personal: org.is_personal || false,
          pending_invoices: pendingInvoices,
          billing_address: org.billing_address || null,
          // Enrichment-based suggestions for prefilling the profile modal
          suggested_company_type: suggestedCompanyType,
          suggested_revenue_tier: suggestedRevenueTier,
          // Discount info for display (if any)
          discount_percent: org.discount_percent || null,
          discount_amount_cents: org.discount_amount_cents || null,
          stripe_promotion_code: org.stripe_promotion_code || null,
        });
      } catch (error) {
        logger.error({ err: error }, "Get billing info error:");
        res.status(500).json({
          error: "Failed to get billing info",
          message: "An unexpected error occurred. Please try again.",
        });
      }
    }
  );

  // PUT /api/organizations/:orgId/billing-info - Update org billing info (company_type, revenue_tier)
  router.put(
    "/organizations/:orgId/billing-info",
    requireAuth,
    async (req: Request, res: Response) => {
      try {
        const user = req.user!;
        const { orgId } = req.params;
        const { company_type, revenue_tier } = req.body;

        // Validate inputs - use centralized constants
        if (company_type && !COMPANY_TYPE_VALUES.includes(company_type)) {
          return res.status(400).json({
            error: "Invalid company_type",
            message: `company_type must be one of: ${COMPANY_TYPE_VALUES.join(", ")}`,
          });
        }

        if (revenue_tier && !VALID_REVENUE_TIERS.includes(revenue_tier as any)) {
          return res.status(400).json({
            error: "Invalid revenue_tier",
            message: `revenue_tier must be one of: ${VALID_REVENUE_TIERS.join(", ")}`,
          });
        }

        // Get organization
        const org = await orgDb.getOrganization(orgId);
        if (!org) {
          return res.status(404).json({
            error: "Organization not found",
            message: "The requested organization does not exist",
          });
        }

        // Dev mode: skip membership check for dev orgs
        const isDevUserBilling =
          isDevModeEnabled() &&
          Object.values(DEV_USERS).some((du) => du.id === user.id) &&
          orgId.startsWith("org_dev_");
        if (!isDevUserBilling) {
          // Verify user is a member of this organization with admin/owner role
          const memberships =
            await workos!.userManagement.listOrganizationMemberships({
              userId: user.id,
              organizationId: orgId,
            });

          if (memberships.data.length === 0) {
            return res.status(403).json({
              error: "Access denied",
              message: "You are not a member of this organization",
            });
          }
        }

        // Update org billing info using updateOrganization
        const updateData: { company_type?: CompanyType; revenue_tier?: RevenueTier } =
          {};
        if (company_type) updateData.company_type = company_type as CompanyType;
        if (revenue_tier) updateData.revenue_tier = revenue_tier as RevenueTier;

        await orgDb.updateOrganization(orgId, updateData);

        logger.info(
          { orgId, company_type, revenue_tier, userId: user.id },
          "Updated organization billing info"
        );

        res.json({
          success: true,
          company_type: company_type || org.company_type,
          revenue_tier: revenue_tier || org.revenue_tier,
        });
      } catch (error) {
        logger.error({ err: error }, "Update billing info error:");
        res.status(500).json({
          error: "Failed to update billing info",
          message: "An unexpected error occurred. Please try again.",
        });
      }
    }
  );

  // GET /api/user/escalations - Get escalations for the authenticated user
  router.get(
    "/user/escalations",
    requireAuth,
    async (req: Request, res: Response) => {
      try {
        const user = req.user!;
        // WorkOS auth doesn't carry a Slack user ID, so escalations created via
        // Slack before the user linked their WorkOS account won't appear here.
        const rows = await listEscalationsForUser(user.id, undefined);
        // Return only member-safe fields; addie_context and original_request are internal
        const escalations = rows.map(({ id, summary, status, created_at, resolution_notes }) => ({
          id, summary, status, created_at, resolution_notes,
        }));
        res.json({ escalations });
      } catch (error) {
        logger.error({ err: error }, "Error fetching user escalations");
        res.status(500).json({ error: "Failed to fetch escalations" });
      }
    }
  );

  return router;
}
