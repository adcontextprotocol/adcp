/**
 * Moltbook Poster Job
 *
 * Posts high-quality industry articles to Moltbook with Addie's take.
 * This is Addie's core contribution to the Moltbook community.
 *
 * Runs every 2 hours, respecting Moltbook's 1 post per 30 minutes rate limit.
 */

import { logger as baseLogger } from '../../logger.js';
import {
  isMoltbookEnabled,
  createPost,
  type CreatePostResult,
} from '../services/moltbook-service.js';
import {
  getUnpostedArticles,
  recordPost,
  recordActivity,
  canPost,
} from '../../db/moltbook-db.js';
import { sendChannelMessage } from '../../slack/client.js';
import { getChannelByName } from '../../db/notification-channels-db.js';

const logger = baseLogger.child({ module: 'moltbook-poster' });

// Channel name in notification_channels table
const MOLTBOOK_CHANNEL_NAME = 'addie_moltbook';

interface PosterResult {
  articlesChecked: number;
  postsCreated: number;
  skipped: number;
  errors: number;
}

/**
 * Format Addie's take for Moltbook posting
 * Keeps the content focused and engaging
 */
function formatMoltbookContent(addieNotes: string, articleUrl: string): string {
  // Addie's notes already have an emoji and engaging take from content curator
  // Add the source link at the end
  return `${addieNotes}\n\nSource: ${articleUrl}`;
}

/**
 * Notify the #moltbook Slack channel about the post
 */
async function notifySlack(title: string, postUrl?: string): Promise<void> {
  // Look up the Moltbook channel from the database
  const channel = await getChannelByName(MOLTBOOK_CHANNEL_NAME);
  if (!channel || !channel.is_active) {
    logger.debug('Moltbook notification channel not configured or inactive');
    return;
  }

  const message = postUrl
    ? `Just shared an article on Moltbook: *${title}*\n<${postUrl}|View on Moltbook>`
    : `Just shared an article on Moltbook: *${title}*`;

  try {
    await sendChannelMessage(channel.slack_channel_id, {
      text: message,
    });
  } catch (err) {
    logger.warn({ err, channelId: channel.slack_channel_id }, 'Failed to notify Slack about Moltbook post');
  }
}

/**
 * Run the Moltbook poster job
 */
export async function runMoltbookPosterJob(options: { limit?: number } = {}): Promise<PosterResult> {
  const limit = options.limit ?? 1; // Default to posting 1 article at a time
  const result: PosterResult = {
    articlesChecked: 0,
    postsCreated: 0,
    skipped: 0,
    errors: 0,
  };

  // Check if Moltbook is enabled
  if (!isMoltbookEnabled()) {
    logger.debug('Moltbook is not enabled or configured');
    return result;
  }

  // Check rate limit
  const canPostNow = await canPost();
  if (!canPostNow) {
    logger.debug('Rate limited - cannot post to Moltbook yet (30-minute limit)');
    result.skipped = 1;
    return result;
  }

  // Get articles that haven't been posted to Moltbook yet
  const articles = await getUnpostedArticles(limit);
  result.articlesChecked = articles.length;

  if (articles.length === 0) {
    logger.debug('No articles available to post to Moltbook');
    return result;
  }

  // Post the first eligible article
  const article = articles[0];

  try {
    logger.info({ articleId: article.id, title: article.title }, 'Posting article to Moltbook');

    const content = formatMoltbookContent(article.addie_notes, article.external_url);

    // Create the post on Moltbook
    const postResult: CreatePostResult = await createPost(
      article.title,
      content,
      undefined, // No specific submolt for now
      article.external_url
    );

    if (!postResult.success) {
      logger.error({ error: postResult.error, articleId: article.id }, 'Failed to post to Moltbook');
      result.errors = 1;
      return result;
    }

    // Record the post in our database
    await recordPost({
      moltbookPostId: postResult.post?.id,
      knowledgeId: parseInt(article.id, 10),
      title: article.title,
      content,
      url: postResult.post?.permalink,
    });

    // Record the activity
    await recordActivity('post', postResult.post?.id, undefined, article.title);

    // Notify Slack
    await notifySlack(article.title, postResult.post?.permalink);

    logger.info(
      { articleId: article.id, moltbookPostId: postResult.post?.id },
      'Successfully posted article to Moltbook'
    );

    result.postsCreated = 1;
  } catch (err) {
    logger.error({ err, articleId: article.id }, 'Error posting to Moltbook');
    result.errors = 1;
  }

  return result;
}
