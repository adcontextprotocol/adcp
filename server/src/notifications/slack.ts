/**
 * Slack notification service for AAO member events
 */

import { logger } from '../logger.js';
import { sendChannelMessage, isSlackConfigured } from '../slack/client.js';
import type { SlackBlockMessage } from '../slack/types.js';

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

  return sendSlackMessage({
    text: `🎉 New AAO Member: ${data.organizationName}`,
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
            text: `*Organization:*\n${data.organizationName}`,
          },
          {
            type: 'mrkdwn',
            text: `*Email:*\n${maskEmail(data.customerEmail)}`,
          },
          {
            type: 'mrkdwn',
            text: `*Plan:*\n${data.productName || 'Membership'}`,
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

  return sendSlackMessage({
    text: `${emoji} ${paymentType}: ${formatAmount(data.amount, data.currency)} from ${data.organizationName}`,
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
            text: `*Organization:*\n${data.organizationName}`,
          },
          {
            type: 'mrkdwn',
            text: `*Amount:*\n${formatAmount(data.amount, data.currency)}`,
          },
          {
            type: 'mrkdwn',
            text: `*Product:*\n${data.productName || 'Membership'}`,
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
  return sendSlackMessage({
    text: `⚠️ Payment Failed: ${data.organizationName} - ${formatAmount(data.amount, data.currency)}`,
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
            text: `*Organization:*\n${data.organizationName}`,
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
  return sendSlackMessage({
    text: `😢 Subscription Cancelled: ${data.organizationName}`,
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
            text: `*Organization:*\n${data.organizationName}`,
          },
          {
            type: 'mrkdwn',
            text: `*Plan:*\n${data.productName || 'Membership'}`,
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
  const offeringsText = data.offerings?.length
    ? data.offerings.join(', ')
    : 'Not specified';

  return sendSlackMessage({
    text: `👤 New Member Profile: ${data.displayName}`,
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
            text: `*Display Name:*\n${data.displayName}`,
          },
          {
            type: 'mrkdwn',
            text: `*Organization:*\n${data.organizationName}`,
          },
          {
            type: 'mrkdwn',
            text: `*Slug:*\n${data.slug}`,
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
  const postUrl = `https://agenticadvertising.org/working-groups/${data.workingGroupSlug}#post-${data.postSlug}`;
  const groupUrl = `https://agenticadvertising.org/working-groups/${data.workingGroupSlug}`;

  return sendSlackMessage({
    text: `${emoji} New ${typeLabel} in ${data.workingGroupName}: ${data.postTitle}`,
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
            text: `*Title:*\n<${postUrl}|${data.postTitle}>`,
          },
          {
            type: 'mrkdwn',
            text: `*Working Group:*\n<${groupUrl}|${data.workingGroupName}>`,
          },
          {
            type: 'mrkdwn',
            text: `*Author:*\n${data.authorName}`,
          },
          {
            type: 'mrkdwn',
            text: `*Type:*\n${typeLabel}${data.category ? ` (${data.category})` : ''}`,
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
  const postUrl = `${APP_URL}/working-groups/${data.workingGroupSlug}#post-${data.postSlug}`;

  // Build message blocks
  const message: SlackBlockMessage = {
    text: `${emoji} ${headerText} in ${data.workingGroupName}: ${data.postTitle}`,
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
          text: `*<${postUrl}|${data.postTitle}>*${data.excerpt ? `\n${data.excerpt}` : ''}`,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn' as const,
          text: `Posted by ${data.authorName}${data.category ? ` • ${data.category}` : ''}`,
        },
      },
      // Add external URL for link posts
      ...(data.contentType === 'link' && data.externalUrl ? [{
        type: 'section',
        text: {
          type: 'mrkdwn' as const,
          text: `🔗 ${data.externalUrl}`,
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
