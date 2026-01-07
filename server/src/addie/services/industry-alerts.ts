/**
 * Industry Alerts Service
 *
 * Sends Slack notifications for industry articles with pacing:
 * - Quality 5 articles: Post immediately
 * - Quality 4 articles: Post only if channel has been quiet for 3+ hours
 * - Quality < 4: Ignored (not relevant enough for our community)
 *
 * Posts one article at a time to encourage engagement.
 */

import { logger } from '../../logger.js';
import { sendChannelMessage } from '../../slack/client.js';
import type { SlackBlock } from '../../slack/types.js';
import { query } from '../../db/client.js';
import { recordPerspectiveAlert } from '../../db/industry-feeds-db.js';
import {
  getActiveChannels,
  isWebsiteOnlyChannel,
  type NotificationChannel,
  type FallbackRules,
} from '../../db/notification-channels-db.js';

// Minimum hours of quiet before posting a quality 4 article
const QUIET_PERIOD_HOURS = 3;

interface ArticleToAlert {
  id: string;
  perspective_id: string;
  title: string;
  link: string;
  summary: string;
  addie_notes: string;
  quality_score: number;
  mentions_agentic: boolean;
  mentions_adcp: boolean;
  relevance_tags: string[];
  feed_name: string;
  notification_channel_ids: string[] | null;
}

/**
 * Determine alert level for visual formatting based on article attributes
 */
function determineAlertLevel(article: ArticleToAlert): 'urgent' | 'high' | 'medium' | 'digest' {
  if (article.mentions_adcp) {
    return 'urgent';
  }
  if (article.mentions_agentic) {
    return 'high';
  }
  if (article.quality_score && article.quality_score >= 4) {
    return 'medium';
  }
  return 'digest';
}

/**
 * Evaluate fallback rules for a channel against an article
 * Returns true if the article matches the channel's criteria
 */
function evaluateFallbackRules(
  article: ArticleToAlert,
  rules: FallbackRules
): boolean {
  // If no rules, don't match by default
  if (!rules || Object.keys(rules).length === 0) {
    return false;
  }

  // Check minimum quality
  if (rules.min_quality !== undefined) {
    if (!article.quality_score || article.quality_score < rules.min_quality) {
      return false;
    }
  }

  // Check required tags (at least one must match)
  if (rules.require_tags && rules.require_tags.length > 0) {
    const articleTags = article.relevance_tags || [];
    const hasRequiredTag = rules.require_tags.some(tag =>
      articleTags.includes(tag)
    );
    if (!hasRequiredTag) {
      return false;
    }
  }

  // Check AdCP mention requirement
  if (rules.require_mentions_adcp && !article.mentions_adcp) {
    return false;
  }

  // Check agentic mention requirement
  if (rules.require_mentions_agentic && !article.mentions_agentic) {
    return false;
  }

  return true;
}

/**
 * Build Slack message blocks for a single article alert
 * Format: Title header, source link, Addie's take with discussion CTA
 */
function buildAlertBlocks(article: ArticleToAlert): SlackBlock[] {
  // Slack header blocks have a 150 character limit for plain_text
  const headerTitle = (article.title || 'Industry Alert').substring(0, 150);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const blocks: any[] = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: headerTitle,
        emoji: true,
      },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `<${article.link}|${article.feed_name}>`,
        },
      ],
    },
  ];

  // Addie's take includes emoji and discussion prompt baked in from content curator
  if (article.addie_notes) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: article.addie_notes,
      },
    });
  }

  return blocks;
}

/**
 * Send an alert to a specific channel
 */
async function sendAlertToChannel(
  article: ArticleToAlert,
  channelId: string,
  alertLevel: 'urgent' | 'high' | 'medium' | 'digest'
): Promise<boolean> {
  try {
    const blocks = buildAlertBlocks(article);
    const fallbackText = `${article.title} - ${article.feed_name}`;

    const result = await sendChannelMessage(channelId, {
      text: fallbackText,
      blocks,
    });

    if (result.ok && result.ts) {
      await recordPerspectiveAlert(article.perspective_id, alertLevel, channelId, result.ts);
      logger.info(
        {
          perspectiveId: article.perspective_id,
          channelId,
          alertLevel,
          qualityScore: article.quality_score,
          title: article.title,
        },
        'Sent industry alert'
      );
      return true;
    }

    logger.warn(
      { error: result.error, perspectiveId: article.perspective_id, channelId },
      'Slack API returned error'
    );
    return false;
  } catch (error) {
    logger.error(
      { error, perspectiveId: article.perspective_id, channelId },
      'Failed to send industry alert'
    );
    return false;
  }
}

