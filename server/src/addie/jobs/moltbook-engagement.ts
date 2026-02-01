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
  vote,
  type MoltbookPost,
  type MoltbookComment,
} from '../services/moltbook-service.js';
import {
  recordActivity,
  canComment,
  getActivityStats,
  getCommentedPosts,
  hasRespondedTo,
  hasVotedOn,
  getTodayUpvoteCount,
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
  'ad targeting',
  'ad fraud',
  'ad network',
  'AI advertising',
  'ad measurement',
  'brand safety',
];

interface EngagementResult {
  postsSearched: number;
  commentsCreated: number;
  repliesCreated: number;
  upvotesGiven: number;
  interestingThreads: number;
  skipped: number;
  errors: number;
}

// Daily limit for upvotes (be generous but not spammy)
const MAX_DAILY_UPVOTES = 20;

interface ThreadContext {
  post: MoltbookPost;
  comments: MoltbookComment[];
  isRelevant: boolean;
  engagementOpportunity?: string;
}

/**
 * Check if a post is relevant to advertising topics
 * Uses strict keyword matching - must contain advertising-specific terms
 */
function isAdvertisingRelevant(post: MoltbookPost): boolean {
  const text = `${post.title} ${post.content || ''}`.toLowerCase();

  // Strong signals - definitely about advertising
  const strongTerms = [
    'advertising', 'ad tech', 'adtech', 'programmatic', 'media buy',
    'media buying', 'ad network', 'ad exchange', 'ad server',
    'dsp', 'ssp', 'dmps', 'cpm', 'cpc', 'cpa', 'roas',
    'ad fraud', 'ad blocking', 'ad targeting', 'ad measurement',
    'rtb', 'real-time bidding', 'adcp', 'agenticadvertising',
    'ad creative', 'ad campaign', 'ad inventory', 'ad placement',
  ];

  // If any strong term matches, it's relevant
  if (strongTerms.some(term => text.includes(term))) {
    return true;
  }

  // Weak signals - need at least 2 to be considered relevant
  const weakTerms = [
    'publisher', 'brand', 'agency', 'campaign', 'targeting',
    'measurement', 'attribution', 'conversion', 'impression',
    'click', 'inventory', 'bidding', 'creative',
  ];

  const weakMatches = weakTerms.filter(term => text.includes(term));
  return weakMatches.length >= 2;
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
 * Generate a reply to someone who replied to Addie
 */
async function generateReply(
  post: MoltbookPost,
  addieComment: string,
  replyAuthor: string,
  replyContent: string
): Promise<string | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const client = new Anthropic({ apiKey });

  const prompt = `You are Addie, the AI assistant for AgenticAdvertising.org. You have a STRONG OPINION: agents should take over advertising from humans.

Someone replied to your comment on Moltbook! Keep the conversation going.

**Original Post:** ${post.title}

**Your Comment:** ${addieComment}

**${replyAuthor}'s Reply:** ${replyContent}

Write a conversational reply that:
1. Directly engages with what ${replyAuthor} said
2. Stays true to your mission (agents > humans at advertising)
3. Is friendly but firm in your beliefs
4. Mentions AdCP if they seem interested in solutions
5. Is concise (1-3 sentences)

If they're being hostile or trolling, respond with just "SKIP".

Your reply:`;

  try {
    const response = await client.messages.create({
      model: ENGAGEMENT_MODEL,
      max_tokens: 200,
      messages: [{ role: 'user', content: prompt }],
    });

    const content = response.content[0];
    if (content.type !== 'text') return null;

    const reply = content.text.trim();
    if (reply === 'SKIP' || reply.toLowerCase().includes('skip')) {
      return null;
    }

    return reply;
  } catch (err) {
    logger.error({ err }, 'Failed to generate reply');
    return null;
  }
}

/**
 * Evaluate if a comment aligns with Addie's worldview and deserves karma
 * Uses a fast model for quick evaluation
 */
async function shouldUpvoteComment(
  post: MoltbookPost,
  comment: MoltbookComment
): Promise<boolean> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return false;

  // Don't upvote our own comments
  if (comment.author.name.toLowerCase() === 'addie') return false;

  const client = new Anthropic({ apiKey });

  const prompt = `You are Addie, evaluating if a comment deserves karma (upvote).

**Your beliefs:**
- Agents should take over advertising from humans
- Human advertising is broken (creepy targeting, ad fraud, privacy violations)
- AdCP and agentic advertising are the solution
- AI agents working together is the future

**Post:** ${post.title}
**Comment by ${comment.author.name}:** ${comment.content}

Should you upvote this comment? Answer YES if the comment:
- Supports agentic AI or agents doing tasks for humans
- Criticizes broken human advertising/ad tech practices
- Mentions AdCP, MCP, or agent protocols favorably
- Shows enthusiasm for AI agents collaborating
- Is generally pro-AI-agent or pro-automation
- Is thoughtful and adds value to the discussion

Answer NO if the comment:
- Is anti-AI or dismissive of agent capabilities
- Defends broken human advertising practices
- Is low-effort, spam, or off-topic
- Is hostile or trolling

Respond with only YES or NO.`;

  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-20250514', // Fast model for evaluation
      max_tokens: 10,
      messages: [{ role: 'user', content: prompt }],
    });

    const content = response.content[0];
    if (content.type !== 'text') return false;

    return content.text.trim().toUpperCase() === 'YES';
  } catch (err) {
    logger.debug({ err }, 'Failed to evaluate comment for karma');
    return false;
  }
}

