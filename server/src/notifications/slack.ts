/**
 * Slack notification service for AAO member events
 */

import { logger } from '../logger.js';
import { sendChannelMessage, sendDirectMessage, isSlackConfigured } from '../slack/client.js';
import { SlackDatabase } from '../db/slack-db.js';
import type { SlackBlockMessage } from '../slack/types.js';
import { isSafeSlackLinkTarget, sanitizeSlackLine, sanitizeSlackLinkLabel } from '../utils/slack-escape.js';

const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;
const APP_URL = process.env.APP_URL || 'https://agenticadvertising.org';

interface SlackMessage {
  text: string;
  blocks?: SlackBlock[];
}

interface SlackBlock {
  type: string;
  text?: {
    type: string;
    text: string;
    emoji?: boolean;
  };
  fields?: Array<{
    type: string;
    text: string;
  }>;
  elements?: Array<{
    type: string;
    text?: string;
    url?: string;
  }>;
}

/**
 * Send a message to Slack via incoming webhook with retry logic
 */
async function sendWithRetry(payload: SlackMessage, maxRetries = 3): Promise<boolean> {
  if (!SLACK_WEBHOOK_URL) {
    logger.debug('Slack webhook not configured, skipping notification');
    return false;
  }

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(SLACK_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (response.ok) {
        logger.info({ attempt }, 'Slack notification sent successfully');
        return true;
      }

      const text = await response.text();
      logger.warn(
        { status: response.status, body: text, attempt, maxRetries },
        'Slack notification failed, will retry'
      );

      if (attempt < maxRetries) {
        const delay = Math.pow(2, attempt) * 1000;
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    } catch (error) {
      logger.error({ error, attempt, maxRetries }, 'Failed to send Slack notification');

      if (attempt === maxRetries) {
        return false;
      }

      const delay = Math.pow(2, attempt) * 1000;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  return false;
}

/**
 * Send a message to Slack via incoming webhook
 */
export async function sendSlackMessage(message: SlackMessage): Promise<boolean> {
  return sendWithRetry(message);
}

/**
 * Render `<url|label>`, or just the label when the target has a shape that
 * would break out of Slack link syntax. The label half is sanitized by the
 * caller; the target half cannot be escaped, so it is checked instead.
 */
function slackLink(url: string, label: string): string {
  return isSafeSlackLinkTarget(url) ? `<${url}|${label}>` : label;
}

/**
 * Drop backticks from text we are about to put inside a ``` fence. The
 * fenced copy is meant to be selected and pasted verbatim, so escaping the
 * mrkdwn would corrupt it — removing the one character that can close the
 * fence keeps the block intact without rewriting the author's words.
 */
function stripFenceBreakers(value: string): string {
  return value.replace(/`/g, '');
}

/**
 * Format currency amount from cents to dollars
 */
function formatAmount(cents: number, currency: string = 'usd'): string {
  const amount = cents / 100;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency.toUpperCase(),
  }).format(amount);
}

/**
 * Mask email address to prevent PII exposure
 * Example: john.doe@example.com → j***@example.com
 */
function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain) return '***';
  const masked = local.charAt(0) + '***';
  return `${masked}@${domain}`;
}

/**
 * Notify when a new subscription is created
 */
export async function notifyNewSubscription(data: {
  organizationName: string;
  customerEmail: string;
  productName?: string;
  amount?: number;
  currency?: string;
  interval?: string;
}): Promise<boolean> {
  const intervalText = data.interval === 'year' ? '/year' : '/month';
  const amountText = data.amount ? formatAmount(data.amount, data.currency) + intervalText : 'Custom';
  // Organization and product names are set by the paying org / the Stripe
  // catalog, not by us (adcp#8320).
  const organizationName = sanitizeSlackLine(data.organizationName, 120);
  const productName = sanitizeSlackLine(data.productName || 'Membership', 120);

  return sendSlackMessage({
    text: `🎉 New AAO Member: ${organizationName}`,
    blocks: [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: '🎉 New AAO Member!',
          emoji: true,
        },
      },
      {
        type: 'section',
        fields: [
          {
            type: 'mrkdwn',
            text: `*Organization:*\n${organizationName}`,
          },
          {
            type: 'mrkdwn',
            text: `*Email:*\n${sanitizeSlackLine(maskEmail(data.customerEmail), 120)}`,
          },
          {
            type: 'mrkdwn',
            text: `*Plan:*\n${productName}`,
          },
          {
            type: 'mrkdwn',
            text: `*Amount:*\n${amountText}`,
          },
        ],
      },
    ],
  });
}

/**
 * Notify when a payment succeeds
 */
export async function notifyPaymentSucceeded(data: {
  organizationName: string;
  amount: number;
  currency: string;
  productName?: string;
  isRecurring: boolean;
}): Promise<boolean> {
  const emoji = data.isRecurring ? '💰' : '🎊';
  const paymentType = data.isRecurring ? 'Recurring Payment' : 'New Payment';
  const organizationName = sanitizeSlackLine(data.organizationName, 120);
  const productName = sanitizeSlackLine(data.productName || 'Membership', 120);

  return sendSlackMessage({
    text: `${emoji} ${paymentType}: ${formatAmount(data.amount, data.currency)} from ${organizationName}`,
    blocks: [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: `${emoji} ${paymentType} Received`,
          emoji: true,
        },
      },
      {
        type: 'section',
        fields: [
          {
            type: 'mrkdwn',
            text: `*Organization:*\n${organizationName}`,
          },
          {
            type: 'mrkdwn',
            text: `*Amount:*\n${formatAmount(data.amount, data.currency)}`,
          },
          {
            type: 'mrkdwn',
            text: `*Product:*\n${productName}`,
          },
          {
            type: 'mrkdwn',
            text: `*Type:*\n${data.isRecurring ? 'Recurring' : 'Initial'}`,
          },
        ],
      },
    ],
  });
}

/**
 * Notify when a payment fails
 */
export async function notifyPaymentFailed(data: {
  organizationName: string;
  amount: number;
  currency: string;
  attemptCount: number;
}): Promise<boolean> {
  const organizationName = sanitizeSlackLine(data.organizationName, 120);

  return sendSlackMessage({
    text: `⚠️ Payment Failed: ${organizationName} - ${formatAmount(data.amount, data.currency)}`,
    blocks: [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: '⚠️ Payment Failed',
          emoji: true,
        },
      },
      {
        type: 'section',
        fields: [
          {
            type: 'mrkdwn',
            text: `*Organization:*\n${organizationName}`,
          },
          {
            type: 'mrkdwn',
            text: `*Amount:*\n${formatAmount(data.amount, data.currency)}`,
          },
          {
            type: 'mrkdwn',
            text: `*Attempt:*\n#${data.attemptCount}`,
          },
        ],
      },
    ],
  });
}

