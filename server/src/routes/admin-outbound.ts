/**
 * Admin routes for Outbound Planner and Rehearsal
 *
 * Routes:
 * - /api/admin/outbound/goals - Manage outreach goals
 * - /api/admin/outbound/outcomes - Manage goal outcomes
 * - /api/admin/outbound/rehearsal - Rehearsal sessions
 * - /api/admin/outbound/plan - Plan preview for users
 */

import { Router } from 'express';
import { createLogger } from '../logger.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { serveHtmlWithConfig } from '../utils/html-config.js';
import * as outboundDb from '../db/outbound-db.js';
import { getOutboundPlanner } from '../addie/services/outbound-planner.js';
import { getRehearsalService } from '../addie/services/rehearsal-service.js';
import { getMemberContext } from '../addie/member-context.js';
import { InsightsDatabase } from '../db/insights-db.js';
import { canContactUser } from '../addie/services/proactive-outreach.js';
import { getMemberCapabilities } from '../db/outbound-db.js';
import type { CreateGoalInput, CreateOutcomeInput, RehearsalPersona, PlannerContext, GoalCategory } from '../addie/types.js';

const logger = createLogger('admin-outbound-routes');

/**
 * Parse and validate an integer ID from request params
 */
function parseIntId(value: string): number | null {
  const id = parseInt(value, 10);
  return isNaN(id) ? null : id;
}

/**
 * Create admin outbound routes
 */
