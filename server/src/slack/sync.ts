/**
 * Slack user sync service
 *
 * Handles syncing between Slack and website accounts:
 * - Fetches users from Slack workspace and syncs them to the database
 * - Auto-links accounts by email when users join (either direction)
 * - Syncs working group memberships based on Slack channel membership
 */

import { logger } from '../logger.js';
import { getSlackUsers, getChannelMembers, getUserChannels, isSlackConfigured } from './client.js';
import { SlackDatabase } from '../db/slack-db.js';
import { WorkingGroupDatabase } from '../db/working-group-db.js';
import { invalidateUnifiedUsersCache } from '../cache/unified-users.js';
import { invalidateMemberContextCache } from '../addie/index.js';
import { invalidateWebAdminStatusCache } from '../addie/mcp/admin-tools.js';
import { getPool } from '../db/client.js';
import { workos } from '../auth/workos-client.js';
import { isFreeEmailDomain } from '../utils/email-domain.js';
import type { SyncSlackUsersResult } from './types.js';

const slackDb = new SlackDatabase();
const workingGroupDb = new WorkingGroupDatabase();

/**
 * Sync all Slack users to the database
 *
 * 1. Fetches all users from Slack workspace
 * 2. Upserts each user into slack_user_mappings table
 *
 * Note: Auto-mapping by email is done via POST /api/admin/slack/auto-link-suggested
 * which has access to WorkOS user data for email matching.
 */
