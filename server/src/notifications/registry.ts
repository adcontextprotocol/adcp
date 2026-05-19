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
 * Strip Slack mrkdwn meta-characters from user-controlled strings before
 * interpolating them into a channel message. Without this, an uploader
 * could plant `<!channel>` / `<!here>` / `<@U…>` mentions to ping the
 * whole moderator channel, or `<https://evil/|legit-text>` to plant a
 * phishing link in a moderator-trusted surface. Replaces angle brackets
 * and ampersand with HTML-escaped equivalents and inserts a zero-width
 * space inside `!channel|here|everyone` so the broadcast token loses
 * its meaning while staying human-readable.
 */
function sanitizeMrkdwn(s: string): string {
  return s
    .replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]!))
    .replace(/!(channel|here|everyone)/gi, '!​$1');
}

/**
 * Notify moderators when a community logo upload queues for review.
 *
 * Fires from both the HTTP route and the Addie MCP tool whenever a logo
 * lands with `review_status='pending'`. Verified-owner uploads (auto-
 * approved) do NOT fire this — they're owner-attested and don't need a
 * second pair of eyes. Returns the message ts so future approval/rejection
 * notifications can thread off it.
 */
export async function notifyPendingBrandLogo(upload: {
  domain: string;
  logo_id: string;
  content_type: string;
  tags: string[];
  uploader_email?: string;
  uploader_name?: string;
  upload_note?: string;
  source: 'community' | 'addie';
}): Promise<string | null> {
  const channelId = getChannelId();
  if (!channelId || !isSlackConfigured()) return null;

  const rawUploader = upload.source === 'addie'
    ? 'Addie (chat)'
    : (upload.uploader_name || upload.uploader_email || 'Unknown');
  const uploaderDisplay = sanitizeMrkdwn(rawUploader);
  const reviewUrl = `${APP_URL}/brand/view/${upload.domain}`;
  const tagsLine = upload.tags.length ? upload.tags.join(', ') : '(none)';

  const fields = [
    { type: 'mrkdwn', text: `*Uploader:*\n${uploaderDisplay}` },
    { type: 'mrkdwn', text: `*Tags:*\n${tagsLine}` },
    { type: 'mrkdwn', text: `*Format:*\n${upload.content_type}` },
  ] as const;

  const blocks: SlackBlockMessage['blocks'] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `🖼️ *Logo pending review:* <${reviewUrl}|${upload.domain}>`,
      },
    },
    { type: 'section', fields: [...fields] },
  ];

  if (upload.upload_note) {
    // Truncate to keep the Slack block under the 3000-char text limit and
    // sanitize before interpolating — the note is uploader-controlled and
    // posted into a moderator-trusted channel.
    const note = sanitizeMrkdwn(upload.upload_note.slice(0, 500));
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*Note:*\n${note}` },
    });
  }

  const message: SlackBlockMessage = {
    text: `🖼️ Logo pending review: ${upload.domain} by ${uploaderDisplay}`,
    blocks,
  };

  try {
    const result = await sendChannelMessage(channelId, message);
    return result.ts || null;
  } catch (error) {
    logger.error({ error, domain: upload.domain, logoId: upload.logo_id }, 'Failed to send pending-logo notification');
    return null;
  }
}

/**
 * Notify (as a thread reply) when a moderator resolves a pending logo
 * upload. Threads off the original `notifyPendingBrandLogo` ts so the
 * channel reads as a conversation rather than a stream of disconnected
 * verdicts. Silently skips when `thread_ts` is missing — older uploads
 * predate the notify path and Slack-disabled environments never had a
 * parent message to thread off.
 */
export async function notifyBrandLogoReviewed(review: {
  thread_ts: string | null;
  domain: string;
  action: 'approve' | 'reject' | 'delete';
  reviewer_email?: string;
  reviewer_name?: string;
  note?: string;
}): Promise<void> {
  const channelId = getChannelId();
  if (!channelId || !isSlackConfigured() || !review.thread_ts) return;

  const verdictEmoji =
    review.action === 'approve' ? '✅' :
    review.action === 'reject' ? '❌' :
    '🗑️';
  const verdictLabel =
    review.action === 'approve' ? 'Approved' :
    review.action === 'reject' ? 'Rejected' :
    'Deleted';
  const reviewer = review.reviewer_name || review.reviewer_email || 'Moderator';
  const noteSuffix = review.note ? `\n_${review.note.slice(0, 500)}_` : '';

  const message: SlackBlockMessage = {
    text: `${verdictEmoji} ${verdictLabel} by ${reviewer}`,
    thread_ts: review.thread_ts,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `${verdictEmoji} *${verdictLabel}* by ${reviewer}${noteSuffix}`,
        },
      },
    ],
  };

  try {
    await sendChannelMessage(channelId, message);
  } catch (error) {
    logger.error({ error, domain: review.domain }, 'Failed to send logo-review thread reply');
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
