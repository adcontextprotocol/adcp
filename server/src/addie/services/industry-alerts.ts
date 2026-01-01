/**
 * Industry Alerts Service
 *
 * Sends Slack notifications for industry articles based on:
 * 1. AI-driven channel routing (from addie_knowledge.notification_channel_ids)
 * 2. Fallback rules when AI routing is empty/null
 */

import { logger } from '../../logger.js';
import { sendChannelMessage } from '../../slack/client.js';
import type { SlackBlock } from '../../slack/types.js';
import { query } from '../../db/client.js';
import {
  recordPerspectiveAlert,
  hasAlertedPerspective,
} from '../../db/industry-feeds-db.js';
import {
  getActiveChannels,
  type NotificationChannel,
  type FallbackRules,
} from '../../db/notification-channels-db.js';

// Legacy channel for backward compatibility (deprecated)
const LEGACY_CHANNEL_ID = process.env.INDUSTRY_INTEL_CHANNEL_ID;

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
 * Build Slack message blocks for an article alert
 */
function buildAlertBlocks(
  article: ArticleToAlert,
  alertLevel: 'urgent' | 'high' | 'medium' | 'digest'
): SlackBlock[] {
  const emoji = {
    urgent: ':rotating_light:',
    high: ':star:',
    medium: ':newspaper:',
    digest: ':bookmark:',
  }[alertLevel];

  const levelText = {
    urgent: 'URGENT - AdCP/Agentic Mention',
    high: 'HIGH - Agentic AI in Advertising',
    medium: 'Notable Industry Article',
    digest: 'Industry Update',
  }[alertLevel];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const blocks: any[] = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: `${emoji} ${levelText}`,
        emoji: true,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*<${article.link}|${article.title}>*\n_Source: ${article.feed_name}_`,
      },
    },
  ];

  if (article.summary) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: article.summary,
      },
    });
  }

  if (article.addie_notes) {
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `*Why this matters:* ${article.addie_notes}`,
        },
      ],
    });
  }

  if (article.relevance_tags && article.relevance_tags.length > 0) {
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `Tags: ${article.relevance_tags.map(t => `\`${t}\``).join(' ')}`,
        },
      ],
    });
  }

  blocks.push({ type: 'divider' });

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
    const blocks = buildAlertBlocks(article, alertLevel);
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
 * Get articles ready for alerting (processed with analysis, not yet alerted)
 */
async function getArticlesToAlert(): Promise<ArticleToAlert[]> {
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
       AND NOT EXISTS (
         SELECT 1 FROM industry_alerts ia
         WHERE ia.perspective_id = p.id
       )
     ORDER BY
       k.mentions_adcp DESC,
       k.mentions_agentic DESC,
       k.quality_score DESC NULLS LAST
     LIMIT 20`
  );
  return result.rows;
}

/**
 * Process and send alerts for qualifying articles
 * Uses AI-driven routing with fallback rules
 */
