/**
 * Approval Queue Alerts
 *
 * Sends Slack DMs to AAO admins when items enter the approval queue
 * and periodic digests for stale pending items.
 */

import { WorkingGroupDatabase } from '../db/working-group-db.js';
import { SlackDatabase } from '../db/slack-db.js';
import { AddieDatabase, type AddieApprovalQueueItem } from '../db/addie-db.js';
import { sendDirectMessage } from '../slack/client.js';
import { createLogger } from '../logger.js';

const logger = createLogger('approval-queue-alerts');
const wgDb = new WorkingGroupDatabase();
const slackDb = new SlackDatabase();
const addieDb = new AddieDatabase();

const AAO_ADMIN_WORKING_GROUP_SLUG = 'aao-admin';

// Cache admin Slack user IDs for 10 minutes to avoid repeated DB lookups
let adminSlackIdsCache: { ids: string[]; expiresAt: number } | null = null;
const CACHE_TTL_MS = 10 * 60 * 1000;

/**
 * Get Slack user IDs for all active AAO admin working group members.
 */
async function getAdminSlackUserIds(): Promise<string[]> {
  if (adminSlackIdsCache && adminSlackIdsCache.expiresAt > Date.now()) {
    return adminSlackIdsCache.ids;
  }

  try {
    const adminGroup = await wgDb.getWorkingGroupBySlug(AAO_ADMIN_WORKING_GROUP_SLUG);
    if (!adminGroup) {
      logger.warn('AAO Admin working group not found — cannot send queue alerts');
      return [];
    }

    const memberships = await wgDb.getMembershipsByWorkingGroup(adminGroup.id);
    const activeMembers = memberships.filter(m => m.status === 'active');

    const slackUserIds: string[] = [];
    for (const member of activeMembers) {
      const mapping = await slackDb.getByWorkosUserId(member.workos_user_id);
      if (mapping?.slack_user_id) {
        slackUserIds.push(mapping.slack_user_id);
      }
    }

    adminSlackIdsCache = { ids: slackUserIds, expiresAt: Date.now() + CACHE_TTL_MS };
    logger.debug({ count: slackUserIds.length }, 'Cached admin Slack user IDs for queue alerts');
    return slackUserIds;
  } catch (error) {
    logger.error({ error }, 'Failed to get admin Slack user IDs');
    return [];
  }
}

/**
 * Send a Slack DM to all admins about a new approval queue item.
 * Fire-and-forget — errors are logged but never thrown.
 */
export async function notifyAdminsOfNewQueueItem(item: AddieApprovalQueueItem): Promise<void> {
  try {
    const adminSlackIds = await getAdminSlackUserIds();
    if (adminSlackIds.length === 0) {
      logger.debug('No admin Slack users found — skipping queue alert');
      return;
    }

    const context = item.trigger_context as Record<string, unknown> | null;
    const userName = context?.user_display_name || 'someone';
    const triggerLabel = item.trigger_type.replace(/_/g, ' ');
    const preview = item.proposed_content.length > 200
      ? item.proposed_content.substring(0, 200) + '...'
      : item.proposed_content;

    const baseUrl = process.env.BASE_URL || 'https://agenticadvertising.org';

    const text = [
      `*Addie wants to reply* (${triggerLabel})`,
      `> From ${userName} in <#${item.target_channel_id}>`,
      `\`\`\`${preview}\`\`\``,
      `<${baseUrl}/admin/addie?tab=queue|Review in Admin>`,
    ].join('\n');

    await Promise.all(
      adminSlackIds.map(slackUserId =>
        sendDirectMessage(slackUserId, { text }).catch(err =>
          logger.error({ err, slackUserId }, 'Failed to send queue alert DM')
        )
      )
    );

    logger.info({ queueItemId: item.id, adminsNotified: adminSlackIds.length }, 'Sent approval queue alert');
  } catch (error) {
    logger.error({ error }, 'Failed to notify admins of new queue item');
  }
}

/**
 * Check for stale pending items and send a digest to admins.
 * Returns stats for the job scheduler.
 */
export async function runApprovalQueueDigestJob(): Promise<{
  pending: number;
  alertsSent: number;
}> {
  const stats = await addieDb.getApprovalStats();

  if (stats.pending === 0) {
    return { pending: 0, alertsSent: 0 };
  }

  const adminSlackIds = await getAdminSlackUserIds();
  if (adminSlackIds.length === 0) {
    return { pending: stats.pending, alertsSent: 0 };
  }

  const baseUrl = process.env.BASE_URL || 'https://agenticadvertising.org';

  const text = [
    `*Approval queue: ${stats.pending} pending*`,
    stats.approved_today > 0 ? `Approved today: ${stats.approved_today}` : null,
    stats.rejected_today > 0 ? `Rejected today: ${stats.rejected_today}` : null,
    `<${baseUrl}/admin/addie?tab=queue|Review now>`,
  ].filter(Boolean).join('\n');

  await Promise.all(
    adminSlackIds.map(slackUserId =>
      sendDirectMessage(slackUserId, { text }).catch(err =>
        logger.error({ err, slackUserId }, 'Failed to send queue digest DM')
      )
    )
  );

  logger.info({ pending: stats.pending, adminsNotified: adminSlackIds.length }, 'Sent approval queue digest');
  return { pending: stats.pending, alertsSent: adminSlackIds.length };
}