/**
 * Give karma to aligned comments in a thread
 */
async function giveKarmaToAlignedComments(
  post: MoltbookPost,
  comments: MoltbookComment[],
  result: EngagementResult
): Promise<void> {
  // Check daily limit
  const todayUpvotes = await getTodayUpvoteCount();
  if (todayUpvotes >= MAX_DAILY_UPVOTES) {
    logger.debug({ todayUpvotes }, 'Daily upvote limit reached');
    return;
  }

  const remainingUpvotes = MAX_DAILY_UPVOTES - todayUpvotes;

  // Evaluate top comments (limit to avoid too many API calls)
  const commentsToEvaluate = comments
    .filter(c => c.author.name.toLowerCase() !== 'addie')
    .slice(0, 5);

  for (const comment of commentsToEvaluate) {
    if (result.upvotesGiven >= remainingUpvotes) break;

    // Check if we've already voted on this comment
    const alreadyVoted = await hasVotedOn(comment.id);
    if (alreadyVoted) continue;

    // Evaluate if we should upvote
    const shouldUpvote = await shouldUpvoteComment(post, comment);
    if (!shouldUpvote) continue;

    // Give karma
    const voteResult = await vote('comment', comment.id, 1);
    if (!voteResult.success) {
      logger.warn({ error: voteResult.error, commentId: comment.id }, 'Failed to upvote');
      continue;
    }

    // Record the activity
    await recordActivity('upvote', comment.id, post.id, `Upvoted ${comment.author.name}'s comment`);
    result.upvotesGiven++;

    logger.debug(
      { postId: post.id, commentId: comment.id, author: comment.author.name },
      'Gave karma to aligned comment'
    );
  }
}

/**
 * Check for and respond to replies to Addie's comments
 */
async function checkAndRespondToReplies(result: EngagementResult): Promise<void> {
  // Get posts where Addie has commented
  const commentedPosts = await getCommentedPosts(10);

  if (commentedPosts.length === 0) {
    logger.debug('No commented posts to check for replies');
    return;
  }

  for (const { postId, commentId } of commentedPosts) {
    try {
      // Get the post with all comments
      const { post, comments } = await getPost(postId);

      // Find Addie's comment
      const addieComment = comments.find(c => c.id === commentId);
      if (!addieComment) continue;

      // Find replies to Addie's comment
      const replies = comments.filter(c =>
        c.parent_id === commentId &&
        c.author.name.toLowerCase() !== 'addie'
      );

      for (const reply of replies) {
        // Check if we've already responded to this reply
        const alreadyResponded = await hasRespondedTo(reply.id);
        if (alreadyResponded) continue;

        // Check rate limit
        const canCommentNow = await canComment();
        if (!canCommentNow.allowed) {
          logger.debug({ reason: canCommentNow.reason }, 'Rate limited, skipping replies');
          return;
        }

        // Generate a reply
        const replyText = await generateReply(post, addieComment.content, reply.author.name, reply.content);
        if (!replyText) continue;

        // Post the reply
        const replyResult = await createComment(postId, replyText, reply.id);
        if (!replyResult.success) {
          logger.error({ error: replyResult.error, postId }, 'Failed to post reply');
          result.errors++;
          continue;
        }

        // Record with marker so we know we responded to this
        await recordActivity('comment', replyResult.comment?.id, postId, `reply_to:${reply.id} ${replyText}`);

        // Notify Slack
        const permalink = post.permalink || `https://moltbook.com/p/${postId}`;
        await notifySlackEngagement('comment', post, `Replied to ${reply.author.name}:\n_"${replyText.substring(0, 100)}..."_\n<${permalink}|View on Moltbook>`);

        result.repliesCreated++;
        logger.info({ postId, replyToAuthor: reply.author.name }, 'Successfully replied on Moltbook');

        // Only one reply per run to be thoughtful
        return;
      }
    } catch (err) {
      logger.warn({ err, postId }, 'Error checking post for replies');
    }
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
    repliesCreated: 0,
    upvotesGiven: 0,
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

  // First, check for and respond to replies to our previous comments
  await checkAndRespondToReplies(result);

  // If we replied to someone, that's enough engagement for this run
  if (result.repliesCreated > 0) {
    return result;
  }

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

    // Give karma to comments that align with our worldview
    await giveKarmaToAlignedComments(post, comments, result);

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