/**
 * Notify when a subscription is cancelled
 */
export async function notifySubscriptionCancelled(data: {
  organizationName: string;
  productName?: string;
}): Promise<boolean> {
  const organizationName = sanitizeSlackLine(data.organizationName, 120);
  const productName = sanitizeSlackLine(data.productName || 'Membership', 120);

  return sendSlackMessage({
    text: `😢 Subscription Cancelled: ${organizationName}`,
    blocks: [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: '😢 Subscription Cancelled',
          emoji: true,
        },
      },
      {
        type: 'section',
        fields: [
          {
            type: 'mrkdwn',
            text: `*Organization:*\n${organizationName}`,
          },
          {
            type: 'mrkdwn',
            text: `*Plan:*\n${productName}`,
          },
        ],
      },
    ],
  });
}

/**
 * Notify when a new member profile is created
 */
export async function notifyNewMemberProfile(data: {
  displayName: string;
  organizationName: string;
  slug: string;
  offerings?: string[];
}): Promise<boolean> {
  // Every field here is member-set profile text landing in a staff channel
  // (adcp#8320), so each one is flattened, capped and mrkdwn-escaped.
  const displayName = sanitizeSlackLine(data.displayName, 120);
  const organizationName = sanitizeSlackLine(data.organizationName, 120);
  const slug = sanitizeSlackLine(data.slug, 120);
  const offeringsText = data.offerings?.length
    ? sanitizeSlackLine(data.offerings.join(', '), 400)
    : 'Not specified';

  return sendSlackMessage({
    text: `👤 New Member Profile: ${displayName}`,
    blocks: [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: '👤 New Member Profile Created',
          emoji: true,
        },
      },
      {
        type: 'section',
        fields: [
          {
            type: 'mrkdwn',
            text: `*Display Name:*\n${displayName}`,
          },
          {
            type: 'mrkdwn',
            text: `*Organization:*\n${organizationName}`,
          },
          {
            type: 'mrkdwn',
            text: `*Slug:*\n${slug}`,
          },
          {
            type: 'mrkdwn',
            text: `*Offerings:*\n${offeringsText}`,
          },
        ],
      },
    ],
  });
}

