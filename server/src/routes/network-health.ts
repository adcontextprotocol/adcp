/**
 * Network health API routes.
 *
 * Platform-admin endpoints comparing brand.json declarations against crawl
 * reality across organizations. Tenant-issued API keys must not reach this
 * cross-organization surface.
 *
 * API:
 *   GET  /api/network-health                     — summary across all orgs (admin)
 *   GET  /api/network-health/:orgId              — latest report for an org
 *   GET  /api/network-health/:orgId/history      — historical reports
 *   GET  /api/network-health/:orgId/trends       — lightweight trend data
 *   GET  /api/network-health/:orgId/alerts       — alert rule config (webhook redacted)
 *   GET  /api/network-health/:orgId/alerts/history    — alert history
 *   GET  /api/network-health/:orgId/alerts/unresolved — unresolved alerts
 *   POST /api/network-health/:orgId/alerts       — configure alert thresholds
 *   POST /api/network-health/:orgId/alerts/:alertId/resolve — resolve an alert
 *
 * Admin page:
 *   GET  /admin/network-health                   — dashboard
 */

import { Router } from 'express';
import { z } from 'zod';
import { createLogger } from '../logger.js';
import { requireGlobalAdmin } from '../middleware/auth.js';
import * as db from '../db/network-health-db.js';
import { isUuid } from '../utils/uuid.js';
import { serveHtmlWithConfig } from '../utils/html-config.js';

const logger = createLogger('network-health');

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

/** Register the platform-admin dashboard page on the shared admin router. */
export function registerNetworkHealthAdminPage(pageRouter: Router): void {
  pageRouter.get('/network-health', ...requireGlobalAdmin, (req, res) => {
    serveHtmlWithConfig(req, res, 'admin-network-health.html').catch((error) => {
      logger.error({ error }, 'Error serving network health page');
      res.status(500).send('Internal server error');
    });
  });
}

export function createNetworkHealthApiRouter(): Router {
  const apiRouter = Router();

  // This dashboard intentionally spans organizations. Keep the authorization
  // boundary at router scope so new endpoints cannot accidentally inherit only
  // authentication or tenant-admin access.
  apiRouter.use(...requireGlobalAdmin);

  // ── Read API ───────────────────────────────────────────────────

  // Summary across all tracked orgs
  apiRouter.get('/', async (_req, res) => {
    try {
      const summaries = await db.getNetworkSummaries();
      res.json({ networks: summaries });
    } catch (error) {
      logger.error({ error }, 'Error fetching network summaries');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Validate orgId format on all org-scoped routes
  apiRouter.param('orgId', (req, res, next, orgId) => {
    if (typeof orgId !== 'string' || orgId.length < 3 || orgId.length > 255) {
      return res.status(400).json({ error: 'Invalid organization ID format' });
    }
    next();
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

  // ── Write API ─────────────────────────────────────────────────

  // Configure alert thresholds
  apiRouter.post('/:orgId/alerts', async (req, res) => {
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

  // Resolve an alert within the organization named by the route.
  apiRouter.post('/:orgId/alerts/:alertId/resolve', async (req, res) => {
    try {
      const { alertId } = req.params;
      if (!isUuid(alertId)) {
        return res.status(400).json({ error: 'Invalid alert ID format' });
      }
      const resolved = await db.resolveAlert(req.params.orgId, alertId);
      if (!resolved) {
        // Use the same response for a missing alert and an alert owned by a
        // different organization so the route does not disclose ownership.
        return res.status(404).json({ error: 'Alert not found' });
      }
      res.json({ ok: true });
    } catch (error) {
      logger.error({ error }, 'Error resolving alert');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return apiRouter;
}
