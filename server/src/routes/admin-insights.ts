/**
 * Admin routes for Member Insights and Proactive Engagement
 *
 * Routes:
 * - /api/admin/insight-types - Manage insight taxonomy
 * - /api/admin/insights - View and manage member insights
 * - /api/admin/outreach - Proactive outreach management
 */

import { Router } from 'express';
import { createLogger } from '../logger.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { serveHtmlWithConfig } from '../utils/html-config.js';
import { InsightsDatabase } from '../db/insights-db.js';
import { getPool } from '../db/client.js';
import {
  runOutreachScheduler,
  manualOutreach,
  manualOutreachWithGoal,
  getOutreachMode,
  canContactUser,
} from '../addie/services/proactive-outreach.js';
import { invalidateInsightsCache } from '../addie/insights-cache.js';
import {
  getActionItems,
  getOpenActionItems,
  getActionItemStats,
  completeActionItem,
  dismissActionItem,
  snoozeActionItem,
  createActionItem,
  getMyAccounts,
  assignUserStakeholder,
  removeUserStakeholder,
  getUserStakeholders,
  type ActionType,
  type ActionPriority,
} from '../db/account-management-db.js';
import { runMomentumCheck, dryRunMomentumCheck, previewMomentumForUser } from '../addie/jobs/momentum-check.js';
import { runTaskReminderJob, previewTaskReminders } from '../addie/jobs/task-reminder.js';
import { runGoalFollowUpJob, previewFollowUps, previewReconciliation } from '../addie/jobs/goal-follow-up.js';

const logger = createLogger('admin-insights-routes');
const insightsDb = new InsightsDatabase();

/**
 * Parse and validate an integer ID from request params
 * Returns the parsed ID or null if invalid
 */
function parseIntId(value: string): number | null {
  const id = parseInt(value, 10);
  return isNaN(id) ? null : id;
}

/**
 * Create admin insights routes
 */
