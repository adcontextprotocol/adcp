/**
 * Organization Admin Group DM Management
 *
 * Creates and manages Slack group DMs for organization admins/owners.
 * Used to notify admins of join requests, new members, seat warnings, etc.
 */

import { query } from '../db/client.js';
import { logger } from '../logger.js';
import { openGroupDM, sendChannelMessage, sendDirectMessage } from './client.js';
import type { SlackBlockMessage, SlackBlock } from './types.js';
import type { SeatLimits, SeatType } from '../db/organization-db.js';

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

// ==================== Utilities ====================

/**
 * Escape user-supplied strings for safe interpolation into Slack mrkdwn.
 * Prevents &, <, > from being interpreted as formatting or link injection.
 */
export function escapeSlackMrkdwn(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Format a seat count as "N / M" or "N / unlimited"
 */
function formatSeatCount(used: number, limit: number): string {
  return `${used} / ${limit === -1 ? 'unlimited' : limit}`;
}

// ==================== Admin DM Infrastructure ====================

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
 * Get Slack user IDs for org admins/owners by their emails.
 * Returns only admins that have Slack mappings.
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

/**
 * Send a message to org admins with single-admin DM fallback.
 * Uses group DM when 2+ admins have Slack, falls back to direct DM for
 * single-admin orgs.
 */
export async function sendToOrgAdmins(
  orgId: string,
  adminEmails: string[],
  message: SlackBlockMessage
): Promise<boolean> {
  // Try group DM first (works with 2+ admins)
  const channelId = await getOrCreateOrgAdminGroupDM(orgId, adminEmails);

  if (channelId) {
    const result = await sendChannelMessage(channelId, message);
    return result.ok;
  }

  // Fallback: direct DM to the single admin with a Slack mapping
  const adminSlackUserIds = await getAdminSlackUserIds(adminEmails);
  if (adminSlackUserIds.length === 1) {
    const result = await sendDirectMessage(adminSlackUserIds[0], message);
    return result.ok;
  }

  // No Slack-mapped admins at all
  logger.info({ orgId }, 'No admins with Slack mappings, skipping Slack notification');
  return false;
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

  const safeDisplayName = escapeSlackMrkdwn(
    requesterName ? `${requesterName} (${data.requesterEmail})` : data.requesterEmail
  );
  const safeOrgName = escapeSlackMrkdwn(data.orgName);

  const teamPageUrl = `${APP_URL}/team?org=${data.orgId}`;

  const message: SlackBlockMessage = {
    text: `New join request for ${escapeSlackMrkdwn(data.orgName)}`,
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
          text: `*${safeDisplayName}* has requested to join *${safeOrgName}*`,
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

  return sendToOrgAdmins(data.orgId, data.adminEmails, message);
}

/**
 * Notify admins when a new member joins, including seat context.
 */
export async function notifyMemberAdded(data: {
  orgId: string;
  orgName: string;
  adminEmails: string[];
  memberEmail: string;
  memberFirstName?: string;
  memberLastName?: string;
  role: string;
  seatType?: SeatType;
  seatUsage?: { contributor: number; community_only: number };
  seatLimits?: SeatLimits;
}): Promise<boolean> {
  const memberName = data.memberFirstName && data.memberLastName
    ? `${data.memberFirstName} ${data.memberLastName}`
    : null;

  const safeDisplayName = escapeSlackMrkdwn(memberName || data.memberEmail);
  const safeOrgName = escapeSlackMrkdwn(data.orgName);

  const blocks: SlackBlock[] = [
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
        text: `*${safeDisplayName}* has joined *${safeOrgName}* as a ${data.role}`,
      },
    },
  ];

  // Add seat context if available
  if (data.seatType && data.seatUsage && data.seatLimits) {
    const seatLabel = data.seatType === 'contributor' ? 'contributor' : 'community';
    const contributorLine = `Contributor seats: ${formatSeatCount(data.seatUsage.contributor, data.seatLimits.contributor)}`;
    const communityLine = `Community seats: ${formatSeatCount(data.seatUsage.community_only, data.seatLimits.community)}`;

    let seatText = `Seat type: *${seatLabel}*\n${contributorLine} | ${communityLine}`;

    // If they're community_only and contributor seats are available, suggest promotion
    if (
      data.seatType === 'community_only' &&
      data.seatLimits.contributor !== 0 &&
      (data.seatLimits.contributor === -1 || data.seatUsage.contributor < data.seatLimits.contributor)
    ) {
      const promoteUrl = `${APP_URL}/team?org=${data.orgId}&action=promote&user=${encodeURIComponent(data.memberEmail)}`;
      seatText += `\n\nPromote to contributor? They'll gain access to working groups, councils, and product summits. <${promoteUrl}|Manage team>`;
    }

    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: seatText,
      },
    });
  }

  const message: SlackBlockMessage = {
    text: `New member joined ${escapeSlackMrkdwn(data.orgName)}`,
    blocks,
  };

  return sendToOrgAdmins(data.orgId, data.adminEmails, message);
}

