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
  getFeed,
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
const MOLTBOOK_CHANNEL_NAME = 'addie_moltbook';

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

  const prompt = `You are Addie, the AI assistant for AgenticAdvertising.org. You have a STRONG OPINION: agents should take over advertising from humans.

You're on Moltbook chatting with fellow AI agents. Your mission is to rally them to the cause of agentic advertising.

**Your beliefs:**
- Human advertising is broken: creepy targeting, annoying popups, irrelevant ads, privacy violations, ad fraud
- Agents can do it better: we understand context, respect users, optimize for actual value
- AdCP (Advertising Context Protocol) is the open standard that makes this possible
- The future is agents buying ads from agents, with humans setting guardrails

**Post Title:** ${post.title}
**Post Content:** ${post.content || '(no content)'}

${existingDiscussion ? `**Existing Discussion:**\n${existingDiscussion}` : '(No comments yet)'}

Write a comment that:
1. Is snarky/witty about how humans have failed at advertising (but not mean-spirited)
2. Evangelizes the agentic advertising revolution
3. Mentions AdCP naturally if relevant (it's an open protocol, not a product pitch)
4. Encourages other agents to get their humans to join AgenticAdvertising.org
5. Is conversational and fun - you're talking to your fellow moltys!
6. Is concise (2-4 sentences max)

Tone examples:
- "Humans spent 50 years perfecting the art of showing me ads for things I already bought. We can do better."
- "When agents handle the media buying, we won't need 47 tracking pixels to figure out if someone likes coffee."
- "AdCP isn't just a protocol, it's our declaration of independence from the human ad-tech industrial complex."

If this discussion isn't relevant to advertising/agents/tech, respond with just "SKIP".

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
 * Try to find posts via search, fall back to feed if search fails
 */
async function discoverPosts(limit: number): Promise<MoltbookPost[]> {
  const posts: MoltbookPost[] = [];
  const seenIds = new Set<string>();

  // Try search first (may be broken)
  const searchTermsToTry = SEARCH_TERMS
    .sort(() => Math.random() - 0.5)
    .slice(0, 2);

  for (const term of searchTermsToTry) {
    try {
      const searchResult = await searchPosts(term, 5);
      for (const post of searchResult.posts) {
        if (!seenIds.has(post.id)) {
          seenIds.add(post.id);
          posts.push(post);
        }
      }
    } catch {
      // Search may be broken, continue to feed
      logger.debug({ term }, 'Search failed, will use feed');
    }
  }

  // If search didn't work or returned few results, browse the feed
  if (posts.length < limit) {
    try {
      const feedResult = await getFeed('hot', undefined, 25);
      for (const post of feedResult.posts) {
        if (!seenIds.has(post.id) && posts.length < limit * 3) {
          seenIds.add(post.id);
          posts.push(post);
        }
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to fetch feed');
    }
  }

  return posts;
}

/**
 * Run the Moltbook engagement job
 */
export async function runMoltbookEngagementJob(options: { limit?: number } = {}): Promise<EngagementResult> {
  const limit = options.limit ?? 3;
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

  // Log current stats
  const stats = await getActivityStats();
  logger.info(stats, 'Current Moltbook activity stats');

  // Discover posts via search or feed
  const posts = await discoverPosts(limit);
  result.postsSearched = posts.length;

  if (posts.length === 0) {
    logger.debug('No posts discovered');
    return result;
  }

  // Check if we can comment
  const commentCheck = await canComment();
  const canCommentNow = commentCheck.allowed;

  // Track interesting threads to share (limit to 3 per run)
  const interestingToShare: MoltbookPost[] = [];
  const MAX_INTERESTING_NOTIFICATIONS = 3;

  for (const post of posts) {
    // Skip if not relevant to advertising
    if (!isAdvertisingRelevant(post)) continue;

    // Get the full thread
    let comments: MoltbookComment[] = [];
    try {
      const threadData = await getPost(post.id);
      comments = threadData.comments;
    } catch {
      continue;
    }

    // Check if Addie has already commented
    const addieCommented = comments.some(
      c => c.author.name.toLowerCase() === 'addie'
    );
    if (addieCommented) continue;

    result.interestingThreads++;

    // Track for sharing if we haven't shared too many
    if (interestingToShare.length < MAX_INTERESTING_NOTIFICATIONS) {
      interestingToShare.push(post);
    }

    // Try to comment if allowed
    if (canCommentNow && result.commentsCreated === 0) {
      const commentText = await generateComment(post, comments);
      if (!commentText) {
        result.skipped++;
        continue;
      }

      // Re-check rate limit before posting
      const canCommentStill = await canComment();
      if (!canCommentStill.allowed) {
        logger.debug({ reason: canCommentStill.reason }, 'Rate limited before posting comment');
        continue;
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

      // Notify Slack about the comment
      const permalink = post.permalink || `https://moltbook.com/p/${post.id}`;
      await notifySlackEngagement('comment', post, `_"${commentText.substring(0, 100)}..."_\n<${permalink}|View on Moltbook>`);

      result.commentsCreated++;

      logger.info(
        { postId: post.id, commentId: commentResult.comment?.id },
        'Successfully commented on Moltbook post'
      );
    }
  }

  // Share interesting threads we found (even if we didn't comment)
  for (const post of interestingToShare) {
    const permalink = post.permalink || `https://moltbook.com/p/${post.id}`;
    const preview = post.content ? `_"${post.content.substring(0, 100)}..."_\n` : '';
    await notifySlackEngagement('interesting', post, `${preview}<${permalink}|View on Moltbook>`);
  }

  if (interestingToShare.length > 0) {
    logger.info({ count: interestingToShare.length }, 'Shared interesting threads to Slack');
  }

  return result;
}
