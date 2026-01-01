/**
 * Admin routes module
 *
 * This module composes admin routes from individual route modules.
 * Routes are organized into focused modules for better maintainability.
 */

import { Router } from "express";
import { WorkOS } from "@workos-inc/node";
import { getPool } from "../db/client.js";
import { createLogger } from "../logger.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";
import { serveHtmlWithConfig } from "../utils/html-config.js";
import { getMemberContext, getWebMemberContext } from "../addie/member-context.js";
import {
  createCheckoutSession,
  getProductsForCustomer,
  createAndSendInvoice,
} from "../billing/stripe-client.js";

// Import route modules
import { setupProspectRoutes } from "./admin/prospects.js";
import { setupOrganizationRoutes } from "./admin/organizations.js";
import { setupEnrichmentRoutes } from "./admin/enrichment.js";
import { setupDomainRoutes } from "./admin/domains.js";
import { setupCleanupRoutes } from "./admin/cleanup.js";

const logger = createLogger("admin-routes");

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

/**
 * Create admin routes
 * Returns separate routers for page routes (/admin/*) and API routes (/api/admin/*)
 */
export function createAdminRouter(): { pageRouter: Router; apiRouter: Router } {
  const pageRouter = Router();
  const apiRouter = Router();

  // =========================================================================
  // ADMIN PAGE ROUTES (mounted at /admin)
  // =========================================================================

  pageRouter.get("/prospects", requireAuth, requireAdmin, (req, res) => {
    serveHtmlWithConfig(req, res, "admin-prospects.html").catch((err) => {
      logger.error({ err }, "Error serving admin prospects page");
      res.status(500).send("Internal server error");
    });
  });

  pageRouter.get("/api-keys", requireAuth, requireAdmin, (req, res) => {
    serveHtmlWithConfig(req, res, "admin-api-keys.html").catch((err) => {
      logger.error({ err }, "Error serving admin API keys page");
      res.status(500).send("Internal server error");
    });
  });

  // =========================================================================
  // SET UP ROUTE MODULES
  // =========================================================================

  // Prospect management routes
  setupProspectRoutes(apiRouter, { workos });

  // Organization detail and management routes
  setupOrganizationRoutes(pageRouter, apiRouter, { workos });

  // Company enrichment and prospecting routes
  setupEnrichmentRoutes(apiRouter);

  // Domain discovery, email contacts, and org domains routes
  setupDomainRoutes(apiRouter, { workos });

  // Prospect cleanup routes
  setupCleanupRoutes(apiRouter);

  // =========================================================================
  // USER CONTEXT API (for viewing member context like Addie sees it)
  // =========================================================================

  // GET /api/admin/users/:userId/context - Get member context for a user
  apiRouter.get(
    "/users/:userId/context",
    requireAuth,
    requireAdmin,
    async (req, res) => {
      try {
        const { userId } = req.params;
        const { type } = req.query;

        let context;

        // Auto-detect or use specified type
        if (type === "slack" || (!type && userId.startsWith("U"))) {
          context = await getMemberContext(userId);
        } else if (type === "workos" || (!type && userId.startsWith("user_"))) {
          context = await getWebMemberContext(userId);
        } else {
          // Try both - first check if it's a WorkOS ID
          try {
            context = await getWebMemberContext(userId);
            if (!context.workos_user && !context.organization) {
              context = await getMemberContext(userId);
            }
          } catch {
            context = await getMemberContext(userId);
          }
        }

        if (!context.is_mapped && !context.slack_user && !context.workos_user) {
          return res.status(404).json({
            error: "User not found",
            message: "Could not find context for this user ID",
          });
        }

        res.json(context);
      } catch (error) {
        logger.error({ err: error }, "Error fetching user context");
        res.status(500).json({
          error: "Internal server error",
          message: "Unable to fetch user context",
        });
      }
    }
  );

  // GET /api/admin/prospects/view-counts - Get counts for each view for the nav
  apiRouter.get(
    "/prospects/view-counts",
    requireAuth,
    requireAdmin,
    async (req, res) => {
      try {
        const pool = getPool();
        const userId = req.user?.id;

        // Run all counts in parallel
        const [
          needsFollowup,
          newSignups,
          goingCold,
          renewals,
          myAccounts,
        ] = await Promise.all([
          pool.query(`
            SELECT COUNT(DISTINCT o.workos_organization_id) as count
            FROM organizations o
            INNER JOIN org_activities na ON na.organization_id = o.workos_organization_id
              AND na.is_next_step = TRUE
              AND na.next_step_completed_at IS NULL
              AND (na.next_step_due_date IS NULL OR na.next_step_due_date <= NOW() + INTERVAL '7 days')
          `),
          pool.query(`
            SELECT COUNT(*) as count
            FROM organizations o
            WHERE o.created_at > NOW() - INTERVAL '14 days'
              AND NOT EXISTS (SELECT 1 FROM org_activities WHERE organization_id = o.workos_organization_id)
          `),
          pool.query(`
            SELECT COUNT(*) as count
            FROM organizations o
            WHERE o.last_activity_at IS NOT NULL
              AND o.last_activity_at < NOW() - INTERVAL '30 days'
              AND (
                o.subscription_status IS NULL
                OR o.subscription_status NOT IN ('active', 'trialing')
                OR o.subscription_canceled_at IS NOT NULL
              )
          `),
          pool.query(`
            SELECT COUNT(*) as count
            FROM organizations o
            WHERE o.subscription_status = 'active'
              AND o.subscription_current_period_end IS NOT NULL
              AND o.subscription_current_period_end >= NOW()
              AND o.subscription_current_period_end <= NOW() + INTERVAL '60 days'
          `),
          userId
            ? pool.query(
                `SELECT COUNT(*) as count FROM org_stakeholders WHERE user_id = $1`,
                [userId]
              )
            : Promise.resolve({ rows: [{ count: 0 }] }),
        ]);

        res.json({
          needs_followup: parseInt(needsFollowup.rows[0]?.count || "0"),
          new_signups: parseInt(newSignups.rows[0]?.count || "0"),
          going_cold: parseInt(goingCold.rows[0]?.count || "0"),
          renewals: parseInt(renewals.rows[0]?.count || "0"),
          my_accounts: parseInt(myAccounts.rows[0]?.count || "0"),
        });
      } catch (error) {
        logger.error({ err: error }, "Error fetching view counts");
        res.status(500).json({
          error: "Internal server error",
          message: "Unable to fetch view counts",
        });
      }
    }
  );

  // =========================================================================
  // PAYMENT LINK GENERATION FOR PROSPECTS
  // =========================================================================

  // POST /api/admin/prospects/:orgId/payment-link - Generate a payment link for a prospect
  apiRouter.post(
    "/prospects/:orgId/payment-link",
    requireAuth,
    requireAdmin,
    async (req, res) => {
      try {
        const { orgId } = req.params;
        const { lookup_key } = req.body;

        const pool = getPool();
        const orgResult = await pool.query(
          `SELECT workos_organization_id, name, is_personal, prospect_contact_email
           FROM organizations WHERE workos_organization_id = $1`,
          [orgId]
        );

        if (orgResult.rows.length === 0) {
          return res.status(404).json({ error: "Organization not found" });
        }

        const org = orgResult.rows[0];
        const customerType = org.is_personal ? "individual" : "company";

        // Fetch products once - we need the full product object for price_id
        const products = await getProductsForCustomer({
          customerType,
          category: "membership",
        });

        if (!lookup_key) {
          return res.json({
            needs_selection: true,
            products: products.map(p => ({
              lookup_key: p.lookup_key,
              display_name: p.display_name,
              amount_cents: p.amount_cents,
              revenue_tiers: p.revenue_tiers,
            })),
            message: "Select a product to generate payment link",
          });
        }

        const product = products.find(p => p.lookup_key === lookup_key);
        if (!product) {
          return res.status(400).json({
            error: "Product not found",
            message: `No product found with lookup key: ${lookup_key}`,
          });
        }

        const baseUrl = process.env.BASE_URL || "https://agenticadvertising.org";
        const session = await createCheckoutSession({
          priceId: product.price_id,
          customerEmail: org.prospect_contact_email || undefined,
          successUrl: `${baseUrl}/dashboard?payment=success`,
          cancelUrl: `${baseUrl}/join?payment=cancelled`,
          workosOrganizationId: orgId,
          isPersonalWorkspace: org.is_personal,
        });

        if (!session) {
          return res.status(500).json({
            error: "Failed to create payment link",
            message: "Stripe may not be configured",
          });
        }

        logger.info(
          {
            orgId,
            orgName: org.name,
            lookupKey: lookup_key,
            adminEmail: req.user!.email,
          },
          "Admin generated payment link for prospect"
        );

        res.json({
          success: true,
          payment_url: session.url,
          product: {
            display_name: product.display_name,
            amount_cents: product.amount_cents,
          },
          organization: {
            name: org.name,
            email: org.prospect_contact_email,
          },
        });
      } catch (error) {
        logger.error({ err: error }, "Error generating payment link");
        res.status(500).json({
          error: "Internal server error",
          message: "Unable to generate payment link",
        });
      }
    }
  );

  // =========================================================================
  // INVOICE GENERATION FOR PROSPECTS
  // =========================================================================

  // POST /api/admin/prospects/:orgId/invoice - Generate and send an invoice for a prospect
  apiRouter.post(
    "/prospects/:orgId/invoice",
    requireAuth,
    requireAdmin,
    async (req, res) => {
      try {
        const { orgId } = req.params;
        const {
          lookup_key,
          company_name,
          contact_name,
          contact_email,
          billing_address,
        } = req.body;

        if (!lookup_key || !company_name || !contact_name || !contact_email || !billing_address) {
          return res.status(400).json({
            error: "Missing required fields",
            message: "lookup_key, company_name, contact_name, contact_email, and billing_address are required",
          });
        }

        if (!billing_address.line1 || !billing_address.city || !billing_address.state ||
            !billing_address.postal_code || !billing_address.country) {
          return res.status(400).json({
            error: "Incomplete billing address",
            message: "Billing address must include line1, city, state, postal_code, and country",
          });
        }

        const pool = getPool();
        const orgResult = await pool.query(
          `SELECT workos_organization_id, name FROM organizations WHERE workos_organization_id = $1`,
          [orgId]
        );

        if (orgResult.rows.length === 0) {
          return res.status(404).json({ error: "Organization not found" });
        }

        const org = orgResult.rows[0];

        const result = await createAndSendInvoice({
          lookupKey: lookup_key,
          companyName: company_name,
          contactName: contact_name,
          contactEmail: contact_email,
          billingAddress: {
            line1: billing_address.line1,
            line2: billing_address.line2,
            city: billing_address.city,
            state: billing_address.state,
            postal_code: billing_address.postal_code,
            country: billing_address.country,
          },
          workosOrganizationId: orgId,
        });

        if (!result) {
          return res.status(500).json({
            error: "Failed to create invoice",
            message: "Stripe may not be configured or the product was not found",
          });
        }

        await pool.query(
          `UPDATE organizations SET
            invoice_requested_at = NOW(),
            prospect_contact_name = $1,
            prospect_contact_email = $2
           WHERE workos_organization_id = $3`,
          [contact_name, contact_email, orgId]
        );

        logger.info(
          {
            orgId,
            orgName: org.name,
            lookupKey: lookup_key,
            invoiceId: result.invoiceId,
            contactEmail: contact_email,
            adminEmail: req.user!.email,
          },
          "Admin sent invoice to prospect"
        );

        res.json({
          success: true,
          invoice_id: result.invoiceId,
          invoice_url: result.invoiceUrl,
          organization: {
            name: org.name,
          },
          contact: {
            name: contact_name,
            email: contact_email,
          },
        });
      } catch (error) {
        logger.error({ err: error }, "Error sending invoice");
        res.status(500).json({
          error: "Internal server error",
          message: "Unable to send invoice",
        });
      }
    }
  );

  // =========================================================================
  // WORKOS WIDGET TOKEN API (mounted at /api/admin)
  // =========================================================================

  // POST /api/admin/widgets/token - Generate a widget token for API keys management
  apiRouter.post(
    "/widgets/token",
    requireAuth,
    requireAdmin,
    async (req, res) => {
      try {
        if (!workos) {
          return res.status(500).json({
            error: "Authentication not configured",
            message: "WorkOS is not configured on this server",
          });
        }

        const { organizationId, scope } = req.body;

        if (!organizationId) {
          return res.status(400).json({
            error: "Invalid request",
            message: "organizationId is required",
          });
        }

        if (!req.user?.id) {
          return res.status(401).json({
            error: "Authentication required",
            message: "User ID not found in session",
          });
        }

        const validScopes = [
          "widgets:api-keys:manage",
          "widgets:users-table:manage",
          "widgets:sso:manage",
          "widgets:domain-verification:manage",
        ] as const;

        const requestedScope = scope || "widgets:api-keys:manage";
        if (!validScopes.includes(requestedScope)) {
          return res.status(400).json({
            error: "Invalid scope",
            message: `Valid scopes are: ${validScopes.join(", ")}`,
          });
        }

        const token = await workos.widgets.getToken({
          organizationId,
          userId: req.user.id,
          scopes: [requestedScope],
        });

        logger.info(
          { userId: req.user?.id, organizationId, scope: requestedScope },
          "Generated widget token"
        );

        res.json({ token });
      } catch (error) {
        logger.error({ err: error }, "Error generating widget token");
        res.status(500).json({
          error: "Internal server error",
          message: error instanceof Error ? error.message : "Unable to generate widget token",
        });
      }
    }
  );

  return { pageRouter, apiRouter };
}
