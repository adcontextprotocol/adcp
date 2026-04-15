/**
 * Network health API routes.
 *
 * Org-scoped endpoints comparing brand.json declarations against crawl reality.
 * All API routes require authentication; write operations require admin.
 *
 * API:
 *   GET  /api/network-health                     — summary across all orgs (admin)
 *   GET  /api/network-health/:orgId              — latest report for an org
 *   GET  /api/network-health/:orgId/history      — historical reports
 *   GET  /api/network-health/:orgId/trends       — lightweight trend data
 *   GET  /api/network-health/:orgId/alerts       — alert rule config (webhook redacted)
 *   GET  /api/network-health/:orgId/alerts/history    — alert history
 *   GET  /api/network-health/:orgId/alerts/unresolved — unresolved alerts
 *   POST /api/network-health/:orgId/alerts       — configure alert thresholds (admin)
 *   POST /api/network-health/alerts/:alertId/resolve — resolve an alert (admin)
 *
 * Admin page:
 *   GET  /admin/network-health                   — dashboard
 */

import { Router } from 'express';
import { z } from 'zod';
import { createLogger } from '../logger.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import * as db from '../db/network-health-db.js';

const logger = createLogger('network-health');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLACK_WEBHOOK_PATTERN = /^https:\/\/hooks\.slack\.com\/services\//;

const alertRuleSchema = z.object({
  coverage_threshold: z.number().min(0).max(100).optional(),
  missing_authorization_max: z.number().int().min(0).optional(),
  orphaned_authorization_max: z.number().int().min(0).optional(),
  agent_unreachable_cycles: z.number().int().min(1).optional(),
  slack_webhook_url: z.string().regex(SLACK_WEBHOOK_PATTERN, 'Must be a hooks.slack.com URL').nullable().optional(),
  email_recipients: z.array(z.string().email()).optional(),
  enabled: z.boolean().optional(),
});

export function createNetworkHealthApiRouter(): Router {
  const apiRouter = Router();

  // All API routes require authentication
  apiRouter.use(requireAuth);

  // ── Read API ───────────────────────────────────────────────────

  // Summary across all tracked orgs (admin only)
  apiRouter.get('/', requireAdmin, async (_req, res) => {
    try {
      const summaries = await db.getNetworkSummaries();
      res.json({ networks: summaries });
    } catch (error) {
      logger.error({ error }, 'Error fetching network summaries');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Latest report for a specific org
  apiRouter.get('/:orgId', async (req, res) => {
    try {
      const report = await db.getLatestReport(req.params.orgId);
      if (!report) {
        return res.status(404).json({ error: 'No report found for this organization' });
      }
      res.json(report);
    } catch (error) {
      logger.error({ error }, 'Error fetching latest report');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Historical reports
  apiRouter.get('/:orgId/history', async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit as string) || 30, 100);
      const reports = await db.getReportHistory(req.params.orgId, limit);
      res.json({ reports });
    } catch (error) {
      logger.error({ error }, 'Error fetching report history');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Trend data
  apiRouter.get('/:orgId/trends', async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit as string) || 60, 200);
      const trends = await db.getTrends(req.params.orgId, limit);
      res.json({ trends });
    } catch (error) {
      logger.error({ error }, 'Error fetching trends');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Get alert configuration (webhook URL redacted)
  apiRouter.get('/:orgId/alerts', async (req, res) => {
    try {
      const rule = await db.getAlertRule(req.params.orgId);
      if (!rule) {
        return res.status(404).json({ error: 'No alert rules configured' });
      }
      const { slack_webhook_url, ...safeRule } = rule;
      res.json({ ...safeRule, slack_webhook_configured: !!slack_webhook_url });
    } catch (error) {
      logger.error({ error }, 'Error fetching alert rule');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Alert history
  apiRouter.get('/:orgId/alerts/history', async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
      const alerts = await db.getAlertHistory(req.params.orgId, limit);
      res.json({ alerts });
    } catch (error) {
      logger.error({ error }, 'Error fetching alert history');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Unresolved alerts
  apiRouter.get('/:orgId/alerts/unresolved', async (req, res) => {
    try {
      const alerts = await db.getUnresolvedAlerts(req.params.orgId);
      res.json({ alerts });
    } catch (error) {
      logger.error({ error }, 'Error fetching unresolved alerts');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Write API (admin only) ────────────────────────────────────

  // Configure alert thresholds
  apiRouter.post('/:orgId/alerts', requireAdmin, async (req, res) => {
    try {
      const parsed = alertRuleSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          error: 'Invalid alert configuration',
          details: parsed.error.issues,
        });
      }

      const rule = await db.upsertAlertRule({
        org_id: req.params.orgId,
        ...parsed.data,
        created_by: req.user?.email ?? req.user?.id,
      });

      const { slack_webhook_url, ...safeRule } = rule;
      res.json({ ...safeRule, slack_webhook_configured: !!slack_webhook_url });
    } catch (error) {
      logger.error({ error }, 'Error upserting alert rule');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Resolve an alert
  apiRouter.post('/alerts/:alertId/resolve', requireAdmin, async (req, res) => {
    try {
      const { alertId } = req.params;
      if (!UUID_PATTERN.test(alertId)) {
        return res.status(400).json({ error: 'Invalid alert ID format' });
      }
      await db.resolveAlert(alertId);
      res.json({ ok: true });
    } catch (error) {
      logger.error({ error }, 'Error resolving alert');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return apiRouter;
}