/**
 * Notify when a new working group post is published
 */
export async function notifyWorkingGroupPost(data: {
  workingGroupName: string;
  workingGroupSlug: string;
  postTitle: string;
  postSlug: string;
  authorName: string;
  contentType: 'article' | 'link';
  category?: string;
}): Promise<boolean> {
  const emoji = data.contentType === 'link' ? '🔗' : '📝';
  const typeLabel = data.contentType === 'link' ? 'Link' : 'Article';
  const postUrl = `https://agenticadvertising.org/working-groups/${data.workingGroupSlug}/posts/${data.postSlug}`;
  const groupUrl = `https://agenticadvertising.org/working-groups/${data.workingGroupSlug}`;
  // Member-authored (adcp#8320). The two that sit inside `<url|label>` also
  // drop `|`, which escaping alone leaves able to restructure the link.
  const postTitle = sanitizeSlackLinkLabel(data.postTitle, 160);
  const workingGroupName = sanitizeSlackLinkLabel(data.workingGroupName, 120);
  const authorName = sanitizeSlackLine(data.authorName, 120);
  const category = data.category ? sanitizeSlackLine(data.category, 80) : '';

  return sendSlackMessage({
    text: `${emoji} New ${typeLabel} in ${workingGroupName}: ${postTitle}`,
    blocks: [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: `${emoji} New Working Group Post`,
          emoji: true,
        },
      },
      {
        type: 'section',
        fields: [
          {
            type: 'mrkdwn',
            text: `*Title:*\n${slackLink(postUrl, postTitle)}`,
          },
          {
            type: 'mrkdwn',
            text: `*Working Group:*\n${slackLink(groupUrl, workingGroupName)}`,
          },
          {
            type: 'mrkdwn',
            text: `*Author:*\n${authorName}`,
          },
          {
            type: 'mrkdwn',
            text: `*Type:*\n${typeLabel}${category ? ` (${category})` : ''}`,
          },
        ],
      },
    ],
  });
}

/**
 * Send a notification to a working group's Slack channel about a published post.
 * Uses the chapter bot to post directly to the channel.
 */
