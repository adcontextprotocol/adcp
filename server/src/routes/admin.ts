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
import { setupBrandEnrichmentRoutes } from "./admin/brand-enrichment.js";
import { setupBanRoutes } from "./admin/bans.js";
import { setupGeoRoutes } from "./admin/geo.js";
import { setupRelationshipRoutes } from "./admin/relationships.js";

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
                available_channels: ['slack'],
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
