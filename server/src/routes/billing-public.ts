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
  getPendingInvoices,
  createStripeCustomer,
  createCustomerSession,
  type BillingProduct,
  type InvoiceRequestData,
  type CheckoutSessionData,
} from "../billing/stripe-client.js";
import {
  OrganizationDatabase,
  type CompanyType,
  type RevenueTier,
  type Organization,
} from "../db/organization-db.js";
import {
  mapIndustryToCompanyType,
  mapRevenueToTier,
} from "../services/lusha.js";
import { COMPANY_TYPE_VALUES } from "../config/company-types.js";
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

  // POST /api/invoice-request - Request an invoice for a product (public endpoint)
  router.post("/invoice-request", async (req: Request, res: Response) => {
    try {
      const { companyName, contactName, contactEmail, billingAddress, lookupKey } =
        req.body as {
          companyName: string;
          contactName: string;
          contactEmail: string;
          billingAddress: {
            line1: string;
            line2?: string;
            city: string;
            state: string;
            postal_code: string;
            country: string;
          };
          lookupKey: string;
        };

      // Validate required fields
      if (
        !companyName ||
        !contactName ||
        !contactEmail ||
        !billingAddress ||
        !lookupKey
      ) {
        return res.status(400).json({
          error: "Missing required fields",
          message:
            "Please provide companyName, contactName, contactEmail, billingAddress, and lookupKey",
        });
      }

      if (
        !billingAddress.line1 ||
        !billingAddress.city ||
        !billingAddress.state ||
        !billingAddress.postal_code ||
        !billingAddress.country
      ) {
        return res.status(400).json({
          error: "Incomplete billing address",
          message: "Please provide line1, city, state, postal_code, and country",
        });
      }

      // Validate lookup key starts with our prefix
      if (!lookupKey.startsWith("aao_")) {
        logger.warn({ lookupKey }, 'Invoice request rejected: invalid lookup key prefix');
        return res.status(400).json({
          error: "Invalid product",
          message: "Invalid product selection",
        });
      }

      logger.info({
        lookupKey,
        companyName,
        contactEmail,
      }, 'Invoice request received');

      // Validate email format
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(contactEmail)) {
        return res.status(400).json({
          error: "Invalid email format",
          message: "Please provide a valid email address",
        });
      }

      const invoiceData: InvoiceRequestData = {
        companyName,
        contactName,
        contactEmail,
        billingAddress,
        lookupKey,
      };

      const result = await createAndSendInvoice(invoiceData);

      if (!result) {
        return res.status(500).json({
          error: "Failed to create invoice",
          message:
            "Could not create or send invoice. Please contact finance@agenticadvertising.org for assistance.",
        });
      }

      // Get product details for the notification
      const products = await getInvoiceableProducts();
      const product = products.find((p) => p.lookup_key === lookupKey);
      const productDisplay = product
        ? `${product.display_name} ($${(product.amount_cents / 100).toLocaleString()})`
        : lookupKey;

      logger.info(
        {
          invoiceId: result.invoiceId,
          companyName,
          contactEmail,
          lookupKey,
        },
        "Invoice request processed successfully"
      );

      // Send Slack notification for invoice request
      if (process.env.SLACK_WEBHOOK_URL) {
        fetch(process.env.SLACK_WEBHOOK_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text: `Invoice requested`,
            blocks: [
              {
                type: "section",
                text: {
                  type: "mrkdwn",
                  text: `*New Invoice Request*\n\n*Company:* ${companyName}\n*Contact:* ${contactName} (${contactEmail})\n*Product:* ${productDisplay}\n*Invoice ID:* ${result.invoiceId}`,
                },
              },
            ],
          }),
        }).catch((err) =>
          logger.error({ err }, "Failed to send Slack notification for invoice request")
        );
      }

      res.json({
        success: true,
        message: `Invoice sent to ${contactEmail}. Please check your email for payment instructions.`,
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
        const { priceId, orgId } = req.body as {
          priceId: string;
          orgId: string;
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

        const checkoutData: CheckoutSessionData = {
          priceId,
          customerId: org.stripe_customer_id || undefined,
          customerEmail: org.stripe_customer_id ? undefined : user.email,
          successUrl: `${baseUrl}/dashboard?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
          cancelUrl: `${baseUrl}/dashboard?checkout=cancelled`,
          workosOrganizationId: orgId,
          workosUserId: user.id,
          isPersonalWorkspace: org.is_personal || false,
          // Apply org's stored coupon if available
          couponId: org.stripe_coupon_id || undefined,
          // Only use promotion code if no coupon ID (coupon takes precedence)
          promotionCode: !org.stripe_coupon_id ? (org.stripe_promotion_code || undefined) : undefined,
        };

        const result = await createCheckoutSession(checkoutData);

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
        const errorMessage = error instanceof Error ? error.message : "An unexpected error occurred. Please try again.";
        res.status(500).json({
          error: "Failed to create checkout session",
          message: errorMessage,
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

        // Dev mode: return mock billing data based on dev user type
        const devUser = isDevModeEnabled() ? getDevUser(req) : null;
        if (devUser) {
          // For 'member' and 'admin' dev users, simulate active membership
          // For 'nonmember' dev user, simulate personal workspace with no subscription
          if (devUser.isMember) {
            return res.json({
              subscription: {
                status: "active",
                product_id: "prod_dev_membership",
                product_name: "Company Membership (Dev)",
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
          } else {
            // Non-member dev user - personal workspace (no subscription)
            return res.json({
              subscription: null,
              stripe_customer_id: "cus_dev_mock",
              customer_session_secret: null,
              company_type: null,
              revenue_tier: null,
              is_personal: true,
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
        let stripeCustomerId = org.stripe_customer_id;
        if (!stripeCustomerId) {
          logger.info(
            { orgId, userName: user.email },
            "Creating Stripe customer for pricing table"
          );
          stripeCustomerId = await createStripeCustomer({
            email: user.email,
            name: org.name,
            metadata: {
              workos_organization_id: orgId,
            },
          });

          if (stripeCustomerId) {
            await orgDb.setStripeCustomerId(orgId, stripeCustomerId);
            logger.info(
              { orgId, stripeCustomerId },
              "Stripe customer created and linked to organization"
            );
          } else {
            logger.error(
              { orgId },
              "Failed to create Stripe customer for pricing table"
            );
          }
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

        // Validate inputs - use centralized company types config
        const validCompanyTypes = COMPANY_TYPE_VALUES;
        const validRevenueTiers = [
          "under_1m",
          "1m_5m",
          "5m_50m",
          "50m_250m",
          "250m_1b",
          "1b_plus",
        ];

        if (company_type && !validCompanyTypes.includes(company_type)) {
          return res.status(400).json({
            error: "Invalid company_type",
            message: `company_type must be one of: ${validCompanyTypes.join(", ")}`,
          });
        }

        if (revenue_tier && !validRevenueTiers.includes(revenue_tier)) {
          return res.status(400).json({
            error: "Invalid revenue_tier",
            message: `revenue_tier must be one of: ${validRevenueTiers.join(", ")}`,
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

  return router;
}