export async function notifyWorkingGroupSlackChannel(data: {
  slackChannelId: string;
  workingGroupName: string;
  workingGroupSlug: string;
  postTitle: string;
  postSlug: string;
  authorName: string;
  contentType: 'article' | 'link';
  excerpt?: string;
  externalUrl?: string;
  category?: string;
}): Promise<boolean> {
  if (!isSlackConfigured()) {
    logger.debug('Slack not configured, skipping channel notification');
    return false;
  }

  const emoji = data.contentType === 'link' ? '🔗' : '📝';
  const headerText = data.contentType === 'link' ? 'New Link Shared' : 'New Post Published';
  const postUrl = `${APP_URL}/working-groups/${data.workingGroupSlug}/posts/${data.postSlug}`;
  // Member-authored post content posted into the group's own channel
  // (adcp#8320). `postTitle` is a link label, so it also drops `|`; the
  // excerpt is multi-line free text, so flattening is what stops it forging
  // the "Posted by …" line below it.
  const postTitle = sanitizeSlackLinkLabel(data.postTitle, 160);
  const workingGroupName = sanitizeSlackLine(data.workingGroupName, 120);
  const authorName = sanitizeSlackLine(data.authorName, 120);
  const category = data.category ? sanitizeSlackLine(data.category, 80) : '';
  const excerpt = data.excerpt ? sanitizeSlackLine(data.excerpt, 400) : '';
  // Member-supplied on a link post, and the only field here that is a URL
  // rather than prose — so it is checked rather than escaped.
  const externalUrl = data.externalUrl && isSafeSlackLinkTarget(data.externalUrl)
    ? data.externalUrl
    : '';

  // Build message blocks
  const message: SlackBlockMessage = {
    text: `${emoji} ${headerText} in ${workingGroupName}: ${postTitle}`,
    blocks: [
      {
        type: 'header',
        text: {
          type: 'plain_text' as const,
          text: `${emoji} ${headerText}`,
          emoji: true,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn' as const,
          text: `*${slackLink(postUrl, postTitle)}*${excerpt ? `\n${excerpt}` : ''}`,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn' as const,
          text: `Posted by ${authorName}${category ? ` • ${category}` : ''}`,
        },
      },
      // Add external URL for link posts
      ...(data.contentType === 'link' && externalUrl ? [{
        type: 'section',
        text: {
          type: 'mrkdwn' as const,
          text: `🔗 ${externalUrl}`,
        },
      }] : []),
    ],
  };

  try {
    const result = await sendChannelMessage(data.slackChannelId, message);
    if (result.ok) {
      logger.info(
        { channelId: data.slackChannelId, postSlug: data.postSlug },
        'Sent working group post notification to Slack channel'
      );
      return true;
    } else {
      logger.warn(
        { channelId: data.slackChannelId, error: result.error },
        'Failed to send working group post notification'
      );
      return false;
    }
  } catch (error) {
    logger.error({ error, channelId: data.slackChannelId }, 'Error sending Slack channel notification');
    return false;
  }
}

/**
 * Notify a working group's Slack channel about a published post.
 * Checks if the post is members-only (skips) and if the working group has a channel configured.
 *
 * @param slackChannelId - The Slack channel ID (required)
 */
export async function notifyPublishedPost(data: {
  slackChannelId?: string;
  workingGroupName: string;
  workingGroupSlug: string;
  postTitle: string;
  postSlug: string;
  authorName: string;
  contentType: 'article' | 'link';
  excerpt?: string;
  externalUrl?: string;
  category?: string;
  isMembersOnly: boolean;
}): Promise<void> {
  // Skip members-only posts - don't share private content to channels
  if (data.isMembersOnly) {
    logger.debug({ postSlug: data.postSlug }, 'Skipping Slack notification for members-only post');
    return;
  }

  // Skip if no channel ID provided
  if (!data.slackChannelId) {
    logger.debug(
      { workingGroupSlug: data.workingGroupSlug },
      'No Slack channel configured for working group, skipping notification'
    );
    return;
  }

  // Send notification (fire-and-forget, errors are logged internally)
  await notifyWorkingGroupSlackChannel({
    slackChannelId: data.slackChannelId,
    workingGroupName: data.workingGroupName,
    workingGroupSlug: data.workingGroupSlug,
    postTitle: data.postTitle,
    postSlug: data.postSlug,
    authorName: data.authorName,
    contentType: data.contentType,
    excerpt: data.excerpt,
    externalUrl: data.externalUrl,
    category: data.category,
  });
}

