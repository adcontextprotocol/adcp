/**
 * Admin routes for Member Insights and Proactive Engagement
 *
 * Routes:
 * - /api/admin/insight-types - Manage insight taxonomy
 * - /api/admin/insight-goals - Manage insight goals
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
  getOutreachMode,
  canContactUser,
} from '../addie/services/proactive-outreach.js';
import { invalidateInsightsCache, invalidateGoalsCache } from '../addie/insights-cache.js';
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

  pageRouter.get('/insight-goals', requireAuth, requireAdmin, (req, res) => {
    serveHtmlWithConfig(req, res, 'admin-insight-goals.html').catch((err) => {
      logger.error({ err }, 'Error serving insight goals page');
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
  // INSIGHT GOALS API
  // =========================================================================

  // GET /api/admin/insight-goals - List all insight goals
  apiRouter.get('/insight-goals', requireAuth, requireAdmin, async (req, res) => {
    try {
      const activeOnly = req.query.activeOnly === 'true';
      const goals = await insightsDb.listGoals({ activeOnly });
      res.json(goals);
    } catch (error) {
      logger.error({ err: error }, 'Error listing insight goals');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/admin/insight-goals/:id - Get single insight goal
  apiRouter.get('/insight-goals/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
      const id = parseIntId(req.params.id);
      if (id === null) {
        return res.status(400).json({ error: 'Invalid ID format' });
      }

      const goal = await insightsDb.getGoal(id);
      if (!goal) {
        return res.status(404).json({ error: 'Insight goal not found' });
      }
      res.json(goal);
    } catch (error) {
      logger.error({ err: error }, 'Error getting insight goal');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /api/admin/insight-goals - Create insight goal
  apiRouter.post('/insight-goals', requireAuth, requireAdmin, async (req, res) => {
    try {
      const {
        name,
        question,
        insight_type_id,
        goal_type,
        start_date,
        end_date,
        is_enabled,
        priority,
        target_mapped_only,
        target_unmapped_only,
        target_response_count,
        suggested_prompt_title,
        suggested_prompt_message,
      } = req.body;

      if (!name || !question) {
        return res.status(400).json({ error: 'Name and question are required' });
      }

      const goal = await insightsDb.createGoal({
        name,
        question,
        insight_type_id,
        goal_type,
        start_date: start_date ? new Date(start_date) : undefined,
        end_date: end_date ? new Date(end_date) : undefined,
        is_enabled,
        priority,
        target_mapped_only,
        target_unmapped_only,
        target_response_count,
        suggested_prompt_title,
        suggested_prompt_message,
        created_by: req.user?.id,
      });

      // Invalidate goals cache so routing uses fresh goal data
      invalidateGoalsCache();

      logger.info({ goalId: goal.id, name }, 'Created insight goal');
      res.status(201).json(goal);
    } catch (error) {
      logger.error({ err: error }, 'Error creating insight goal');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // PUT /api/admin/insight-goals/:id - Update insight goal
  apiRouter.put('/insight-goals/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
      const id = parseIntId(req.params.id);
      if (id === null) {
        return res.status(400).json({ error: 'Invalid ID format' });
      }

      const goal = await insightsDb.updateGoal(id, req.body);

      if (!goal) {
        return res.status(404).json({ error: 'Insight goal not found' });
      }

      // Invalidate goals cache so routing uses fresh goal data
      invalidateGoalsCache();

      logger.info({ goalId: goal.id }, 'Updated insight goal');
      res.json(goal);
    } catch (error) {
      logger.error({ err: error }, 'Error updating insight goal');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // DELETE /api/admin/insight-goals/:id - Delete insight goal
  apiRouter.delete('/insight-goals/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
      const id = parseIntId(req.params.id);
      if (id === null) {
        return res.status(400).json({ error: 'Invalid ID format' });
      }

      const deleted = await insightsDb.deleteGoal(id);
      if (!deleted) {
        return res.status(404).json({ error: 'Insight goal not found' });
      }

      // Invalidate goals cache so routing uses fresh goal data
      invalidateGoalsCache();

      logger.info({ goalId: id }, 'Deleted insight goal');
      res.json({ success: true });
    } catch (error) {
      logger.error({ err: error }, 'Error deleting insight goal');
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
  // OUTREACH VARIANTS API
  // =========================================================================

  // GET /api/admin/outreach/variants - List all variants
  apiRouter.get('/outreach/variants', requireAuth, requireAdmin, async (req, res) => {
    try {
      const activeOnly = req.query.activeOnly === 'true';
      const variants = await insightsDb.listVariants(activeOnly);
      res.json(variants);
    } catch (error) {
      logger.error({ err: error }, 'Error listing outreach variants');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/admin/outreach/variants/stats - Get A/B test statistics
  apiRouter.get('/outreach/variants/stats', requireAuth, requireAdmin, async (req, res) => {
    try {
      const stats = await insightsDb.getVariantStats();
      res.json(stats);
    } catch (error) {
      logger.error({ err: error }, 'Error getting variant stats');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /api/admin/outreach/variants - Create variant
  apiRouter.post('/outreach/variants', requireAuth, requireAdmin, async (req, res) => {
    try {
      const { name, description, tone, approach, message_template, is_active, weight } = req.body;

      if (!name || !tone || !approach || !message_template) {
        return res.status(400).json({ error: 'name, tone, approach, and message_template are required' });
      }

      const variant = await insightsDb.createVariant({
        name,
        description,
        tone,
        approach,
        message_template,
        is_active,
        weight,
      });

      logger.info({ variantId: variant.id, name }, 'Created outreach variant');
      res.status(201).json(variant);
    } catch (error) {
      logger.error({ err: error }, 'Error creating outreach variant');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // PUT /api/admin/outreach/variants/:id - Update variant
  apiRouter.put('/outreach/variants/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
      const id = parseIntId(req.params.id);
      if (id === null) {
        return res.status(400).json({ error: 'Invalid ID format' });
      }

      const variant = await insightsDb.updateVariant(id, req.body);

      if (!variant) {
        return res.status(404).json({ error: 'Variant not found' });
      }

      logger.info({ variantId: variant.id }, 'Updated outreach variant');
      res.json(variant);
    } catch (error) {
      logger.error({ err: error }, 'Error updating outreach variant');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // DELETE /api/admin/outreach/variants/:id - Delete variant
  apiRouter.delete('/outreach/variants/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
      const id = parseIntId(req.params.id);
      if (id === null) {
        return res.status(400).json({ error: 'Invalid ID format' });
      }

      const deleted = await insightsDb.deleteVariant(id);
      if (!deleted) {
        return res.status(404).json({ error: 'Variant not found' });
      }

      logger.info({ variantId: id }, 'Deleted outreach variant');
      res.json({ success: true });
    } catch (error) {
      logger.error({ err: error }, 'Error deleting outreach variant');
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

      // Get user info
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

      // Use the goal from unified_contacts_with_goals which considers all factors
      // including whether the account is already linked
      const goalKey = user.goal_key;

      // Map goal_key to outreach_type for variant selection
      let outreachType: string;
      if (goalKey === 'link_account') {
        // User needs to link their Slack to AAO
        outreachType = 'account_link';
      } else if (!user.last_outreach_at && !user.workos_user_id) {
        // Never contacted and no AAO account
        outreachType = 'introduction';
      } else {
        // User is already linked or has been contacted before
        // Use goal-based outreach
        outreachType = goalKey || 'insight_goal';
      }

      // Get active variant appropriate for the outreach type
      // For linked users (not needing account_link), prefer engagement-focused variants
      const needsLinking = goalKey === 'link_account';

      // Use separate queries to avoid dynamic SQL construction
      let variantQuery: string;
      if (needsLinking) {
        variantQuery = `
          SELECT name, message_template, tone, approach
          FROM outreach_variants
          WHERE is_active = TRUE
          ORDER BY weight DESC
          LIMIT 1
        `;
      } else {
        // Exclude account-linking focused variants for already-linked users
        variantQuery = `
          SELECT name, message_template, tone, approach
          FROM outreach_variants
          WHERE is_active = TRUE
            AND message_template NOT LIKE '%connected to Slack%'
            AND message_template NOT LIKE '%linked to Slack%'
            AND message_template NOT LIKE '%link your Slack%'
          ORDER BY weight DESC
          LIMIT 1
        `;
      }
      const variantResult = await pool.query(variantQuery);

      const variant = variantResult.rows[0];

      // Get insight goal if applicable
      let goalQuestion: string | null = null;
      if (outreachType === 'insight_goal') {
        const goalResult = await pool.query(`
          SELECT question FROM insight_goals
          WHERE is_active = TRUE AND target_unmapped_only = FALSE
          ORDER BY priority DESC
          LIMIT 1
        `);
        if (goalResult.rows.length > 0) {
          goalQuestion = goalResult.rows[0].question;
        }
      }

      // Build preview message
      const userName = user.slack_display_name || user.slack_real_name || 'there';
      let previewMessage: string;

      // If user doesn't need account linking, don't show linking-focused messages
      if (!needsLinking && variant?.message_template) {
        previewMessage = `[Account already linked - no outreach needed]\n\nThis user's Slack and AgenticAdvertising.org accounts are already connected. The current goal for Addie is: ${user.goal_name || 'Drive Engagement'}`;
      } else {
        previewMessage = variant?.message_template || '[No active outreach variant configured]';
        previewMessage = previewMessage.replace(/\{\{user_name\}\}/g, userName);
        if (goalQuestion) {
          previewMessage = previewMessage.replace(/\{\{goal_question\}\}/g, goalQuestion);
        }
      }

      // Check eligibility
      const baseEligibility = await canContactUser(slackUserId);

      // For already-linked users, override eligibility to indicate no linking outreach needed
      const eligibility = !needsLinking
        ? { canContact: false, reason: 'Account already linked - Slack and AAO accounts are connected' }
        : baseEligibility;

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
        variant: variant ? {
          name: variant.name,
          tone: variant.tone,
          approach: variant.approach,
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
