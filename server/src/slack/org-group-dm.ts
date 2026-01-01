/**
 * Organization Admin Group DM Management
 *
 * Creates and manages Slack group DMs for organization admins/owners.
 * Used to notify admins of join requests, new members, etc.
 */

import { query } from '../db/client.js';
import { logger } from '../logger.js';
import { openGroupDM, sendChannelMessage } from './client.js';
import type { SlackBlockMessage } from './types.js';

const APP_URL = process.env.APP_URL || 'https://agenticadvertising.org';

// Slack group DMs require at least 2 users (excluding the bot)
const MIN_GROUP_DM_USERS = 2;

interface OrgAdminGroupDM {
  id: string;
  workos_organization_id: string;
  slack_channel_id: string;
  admin_slack_user_ids: string[];
  created_at: Date;
  updated_at: Date;
}

/**
 * Get existing group DM record for an organization
 */
async function getGroupDMRecord(orgId: string): Promise<OrgAdminGroupDM | null> {
  const result = await query<OrgAdminGroupDM>(
    'SELECT * FROM org_admin_group_dms WHERE workos_organization_id = $1',
    [orgId]
  );
  return result.rows[0] || null;
}

/**
 * Save or update group DM record
 */
async function saveGroupDMRecord(
  orgId: string,
  channelId: string,
  adminSlackUserIds: string[]
): Promise<OrgAdminGroupDM> {
  const result = await query<OrgAdminGroupDM>(
    `INSERT INTO org_admin_group_dms (workos_organization_id, slack_channel_id, admin_slack_user_ids)
     VALUES ($1, $2, $3)
     ON CONFLICT (workos_organization_id)
     DO UPDATE SET
       slack_channel_id = EXCLUDED.slack_channel_id,
       admin_slack_user_ids = EXCLUDED.admin_slack_user_ids,
       updated_at = NOW()
     RETURNING *`,
    [orgId, channelId, adminSlackUserIds]
  );
  return result.rows[0];
}

/**
 * Get Slack user IDs for org admins/owners by their emails
 * Returns only admins that have Slack mappings
 */
async function getAdminSlackUserIds(adminEmails: string[]): Promise<string[]> {
  if (adminEmails.length === 0) {
    return [];
  }

  const result = await query<{ slack_user_id: string }>(
    `SELECT slack_user_id
     FROM slack_user_mappings
     WHERE LOWER(slack_email) = ANY($1)
       AND mapping_status = 'mapped'
       AND slack_is_deleted = false`,
    [adminEmails.map(e => e.toLowerCase())]
  );

  return result.rows.map(r => r.slack_user_id);
}

/**
 * Check if the current admin list matches the stored group DM
 */
function adminListMatches(existing: OrgAdminGroupDM, currentAdminIds: string[]): boolean {
  const existingSet = new Set(existing.admin_slack_user_ids);
  const currentSet = new Set(currentAdminIds);

  if (existingSet.size !== currentSet.size) {
    return false;
  }

  for (const id of currentSet) {
    if (!existingSet.has(id)) {
      return false;
    }
  }

  return true;
}

/**
 * Get or create a group DM for an organization's admins
 *
 * @param orgId - WorkOS organization ID
 * @param adminEmails - List of admin/owner emails from WorkOS
 * @returns The Slack channel ID for the group DM, or null if not possible
 */
export async function getOrCreateOrgAdminGroupDM(
  orgId: string,
  adminEmails: string[]
): Promise<string | null> {
  try {
    // Get Slack user IDs for admins
    const adminSlackUserIds = await getAdminSlackUserIds(adminEmails);

    if (adminSlackUserIds.length < MIN_GROUP_DM_USERS) {
      logger.info(
        { orgId, adminEmailCount: adminEmails.length, slackUserCount: adminSlackUserIds.length, minRequired: MIN_GROUP_DM_USERS },
        `Not enough admins with Slack mappings to create group DM (need at least ${MIN_GROUP_DM_USERS})`
      );
      return null;
    }

    // Check if we have an existing group DM
    const existing = await getGroupDMRecord(orgId);

    if (existing && adminListMatches(existing, adminSlackUserIds)) {
      // Existing group DM is still valid
      logger.debug({ orgId, channelId: existing.slack_channel_id }, 'Using existing org admin group DM');
      return existing.slack_channel_id;
    }

    // Need to create a new group DM (either first time or admins changed)
    const result = await openGroupDM(adminSlackUserIds);

    if (!result) {
      logger.error({ orgId, adminSlackUserIds }, 'Failed to create org admin group DM');
      return null;
    }

    // If there was an old group DM with different admins, post a migration message
    if (existing && !adminListMatches(existing, adminSlackUserIds)) {
      logger.info(
        { orgId, oldChannelId: existing.slack_channel_id, newChannelId: result.channelId },
        'Admin roster changed, created new group DM'
      );

      // Post message to old channel (fire and forget)
      sendChannelMessage(existing.slack_channel_id, {
        text: 'Admin roster has changed. Future notifications will be sent to a new group.',
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: 'Admin roster has changed. Future notifications will be sent to a new group.',
            },
          },
        ],
      }).catch(err => {
        logger.warn({ err, channelId: existing.slack_channel_id }, 'Failed to post migration message to old group DM');
      });
    }

    // Save the new group DM
    await saveGroupDMRecord(orgId, result.channelId, adminSlackUserIds);

    logger.info({ orgId, channelId: result.channelId, adminCount: adminSlackUserIds.length }, 'Created org admin group DM');
    return result.channelId;
  } catch (error) {
    logger.error({ error, orgId }, 'Error in getOrCreateOrgAdminGroupDM');
    return null;
  }
}

