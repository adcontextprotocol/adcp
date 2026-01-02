/**
 * Slack user sync service
 *
 * Fetches users from Slack workspace and syncs them to the database.
 * Auto-mapping by email is handled separately via the admin API endpoint
 * which has access to WorkOS user data.
 */

import { logger } from '../logger.js';
import { getSlackUsers, getChannelMembers, isSlackConfigured } from './client.js';
import { SlackDatabase } from '../db/slack-db.js';
import { WorkingGroupDatabase } from '../db/working-group-db.js';
import type { SyncSlackUsersResult } from './types.js';

const slackDb = new SlackDatabase();

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

    // Note: auto_mapped will remain 0 here.
    // Use POST /api/admin/slack/auto-link-suggested after sync to auto-map by email.
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
  const workingGroupDb = new WorkingGroupDatabase();

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
  const workingGroupDb = new WorkingGroupDatabase();
  const results: SyncWorkingGroupMembersResult[] = [];

  const workingGroups = await workingGroupDb.listWorkingGroupsWithSlackChannel();

  for (const wg of workingGroups) {
    const result = await syncWorkingGroupMembersFromSlack(wg.id);
    results.push(result);
  }

  return results;
}
