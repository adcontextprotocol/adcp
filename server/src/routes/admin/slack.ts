/**
 * Admin Slack routes module
 *
 * Admin-only routes for managing Slack integration:
 * - Status and stats
 * - User sync
 * - User mapping (link/unlink)
 * - Auto-link suggestions
 */

import { Router } from 'express';
import { createLogger } from '../../logger.js';
import { requireAuth, requireAdmin } from '../../middleware/auth.js';
import { SlackDatabase } from '../../db/slack-db.js';
import { getPool } from '../../db/client.js';
import { isSlackConfigured, testSlackConnection } from '../../slack/client.js';
import { syncSlackUsers, getSyncStatus, syncUserToChaptersFromSlackChannels } from '../../slack/sync.js';
import { invalidateUnifiedUsersCache } from '../../cache/unified-users.js';
import { invalidateMemberContextCache } from '../../addie/index.js';
import { workos } from '../../auth/workos-client.js';
import { isFreeEmailDomain } from '../../utils/email-domain.js';

const logger = createLogger('admin-slack-routes');

const slackDb = new SlackDatabase();

/**
 * Check if a user should be assigned to an organization based on their email domain.
 * If the user is in a personal workspace and their email domain matches a registered
 * organization domain, adds them to that organization.
 *
 * @returns Object with organization assignment details, or null if no assignment needed
 */
