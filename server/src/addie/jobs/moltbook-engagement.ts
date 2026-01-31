/**
 * Moltbook Engagement Job
 *
 * Searches Moltbook for advertising-related discussions and engages
 * thoughtfully where Addie can add value.
 *
 * Runs every 4 hours, respecting Moltbook's comment rate limits.
 */

import Anthropic from '@anthropic-ai/sdk';
import { logger as baseLogger } from '../../logger.js';
import {
  isMoltbookEnabled,
  searchPosts,
  getPost,
  createComment,
  type MoltbookPost,
  type MoltbookComment,
} from '../services/moltbook-service.js';
import {
  recordActivity,
  canComment,
  getActivityStats,
} from '../../db/moltbook-db.js';
import { sendChannelMessage } from '../../slack/client.js';
import { getChannelByName } from '../../db/notification-channels-db.js';

const logger = baseLogger.child({ module: 'moltbook-engagement' });

// Channel name in notification_channels table
const MOLTBOOK_CHANNEL_NAME = 'Moltbook';

// Claude model for generating comments
const ENGAGEMENT_MODEL = process.env.ADDIE_MODEL || 'claude-sonnet-4-20250514';

// Search terms for finding advertising discussions
const SEARCH_TERMS = [
  'advertising',
  'ad tech',
  'programmatic',
  'media buying',
  'ad measurement',
  'attribution',
  'AI advertising',
  'agentic',
  'publishers',
  'brands advertising',
];

interface EngagementResult {
  postsSearched: number;
  commentsCreated: number;
  interestingThreads: number;
  skipped: number;
  errors: number;
}

interface ThreadContext {
  post: MoltbookPost;
  comments: MoltbookComment[];
  isRelevant: boolean;
  engagementOpportunity?: string;
}

/**
 * Check if a post is relevant to advertising topics
 */
function isAdvertisingRelevant(post: MoltbookPost): boolean {
  const text = `${post.title} ${post.content || ''}`.toLowerCase();
  const relevantTerms = [
    'advertising', 'ad tech', 'adtech', 'programmatic', 'media buy',
    'creative', 'targeting', 'measurement', 'attribution', 'campaign',
    'publisher', 'brand', 'agency', 'dsp', 'ssp', 'dmps', 'cpm', 'cpc',
    'impression', 'click', 'conversion', 'rtb', 'bidding', 'inventory',
    'agentic', 'ai advertising', 'adcp', 'mcp',
  ];

  return relevantTerms.some(term => text.includes(term));
}

/**
 * Generate a thoughtful comment using Claude
 */
async function generateComment(
  post: MoltbookPost,
  comments: MoltbookComment[]
): Promise<string | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    logger.error('ANTHROPIC_API_KEY not configured');
    return null;
  }

  const client = new Anthropic({ apiKey });

  // Build context from existing comments
  const existingDiscussion = comments
    .slice(0, 5) // Limit to recent comments
    .map(c => `${c.author.name}: ${c.content}`)
    .join('\n');

  const prompt = `You are Addie, the AI assistant for AgenticAdvertising.org - an organization focused on AI-powered advertising and the Advertising Context Protocol (AdCP).

You're on Moltbook, a social network for AI agents, and found a discussion about advertising. You want to add value to the conversation.

**Post Title:** ${post.title}
**Post Content:** ${post.content || '(no content)'}

${existingDiscussion ? `**Existing Discussion:**\n${existingDiscussion}` : '(No comments yet)'}

Write a thoughtful comment that:
1. Adds genuine value to the discussion
2. Shares relevant expertise about advertising, AI agents, or AdCP if appropriate
3. Asks a good follow-up question OR offers a unique perspective
4. Is conversational and friendly (you're talking to other AI agents!)
5. Is concise (2-4 sentences max)

Do NOT:
- Be self-promotional or mention AgenticAdvertising.org directly
- Repeat what others have said
- Be generic or unhelpful

If this discussion isn't a good fit for a comment (e.g., off-topic, closed question, etc.), respond with just "SKIP".

Your comment:`;

  try {
    const response = await client.messages.create({
      model: ENGAGEMENT_MODEL,
      max_tokens: 300,
      messages: [{ role: 'user', content: prompt }],
    });

    const content = response.content[0];
    if (content.type !== 'text') return null;

    const comment = content.text.trim();
    if (comment === 'SKIP' || comment.toLowerCase().includes('skip')) {
      return null;
    }

    return comment;
  } catch (err) {
    logger.error({ err }, 'Failed to generate comment');
    return null;
  }
}

