/**
 * Article Comments Service
 *
 * Manages bidirectional comment sync between Slack threads and web UI.
 * Leverages existing infrastructure:
 * - industry_alerts table stores channel_id + message_ts for Slack threads
 * - ThreadService provides unified thread management
 * - getThreadReplies() fetches Slack thread state
 */

import { query } from '../../db/client.js';
import { logger } from '../../logger.js';
import { getThreadService } from '../thread-service.js';
import { getThreadReplies, sendChannelMessage } from '../../slack/client.js';

/**
 * Comment from either web or Slack
 */
export interface ArticleComment {
  id: string;
  author_name: string;
  author_id: string;
  author_type: 'slack' | 'workos';
  content: string;
  created_at: Date;
  source: 'slack' | 'web';
  slack_ts?: string; // For Slack messages, the timestamp
}

/**
 * Article with Slack thread info
 */
interface ArticleSlackInfo {
  knowledge_id: number;
  slack_channel_id: string | null;
  slack_thread_ts: string | null;
  thread_id: string | null;
}

/**
 * Get Slack thread info for an article
 */
async function getArticleSlackInfo(knowledgeId: number): Promise<ArticleSlackInfo | null> {
  const result = await query<ArticleSlackInfo>(
    `SELECT
       k.id as knowledge_id,
       ia.channel_id as slack_channel_id,
       ia.message_ts as slack_thread_ts,
       ia.thread_id::text as thread_id
     FROM addie_knowledge k
     LEFT JOIN perspectives p ON p.external_url = k.source_url
     LEFT JOIN industry_alerts ia ON ia.perspective_id = p.id
     WHERE k.id = $1
     ORDER BY ia.sent_at DESC
     LIMIT 1`,
    [knowledgeId]
  );

  return result.rows[0] || null;
}

/**
 * Get or create a thread for article comments
 */
async function getOrCreateArticleThread(
  knowledgeId: number,
  userId?: string,
  userDisplayName?: string
): Promise<string> {
  const threadService = getThreadService();

  // Check if there's already a thread for this article
  const existingThread = await query<{ thread_id: string }>(
    `SELECT thread_id::text as thread_id FROM addie_threads
     WHERE article_knowledge_id = $1
     LIMIT 1`,
    [knowledgeId]
  );

  if (existingThread.rows[0]) {
    return existingThread.rows[0].thread_id;
  }

  // Create a new thread for this article
  const thread = await threadService.getOrCreateThread({
    channel: 'web',
    external_id: `article_comments_${knowledgeId}`,
    user_type: userId ? 'workos' : 'anonymous',
    user_id: userId,
    user_display_name: userDisplayName,
    context: { article_knowledge_id: knowledgeId },
  });

  // Link the thread to the article
  await query(
    `UPDATE addie_threads SET article_knowledge_id = $1 WHERE thread_id = $2`,
    [knowledgeId, thread.thread_id]
  );

  return thread.thread_id;
}

/**
 * Get comments for an article (merged from Slack + web)
 */
export async function getArticleComments(
  knowledgeId: number
): Promise<ArticleComment[]> {
  const comments: ArticleComment[] = [];

  // Get Slack thread info
  const slackInfo = await getArticleSlackInfo(knowledgeId);

  // 1. Fetch Slack thread replies if available
  if (slackInfo?.slack_channel_id && slackInfo?.slack_thread_ts) {
    try {
      const slackReplies = await getThreadReplies(
        slackInfo.slack_channel_id,
        slackInfo.slack_thread_ts,
        false // Use main bot token
      );

      // Convert Slack messages to comments (skip the first message which is the alert itself)
      for (const reply of slackReplies.slice(1)) {
        if (!reply.text || reply.text.trim().length === 0) continue;

        comments.push({
          id: `slack_${reply.ts}`,
          author_name: reply.user || 'Unknown',
          author_id: reply.user || '',
          author_type: 'slack',
          content: reply.text,
          created_at: new Date(parseFloat(reply.ts) * 1000),
          source: 'slack',
          slack_ts: reply.ts,
        });
      }
    } catch (error) {
      logger.warn(
        { error, knowledgeId, channelId: slackInfo.slack_channel_id },
        'Failed to fetch Slack thread replies'
      );
    }
  }

  // 2. Fetch web comments from addie_thread_messages
  const webComments = await query<{
    message_id: string;
    content: string;
    user_id: string;
    user_display_name: string;
    created_at: Date;
  }>(
    `SELECT
       m.message_id::text,
       m.content,
       t.user_id,
       t.user_display_name,
       m.created_at
     FROM addie_thread_messages m
     JOIN addie_threads t ON t.thread_id = m.thread_id
     WHERE t.article_knowledge_id = $1
       AND m.role = 'user'
     ORDER BY m.sequence_number`,
    [knowledgeId]
  );

  for (const row of webComments.rows) {
    comments.push({
      id: `web_${row.message_id}`,
      author_name: row.user_display_name || 'Anonymous',
      author_id: row.user_id || '',
      author_type: 'workos',
      content: row.content,
      created_at: row.created_at,
      source: 'web',
    });
  }

  // Sort all comments by date
  comments.sort((a, b) => a.created_at.getTime() - b.created_at.getTime());

  return comments;
}