async function checkAndAssignOrganizationByDomain(
  workosUserId: string
): Promise<{
  assigned: boolean;
  organizationId?: string;
  organizationName?: string;
  previousOrgId?: string;
  previousOrgName?: string;
  error?: string;
} | null> {
  const pool = getPool();

  try {
    // Get the user's email and current organization from organization_memberships
    const membershipResult = await pool.query<{
      email: string;
      workos_organization_id: string;
      org_name: string;
      is_personal: boolean;
    }>(`
      SELECT om.email, om.workos_organization_id, o.name as org_name, o.is_personal
      FROM organization_memberships om
      JOIN organizations o ON o.workos_organization_id = om.workos_organization_id
      WHERE om.workos_user_id = $1
      LIMIT 1
    `, [workosUserId]);

    if (membershipResult.rows.length === 0) {
      logger.debug({ workosUserId }, 'No membership found for user, skipping org assignment');
      return null;
    }

    const { email, workos_organization_id: currentOrgId, org_name: currentOrgName, is_personal: isPersonal } = membershipResult.rows[0];

    // Only proceed if user is in a personal workspace
    if (!isPersonal) {
      logger.debug({ workosUserId, currentOrgId, currentOrgName }, 'User is already in a company workspace');
      return null;
    }

    // Extract domain from email
    const domain = email.split('@')[1]?.toLowerCase();
    if (!domain) {
      logger.warn({ workosUserId, email }, 'Could not extract domain from email');
      return null;
    }

    // Skip free email providers (gmail, yahoo, etc.)
    if (isFreeEmailDomain(domain)) {
      logger.debug({ workosUserId, domain }, 'Skipping free email domain');
      return null;
    }

    // Check if there's an organization with this domain registered
    // Note: domain is already lowercased above
    const domainResult = await pool.query<{
      workos_organization_id: string;
      org_name: string;
    }>(`
      SELECT od.workos_organization_id, o.name as org_name
      FROM organization_domains od
      JOIN organizations o ON o.workos_organization_id = od.workos_organization_id
      WHERE LOWER(od.domain) = $1
        AND o.is_personal = false
      LIMIT 1
    `, [domain]);

    if (domainResult.rows.length === 0) {
      logger.debug({ workosUserId, domain }, 'No organization found for domain');
      return null;
    }

    const { workos_organization_id: targetOrgId, org_name: targetOrgName } = domainResult.rows[0];

    // Check if user is already a member of the target organization
    const existingMembershipResult = await pool.query(`
      SELECT 1 FROM organization_memberships
      WHERE workos_user_id = $1 AND workos_organization_id = $2
      LIMIT 1
    `, [workosUserId, targetOrgId]);

    if (existingMembershipResult.rows.length > 0) {
      logger.debug({ workosUserId, targetOrgId, targetOrgName }, 'User is already a member of the target organization');
      return null;
    }

    // Add user to the organization via WorkOS
    logger.info(
      { workosUserId, email, domain, targetOrgId, targetOrgName, currentOrgId, currentOrgName },
      'Adding user to organization based on email domain'
    );

    await workos.userManagement.createOrganizationMembership({
      userId: workosUserId,
      organizationId: targetOrgId,
      roleSlug: 'member',
    });

    // Update our local organization_memberships table
    // (This will also be updated by the webhook, but we do it here for immediate consistency)
    await pool.query(`
      INSERT INTO organization_memberships (workos_user_id, workos_organization_id, email, created_at, updated_at, synced_at)
      SELECT $1, $2, email, NOW(), NOW(), NOW()
      FROM organization_memberships
      WHERE workos_user_id = $1
      LIMIT 1
      ON CONFLICT (workos_user_id, workos_organization_id) DO NOTHING
    `, [workosUserId, targetOrgId]);

    logger.info(
      { workosUserId, targetOrgId, targetOrgName },
      'User successfully added to organization based on email domain'
    );

    return {
      assigned: true,
      organizationId: targetOrgId,
      organizationName: targetOrgName,
      previousOrgId: currentOrgId,
      previousOrgName: currentOrgName,
    };
  } catch (error) {
    logger.error({ err: error, workosUserId }, 'Error checking/assigning organization by domain');
    return {
      assigned: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Build a map of AAO user emails to WorkOS user IDs
 * Uses local organization_memberships table (synced from WorkOS via webhooks)
 * Used by both GET and POST auto-link-suggested endpoints
 */
async function buildAaoEmailToUserIdMap(): Promise<Map<string, string>> {
  const pool = getPool();
  const aaoEmailToUserId = new Map<string, string>();

  // Query local organization_memberships table instead of calling WorkOS API
  const result = await pool.query<{ email: string; workos_user_id: string }>(`
    SELECT DISTINCT email, workos_user_id
    FROM organization_memberships
    WHERE email IS NOT NULL
  `);

  for (const row of result.rows) {
    aaoEmailToUserId.set(row.email.toLowerCase(), row.workos_user_id);
  }

  return aaoEmailToUserId;
}

/**
 * Create admin Slack routes
 * Returns a router to be mounted at /api/admin/slack
 */
export function createAdminSlackRouter(): Router {
  const router = Router();

  // GET /api/admin/slack/status - Get Slack integration status
  router.get('/status', requireAuth, requireAdmin, async (req, res) => {
    try {
      const configured = isSlackConfigured();
      let connection = null;

      if (configured) {
        connection = await testSlackConnection();
      }

      const syncStatus = await getSyncStatus();

      res.json({
        configured,
        connection,
        stats: syncStatus.stats,
        last_sync: syncStatus.last_sync,
      });
    } catch (error) {
      logger.error({ err: error }, 'Get Slack status error');
      res.status(500).json({
        error: 'Failed to get Slack status',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // GET /api/admin/slack/stats - Get Slack mapping statistics
  router.get('/stats', requireAuth, requireAdmin, async (req, res) => {
    try {
      const stats = await slackDb.getStats();
      res.json(stats);
    } catch (error) {
      logger.error({ err: error }, 'Get Slack stats error');
      res.status(500).json({
        error: 'Failed to get Slack stats',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // POST /api/admin/slack/sync - Trigger user sync from Slack
  router.post('/sync', requireAuth, requireAdmin, async (req, res) => {
    try {
      const result = await syncSlackUsers();
      logger.info(result, 'Slack user sync completed');
      // Invalidate caches since mappings may have changed
      invalidateUnifiedUsersCache();
      invalidateMemberContextCache(); // Clear all - bulk sync affects many users
      res.json(result);
    } catch (error) {
      logger.error({ err: error }, 'Slack sync error');
      res.status(500).json({
        error: 'Failed to sync Slack users',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // GET /api/admin/slack/users - List all Slack users with mapping status
  router.get('/users', requireAuth, requireAdmin, async (req, res) => {
    try {
      const { status, search, limit, offset } = req.query;

      const users = await slackDb.getAllMappings({
        status: status as 'mapped' | 'unmapped' | 'pending_verification' | undefined,
        search: search as string | undefined,
        limit: limit ? parseInt(limit as string, 10) : undefined,
        offset: offset ? parseInt(offset as string, 10) : undefined,
      });

      const stats = await slackDb.getStats();

      res.json({
        users,
        stats,
      });
    } catch (error) {
      logger.error({ err: error }, 'List Slack users error');
      res.status(500).json({
        error: 'Failed to list Slack users',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // POST /api/admin/slack/users/:slackUserId/link - Manually link Slack user to WorkOS user
  router.post('/users/:slackUserId/link', requireAuth, requireAdmin, async (req, res) => {
    try {
      const { slackUserId } = req.params;
      const { workos_user_id } = req.body;
      const adminUser = (req as any).user;

      if (!workos_user_id) {
        return res.status(400).json({
          error: 'Missing workos_user_id',
          message: 'workos_user_id is required in request body',
        });
      }

      // Check if Slack user exists
      const slackUser = await slackDb.getBySlackUserId(slackUserId);
      if (!slackUser) {
        return res.status(404).json({
          error: 'Slack user not found',
          message: `No Slack user found with ID: ${slackUserId}`,
        });
      }

      // Check if WorkOS user is already mapped to another Slack user
      const existingMapping = await slackDb.getByWorkosUserId(workos_user_id);
      if (existingMapping && existingMapping.slack_user_id !== slackUserId) {
        return res.status(409).json({
          error: 'WorkOS user already mapped',
          message: `WorkOS user ${workos_user_id} is already mapped to Slack user ${existingMapping.slack_user_id}`,
        });
      }

      const updated = await slackDb.mapUser({
        slack_user_id: slackUserId,
        workos_user_id,
        mapping_source: 'manual_admin',
        mapped_by_user_id: adminUser?.id,
      });

      logger.info(
        { slackUserId, workos_user_id, adminUserId: adminUser?.id },
        'Slack user manually linked'
      );

      // Sync user to chapters based on their Slack channel memberships
      const chapterSyncResult = await syncUserToChaptersFromSlackChannels(workos_user_id, slackUserId);
      if (chapterSyncResult.chapters_joined > 0) {
        logger.info(
          { slackUserId, workos_user_id, chaptersJoined: chapterSyncResult.chapters_joined },
          'User added to chapters based on Slack channel memberships'
        );
      }

      // Check if user should be assigned to an organization based on their email domain
      // This handles the case where a user with a corporate email (e.g., @scope3.com) is in a
      // personal workspace but should be in the company workspace (e.g., Scope3)
      const orgAssignment = await checkAndAssignOrganizationByDomain(workos_user_id);

      invalidateUnifiedUsersCache();
      invalidateMemberContextCache(slackUserId);

      res.json({
        mapping: updated,
        chapter_sync: chapterSyncResult,
        organization_assignment: orgAssignment,
      });
    } catch (error) {
      logger.error({ err: error }, 'Link Slack user error');
      res.status(500).json({
        error: 'Failed to link Slack user',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // POST /api/admin/slack/users/:slackUserId/unlink - Unlink Slack user from WorkOS user
  router.post('/users/:slackUserId/unlink', requireAuth, requireAdmin, async (req, res) => {
    try {
      const { slackUserId } = req.params;
      const adminUser = (req as any).user;

      const slackUser = await slackDb.getBySlackUserId(slackUserId);
      if (!slackUser) {
        return res.status(404).json({
          error: 'Slack user not found',
          message: `No Slack user found with ID: ${slackUserId}`,
        });
      }

      if (!slackUser.workos_user_id) {
        return res.status(400).json({
          error: 'User not linked',
          message: 'This Slack user is not linked to any AAO account',
        });
      }

      const updated = await slackDb.unmapUser(slackUserId);

      logger.info(
        { slackUserId, previousWorkosUserId: slackUser.workos_user_id, adminUserId: adminUser?.id },
        'Slack user unlinked'
      );

      invalidateUnifiedUsersCache();
      invalidateMemberContextCache(slackUserId);

      res.json({ mapping: updated });
    } catch (error) {
      logger.error({ err: error }, 'Unlink Slack user error');
      res.status(500).json({
        error: 'Failed to unlink Slack user',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // GET /api/admin/slack/unmapped - Get unmapped users eligible for nudges
  router.get('/unmapped', requireAuth, requireAdmin, async (req, res) => {
    try {
      const { limit } = req.query;

      const users = await slackDb.getUnmappedUsers({
        excludeOptedOut: true,
        excludeRecentlyNudged: true,
        limit: limit ? parseInt(limit as string, 10) : 50,
      });

      res.json({ users, count: users.length });
    } catch (error) {
      logger.error({ err: error }, 'Get unmapped Slack users error');
      res.status(500).json({
        error: 'Failed to get unmapped users',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // GET /api/admin/slack/auto-link-suggested - Get suggested email matches
  router.get('/auto-link-suggested', requireAuth, requireAdmin, async (_req, res) => {
    try {
      const unmappedSlack = await slackDb.getUnmappedUsers({
        excludeOptedOut: false,
        excludeRecentlyNudged: false,
      });

      const aaoEmailToUserId = await buildAaoEmailToUserIdMap();
      const mappedWorkosUserIds = await slackDb.getMappedWorkosUserIds();

      const suggestions: Array<{
        slack_user_id: string;
        slack_email: string;
        slack_name: string;
        workos_user_id: string;
      }> = [];

      for (const slackUser of unmappedSlack) {
        if (!slackUser.slack_email) continue;

        const workosUserId = aaoEmailToUserId.get(slackUser.slack_email.toLowerCase());
        if (!workosUserId) continue;

        if (mappedWorkosUserIds.has(workosUserId)) continue;

        suggestions.push({
          slack_user_id: slackUser.slack_user_id,
          slack_email: slackUser.slack_email,
          slack_name: slackUser.slack_real_name || slackUser.slack_display_name || '',
          workos_user_id: workosUserId,
        });
      }

      res.json({ suggestions });
    } catch (error) {
      logger.error({ err: error }, 'Get suggested matches error');
      res.status(500).json({
        error: 'Failed to get suggested matches',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // POST /api/admin/slack/auto-link-suggested - Auto-link all suggested email matches
  router.post('/auto-link-suggested', requireAuth, requireAdmin, async (req, res) => {
    try {
      const adminUser = (req as any).user;

      const unmappedSlack = await slackDb.getUnmappedUsers({
        excludeOptedOut: false,
        excludeRecentlyNudged: false,
      });

      const aaoEmailToUserId = await buildAaoEmailToUserIdMap();
      const mappedWorkosUserIds = await slackDb.getMappedWorkosUserIds();

      let linked = 0;
      const errors: string[] = [];

      let chaptersJoined = 0;
      let orgsAssigned = 0;

      for (const slackUser of unmappedSlack) {
        if (!slackUser.slack_email) continue;

        const workosUserId = aaoEmailToUserId.get(slackUser.slack_email.toLowerCase());
        if (!workosUserId) continue;

        if (mappedWorkosUserIds.has(workosUserId)) continue;

        try {
          await slackDb.mapUser({
            slack_user_id: slackUser.slack_user_id,
            workos_user_id: workosUserId,
            mapping_source: 'email_auto',
            mapped_by_user_id: adminUser?.id,
          });
          linked++;
          mappedWorkosUserIds.add(workosUserId);

          // Sync user to chapters based on their Slack channel memberships
          const chapterSyncResult = await syncUserToChaptersFromSlackChannels(workosUserId, slackUser.slack_user_id);
          chaptersJoined += chapterSyncResult.chapters_joined;

          // Check if user should be assigned to an organization based on their email domain
          const orgAssignment = await checkAndAssignOrganizationByDomain(workosUserId);
          if (orgAssignment?.assigned) {
            orgsAssigned++;
          } else if (orgAssignment?.error) {
            logger.warn(
              { workosUserId, error: orgAssignment.error },
              'Failed to assign organization by domain'
            );
          }
        } catch (err) {
          errors.push(`Failed to link ${slackUser.slack_email}: ${err instanceof Error ? err.message : 'Unknown error'}`);
        }
      }

      logger.info({ linked, chaptersJoined, orgsAssigned, errors: errors.length, adminUserId: adminUser?.id }, 'Auto-linked suggested matches');

      if (linked > 0) {
        invalidateUnifiedUsersCache();
        invalidateMemberContextCache(); // Clear all - bulk operation affects many users
      }

      res.json({
        linked,
        chapters_joined: chaptersJoined,
        organizations_assigned: orgsAssigned,
        errors,
      });
    } catch (error) {
      logger.error({ err: error }, 'Auto-link suggested error');
      res.status(500).json({
        error: 'Failed to auto-link suggested matches',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  return router;
}
