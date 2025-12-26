/**
 * Slack user sync service
 *
 * Fetches users from Slack workspace and syncs them to the database.
 * Auto-mapping by email is handled separately via the admin API endpoint
 * which has access to WorkOS user data.
 */

import { logger } from '../logger.js';
import { getSlackUsers, isSlackConfigured } from './client.js';
import { SlackDatabase } from '../db/slack-db.js';
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
      errors: ['Slack is not configured (SLACK_BOT_TOKEN missing)'],
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
