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
import { getMemberCapabilities } from "../db/outbound-db.js";
import { getOutboundPlanner } from "../addie/services/outbound-planner.js";
import * as outboundDb from "../db/outbound-db.js";
import { canContactUser } from "../addie/services/proactive-outreach.js";
import { InsightsDatabase } from "../db/insights-db.js";
import type { PlannerContext, MemberCapabilities } from "../addie/types.js";

// Import route modules
import { setupProspectRoutes } from "./admin/prospects.js";
import { setupOrganizationRoutes } from "./admin/organizations.js";
import { setupEnrichmentRoutes } from "./admin/enrichment.js";
import { setupDomainRoutes } from "./admin/domains.js";
import { setupCleanupRoutes } from "./admin/cleanup.js";
import { setupStatsRoutes } from "./admin/stats.js";
import { setupDiscountRoutes } from "./admin/discounts.js";
import { setupMembersRoutes } from "./admin/members.js";
import { setupAccountRoutes } from "./admin/accounts.js";

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

  pageRouter.get("/domain-health", requireAuth, requireAdmin, (req, res) => {
    serveHtmlWithConfig(req, res, "admin-domain-health.html").catch((err) => {
      logger.error({ err }, "Error serving domain health page");
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

  // Dashboard stats routes
  setupStatsRoutes(apiRouter);

  // Discount management routes
  setupDiscountRoutes(apiRouter);

  // Members management routes (list, sync, payments, delete)
  setupMembersRoutes(apiRouter, { workos });

  // Unified account management routes (replaces separate prospect/org detail)
  setupAccountRoutes(pageRouter, apiRouter);

  // =========================================================================
  // USER CONTEXT API (for viewing member context like Addie sees it)
  // =========================================================================

  // GET /api/admin/users/:userId/context - Get member context for a user
  // Extended to include Addie goal and member insights
  apiRouter.get(
    "/users/:userId/context",
    requireAuth,
    requireAdmin,
    async (req, res) => {
      try {
        const { userId } = req.params;
        const { type } = req.query;
        const pool = getPool();

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

        // Extend context with Addie goal from unified_contacts_with_goals
        const workosUserId = context.workos_user?.workos_user_id;
        const slackUserId = context.slack_user?.slack_user_id;

        // Create extended context object with goal and insights
        const extendedContext: typeof context & {
          addie_goal?: { goal_key: string; goal_name: string; reasoning: string };
          insights?: Array<{ type_key: string; type_name: string; value: string }>;
        } = { ...context };

        if (workosUserId || slackUserId) {
          // Get goal from unified contacts view
          const goalQuery = workosUserId
            ? `SELECT goal_key, goal_name, goal_reasoning as reasoning
               FROM unified_contacts_with_goals
               WHERE workos_user_id = $1
               LIMIT 1`
            : `SELECT goal_key, goal_name, goal_reasoning as reasoning
               FROM unified_contacts_with_goals
               WHERE slack_user_id = $1 AND contact_type = 'slack_only'
               LIMIT 1`;

          const goalResult = await pool.query(goalQuery, [workosUserId || slackUserId]);
          if (goalResult.rows.length > 0) {
            extendedContext.addie_goal = goalResult.rows[0];
          }

          // Get member insights
          const insightsQuery = workosUserId
            ? `SELECT mit.name as type_key, mit.name as type_name, mi.value
               FROM member_insights mi
               LEFT JOIN member_insight_types mit ON mit.id = mi.insight_type_id
               WHERE mi.workos_user_id = $1 AND mi.is_current = TRUE
               ORDER BY mi.confidence DESC, mi.created_at DESC
               LIMIT 10`
            : `SELECT mit.name as type_key, mit.name as type_name, mi.value
               FROM member_insights mi
               LEFT JOIN member_insight_types mit ON mit.id = mi.insight_type_id
               WHERE mi.slack_user_id = $1 AND mi.is_current = TRUE
               ORDER BY mi.confidence DESC, mi.created_at DESC
               LIMIT 10`;

          const insightsResult = await pool.query(insightsQuery, [workosUserId || slackUserId]);
          if (insightsResult.rows.length > 0) {
            extendedContext.insights = insightsResult.rows;
          }

          // Get outreach info (if Slack user)
          if (slackUserId) {
            const outreachQuery = `
              SELECT
                sm.last_outreach_at,
                sm.outreach_opt_out,
                EXTRACT(EPOCH FROM (NOW() - sm.last_outreach_at)) / 86400 as days_since_outreach,
                (SELECT COUNT(*) FROM member_outreach mo WHERE mo.slack_user_id = sm.slack_user_id) as total_outreach_count,
                (SELECT COUNT(*) FROM member_outreach mo WHERE mo.slack_user_id = sm.slack_user_id AND mo.user_responded = TRUE) as responses_received
              FROM slack_user_mappings sm
              WHERE sm.slack_user_id = $1`;
            const outreachResult = await pool.query(outreachQuery, [slackUserId]);
            if (outreachResult.rows.length > 0) {
              const row = outreachResult.rows[0];
              (extendedContext as typeof extendedContext & { outreach?: unknown }).outreach = {
                last_outreach_at: row.last_outreach_at,
                days_since_outreach: row.days_since_outreach ? Math.floor(row.days_since_outreach) : null,
                total_outreach_count: parseInt(row.total_outreach_count) || 0,
                responses_received: parseInt(row.responses_received) || 0,
                opted_out: row.outreach_opt_out || false,
              };
            }

            // Get detailed outreach history with goals, responses, and linked threads
            const outreachHistoryQuery = `
              SELECT
                mo.id,
                mo.sent_at,
                mo.initial_message,
                mo.user_responded,
                mo.response_received_at,
                mo.response_sentiment,
                mo.response_intent,
                mo.response_text,
                mo.thread_id,
                mo.dm_channel_id,
                og.name as goal_name,
                og.description as goal_question,
                at.message_count as thread_message_count
              FROM member_outreach mo
              LEFT JOIN user_goal_history ugh ON ugh.outreach_id = mo.id
              LEFT JOIN outreach_goals og ON og.id = ugh.goal_id
              LEFT JOIN addie_threads at ON at.thread_id = mo.thread_id
              WHERE mo.slack_user_id = $1
              ORDER BY mo.sent_at DESC
              LIMIT 10`;
            const historyResult = await pool.query(outreachHistoryQuery, [slackUserId]);
            if (historyResult.rows.length > 0) {
              (extendedContext as typeof extendedContext & { outreach_history?: unknown }).outreach_history = historyResult.rows;
            }
          }

          // Get recent conversations (threads) for this user
          const threadsQuery = workosUserId
            ? `SELECT thread_id, channel, title, message_count, started_at, last_message_at
               FROM addie_threads
               WHERE user_type = 'workos' AND user_id = $1
               ORDER BY last_message_at DESC
               LIMIT 5`
            : `SELECT thread_id, channel, title, message_count, started_at, last_message_at
               FROM addie_threads
               WHERE user_type = 'slack' AND user_id = $1
               ORDER BY last_message_at DESC
               LIMIT 5`;
          const threadsResult = await pool.query(threadsQuery, [workosUserId || slackUserId]);
          if (threadsResult.rows.length > 0) {
            (extendedContext as typeof extendedContext & { recent_conversations?: unknown }).recent_conversations = threadsResult.rows;
          }

          // Get capabilities and planner recommendation (if Slack user)
          if (slackUserId) {
            try {
              const capabilities = await getMemberCapabilities(slackUserId, workosUserId);
              (extendedContext as typeof extendedContext & { capabilities?: MemberCapabilities }).capabilities = capabilities;

              // Get planner recommendation
              const planner = getOutboundPlanner();
              const insightsDb = new InsightsDatabase();
              const [plannerInsights, history, contactEligibility] = await Promise.all([
                insightsDb.getInsightsForUser(slackUserId),
                outboundDb.getUserGoalHistory(slackUserId),
                canContactUser(slackUserId),
              ]);

              // Check if this is a personal workspace (auto-generated "User's Workspace" name)
              const orgName = context.organization?.name ?? '';
              const isPersonalWorkspace = orgName.toLowerCase().endsWith("'s workspace") ||
                                          orgName.toLowerCase().endsWith("'s workspace");

              const plannerCtx: PlannerContext = {
                user: {
                  slack_user_id: slackUserId,
                  workos_user_id: workosUserId,
                  display_name: context.slack_user?.display_name ?? undefined,
                  is_mapped: !!workosUserId,
                  is_member: context.is_member ?? false,
                  engagement_score: capabilities.slack_message_count_30d > 10 ? 75 :
                                    capabilities.slack_message_count_30d > 5 ? 50 :
                                    capabilities.slack_message_count_30d > 0 ? 25 : 0,
                  insights: plannerInsights.map(i => ({
                    type: i.insight_type_name ?? 'unknown',
                    value: i.value,
                    confidence: i.confidence,
                  })),
                },
                company: context.organization ? {
                  name: isPersonalWorkspace ? 'your account' : context.organization.name,
                  type: 'unknown',
                  is_personal_workspace: isPersonalWorkspace,
                } : undefined,
                capabilities,
                history,
                contact_eligibility: {
                  can_contact: contactEligibility.canContact,
                  reason: contactEligibility.reason ?? 'Eligible',
                },
              };

              const planned = await planner.planNextAction(plannerCtx);
              if (planned) {
                const linkUrl = `https://agenticadvertising.org/auth/login?slack_user_id=${encodeURIComponent(slackUserId)}`;
                const messagePreview = planner.buildMessage(planned.goal, plannerCtx, linkUrl);
                (extendedContext as typeof extendedContext & { planner?: unknown }).planner = {
                  recommended_action: {
                    goal_id: planned.goal.id,
                    goal_name: planned.goal.name,
                    category: planned.goal.category,
                    reason: planned.reason,
                    priority_score: planned.priority_score,
                    decision_method: planned.decision_method,
                  },
                  message_preview: messagePreview,
                  alternative_goals: planned.alternative_goals.map(g => ({
                    id: g.id,
                    name: g.name,
                    category: g.category,
                  })),
                  contact_eligibility: {
                    can_contact: contactEligibility.canContact,
                    reason: contactEligibility.reason,
                  },
                };
              } else {
                (extendedContext as typeof extendedContext & { planner?: unknown }).planner = {
                  recommended_action: null,
                  contact_eligibility: {
                    can_contact: contactEligibility.canContact,
                    reason: contactEligibility.reason,
                  },
                };
              }
            } catch (plannerError) {
              logger.warn({ err: plannerError, slackUserId }, 'Failed to get planner recommendation');
            }
          }
        }

        res.json(extendedContext);
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
        const { lookup_key, coupon_id, promotion_code } = req.body;

        const pool = getPool();
        const orgResult = await pool.query(
          `SELECT workos_organization_id, name, is_personal, prospect_contact_email,
                  stripe_coupon_id, stripe_promotion_code
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
            products: products.map((p) => ({
              lookup_key: p.lookup_key,
              display_name: p.display_name,
              amount_cents: p.amount_cents,
              revenue_tiers: p.revenue_tiers,
            })),
            message: "Select a product to generate payment link",
          });
        }

        const product = products.find((p) => p.lookup_key === lookup_key);
        if (!product) {
          return res.status(400).json({
            error: "Product not found",
            message: `No product found with lookup key: ${lookup_key}`,
          });
        }

        // Determine which coupon/promotion code to use
        // Priority: explicit parameter > org's saved coupon
        const effectiveCouponId = coupon_id || org.stripe_coupon_id;
        const effectivePromoCode = promotion_code || org.stripe_promotion_code;

        const baseUrl =
          process.env.BASE_URL || "https://agenticadvertising.org";
        const session = await createCheckoutSession({
          priceId: product.price_id,
          customerEmail: org.prospect_contact_email || undefined,
          successUrl: `${baseUrl}/dashboard?payment=success`,
          cancelUrl: `${baseUrl}/join?payment=cancelled`,
          workosOrganizationId: orgId,
          isPersonalWorkspace: org.is_personal,
          couponId: effectiveCouponId || undefined,
          promotionCode: !effectiveCouponId ? effectivePromoCode : undefined,
        });

        if (!session) {
          return res.status(500).json({
            error: "Failed to create payment link",
            message: "Stripe is not configured. Please contact support.",
          });
        }

        if (!session.url) {
          return res.status(500).json({
            error: "Failed to create payment link",
            message: "Stripe session created but no URL returned",
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
        // Extract meaningful error message from Stripe errors
        let errorMessage = "Unable to generate payment link";
        if (error instanceof Error) {
          errorMessage = error.message;
        }
        res.status(500).json({
          error: "Internal server error",
          message: errorMessage,
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
          coupon_id,
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
          `SELECT workos_organization_id, name, stripe_coupon_id FROM organizations WHERE workos_organization_id = $1`,
          [orgId]
        );

        if (orgResult.rows.length === 0) {
          return res.status(404).json({ error: "Organization not found" });
        }

        const org = orgResult.rows[0];

        // Use explicit coupon_id from request, or fall back to org's saved coupon
        const effectiveCouponId = coupon_id || org.stripe_coupon_id;

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
          couponId: effectiveCouponId,
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