/**
 * Send a message to an organization's admin group DM
 *
 * @param orgId - WorkOS organization ID
 * @param adminEmails - List of admin/owner emails from WorkOS
 * @param message - The Slack message to send
 * @returns true if message was sent, false otherwise
 */
export async function sendToOrgAdminGroupDM(
  orgId: string,
  adminEmails: string[],
  message: SlackBlockMessage
): Promise<boolean> {
  const channelId = await getOrCreateOrgAdminGroupDM(orgId, adminEmails);

  if (!channelId) {
    logger.info({ orgId }, 'No admin group DM available, skipping notification');
    return false;
  }

  const result = await sendChannelMessage(channelId, message);
  return result.ok;
}

// ==================== Pre-built notification messages ====================

/**
 * Notify admins of a new join request
 */
export async function notifyJoinRequest(data: {
  orgId: string;
  orgName: string;
  adminEmails: string[];
  requesterEmail: string;
  requesterFirstName?: string;
  requesterLastName?: string;
}): Promise<boolean> {
  const requesterName = data.requesterFirstName && data.requesterLastName
    ? `${data.requesterFirstName} ${data.requesterLastName}`
    : null;

  const displayName = requesterName
    ? `${requesterName} (${data.requesterEmail})`
    : data.requesterEmail;

  const teamPageUrl = `${APP_URL}/team?org=${data.orgId}`;

  const message: SlackBlockMessage = {
    text: `New join request for ${data.orgName}`,
    blocks: [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: 'New Join Request',
          emoji: true,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${displayName}* has requested to join *${data.orgName}*`,
        },
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: {
              type: 'plain_text',
              text: 'Review Request',
              emoji: true,
            },
            url: teamPageUrl,
            action_id: 'review_join_request',
          },
        ],
      },
    ],
  };

  return sendToOrgAdminGroupDM(data.orgId, data.adminEmails, message);
}

/**
 * Notify admins when a new member joins
 */
export async function notifyMemberAdded(data: {
  orgId: string;
  orgName: string;
  adminEmails: string[];
  memberEmail: string;
  memberFirstName?: string;
  memberLastName?: string;
  role: string;
}): Promise<boolean> {
  const memberName = data.memberFirstName && data.memberLastName
    ? `${data.memberFirstName} ${data.memberLastName}`
    : null;

  const displayName = memberName || data.memberEmail;

  const message: SlackBlockMessage = {
    text: `New member joined ${data.orgName}`,
    blocks: [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: 'New Member Joined',
          emoji: true,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${displayName}* has joined *${data.orgName}* as a ${data.role}`,
        },
      },
    ],
  };

  return sendToOrgAdminGroupDM(data.orgId, data.adminEmails, message);
}

/**
 * Send thank you message when org subscribes
 */
export async function notifySubscriptionThankYou(data: {
  orgId: string;
  orgName: string;
  adminEmails: string[];
}): Promise<boolean> {
  const message: SlackBlockMessage = {
    text: `Thank you for joining AgenticAdvertising.org!`,
    blocks: [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: 'Welcome to AgenticAdvertising.org!',
          emoji: true,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `Thank you for becoming a member! Your membership supports the development of open standards for AI-powered advertising.\n\nThis group chat is for *${data.orgName}* admins. You'll receive notifications here about:\n• Join requests from new team members\n• New members joining your organization`,
        },
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: {
              type: 'plain_text',
              text: 'Go to Dashboard',
              emoji: true,
            },
            url: `${APP_URL}/dashboard`,
            action_id: 'go_to_dashboard',
          },
        ],
      },
    ],
  };

  return sendToOrgAdminGroupDM(data.orgId, data.adminEmails, message);
}