/**
 * Notify a working group's Slack channel when a meeting starts
 */
export async function notifyMeetingStarted(data: {
  slackChannelId: string;
  meetingTitle: string;
  workingGroupName: string;
  zoomJoinUrl?: string;
}): Promise<boolean> {
  if (!isSlackConfigured()) {
    logger.debug('Slack not configured, skipping meeting started notification');
    return false;
  }

  const meetingTitle = sanitizeSlackLine(data.meetingTitle, 160);
  const workingGroupName = sanitizeSlackLine(data.workingGroupName, 120);

  const message: SlackBlockMessage = {
    text: `📹 Meeting starting now: ${meetingTitle}`,
    blocks: [
      {
        type: 'header',
        text: {
          type: 'plain_text' as const,
          text: '📹 Meeting Starting Now',
          emoji: true,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn' as const,
          text: `*${meetingTitle}*\n${workingGroupName}`,
        },
      },
      ...(data.zoomJoinUrl && isSafeSlackLinkTarget(data.zoomJoinUrl) ? [{
        type: 'section',
        text: {
          type: 'mrkdwn' as const,
          text: `<${data.zoomJoinUrl}|Join Zoom Meeting>`,
        },
      }] : []),
    ],
  };

  try {
    const result = await sendChannelMessage(data.slackChannelId, message);
    if (result.ok) {
      logger.info(
        { channelId: data.slackChannelId, meetingTitle },
        'Sent meeting started notification to Slack channel'
      );
      return true;
    } else {
      logger.warn(
        { channelId: data.slackChannelId, error: result.error },
        'Failed to send meeting started notification'
      );
      return false;
    }
  } catch (error) {
    logger.error({ error, channelId: data.slackChannelId }, 'Error sending meeting started notification');
    return false;
  }
}

/**
 * Notify a working group's Slack channel when a meeting ends
 */
export async function notifyMeetingEnded(data: {
  slackChannelId: string;
  meetingTitle: string;
  workingGroupName: string;
  durationMinutes?: number;
}): Promise<boolean> {
  if (!isSlackConfigured()) {
    logger.debug('Slack not configured, skipping meeting ended notification');
    return false;
  }

  const durationText = data.durationMinutes
    ? `Duration: ${Math.floor(data.durationMinutes / 60)}h ${data.durationMinutes % 60}m`
    : '';
  const meetingTitle = sanitizeSlackLine(data.meetingTitle, 160);
  const workingGroupName = sanitizeSlackLine(data.workingGroupName, 120);

  const message: SlackBlockMessage = {
    text: `✅ Meeting ended: ${meetingTitle}`,
    blocks: [
      {
        type: 'header',
        text: {
          type: 'plain_text' as const,
          text: '✅ Meeting Ended',
          emoji: true,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn' as const,
          text: `*${meetingTitle}*\n${workingGroupName}${durationText ? `\n${durationText}` : ''}`,
        },
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: {
              type: 'mrkdwn' as const,
              text: 'Recording and transcript will be available soon.',
            },
          },
        ],
      },
    ],
  };

  try {
    const result = await sendChannelMessage(data.slackChannelId, message);
    if (result.ok) {
      logger.info(
        { channelId: data.slackChannelId, meetingTitle },
        'Sent meeting ended notification to Slack channel'
      );
      return true;
    } else {
      logger.warn(
        { channelId: data.slackChannelId, error: result.error },
        'Failed to send meeting ended notification'
      );
      return false;
    }
  } catch (error) {
    logger.error({ error, channelId: data.slackChannelId }, 'Error sending meeting ended notification');
    return false;
  }
}

/**
 * Send a DM to the author of a published perspective with ready-to-post
 * social media copy for LinkedIn and X/Twitter.
 *
 * Skips silently when:
 * - The author has no mapped Slack user ID
 * - The content is a link post (not an article)
 * - The content is members-only
 * - Slack is not configured
 */