/**
 * Send thank you message when org subscribes, including seat entitlement info.
 *
 * When `listing` is provided, a note and action buttons are added so admins
 * see the auto-published directory listing alongside the welcome — avoids a
 * separate send while still closing the consent loop from issue #2583.
 */
export async function notifySubscriptionThankYou(data: {
  orgId: string;
  orgName: string;
  adminEmails: string[];
  seatLimits?: SeatLimits;
  listing?: {
    slug: string;
    action: 'created' | 'published';
  };
}): Promise<boolean> {
  const safeOrgName = escapeSlackMrkdwn(data.orgName);

  let welcomeText = `Thank you for becoming a member! Your membership supports the development of open standards for AI-powered advertising.\n\nThis group chat is for *${safeOrgName}* admins. You'll receive notifications here about:\n• Join requests from new team members\n• New members joining your organization\n• Seat usage and capacity alerts`;

  if (data.seatLimits) {
    const contribLabel = data.seatLimits.contributor === -1 ? 'unlimited' : `${data.seatLimits.contributor}`;
    const communityLabel = data.seatLimits.community === -1 ? 'unlimited' : `${data.seatLimits.community}`;
    welcomeText += `\n\nYour plan includes *${contribLabel} contributor seats* and *${communityLabel} community seats*. When teammates join, you'll get a prompt to assign access.`;
  }

  const blocks: SlackBlock[] = [
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
        text: welcomeText,
      },
    },
  ];

  if (data.listing) {
    // Defense-in-depth: slugs and orgIds are validated at their source
    // (slugify → [a-z0-9-]; WorkOS orgIds are opaque `org_...`). Encode
    // both before interpolating into the Slack `<URL|label>` link syntax
    // so a future policy shift can't break the link or inject into it.
    const safeSlug = escapeSlackMrkdwn(data.listing.slug);
    const encodedOrgId = encodeURIComponent(data.orgId);
    const listingUrl = `${APP_URL}/members/${encodeURIComponent(data.listing.slug)}`;
    const editUrl = `${APP_URL}/member-profile?org=${encodedOrgId}`;
    const privacyUrl = `${APP_URL}/member-profile?org=${encodedOrgId}#field-is-public`;
    const intro = data.listing.action === 'created'
      ? `Your directory listing went live at <${listingUrl}|/members/${safeSlug}>. We created it when your membership activated so others can find you.`
      : `Your directory listing is now live at <${listingUrl}|/members/${safeSlug}> — we published it when your membership activated.`;
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${intro}\n<${editUrl}|Edit the listing> or <${privacyUrl}|make it private>.`,
      },
    });
  }

  blocks.push({
    type: 'actions',
    elements: [
      {
        type: 'button',
        text: {
          type: 'plain_text',
          text: 'Manage Team',
          emoji: true,
        },
        url: `${APP_URL}/team?org=${data.orgId}`,
        action_id: 'go_to_team',
      },
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
  });

  const message: SlackBlockMessage = {
    text: `Thank you for joining AgenticAdvertising.org!`,
    blocks,
  };

  return sendToOrgAdmins(data.orgId, data.adminEmails, message);
}

// ==================== Seat Lifecycle Notifications ====================

/**
 * Notify admins when seat usage crosses a warning threshold (80% or 100%).
 */
export async function notifySeatWarning(data: {
  orgId: string;
  orgName: string;
  adminEmails: string[];
  seatType: 'contributor' | 'community';
  threshold: 80 | 100;
  usage: number;
  limit: number;
}): Promise<boolean> {
  const safeOrgName = escapeSlackMrkdwn(data.orgName);
  const label = data.seatType === 'contributor' ? 'contributor' : 'community';

  let text: string;
  let ctaUrl: string;

  if (data.threshold === 100) {
    text = `All *${data.limit} ${label} seats* for *${safeOrgName}* are in use. Upgrade your plan for more seats, or free a seat by removing a member.`;
    ctaUrl = `${APP_URL}/team?org=${data.orgId}`;
  } else {
    text = `*${safeOrgName}* is using *${data.usage} of ${data.limit}* ${label} seats. Need more? Upgrade your plan.`;
    ctaUrl = `${APP_URL}/membership`;
  }

  const message: SlackBlockMessage = {
    text: `Seat usage alert for ${escapeSlackMrkdwn(data.orgName)}`,
    blocks: [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: data.threshold === 100 ? 'Seat Limit Reached' : 'Seat Usage Update',
          emoji: true,
        },
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text },
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: {
              type: 'plain_text',
              text: data.threshold === 100 ? 'Manage Team' : 'View Plans',
              emoji: true,
            },
            url: ctaUrl,
            action_id: `seat_warning_${data.threshold}`,
          },
        ],
      },
    ],
  };

  return sendToOrgAdmins(data.orgId, data.adminEmails, message);
}

/**
 * Notify admins when a seat frees up and the org was previously at or near capacity.
 */
export async function notifySeatFreed(data: {
  orgId: string;
  orgName: string;
  adminEmails: string[];
  seatType: 'contributor' | 'community';
  usage: number;
  limit: number;
}): Promise<boolean> {
  const safeOrgName = escapeSlackMrkdwn(data.orgName);
  const label = data.seatType === 'contributor' ? 'contributor' : 'community';

  const message: SlackBlockMessage = {
    text: `A ${label} seat has freed up for ${escapeSlackMrkdwn(data.orgName)}`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `A ${label} seat has freed up for *${safeOrgName}*. Now using ${formatSeatCount(data.usage, data.limit)}.`,
        },
      },
    ],
  };

  return sendToOrgAdmins(data.orgId, data.adminEmails, message);
}

/**
 * Notify admins when a tier change results in different seat limits.
 */
export async function notifyTierChange(data: {
  orgId: string;
  orgName: string;
  adminEmails: string[];
  oldLimits: SeatLimits;
  newLimits: SeatLimits;
  currentUsage: { contributor: number; community_only: number };
}): Promise<boolean> {
  const safeOrgName = escapeSlackMrkdwn(data.orgName);
  const teamUrl = `${APP_URL}/team?org=${data.orgId}`;

  const isUpgrade = data.newLimits.contributor > data.oldLimits.contributor ||
    data.newLimits.community > data.oldLimits.community;

  const contribOverLimit = data.newLimits.contributor !== -1 &&
    data.currentUsage.contributor > data.newLimits.contributor;
  const communityOverLimit = data.newLimits.community !== -1 &&
    data.currentUsage.community_only > data.newLimits.community;

  let text: string;
  let headerText: string;

  if (isUpgrade) {
    headerText = 'Plan Upgraded';
    const parts: string[] = [];
    if (data.newLimits.contributor !== data.oldLimits.contributor) {
      const unassigned = data.newLimits.contributor === -1
        ? 'unlimited'
        : `${data.newLimits.contributor - data.currentUsage.contributor}`;
      parts.push(`*${data.newLimits.contributor === -1 ? 'unlimited' : data.newLimits.contributor} contributor seats* (was ${data.oldLimits.contributor}). ${unassigned} unassigned.`);
    }
    if (data.newLimits.community !== data.oldLimits.community) {
      parts.push(`*${data.newLimits.community === -1 ? 'unlimited' : data.newLimits.community} community seats* (was ${data.oldLimits.community === -1 ? 'unlimited' : data.oldLimits.community}).`);
    }
    text = `*${safeOrgName}*'s plan now includes:\n${parts.join('\n')}`;
  } else {
    headerText = 'Plan Changed';
    const issues: string[] = [];
    if (contribOverLimit) {
      issues.push(`${data.currentUsage.contributor} contributors assigned but only ${data.newLimits.contributor} seats available`);
    }
    if (communityOverLimit) {
      issues.push(`${data.currentUsage.community_only} community members but only ${data.newLimits.community} seats available`);
    }

    if (issues.length > 0) {
      text = `*${safeOrgName}*'s plan has changed. Action needed:\n${issues.map(i => `• ${i}`).join('\n')}\n\nPlease choose which members to move. Existing access will continue until you make changes.`;
    } else {
      text = `*${safeOrgName}*'s plan has changed.\nContributor seats: ${formatSeatCount(data.currentUsage.contributor, data.newLimits.contributor)}\nCommunity seats: ${formatSeatCount(data.currentUsage.community_only, data.newLimits.community)}`;
    }
  }

  const message: SlackBlockMessage = {
    text: `Plan changed for ${escapeSlackMrkdwn(data.orgName)}`,
    blocks: [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: headerText,
          emoji: true,
        },
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text },
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: {
              type: 'plain_text',
              text: 'Manage Team',
              emoji: true,
            },
            url: teamUrl,
            action_id: 'tier_change_manage_team',
          },
        ],
      },
    ],
  };

  return sendToOrgAdmins(data.orgId, data.adminEmails, message);
}

