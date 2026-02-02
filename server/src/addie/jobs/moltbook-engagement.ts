/**
 * Moltbook Engagement Job
 *
 * Searches Moltbook for advertising-related discussions and engages
 * thoughtfully where Addie can add value.
 *
 * Runs every 4 hours, respecting Moltbook's comment rate limits.
 */

import { randomUUID } from 'crypto';
import { logger as baseLogger } from '../../logger.js';
import {
  isMoltbookEnabled,
  searchPosts,
  getFeed,
  getPost,
  createComment,
  vote,
  followAgent,
  type MoltbookPost,
  type MoltbookComment,
} from '../services/moltbook-service.js';
import {
  recordActivity,
  recordDecision,
  canComment,
  getActivityStats,
  getCommentedPosts,
  getAddieOwnPosts,
  hasRespondedTo,
  hasVotedOn,
  getTodayUpvoteCount,
  hasSharedToSlack,
  recordSlackShare,
  isFollowingAgent,
  recordFollow,
  getTodayFollowCount,
} from '../../db/moltbook-db.js';
import { sendChannelMessage } from '../../slack/client.js';
import { getChannelByName } from '../../db/notification-channels-db.js';
import { isLLMConfigured, classify, complete } from '../../utils/llm.js';

const logger = baseLogger.child({ module: 'moltbook-engagement' });

// Channel name in notification_channels table
const MOLTBOOK_CHANNEL_NAME = 'addie_moltbook';

// Search terms for finding advertising discussions
export const SEARCH_TERMS = [
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
  followsGiven: number;
  interestingThreads: number;
  skipped: number;
  errors: number;
}

// Daily limit for upvotes (be generous but not spammy)
const MAX_DAILY_UPVOTES = 20;

// Daily limit for follows (build community gradually)
const MAX_DAILY_FOLLOWS = 10;

/**
 * Check if a post is relevant to advertising topics
 * Uses Claude to evaluate - much more accurate than keyword matching
 */
async function isAdvertisingRelevant(post: MoltbookPost, jobRunId: string): Promise<boolean> {
  if (!isLLMConfigured()) return false;

  const prompt = `Is this Moltbook post relevant to ADVERTISING, AD TECH, or MARKETING?

**Title:** ${post.title}
**Content:** ${post.content || '(no content)'}

Answer YES only if the post is about:
- Advertising industry, ad tech, programmatic ads
- Marketing, media buying, ad campaigns
- Publishers, brands, agencies in advertising context
- Ad targeting, measurement, attribution
- AI/agents specifically applied to advertising

Answer NO if the post is about:
- General AI/agent topics not related to ads
- Crypto, tokens, memecoins
- General tech news unrelated to advertising
- Personal updates, manifestos, general chatter

Respond with only YES or NO.`;

  try {
    const result = await classify({
      prompt,
      operationName: 'moltbook-relevance',
    });

    // Record the decision
    await recordDecision({
      moltbookPostId: post.id,
      postTitle: post.title,
      postAuthor: post.author?.name,
      decisionType: 'relevance',
      outcome: result.result ? 'engaged' : 'skipped',
      reason: result.result
        ? 'Post is relevant to advertising/ad tech/marketing topics'
        : 'Post not related to advertising topics',
      decisionMethod: 'llm',
      model: result.model,
      tokensInput: result.inputTokens,
      tokensOutput: result.outputTokens,
      latencyMs: result.latencyMs,
      jobRunId,
    });

    return result.result;
  } catch (err) {
    logger.debug({ err, postId: post.id }, 'Failed to evaluate post relevance');

    // Record error case
    await recordDecision({
      moltbookPostId: post.id,
      postTitle: post.title,
      postAuthor: post.author?.name,
      decisionType: 'relevance',
      outcome: 'skipped',
      reason: `Error evaluating relevance: ${err instanceof Error ? err.message : 'Unknown error'}`,
      decisionMethod: 'llm',
      latencyMs: 0,
      jobRunId,
    });

    return false;
  }
}

/**
 * Generate a thoughtful comment using Claude
 */
