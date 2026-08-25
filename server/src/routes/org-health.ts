import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { createLogger } from '../logger.js';
import { requireAuth } from '../middleware/auth.js';
import { assembleOrgHealth } from '../services/org-health.js';
import { query } from '../db/client.js';
import { recordEvent } from '../db/person-events-db.js';
import { getWorkos } from '../auth/workos-client.js';
import { resolveUserOrgMembership } from '../utils/resolve-user-org-membership.js';
import { getOrganizationAuthorizationUserId } from '../auth/organization-principal.js';

const logger = createLogger('org-health-routes');

const nudgeRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 20,                   // 20 nudges per hour per IP
  standardHeaders: true,
  legacyHeaders: false,
});

export function createOrgHealthRouter(): Router {
  const router = Router();

  // GET /api/me/org-health — org health aggregation
  router.get('/', requireAuth, async (req, res) => {
    try {
      const orgId = typeof req.query.org === 'string' && req.query.org.trim()
        ? req.query.org
        : null;
      if (!orgId) {
        return res.status(400).json({ error: 'org query parameter is required' });
      }
      const membership = await resolveUserOrgMembership(getWorkos(), req.user!, orgId);
      if (!membership) {
        return res.status(403).json({ error: 'Not authorized for the selected organization' });
      }

      // Restrict to admin/owner — people table contains PII (emails)
      if (membership.role !== 'admin' && membership.role !== 'owner') {
        return res.status(403).json({ error: 'Org admin access required' });
      }

      const health = await assembleOrgHealth(membership.organizationId);
      res.json(health);
    } catch (error) {
      logger.error({ error }, 'Failed to load org health');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /api/me/org-health/nudge — admin requests Addie outreach for a team member
  router.post('/nudge', requireAuth, nudgeRateLimiter, async (req, res) => {
    try {
      const userId = getOrganizationAuthorizationUserId(req.user!);
      const { target_user_id, topic } = req.body;
      const orgId = typeof req.query.org === 'string' && req.query.org.trim()
        ? req.query.org
        : null;

      if (!target_user_id || typeof target_user_id !== 'string') {
        return res.status(400).json({ error: 'target_user_id required' });
      }
      if (!orgId) {
        return res.status(400).json({ error: 'org query parameter is required' });
      }

      const membership = await resolveUserOrgMembership(getWorkos(), req.user!, orgId);
      if (!membership || (membership.role !== 'admin' && membership.role !== 'owner')) {
        return res.status(403).json({ error: 'Org admin access required' });
      }

      // Verify target is in the same org
      const memberCheck = await query<{ workos_user_id: string }>(
        `SELECT workos_user_id FROM organization_memberships
         WHERE workos_user_id = $1 AND workos_organization_id = $2`,
        [target_user_id, membership.organizationId]
      );
      if (memberCheck.rows.length === 0) {
        return res.status(404).json({ error: 'User not found in your organization' });
      }

      // Find the person_relationships record for the target user
      const personResult = await query<{ id: string }>(
        `SELECT id FROM person_relationships WHERE workos_user_id = $1 LIMIT 1`,
        [target_user_id]
      );

      if (!personResult.rows[0]) {
        return res.status(404).json({ error: 'No relationship record found for this user' });
      }

      const currentMembership = await resolveUserOrgMembership(getWorkos(), req.user!, orgId);
      if (!currentMembership || (currentMembership.role !== 'admin' && currentMembership.role !== 'owner')) {
        return res.status(403).json({ error: 'Organization authorization was revoked' });
      }
      await recordEvent(personResult.rows[0].id, 'admin_nudge_requested', {
        channel: 'system',
        data: {
          requested_by: userId,
          topic: typeof topic === 'string' ? topic.slice(0, 200) : 'general engagement',
        },
      });
      logger.info({ targetUserId: target_user_id, requestedBy: userId, topic }, 'Admin nudge requested');

      res.json({ success: true });
    } catch (error) {
      logger.error({ error }, 'Failed to process nudge request');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
