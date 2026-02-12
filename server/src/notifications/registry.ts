/**
 * Slack notifications for registry wiki edits.
 *
 * Posts to the #registry-edits channel (configured via REGISTRY_EDITS_CHANNEL_ID).
 * Follows patterns from notifications/slack.ts.
 */

import { logger } from '../logger.js';
import { sendChannelMessage, isSlackConfigured } from '../slack/client.js';
import type { SlackBlockMessage } from '../slack/types.js';

const CHANNEL_ID = process.env.REGISTRY_EDITS_CHANNEL_ID;
const APP_URL = process.env.APP_URL || 'https://agenticadvertising.org';

function getChannelId(): string | null {
  if (!CHANNEL_ID) {
    logger.debug('REGISTRY_EDITS_CHANNEL_ID not configured, skipping registry notification');
    return null;
  }
  return CHANNEL_ID;
}

/**
 * Notify when a community member edits an existing registry record.
 * Returns the Slack message timestamp for threading.
 */
export async function notifyRegistryEdit(edit: {
  entity_type: 'brand' | 'property';
  domain: string;
  editor_email?: string;
  editor_name?: string;
  edit_summary: string;
  revision_number: number;
}): Promise<string | null> {
  const channelId = getChannelId();
  if (!channelId || !isSlackConfigured()) return null;

  const emoji = edit.entity_type === 'brand' ? '🏷️' : '🌐';
  const typeLabel = edit.entity_type === 'brand' ? 'Brand' : 'Property';
  const editorDisplay = edit.editor_name || edit.editor_email || 'Unknown';
  const viewUrl = edit.entity_type === 'brand'
    ? `${APP_URL}/brand/view/${edit.domain}`
    : `${APP_URL}/property/view/${edit.domain}`;

  const message: SlackBlockMessage = {
    text: `${emoji} ${typeLabel} edited: ${edit.domain} by ${editorDisplay}`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `${emoji} *${typeLabel} edited:* <${viewUrl}|${edit.domain}> (rev ${edit.revision_number})`,
        },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Editor:*\n${editorDisplay}` },
          { type: 'mrkdwn', text: `*Summary:*\n${edit.edit_summary}` },
        ],
      },
    ],
  };

  try {
    const result = await sendChannelMessage(channelId, message);
    return result.ts || null;
  } catch (error) {
    logger.error({ error, domain: edit.domain }, 'Failed to send registry edit notification');
    return null;
  }
}

/**
 * Notify when a new record is created and pending Addie review.
 */
export async function notifyRegistryCreate(record: {
  entity_type: 'brand' | 'property';
  domain: string;
  editor_email?: string;
  editor_name?: string;
}): Promise<string | null> {
  const channelId = getChannelId();
  if (!channelId || !isSlackConfigured()) return null;

  const emoji = record.entity_type === 'brand' ? '🏷️' : '🌐';
  const typeLabel = record.entity_type === 'brand' ? 'Brand' : 'Property';
  const editorDisplay = record.editor_name || record.editor_email || 'Unknown';

  const message: SlackBlockMessage = {
    text: `${emoji} New ${typeLabel.toLowerCase()}: ${record.domain} by ${editorDisplay} - awaiting review`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `${emoji} *New ${typeLabel.toLowerCase()} record:* \`${record.domain}\`\n_Awaiting Addie review_`,
        },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Created by:*\n${editorDisplay}` },
        ],
      },
    ],
  };

  try {
    const result = await sendChannelMessage(channelId, message);
    return result.ts || null;
  } catch (error) {
    logger.error({ error, domain: record.domain }, 'Failed to send registry create notification');
    return null;
  }
}

/**
 * Notify when Addie approves a new record.
 */
export async function notifyRegistryApproval(record: {
  entity_type: 'brand' | 'property';
  domain: string;
  thread_ts?: string;
}): Promise<void> {
  const channelId = getChannelId();
  if (!channelId || !isSlackConfigured()) return;

  const typeLabel = record.entity_type === 'brand' ? 'Brand' : 'Property';

  const message: SlackBlockMessage = {
    text: `Approved: ${record.domain}`,
    thread_ts: record.thread_ts,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `✅ *${typeLabel} approved:* \`${record.domain}\` is now visible in the registry.`,
        },
      },
    ],
  };

  try {
    await sendChannelMessage(channelId, message);
  } catch (error) {
    logger.error({ error, domain: record.domain }, 'Failed to send registry approval notification');
  }
}

