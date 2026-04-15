/**
 * Network health API routes.
 *
 * Authenticated endpoints for network consistency reports and alerting.
 * Admin page route for the dashboard UI.
 *
 * API (all require auth):
 *   GET  /api/network-health                                — summary across all networks
 *   GET  /api/network-health/:authoritativeUrl              — latest report
 *   GET  /api/network-health/:authoritativeUrl/history      — historical reports
 *   GET  /api/network-health/:authoritativeUrl/trends       — lightweight trend data
 *   GET  /api/network-health/:authoritativeUrl/alerts       — alert rule config (webhook URL redacted)
 *   GET  /api/network-health/:authoritativeUrl/alerts/history    — alert history
 *   GET  /api/network-health/:authoritativeUrl/alerts/unresolved — unresolved alerts
 *   POST /api/network-health/:authoritativeUrl/alerts       — configure alert thresholds (admin)
 *   POST /api/network-health/alerts/:alertId/resolve        — resolve an alert (admin)
 *
 * Admin page:
 *   GET  /admin/network-health                              — dashboard
 */

import { Router } from 'express';
import { z } from 'zod';
import { createLogger } from '../logger.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { serveHtmlWithConfig } from '../utils/html-config.js';
import * as db from '../db/network-health-db.js';

const logger = createLogger('network-health');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLACK_WEBHOOK_PATTERN = /^https:\/\/hooks\.slack\.com\/services\//;

const alertRuleSchema = z.object({
  coverage_threshold: z.number().min(0).max(100).optional(),
  stale_pointer_max: z.number().int().min(0).optional(),
  orphaned_pointer_max: z.number().int().min(0).optional(),
  missing_pointer_persistence_cycles: z.number().int().min(1).optional(),
  agent_unreachable_cycles: z.number().int().min(1).optional(),
  slack_webhook_url: z.string().regex(SLACK_WEBHOOK_PATTERN, 'Must be a hooks.slack.com URL').nullable().optional(),
  email_recipients: z.array(z.string().email()).optional(),
  enabled: z.boolean().optional(),
});

export function createNetworkHealthRouter(): { pageRouter: Router; apiRouter: Router } {
  const pageRouter = Router();
  const apiRouter = Router();

  // All API routes require authentication
  apiRouter.use(requireAuth);

  // ── Admin page ─────────────────────────────────────────────────

  pageRouter.get('/network-health', requireAuth, requireAdmin, (req, res) => {
    serveHtmlWithConfig(req, res, 'admin-network-health.html').catch((err) => {
      logger.error({ err }, 'Error serving network health page');
      res.status(500).send('Internal server error');
    });
  });

  // ── Read API ───────────────────────────────────────────────────

  // Summary across all tracked networks
  apiRouter.get('/', async (_req, res) => {
    try {
      const summaries = await db.getNetworkSummaries();
      res.json({ networks: summaries });
    } catch (error) {
      logger.error({ error }, 'Error fetching network summaries');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Latest consistency report for a specific authoritative URL
  apiRouter.get('/:authoritativeUrl', async (req, res) => {
    try {
      const authoritativeUrl = decodeURIComponent(req.params.authoritativeUrl);
      const report = await db.getLatestReport(authoritativeUrl);
      if (!report) {
        return res.status(404).json({ error: 'No report found for this authoritative URL' });
      }
      res.json(report);
    } catch (error) {
      logger.error({ error }, 'Error fetching latest report');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Historical reports for trend analysis
  apiRouter.get('/:authoritativeUrl/history', async (req, res) => {
    try {
      const authoritativeUrl = decodeURIComponent(req.params.authoritativeUrl);
      const limit = Math.min(parseInt(req.query.limit as string) || 30, 100);
      const reports = await db.getReportHistory(authoritativeUrl, limit);
      res.json({ reports });
    } catch (error) {
      logger.error({ error }, 'Error fetching report history');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Trend data (lightweight projection for charts)
  apiRouter.get('/:authoritativeUrl/trends', async (req, res) => {
    try {
      const authoritativeUrl = decodeURIComponent(req.params.authoritativeUrl);
      const limit = Math.min(parseInt(req.query.limit as string) || 60, 200);
      const trends = await db.getTrends(authoritativeUrl, limit);
      res.json({ trends });
    } catch (error) {
      logger.error({ error }, 'Error fetching trends');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Get alert configuration (webhook URL redacted)
  apiRouter.get('/:authoritativeUrl/alerts', async (req, res) => {
    try {
      const authoritativeUrl = decodeURIComponent(req.params.authoritativeUrl);
      const rule = await db.getAlertRule(authoritativeUrl);
      if (!rule) {
        return res.status(404).json({ error: 'No alert rules configured for this network' });
      }
      // Redact sensitive fields
      const { slack_webhook_url, ...safeRule } = rule;
      res.json({ ...safeRule, slack_webhook_configured: !!slack_webhook_url });
    } catch (error) {
      logger.error({ error }, 'Error fetching alert rule');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Get alert history for a network
  apiRouter.get('/:authoritativeUrl/alerts/history', async (req, res) => {
    try {
      const authoritativeUrl = decodeURIComponent(req.params.authoritativeUrl);
      const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
      const alerts = await db.getAlertHistory(authoritativeUrl, limit);
      res.json({ alerts });
    } catch (error) {
      logger.error({ error }, 'Error fetching alert history');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Get unresolved alerts for a network
  apiRouter.get('/:authoritativeUrl/alerts/unresolved', async (req, res) => {
    try {
      const authoritativeUrl = decodeURIComponent(req.params.authoritativeUrl);
      const alerts = await db.getUnresolvedAlerts(authoritativeUrl);
      res.json({ alerts });
    } catch (error) {
      logger.error({ error }, 'Error fetching unresolved alerts');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Write API (admin only) ────────────────────────────────────

  // Configure alert thresholds
  apiRouter.post('/:authoritativeUrl/alerts', requireAdmin, async (req, res) => {
    try {
      const authoritativeUrl = decodeURIComponent(req.params.authoritativeUrl);

      const parsed = alertRuleSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          error: 'Invalid alert configuration',
          details: parsed.error.issues,
        });
      }

      const rule = await db.upsertAlertRule({
        authoritative_url: authoritativeUrl,
        ...parsed.data,
        created_by: req.user?.email ?? req.user?.id,
      });

      // Redact webhook URL in response
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

  return { pageRouter, apiRouter };
}