export async function processAlerts(): Promise<{
  checked: number;
  alerted: number;
  byChannel: Record<string, number>;
}> {
  const articles = await getArticlesToAlert();

  if (articles.length === 0) {
    logger.debug('No articles need alerting');
    return { checked: 0, alerted: 0, byChannel: {} };
  }

  logger.debug({ count: articles.length }, 'Processing articles for alerting');

  // Get active notification channels
  const channels = await getActiveChannels();
  const channelMap = new Map<string, NotificationChannel>();
  for (const ch of channels) {
    channelMap.set(ch.slack_channel_id, ch);
  }

  let alerted = 0;
  const byChannel: Record<string, number> = {};

  for (const article of articles) {
    // Skip if already alerted (race condition protection)
    if (await hasAlertedPerspective(article.perspective_id)) {
      continue;
    }

    const alertLevel = determineAlertLevel(article);

    // Determine which channels to send to
    let targetChannelIds: string[] = [];

    // 1. Use AI-routed channels if available
    if (article.notification_channel_ids && article.notification_channel_ids.length > 0) {
      // Filter to only active channels
      targetChannelIds = article.notification_channel_ids.filter(id => channelMap.has(id));
    }

    // 2. If no AI routing, apply fallback rules
    if (targetChannelIds.length === 0 && channels.length > 0) {
      for (const channel of channels) {
        if (evaluateFallbackRules(article, channel.fallback_rules)) {
          targetChannelIds.push(channel.slack_channel_id);
        }
      }
    }

    // 3. Legacy fallback: use env var channel if no channels configured
    if (targetChannelIds.length === 0 && channels.length === 0 && LEGACY_CHANNEL_ID) {
      targetChannelIds = [LEGACY_CHANNEL_ID];
    }

    // 4. If still no channels, record as digest (no notification)
    if (targetChannelIds.length === 0) {
      await recordPerspectiveAlert(article.perspective_id, 'digest');
      byChannel['(no-channel)'] = (byChannel['(no-channel)'] || 0) + 1;
      continue;
    }

    // Send to each target channel
    for (const channelId of targetChannelIds) {
      const success = await sendAlertToChannel(article, channelId, alertLevel);
      if (success) {
        alerted++;
        const channelName = channelMap.get(channelId)?.name || channelId;
        byChannel[channelName] = (byChannel[channelName] || 0) + 1;
      }

      // Small delay between alerts
      await new Promise(resolve => setTimeout(resolve, 300));
    }
  }

  logger.debug({ checked: articles.length, alerted, byChannel }, 'Completed alert processing');

  return { checked: articles.length, alerted, byChannel };
}

/**
 * Send a daily digest to all active channels
 */
export async function sendDailyDigest(): Promise<boolean> {
  const channels = await getActiveChannels();

  // Fall back to legacy channel if no channels configured
  const targetChannels = channels.length > 0
    ? channels.map(c => c.slack_channel_id)
    : LEGACY_CHANNEL_ID
      ? [LEGACY_CHANNEL_ID]
      : [];

  if (targetChannels.length === 0) {
    logger.debug('No channels configured for daily digest');
    return false;
  }

  // Get articles from last 24 hours that weren't sent as real-time alerts
  const result = await query<{
    id: number;
    title: string;
    link: string;
    summary: string;
    feed_name: string;
    quality_score: number;
  }>(
    `SELECT DISTINCT ON (k.source_url)
       k.id, k.title, k.source_url as link, k.summary, f.name as feed_name, k.quality_score
     FROM addie_knowledge k
     JOIN perspectives p ON k.source_url = p.external_url
     JOIN industry_feeds f ON p.feed_id = f.id
     LEFT JOIN industry_alerts ia ON ia.perspective_id = p.id
     WHERE p.source_type = 'rss'
       AND k.fetch_status = 'success'
       AND k.created_at > NOW() - INTERVAL '24 hours'
       AND (ia.id IS NULL OR ia.alert_level = 'digest')
     ORDER BY k.source_url, k.quality_score DESC NULLS LAST
     LIMIT 10`
  );

  if (result.rows.length === 0) {
    logger.debug('No digest articles to send');
    return true;
  }

  const articles = result.rows;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const blocks: any[] = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: ':newspaper: Daily Industry Digest',
        emoji: true,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `Here are ${articles.length} notable articles from the last 24 hours:`,
      },
    },
    { type: 'divider' },
  ];

  for (const article of articles) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*<${article.link}|${article.title}>*\n_${article.feed_name}_ • Quality: ${article.quality_score || '?'}/5\n${article.summary?.substring(0, 200) || ''}${article.summary && article.summary.length > 200 ? '...' : ''}`,
      },
    });
  }

  blocks.push({ type: 'divider' });

  let success = false;
  for (const channelId of targetChannels) {
    try {
      const msgResult = await sendChannelMessage(channelId, {
        text: `Daily Industry Digest - ${articles.length} articles`,
        blocks,
      });

      if (msgResult.ok) {
        logger.info({ channelId, articleCount: articles.length }, 'Sent daily digest');
        success = true;
      }
    } catch (error) {
      logger.error({ error, channelId }, 'Failed to send daily digest');
    }
  }

  return success;
}