export function createAdminOutboundRouter(): { pageRouter: Router; apiRouter: Router } {
  const pageRouter = Router();
  const apiRouter = Router();

  // =========================================================================
  // ADMIN PAGE ROUTES (mounted at /admin)
  // =========================================================================

  pageRouter.get('/goals', requireAuth, requireAdmin, (req, res) => {
    serveHtmlWithConfig(req, res, 'admin-goals.html').catch((err) => {
      logger.error({ err }, 'Error serving goals page');
      res.status(500).send('Internal server error');
    });
  });

  pageRouter.get('/rehearsal', requireAuth, requireAdmin, (req, res) => {
    serveHtmlWithConfig(req, res, 'admin-rehearsal.html').catch((err) => {
      logger.error({ err }, 'Error serving rehearsal page');
      res.status(500).send('Internal server error');
    });
  });

  // =========================================================================
  // GOALS API
  // =========================================================================

  // GET /api/admin/outbound/goals - List all goals
  apiRouter.get('/goals', requireAuth, requireAdmin, async (req, res) => {
    try {
      const enabledOnly = req.query.enabled === 'true';
      const category = req.query.category as string | undefined;

      const goals = await outboundDb.listGoals({
        enabledOnly,
        category: category as GoalCategory | undefined,
      });

      res.json(goals);
    } catch (err) {
      logger.error({ err }, 'Error listing goals');
      res.status(500).json({ error: 'Failed to list goals' });
    }
  });

  // GET /api/admin/outbound/goals/summary - Get goals with stats
  apiRouter.get('/goals/summary', requireAuth, requireAdmin, async (req, res) => {
    try {
      const summaries = await outboundDb.getGoalSummaries();
      res.json(summaries);
    } catch (err) {
      logger.error({ err }, 'Error getting goal summaries');
      res.status(500).json({ error: 'Failed to get goal summaries' });
    }
  });

  // GET /api/admin/outbound/goals/:id - Get a single goal
  apiRouter.get('/goals/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
      const id = parseIntId(req.params.id);
      if (!id) {
        return res.status(400).json({ error: 'Invalid goal ID' });
      }

      const goal = await outboundDb.getGoal(id);
      if (!goal) {
        return res.status(404).json({ error: 'Goal not found' });
      }

      // Include outcomes
      const outcomes = await outboundDb.listOutcomes(id);

      res.json({ ...goal, outcomes });
    } catch (err) {
      logger.error({ err }, 'Error getting goal');
      res.status(500).json({ error: 'Failed to get goal' });
    }
  });

  // POST /api/admin/outbound/goals - Create a goal
  apiRouter.post('/goals', requireAuth, requireAdmin, async (req, res) => {
    try {
      const input: CreateGoalInput = {
        name: req.body.name,
        category: req.body.category,
        description: req.body.description,
        success_insight_type: req.body.success_insight_type,
        requires_mapped: req.body.requires_mapped,
        requires_company_type: req.body.requires_company_type,
        requires_min_engagement: req.body.requires_min_engagement,
        requires_insights: req.body.requires_insights,
        excludes_insights: req.body.excludes_insights,
        base_priority: req.body.base_priority,
        message_template: req.body.message_template,
        follow_up_on_question: req.body.follow_up_on_question,
        is_enabled: req.body.is_enabled,
        created_by: (req as Express.Request & { user?: { id: string } }).user?.id,
      };

      if (!input.name || !input.category || !input.message_template) {
        return res.status(400).json({ error: 'name, category, and message_template are required' });
      }

      const goal = await outboundDb.createGoal(input);
      logger.info({ goal_id: goal.id, name: goal.name }, 'Goal created');
      res.status(201).json(goal);
    } catch (err) {
      logger.error({ err }, 'Error creating goal');
      res.status(500).json({ error: 'Failed to create goal' });
    }
  });

  // PUT /api/admin/outbound/goals/:id - Update a goal
  apiRouter.put('/goals/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
      const id = parseIntId(req.params.id);
      if (!id) {
        return res.status(400).json({ error: 'Invalid goal ID' });
      }

      const goal = await outboundDb.updateGoal(id, req.body);
      if (!goal) {
        return res.status(404).json({ error: 'Goal not found' });
      }

      logger.info({ goal_id: id }, 'Goal updated');
      res.json(goal);
    } catch (err) {
      logger.error({ err }, 'Error updating goal');
      res.status(500).json({ error: 'Failed to update goal' });
    }
  });

  // DELETE /api/admin/outbound/goals/:id - Delete a goal
  apiRouter.delete('/goals/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
      const id = parseIntId(req.params.id);
      if (!id) {
        return res.status(400).json({ error: 'Invalid goal ID' });
      }

      const deleted = await outboundDb.deleteGoal(id);
      if (!deleted) {
        return res.status(404).json({ error: 'Goal not found' });
      }

      logger.info({ goal_id: id }, 'Goal deleted');
      res.json({ success: true });
    } catch (err) {
      logger.error({ err }, 'Error deleting goal');
      res.status(500).json({ error: 'Failed to delete goal' });
    }
  });

  // =========================================================================
  // OUTCOMES API
  // =========================================================================

  // GET /api/admin/outbound/goals/:id/outcomes - List outcomes for a goal
  apiRouter.get('/goals/:id/outcomes', requireAuth, requireAdmin, async (req, res) => {
    try {
      const id = parseIntId(req.params.id);
      if (!id) {
        return res.status(400).json({ error: 'Invalid goal ID' });
      }

      const outcomes = await outboundDb.listOutcomes(id);
      res.json(outcomes);
    } catch (err) {
      logger.error({ err }, 'Error listing outcomes');
      res.status(500).json({ error: 'Failed to list outcomes' });
    }
  });

  // POST /api/admin/outbound/outcomes - Create an outcome
  apiRouter.post('/outcomes', requireAuth, requireAdmin, async (req, res) => {
    try {
      const input: CreateOutcomeInput = {
        goal_id: req.body.goal_id,
        trigger_type: req.body.trigger_type,
        trigger_value: req.body.trigger_value,
        outcome_type: req.body.outcome_type,
        response_message: req.body.response_message,
        next_goal_id: req.body.next_goal_id,
        defer_days: req.body.defer_days,
        insight_to_record: req.body.insight_to_record,
        insight_value: req.body.insight_value,
        priority: req.body.priority,
      };

      if (!input.goal_id || !input.trigger_type || !input.outcome_type) {
        return res.status(400).json({ error: 'goal_id, trigger_type, and outcome_type are required' });
      }

      const outcome = await outboundDb.createOutcome(input);
      logger.info({ outcome_id: outcome.id, goal_id: input.goal_id }, 'Outcome created');
      res.status(201).json(outcome);
    } catch (err) {
      logger.error({ err }, 'Error creating outcome');
      res.status(500).json({ error: 'Failed to create outcome' });
    }
  });

  // PUT /api/admin/outbound/outcomes/:id - Update an outcome
  apiRouter.put('/outcomes/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
      const id = parseIntId(req.params.id);
      if (!id) {
        return res.status(400).json({ error: 'Invalid outcome ID' });
      }

      const outcome = await outboundDb.updateOutcome(id, req.body);
      if (!outcome) {
        return res.status(404).json({ error: 'Outcome not found' });
      }

      logger.info({ outcome_id: id }, 'Outcome updated');
      res.json(outcome);
    } catch (err) {
      logger.error({ err }, 'Error updating outcome');
      res.status(500).json({ error: 'Failed to update outcome' });
    }
  });

  // DELETE /api/admin/outbound/outcomes/:id - Delete an outcome
  apiRouter.delete('/outcomes/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
      const id = parseIntId(req.params.id);
      if (!id) {
        return res.status(400).json({ error: 'Invalid outcome ID' });
      }

      const deleted = await outboundDb.deleteOutcome(id);
      if (!deleted) {
        return res.status(404).json({ error: 'Outcome not found' });
      }

      logger.info({ outcome_id: id }, 'Outcome deleted');
      res.json({ success: true });
    } catch (err) {
      logger.error({ err }, 'Error deleting outcome');
      res.status(500).json({ error: 'Failed to delete outcome' });
    }
  });

  // =========================================================================
  // REHEARSAL API
  // =========================================================================

  const rehearsalService = getRehearsalService();

  // GET /api/admin/outbound/rehearsal/sessions - List rehearsal sessions
  apiRouter.get('/rehearsal/sessions', requireAuth, requireAdmin, async (req, res) => {
    try {
      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;
      const sessions = await rehearsalService.listSessions({ limit });
      res.json(sessions);
    } catch (err) {
      logger.error({ err }, 'Error listing rehearsal sessions');
      res.status(500).json({ error: 'Failed to list sessions' });
    }
  });

  // GET /api/admin/outbound/rehearsal/sessions/:id - Get a session
  apiRouter.get('/rehearsal/sessions/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
      const id = parseIntId(req.params.id);
      if (!id) {
        return res.status(400).json({ error: 'Invalid session ID' });
      }

      const session = await rehearsalService.getSession(id);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      res.json(session);
    } catch (err) {
      logger.error({ err }, 'Error getting session');
      res.status(500).json({ error: 'Failed to get session' });
    }
  });

  // POST /api/admin/outbound/rehearsal/sessions - Start a new session
  apiRouter.post('/rehearsal/sessions', requireAuth, requireAdmin, async (req, res) => {
    try {
      const user = (req as Express.Request & { user?: { id: string } }).user;
      if (!user?.id) {
        return res.status(401).json({ error: 'User ID required' });
      }

      const persona: RehearsalPersona = req.body.persona ?? {
        name: 'Test User',
        is_mapped: false,
        engagement_score: 50,
      };

      const result = await rehearsalService.startSession({
        admin_user_id: user.id,
        persona,
      });

      logger.info({
        session_id: result.session.id,
        persona_name: persona.name,
        planned_goal: result.planned_action?.goal.name,
      }, 'Rehearsal session started');

      res.status(201).json(result);
    } catch (err) {
      logger.error({ err }, 'Error starting rehearsal session');
      res.status(500).json({ error: 'Failed to start session' });
    }
  });

  // POST /api/admin/outbound/rehearsal/sessions/:id/respond - Simulate a response
  apiRouter.post('/rehearsal/sessions/:id/respond', requireAuth, requireAdmin, async (req, res) => {
    try {
      const id = parseIntId(req.params.id);
      if (!id) {
        return res.status(400).json({ error: 'Invalid session ID' });
      }

      const response = req.body.response;
      if (!response || typeof response !== 'string') {
        return res.status(400).json({ error: 'response is required' });
      }

      const result = await rehearsalService.simulateResponse(id, response);

      logger.info({
        session_id: id,
        sentiment: result.analysis.sentiment,
        intent: result.analysis.intent,
        outcome: result.matched_outcome?.outcome_type,
      }, 'Rehearsal response simulated');

      res.json(result);
    } catch (err) {
      logger.error({ err }, 'Error simulating response');
      res.status(500).json({ error: 'Failed to simulate response' });
    }
  });

  // POST /api/admin/outbound/rehearsal/sessions/:id/complete - Complete a session
  apiRouter.post('/rehearsal/sessions/:id/complete', requireAuth, requireAdmin, async (req, res) => {
    try {
      const id = parseIntId(req.params.id);
      if (!id) {
        return res.status(400).json({ error: 'Invalid session ID' });
      }

      const session = await rehearsalService.completeSession(
        id,
        req.body.notes,
        req.body.outcome_summary
      );

      logger.info({ session_id: id }, 'Rehearsal session completed');
      res.json(session);
    } catch (err) {
      logger.error({ err }, 'Error completing session');
      res.status(500).json({ error: 'Failed to complete session' });
    }
  });

  // POST /api/admin/outbound/rehearsal/sessions/:id/abandon - Abandon a session
  apiRouter.post('/rehearsal/sessions/:id/abandon', requireAuth, requireAdmin, async (req, res) => {
    try {
      const id = parseIntId(req.params.id);
      if (!id) {
        return res.status(400).json({ error: 'Invalid session ID' });
      }

      const session = await rehearsalService.abandonSession(id);

      logger.info({ session_id: id }, 'Rehearsal session abandoned');
      res.json(session);
    } catch (err) {
      logger.error({ err }, 'Error abandoning session');
      res.status(500).json({ error: 'Failed to abandon session' });
    }
  });

  // =========================================================================
  // PLAN PREVIEW API
  // =========================================================================

  // POST /api/admin/outbound/plan/preview - Preview what planner would do for a user
  apiRouter.post('/plan/preview', requireAuth, requireAdmin, async (req, res) => {
    try {
      const slackUserId = req.body.slack_user_id;
      if (!slackUserId) {
        return res.status(400).json({ error: 'slack_user_id is required' });
      }

      const planner = getOutboundPlanner();
      const insightsDb = new InsightsDatabase();

      // Build context
      const memberContext = await getMemberContext(slackUserId);
      const insights = await insightsDb.getInsightsForUser(slackUserId);
      const history = await outboundDb.getUserGoalHistory(slackUserId);
      const contactEligibility = await canContactUser(slackUserId);

      const ctx: PlannerContext = {
        user: {
          slack_user_id: slackUserId,
          workos_user_id: memberContext?.workos_user?.workos_user_id,
          display_name: memberContext?.slack_user?.display_name ?? undefined,
          is_mapped: !!memberContext?.is_mapped,
          engagement_score: 0, // Could compute from activity later
          insights: insights.map(i => ({
            type: i.insight_type_name ?? 'unknown',
            value: i.value,
            confidence: i.confidence,
          })),
        },
        company: memberContext?.organization ? {
          name: memberContext.organization.name,
          type: 'unknown', // Would need to look up company_type from organization
        } : undefined,
        history,
        contact_eligibility: {
          can_contact: contactEligibility.canContact,
          reason: contactEligibility.reason ?? 'Eligible',
        },
      };

      const planned = await planner.planNextAction(ctx);

      if (!planned) {
        return res.json({
          can_contact: contactEligibility.canContact,
          contact_reason: contactEligibility.reason,
          planned_action: null,
          message_preview: null,
          context: ctx,
        });
      }

      const linkUrl = `https://agenticadvertising.org/auth/login?slack_user_id=${encodeURIComponent(slackUserId)}`;
      const messagePreview = planner.buildMessage(planned.goal, ctx, linkUrl);

      res.json({
        can_contact: contactEligibility.canContact,
        contact_reason: contactEligibility.reason,
        planned_action: planned,
        message_preview: messagePreview,
        context: ctx,
      });
    } catch (err) {
      logger.error({ err }, 'Error previewing plan');
      res.status(500).json({ error: 'Failed to preview plan' });
    }
  });

  // GET /api/admin/outbound/history/:slackUserId - Get goal history for a user
  apiRouter.get('/history/:slackUserId', requireAuth, requireAdmin, async (req, res) => {
    try {
      const history = await outboundDb.getUserGoalHistory(req.params.slackUserId);
      res.json(history);
    } catch (err) {
      logger.error({ err }, 'Error getting user goal history');
      res.status(500).json({ error: 'Failed to get history' });
    }
  });

  // =========================================================================
  // MEMBER DETAIL API - Live view of member's capabilities and planner state
  // =========================================================================

  // GET /api/admin/outbound/member/:slackUserId - Full member detail with capabilities
  apiRouter.get('/member/:slackUserId', requireAuth, requireAdmin, async (req, res) => {
    try {
      const slackUserId = req.params.slackUserId;
      const planner = getOutboundPlanner();
      const insightsDb = new InsightsDatabase();

      // Fetch member context first to get workosUserId for capabilities
      const memberContext = await getMemberContext(slackUserId);
      const workosUserId = memberContext?.workos_user?.workos_user_id;

      // Fetch remaining data in parallel
      const [insights, history, contactEligibility, capabilities] = await Promise.all([
        insightsDb.getInsightsForUser(slackUserId),
        outboundDb.getUserGoalHistory(slackUserId),
        canContactUser(slackUserId),
        getMemberCapabilities(slackUserId, workosUserId),
      ]);

      // Build context for planner
      const ctx: PlannerContext = {
        user: {
          slack_user_id: slackUserId,
          workos_user_id: workosUserId,
          display_name: memberContext?.slack_user?.display_name ?? undefined,
          is_mapped: !!memberContext?.is_mapped,
          engagement_score: capabilities.slack_message_count_30d > 10 ? 75 :
                            capabilities.slack_message_count_30d > 5 ? 50 :
                            capabilities.slack_message_count_30d > 0 ? 25 : 0,
          insights: insights.map(i => ({
            type: i.insight_type_name ?? 'unknown',
            value: i.value,
            confidence: i.confidence,
          })),
        },
        company: memberContext?.organization ? {
          name: memberContext.organization.name,
          type: 'unknown',
        } : undefined,
        capabilities,
        history,
        contact_eligibility: {
          can_contact: contactEligibility.canContact,
          reason: contactEligibility.reason ?? 'Eligible',
        },
      };

      // Get planner's recommendation
      const planned = await planner.planNextAction(ctx);

      // Build message preview if there's a plan
      let messagePreview: string | null = null;
      if (planned) {
        const linkUrl = `https://agenticadvertising.org/auth/login?slack_user_id=${encodeURIComponent(slackUserId)}`;
        messagePreview = planner.buildMessage(planned.goal, ctx, linkUrl);
      }

      // Format capability summary for display
      const capabilitySummary = {
        account: {
          linked: capabilities.account_linked,
          profile_complete: capabilities.profile_complete,
          offerings_set: capabilities.offerings_set,
          email_prefs_configured: capabilities.email_prefs_configured,
        },
        team: {
          has_team_members: capabilities.has_team_members,
          is_org_admin: capabilities.is_org_admin,
        },
        participation: {
          working_groups: capabilities.working_group_count,
          councils: capabilities.council_count,
          events_registered: capabilities.events_registered,
          events_attended: capabilities.events_attended,
          is_committee_leader: capabilities.is_committee_leader,
        },
        engagement: {
          last_active_days_ago: capabilities.last_active_days_ago,
          slack_messages_30d: capabilities.slack_message_count_30d,
        },
      };

      // Return comprehensive member view
      res.json({
        member: {
          slack_user_id: slackUserId,
          display_name: memberContext?.slack_user?.display_name,
          email: memberContext?.slack_user?.email,
          is_mapped: !!memberContext?.is_mapped,
          workos_user_id: workosUserId,
          organization: memberContext?.organization ? {
            workos_organization_id: memberContext.organization.workos_organization_id,
            name: memberContext.organization.name,
          } : null,
        },
        capabilities: capabilitySummary,
        capabilities_raw: capabilities,
        insights: insights.map(i => ({
          type: i.insight_type_name,
          value: i.value,
          confidence: i.confidence,
          source_type: i.source_type,
          created_at: i.created_at,
        })),
        contact_eligibility: {
          can_contact: contactEligibility.canContact,
          reason: contactEligibility.reason,
        },
        planner: {
          recommended_action: planned ? {
            goal_id: planned.goal.id,
            goal_name: planned.goal.name,
            category: planned.goal.category,
            reason: planned.reason,
            priority_score: planned.priority_score,
            decision_method: planned.decision_method,
          } : null,
          message_preview: messagePreview,
          alternative_goals: planned?.alternative_goals.map(g => ({
            id: g.id,
            name: g.name,
            category: g.category,
          })) ?? [],
        },
        history: history.map(h => ({
          goal_id: h.goal_id,
          status: h.status,
          attempt_count: h.attempt_count,
          last_attempt_at: h.last_attempt_at,
          next_attempt_at: h.next_attempt_at,
          outcome_id: h.outcome_id,
          response_sentiment: h.response_sentiment,
          response_intent: h.response_intent,
          planner_reason: h.planner_reason,
          decision_method: h.decision_method,
        })),
      });
    } catch (err) {
      logger.error({ err }, 'Error getting member detail');
      res.status(500).json({ error: 'Failed to get member detail' });
    }
  });

  return { pageRouter, apiRouter };
}
