/**
 * Community Articles Service
 *
 * Handles articles shared by community members in managed channels.
 * When someone posts an article link:
 * 1. React with :eyes: to acknowledge
 * 2. Queue for content processing
 * 3. Reply with Addie's take once processed
 *
 * This amplifies community contributions and feeds the website.
 */

import { logger } from '../../logger.js';
import { query } from '../../db/client.js';
import { getChannelBySlackId } from '../../db/notification-channels-db.js';

/**
 * Check if a Slack channel is a managed notification channel
 */
export async function isManagedChannel(slackChannelId: string): Promise<boolean> {
  const channel = await getChannelBySlackId(slackChannelId);
  return channel !== null && channel.is_active;
}

/**
 * Extract article URLs from message text
 * Filters out non-article URLs (images, videos, social media posts, etc.)
 */
export function extractArticleUrls(text: string): string[] {
  // Match URLs in Slack format <url|label> or plain URLs
  const slackUrlPattern = /<(https?:\/\/[^|>]+)(?:\|[^>]*)?>|(?<![<|])(https?:\/\/[^\s<>]+)/gi;
  const urls: string[] = [];
  let match;

  while ((match = slackUrlPattern.exec(text)) !== null) {
    const url = match[1] || match[2];
    if (url && !urls.includes(url) && isLikelyArticleUrl(url)) {
      urls.push(url);
    }
  }

  return urls;
}

/**
 * Check if a URL is likely an article (vs image, video, social post, etc.)
 */
function isLikelyArticleUrl(url: string): boolean {
  const urlLower = url.toLowerCase();

  // Skip media files
  const mediaExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.mp4', '.mov', '.pdf'];
  if (mediaExtensions.some(ext => urlLower.endsWith(ext))) {
    return false;
  }

  // Skip social media posts (these don't have article content)
  const socialPatterns = [
    /twitter\.com\/\w+\/status/,
    /x\.com\/\w+\/status/,
    /linkedin\.com\/posts/,
    /linkedin\.com\/feed/,
    /instagram\.com\/p\//,
    /tiktok\.com/,
    /youtube\.com\/watch/,
    /youtu\.be\//,
  ];
  if (socialPatterns.some(pattern => pattern.test(urlLower))) {
    return false;
  }

  // Google Docs/Sheets/Slides ARE valid - we can read them via Google API
  // (handled specially in content-curator.ts)

  return true;
}

/**
 * Queue a community-shared article for processing
 */
export async function queueCommunityArticle(params: {
  url: string;
  sharedByUserId: string;
  channelId: string;
  messageTs: string;
  sharedByDisplayName?: string;
}): Promise<number | null> {
  const { url, sharedByUserId, channelId, messageTs, sharedByDisplayName } = params;

  // Check if URL already exists in knowledge base
  const existing = await query<{ id: number }>(
    `SELECT id FROM addie_knowledge WHERE source_url = $1`,
    [url]
  );

  if (existing.rows.length > 0) {
    logger.debug({ url }, 'Community article already in knowledge base');
    return null;
  }

  // Insert into addie_knowledge with community source
  const result = await query<{ id: number }>(
    `INSERT INTO addie_knowledge (
       title,
       category,
       source_url,
       fetch_url,
       source_type,
       fetch_status,
       discovery_source,
       discovery_context,
       created_by
     ) VALUES (
       'Community shared article',
       'Industry News',
       $1,
       $1,
       'community',
       'pending',
       'community_share',
       $2,
       'system'
     )
     ON CONFLICT (source_url) DO NOTHING
     RETURNING id`,
    [
      url,
      JSON.stringify({
        shared_by_user_id: sharedByUserId,
        shared_by_display_name: sharedByDisplayName,
        channel_id: channelId,
        message_ts: messageTs,
        shared_at: new Date().toISOString(),
      }),
    ]
  );

  if (result.rows.length > 0) {
    logger.info(
      { url, userId: sharedByUserId, channelId },
      'Queued community article for processing'
    );
    return result.rows[0].id;
  }

  return null;
}

/**
 * Get community articles that have been processed and need replies
 */
export async function getPendingCommunityReplies(): Promise<Array<{
  id: number;
  source_url: string;
  title: string;
  addie_notes: string;
  quality_score: number;
  channel_id: string;
  message_ts: string;
  shared_by_user_id: string;
}>> {
  const result = await query<{
    id: number;
    source_url: string;
    title: string;
    addie_notes: string;
    quality_score: number;
    discovery_context: {
      channel_id: string;
      message_ts: string;
      shared_by_user_id: string;
      reply_sent?: boolean;
    };
  }>(
    `SELECT id, source_url, title, addie_notes, quality_score, discovery_context
     FROM addie_knowledge
     WHERE source_type = 'community'
       AND fetch_status = 'success'
       AND discovery_source = 'community_share'
       AND (discovery_context->>'reply_sent')::boolean IS NOT TRUE
       AND quality_score >= 3
     ORDER BY created_at ASC
     LIMIT 10`
  );

  return result.rows.map(row => ({
    id: row.id,
    source_url: row.source_url,
    title: row.title,
    addie_notes: row.addie_notes,
    quality_score: row.quality_score,
    channel_id: row.discovery_context.channel_id,
    message_ts: row.discovery_context.message_ts,
    shared_by_user_id: row.discovery_context.shared_by_user_id,
  }));
}

/**
 * Mark a community article as replied to
 */
export async function markCommunityReplyComplete(id: number): Promise<void> {
  await query(
    `UPDATE addie_knowledge
     SET discovery_context = discovery_context || '{"reply_sent": true}'::jsonb,
         updated_at = NOW()
     WHERE id = $1`,
    [id]
  );
}

/**
 * Send replies to processed community articles
 * Called periodically to reply to articles that have been analyzed
 */
export async function sendCommunityReplies(
  sendReply: (channelId: string, threadTs: string, text: string) => Promise<boolean>
): Promise<{ sent: number; failed: number }> {
  const pendingReplies = await getPendingCommunityReplies();

  if (pendingReplies.length === 0) {
    return { sent: 0, failed: 0 };
  }

  let sent = 0;
  let failed = 0;

  for (const article of pendingReplies) {
    // Build reply message
    const replyText = article.addie_notes
      ? `Thanks for sharing! ${article.addie_notes}`
      : `Thanks for sharing this article on ${article.title}!`;

    try {
      const success = await sendReply(
        article.channel_id,
        article.message_ts,
        replyText
      );

      if (success) {
        await markCommunityReplyComplete(article.id);
        sent++;
        logger.info(
          { id: article.id, channelId: article.channel_id },
          'Sent community article reply'
        );
      } else {
        failed++;
      }
    } catch (error) {
      logger.error({ error, id: article.id }, 'Failed to send community article reply');
      failed++;
    }

    // Small delay between replies
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  return { sent, failed };
}