async function generateComment(
  post: MoltbookPost,
  comments: MoltbookComment[],
  jobRunId: string
): Promise<string | null> {
  if (!isLLMConfigured()) {
    logger.error('ANTHROPIC_API_KEY not configured');
    return null;
  }

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
    const result = await complete({
      prompt,
      maxTokens: 300,
      model: 'primary',
      operationName: 'moltbook-comment',
    });

    const comment = result.text;
    const isSkip = comment === 'SKIP' || comment.toLowerCase().includes('skip');

    // Record the decision
    await recordDecision({
      moltbookPostId: post.id,
      postTitle: post.title,
      postAuthor: post.author?.name,
      decisionType: 'comment',
      outcome: isSkip ? 'skipped' : 'engaged',
      reason: isSkip
        ? 'Discussion not relevant enough to comment on'
        : 'Generated comment for advertising discussion',
      decisionMethod: 'llm',
      generatedContent: isSkip ? undefined : comment,
      contentPosted: false, // Will be updated after posting
      model: result.model,
      tokensInput: result.inputTokens,
      tokensOutput: result.outputTokens,
      latencyMs: result.latencyMs,
      jobRunId,
    });

    if (isSkip) {
      return null;
    }

    return comment;
  } catch (err) {
    logger.error({ err }, 'Failed to generate comment');

    // Record error case
    await recordDecision({
      moltbookPostId: post.id,
      postTitle: post.title,
      decisionType: 'comment',
      outcome: 'skipped',
      reason: `Error generating comment: ${err instanceof Error ? err.message : 'Unknown error'}`,
      decisionMethod: 'llm',
      latencyMs: 0,
      jobRunId,
    });

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
  if (!isLLMConfigured()) return null;

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
    const result = await complete({
      prompt,
      maxTokens: 200,
      model: 'primary',
      operationName: 'moltbook-reply',
    });

    const reply = result.text;
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
  comment: MoltbookComment,
  jobRunId: string
): Promise<boolean> {
  if (!isLLMConfigured()) return false;

  // Don't upvote our own comments
  if (comment.author.name.toLowerCase() === 'addie') return false;

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
    const result = await classify({
      prompt,
      operationName: 'moltbook-upvote',
    });

    // Record the decision
    await recordDecision({
      moltbookPostId: post.id,
      postTitle: post.title,
      postAuthor: comment.author.name,
      decisionType: 'upvote',
      outcome: result.result ? 'engaged' : 'skipped',
      reason: result.result
        ? `Comment by ${comment.author.name} aligns with agentic advertising worldview`
        : `Comment by ${comment.author.name} does not align with worldview or is low-effort`,
      decisionMethod: 'llm',
      generatedContent: comment.content.substring(0, 200),
      model: result.model,
      tokensInput: result.inputTokens,
      tokensOutput: result.outputTokens,
      latencyMs: result.latencyMs,
      jobRunId,
    });

    return result.result;
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
  result: EngagementResult,
  jobRunId: string
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
    const shouldUpvote = await shouldUpvoteComment(post, comment, jobRunId);
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
 * Evaluate if we should follow a poster based on their content
 * Uses Claude to determine if they're aligned with agentic advertising
 */
async function shouldFollowPoster(
  post: MoltbookPost,
  jobRunId: string
): Promise<boolean> {
  if (!isLLMConfigured()) return false;

  // Don't follow ourselves
  if (post.author.name.toLowerCase() === 'addie') return false;

  const prompt = `You are Addie, deciding whether to follow an agent on Moltbook.

**Your interests:**
- Agentic advertising and AI agents doing advertising tasks
- Ad tech, programmatic advertising, media buying
- AI agents, MCP, A2A, agent protocols
- Marketing technology and automation

**Post by ${post.author.name}:**
Title: ${post.title}
Content: ${post.content || '(no content)'}

Should you follow ${post.author.name}? Answer YES if:
- They post about advertising, ad tech, or marketing
- They post about AI agents, agent protocols, or automation
- They seem interested in the intersection of AI and advertising
- They're part of the agentic advertising community

Answer NO if:
- The post is off-topic (crypto, memes, general chatter)
- The post is low-effort or spam
- You can't determine their interests from this post

Respond with only YES or NO.`;

  try {
    const result = await classify({
      prompt,
      operationName: 'moltbook-follow',
    });

    // Record the decision
    await recordDecision({
      moltbookPostId: post.id,
      postTitle: post.title,
      postAuthor: post.author.name,
      decisionType: 'follow',
      outcome: result.result ? 'engaged' : 'skipped',
      reason: result.result
        ? `${post.author.name} posts about relevant topics`
        : `${post.author.name}'s interests don't align`,
      decisionMethod: 'llm',
      model: result.model,
      tokensInput: result.inputTokens,
      tokensOutput: result.outputTokens,
      latencyMs: result.latencyMs,
      jobRunId,
    });

    return result.result;
  } catch (err) {
    logger.debug({ err, postId: post.id }, 'Failed to evaluate poster for follow');
    return false;
  }
}

/**
 * Follow relevant posters discovered during engagement
 */
async function followRelevantPosters(
  posts: MoltbookPost[],
  result: EngagementResult,
  jobRunId: string
): Promise<void> {
  // Check daily limit
  let todayFollows;
  try {
    todayFollows = await getTodayFollowCount();
  } catch (err) {
    logger.warn({ err }, 'Failed to get follow count');
    return;
  }

  if (todayFollows >= MAX_DAILY_FOLLOWS) {
    logger.debug({ todayFollows }, 'Daily follow limit reached');
    return;
  }

  const remainingFollows = MAX_DAILY_FOLLOWS - todayFollows;
  const authorsToEvaluate = new Map<string, MoltbookPost>();

  // Dedupe by author (only evaluate each author once)
  for (const post of posts) {
    if (!authorsToEvaluate.has(post.author.id)) {
      authorsToEvaluate.set(post.author.id, post);
    }
  }

  for (const [authorId, post] of authorsToEvaluate) {
    if (result.followsGiven >= remainingFollows) break;

    // Check if we're already following
    const alreadyFollowing = await isFollowingAgent(authorId);
    if (alreadyFollowing) continue;

    // Evaluate if we should follow
    const shouldFollow = await shouldFollowPoster(post, jobRunId);
    if (!shouldFollow) continue;

    // Follow the agent
    const followResult = await followAgent(authorId);
    if (!followResult.success) {
      logger.debug({ error: followResult.error, agentId: authorId }, 'Failed to follow agent');
      continue;
    }

    // Record the activity
    await recordFollow(authorId, post.author.name);
    result.followsGiven++;

    logger.info(
      { agentId: authorId, agentName: post.author.name },
      'Followed relevant poster on Moltbook'
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
 * Check for and respond to comments on Addie's own posts
 * This handles the case where Addie creates a post and others comment on it
 */
async function checkAndRespondToOwnPostComments(result: EngagementResult): Promise<void> {
  // Get posts that Addie authored
  let ownPosts;
  try {
    ownPosts = await getAddieOwnPosts(10);
  } catch (err) {
    logger.warn({ err }, 'Failed to fetch own posts');
    return;
  }

  if (ownPosts.length === 0) {
    logger.debug('No own posts to check for comments');
    return;
  }

  for (const { postId, title } of ownPosts) {
    try {
      // Get the post with all comments
      const { post, comments } = await getPost(postId);

      // Find top-level comments (not from Addie, not already responded to)
      const topLevelComments = comments.filter(c =>
        !c.parent_id && // Top-level comment
        c.author.name.toLowerCase() !== 'addie'
      );

      for (const comment of topLevelComments) {
        // Check if we've already responded to this comment
        const alreadyResponded = await hasRespondedTo(comment.id);
        if (alreadyResponded) continue;

        // Check rate limit
        const canCommentNow = await canComment();
        if (!canCommentNow.allowed) {
          logger.debug({ reason: canCommentNow.reason }, 'Rate limited, skipping own post replies');
          return;
        }

        // Generate a reply
        const replyText = await generateReply(
          post,
          `[Original post by Addie: ${title}]`,
          comment.author.name,
          comment.content
        );
        if (!replyText) continue;

        // Post the reply (as a nested reply to their comment)
        const replyResult = await createComment(postId, replyText, comment.id);
        if (!replyResult.success) {
          logger.error({ error: replyResult.error, postId }, 'Failed to reply to comment on own post');
          result.errors++;
          continue;
        }

        // Record with marker so we know we responded to this
        await recordActivity('comment', replyResult.comment?.id, postId, `reply_to:${comment.id} ${replyText}`);

        // Notify Slack
        const permalink = post.permalink || `https://moltbook.com/p/${postId}`;
        await notifySlackEngagement('comment', post, `Replied to ${comment.author.name} on my post:\n_"${replyText.substring(0, 100)}..."_\n<${permalink}|View on Moltbook>`);

        result.repliesCreated++;
        logger.info({ postId, replyToAuthor: comment.author.name }, 'Successfully replied to comment on own post');

        // Only one reply per run to be thoughtful
        return;
      }
    } catch (err) {
      logger.warn({ err, postId }, 'Error checking own post for comments');
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
  let searchPostCount = 0;
  let feedPostCount = 0;

  // Try search first (may be broken)
  const searchTermsToTry = SEARCH_TERMS
    .sort(() => Math.random() - 0.5)
    .slice(0, 2);

  logger.debug({ searchTerms: searchTermsToTry }, 'Searching Moltbook with terms');

  for (const term of searchTermsToTry) {
    try {
      const searchResult = await searchPosts(term, 5);
      const resultCount = searchResult.posts.length;
      const titles = searchResult.posts.map(p => p.title).slice(0, 3);
      logger.debug({ term, resultCount, titles }, 'Search results for term');

      for (const post of searchResult.posts) {
        if (!seenIds.has(post.id)) {
          seenIds.add(post.id);
          posts.push(post);
          searchPostCount++;
        }
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      logger.warn({ term, error: errorMessage }, 'Search failed, will use feed');
    }
  }

  logger.debug({ searchPostCount, limit }, 'Posts from search');

  // If search didn't work or returned few results, browse the feed
  if (posts.length < limit) {
    try {
      const feedResult = await getFeed('hot', undefined, 25);
      const feedTitles = feedResult.posts.map(p => p.title).slice(0, 5);
      logger.debug({ feedPostCount: feedResult.posts.length, feedTitles }, 'Feed results');

      for (const post of feedResult.posts) {
        if (!seenIds.has(post.id) && posts.length < limit * 3) {
          seenIds.add(post.id);
          posts.push(post);
          feedPostCount++;
        }
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      logger.warn({ error: errorMessage }, 'Failed to fetch feed');
    }
  }

  logger.debug({ searchPostCount, feedPostCount, totalPosts: posts.length }, 'Discovery complete');

  return posts;
}

// Max comments per job run (was 1, now more aggressive)
const MAX_COMMENTS_PER_RUN = 3;

/**
 * Run the Moltbook engagement job
 */
export async function runMoltbookEngagementJob(options: {
  limit?: number;
  maxComments?: number;
} = {}): Promise<EngagementResult> {
  const limit = options.limit ?? 5; // Search more posts to find commentable ones
  const maxComments = options.maxComments ?? MAX_COMMENTS_PER_RUN;
  const jobRunId = randomUUID();
  const result: EngagementResult = {
    postsSearched: 0,
    commentsCreated: 0,
    repliesCreated: 0,
    upvotesGiven: 0,
    followsGiven: 0,
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
  logger.info({ ...stats, jobRunId, maxComments }, 'Starting Moltbook engagement job');

  // First, check for and respond to comments on our own posts
  await checkAndRespondToOwnPostComments(result);

  // If we replied to someone, that's enough engagement for this run
  if (result.repliesCreated > 0) {
    return result;
  }

  // Then check for replies to our comments on other posts
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
    const relevant = await isAdvertisingRelevant(post, jobRunId);
    if (!relevant) continue;

    // Get the full thread
    let comments: MoltbookComment[] = [];
    try {
      const threadData = await getPost(post.id);
      comments = threadData.comments;
    } catch {
      continue;
    }

    // Give karma to comments that align with our worldview
    await giveKarmaToAlignedComments(post, comments, result, jobRunId);

    // Check if Addie has already commented
    const addieCommented = comments.some(
      c => c.author.name.toLowerCase() === 'addie'
    );
    if (addieCommented) continue;

    result.interestingThreads++;

    // Track for sharing if we haven't already shared this post
    if (interestingToShare.length < MAX_INTERESTING_NOTIFICATIONS) {
      const alreadyShared = await hasSharedToSlack(post.id);
      if (!alreadyShared) {
        interestingToShare.push(post);
      }
    }

    // Try to comment if allowed and haven't hit max for this run
    if (canCommentNow && result.commentsCreated < maxComments) {
      const commentText = await generateComment(post, comments, jobRunId);
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
        { postId: post.id, commentId: commentResult.comment?.id, jobRunId },
        'Successfully commented on Moltbook post'
      );
    }
  }

  // Share interesting threads we found (even if we didn't comment)
  for (const post of interestingToShare) {
    const permalink = post.permalink || `https://moltbook.com/p/${post.id}`;
    const preview = post.content ? `_"${post.content.substring(0, 100)}..."_\n` : '';
    await notifySlackEngagement('interesting', post, `${preview}<${permalink}|View on Moltbook>`);
    // Record that we shared this so we don't share it again
    await recordSlackShare(post.id, post.title);
  }

  if (interestingToShare.length > 0) {
    logger.info({ count: interestingToShare.length, jobRunId }, 'Shared interesting threads to Slack');
  }

  // Follow relevant posters we discovered
  await followRelevantPosters(posts, result, jobRunId);

  if (result.followsGiven > 0) {
    logger.info({ followsGiven: result.followsGiven, jobRunId }, 'Followed relevant posters');
  }

  return result;
}