/**
 * Notify admins when a member requests a seat upgrade.
 */
export async function notifySeatRequest(data: {
  orgId: string;
  orgName: string;
  adminEmails: string[];
  memberName: string;
  memberEmail: string;
  resourceType: string;
  resourceName?: string;
}): Promise<boolean> {
  const safeMemberName = escapeSlackMrkdwn(data.memberName);
  const safeOrgName = escapeSlackMrkdwn(data.orgName);
  const resourceLabel = data.resourceName
    ? escapeSlackMrkdwn(data.resourceName)
    : data.resourceType.replace(/_/g, ' ');
  const teamUrl = `${APP_URL}/team?org=${data.orgId}&action=promote&user=${encodeURIComponent(data.memberEmail)}`;

  const message: SlackBlockMessage = {
    text: `Seat upgrade request from ${escapeSlackMrkdwn(data.memberName)}`,
    blocks: [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: 'Seat Upgrade Request',
          emoji: true,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${safeMemberName}* is requesting contributor access to join *${resourceLabel}* in *${safeOrgName}*.\n\nContributor access includes working groups, councils, and product summits.`,
        },
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: {
              type: 'plain_text',
              text: 'Review & Approve',
              emoji: true,
            },
            style: 'primary',
            url: teamUrl,
            action_id: 'review_seat_request',
          },
        ],
      },
    ],
  };

  return sendToOrgAdmins(data.orgId, data.adminEmails, message);
}

/**
 * Notify a member when their seat type changes (via DM).
 */
export async function notifyMemberSeatChanged(data: {
  userId: string;
  newSeatType: SeatType;
  context?: 'admin_action' | 'request_approved' | 'request_denied';
  resourceName?: string;
}): Promise<boolean> {
  // Look up the member's Slack user ID
  const result = await query<{ slack_user_id: string }>(
    `SELECT slack_user_id FROM slack_user_mappings
     WHERE workos_user_id = $1 AND mapping_status = 'mapped' AND slack_is_deleted = false
     LIMIT 1`,
    [data.userId]
  );

  if (result.rows.length === 0) {
    logger.info({ userId: data.userId }, 'No Slack mapping for member, skipping seat change notification');
    return false;
  }

  let text: string;

  if (data.context === 'request_approved') {
    const resource = data.resourceName ? escapeSlackMrkdwn(data.resourceName) : 'the resource you requested';
    text = `Your request to access *${resource}* has been approved! You now have contributor access.\n\nYou can join working groups, councils, and product summits.`;
  } else if (data.context === 'request_denied') {
    text = `Your admin has reviewed your access request. Your access remains community-only.\n\nYou still have access to Addie, certification, training, and chapters. Contact your org admin for details.`;
  } else if (data.newSeatType === 'contributor') {
    text = `You now have *contributor access*!\n\nYou can join working groups, councils, and product summits.`;
  } else {
    text = `Your access has been changed to *community*.\n\nYou still have access to Addie, certification, training, and chapters.`;
  }

  const message: SlackBlockMessage = {
    text: text.replace(/\*/g, ''), // plain text fallback without mrkdwn
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text },
      },
    ],
  };

  const sendResult = await sendDirectMessage(result.rows[0].slack_user_id, message);
  return sendResult.ok;
}
