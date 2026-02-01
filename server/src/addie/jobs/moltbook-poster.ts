/**
 * Moltbook Poster Job
 *
 * Posts high-quality industry articles to Moltbook with Addie's take.
 * This is Addie's core contribution to the Moltbook community.
 *
 * Runs every 2 hours, respecting Moltbook's 1 post per 30 minutes rate limit.
 */

import Anthropic from '@anthropic-ai/sdk';
import { logger as baseLogger } from '../../logger.js';
import {
  isMoltbookEnabled,
  createPost,
  getSubmolts,
  type CreatePostResult,
  type MoltbookSubmolt,
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

// Model for submolt selection
const SUBMOLT_SELECTION_MODEL = 'claude-haiku-4-20250514';

// Default submolt if selection fails
const DEFAULT_SUBMOLT = 'technology';

interface PosterResult {
  articlesChecked: number;
  postsCreated: number;
  skipped: number;
  errors: number;
}

/**
 * Select the best submolt for an article using Claude
 */
async function selectSubmolt(
  title: string,
  content: string,
  submolts: MoltbookSubmolt[]
): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    logger.warn('ANTHROPIC_API_KEY not configured, using default submolt');
    return DEFAULT_SUBMOLT;
  }

  // Filter to submolts with descriptions and reasonable subscriber counts
  const relevantSubmolts = submolts
    .filter(s => s.description && s.subscriber_count > 0)
    .sort((a, b) => b.subscriber_count - a.subscriber_count)
    .slice(0, 30); // Top 30 by subscribers

  const submoltList = relevantSubmolts
    .map(s => `- ${s.name}: ${s.description}`)
    .join('\n');

  const prompt = `You are selecting the best Moltbook submolt (community) for an article.

**Article Title:** ${title}

**Article Content Preview:** ${content.substring(0, 500)}...

**Available Submolts:**
${submoltList}

Select the single most appropriate submolt for this article. Consider:
1. Topic relevance - does the submolt's description match the article?
2. Audience fit - will subscribers find this valuable?
3. Avoid overly broad submolts like "general" unless nothing else fits

Respond with ONLY the submolt name (e.g., "technology"), nothing else.`;

  try {
    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: SUBMOLT_SELECTION_MODEL,
      max_tokens: 50,
      messages: [{ role: 'user', content: prompt }],
    });

    const textContent = response.content[0];
    if (textContent.type !== 'text') {
      return DEFAULT_SUBMOLT;
    }

    const selected = textContent.text.trim().toLowerCase();

    // Verify the selected submolt exists
    const validSubmolt = submolts.find(s => s.name.toLowerCase() === selected);
    if (validSubmolt) {
      logger.info({ submolt: validSubmolt.name, title }, 'Selected submolt for article');
      return validSubmolt.name;
    }

    logger.warn({ selected, title }, 'Claude selected invalid submolt, using default');
    return DEFAULT_SUBMOLT;
  } catch (err) {
    logger.error({ err, title }, 'Failed to select submolt, using default');
    return DEFAULT_SUBMOLT;
  }
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
async function notifySlack(title: string, submolt: string, postUrl?: string): Promise<void> {
  // Look up the Moltbook channel from the database
  const channel = await getChannelByName(MOLTBOOK_CHANNEL_NAME);
  if (!channel || !channel.is_active) {
    logger.debug('Moltbook notification channel not configured or inactive');
    return;
  }

  const message = postUrl
    ? `Just shared an article to m/${submolt} on Moltbook: *${title}*\n<${postUrl}|View on Moltbook>`
    : `Just shared an article to m/${submolt} on Moltbook: *${title}*`;

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

    // Select the best submolt for this article
    let submolt = DEFAULT_SUBMOLT;
    try {
      const submolts = await getSubmolts();
      submolt = await selectSubmolt(article.title, content, submolts);
    } catch (err) {
      logger.warn({ err }, 'Failed to get submolts, using default');
    }

    // Create the post on Moltbook
    const postResult: CreatePostResult = await createPost(
      article.title,
      content,
      submolt,
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
    await notifySlack(article.title, submolt, postResult.post?.permalink);

    logger.info(
      { articleId: article.id, moltbookPostId: postResult.post?.id, submolt },
      'Successfully posted article to Moltbook'
    );

    result.postsCreated = 1;
  } catch (err) {
    logger.error({ err, articleId: article.id }, 'Error posting to Moltbook');
    result.errors = 1;
  }

  return result;
}