/**
 * Notify when a record is rolled back.
 */
export async function notifyRegistryRollback(rollback: {
  entity_type: 'brand' | 'property';
  domain: string;
  rolled_back_to: number;
  revision_number: number;
  rolled_back_by_name?: string;
  rolled_back_by_email?: string;
}): Promise<void> {
  const channelId = getChannelId();
  if (!channelId || !isSlackConfigured()) return;

  const typeLabel = rollback.entity_type === 'brand' ? 'Brand' : 'Property';
  const editorDisplay = rollback.rolled_back_by_name || rollback.rolled_back_by_email || 'Admin';

  const message: SlackBlockMessage = {
    text: `Rollback: ${rollback.domain} restored to rev ${rollback.rolled_back_to}`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `⏪ *${typeLabel} rolled back:* \`${rollback.domain}\` restored to revision ${rollback.rolled_back_to} (now rev ${rollback.revision_number})`,
        },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*By:*\n${editorDisplay}` },
        ],
      },
    ],
  };

  try {
    await sendChannelMessage(channelId, message);
  } catch (error) {
    logger.error({ error, domain: rollback.domain }, 'Failed to send registry rollback notification');
  }
}

/**
 * Notify when a user is banned from editing.
 */
export async function notifyRegistryBan(ban: {
  entity_type: 'brand' | 'property';
  banned_email?: string;
  entity_domain?: string;
  reason: string;
  banned_by_email?: string;
}): Promise<void> {
  const channelId = getChannelId();
  if (!channelId || !isSlackConfigured()) return;

  const scope = ban.entity_domain
    ? `\`${ban.entity_domain}\``
    : `all ${ban.entity_type}s`;

  const message: SlackBlockMessage = {
    text: `Edit ban: ${ban.banned_email || 'User'} banned from editing ${scope}`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `🚫 *Edit ban:* ${ban.banned_email || 'User'} banned from editing ${scope}`,
        },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Reason:*\n${ban.reason}` },
          { type: 'mrkdwn', text: `*By:*\n${ban.banned_by_email || 'System'}` },
        ],
      },
    ],
  };

  try {
    await sendChannelMessage(channelId, message);
  } catch (error) {
    logger.error({ error }, 'Failed to send registry ban notification');
  }
}

/**
 * Post Addie's review assessment as a thread reply.
 */
export async function notifyAddieReview(review: {
  thread_ts: string;
  verdict: 'ok' | 'suspicious' | 'malicious';
  reason: string;
  domain: string;
  action_taken?: string;
}): Promise<void> {
  const channelId = getChannelId();
  if (!channelId || !isSlackConfigured()) return;

  const verdictEmoji = review.verdict === 'ok' ? '✅'
    : review.verdict === 'suspicious' ? '⚠️'
    : '🚨';

  const verdictLabel = review.verdict === 'ok' ? 'Looks good'
    : review.verdict === 'suspicious' ? 'Suspicious'
    : 'Malicious';

  let text = `${verdictEmoji} *Addie review (${verdictLabel}):* ${review.reason}`;
  if (review.action_taken) {
    text += `\n_Action: ${review.action_taken}_`;
  }

  const message: SlackBlockMessage = {
    text: `Addie review: ${verdictLabel} - ${review.domain}`,
    thread_ts: review.thread_ts,
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text },
      },
    ],
  };

  try {
    await sendChannelMessage(channelId, message);
  } catch (error) {
    logger.error({ error, domain: review.domain }, 'Failed to send Addie review notification');
  }
}
