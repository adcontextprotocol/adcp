/**
 * Admin Email routes module
 *
 * Admin-only routes for email management:
 * - Email statistics
 * - Campaigns list
 * - Templates list
 * - Recent email sends
 */

import { Router } from 'express';
import { createLogger } from '../../logger.js';
import { requireAuth, requireAdmin } from '../../middleware/auth.js';
import { getPool } from '../../db/client.js';
import { emailPrefsDb } from '../../db/email-preferences-db.js';

const logger = createLogger('admin-email-routes');

/**
 * Create admin email routes
 * Returns a router to be mounted at /api/admin/email
 */
export function createAdminEmailRouter(): Router {
  const router = Router();

  // GET /api/admin/email/stats - Email statistics for admin dashboard
  router.get('/stats', requireAuth, requireAdmin, async (req, res) => {
    try {
      const pool = getPool();

      // Get total emails sent
      const sentResult = await pool.query(
        `SELECT COUNT(*) as count FROM email_events WHERE sent_at IS NOT NULL`
      );
      const totalSent = parseInt(sentResult.rows[0]?.count || '0');

      // Get open rate
      const openResult = await pool.query(
        `SELECT
          COUNT(*) FILTER (WHERE opened_at IS NOT NULL) as opened,
          COUNT(*) as total
         FROM email_events
         WHERE sent_at IS NOT NULL`
      );
      const avgOpenRate = openResult.rows[0]?.total > 0
        ? (parseInt(openResult.rows[0].opened) / parseInt(openResult.rows[0].total)) * 100
        : 0;

      // Get click rate
      const clickResult = await pool.query(
        `SELECT
          COUNT(*) FILTER (WHERE first_clicked_at IS NOT NULL) as clicked,
          COUNT(*) as total
         FROM email_events
         WHERE sent_at IS NOT NULL`
      );
      const avgClickRate = clickResult.rows[0]?.total > 0
        ? (parseInt(clickResult.rows[0].clicked) / parseInt(clickResult.rows[0].total)) * 100
        : 0;

      // Get campaign count
      const campaignResult = await pool.query(
        `SELECT COUNT(*) as count FROM email_campaigns`
      );
      const totalCampaigns = parseInt(campaignResult.rows[0]?.count || '0');

      res.json({
        total_sent: totalSent,
        avg_open_rate: avgOpenRate,
        avg_click_rate: avgClickRate,
        total_campaigns: totalCampaigns,
      });
    } catch (error) {
      logger.error({ error }, 'Error fetching email stats');
      res.status(500).json({ error: 'Failed to fetch email stats' });
    }
  });

  // GET /api/admin/email/campaigns - List all campaigns
  router.get('/campaigns', requireAuth, requireAdmin, async (req, res) => {
    try {
      const campaigns = await emailPrefsDb.getCampaigns();
      res.json({ campaigns });
    } catch (error) {
      logger.error({ error }, 'Error fetching campaigns');
      res.status(500).json({ error: 'Failed to fetch campaigns' });
    }
  });

  // GET /api/admin/email/templates - List all templates
  router.get('/templates', requireAuth, requireAdmin, async (req, res) => {
    try {
      const templates = await emailPrefsDb.getTemplates();
      res.json({ templates });
    } catch (error) {
      logger.error({ error }, 'Error fetching templates');
      res.status(500).json({ error: 'Failed to fetch templates' });
    }
  });

  // GET /api/admin/email/recent - Recent email sends
  router.get('/recent', requireAuth, requireAdmin, async (req, res) => {
    try {
      const pool = getPool();
      const result = await pool.query(
        `SELECT *
         FROM email_events
         ORDER BY created_at DESC
         LIMIT 100`
      );
      res.json({ emails: result.rows });
    } catch (error) {
      logger.error({ error }, 'Error fetching recent emails');
      res.status(500).json({ error: 'Failed to fetch recent emails' });
    }
  });

  return router;
}