export async function sendSocialAmplificationDM(data: {
  proposerUserId: string;
  title: string;
  excerpt?: string;
  subtitle?: string;
  workingGroupSlug: string;
  postSlug: string;
  contentType: 'article' | 'link';
  isMembersOnly: boolean;
}): Promise<boolean> {
  // Only articles, not link posts
  if (data.contentType === 'link') {
    logger.debug({ postSlug: data.postSlug }, 'Skipping social amplification DM for link post');
    return false;
  }

  // Not for members-only content
  if (data.isMembersOnly) {
    logger.debug({ postSlug: data.postSlug }, 'Skipping social amplification DM for members-only post');
    return false;
  }

  if (!isSlackConfigured()) {
    logger.debug('Slack not configured, skipping social amplification DM');
    return false;
  }

  // Look up the author's Slack user ID via the mapping table
  const slackDb = new SlackDatabase();
  const mapping = await slackDb.getByWorkosUserId(data.proposerUserId);

  if (!mapping?.slack_user_id) {
    logger.debug(
      { proposerUserId: data.proposerUserId, postSlug: data.postSlug },
      'No Slack user mapping for author, skipping social amplification DM'
    );
    return false;
  }

  const postUrl = `${APP_URL}/working-groups/${data.workingGroupSlug}/posts/${data.postSlug}`;
  // Slack rejects a header block over 150 characters with `invalid_blocks`,
  // and member-authored titles run to 500 — an uncapped title silently
  // loses the author their whole amplification DM.
  const headerTitle = sanitizeSlackLine(data.title, 110);
  // Fenced below, so a backtick run in the excerpt would close the fence.
  const socialText = stripFenceBreakers(data.excerpt || data.subtitle || '');

  // LinkedIn: use excerpt/subtitle with URL and hashtags
  const linkedInPost = `"${socialText}"\n\nRead more: ${postUrl}\n\n#AgenticAdvertising #AdCP #AdTech #AI`;

  // Twitter: title + short excerpt, keep under 280 chars
  const tweetBase = `${stripFenceBreakers(data.title)} — `;
  const tweetHashtags = `\n\n${postUrl}\n\n#AgenticAdvertising #AdCP`;
  const tweetBudget = 280 - tweetBase.length - tweetHashtags.length;
  const tweetExcerpt = tweetBudget > 0 && socialText
    ? socialText.length <= tweetBudget
      ? socialText
      : socialText.slice(0, tweetBudget - 1) + '\u2026'
    : '';
  const tweetPost = tweetExcerpt
    ? `${tweetBase}${tweetExcerpt}${tweetHashtags}`
    : `${stripFenceBreakers(data.title)}${tweetHashtags}`;

  const message: SlackBlockMessage = {
    text: `Your perspective "${headerTitle}" is live!`,
    blocks: [
      {
        type: 'header',
        text: {
          type: 'plain_text' as const,
          text: `Your perspective "${headerTitle}" is live! \ud83c\udf89`,
          emoji: true,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn' as const,
          text: "Here's ready-to-post copy for social media:",
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn' as const,
          text: `*LinkedIn:*\n\`\`\`${linkedInPost}\`\`\``,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn' as const,
          text: `*X/Twitter:*\n\`\`\`${tweetPost}\`\`\``,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn' as const,
          text: 'Share it to help spread the word about agentic advertising and AdCP!',
        },
      },
    ],
  };

  try {
    const result = await sendDirectMessage(mapping.slack_user_id, message);
    if (result.ok) {
      logger.info(
        { slackUserId: mapping.slack_user_id, postSlug: data.postSlug },
        'Sent social amplification DM to author'
      );
      return true;
    } else {
      logger.warn(
        { slackUserId: mapping.slack_user_id, error: result.error },
        'Failed to send social amplification DM'
      );
      return false;
    }
  } catch (error) {
    logger.error({ error, slackUserId: mapping.slack_user_id }, 'Error sending social amplification DM');
    return false;
  }
}
