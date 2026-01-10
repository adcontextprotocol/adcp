/**
 * Admin Users routes module
 *
 * Admin-only routes for managing users:
 * - Unified user list (AAO members + Slack users) with engagement data
 * - Working group memberships export
 * - WorkOS user sync (backfill)
 */

import { Router } from 'express';
import { createLogger } from '../../logger.js';
import { requireAuth, requireAdmin } from '../../middleware/auth.js';
import { SlackDatabase } from '../../db/slack-db.js';
import { WorkingGroupDatabase } from '../../db/working-group-db.js';
import { getPool } from '../../db/client.js';
import { backfillOrganizationMemberships, backfillUsers } from '../workos-webhooks.js';
import { sendSlackInviteEmail, hasSlackInviteBeenSent } from '../../notifications/email.js';

const logger = createLogger('admin-users-routes');

/**
 * Create admin users router
 * Returns a router to be mounted at /api/admin/users
 */
export function createAdminUsersRouter(): Router {
  const router = Router();

  // GET /api/admin/users - Unified view of AAO members and Slack users with engagement
  // Uses local organization_memberships table (synced from WorkOS via webhooks) for fast queries
  // Also joins users table for engagement scores and goal selection
  router.get('/', requireAuth, requireAdmin, async (req, res) => {
    const startTime = Date.now();
    try {
      const pool = getPool();
      const slackDb = new SlackDatabase();
      const wgDb = new WorkingGroupDatabase();
      const { search, status, group, goal, lifecycle } = req.query;
      const searchTerm = typeof search === 'string' ? search.toLowerCase().trim() : '';
      const statusFilter = typeof status === 'string' ? status : '';
      const filterByGroup = typeof group === 'string' ? group : undefined;
      const filterByGoal = typeof goal === 'string' ? goal : undefined;
      const filterByLifecycle = typeof lifecycle === 'string' ? lifecycle : undefined;

      // Get all AAO users from local organization_memberships table with engagement data
      const aaoUsersResult = await pool.query<{
        workos_user_id: string;
        email: string;
        first_name: string | null;
        last_name: string | null;
        org_id: string;
        org_name: string;
        engagement_score: number | null;
        excitement_score: number | null;
        lifecycle_stage: string | null;
        goal_key: string | null;
        goal_name: string | null;
        last_activity_at: Date | null;
      }>(`
        SELECT DISTINCT ON (om.workos_user_id)
          om.workos_user_id,
          om.email,
          om.first_name,
          om.last_name,
          om.workos_organization_id AS org_id,
          o.name AS org_name,
          u.engagement_score,
          u.excitement_score,
          u.lifecycle_stage,
          uc.goal_key,
          uc.goal_name,
          GREATEST(sm.last_slack_activity_at, u.updated_at) as last_activity_at
        FROM organization_memberships om
        INNER JOIN organizations o ON om.workos_organization_id = o.workos_organization_id
        LEFT JOIN users u ON u.workos_user_id = om.workos_user_id
        LEFT JOIN unified_contacts_with_goals uc ON uc.workos_user_id = om.workos_user_id
        LEFT JOIN slack_user_mappings sm ON sm.workos_user_id = om.workos_user_id
        ORDER BY om.workos_user_id, o.name
      `);

      // Get all Slack users from our mapping table
      const slackMappings = await slackDb.getAllMappings({
        includeBots: false,
        includeDeleted: false,
      });

      // Build lookup maps for Slack users
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

      // Get working group memberships
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
        // Engagement data
        engagement_score: number | null;
        excitement_score: number | null;
        lifecycle_stage: string | null;
        goal_key: string | null;
        goal_name: string | null;
        last_activity_at: Date | null;
      };

      const unifiedUsers: UnifiedUser[] = [];
      const processedSlackIds = new Set<string>();

      // Process AAO users
      for (const user of aaoUsersResult.rows) {
        const fullName = [user.first_name, user.last_name].filter(Boolean).join(' ') || '';

        // Check if user has Slack mapping
        const slackMapping = slackByWorkosId.get(user.workos_user_id);
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
        const workingGroups = userWorkingGroups.get(user.workos_user_id) || [];

        // Apply group filter
        if (filterByGroup) {
          const hasGroup = workingGroups.some(g => g.id === filterByGroup);
          if (!hasGroup) continue;
        }

        // Apply goal filter
        if (filterByGoal && user.goal_key !== filterByGoal) continue;

        // Apply lifecycle filter
        if (filterByLifecycle && user.lifecycle_stage !== filterByLifecycle) continue;

        // Apply search filter
        if (searchTerm) {
          const matches =
            user.email.toLowerCase().includes(searchTerm) ||
            fullName.toLowerCase().includes(searchTerm) ||
            user.org_name.toLowerCase().includes(searchTerm) ||
            (slackInfo.slack_email?.toLowerCase().includes(searchTerm)) ||
            (slackInfo.slack_display_name?.toLowerCase().includes(searchTerm)) ||
            (slackInfo.slack_real_name?.toLowerCase().includes(searchTerm));
          if (!matches) continue;
        }

        unifiedUsers.push({
          workos_user_id: user.workos_user_id,
          email: user.email,
          name: fullName || user.email,
          org_id: user.org_id,
          org_name: user.org_name,
          ...slackInfo,
          mapping_status: mappingStatus,
          mapping_source: slackMapping?.mapping_source || null,
          working_groups: workingGroups,
          // Engagement data
          engagement_score: user.engagement_score,
          excitement_score: user.excitement_score,
          lifecycle_stage: user.lifecycle_stage,
          goal_key: user.goal_key,
          goal_name: user.goal_name,
          last_activity_at: user.last_activity_at,
        });
      }

      // Get Slack-only contacts from unified_contacts_with_goals for engagement data
      const slackOnlyContactsResult = await pool.query<{
        slack_user_id: string;
        engagement_score: number | null;
        excitement_score: number | null;
        lifecycle_stage: string | null;
        goal_key: string | null;
        goal_name: string | null;
        last_activity_at: Date | null;
      }>(`
        SELECT
          slack_user_id,
          engagement_score,
          excitement_score,
          lifecycle_stage,
          goal_key,
          goal_name,
          COALESCE(last_slack_activity_at, last_conversation_at) as last_activity_at
        FROM unified_contacts_with_goals
        WHERE contact_type = 'slack_only' AND slack_user_id IS NOT NULL
      `);
      const slackOnlyEngagement = new Map(
        slackOnlyContactsResult.rows.map(r => [r.slack_user_id, r])
      );

      // Add Slack-only users (those not linked to any AAO account)
      for (const slackUser of slackMappings) {
        if (processedSlackIds.has(slackUser.slack_user_id)) continue;
        if (slackUser.workos_user_id) continue;

        // Check if this Slack user's email matches an AAO user
        if (slackUser.slack_email) {
          const hasAaoMatch = aaoUsersResult.rows.some(
            u => u.email.toLowerCase() === slackUser.slack_email!.toLowerCase()
          );
          if (hasAaoMatch) continue;
        }

        // Skip if filtering by group (Slack-only users have no groups)
        if (filterByGroup) continue;

        // Get engagement data for this Slack user
        const engagement = slackOnlyEngagement.get(slackUser.slack_user_id);

        // Apply goal filter
        if (filterByGoal && engagement?.goal_key !== filterByGoal) continue;

        // Apply lifecycle filter
        if (filterByLifecycle && engagement?.lifecycle_stage !== filterByLifecycle) continue;

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
          // Engagement data from unified contacts
          engagement_score: engagement?.engagement_score ?? null,
          excitement_score: engagement?.excitement_score ?? null,
          lifecycle_stage: engagement?.lifecycle_stage ?? null,
          goal_key: engagement?.goal_key ?? null,
          goal_name: engagement?.goal_name ?? null,
          last_activity_at: engagement?.last_activity_at ?? null,
        });
      }

      // Calculate stats before filtering by status
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

      // Sort by status then name
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
        aaoUsers: aaoUsersResult.rows.length,
        slackMappings: slackMappings.length,
        stats,
        durationMs: duration,
      }, 'Admin users endpoint: completed');

      res.json({ users: filteredUsers, stats });
    } catch (error) {
      const duration = Date.now() - startTime;
      logger.error({ err: error, durationMs: duration }, 'Get admin users error');
      res.status(500).json({
        error: 'Failed to get users',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // GET /api/admin/users/memberships - Get all working group memberships (for export)
  router.get('/memberships', requireAuth, requireAdmin, async (req, res) => {
    try {
      const wgDb = new WorkingGroupDatabase();
      const memberships = await wgDb.getAllMemberships();

      // Check if CSV export is requested
      const format = req.query.format;
      if (format === 'csv') {
        const csv = [
          'User Name,Email,Organization,Working Group,Joined At',
          ...memberships.map(m =>
            `"${m.user_name || ''}","${m.user_email || ''}","${m.user_org_name || ''}","${m.working_group_name}","${m.joined_at ? new Date(m.joined_at).toISOString().split('T')[0] : ''}"`
          ),
        ].join('\n');

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename="working-group-memberships.csv"');
        return res.send(csv);
      }

      res.json({ memberships });
    } catch (error) {
      logger.error({ err: error }, 'Get memberships export error');
      res.status(500).json({
        error: 'Failed to get memberships',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // POST /api/admin/users/sync-workos - Backfill organization_memberships table from WorkOS
  // Call this once after setting up the webhook to populate existing data
  router.post('/sync-workos', requireAuth, requireAdmin, async (_req, res) => {
    try {
      const result = await backfillOrganizationMemberships();

      res.json({
        success: result.errors.length === 0,
        orgs_processed: result.orgsProcessed,
        memberships_created: result.membershipsCreated,
        errors: result.errors,
      });
    } catch (error) {
      logger.error({ err: error }, 'Backfill memberships error');
      res.status(500).json({
        error: 'Failed to backfill memberships',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // POST /api/admin/users/sync-users - Backfill users table from WorkOS
  // Populates canonical users table with WorkOS user data for engagement tracking
  router.post('/sync-users', requireAuth, requireAdmin, async (_req, res) => {
    try {
      const result = await backfillUsers();

      res.json({
        success: result.errors.length === 0,
        users_processed: result.usersProcessed,
        users_created: result.usersCreated,
        errors: result.errors,
      });
    } catch (error) {
      logger.error({ err: error }, 'Backfill users error');
      res.status(500).json({
        error: 'Failed to backfill users',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // GET /api/admin/users/website-only - Get users who have website accounts but not Slack
  // These are candidates for Slack invite emails
  router.get('/website-only', requireAuth, requireAdmin, async (_req, res) => {
    try {
      const pool = getPool();

      // Get users who:
      // 1. Have an organization membership (website account)
      // 2. Are NOT linked to a Slack account
      // 3. Don't have a matching email in slack_user_mappings (not in Slack at all)
      const result = await pool.query<{
        workos_user_id: string;
        email: string;
        first_name: string | null;
        last_name: string | null;
        org_name: string;
        workos_organization_id: string;
        slack_invite_sent: boolean;
      }>(`
        SELECT DISTINCT ON (om.workos_user_id)
          om.workos_user_id,
          om.email,
          om.first_name,
          om.last_name,
          o.name as org_name,
          om.workos_organization_id,
          EXISTS (
            SELECT 1 FROM email_events ee
            WHERE ee.workos_user_id = om.workos_user_id
              AND ee.email_type = 'slack_invite'
              AND ee.sent_at IS NOT NULL
          ) as slack_invite_sent
        FROM organization_memberships om
        INNER JOIN organizations o ON om.workos_organization_id = o.workos_organization_id
        LEFT JOIN slack_user_mappings sm_linked ON sm_linked.workos_user_id = om.workos_user_id
        LEFT JOIN slack_user_mappings sm_email ON LOWER(sm_email.slack_email) = LOWER(om.email)
        WHERE sm_linked.workos_user_id IS NULL  -- Not linked to Slack
          AND sm_email.slack_user_id IS NULL    -- Email not in Slack either
        ORDER BY om.workos_user_id, o.name
      `);

      const users = result.rows.map(row => ({
        workos_user_id: row.workos_user_id,
        email: row.email,
        name: [row.first_name, row.last_name].filter(Boolean).join(' ') || null,
        first_name: row.first_name,
        org_name: row.org_name,
        workos_organization_id: row.workos_organization_id,
        slack_invite_sent: row.slack_invite_sent,
      }));

      res.json({
        users,
        count: users.length,
        not_invited_count: users.filter(u => !u.slack_invite_sent).length,
      });
    } catch (error) {
      logger.error({ err: error }, 'Get website-only users error');
      res.status(500).json({
        error: 'Failed to get website-only users',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // POST /api/admin/users/send-slack-invites - Send Slack invite emails to website-only users
  // Can send to all uninvited users or specific user IDs
  router.post('/send-slack-invites', requireAuth, requireAdmin, async (req, res) => {
    try {
      const { user_ids, send_to_all } = req.body;
      const pool = getPool();

      let targetUsers: Array<{
        workos_user_id: string;
        email: string;
        first_name: string | null;
        workos_organization_id: string;
      }>;

      if (send_to_all) {
        // Get all website-only users who haven't been sent an invite
        const result = await pool.query<{
          workos_user_id: string;
          email: string;
          first_name: string | null;
          workos_organization_id: string;
        }>(`
          SELECT DISTINCT ON (om.workos_user_id)
            om.workos_user_id,
            om.email,
            om.first_name,
            om.workos_organization_id
          FROM organization_memberships om
          LEFT JOIN slack_user_mappings sm_linked ON sm_linked.workos_user_id = om.workos_user_id
          LEFT JOIN slack_user_mappings sm_email ON LOWER(sm_email.slack_email) = LOWER(om.email)
          WHERE sm_linked.workos_user_id IS NULL
            AND sm_email.slack_user_id IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM email_events ee
              WHERE ee.workos_user_id = om.workos_user_id
                AND ee.email_type = 'slack_invite'
                AND ee.sent_at IS NOT NULL
            )
          ORDER BY om.workos_user_id
        `);
        targetUsers = result.rows;
      } else if (Array.isArray(user_ids) && user_ids.length > 0) {
        // Get specific users
        const result = await pool.query<{
          workos_user_id: string;
          email: string;
          first_name: string | null;
          workos_organization_id: string;
        }>(`
          SELECT DISTINCT ON (om.workos_user_id)
            om.workos_user_id,
            om.email,
            om.first_name,
            om.workos_organization_id
          FROM organization_memberships om
          WHERE om.workos_user_id = ANY($1)
          ORDER BY om.workos_user_id
        `, [user_ids]);
        targetUsers = result.rows;
      } else {
        return res.status(400).json({
          error: 'Invalid request',
          message: 'Either send_to_all: true or user_ids array is required',
        });
      }

      let sent = 0;
      let skipped = 0;
      let failed = 0;
      const errors: string[] = [];

      for (const user of targetUsers) {
        try {
          const success = await sendSlackInviteEmail({
            to: user.email,
            firstName: user.first_name || undefined,
            workosUserId: user.workos_user_id,
            workosOrganizationId: user.workos_organization_id,
          });

          if (success) {
            // Check if it was actually sent or skipped (already sent)
            const wasPreviouslySent = await hasSlackInviteBeenSent(user.workos_user_id);
            if (wasPreviouslySent) {
              skipped++;
            } else {
              sent++;
            }
          } else {
            failed++;
            errors.push(`Failed to send to ${user.email}`);
          }
        } catch (error) {
          failed++;
          errors.push(`Error sending to ${user.email}: ${error instanceof Error ? error.message : 'Unknown'}`);
        }

        // Small delay between sends to avoid rate limiting
        if (targetUsers.length > 1) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }

      logger.info({ sent, skipped, failed, total: targetUsers.length }, 'Slack invite emails batch complete');

      res.json({
        sent,
        skipped,
        failed,
        total: targetUsers.length,
        errors: errors.length > 0 ? errors.slice(0, 10) : undefined, // Limit error list
      });
    } catch (error) {
      logger.error({ err: error }, 'Send Slack invites error');
      res.status(500).json({
        error: 'Failed to send Slack invites',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  return router;
}