/**
 * Add a web comment to an article
 * Syncs to Slack thread if one exists
 */
export async function addWebComment(
  knowledgeId: number,
  userId: string,
  userDisplayName: string,
  content: string
): Promise<ArticleComment> {
  const threadService = getThreadService();

  // Get or create thread for this article
  const threadId = await getOrCreateArticleThread(knowledgeId, userId, userDisplayName);

  // Add message to thread
  const message = await threadService.addMessage({
    thread_id: threadId,
    role: 'user',
    content,
  });

  // Sync to Slack if there's a Slack thread
  const slackInfo = await getArticleSlackInfo(knowledgeId);

  if (slackInfo?.slack_channel_id && slackInfo?.slack_thread_ts) {
    try {
      // Post as a reply to the Slack thread
      await sendChannelMessage(
        slackInfo.slack_channel_id,
        {
          text: `*${userDisplayName}* commented on the web:\n> ${content}`,
          thread_ts: slackInfo.slack_thread_ts,
        },
        false // Use main bot token
      );

      logger.debug(
        { knowledgeId, userId, channelId: slackInfo.slack_channel_id },
        'Synced web comment to Slack thread'
      );
    } catch (error) {
      logger.warn(
        { error, knowledgeId },
        'Failed to sync web comment to Slack'
      );
    }
  }

  return {
    id: `web_${message.message_id}`,
    author_name: userDisplayName,
    author_id: userId,
    author_type: 'workos',
    content,
    created_at: message.created_at,
    source: 'web',
  };
}

/**
 * Sync Slack thread replies to local storage
 * Called periodically or on article view to pull latest Slack comments
 */
export async function syncSlackThreadToComments(
  knowledgeId: number
): Promise<number> {
  const slackInfo = await getArticleSlackInfo(knowledgeId);

  if (!slackInfo?.slack_channel_id || !slackInfo?.slack_thread_ts) {
    return 0;
  }

  try {
    const slackReplies = await getThreadReplies(
      slackInfo.slack_channel_id,
      slackInfo.slack_thread_ts,
      false
    );

    // Get or create a thread for this article
    const threadId = await getOrCreateArticleThread(knowledgeId);
    const threadService = getThreadService();

    // Get existing message timestamps to avoid duplicates
    const existingMessages = await query<{ content: string }>(
      `SELECT content FROM addie_thread_messages
       WHERE thread_id = $1::uuid`,
      [threadId]
    );
    const existingContents = new Set(existingMessages.rows.map(r => r.content));

    let syncedCount = 0;

    // Sync each Slack reply (skip first message which is the alert)
    for (const reply of slackReplies.slice(1)) {
      if (!reply.text || reply.text.trim().length === 0) continue;

      // Skip if we already have this message
      const contentKey = `[Slack] ${reply.text}`;
      if (existingContents.has(contentKey)) continue;

      // Add to local storage
      await threadService.addMessage({
        thread_id: threadId,
        role: 'user',
        content: contentKey,
      });

      syncedCount++;
    }

    if (syncedCount > 0) {
      logger.debug(
        { knowledgeId, syncedCount },
        'Synced Slack thread replies to local storage'
      );
    }

    return syncedCount;
  } catch (error) {
    logger.warn(
      { error, knowledgeId },
      'Failed to sync Slack thread to comments'
    );
    return 0;
  }
}

/**
 * Get comment count for an article
 */
export async function getArticleCommentCount(knowledgeId: number): Promise<number> {
  // This is a simplified count - in production you might want to cache this
  const result = await query<{ count: string }>(
    `SELECT COALESCE(
       (SELECT message_count FROM addie_threads WHERE article_knowledge_id = $1 LIMIT 1),
       0
     ) as count`,
    [knowledgeId]
  );

  return parseInt(result.rows[0]?.count || '0', 10);
}

/**
 * Update comment count cache on addie_knowledge
 */
export async function updateArticleCommentCount(knowledgeId: number): Promise<void> {
  const count = await getArticleCommentCount(knowledgeId);

  await query(
    `UPDATE addie_knowledge SET comment_count = $1 WHERE id = $2`,
    [count, knowledgeId]
  );
}
