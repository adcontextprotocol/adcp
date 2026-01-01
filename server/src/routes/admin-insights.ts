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
import {
  runOutreachScheduler,
  manualOutreach,
  getOutreachMode,
  canContactUser,
} from '../addie/services/proactive-outreach.js';
import { invalidateInsightsCache, invalidateGoalsCache } from '../addie/insights-cache.js';

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

      const result = await manualOutreach(slackUserId);

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

  return { pageRouter, apiRouter };
}
