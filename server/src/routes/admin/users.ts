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
import { requireAuth, requireAdmin, invalidateSessionsForUsers } from '../../middleware/auth.js';
import { SlackDatabase } from '../../db/slack-db.js';
import { WorkingGroupDatabase } from '../../db/working-group-db.js';
import { getPool } from '../../db/client.js';
import { backfillOrganizationMemberships, backfillUsers, backfillOrganizationDomains } from '../workos-webhooks.js';
import { sendSlackInviteEmail, hasSlackInviteBeenSent } from '../../notifications/email.js';
import { getWorkos } from '../../auth/workos-client.js';
import { mergeUsers } from '../../db/user-merge-db.js';

const logger = createLogger('admin-users-routes');

/**
 * Linear-time plausibility check for an email-shaped string. Avoids the
 * polynomial backtracking that catch-all email regexes can hit on adversarial
 * input. We don't try to be RFC-correct — WorkOS validates real syntax
 * upstream; this is just a "does it look like an email?" gate.
 */
function isPlausibleEmail(s: string): boolean {
  if (s.length < 3 || /\s/.test(s)) return false;
  const at = s.indexOf('@');
  if (at < 1 || at !== s.lastIndexOf('@')) return false;
  const dot = s.indexOf('.', at + 1);
  if (dot < 0 || dot === at + 1 || dot === s.length - 1) return false;
  return true;
}

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
      const { search, status, group, goal, lifecycle, stage } = req.query;
      const searchTerm = typeof search === 'string' ? search.toLowerCase().trim() : '';
      const statusFilter = typeof status === 'string' ? status : '';
      const filterByGroup = typeof group === 'string' ? group : undefined;
      const filterByGoal = typeof goal === 'string' ? goal : undefined;
      const filterByLifecycle = typeof lifecycle === 'string' ? lifecycle : undefined;
      const filterByStage = typeof stage === 'string' ? stage : undefined;

      // Get all AAO users from local organization_memberships table with community points
      const aaoUsersResult = await pool.query<{
        workos_user_id: string;
        email: string;
        first_name: string | null;
        last_name: string | null;
        org_id: string;
        org_name: string;
        is_personal: boolean;
        community_points: number;
        lifecycle_stage: string | null;
        relationship_stage: string | null;
        goal_key: string | null;
        goal_name: string | null;
        last_activity_at: Date | null;
        marketing_opt_in: boolean | null;
      }>(`
        SELECT DISTINCT ON (om.workos_user_id)
          om.workos_user_id,
          om.email,
          om.first_name,
          om.last_name,
          om.workos_organization_id AS org_id,
          o.name AS org_name,
          COALESCE(o.is_personal, false) AS is_personal,
          COALESCE(cp.total_points, 0)::int AS community_points,
          u.lifecycle_stage,
          pr.stage AS relationship_stage,
          uc.goal_key,
          uc.goal_name,
          GREATEST(sm.last_slack_activity_at, u.updated_at) as last_activity_at,
          ep.marketing_opt_in
        FROM organization_memberships om
        INNER JOIN organizations o ON om.workos_organization_id = o.workos_organization_id
        LEFT JOIN users u ON u.workos_user_id = om.workos_user_id
        LEFT JOIN person_relationships pr ON pr.workos_user_id = om.workos_user_id
        LEFT JOIN unified_contacts_with_goals uc ON uc.workos_user_id = om.workos_user_id
        LEFT JOIN slack_user_mappings sm ON sm.workos_user_id = om.workos_user_id
        LEFT JOIN user_email_preferences ep ON ep.workos_user_id = om.workos_user_id
        LEFT JOIN (
          SELECT workos_user_id, SUM(points) AS total_points
          FROM community_points
          GROUP BY workos_user_id
        ) cp ON cp.workos_user_id = om.workos_user_id
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
        is_personal: boolean;
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
        community_points: number;
        lifecycle_stage: string | null;
        relationship_stage: string | null;
        goal_key: string | null;
        goal_name: string | null;
        last_activity_at: Date | null;
        marketing_opt_in: boolean | null;
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

        // Apply relationship stage filter
        if (filterByStage && user.relationship_stage !== filterByStage) continue;

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
          is_personal: user.is_personal,
          ...slackInfo,
          mapping_status: mappingStatus,
          mapping_source: slackMapping?.mapping_source || null,
          working_groups: workingGroups,
          // Engagement data
          community_points: user.community_points,
          lifecycle_stage: user.lifecycle_stage,
          relationship_stage: user.relationship_stage,
          goal_key: user.goal_key,
          goal_name: user.goal_name,
          last_activity_at: user.last_activity_at,
          marketing_opt_in: user.marketing_opt_in ?? null,
        });
      }

      // Get relationship stages for Slack-only users
      const slackOnlyRelStagesResult = await pool.query<{
        slack_user_id: string;
        stage: string;
      }>(`
        SELECT slack_user_id, stage
        FROM person_relationships
        WHERE slack_user_id IS NOT NULL AND workos_user_id IS NULL
      `);
      const slackOnlyRelStages = new Map(
        slackOnlyRelStagesResult.rows.map(r => [r.slack_user_id, r.stage])
      );

      // Get Slack-only contacts from unified_contacts_with_goals for goal/lifecycle data
      const slackOnlyContactsResult = await pool.query<{
        slack_user_id: string;
        lifecycle_stage: string | null;
        goal_key: string | null;
        goal_name: string | null;
        last_activity_at: Date | null;
      }>(`
        SELECT
          slack_user_id,
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

      // Add Slack users not already processed (Slack-only OR mapped individuals without org)
      for (const slackUser of slackMappings) {
        if (processedSlackIds.has(slackUser.slack_user_id)) continue;

        // Determine if this is a mapped individual (has workos_user_id but no org membership)
        // or a true Slack-only user (no workos_user_id)
        const isMappedIndividual = !!slackUser.workos_user_id;

        // Check if this Slack user's email matches an AAO user (skip to avoid duplicates)
        if (slackUser.slack_email && !isMappedIndividual) {
          const hasAaoMatch = aaoUsersResult.rows.some(
            u => u.email.toLowerCase() === slackUser.slack_email!.toLowerCase()
          );
          if (hasAaoMatch) continue;
        }

        // Skip if filtering by group (these users have no groups)
        if (filterByGroup) continue;

        // Get engagement data for this Slack user
        const engagement = slackOnlyEngagement.get(slackUser.slack_user_id);

        // Apply goal filter
        if (filterByGoal && engagement?.goal_key !== filterByGoal) continue;

        // Apply lifecycle filter
        if (filterByLifecycle && engagement?.lifecycle_stage !== filterByLifecycle) continue;

        // Apply relationship stage filter
        const relStage = slackOnlyRelStages.get(slackUser.slack_user_id) ?? null;
        if (filterByStage && relStage !== filterByStage) continue;

        if (searchTerm) {
          const matches =
            (slackUser.slack_email?.toLowerCase().includes(searchTerm)) ||
            (slackUser.slack_display_name?.toLowerCase().includes(searchTerm)) ||
            (slackUser.slack_real_name?.toLowerCase().includes(searchTerm));
          if (!matches) continue;
        }

        unifiedUsers.push({
          workos_user_id: isMappedIndividual ? slackUser.workos_user_id : null,
          email: slackUser.slack_email,
          name: slackUser.slack_real_name || slackUser.slack_display_name || null,
          org_id: null,
          org_name: null,
          is_personal: false,
          slack_user_id: slackUser.slack_user_id,
          slack_email: slackUser.slack_email,
          slack_display_name: slackUser.slack_display_name,
          slack_real_name: slackUser.slack_real_name,
          mapping_status: isMappedIndividual ? 'mapped' : 'slack_only',
          mapping_source: isMappedIndividual ? slackUser.mapping_source : null,
          working_groups: [],
          // Engagement data — Slack-only users have no community_points (requires WorkOS account)
          community_points: 0,
          lifecycle_stage: engagement?.lifecycle_stage ?? null,
          relationship_stage: relStage,
          goal_key: engagement?.goal_key ?? null,
          goal_name: engagement?.goal_name ?? null,
          last_activity_at: engagement?.last_activity_at ?? null,
          marketing_opt_in: slackUser.pending_marketing_opt_in ?? null,
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
      });
    }
  });

  // POST /api/admin/users/sync-workos - Backfill organization_memberships table from WorkOS
  // Upserts active memberships and removes stale local rows not found in WorkOS
  router.post('/sync-workos', requireAuth, requireAdmin, async (_req, res) => {
    try {
      const result = await backfillOrganizationMemberships();

      res.json({
        success: result.errors.length === 0,
        orgs_processed: result.orgsProcessed,
        memberships_created: result.membershipsCreated,
        memberships_removed: result.membershipsRemoved,
        errors: result.errors,
      });
    } catch (error) {
      logger.error({ err: error }, 'Backfill memberships error');
      res.status(500).json({
        error: 'Failed to backfill memberships',
      });
    }
  });

  // POST /api/admin/users/sync-users - Backfill users table from WorkOS
  // Upserts users and removes stale local rows not found in any WorkOS org
  router.post('/sync-users', requireAuth, requireAdmin, async (_req, res) => {
    try {
      const result = await backfillUsers();

      res.json({
        success: result.errors.length === 0,
        users_processed: result.usersProcessed,
        users_created: result.usersCreated,
        users_removed: result.usersRemoved,
        users_skipped: result.usersSkipped,
        errors: result.errors,
      });
    } catch (error) {
      logger.error({ err: error }, 'Backfill users error');
      res.status(500).json({
        error: 'Failed to backfill users',
      });
    }
  });

  // POST /api/admin/users/sync-domains - Backfill organization_domains table from WorkOS
  // Fetches each org's domains from WorkOS and syncs to local table
  router.post('/sync-domains', requireAuth, requireAdmin, async (_req, res) => {
    try {
      const result = await backfillOrganizationDomains();

      res.json({
        success: result.errors.length === 0,
        orgs_processed: result.orgsProcessed,
        domains_synced: result.domainsSynced,
        errors: result.errors,
      });
    } catch (error) {
      logger.error({ err: error }, 'Backfill domains error');
      res.status(500).json({
        error: 'Failed to backfill domains',
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
          errors.push(`Failed to send to ${user.email}`);
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
      });
    }
  });

  // PUT /api/admin/users/:userId/name - Update a user's display name
  router.put('/:userId/name', requireAuth, requireAdmin, async (req, res) => {
    try {
      const { userId } = req.params;
      const firstName = (req.body.first_name as string)?.trim();
      const lastName = (req.body.last_name as string | null)?.trim() || null;

      if (!firstName) {
        return res.status(400).json({ error: 'first_name is required' });
      }

      const pool = getPool();

      // Verify user exists
      const userResult = await pool.query(
        `SELECT email, first_name, last_name FROM users WHERE workos_user_id = $1`,
        [userId]
      );

      if (userResult.rows.length === 0) {
        return res.status(404).json({ error: 'User not found' });
      }

      const oldName = [userResult.rows[0].first_name, userResult.rows[0].last_name].filter(Boolean).join(' ') || '(empty)';

      // Update users table
      await pool.query(
        `UPDATE users SET first_name = $1, last_name = $2, updated_at = NOW() WHERE workos_user_id = $3`,
        [firstName, lastName, userId]
      );

      // Update across all memberships
      await pool.query(
        `UPDATE organization_memberships SET first_name = $1, last_name = $2, updated_at = NOW() WHERE workos_user_id = $3`,
        [firstName, lastName, userId]
      );

      logger.info({
        adminEmail: req.user!.email,
        userId,
        oldName,
        newName: [firstName, lastName].filter(Boolean).join(' '),
      }, 'Admin updated user display name');

      res.json({ first_name: firstName, last_name: lastName });
    } catch (error) {
      logger.error({ err: error }, 'Admin update user name error');
      res.status(500).json({ error: 'Failed to update name' });
    }
  });

  // POST /api/admin/users/:userId/linked-emails
  //
  // Bind a new sign-in email to an existing user's identity. Creates a fresh
  // WorkOS user for the new email and binds it as a non-primary credential
  // under the same identity. After this, the user can sign in with either
  // email — the auth middleware id-swaps non-primary logins to the canonical
  // workos_user_id so they see the same workspace.
  //
  // Use case: a user lost access to an alias email after the old delete-the-
  // secondary merge flow. Admin restores the alias by creating a new WorkOS
  // user and binding it.
  //
  // Trust model: admin is asserting the email belongs to the person. No
  // verification email is sent to the new address. Phase 3 may add one.
  router.post('/:userId/linked-emails', requireAuth, requireAdmin, async (req, res) => {
    const adminEmail = req.user!.email;
    const adminUserId = req.user!.id;
    const existingUserId = req.params.userId;
    const rawEmail = (req.body?.email as string | undefined)?.trim();

    if (!rawEmail) {
      return res.status(400).json({ error: 'email is required' });
    }
    const newEmail = rawEmail.toLowerCase();
    if (newEmail.length > 255 || !isPlausibleEmail(newEmail)) {
      return res.status(400).json({ error: 'Invalid email address' });
    }

    const pool = getPool();

    // Verify existing user
    const existing = await pool.query<{ email: string; first_name: string | null; last_name: string | null }>(
      `SELECT email, first_name, last_name FROM users WHERE workos_user_id = $1`,
      [existingUserId]
    );
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    if (existing.rows[0].email.toLowerCase() === newEmail) {
      return res.status(409).json({ error: 'This is already the user\'s primary email' });
    }

    // Refuse if this email is already a real WorkOS user in our DB. Binding
    // an existing account is the high-risk path that the self-service merge
    // flow blocks (see issue #3719); admin shouldn't silently merge two
    // existing accounts via this endpoint either. Use the org-merge tool or
    // a future "bind existing" admin path instead.
    const claimed = await pool.query(
      `SELECT workos_user_id FROM users WHERE LOWER(email) = $1`,
      [newEmail]
    );
    if (claimed.rows.length > 0) {
      return res.status(409).json({
        error: 'This email already has an AAO account',
        message: 'Use a separate consolidation flow to combine two existing accounts. This endpoint creates a fresh sign-in.',
      });
    }

    const workos = getWorkos();
    let newWorkosUser: { id: string; email: string; firstName: string | null; lastName: string | null; emailVerified: boolean; createdAt: string; updatedAt: string };

    try {
      newWorkosUser = await workos.userManagement.createUser({
        email: newEmail,
        emailVerified: true,
        firstName: existing.rows[0].first_name ?? undefined,
        lastName: existing.rows[0].last_name ?? undefined,
      });
    } catch (err: any) {
      // 422 = email already in use in WorkOS (we didn't see them in our DB
      // but WorkOS knows about them). 400 = WorkOS rejected for other
      // reasons — typically a still-living user at that email from a prior
      // merge whose deleteUser silently failed. Surface clearly.
      const status = err?.status ?? err?.response?.status;
      const workosMsg = err?.message ?? err?.rawMessage ?? '';
      if (status === 422 || status === 409 || status === 400) {
        logger.warn({ err, newEmail, existingUserId, status }, 'Admin bind-email: WorkOS rejected createUser');
        return res.status(409).json({
          error: 'WorkOS will not create a user at this email',
          message: `WorkOS responded ${status}: ${workosMsg || 'no message'}. The email is likely already in use upstream — look it up in the WorkOS Dashboard and use the "Link existing WorkOS user" admin tool to bind by id.`,
        });
      }
      logger.error({ err, newEmail, existingUserId, status }, 'Admin bind-email: WorkOS createUser failed');
      return res.status(502).json({
        error: 'Failed to create sign-in email upstream',
        message: workosMsg || `WorkOS responded with status ${status ?? 'unknown'}.`,
      });
    }

    // Insert into local users — fires the AFTER INSERT trigger which creates
    // a singleton identity for the new WorkOS user. mergeUsers will then
    // re-point the new user's binding to the existing user's identity.
    try {
      await pool.query(
        `INSERT INTO users (workos_user_id, email, first_name, last_name, email_verified,
                            workos_created_at, workos_updated_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
         ON CONFLICT (workos_user_id) DO NOTHING`,
        [newWorkosUser.id, newWorkosUser.email, newWorkosUser.firstName, newWorkosUser.lastName,
         newWorkosUser.emailVerified, newWorkosUser.createdAt, newWorkosUser.updatedAt]
      );

      // Merge: moves zero data rows (the new user has nothing), rebinds the
      // new user's identity_workos_users row to the existing user's identity
      // as is_primary = FALSE, drops the new user's orphan singleton identity.
      await mergeUsers(existingUserId, newWorkosUser.id, adminUserId);
    } catch (err) {
      logger.error(
        { err, newWorkosUserId: newWorkosUser.id, existingUserId },
        'Admin bind-email: local bind failed after WorkOS createUser succeeded — rolling back the WorkOS user'
      );
      // Best-effort cleanup so a retry doesn't leave an orphan in WorkOS.
      // If the delete itself fails, surface the WorkOS id for manual cleanup.
      let cleanedUp = false;
      try {
        await workos.userManagement.deleteUser(newWorkosUser.id);
        cleanedUp = true;
      } catch (deleteErr) {
        logger.error(
          { err: deleteErr, newWorkosUserId: newWorkosUser.id },
          'Admin bind-email: failed to roll back WorkOS user after local-bind failure'
        );
      }
      return res.status(500).json({
        error: 'Failed to bind sign-in email',
        message: cleanedUp
          ? 'The new WorkOS user was rolled back. Please retry.'
          : 'Please contact engineering — a WorkOS user was created at the new email but is not yet linked, and rollback failed.',
        ...(cleanedUp ? {} : { new_workos_user_id: newWorkosUser.id }),
      });
    }

    logger.info(
      { adminEmail, existingUserId, newEmail, newWorkosUserId: newWorkosUser.id },
      'Admin bound new sign-in email to existing user'
    );

    return res.status(201).json({
      bound: true,
      existing_user_id: existingUserId,
      new_email: newEmail,
      new_workos_user_id: newWorkosUser.id,
      message: `${newEmail} is now a sign-in email for this user. They can sign in with either address.`,
    });
  });

  // GET /api/admin/users/:userId/credentials
  //
  // List the WorkOS-user credentials bound to this user's identity. Useful
  // for the admin UI to render a "linked emails" section and decide which
  // operations are available.
  router.get('/:userId/credentials', requireAuth, requireAdmin, async (req, res) => {
    const userId = req.params.userId;
    const pool = getPool();

    const identity = await pool.query<{ identity_id: string }>(
      `SELECT identity_id FROM identity_workos_users WHERE workos_user_id = $1`,
      [userId]
    );
    if (identity.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const credentials = await pool.query<{
      workos_user_id: string;
      is_primary: boolean;
      bound_at: string;
      email: string | null;
      first_name: string | null;
      last_name: string | null;
    }>(
      `SELECT iwu.workos_user_id, iwu.is_primary, iwu.bound_at,
              u.email, u.first_name, u.last_name
         FROM identity_workos_users iwu
         LEFT JOIN users u ON u.workos_user_id = iwu.workos_user_id
        WHERE iwu.identity_id = $1
        ORDER BY iwu.is_primary DESC, iwu.bound_at ASC`,
      [identity.rows[0].identity_id]
    );

    return res.json({
      identity_id: identity.rows[0].identity_id,
      credentials: credentials.rows,
    });
  });

  // POST /api/admin/users/:userId/credentials
  // Body: { workos_user_id }
  //
  // Bind an EXISTING WorkOS user as a non-primary credential to this user's
  // identity. Use this when the email already has a WorkOS user (admin
  // created one in the WorkOS Dashboard, or a prior merge left the WorkOS
  // user alive). Bypasses createUser, which avoids the case where WorkOS
  // returns 400 because the email is already in use.
  //
  // If the target WorkOS user is itself bound to a different identity with
  // its own app-state, mergeUsers moves that data to this user — admin is
  // asserting the two represent the same person. The trust model and
  // confirmation UX live on the admin frontend.
  router.post('/:userId/credentials', requireAuth, requireAdmin, async (req, res) => {
    const adminEmail = req.user!.email;
    const adminUserId = req.user!.id;
    const existingUserId = req.params.userId;
    const credId = (req.body?.workos_user_id as string | undefined)?.trim();

    if (!credId || !credId.startsWith('user_')) {
      return res.status(400).json({ error: 'workos_user_id is required (must start with user_)' });
    }
    if (credId === existingUserId) {
      return res.status(400).json({ error: 'Cannot bind a user to itself' });
    }

    const pool = getPool();

    const existing = await pool.query<{ email: string }>(
      `SELECT email FROM users WHERE workos_user_id = $1`,
      [existingUserId]
    );
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    // If credId is already bound to existingUserId's identity, this is a
    // no-op (idempotent retry).
    const sameIdentity = await pool.query<{ workos_user_id: string }>(
      `SELECT iwu.workos_user_id
         FROM identity_workos_users iwu
        WHERE iwu.workos_user_id = $1
          AND iwu.identity_id = (
            SELECT identity_id FROM identity_workos_users WHERE workos_user_id = $2
          )`,
      [credId, existingUserId]
    );
    if (sameIdentity.rows.length > 0) {
      return res.json({ linked: true, message: 'Already bound to this user — no change.' });
    }

    // If credId is not in our local users table, fetch from WorkOS and
    // upsert. The AFTER INSERT trigger creates a singleton identity which
    // mergeUsers will then re-point.
    const credLocal = await pool.query(
      `SELECT email FROM users WHERE workos_user_id = $1`,
      [credId]
    );
    if (credLocal.rows.length === 0) {
      try {
        const workosUser = await getWorkos().userManagement.getUser(credId);
        await pool.query(
          `INSERT INTO users (workos_user_id, email, first_name, last_name, email_verified,
                              workos_created_at, workos_updated_at, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
           ON CONFLICT (workos_user_id) DO NOTHING`,
          [workosUser.id, workosUser.email, workosUser.firstName, workosUser.lastName,
           workosUser.emailVerified, workosUser.createdAt, workosUser.updatedAt]
        );
      } catch (err: any) {
        const status = err?.status ?? err?.response?.status;
        if (status === 404) {
          return res.status(404).json({ error: 'WorkOS user not found at that id' });
        }
        logger.error({ err, credId }, 'Admin link-credential: failed to fetch WorkOS user');
        return res.status(502).json({ error: 'Failed to fetch WorkOS user', message: err?.message });
      }
    }

    // Foot-gun gate: refuse silent consolidation. If credId has any app-state
    // attached (org membership, points, certification work, working-group
    // membership), binding will MOVE it onto the host — that's a real account
    // being absorbed, not a fresh credential being added. Require explicit
    // `consolidate: true` in the body so the admin has stated intent.
    //
    // Cheap signal: check the four most user-facing tables. False negatives
    // (e.g., a Slack-only points-bearing user with no org_membership) only
    // matter if the points themselves are valuable enough to warn about, and
    // they will move forward correctly either way.
    const consolidateConfirmed = req.body?.consolidate === true;
    if (!consolidateConfirmed) {
      const stateCheck = await pool.query<{ has_state: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM organization_memberships WHERE workos_user_id = $1
           UNION ALL
           SELECT 1 FROM working_group_memberships WHERE workos_user_id = $1
           UNION ALL
           SELECT 1 FROM certification_attempts WHERE workos_user_id = $1
           UNION ALL
           SELECT 1 FROM community_points WHERE workos_user_id = $1
           LIMIT 1
         ) AS has_state`,
        [credId]
      );
      if (stateCheck.rows[0].has_state) {
        return res.status(409).json({
          error: 'This WorkOS user has its own AAO data',
          message: 'Binding will move that data (organization memberships, working-group memberships, certification work, community points) to the host. Re-submit with `"consolidate": true` to confirm this is the intended consolidation.',
          consolidate_confirmation_required: true,
        });
      }
    }

    // mergeUsers moves any app-state from credId to existingUserId, rebinds
    // credId's identity_workos_users row to existingUserId's identity as
    // is_primary = FALSE, and drops the orphan identity. Throws if either
    // user lacks an identity binding.
    try {
      await mergeUsers(existingUserId, credId, adminUserId);
    } catch (err) {
      logger.error({ err, existingUserId, credId }, 'Admin link-credential: mergeUsers failed');
      return res.status(500).json({ error: 'Failed to bind credential' });
    }

    logger.info(
      { adminEmail, existingUserId, credId },
      'Admin linked existing WorkOS user to identity'
    );

    return res.status(201).json({
      linked: true,
      existing_user_id: existingUserId,
      bound_workos_user_id: credId,
      message: 'WorkOS user linked. They can now sign in with that credential and reach the same workspace.',
    });
  });

  // DELETE /api/admin/users/:userId/credentials/:credentialId
  //
  // Unbind a non-primary credential from this user's identity. The WorkOS
  // user stays alive in WorkOS and gets a fresh singleton identity locally
  // (becomes its own person again). Admin can delete the WorkOS user
  // separately via the WorkOS Dashboard if desired.
  //
  // Refuses if the credential is the primary — removing the primary would
  // leave the identity with no canonical credential. Promote another
  // credential to primary first (separate endpoint, not yet built).
  router.delete('/:userId/credentials/:credentialId', requireAuth, requireAdmin, async (req, res) => {
    const adminEmail = req.user!.email;
    const adminUserId = req.user!.id;
    // For non-singleton admin identities (today: nobody — admins are still
    // singleton-bound — but Phase 3+ may change), record the auth credential
    // separately from the canonical id so forensics can tell them apart.
    const adminAuthCredentialId = req.user!.authWorkosUserId ?? req.user!.id;
    const userId = req.params.userId;
    const credId = req.params.credentialId;

    if (credId === userId) {
      return res.status(400).json({ error: 'Cannot remove the canonical user via this endpoint' });
    }

    const pool = getPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const check = await client.query<{ is_primary: boolean; identity_id: string }>(
        `SELECT iwu.is_primary, iwu.identity_id
           FROM identity_workos_users iwu
          WHERE iwu.workos_user_id = $1
            AND iwu.identity_id = (
              SELECT identity_id FROM identity_workos_users WHERE workos_user_id = $2
            )`,
        [credId, userId]
      );

      if (check.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Credential not bound to this user' });
      }
      if (check.rows[0].is_primary) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'Cannot remove the primary credential',
          message: 'Promote another credential to primary before removing this one.',
        });
      }

      const detachedIdentityId = check.rows[0].identity_id;

      // Unbind, then create a fresh singleton identity for the detached
      // credential so the Phase 1 invariant ("every user has exactly one
      // binding") holds.
      await client.query(
        `DELETE FROM identity_workos_users WHERE workos_user_id = $1`,
        [credId]
      );
      const newIdentity = await client.query<{ id: string }>(
        `INSERT INTO identities DEFAULT VALUES RETURNING id`
      );
      await client.query(
        `INSERT INTO identity_workos_users (workos_user_id, identity_id, is_primary)
         VALUES ($1, $2, TRUE)`,
        [credId, newIdentity.rows[0].id]
      );

      // Audit log
      const auditOrg = await client.query<{ workos_organization_id: string }>(
        `SELECT workos_organization_id FROM organization_memberships
          WHERE workos_user_id = $1 LIMIT 1`,
        [userId]
      );
      const auditOrgId = auditOrg.rows[0]?.workos_organization_id || 'system';
      await client.query(
        `INSERT INTO registry_audit_log (
          workos_organization_id, workos_user_id, action, resource_type, resource_id, details
        ) VALUES ($1, $2, 'unbind_credential', 'user', $3, $4)`,
        [
          auditOrgId,
          adminUserId,
          credId,
          JSON.stringify({
            host_user_id: userId,
            detached_from_identity_id: detachedIdentityId,
            new_identity_id: newIdentity.rows[0].id,
            // Auth credential the admin used (may differ from adminUserId
            // post-id-swap if the admin has multiple bound credentials).
            acting_workos_user_id: adminAuthCredentialId,
          }),
        ]
      );

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      logger.error({ err, userId, credId }, 'Admin unbind-credential: failed');
      return res.status(500).json({ error: 'Failed to unbind credential' });
    } finally {
      client.release();
    }

    // Invalidate cached sessions for both users so the swap is recomputed
    // on the next request.
    invalidateSessionsForUsers([userId, credId]);

    logger.info(
      { adminEmail, userId, credId },
      'Admin unbound credential from identity'
    );

    return res.json({
      removed: true,
      host_user_id: userId,
      removed_workos_user_id: credId,
      message: 'Credential unbound. The WorkOS user is now a separate identity.',
    });
  });

  // POST /api/admin/users/:userId/credentials/:credentialId/promote
  //
  // Make :credentialId the primary credential of the host's identity.
  // Moves all of the current primary's app-state forward to :credentialId
  // (so reads keyed on the canonical workos_user_id land on the right
  // place), swaps `is_primary`, audit row.
  //
  // Use case: after a `link-existing` bind, the new credential ended up as
  // the right one for the workspace the person actually wants (e.g., a
  // work email that's a member of a paid org), but the canonical primary
  // sits on a different credential whose org_memberships are a different
  // (personal) workspace. Promote re-points the canonical so id-swap
  // routes both sign-ins to the org-bearing credential.
  //
  // Implementation note: we run mergeUsers(newPrimary, currentPrimary)
  // which moves data forward and demotes the old primary as a side
  // effect (it becomes is_primary=FALSE). Both bindings are non-primary
  // for a brief window between the mergeUsers commit and the follow-up
  // UPDATE; during that window `attachIdentityId` finds no primary and
  // skips the id-swap, so requests fall back to the auth user's slice of
  // data — degraded but not broken. A failure of the follow-up UPDATE
  // would persist that degraded state; the audit row records the intent
  // and the recovery is a one-line UPDATE.
  router.post('/:userId/credentials/:credentialId/promote', requireAuth, requireAdmin, async (req, res) => {
    const adminEmail = req.user!.email;
    const adminUserId = req.user!.id;
    const adminAuthCredentialId = req.user!.authWorkosUserId ?? req.user!.id;
    const userId = req.params.userId;
    const newPrimaryId = req.params.credentialId;

    if (newPrimaryId === userId) {
      return res.status(400).json({ error: 'The credential to promote must differ from the host id in the URL' });
    }

    const pool = getPool();

    // Validate: target is bound to host's identity, find current primary
    const check = await pool.query<{
      new_is_primary: boolean;
      current_primary_id: string | null;
      identity_id: string;
    }>(
      `SELECT
          target.is_primary AS new_is_primary,
          primary_iwu.workos_user_id AS current_primary_id,
          target.identity_id
        FROM identity_workos_users target
        LEFT JOIN identity_workos_users primary_iwu
          ON primary_iwu.identity_id = target.identity_id
         AND primary_iwu.is_primary = TRUE
       WHERE target.workos_user_id = $1
         AND target.identity_id = (
           SELECT identity_id FROM identity_workos_users WHERE workos_user_id = $2
         )`,
      [newPrimaryId, userId]
    );

    if (check.rows.length === 0) {
      return res.status(404).json({ error: 'Credential not bound to this user' });
    }
    if (check.rows[0].new_is_primary) {
      return res.json({ promoted: true, message: 'Already primary — no change.' });
    }

    const identityId = check.rows[0].identity_id;
    const currentPrimaryId = check.rows[0].current_primary_id;

    // Edge case: identity has no current primary (broken invariant from a
    // prior partial promote, manual SQL, etc.). Just set the target as
    // primary; nothing to move forward.
    if (!currentPrimaryId) {
      await pool.query(
        `UPDATE identity_workos_users SET is_primary = TRUE WHERE workos_user_id = $1`,
        [newPrimaryId]
      );
      logger.info(
        { adminEmail, userId, newPrimaryId, identityId, recovered_orphan: true },
        'Promote: identity had no current primary; set target as primary directly'
      );
      invalidateSessionsForUsers([newPrimaryId]);
      return res.json({
        promoted: true,
        message: 'Promoted (no current primary to demote — invariant repaired).',
      });
    }

    // Run mergeUsers to move data forward. mergeUsers' identity-rebind step
    // sets the (former) primary to is_primary=FALSE; we then UPDATE the new
    // primary to TRUE.
    try {
      await mergeUsers(newPrimaryId, currentPrimaryId, adminUserId);
    } catch (err) {
      logger.error(
        { err, userId, newPrimaryId, currentPrimaryId },
        'Promote: mergeUsers failed'
      );
      return res.status(500).json({ error: 'Failed to promote credential' });
    }

    try {
      await pool.query(
        `UPDATE identity_workos_users SET is_primary = TRUE WHERE workos_user_id = $1`,
        [newPrimaryId]
      );
    } catch (err) {
      logger.error(
        { err, userId, newPrimaryId, currentPrimaryId, identityId },
        'Promote: post-merge primary swap UPDATE failed — identity is left with NO primary; manual recovery: UPDATE identity_workos_users SET is_primary=TRUE WHERE workos_user_id=$newPrimaryId'
      );
      return res.status(500).json({
        error: 'Promote partially completed',
        message: 'App-state moved successfully, but the primary swap could not be persisted. Engineering needs to manually set is_primary on the new credential. Please contact engineering.',
      });
    }

    // Audit row
    try {
      const auditOrg = await pool.query<{ workos_organization_id: string }>(
        `SELECT workos_organization_id FROM organization_memberships
          WHERE workos_user_id = $1 LIMIT 1`,
        [newPrimaryId]
      );
      const auditOrgId = auditOrg.rows[0]?.workos_organization_id || 'system';
      await pool.query(
        `INSERT INTO registry_audit_log (
          workos_organization_id, workos_user_id, action, resource_type, resource_id, details
        ) VALUES ($1, $2, 'promote_credential_to_primary', 'user', $3, $4)`,
        [
          auditOrgId,
          adminUserId,
          newPrimaryId,
          JSON.stringify({
            host_user_id: userId,
            identity_id: identityId,
            previous_primary_id: currentPrimaryId,
            new_primary_id: newPrimaryId,
            acting_workos_user_id: adminAuthCredentialId,
          }),
        ]
      );
    } catch (err) {
      logger.warn({ err, userId, newPrimaryId }, 'Promote: audit row insert failed (non-fatal)');
    }

    invalidateSessionsForUsers([userId, newPrimaryId, currentPrimaryId]);

    logger.info(
      { adminEmail, identityId, previous_primary_id: currentPrimaryId, new_primary_id: newPrimaryId },
      'Admin promoted credential to primary'
    );

    return res.json({
      promoted: true,
      identity_id: identityId,
      previous_primary_id: currentPrimaryId,
      new_primary_id: newPrimaryId,
      message: 'Credential is now primary. Sign-ins via either bound credential will route here.',
    });
  });

  return router;
}
