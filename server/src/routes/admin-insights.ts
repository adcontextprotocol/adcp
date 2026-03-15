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
import { getPool } from '../db/client.js';
import { query } from '../db/client.js';
import * as personEvents from '../db/person-events-db.js';
import {
  runOutreachScheduler,
  manualOutreach,
  getOutreachMode,
  canContactUser,
} from '../addie/services/proactive-outreach.js';
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

const logger = createLogger('admin-insights-routes');

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


  // =========================================================================
  // OUTREACH STATS & HISTORY API
  // =========================================================================

  // GET /api/admin/outreach/stats - Get outreach statistics from person_events
  apiRouter.get('/outreach/stats', requireAuth, requireAdmin, async (req, res) => {
    try {
      const result = await query<{
        sent_today: string;
        sent_this_week: string;
        total_sent: string;
        total_responded: string;
      }>(`
        SELECT
          COUNT(*) FILTER (WHERE event_type = 'outreach_decided' AND occurred_at > CURRENT_DATE)::text as sent_today,
          COUNT(*) FILTER (WHERE event_type = 'outreach_decided' AND occurred_at > CURRENT_DATE - INTERVAL '7 days')::text as sent_this_week,
          COUNT(*) FILTER (WHERE event_type = 'outreach_decided')::text as total_sent,
          COUNT(DISTINCT person_id) FILTER (WHERE event_type = 'message_received')::text as total_responded
        FROM person_events
      `);
      const row = result.rows[0];
      const totalSent = parseInt(row.total_sent, 10);
      const totalResponded = parseInt(row.total_responded, 10);
      res.json({
        sent_today: parseInt(row.sent_today, 10),
        sent_this_week: parseInt(row.sent_this_week, 10),
        total_responded: totalResponded,
        total_sent: totalSent,
        response_rate: totalSent > 0 ? Math.round((100 * totalResponded) / totalSent) : 0,
        insights_gathered: 0,
      });
    } catch (error) {
      logger.error({ err: error }, 'Error getting outreach stats');
      res.status(500).json({ error: 'Internal server error' });
    }
  });


  // GET /api/admin/outreach/stats/time-series - Get time-windowed outreach stats from person_events
  apiRouter.get('/outreach/stats/time-series', requireAuth, requireAdmin, async (req, res) => {
    try {
      const result = await query<{
        sent_today: string;
        responded_today: string;
        sent_this_week: string;
        responded_this_week: string;
        sent_this_month: string;
        responded_this_month: string;
        total_sent: string;
        total_responded: string;
      }>(`
        SELECT
          COUNT(*) FILTER (WHERE event_type = 'outreach_decided' AND occurred_at > CURRENT_DATE)::text as sent_today,
          COUNT(*) FILTER (WHERE event_type = 'message_received' AND occurred_at > CURRENT_DATE)::text as responded_today,
          COUNT(*) FILTER (WHERE event_type = 'outreach_decided' AND occurred_at > CURRENT_DATE - INTERVAL '7 days')::text as sent_this_week,
          COUNT(*) FILTER (WHERE event_type = 'message_received' AND occurred_at > CURRENT_DATE - INTERVAL '7 days')::text as responded_this_week,
          COUNT(*) FILTER (WHERE event_type = 'outreach_decided' AND occurred_at > CURRENT_DATE - INTERVAL '30 days')::text as sent_this_month,
          COUNT(*) FILTER (WHERE event_type = 'message_received' AND occurred_at > CURRENT_DATE - INTERVAL '30 days')::text as responded_this_month,
          COUNT(*) FILTER (WHERE event_type = 'outreach_decided')::text as total_sent,
          COUNT(DISTINCT person_id) FILTER (WHERE event_type = 'message_received')::text as total_responded
        FROM person_events
      `);
      const row = result.rows[0];
      const totalSent = parseInt(row.total_sent, 10);
      const totalResponded = parseInt(row.total_responded, 10);
      res.json({
        sent_today: parseInt(row.sent_today, 10),
        responded_today: parseInt(row.responded_today, 10),
        sent_this_week: parseInt(row.sent_this_week, 10),
        responded_this_week: parseInt(row.responded_this_week, 10),
        sent_this_month: parseInt(row.sent_this_month, 10),
        responded_this_month: parseInt(row.responded_this_month, 10),
        total_sent: totalSent,
        total_responded: totalResponded,
        total_insights: 0,
        overall_response_rate_pct: totalSent > 0 ? Math.round((100 * totalResponded) / totalSent) : null,
      });
    } catch (error) {
      logger.error({ err: error }, 'Error getting outreach time stats');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/admin/outreach/history - Get recent outreach history from person_events
  apiRouter.get('/outreach/history', requireAuth, requireAdmin, async (req, res) => {
    try {
      const limit = Math.min(req.query.limit ? parseInt(req.query.limit as string, 10) : 50, 200);
      const result = await query<{
        id: number;
        person_id: string;
        occurred_at: Date;
        event_type: string;
        channel: string | null;
        data: string;
        display_name: string | null;
        slack_user_id: string | null;
        stage: string | null;
      }>(`
        SELECT pe.id, pe.person_id, pe.occurred_at, pe.event_type, pe.channel, pe.data::text,
               pr.display_name, pr.slack_user_id, pr.stage
        FROM person_events pe
        LEFT JOIN person_relationships pr ON pr.id = pe.person_id
        WHERE pe.event_type IN ('outreach_decided', 'message_sent', 'message_received')
          AND (pe.event_type != 'message_sent' OR pe.data->>'source' IS DISTINCT FROM 'dm_reply')
        ORDER BY pe.occurred_at DESC
        LIMIT $1
      `, [limit]);

      // Map to legacy shape expected by admin-outreach.html
      res.json(result.rows.map(row => {
        const data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
        return {
          id: row.id,
          slack_user_id: row.slack_user_id || row.person_id,
          slack_display_name: row.display_name,
          slack_real_name: row.display_name,
          sent_at: row.occurred_at,
          outreach_type: row.channel || 'slack',
          user_responded: row.event_type === 'message_received',
          insight_extracted: false,
          thread_id: data.thread_ts || data.thread_id || null,
          initial_message: data.text || null,
        };
      }));
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
      const result = await query('SELECT * FROM outreach_test_accounts WHERE is_active = TRUE ORDER BY created_at');
      const accounts = result.rows;
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

      if (!slack_user_id || !/^[UW][A-Z0-9]+$/i.test(slack_user_id)) {
        return res.status(400).json({ error: 'Valid Slack user ID is required (e.g., U1234ABCD)' });
      }

      const addResult = await query(
        `INSERT INTO outreach_test_accounts (slack_user_id, description)
         VALUES ($1, $2)
         ON CONFLICT (slack_user_id) DO UPDATE SET description = EXCLUDED.description, is_active = TRUE
         RETURNING *`,
        [slack_user_id, description || null]
      );
      const account = addResult.rows[0];
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
      const removeResult = await query(
        'UPDATE outreach_test_accounts SET is_active = FALSE WHERE slack_user_id = $1',
        [req.params.slackUserId]
      );
      const removed = (removeResult.rowCount ?? 0) > 0;
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

  // POST /api/admin/outreach/send-with-goal - Admin-triggered outreach (goal_id accepted but unused)
  apiRouter.post('/outreach/send-with-goal', requireAuth, requireAdmin, async (req, res) => {
    try {
      const { slack_user_id } = req.body;

      if (!slack_user_id) {
        return res.status(400).json({ error: 'slack_user_id is required' });
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

      const result = await manualOutreach(
        slack_user_id,
        triggeredBy
      );

      if (result.success) {
        logger.info({ slackUserId: slack_user_id, triggeredBy: req.user?.id }, 'Admin outreach sent');
        res.json(result);
      } else {
        res.status(400).json({ error: result.error });
      }
    } catch (error) {
      logger.error({ err: error }, 'Error sending admin outreach');
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



  // GET /api/admin/outreach/timeline/:slackUserId - Get person event timeline
  apiRouter.get('/outreach/timeline/:slackUserId', requireAuth, requireAdmin, async (req, res) => {
    try {
      const { slackUserId } = req.params;

      // Validate Slack user ID format
      if (!/^[UW][A-Z0-9]+$/i.test(slackUserId)) {
        return res.status(400).json({ error: 'Invalid Slack user ID format' });
      }

      // Resolve person from Slack ID
      const personResult = await query<{
        id: string;
        display_name: string | null;
        slack_user_id: string | null;
        email: string | null;
        stage: string | null;
        opted_out: boolean;
      }>(`
        SELECT id, display_name, slack_user_id, email, stage, opted_out
        FROM person_relationships
        WHERE slack_user_id = $1
      `, [slackUserId]);

      const person = personResult.rows[0];
      if (!person) {
        return res.json({ user: null, timeline: [] });
      }

      // Get person events
      const events = await personEvents.getPersonTimeline(person.id, { limit: 50 });

      res.json({
        user: {
          slack_user_id: person.slack_user_id,
          slack_display_name: person.display_name,
          slack_real_name: person.display_name,
          slack_email: person.email,
          stage: person.stage,
          outreach_opt_out: person.opted_out,
        },
        timeline: events.reverse().map(event => {
          const text = (event.data?.text as string) || (event.data?.subject as string) || null;
          // Filter data to avoid leaking full message content and internal metadata
          const safeData: Record<string, unknown> = {};
          if (event.data?.stage) safeData.stage = event.data.stage;
          if (event.data?.goal_hint) safeData.goal_hint = event.data.goal_hint;
          if (event.data?.reason) safeData.reason = event.data.reason;
          if (event.data?.cadence) safeData.cadence = event.data.cadence;
          if (event.data?.preference) safeData.preference = event.data.preference;
          if (event.data?.from) safeData.from = event.data.from;
          if (event.data?.to) safeData.to = event.data.to;
          return {
            id: event.id,
            sent_at: event.occurred_at,
            outreach_type: event.event_type,
            channel: event.channel,
            message_preview: text ? text.substring(0, 200) + (text.length > 200 ? '...' : '') : null,
            data: safeData,
          };
        }),
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
        logger.warn({ err: error, slackUserId: req.params.slackUserId }, 'Resource not found');
        return res.status(404).json({ error: 'Resource not found' });
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