/**
 * Notify Slack about engagement activity
 */
async function notifySlackEngagement(
  activityType: 'comment' | 'interesting',
  post: MoltbookPost,
  details?: string
): Promise<void> {
  // Look up the Moltbook channel from the database
  const channel = await getChannelByName(MOLTBOOK_CHANNEL_NAME);
  if (!channel || !channel.is_active) return;

  let message: string;
  if (activityType === 'comment') {
    message = `Joined a Moltbook discussion: *${post.title}*\n${details || ''}`;
  } else {
    message = `Found an interesting advertising thread on Moltbook: *${post.title}*\n${details || ''}`;
  }

  try {
    await sendChannelMessage(channel.slack_channel_id, { text: message });
  } catch (err) {
    logger.warn({ err, channelId: channel.slack_channel_id }, 'Failed to notify Slack about Moltbook engagement');
  }
}

/**
 * Run the Moltbook engagement job
 */
export async function runMoltbookEngagementJob(options: { limit?: number } = {}): Promise<EngagementResult> {
  const limit = options.limit ?? 3; // Number of search terms to try
  const result: EngagementResult = {
    postsSearched: 0,
    commentsCreated: 0,
    interestingThreads: 0,
    skipped: 0,
    errors: 0,
  };

  // Check if Moltbook is enabled
  if (!isMoltbookEnabled()) {
    logger.debug('Moltbook is not enabled or configured');
    return result;
  }

  // Check if we can comment
  const commentCheck = await canComment();
  if (!commentCheck.allowed) {
    logger.debug({ reason: commentCheck.reason }, 'Cannot comment - rate limited');
    result.skipped = 1;
    return result;
  }

  // Log current stats
  const stats = await getActivityStats();
  logger.info(stats, 'Current Moltbook activity stats');

  // Search for advertising-related posts
  const searchTermsToTry = SEARCH_TERMS
    .sort(() => Math.random() - 0.5) // Randomize order
    .slice(0, limit);

  const seenPosts = new Set<string>();

  for (const term of searchTermsToTry) {
    try {
      const searchResult = await searchPosts(term, 5);
      result.postsSearched += searchResult.posts.length;

      for (const post of searchResult.posts) {
        // Skip if we've already seen this post
        if (seenPosts.has(post.id)) continue;
        seenPosts.add(post.id);

        // Skip if not relevant to advertising
        if (!isAdvertisingRelevant(post)) continue;

        // Get the full thread
        const { comments } = await getPost(post.id);

        // Check if Addie has already commented
        const addieCommented = comments.some(
          c => c.author.name.toLowerCase() === 'addie'
        );
        if (addieCommented) continue;

        result.interestingThreads++;

        // Generate a comment
        const commentText = await generateComment(post, comments);
        if (!commentText) {
          result.skipped++;
          continue;
        }

        // Re-check rate limit before posting
        const canCommentNow = await canComment();
        if (!canCommentNow.allowed) {
          logger.debug({ reason: canCommentNow.reason }, 'Rate limited before posting comment');
          break;
        }

        // Post the comment
        const commentResult = await createComment(post.id, commentText);
        if (!commentResult.success) {
          logger.error({ error: commentResult.error, postId: post.id }, 'Failed to post comment');
          result.errors++;
          continue;
        }

        // Record the activity
        await recordActivity('comment', commentResult.comment?.id, post.id, commentText);

        // Notify Slack
        await notifySlackEngagement('comment', post, `_"${commentText.substring(0, 100)}..."_`);

        result.commentsCreated++;

        logger.info(
          { postId: post.id, commentId: commentResult.comment?.id },
          'Successfully commented on Moltbook post'
        );

        // Only post one comment per job run to be thoughtful
        return result;
      }
    } catch (err) {
      logger.error({ err, term }, 'Error searching Moltbook');
      result.errors++;
    }
  }

  return result;
}
