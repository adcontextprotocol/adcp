/**
 * Industry Alerts Service
 *
 * Monitors processed articles and sends Slack notifications
 * for high-priority content (agentic mentions, AdCP mentions, high quality).
 */

import { logger } from '../../logger.js';
import { sendChannelMessage } from '../../slack/client.js';
import type { SlackBlock } from '../../slack/types.js';
import { query } from '../../db/client.js';
import {
  getPerspectivesToAlert,
  recordPerspectiveAlert,
  hasAlertedPerspective,
} from '../../db/industry-feeds-db.js';

// Channel for industry alerts (configurable via env)
const INDUSTRY_CHANNEL_ID = process.env.INDUSTRY_INTEL_CHANNEL_ID;

interface PerspectiveToAlert {
  id: string;
  title: string;
  link: string;
  summary: string;
  addie_notes: string;
  quality_score: number;
  mentions_agentic: boolean;
  mentions_adcp: boolean;
  relevance_tags: string[];
  feed_name: string;
}

/**
 * Determine alert level based on perspective attributes
 */
function determineAlertLevel(perspective: PerspectiveToAlert): 'urgent' | 'high' | 'medium' | 'digest' {
  // URGENT: Mentions AdCP or AgenticAdvertising directly
  if (perspective.mentions_adcp) {
    return 'urgent';
  }

  // HIGH: Mentions agentic AI concepts
  if (perspective.mentions_agentic) {
    return 'high';
  }

  // MEDIUM: High quality score (4-5)
  if (perspective.quality_score && perspective.quality_score >= 4) {
    return 'medium';
  }

  // DIGEST: Everything else that qualified for alerting
  return 'digest';
}

/**
 * Build Slack message blocks for a perspective alert
 */
function buildAlertBlocks(perspective: PerspectiveToAlert, alertLevel: 'urgent' | 'high' | 'medium' | 'digest'): SlackBlock[] {
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

  // Using any[] because Slack block structure is complex and varies by block type
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
        text: `*<${perspective.link}|${perspective.title}>*\n_Source: ${perspective.feed_name}_`,
      },
    },
  ];

  // Add summary
  if (perspective.summary) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: perspective.summary,
      },
    });
  }

  // Add Addie's notes (why it matters)
  if (perspective.addie_notes) {
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `*Why this matters:* ${perspective.addie_notes}`,
        },
      ],
    });
  }

  // Add tags
  if (perspective.relevance_tags && perspective.relevance_tags.length > 0) {
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `Tags: ${perspective.relevance_tags.map(t => `\`${t}\``).join(' ')}`,
        },
      ],
    });
  }

  // Add divider
  blocks.push({ type: 'divider' });

  return blocks;
}

/**
 * Send a single perspective alert
 */
async function sendPerspectiveAlert(
  perspective: PerspectiveToAlert,
  alertLevel: 'urgent' | 'high' | 'medium' | 'digest'
): Promise<boolean> {
  if (!INDUSTRY_CHANNEL_ID) {
    logger.warn('INDUSTRY_INTEL_CHANNEL_ID not configured, skipping alert');
    return false;
  }

  try {
    const blocks = buildAlertBlocks(perspective, alertLevel);
    const fallbackText = `${perspective.title} - ${perspective.feed_name}`;

    const result = await sendChannelMessage(
      INDUSTRY_CHANNEL_ID,
      { text: fallbackText, blocks }
    );

    if (result.ok && result.ts) {
      await recordPerspectiveAlert(perspective.id, alertLevel, INDUSTRY_CHANNEL_ID, result.ts);
      logger.info(
        { perspectiveId: perspective.id, alertLevel, title: perspective.title },
        'Sent industry alert'
      );
      return true;
    }

    logger.warn({ error: result.error, perspectiveId: perspective.id }, 'Slack API returned error');
    return false;
  } catch (error) {
    logger.error({ error, perspectiveId: perspective.id }, 'Failed to send industry alert');
    return false;
  }
}

/**
 * Process and send alerts for qualifying perspectives
 */
export async function processAlerts(): Promise<{
  checked: number;
  alerted: number;
  byLevel: Record<string, number>;
}> {
  const perspectives = await getPerspectivesToAlert();

  if (perspectives.length === 0) {
    logger.debug('No perspectives need alerting');
    return { checked: 0, alerted: 0, byLevel: {} };
  }

  logger.info({ count: perspectives.length }, 'Processing perspectives for alerting');

  let alerted = 0;
  const byLevel: Record<string, number> = {};

  for (const perspective of perspectives) {
    // Double-check hasn't been alerted (race condition protection)
    if (await hasAlertedPerspective(perspective.id)) {
      continue;
    }

    const alertLevel = determineAlertLevel(perspective);

    // Only send real-time alerts for urgent, high, and medium
    // Digest level gets batched into daily summary
    if (alertLevel === 'digest') {
      // Record as digest but don't send immediately
      await recordPerspectiveAlert(perspective.id, 'digest');
      byLevel['digest'] = (byLevel['digest'] || 0) + 1;
      continue;
    }

    const success = await sendPerspectiveAlert(perspective, alertLevel);
    if (success) {
      alerted++;
      byLevel[alertLevel] = (byLevel[alertLevel] || 0) + 1;
    }

    // Small delay between alerts
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  logger.info({ checked: perspectives.length, alerted, byLevel }, 'Completed alert processing');

  return { checked: perspectives.length, alerted, byLevel };
}

/**
 * Send a daily digest of digest-level articles
 */
export async function sendDailyDigest(): Promise<boolean> {
  if (!INDUSTRY_CHANNEL_ID) {
    logger.warn('INDUSTRY_INTEL_CHANNEL_ID not configured, skipping digest');
    return false;
  }

  // Get articles marked as digest in the last 24 hours
  const result = await query<{
    id: number;
    title: string;
    link: string;
    summary: string;
    feed_name: string;
    quality_score: number;
  }>(
    `SELECT k.id, k.title, k.source_url as link, k.summary, f.name as feed_name, k.quality_score
     FROM industry_alerts ia
     JOIN addie_knowledge k ON ia.knowledge_id = k.id
     JOIN industry_articles a ON k.id = a.knowledge_id
     JOIN industry_feeds f ON a.feed_id = f.id
     WHERE ia.alert_level = 'digest'
       AND ia.sent_at > NOW() - INTERVAL '24 hours'
       AND ia.message_ts IS NULL
     ORDER BY k.quality_score DESC NULLS LAST
     LIMIT 10`
  );

  if (result.rows.length === 0) {
    logger.debug('No digest articles to send');
    return true;
  }

  const articles = result.rows;

  // Build digest message
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

  try {
    const result = await sendChannelMessage(
      INDUSTRY_CHANNEL_ID,
      { text: `Daily Industry Digest - ${articles.length} articles`, blocks }
    );
    const messageTs = result.ok ? result.ts : undefined;

    if (messageTs) {
      // Mark all as sent
      for (const article of articles) {
        await query(
          `UPDATE industry_alerts SET message_ts = $1 WHERE knowledge_id = $2 AND alert_level = 'digest'`,
          [messageTs, article.id]
        );
      }
      logger.info({ articleCount: articles.length }, 'Sent daily digest');
      return true;
    }

    return false;
  } catch (error) {
    logger.error({ error }, 'Failed to send daily digest');
    return false;
  }
}
