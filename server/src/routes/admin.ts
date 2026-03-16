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
import { requireAuth, requireAdmin, requireManage } from "../middleware/auth.js";
import { serveHtmlWithConfig } from "../utils/html-config.js";
import { getMemberContext, getWebMemberContext } from "../addie/member-context.js";
import { getMemberCapabilities } from "../db/outbound-db.js";
import { canEngageSlackUser } from "../addie/services/relationship-orchestrator.js";
import { computeEngagementOpportunities } from "../addie/services/engagement-planner.js";
import type { MemberCapabilities } from "../addie/types.js";
import * as relationshipDb from "../db/relationship-db.js";
import { loadRelationshipContext } from "../addie/services/relationship-context.js";

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
import { setupBrandEnrichmentRoutes } from "./admin/brand-enrichment.js";
import { setupBanRoutes } from "./admin/bans.js";
import { setupGeoRoutes } from "./admin/geo.js";
import { setupRelationshipRoutes } from "./admin/relationships.js";
import { setupSimulationRoutes } from "./admin/simulations.js";

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

  pageRouter.get("/prospects", (req, res) => {
    res.redirect(301, "/manage/prospects");
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

  pageRouter.get("/policies", requireAuth, requireAdmin, (req, res) => {
    serveHtmlWithConfig(req, res, "admin-policies.html").catch((err) => {
      logger.error({ err }, "Error serving policies page");
      res.status(500).send("Internal server error");
    });
  });

  pageRouter.get("/people", requireAuth, requireAdmin, (req, res) => {
    serveHtmlWithConfig(req, res, "admin-people.html").catch((err) => {
      logger.error({ err }, "Error serving people page");
      res.status(500).send("Internal server error");
    });
  });

  pageRouter.get("/simulations", requireAuth, requireAdmin, (req, res) => {
    serveHtmlWithConfig(req, res, "admin-simulations.html").catch((err) => {
      logger.error({ err }, "Error serving simulations page");
      res.status(500).send("Internal server error");
    });
  });

  // =========================================================================
  // SET UP ROUTE MODULES
  // =========================================================================

  // Prospect management routes
  setupProspectRoutes(apiRouter, { workos });

  // Organization detail and management routes
  setupOrganizationRoutes(apiRouter, { workos });

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
  setupAccountRoutes(pageRouter, apiRouter, { workos });

  // Brand registry enrichment routes (Brandfetch)
  setupBrandEnrichmentRoutes(apiRouter);

  // Ban management and registry activity routes
  setupBanRoutes(pageRouter, apiRouter);

  // GEO visibility routes (LLM Pulse integration)
  setupGeoRoutes(apiRouter);

  // Relationship and person events routes
  setupRelationshipRoutes(apiRouter);

  // Outreach simulation and assessment routes
  setupSimulationRoutes(apiRouter);

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

          // Get relationship info from person_relationships + person_events
          if (slackUserId) {
            const relationshipQuery = `
              SELECT
                pr.id as person_id,
                pr.stage,
                pr.interaction_count,
                pr.unreplied_outreach_count,
                pr.sentiment_trend,
                pr.opted_out,
                pr.last_addie_message_at,
                pr.last_person_message_at,
                pr.last_interaction_channel
              FROM person_relationships pr
              WHERE pr.slack_user_id = $1`;
            const relationshipResult = await pool.query(relationshipQuery, [slackUserId]);
            if (relationshipResult.rows.length > 0) {
              const row = relationshipResult.rows[0];
              (extendedContext as typeof extendedContext & { relationship?: unknown }).relationship = row;

              // Get recent person_events for timeline
              const eventsQuery = `
                SELECT event_type, channel, data, occurred_at
                FROM person_events
                WHERE person_id = $1
                ORDER BY occurred_at DESC
                LIMIT 10`;
              const eventsResult = await pool.query(eventsQuery, [row.person_id]);
              if (eventsResult.rows.length > 0) {
                (extendedContext as typeof extendedContext & { event_timeline?: unknown }).event_timeline = eventsResult.rows;
              }
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

              // Get engagement opportunities from the relationship model
              const contactEligibility = await canEngageSlackUser(slackUserId);
              const relationship = await relationshipDb.getRelationshipBySlackId(slackUserId);

              if (relationship) {
                const relCtx = await loadRelationshipContext(relationship.id, { includeCommunity: true });
                const opportunities = computeEngagementOpportunities({
                  relationship,
                  capabilities: relCtx.profile.capabilities,
                  company: relCtx.profile.company,
                  recentMessages: relCtx.recentMessages,
                  certification: relCtx.certification,
                });

                (extendedContext as unknown as Record<string, unknown>).engagement = {
                  opportunities: opportunities.map(o => ({
                    id: o.id,
                    description: o.description,
                    dimension: o.dimension,
                    relevance: o.relevance,
                  })),
                  contact_eligibility: {
                    can_contact: contactEligibility.canContact,
                    reason: contactEligibility.reason,
                    channel: contactEligibility.channel,
                  },
                  relationship_stage: relationship.stage,
                  unreplied_count: relationship.unreplied_outreach_count,
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
        });
      }
    }
  );

  return { pageRouter, apiRouter };
}
