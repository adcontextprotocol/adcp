/**
 * Admin Slack routes module
 *
 * Admin-only routes for managing Slack integration:
 * - Status and stats
 * - User sync
 * - User mapping (link/unlink)
 * - Auto-link suggestions
 * - Unified users view
 */

import { Router } from 'express';
import { WorkOS } from '@workos-inc/node';
import { createLogger } from '../../logger.js';
import { requireAuth, requireAdmin } from '../../middleware/auth.js';
import { SlackDatabase } from '../../db/slack-db.js';
import { OrganizationDatabase } from '../../db/organization-db.js';
import { WorkingGroupDatabase } from '../../db/working-group-db.js';
import { isSlackConfigured, testSlackConnection } from '../../slack/client.js';
import { syncSlackUsers, getSyncStatus } from '../../slack/sync.js';
import {
  getUnifiedUsersCache,
  setUnifiedUsersCache,
  invalidateUnifiedUsersCache,
  type WorkOSUserInfo,
} from '../../cache/unified-users.js';
import { invalidateMemberContextCache } from '../../addie/index.js';

const logger = createLogger('admin-slack-routes');

const slackDb = new SlackDatabase();

// Initialize WorkOS client only if authentication is enabled
const AUTH_ENABLED = !!(
  process.env.WORKOS_API_KEY &&
  process.env.WORKOS_CLIENT_ID &&
  process.env.WORKOS_COOKIE_PASSWORD &&
  process.env.WORKOS_COOKIE_PASSWORD.length >= 32
);

const workos = AUTH_ENABLED
  ? new WorkOS(process.env.WORKOS_API_KEY!, {
      clientId: process.env.WORKOS_CLIENT_ID!,
    })
  : null;

/**
 * Build a map of AAO user emails to WorkOS user IDs
 * Used by both GET and POST auto-link-suggested endpoints
 */