export function createAdminInsightsRouter(): { pageRouter: Router; apiRouter: Router } {
  const pageRouter = Router();
  const apiRouter = Router();

  // =========================================================================
  // ADMIN PAGE ROUTES (mounted at /admin)
  // =========================================================================

  pageRouter.get('/insight-types', requireAuth, requireAdmin, (req, res) => {
    serveHtmlWithConfig(req, res, 'admin-insight-types.html').catch((err) => {
      logger.error({ err }, 'Error serving insight types page');
      res.status(500).send('Internal server error');
    });
  });

  pageRouter.get('/insights', requireAuth, requireAdmin, (req, res) => {
    serveHtmlWithConfig(req, res, 'admin-insights.html').catch((err) => {
      logger.error({ err }, 'Error serving insights page');
      res.status(500).send('Internal server error');
    });
  });

  pageRouter.get('/outreach', requireAuth, requireAdmin, (req, res) => {
    serveHtmlWithConfig(req, res, 'admin-outreach.html').catch((err) => {
      logger.error({ err }, 'Error serving outreach page');
      res.status(500).send('Internal server error');
    });
  });

  // =========================================================================
  // INSIGHT TYPES API
  // =========================================================================

  // GET /api/admin/goal-types - List Addie goal types (for contacts/users filtering)
  apiRouter.get('/goal-types', requireAuth, requireAdmin, async (req, res) => {
    try {
      const pool = getPool();
      const result = await pool.query(`
        SELECT goal_key, name, description, priority
        FROM addie_goal_types
        WHERE is_active = TRUE
        ORDER BY priority DESC
      `);
      res.json(result.rows);
    } catch (error) {
      logger.error({ err: error }, 'Error listing goal types');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/admin/insight-types - List all insight types
  apiRouter.get('/insight-types', requireAuth, requireAdmin, async (req, res) => {
    try {
      const activeOnly = req.query.activeOnly === 'true';
      const types = await insightsDb.listInsightTypes(activeOnly);
      res.json(types);
    } catch (error) {
      logger.error({ err: error }, 'Error listing insight types');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/admin/insight-types/:id - Get single insight type
  apiRouter.get('/insight-types/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
      const id = parseIntId(req.params.id);
      if (id === null) {
        return res.status(400).json({ error: 'Invalid ID format' });
      }

      const type = await insightsDb.getInsightType(id);
      if (!type) {
        return res.status(404).json({ error: 'Insight type not found' });
      }
      res.json(type);
    } catch (error) {
      logger.error({ err: error }, 'Error getting insight type');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /api/admin/insight-types - Create insight type
  apiRouter.post('/insight-types', requireAuth, requireAdmin, async (req, res) => {
    try {
      const { name, description, example_values, is_active } = req.body;

      if (!name) {
        return res.status(400).json({ error: 'Name is required' });
      }

      const type = await insightsDb.createInsightType({
        name,
        description,
        example_values,
        is_active,
        created_by: req.user?.id,
      });

      logger.info({ typeId: type.id, name }, 'Created insight type');
      res.status(201).json(type);
    } catch (error) {
      if ((error as any)?.code === '23505') {
        return res.status(409).json({ error: 'An insight type with that name already exists' });
      }
      logger.error({ err: error }, 'Error creating insight type');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // PUT /api/admin/insight-types/:id - Update insight type
  apiRouter.put('/insight-types/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
      const id = parseIntId(req.params.id);
      if (id === null) {
        return res.status(400).json({ error: 'Invalid ID format' });
      }

      const { name, description, example_values, is_active } = req.body;
      const type = await insightsDb.updateInsightType(id, {
        name,
        description,
        example_values,
        is_active,
      });

      if (!type) {
        return res.status(404).json({ error: 'Insight type not found' });
      }

      logger.info({ typeId: type.id }, 'Updated insight type');
      res.json(type);
    } catch (error) {
      logger.error({ err: error }, 'Error updating insight type');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // DELETE /api/admin/insight-types/:id - Delete (deactivate) insight type
  apiRouter.delete('/insight-types/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
      const id = parseIntId(req.params.id);
      if (id === null) {
        return res.status(400).json({ error: 'Invalid ID format' });
      }

      const deleted = await insightsDb.deleteInsightType(id);
      if (!deleted) {
        return res.status(404).json({ error: 'Insight type not found' });
      }

      logger.info({ typeId: id }, 'Deleted insight type');
      res.json({ success: true });
    } catch (error) {
      logger.error({ err: error }, 'Error deleting insight type');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // =========================================================================
  // MEMBER INSIGHTS API
  // =========================================================================

  // GET /api/admin/insights - List member insight summaries
  apiRouter.get('/insights', requireAuth, requireAdmin, async (req, res) => {
    try {
      const { search, hasInsights, limit, offset } = req.query;
      const summaries = await insightsDb.getMemberInsightSummaries({
        search: search as string,
        hasInsights: hasInsights === 'true' ? true : hasInsights === 'false' ? false : undefined,
        limit: limit ? parseInt(limit as string, 10) : undefined,
        offset: offset ? parseInt(offset as string, 10) : undefined,
      });
      res.json(summaries);
    } catch (error) {
      logger.error({ err: error }, 'Error listing member insights');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/admin/insights/members - List member insight summaries (alias)
  apiRouter.get('/insights/members', requireAuth, requireAdmin, async (req, res) => {
    try {
      const { search, hasInsights, limit, offset } = req.query;
      const summaries = await insightsDb.getMemberInsightSummaries({
        search: search as string,
        hasInsights: hasInsights === 'true' ? true : hasInsights === 'false' ? false : undefined,
        limit: limit ? parseInt(limit as string, 10) : undefined,
        offset: offset ? parseInt(offset as string, 10) : undefined,
      });
      res.json(summaries);
    } catch (error) {
      logger.error({ err: error }, 'Error listing member insights');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/admin/insights/stats - Get insight statistics
  apiRouter.get('/insights/stats', requireAuth, requireAdmin, async (req, res) => {
    try {
      const stats = await insightsDb.getInsightStats();
      res.json(stats);
    } catch (error) {
      logger.error({ err: error }, 'Error getting insight stats');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/admin/insights/user/:slackUserId - Get insights for a specific user
  apiRouter.get('/insights/user/:slackUserId', requireAuth, requireAdmin, async (req, res) => {
    try {
      const insights = await insightsDb.getInsightsForUser(req.params.slackUserId);
      res.json(insights);
    } catch (error) {
      logger.error({ err: error }, 'Error getting user insights');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // =========================================================================
  // UNIFIED PERSON VIEW API
  // =========================================================================
  // These endpoints join insights from both Slack and email channels via workos_user_id

  // GET /api/admin/insights/unified/slack/:slackUserId - Get unified view by Slack user ID
  apiRouter.get('/insights/unified/slack/:slackUserId', requireAuth, requireAdmin, async (req, res) => {
    try {
      const unified = await insightsDb.getUnifiedInsightsBySlackUser(req.params.slackUserId);
      res.json(unified);
    } catch (error) {
      logger.error({ err: error }, 'Error getting unified insights by Slack user');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/admin/insights/unified/workos/:workosUserId - Get unified view by WorkOS user ID
  apiRouter.get('/insights/unified/workos/:workosUserId', requireAuth, requireAdmin, async (req, res) => {
    try {
      const unified = await insightsDb.getUnifiedInsightsByWorkosUser(req.params.workosUserId);
      if (!unified) {
        return res.status(404).json({ error: 'User not found' });
      }
      res.json(unified);
    } catch (error) {
      logger.error({ err: error }, 'Error getting unified insights by WorkOS user');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/admin/insights/unified/email/:email - Get unified view by email address
  apiRouter.get('/insights/unified/email/:email', requireAuth, requireAdmin, async (req, res) => {
    try {
      const email = req.params.email;
      // Basic email format validation
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email)) {
        return res.status(400).json({ error: 'Invalid email format' });
      }

      const unified = await insightsDb.getUnifiedInsightsByEmail(email);
      if (!unified) {
        return res.status(404).json({ error: 'Contact not found' });
      }
      res.json(unified);
    } catch (error) {
      logger.error({ err: error }, 'Error getting unified insights by email');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /api/admin/insights - Add manual insight
  apiRouter.post('/insights', requireAuth, requireAdmin, async (req, res) => {
    try {
      const {
        slack_user_id,
        workos_user_id,
        insight_type_id,
        value,
        confidence,
      } = req.body;

      if (!slack_user_id || !insight_type_id || !value) {
        return res.status(400).json({ error: 'slack_user_id, insight_type_id, and value are required' });
      }

      const insight = await insightsDb.addInsight({
        slack_user_id,
        workos_user_id,
        insight_type_id,
        value,
        confidence,
        source_type: 'manual',
        created_by: req.user?.id,
      });

      // Invalidate cache so routing uses fresh insights
      invalidateInsightsCache(slack_user_id);

      logger.info({ insightId: insight.id, slackUserId: slack_user_id }, 'Added manual insight');
      res.status(201).json(insight);
    } catch (error) {
      logger.error({ err: error }, 'Error adding insight');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // DELETE /api/admin/insights/:id - Delete an insight
  apiRouter.delete('/insights/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
      const id = parseIntId(req.params.id);
      if (id === null) {
        return res.status(400).json({ error: 'Invalid ID format' });
      }

      const deleted = await insightsDb.deleteInsight(id);
      if (!deleted) {
        return res.status(404).json({ error: 'Insight not found' });
      }

      logger.info({ insightId: id }, 'Deleted insight');
      res.json({ success: true });
    } catch (error) {
      logger.error({ err: error }, 'Error deleting insight');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // =========================================================================
  // OUTREACH STATS & HISTORY API
  // =========================================================================

  // GET /api/admin/outreach/stats - Get outreach statistics
  apiRouter.get('/outreach/stats', requireAuth, requireAdmin, async (req, res) => {
    try {
      const stats = await insightsDb.getOutreachStats();
      res.json(stats);
    } catch (error) {
      logger.error({ err: error }, 'Error getting outreach stats');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/admin/outreach/stats/by-goal - Get response rates by goal type
  apiRouter.get('/outreach/stats/by-goal', requireAuth, requireAdmin, async (req, res) => {
    try {
      const stats = await insightsDb.getOutreachGoalStats();
      res.json(stats);
    } catch (error) {
      logger.error({ err: error }, 'Error getting outreach goal stats');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/admin/outreach/stats/time-series - Get time-windowed outreach stats
  apiRouter.get('/outreach/stats/time-series', requireAuth, requireAdmin, async (req, res) => {
    try {
      const stats = await insightsDb.getOutreachTimeStats();
      res.json(stats);
    } catch (error) {
      logger.error({ err: error }, 'Error getting outreach time stats');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/admin/outreach/history - Get recent outreach history
  apiRouter.get('/outreach/history', requireAuth, requireAdmin, async (req, res) => {
    try {
      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;
      const history = await insightsDb.getRecentOutreach(limit);
      res.json(history);
    } catch (error) {
      logger.error({ err: error }, 'Error getting outreach history');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // =========================================================================
  // TEST ACCOUNTS API
  // =========================================================================

  // GET /api/admin/outreach/test-accounts - List test accounts
  apiRouter.get('/outreach/test-accounts', requireAuth, requireAdmin, async (req, res) => {
    try {
      const accounts = await insightsDb.listTestAccounts();
      res.json(accounts);
    } catch (error) {
      logger.error({ err: error }, 'Error listing test accounts');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /api/admin/outreach/test-accounts - Add test account
  apiRouter.post('/outreach/test-accounts', requireAuth, requireAdmin, async (req, res) => {
    try {
      const { slack_user_id, description } = req.body;

      if (!slack_user_id) {
        return res.status(400).json({ error: 'slack_user_id is required' });
      }

      const account = await insightsDb.addTestAccount(slack_user_id, description);
      logger.info({ slackUserId: slack_user_id }, 'Added test account');
      res.status(201).json(account);
    } catch (error) {
      logger.error({ err: error }, 'Error adding test account');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // DELETE /api/admin/outreach/test-accounts/:slackUserId - Remove test account
  apiRouter.delete('/outreach/test-accounts/:slackUserId', requireAuth, requireAdmin, async (req, res) => {
    try {
      const removed = await insightsDb.removeTestAccount(req.params.slackUserId);
      if (!removed) {
        return res.status(404).json({ error: 'Test account not found' });
      }

      logger.info({ slackUserId: req.params.slackUserId }, 'Removed test account');
      res.json({ success: true });
    } catch (error) {
      logger.error({ err: error }, 'Error removing test account');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // =========================================================================
  // OUTREACH CONTROL API
  // =========================================================================

  // GET /api/admin/outreach/mode - Get current outreach mode
  apiRouter.get('/outreach/mode', requireAuth, requireAdmin, (req, res) => {
    res.json({ mode: getOutreachMode() });
  });

  // POST /api/admin/outreach/run - Manually trigger outreach scheduler
  apiRouter.post('/outreach/run', requireAuth, requireAdmin, async (req, res) => {
    try {
      const { limit, forceRun } = req.body;
      const result = await runOutreachScheduler({
        limit: limit ?? 5,
        forceRun: forceRun ?? true,
      });

      logger.info({ result, triggeredBy: req.user?.id }, 'Manual outreach run triggered');
      res.json(result);
    } catch (error) {
      logger.error({ err: error }, 'Error running outreach scheduler');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /api/admin/outreach/send/:slackUserId - Send outreach to specific user
  apiRouter.post('/outreach/send/:slackUserId', requireAuth, requireAdmin, async (req, res) => {
    try {
      const { slackUserId } = req.params;

      // Check if user can be contacted
      const eligibility = await canContactUser(slackUserId);
      if (!eligibility.canContact) {
        return res.status(400).json({ error: eligibility.reason });
      }

      // Pass admin info for auto-assignment
      const triggeredBy = req.user ? {
        id: req.user.id,
        name: `${req.user.firstName || ''} ${req.user.lastName || ''}`.trim() || req.user.email,
        email: req.user.email,
      } : undefined;

      const result = await manualOutreach(slackUserId, triggeredBy);

      if (result.success) {
        logger.info({ slackUserId, triggeredBy: req.user?.id }, 'Manual outreach sent');
        res.json(result);
      } else {
        res.status(400).json({ error: result.error });
      }
    } catch (error) {
      logger.error({ err: error }, 'Error sending manual outreach');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /api/admin/outreach/send-with-goal - Send outreach with a specific goal (admin override)
  apiRouter.post('/outreach/send-with-goal', requireAuth, requireAdmin, async (req, res) => {
    try {
      const { slack_user_id, goal_id, admin_context } = req.body;

      // Validate inputs
      const goalIdNum = parseInt(goal_id, 10);
      if (!slack_user_id || isNaN(goalIdNum) || goalIdNum <= 0) {
        return res.status(400).json({ error: 'Valid slack_user_id and goal_id are required' });
      }

      // Check if user can be contacted
      const eligibility = await canContactUser(slack_user_id);
      if (!eligibility.canContact) {
        return res.status(400).json({ error: eligibility.reason });
      }

      // Pass admin info for auto-assignment
      const triggeredBy = req.user ? {
        id: req.user.id,
        name: `${req.user.firstName || ''} ${req.user.lastName || ''}`.trim() || req.user.email,
        email: req.user.email,
      } : undefined;

      const result = await manualOutreachWithGoal(
        slack_user_id,
        goalIdNum,
        admin_context,
        triggeredBy
      );

      if (result.success) {
        logger.info({
          slackUserId: slack_user_id,
          goalId: goal_id,
          hasContext: !!admin_context,
          triggeredBy: req.user?.id,
        }, 'Admin-override outreach sent');
        res.json(result);
      } else {
        res.status(400).json({ error: result.error });
      }
    } catch (error) {
      logger.error({ err: error }, 'Error sending admin-override outreach');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/admin/outreach/check/:slackUserId - Check if user can be contacted
  apiRouter.get('/outreach/check/:slackUserId', requireAuth, requireAdmin, async (req, res) => {
    try {
      const eligibility = await canContactUser(req.params.slackUserId);
      res.json(eligibility);
    } catch (error) {
      logger.error({ err: error }, 'Error checking outreach eligibility');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/admin/outreach/preview/:slackUserId - Preview what outreach message would be sent
  apiRouter.get('/outreach/preview/:slackUserId', requireAuth, requireAdmin, async (req, res) => {
    try {
      const { slackUserId } = req.params;
      const pool = getPool();

      // Get user info with goal from unified_contacts view
      const userResult = await pool.query(`
        SELECT
          sm.*,
          uc.goal_key,
          uc.goal_name,
          uc.goal_reasoning
        FROM slack_user_mappings sm
        LEFT JOIN unified_contacts_with_goals uc ON uc.slack_user_id = sm.slack_user_id
        WHERE sm.slack_user_id = $1
      `, [slackUserId]);

      if (userResult.rows.length === 0) {
        return res.status(404).json({ error: 'User not found' });
      }

      const user = userResult.rows[0];
      const goalKey = user.goal_key;

      // Map goal_key to outreach_type
      let outreachType: string;
      if (goalKey === 'link_account') {
        outreachType = 'account_link';
      } else if (!user.last_outreach_at && !user.workos_user_id) {
        outreachType = 'introduction';
      } else {
        outreachType = goalKey || 'insight_goal';
      }

      // Get the goal and its message template
      const goalResult = await pool.query(`
        SELECT id, name, description, message_template, category
        FROM outreach_goals
        WHERE is_enabled = TRUE
        ORDER BY base_priority DESC
        LIMIT 1
      `);

      const goal = goalResult.rows[0];

      // Build preview message from goal template
      const userName = user.slack_display_name || user.slack_real_name || 'there';
      const linkUrl = `https://agenticadvertising.org/auth/login?slack_user_id=${encodeURIComponent(slackUserId)}`;
      let previewMessage = goal?.message_template || '[No active outreach goal configured]';
      previewMessage = previewMessage.replace(/\{\{user_name\}\}/g, userName);
      previewMessage = previewMessage.replace(/\{\{link_url\}\}/g, linkUrl);

      // Check eligibility
      const eligibility = await canContactUser(slackUserId);

      res.json({
        user: {
          slack_user_id: user.slack_user_id,
          slack_display_name: user.slack_display_name,
          slack_real_name: user.slack_real_name,
          workos_user_id: user.workos_user_id,
          last_outreach_at: user.last_outreach_at,
        },
        outreach_type: outreachType,
        addie_goal: {
          goal_key: user.goal_key,
          goal_name: user.goal_name,
          reasoning: user.goal_reasoning,
        },
        goal: goal ? {
          id: goal.id,
          name: goal.name,
          category: goal.category,
        } : null,
        preview_message: previewMessage,
        eligibility,
        mode: getOutreachMode(),
      });
    } catch (error) {
      logger.error({ err: error }, 'Error previewing outreach');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // =========================================================================
  // GOAL FOLLOW-UP ROUTES
  // =========================================================================

  // GET /api/admin/outreach/follow-ups/preview - Preview pending follow-ups
  apiRouter.get('/outreach/follow-ups/preview', requireAuth, requireAdmin, async (req, res) => {
    try {
      const pending = await previewFollowUps();
      res.json({ pending, count: pending.length });
    } catch (error) {
      logger.error({ err: error }, 'Error previewing follow-ups');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/admin/outreach/reconciliation/preview - Preview goals that could be reconciled
  apiRouter.get('/outreach/reconciliation/preview', requireAuth, requireAdmin, async (req, res) => {
    try {
      const goals = await previewReconciliation();
      res.json({ goals, count: goals.length });
    } catch (error) {
      logger.error({ err: error }, 'Error previewing reconciliation');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /api/admin/outreach/follow-ups/run - Run the follow-up job
  apiRouter.post('/outreach/follow-ups/run', requireAuth, requireAdmin, async (req, res) => {
    try {
      const { dryRun, skipFollowUps, skipReconciliation } = req.body;
      const result = await runGoalFollowUpJob({
        dryRun: dryRun ?? false,
        skipFollowUps: skipFollowUps ?? false,
        skipReconciliation: skipReconciliation ?? false,
      });

      logger.info({ result, triggeredBy: req.user?.id, dryRun }, 'Goal follow-up job triggered');
      res.json(result);
    } catch (error) {
      logger.error({ err: error }, 'Error running follow-up job');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/admin/outreach/timeline/:slackUserId - Get outreach timeline for a user
  apiRouter.get('/outreach/timeline/:slackUserId', requireAuth, requireAdmin, async (req, res) => {
    try {
      const { slackUserId } = req.params;

      // Validate Slack user ID format (starts with U or W, followed by alphanumeric)
      if (!/^[UW][A-Z0-9]+$/i.test(slackUserId)) {
        return res.status(400).json({ error: 'Invalid Slack user ID format' });
      }

      const pool = getPool();

      // Get all outreach events for this user with full details
      const result = await pool.query(`
        SELECT
          mo.id,
          mo.sent_at,
          mo.outreach_type,
          mo.initial_message,
          mo.user_responded,
          mo.response_received_at,
          mo.response_text,
          mo.response_sentiment,
          mo.response_intent,
          mo.insight_extracted,
          -- Goal info from user_goal_history if linked
          ugh.goal_id,
          og.name as goal_name,
          og.category as goal_category,
          ugh.status as goal_status,
          ugh.attempt_count
        FROM member_outreach mo
        LEFT JOIN user_goal_history ugh ON ugh.outreach_id = mo.id
        LEFT JOIN outreach_goals og ON og.id = ugh.goal_id
        WHERE mo.slack_user_id = $1
        ORDER BY mo.sent_at DESC
        LIMIT 50
      `, [slackUserId]);

      // Get user info
      const userResult = await pool.query(`
        SELECT
          slack_user_id,
          slack_display_name,
          slack_real_name,
          slack_email,
          workos_user_id,
          last_outreach_at,
          outreach_opt_out
        FROM slack_user_mappings
        WHERE slack_user_id = $1
      `, [slackUserId]);

      res.json({
        user: userResult.rows[0] || null,
        timeline: result.rows.map(row => ({
          id: row.id,
          sent_at: row.sent_at,
          outreach_type: row.outreach_type,
          message_preview: row.initial_message?.substring(0, 200) + (row.initial_message?.length > 200 ? '...' : ''),
          response: row.user_responded ? {
            received_at: row.response_received_at,
            text: row.response_text,
            sentiment: row.response_sentiment,
            intent: row.response_intent,
            insight_extracted: row.insight_extracted,
          } : null,
          goal: row.goal_id ? {
            id: row.goal_id,
            name: row.goal_name,
            category: row.goal_category,
            status: row.goal_status,
            attempt_count: row.attempt_count,
          } : null,
        })),
      });
    } catch (error) {
      logger.error({ err: error }, 'Error fetching outreach timeline');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // =========================================================================
  // ACTION ITEMS API ROUTES
  // =========================================================================

  // GET /api/admin/action-items - Get action items with filters
  apiRouter.get('/action-items', requireAuth, requireAdmin, async (req, res) => {
    try {
      const {
        assigned_to,
        slack_user_id,
        workos_user_id,
        org_id,
        status,
        action_type,
        priority,
        limit,
        offset,
      } = req.query;

      const items = await getActionItems({
        assignedTo: assigned_to as string,
        slackUserId: slack_user_id as string,
        workosUserId: workos_user_id as string,
        orgId: org_id as string,
        status: status as 'open' | 'snoozed' | 'completed' | 'dismissed',
        actionType: action_type as ActionType,
        priority: priority as ActionPriority,
        limit: limit ? parseInt(limit as string, 10) : undefined,
        offset: offset ? parseInt(offset as string, 10) : undefined,
      });

      res.json({ items });
    } catch (error) {
      logger.error({ err: error }, 'Error fetching action items');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/admin/action-items/mine - Get my action items
  apiRouter.get('/action-items/mine', requireAuth, requireAdmin, async (req, res) => {
    try {
      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 20;
      const items = await getOpenActionItems(req.user?.id, limit);
      const stats = await getActionItemStats(req.user?.id);

      res.json({ items, stats });
    } catch (error) {
      logger.error({ err: error }, 'Error fetching my action items');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/admin/action-items/stats - Get action item statistics
  apiRouter.get('/action-items/stats', requireAuth, requireAdmin, async (req, res) => {
    try {
      const assignedTo = req.query.assigned_to as string | undefined;
      const stats = await getActionItemStats(assignedTo);
      res.json(stats);
    } catch (error) {
      logger.error({ err: error }, 'Error fetching action item stats');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /api/admin/action-items - Create an action item
  apiRouter.post('/action-items', requireAuth, requireAdmin, async (req, res) => {
    try {
      const {
        slack_user_id,
        workos_user_id,
        org_id,
        assigned_to,
        action_type,
        priority,
        title,
        description,
        context,
      } = req.body;

      if (!action_type || !title) {
        return res.status(400).json({ error: 'action_type and title are required' });
      }

      const item = await createActionItem({
        slackUserId: slack_user_id,
        workosUserId: workos_user_id,
        orgId: org_id,
        assignedTo: assigned_to || req.user?.id,
        actionType: action_type,
        priority: priority || 'medium',
        title,
        description,
        context,
        triggerType: 'manual',
        triggerId: `manual-${Date.now()}`,
      });

      res.json(item);
    } catch (error) {
      logger.error({ err: error }, 'Error creating action item');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /api/admin/action-items/:id/complete - Complete an action item
  apiRouter.post('/action-items/:id/complete', requireAuth, requireAdmin, async (req, res) => {
    try {
      const id = parseIntId(req.params.id);
      if (id === null) {
        return res.status(400).json({ error: 'Invalid action item ID' });
      }

      if (!req.user?.id) {
        return res.status(401).json({ error: 'User ID not available' });
      }

      const { resolution_note } = req.body;
      const item = await completeActionItem(id, req.user.id, resolution_note);

      if (!item) {
        return res.status(404).json({ error: 'Action item not found' });
      }

      res.json(item);
    } catch (error) {
      logger.error({ err: error }, 'Error completing action item');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /api/admin/action-items/:id/dismiss - Dismiss an action item
  apiRouter.post('/action-items/:id/dismiss', requireAuth, requireAdmin, async (req, res) => {
    try {
      const id = parseIntId(req.params.id);
      if (id === null) {
        return res.status(400).json({ error: 'Invalid action item ID' });
      }

      if (!req.user?.id) {
        return res.status(401).json({ error: 'User ID not available' });
      }

      const { resolution_note } = req.body;
      const item = await dismissActionItem(id, req.user.id, resolution_note);

      if (!item) {
        return res.status(404).json({ error: 'Action item not found' });
      }

      res.json(item);
    } catch (error) {
      logger.error({ err: error }, 'Error dismissing action item');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /api/admin/action-items/:id/snooze - Snooze an action item
  apiRouter.post('/action-items/:id/snooze', requireAuth, requireAdmin, async (req, res) => {
    try {
      const id = parseIntId(req.params.id);
      if (id === null) {
        return res.status(400).json({ error: 'Invalid action item ID' });
      }

      const { until } = req.body;
      if (!until) {
        return res.status(400).json({ error: 'until date is required' });
      }

      const parsedDate = new Date(until);
      if (isNaN(parsedDate.getTime())) {
        return res.status(400).json({ error: 'Invalid date format for until' });
      }

      const item = await snoozeActionItem(id, parsedDate);

      if (!item) {
        return res.status(404).json({ error: 'Action item not found' });
      }

      res.json(item);
    } catch (error) {
      logger.error({ err: error }, 'Error snoozing action item');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /api/admin/action-items/check-momentum - Run momentum check job
  apiRouter.post('/action-items/check-momentum', requireAuth, requireAdmin, async (req, res) => {
    try {
      const result = await runMomentumCheck();
      res.json(result);
    } catch (error) {
      logger.error({ err: error }, 'Error running momentum check');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/admin/action-items/check-momentum/dry-run - Preview what momentum check would do
  apiRouter.get('/action-items/check-momentum/dry-run', requireAuth, requireAdmin, async (req, res) => {
    try {
      const result = await dryRunMomentumCheck();
      res.json(result);
    } catch (error) {
      logger.error({ err: error }, 'Error running momentum check dry-run');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/admin/action-items/preview/:slackUserId - Preview momentum analysis for a specific user
  apiRouter.get('/action-items/preview/:slackUserId', requireAuth, requireAdmin, async (req, res) => {
    try {
      const { slackUserId } = req.params;
      const result = await previewMomentumForUser(slackUserId);
      res.json(result);
    } catch (error) {
      logger.error({ err: error, slackUserId: req.params.slackUserId }, 'Error previewing momentum for user');
      if (error instanceof Error && error.message.includes('not found')) {
        return res.status(404).json({ error: error.message });
      }
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /api/admin/task-reminders/run - Run task reminder job
  apiRouter.post('/task-reminders/run', requireAuth, requireAdmin, async (req, res) => {
    try {
      const { includeTomorrow, dryRun, forceResend } = req.body;
      const result = await runTaskReminderJob({
        includeTomorrow: includeTomorrow === true,
        dryRun: dryRun === true,
        forceResend: forceResend === true,
      });
      res.json(result);
    } catch (error) {
      logger.error({ err: error }, 'Error running task reminder job');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/admin/task-reminders/preview - Preview what reminders would be sent
  apiRouter.get('/task-reminders/preview', requireAuth, requireAdmin, async (req, res) => {
    try {
      const result = await previewTaskReminders();
      res.json({ batches: result });
    } catch (error) {
      logger.error({ err: error }, 'Error previewing task reminders');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // =========================================================================
  // ACCOUNT MANAGEMENT API ROUTES
  // =========================================================================

  // GET /api/admin/my-accounts - Get accounts assigned to current user
  apiRouter.get('/my-accounts', requireAuth, requireAdmin, async (req, res) => {
    try {
      const accounts = await getMyAccounts(req.user?.id || '');
      res.json({ accounts });
    } catch (error) {
      logger.error({ err: error }, 'Error fetching my accounts');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/admin/users/:userId/stakeholders - Get stakeholders for a user
  apiRouter.get('/users/:userId/stakeholders', requireAuth, requireAdmin, async (req, res) => {
    try {
      const { userId } = req.params;
      const { type } = req.query;

      const stakeholders = await getUserStakeholders(
        type === 'slack' ? userId : undefined,
        type === 'workos' ? userId : undefined
      );

      res.json({ stakeholders });
    } catch (error) {
      logger.error({ err: error }, 'Error fetching user stakeholders');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /api/admin/users/:userId/assign - Assign user to admin
  apiRouter.post('/users/:userId/assign', requireAuth, requireAdmin, async (req, res) => {
    try {
      const { userId } = req.params;
      const { type, role, notes } = req.body;

      if (!req.user) {
        return res.status(401).json({ error: 'Not authenticated' });
      }

      const stakeholder = await assignUserStakeholder({
        slackUserId: type === 'slack' ? userId : undefined,
        workosUserId: type === 'workos' ? userId : undefined,
        stakeholderId: req.user.id,
        stakeholderName: `${req.user.firstName || ''} ${req.user.lastName || ''}`.trim() || req.user.email,
        stakeholderEmail: req.user.email,
        role: role || 'owner',
        reason: 'manual',
        notes,
      });

      if (!stakeholder) {
        return res.status(409).json({ error: 'User already assigned' });
      }

      res.json(stakeholder);
    } catch (error) {
      logger.error({ err: error }, 'Error assigning user');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // DELETE /api/admin/users/:userId/unassign - Remove assignment
  apiRouter.delete('/users/:userId/unassign', requireAuth, requireAdmin, async (req, res) => {
    try {
      const { userId } = req.params;
      const { type } = req.query;

      if (!req.user) {
        return res.status(401).json({ error: 'Not authenticated' });
      }

      const removed = await removeUserStakeholder(
        type === 'slack' ? userId : undefined,
        type === 'workos' ? userId : undefined,
        req.user.id
      );

      res.json({ removed });
    } catch (error) {
      logger.error({ err: error }, 'Error unassigning user');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return { pageRouter, apiRouter };
}