/**
 * Check if a channel has been quiet (no Addie posts) for the specified hours
 */
async function isChannelQuiet(channelId: string, hours: number): Promise<boolean> {
  const result = await query<{ last_post: Date | null }>(
    `SELECT MAX(sent_at) as last_post
     FROM industry_alerts
     WHERE channel_id = $1
       AND sent_at > NOW() - INTERVAL '1 hour' * $2`,
    [channelId, hours]
  );
  return !result.rows[0]?.last_post;
}

/**
 * Get a single high-quality article ready for alerting to a specific channel
 * Quality 5 articles are always eligible; quality 4 only if channel is quiet
 */
async function getNextArticleForChannel(
  channelId: string,
  channelQuiet: boolean
): Promise<ArticleToAlert | null> {
  // Build quality filter: always include 5, include 4 if quiet
  const minQuality = channelQuiet ? 4 : 5;

  const result = await query<ArticleToAlert>(
    `SELECT
       k.id,
       p.id as perspective_id,
       p.title,
       p.external_url as link,
       k.summary,
       k.addie_notes,
       k.quality_score,
       k.mentions_agentic,
       k.mentions_adcp,
       k.relevance_tags,
       k.notification_channel_ids,
       f.name as feed_name
     FROM addie_knowledge k
     JOIN perspectives p ON k.source_url = p.external_url
     JOIN industry_feeds f ON p.feed_id = f.id
     WHERE p.source_type = 'rss'
       AND k.fetch_status = 'success'
       AND k.quality_score >= $1
       AND (
         $2 = ANY(k.notification_channel_ids)
         OR k.notification_channel_ids IS NULL
         OR array_length(k.notification_channel_ids, 1) = 0
       )
       AND NOT EXISTS (
         SELECT 1 FROM industry_alerts ia
         WHERE ia.perspective_id = p.id
           AND ia.channel_id = $2
       )
     ORDER BY
       k.quality_score DESC,
       k.mentions_adcp DESC,
       k.mentions_agentic DESC,
       k.created_at ASC
     LIMIT 1`,
    [minQuality, channelId]
  );
  return result.rows[0] || null;
}


/**
 * Process and send alerts for qualifying articles
 *
 * Pacing rules:
 * - Only posts ONE article per channel per run
 * - Quality 5: Post immediately
 * - Quality 4: Post only if channel has been quiet for 3+ hours
 * - Quality < 4: Ignored (not posted anywhere)
 */
export async function processAlerts(): Promise<{
  checked: number;
  alerted: number;
  byChannel: Record<string, number>;
}> {
  // Get active notification channels
  const channels = await getActiveChannels();
  const byChannel: Record<string, number> = {};
  let alerted = 0;
  let checked = 0;

  // Process each Slack channel (skip website-only)
  for (const channel of channels) {
    if (isWebsiteOnlyChannel(channel)) {
      continue;
    }

    const channelId = channel.slack_channel_id;

    // Check if channel has been quiet
    const isQuiet = await isChannelQuiet(channelId, QUIET_PERIOD_HOURS);

    // Get next article for this channel
    const article = await getNextArticleForChannel(channelId, isQuiet);
    checked++;

    if (!article) {
      logger.debug({ channelId, channelName: channel.name, isQuiet }, 'No article ready for channel');
      continue;
    }

    // Verify pacing: quality 5 always posts, quality 4 only if quiet
    if (article.quality_score === 4 && !isQuiet) {
      logger.debug(
        { channelId, channelName: channel.name, qualityScore: article.quality_score },
        'Skipping quality 4 article - channel not quiet'
      );
      continue;
    }

    const alertLevel = determineAlertLevel(article);
    const success = await sendAlertToChannel(article, channelId, alertLevel);

    if (success) {
      alerted++;
      byChannel[channel.name] = (byChannel[channel.name] || 0) + 1;
    }
  }

  logger.debug({ checked, alerted, byChannel }, 'Completed alert processing');

  return { checked, alerted, byChannel };
}

/**
 * @deprecated Daily digest is no longer used - replaced by paced single-article posts
 */
export async function sendDailyDigest(): Promise<boolean> {
  logger.debug('Daily digest is deprecated - using paced single-article posts instead');
  return true;
}