async function buildAaoEmailToUserIdMap(): Promise<Map<string, string>> {
  const aaoEmailToUserId = new Map<string, string>();

  if (!workos) {
    return aaoEmailToUserId;
  }

  const orgDatabase = new OrganizationDatabase();
  const orgs = await orgDatabase.listOrganizations();

  // Use listUsers with organizationId filter - returns email directly
  for (const org of orgs) {
    try {
      let after: string | undefined;
      do {
        const usersResponse = await workos.userManagement.listUsers({
          organizationId: org.workos_organization_id,
          limit: 100,
          after,
        });

        for (const user of usersResponse.data) {
          if (user.email) {
            aaoEmailToUserId.set(user.email.toLowerCase(), user.id);
          }
        }

        after = usersResponse.listMetadata?.after || undefined;
      } while (after);
    } catch (orgErr) {
      logger.warn({ err: orgErr, orgId: org.workos_organization_id }, 'Failed to fetch users for organization');
    }
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

      invalidateUnifiedUsersCache();
      invalidateMemberContextCache(slackUserId);

      res.json({ mapping: updated });
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

  // GET /api/admin/slack/unified - Get unified view of all AAO users + all Slack users
  router.get('/unified', requireAuth, requireAdmin, async (req, res) => {
    const startTime = Date.now();
    try {
      if (!workos) {
        return res.status(503).json({ error: 'Authentication not configured' });
      }

      const { search, status, group } = req.query;
      const searchTerm = typeof search === 'string' ? search.toLowerCase() : '';
      const statusFilter = typeof status === 'string' ? status : '';
      const filterByGroup = typeof group === 'string' ? group : undefined;

      logger.info({ search, status, group }, 'Unified users endpoint: starting');

      const orgDatabase = new OrganizationDatabase();
      const wgDb = new WorkingGroupDatabase();

      // Get all working group memberships from our database
      const allWgMemberships = await wgDb.getAllMemberships();

      // Create a map of user_id -> working groups
      const userWorkingGroups = new Map<string, Array<{
        id: string;
        name: string;
        slug: string;
        is_private: boolean;
      }>>();

      for (const m of allWgMemberships) {
        const groups = userWorkingGroups.get(m.user_id) || [];
        groups.push({
          id: m.working_group_id,
          name: m.working_group_name,
          slug: m.working_group_slug || '',
          is_private: m.is_private || false,
        });
        userWorkingGroups.set(m.user_id, groups);
      }

      // Get all Slack users from our mapping table
      const slackMappings = await slackDb.getAllMappings({
        includeBots: false,
        includeDeleted: false,
      });
      const slackByWorkosId = new Map(
        slackMappings
          .filter(m => m.workos_user_id)
          .map(m => [m.workos_user_id!, m])
      );
      const slackByEmail = new Map(
        slackMappings
          .filter(m => m.slack_email)
          .map(m => [m.slack_email!.toLowerCase(), m])
      );

      // Build unified user list
      type UnifiedUser = {
        workos_user_id: string | null;
        email: string | null;
        name: string | null;
        org_id: string | null;
        org_name: string | null;
        slack_user_id: string | null;
        slack_email: string | null;
        slack_display_name: string | null;
        slack_real_name: string | null;
        mapping_status: 'mapped' | 'slack_only' | 'aao_only' | 'suggested_match';
        mapping_source: string | null;
        working_groups: Array<{
          id: string;
          name: string;
          slug: string;
          is_private: boolean;
        }>;
      };

      const unifiedUsers: UnifiedUser[] = [];
      const processedSlackIds = new Set<string>();

      // Get all AAO users from WorkOS
      const orgs = await orgDatabase.listOrganizations();
      const seenUserIds = new Set<string>();

      // Check cache first
      let cachedUsersByOrg = getUnifiedUsersCache();
      let cacheHit = cachedUsersByOrg !== null;

      if (!cachedUsersByOrg) {
        // Build cache - fetch all users from WorkOS
        cachedUsersByOrg = new Map<string, WorkOSUserInfo[]>();

        for (const org of orgs) {
          try {
            const orgUsers: WorkOSUserInfo[] = [];
            let after: string | undefined;
            do {
              const usersResponse = await workos.userManagement.listUsers({
                organizationId: org.workos_organization_id,
                limit: 100,
                after,
              });

              for (const user of usersResponse.data) {
                orgUsers.push({
                  id: user.id,
                  email: user.email,
                  firstName: user.firstName,
                  lastName: user.lastName,
                });
              }

              after = usersResponse.listMetadata?.after || undefined;
            } while (after);

            cachedUsersByOrg.set(org.workos_organization_id, orgUsers);
          } catch (orgErr) {
            logger.warn({ orgId: org.workos_organization_id, err: orgErr }, 'Failed to fetch users for org from WorkOS');
          }
        }

        setUnifiedUsersCache(cachedUsersByOrg);
      }

      logger.info({ cacheHit, orgCount: orgs.length }, 'Unified users: WorkOS user fetch');

      // Process cached users
      for (const org of orgs) {
        const orgUsers = cachedUsersByOrg.get(org.workos_organization_id) || [];

        for (const user of orgUsers) {
          if (seenUserIds.has(user.id)) continue;
          const fullName = [user.firstName, user.lastName].filter(Boolean).join(' ') || '';

          // Check if user has Slack mapping
          const slackMapping = slackByWorkosId.get(user.id);
          const suggestedSlack = !slackMapping ? slackByEmail.get(user.email.toLowerCase()) : null;

          let mappingStatus: UnifiedUser['mapping_status'] = 'aao_only';
          let slackInfo = {
            slack_user_id: null as string | null,
            slack_email: null as string | null,
            slack_display_name: null as string | null,
            slack_real_name: null as string | null,
          };

          if (slackMapping) {
            mappingStatus = 'mapped';
            slackInfo = {
              slack_user_id: slackMapping.slack_user_id,
              slack_email: slackMapping.slack_email,
              slack_display_name: slackMapping.slack_display_name,
              slack_real_name: slackMapping.slack_real_name,
            };
            processedSlackIds.add(slackMapping.slack_user_id);
          } else if (suggestedSlack && suggestedSlack.mapping_status === 'unmapped') {
            mappingStatus = 'suggested_match';
            slackInfo = {
              slack_user_id: suggestedSlack.slack_user_id,
              slack_email: suggestedSlack.slack_email,
              slack_display_name: suggestedSlack.slack_display_name,
              slack_real_name: suggestedSlack.slack_real_name,
            };
          }

          // Get working groups for this user
          const workingGroups = userWorkingGroups.get(user.id) || [];

          // Apply group filter
          if (filterByGroup) {
            const hasGroup = workingGroups.some(g => g.id === filterByGroup);
            if (!hasGroup) continue;
          }

          // Apply search filter
          if (searchTerm) {
            const matches =
              user.email.toLowerCase().includes(searchTerm) ||
              fullName.toLowerCase().includes(searchTerm) ||
              org.name.toLowerCase().includes(searchTerm) ||
              (slackInfo.slack_email?.toLowerCase().includes(searchTerm)) ||
              (slackInfo.slack_display_name?.toLowerCase().includes(searchTerm)) ||
              (slackInfo.slack_real_name?.toLowerCase().includes(searchTerm));
            if (!matches) continue;
          }

          seenUserIds.add(user.id);
          unifiedUsers.push({
            workos_user_id: user.id,
            email: user.email,
            name: fullName || user.email,
            org_id: org.workos_organization_id,
            org_name: org.name,
            ...slackInfo,
            mapping_status: mappingStatus,
            mapping_source: slackMapping?.mapping_source || null,
            working_groups: workingGroups,
          });
        }
      }

      logger.info({
        totalOrgs: orgs.length,
        uniqueUsers: seenUserIds.size,
        slackMappings: slackMappings.length,
      }, 'Unified users endpoint: completed WorkOS data fetch');

      // Add Slack-only users
      for (const slackUser of slackMappings) {
        if (processedSlackIds.has(slackUser.slack_user_id)) continue;
        if (slackUser.workos_user_id) continue;

        if (slackUser.slack_email && slackByEmail.has(slackUser.slack_email.toLowerCase())) {
          const wasProcessed = [...seenUserIds].some(userId => {
            const mapping = slackByWorkosId.get(userId);
            return mapping?.slack_user_id === slackUser.slack_user_id;
          });
          if (wasProcessed) continue;
        }

        if (filterByGroup) continue;

        if (searchTerm) {
          const matches =
            (slackUser.slack_email?.toLowerCase().includes(searchTerm)) ||
            (slackUser.slack_display_name?.toLowerCase().includes(searchTerm)) ||
            (slackUser.slack_real_name?.toLowerCase().includes(searchTerm));
          if (!matches) continue;
        }

        unifiedUsers.push({
          workos_user_id: null,
          email: null,
          name: null,
          org_id: null,
          org_name: null,
          slack_user_id: slackUser.slack_user_id,
          slack_email: slackUser.slack_email,
          slack_display_name: slackUser.slack_display_name,
          slack_real_name: slackUser.slack_real_name,
          mapping_status: 'slack_only',
          mapping_source: null,
          working_groups: [],
        });
      }

      // Get stats
      const stats = {
        total: unifiedUsers.length,
        mapped: unifiedUsers.filter(u => u.mapping_status === 'mapped').length,
        suggested: unifiedUsers.filter(u => u.mapping_status === 'suggested_match').length,
        aao_only: unifiedUsers.filter(u => u.mapping_status === 'aao_only').length,
        slack_only: unifiedUsers.filter(u => u.mapping_status === 'slack_only').length,
      };

      // Apply status filter
      let filteredUsers = unifiedUsers;
      if (statusFilter) {
        filteredUsers = unifiedUsers.filter(u => u.mapping_status === statusFilter);
      }

      // Sort
      const statusOrder = { mapped: 0, suggested_match: 1, aao_only: 2, slack_only: 3 };
      filteredUsers.sort((a, b) => {
        const statusDiff = statusOrder[a.mapping_status] - statusOrder[b.mapping_status];
        if (statusDiff !== 0) return statusDiff;
        const aName = a.name || a.slack_real_name || a.slack_display_name || a.email || a.slack_email || '';
        const bName = b.name || b.slack_real_name || b.slack_display_name || b.email || b.slack_email || '';
        return aName.localeCompare(bName);
      });

      const duration = Date.now() - startTime;
      logger.info({
        totalUsers: filteredUsers.length,
        stats,
        durationMs: duration,
      }, 'Unified users endpoint: completed');

      res.json({ users: filteredUsers, stats });
    } catch (error) {
      const duration = Date.now() - startTime;
      logger.error({ err: error, durationMs: duration }, 'Get unified Slack/AAO users error');
      res.status(500).json({
        error: 'Failed to get unified users',
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
        } catch (err) {
          errors.push(`Failed to link ${slackUser.slack_email}: ${err instanceof Error ? err.message : 'Unknown error'}`);
        }
      }

      logger.info({ linked, errors: errors.length, adminUserId: adminUser?.id }, 'Auto-linked suggested matches');

      if (linked > 0) {
        invalidateUnifiedUsersCache();
        invalidateMemberContextCache(); // Clear all - bulk operation affects many users
      }

      res.json({
        linked,
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