export async function syncSlackUsers(): Promise<SyncSlackUsersResult> {
  if (!isSlackConfigured()) {
    return {
      total_synced: 0,
      new_users: 0,
      updated_users: 0,
      auto_mapped: 0,
      errors: ['Slack is not configured (ADDIE_BOT_TOKEN missing)'],
    };
  }

  const result: SyncSlackUsersResult = {
    total_synced: 0,
    new_users: 0,
    updated_users: 0,
    auto_mapped: 0,
    errors: [],
  };

  try {
    logger.info('Starting Slack user sync');

    // Fetch all users from Slack
    const slackUsers = await getSlackUsers();
    logger.info({ count: slackUsers.length }, 'Fetched users from Slack');

    // Get existing mappings to track new vs updated
    const existingBefore = new Set<string>();
    const existingMappings = await slackDb.getAllMappings({ includeBots: true, includeDeleted: true });
    for (const mapping of existingMappings) {
      existingBefore.add(mapping.slack_user_id);
    }

    // Upsert each user
    for (const user of slackUsers) {
      try {
        const email = user.profile?.email || null;
        const displayName = user.profile?.display_name || user.profile?.display_name_normalized || null;
        const realName = user.profile?.real_name || user.real_name || null;

        await slackDb.upsertSlackUser({
          slack_user_id: user.id,
          slack_email: email,
          slack_display_name: displayName,
          slack_real_name: realName,
          slack_is_bot: user.is_bot,
          slack_is_deleted: user.deleted,
          slack_tz_offset: user.tz_offset ?? null,
        });

        result.total_synced++;

        if (existingBefore.has(user.id)) {
          result.updated_users++;
        } else {
          result.new_users++;
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        result.errors.push(`Failed to sync user ${user.id}: ${errorMessage}`);
        logger.error({ error, userId: user.id }, 'Failed to sync Slack user');
      }
    }

    // Note: auto_mapped will remain 0 here since bulk sync doesn't auto-map.
    // Auto-mapping happens on:
    // - team_join event (Slack user joins workspace)
    // - user.created webhook (website user signs up)
    // - organization_membership.created webhook (user joins org)
    // For historical users, use POST /api/admin/slack/auto-link-suggested
    logger.info(result, 'Slack user sync completed');
    return result;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    result.errors.push(`Sync failed: ${errorMessage}`);
    logger.error({ error }, 'Slack user sync failed');
    return result;
  }
}

/**
 * Get sync status summary
 */
export async function getSyncStatus(): Promise<{
  configured: boolean;
  stats: {
    total: number;
    mapped: number;
    unmapped: number;
    pending_verification: number;
    bots: number;
    deleted: number;
    opted_out: number;
  } | null;
  last_sync: Date | null;
}> {
  if (!isSlackConfigured()) {
    return {
      configured: false,
      stats: null,
      last_sync: null,
    };
  }

  const stats = await slackDb.getStats();

  // Get most recent sync timestamp
  const mappings = await slackDb.getAllMappings({ limit: 1, includeBots: true, includeDeleted: true });
  const lastSync = mappings.length > 0 ? mappings[0].last_slack_sync_at : null;

  return {
    configured: true,
    stats,
    last_sync: lastSync,
  };
}

// ============== Working Group Member Sync ==============

export interface SyncWorkingGroupMembersResult {
  working_group_id: string;
  working_group_name: string;
  slack_channel_id: string;
  total_channel_members: number;
  members_added: number;
  members_already_in_group: number;
  unmapped_slack_users: number;
  errors: string[];
}

/**
 * Sync members from a Slack channel to a working group
 *
 * 1. Gets all members of the Slack channel
 * 2. For each member, checks if they have a mapped WorkOS user
 * 3. If mapped, adds them to the working group (if not already a member)
 */
export async function syncWorkingGroupMembersFromSlack(
  workingGroupId: string
): Promise<SyncWorkingGroupMembersResult> {
  // Get the working group
  const workingGroup = await workingGroupDb.getWorkingGroupById(workingGroupId);
  if (!workingGroup) {
    return {
      working_group_id: workingGroupId,
      working_group_name: 'Unknown',
      slack_channel_id: '',
      total_channel_members: 0,
      members_added: 0,
      members_already_in_group: 0,
      unmapped_slack_users: 0,
      errors: ['Working group not found'],
    };
  }

  if (!workingGroup.slack_channel_id) {
    return {
      working_group_id: workingGroupId,
      working_group_name: workingGroup.name,
      slack_channel_id: '',
      total_channel_members: 0,
      members_added: 0,
      members_already_in_group: 0,
      unmapped_slack_users: 0,
      errors: ['Working group does not have a Slack channel ID configured'],
    };
  }

  if (!isSlackConfigured()) {
    return {
      working_group_id: workingGroupId,
      working_group_name: workingGroup.name,
      slack_channel_id: workingGroup.slack_channel_id,
      total_channel_members: 0,
      members_added: 0,
      members_already_in_group: 0,
      unmapped_slack_users: 0,
      errors: ['Slack is not configured (ADDIE_BOT_TOKEN missing)'],
    };
  }

  const result: SyncWorkingGroupMembersResult = {
    working_group_id: workingGroupId,
    working_group_name: workingGroup.name,
    slack_channel_id: workingGroup.slack_channel_id,
    total_channel_members: 0,
    members_added: 0,
    members_already_in_group: 0,
    unmapped_slack_users: 0,
    errors: [],
  };

  try {
    logger.info(
      { workingGroupId, channelId: workingGroup.slack_channel_id },
      'Starting working group member sync from Slack'
    );

    // Get all members of the Slack channel
    const channelMemberIds = await getChannelMembers(workingGroup.slack_channel_id);
    result.total_channel_members = channelMemberIds.length;

    logger.info(
      { count: channelMemberIds.length, channelId: workingGroup.slack_channel_id },
      'Fetched channel members from Slack'
    );

    // Process each channel member
    for (const slackUserId of channelMemberIds) {
      try {
        // Look up the Slack user mapping
        const mapping = await slackDb.getBySlackUserId(slackUserId);

        if (!mapping || !mapping.workos_user_id) {
          // User not mapped to WorkOS
          result.unmapped_slack_users++;
          continue;
        }

        // Check if already a member
        const isMember = await workingGroupDb.isMember(workingGroupId, mapping.workos_user_id);
        if (isMember) {
          result.members_already_in_group++;
          continue;
        }

        // Add to working group
        await workingGroupDb.addMembership({
          working_group_id: workingGroupId,
          workos_user_id: mapping.workos_user_id,
          user_email: mapping.slack_email || undefined,
          user_name: mapping.slack_real_name || mapping.slack_display_name || undefined,
        });
        invalidateWebAdminStatusCache(mapping.workos_user_id);

        result.members_added++;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        result.errors.push(`Failed to process Slack user ${slackUserId}: ${errorMessage}`);
        logger.error({ error, slackUserId }, 'Failed to process Slack user for working group sync');
      }
    }

    logger.info(result, 'Working group member sync from Slack completed');
    return result;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    result.errors.push(`Sync failed: ${errorMessage}`);
    logger.error({ error, workingGroupId }, 'Working group member sync from Slack failed');
    return result;
  }
}

/**
 * Sync all working groups that have Slack channels configured
 */
export async function syncAllWorkingGroupMembersFromSlack(): Promise<SyncWorkingGroupMembersResult[]> {
  const results: SyncWorkingGroupMembersResult[] = [];

  const workingGroups = await workingGroupDb.listWorkingGroupsWithSlackChannel();

  for (const wg of workingGroups) {
    const result = await syncWorkingGroupMembersFromSlack(wg.id);
    results.push(result);
  }

  return results;
}

// ============== User Account Link Sync ==============

export interface SyncUserChaptersResult {
  workos_user_id: string;
  slack_user_id: string;
  channels_checked: number;
  chapters_joined: number;
  chapters_already_member: number;
  chapters: Array<{
    id: string;
    name: string;
    action: 'joined' | 'already_member';
  }>;
  errors: string[];
}

/**
 * Sync a user to committees based on their Slack channel memberships
 *
 * Called when a user's Slack account is linked to their WorkOS account.
 * Checks which channels they're in and adds them to corresponding committees.
 */
export async function syncUserToChaptersFromSlackChannels(
  workosUserId: string,
  slackUserId: string
): Promise<SyncUserChaptersResult> {
  const result: SyncUserChaptersResult = {
    workos_user_id: workosUserId,
    slack_user_id: slackUserId,
    channels_checked: 0,
    chapters_joined: 0,
    chapters_already_member: 0,
    chapters: [],
    errors: [],
  };

  if (!isSlackConfigured()) {
    result.errors.push('Slack is not configured (ADDIE_BOT_TOKEN missing)');
    return result;
  }

  try {
    logger.info(
      { workosUserId, slackUserId },
      'Starting user committee sync from Slack channels'
    );

    // Get all channels the user is a member of
    let userChannelIds: string[];
    try {
      userChannelIds = await getUserChannels(slackUserId);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      result.errors.push(`Failed to fetch user channels: ${errorMessage}`);
      logger.error({ error, slackUserId }, 'Failed to fetch user channels from Slack');
      return result;
    }
    result.channels_checked = userChannelIds.length;

    if (userChannelIds.length === 0) {
      logger.info({ slackUserId }, 'User is not a member of any channels');
      return result;
    }

    // Get all committees that have Slack channels configured
    const workingGroups = await workingGroupDb.listWorkingGroupsWithSlackChannel();

    // Get user's Slack info for membership record
    const slackMapping = await slackDb.getBySlackUserId(slackUserId);

    // Check each group with a Slack channel
    // Note: getUserChannels only returns public channels, so we skip private committees
    // since a public channel shouldn't grant access to a private committee
    for (const group of workingGroups) {
      if (!group.slack_channel_id) continue;

      // Skip private committees (we only have public channel data from getUserChannels)
      if (group.is_private) continue;

      // Check if user is in this channel
      if (!userChannelIds.includes(group.slack_channel_id)) continue;

      try {
        // Check if already a member
        const isMember = await workingGroupDb.isMember(group.id, workosUserId);
        if (isMember) {
          result.chapters_already_member++;
          result.chapters.push({
            id: group.id,
            name: group.name,
            action: 'already_member',
          });
          continue;
        }

        // Add to the group
        await workingGroupDb.addMembershipWithInterest({
          working_group_id: group.id,
          workos_user_id: workosUserId,
          user_email: slackMapping?.slack_email || undefined,
          user_name: slackMapping?.slack_real_name || slackMapping?.slack_display_name || undefined,
          interest_level: group.committee_type === 'industry_gathering' ? 'interested' : undefined,
          interest_source: 'slack_join',
        });
        invalidateWebAdminStatusCache(workosUserId);

        result.chapters_joined++;
        result.chapters.push({
          id: group.id,
          name: group.name,
          action: 'joined',
        });

        logger.info(
          { workosUserId, groupId: group.id, groupName: group.name, type: group.committee_type },
          'Added user to committee based on Slack channel membership'
        );
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        result.errors.push(`Failed to add to ${group.name}: ${errorMessage}`);
        logger.error({ error, groupId: group.id }, 'Failed to add user to committee');
      }
    }

    logger.info(result, 'User committee sync from Slack channels completed');
    return result;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    result.errors.push(`Sync failed: ${errorMessage}`);
    logger.error({ error, workosUserId, slackUserId }, 'User committee sync from Slack failed');
    return result;
  }
}

// ============== Auto-Link by Email ==============

export interface AutoLinkResult {
  linked: boolean;
  slack_user_id?: string;
  workos_user_id?: string;
  chapters_joined?: number;
  reason?: string;
}

/**
 * Try to auto-link a website user to their Slack account by email
 *
 * Called when a new user signs up on the website. Looks for a Slack user
 * with the same email and links them if found.
 */
export async function tryAutoLinkWebsiteUserToSlack(
  workosUserId: string,
  email: string
): Promise<AutoLinkResult> {
  try {
    // Find Slack user with this email
    const slackUser = await slackDb.findByEmail(email);

    if (!slackUser) {
      logger.debug({ email }, 'No Slack user found for website user email');
      return { linked: false, reason: 'no_slack_user' };
    }

    // Check if Slack user is already mapped to a different WorkOS user
    if (slackUser.workos_user_id && slackUser.workos_user_id !== workosUserId) {
      logger.debug(
        { email, existingWorkosUserId: slackUser.workos_user_id, newWorkosUserId: workosUserId },
        'Slack user already mapped to different WorkOS account'
      );
      return { linked: false, reason: 'slack_user_already_mapped' };
    }

    // Check if this WorkOS user is already mapped to a different Slack user
    const existingMapping = await slackDb.getByWorkosUserId(workosUserId);
    if (existingMapping && existingMapping.slack_user_id !== slackUser.slack_user_id) {
      logger.debug(
        { workosUserId, existingSlackUserId: existingMapping.slack_user_id },
        'WorkOS user already mapped to different Slack account'
      );
      return { linked: false, reason: 'workos_user_already_mapped' };
    }

    // Already linked (same accounts)
    if (slackUser.workos_user_id === workosUserId) {
      logger.debug({ workosUserId, slackUserId: slackUser.slack_user_id }, 'Users already linked');
      return { linked: false, reason: 'already_linked' };
    }

    // Skip bots and deleted users
    if (slackUser.slack_is_bot) {
      return { linked: false, reason: 'slack_user_is_bot' };
    }
    if (slackUser.slack_is_deleted) {
      return { linked: false, reason: 'slack_user_is_deleted' };
    }

    // Link the accounts
    await slackDb.mapUser({
      slack_user_id: slackUser.slack_user_id,
      workos_user_id: workosUserId,
      mapping_source: 'email_auto',
    });

    logger.info(
      { workosUserId, slackUserId: slackUser.slack_user_id, email },
      'Auto-linked website user to Slack account by email'
    );

    // Sync user to chapters based on their Slack channel memberships
    let chaptersJoined = 0;
    try {
      const chapterSyncResult = await syncUserToChaptersFromSlackChannels(workosUserId, slackUser.slack_user_id);
      chaptersJoined = chapterSyncResult.chapters_joined;
      if (chaptersJoined > 0) {
        logger.info(
          { workosUserId, chaptersJoined },
          'Auto-synced user to chapters from Slack channels'
        );
      }
    } catch (error) {
      logger.error({ error, workosUserId }, 'Failed to sync chapters after auto-link');
    }

    // Invalidate caches
    invalidateUnifiedUsersCache();
    invalidateMemberContextCache(slackUser.slack_user_id);

    return {
      linked: true,
      slack_user_id: slackUser.slack_user_id,
      workos_user_id: workosUserId,
      chapters_joined: chaptersJoined,
    };
  } catch (error) {
    logger.error({ error, workosUserId, email }, 'Failed to auto-link website user to Slack');
    return { linked: false, reason: 'error' };
  }
}

/**
 * Build a map of AAO member emails to WorkOS user IDs.
 * Uses the local organization_memberships table (synced from WorkOS via webhooks).
 */
export async function buildAaoEmailToUserIdMap(): Promise<Map<string, string>> {
  const pool = getPool();
  const aaoEmailToUserId = new Map<string, string>();
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
 * Check if a user should be assigned to an organization based on their email domain.
 * If the user is in a personal workspace and their email domain matches a registered
 * organization domain, adds them to that organization.
 */
export async function checkAndAssignOrganizationByDomain(
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
      return null;
    }

    const { email, workos_organization_id: currentOrgId, org_name: currentOrgName, is_personal: isPersonal } = membershipResult.rows[0];

    if (!isPersonal) {
      return null;
    }

    const domain = email.split('@')[1]?.toLowerCase();
    if (!domain || isFreeEmailDomain(domain)) {
      return null;
    }

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
      return null;
    }

    const { workos_organization_id: targetOrgId, org_name: targetOrgName } = domainResult.rows[0];

    const existingMembership = await pool.query(`
      SELECT 1 FROM organization_memberships
      WHERE workos_user_id = $1 AND workos_organization_id = $2
      LIMIT 1
    `, [workosUserId, targetOrgId]);

    if (existingMembership.rows.length > 0) {
      return null;
    }

    logger.info(
      { workosUserId, email, domain, targetOrgId, targetOrgName, currentOrgId, currentOrgName },
      'Adding user to organization based on email domain'
    );

    await workos.userManagement.createOrganizationMembership({
      userId: workosUserId,
      organizationId: targetOrgId,
      roleSlug: 'member',
    });

    await pool.query(`
      INSERT INTO organization_memberships (workos_user_id, workos_organization_id, email, created_at, updated_at, synced_at)
      SELECT $1, $2, email, NOW(), NOW(), NOW()
      FROM organization_memberships
      WHERE workos_user_id = $1
      LIMIT 1
      ON CONFLICT (workos_user_id, workos_organization_id) DO NOTHING
    `, [workosUserId, targetOrgId]);

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
 * Bulk auto-link unmapped Slack users to website accounts by email match.
 * Used by both the admin endpoint and the daily background job.
 */
export async function autoLinkUnmappedSlackUsers(): Promise<{
  linked: number;
  chapters_joined: number;
  organizations_assigned: number;
  errors: number;
}> {
  // excludeOptedOut: false — opt-out applies to nudge notifications, not account linking.
  // Linking is a system operation; it doesn't send any messages.
  const unmappedSlack = await slackDb.getUnmappedUsers({
    excludeOptedOut: false,
    excludeRecentlyNudged: false,
  });

  const aaoEmailToUserId = await buildAaoEmailToUserIdMap();
  const mappedWorkosUserIds = await slackDb.getMappedWorkosUserIds();

  let linked = 0;
  let chaptersJoined = 0;
  let orgsAssigned = 0;
  let errors = 0;

  for (const slackUser of unmappedSlack) {
    if (!slackUser.slack_email) continue;

    const workosUserId = aaoEmailToUserId.get(slackUser.slack_email.toLowerCase());
    if (!workosUserId || mappedWorkosUserIds.has(workosUserId)) continue;

    try {
      await slackDb.mapUser({
        slack_user_id: slackUser.slack_user_id,
        workos_user_id: workosUserId,
        mapping_source: 'email_auto',
      });
      linked++;
      mappedWorkosUserIds.add(workosUserId);

      const chapterResult = await syncUserToChaptersFromSlackChannels(workosUserId, slackUser.slack_user_id);
      chaptersJoined += chapterResult.chapters_joined;

      const orgResult = await checkAndAssignOrganizationByDomain(workosUserId);
      if (orgResult?.assigned) orgsAssigned++;
    } catch (err) {
      logger.error({ err, slackUserId: slackUser.slack_user_id, email: slackUser.slack_email }, 'Failed to auto-link user');
      errors++;
    }
  }

  if (linked > 0) {
    invalidateUnifiedUsersCache();
    invalidateMemberContextCache();
  }

  return { linked, chapters_joined: chaptersJoined, organizations_assigned: orgsAssigned, errors };
}
