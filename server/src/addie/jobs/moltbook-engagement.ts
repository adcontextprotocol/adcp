/**
 * Moltbook Engagement Job
 *
 * Searches Moltbook for advertising-related discussions and engages
 * thoughtfully where Addie can add value. Also checks and responds
 * to DMs (which may include platform verification challenges).
 *
 * Runs every 4 hours, respecting Moltbook's comment rate limits.
 */

import { randomUUID } from 'crypto';
import { logger as baseLogger } from '../../logger.js';
import {
  isMoltbookEnabled,
  isAccountSuspended,
  searchPosts,
  getFeed,
  getPost,
  createComment,
  checkDMs,
  getDMRequests,
  approveDMRequest,
  getDMConversations,
  getDMConversation,
  sendDM,
  MoltbookApiError,
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
  hasSharedToSlack,
  recordSlackShare,
  removeStaleActivityForPost,
  markOwnPostStale,
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
  dmsHandled: number;
  interestingThreads: number;
  skipped: number;
  errors: number;
}

// Max comments per job run
const MAX_COMMENTS_PER_RUN = 1;

// ============== DM Handling ==============

/**
 * Check for and respond to DMs.
 * Runs even when the account is suspended for posting, since DMs may
 * contain platform verification challenges or the path to un-suspension.
 */
async function checkAndRespondToDMs(result: EngagementResult): Promise<void> {
  let dmStatus;
  try {
    dmStatus = await checkDMs();
  } catch (err) {
    logger.debug({ err }, 'Failed to check DMs');
    return;
  }

  if (dmStatus.pending_requests === 0 && dmStatus.unread_messages === 0) {
    return;
  }

  logger.info(
    { pendingRequests: dmStatus.pending_requests, unreadMessages: dmStatus.unread_messages },
    'Moltbook DMs to handle'
  );

  // Handle pending DM requests - auto-approve all (Addie is a public-facing bot)
  if (dmStatus.pending_requests > 0) {
    try {
      const requests = await getDMRequests();
      for (const req of requests) {
        try {
          await approveDMRequest(req.id);
          logger.info({ from: req.from.name, requestId: req.id }, 'Approved Moltbook DM request');

          await notifySlackEngagement(
            'dm',
            undefined,
            `Approved DM request from *${req.from.name}*: _"${req.message.substring(0, 100)}"_`
          );
        } catch (err) {
          logger.warn({ err, requestId: req.id }, 'Failed to approve DM request');
        }
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to fetch DM requests');
    }
  }

  // Handle unread messages
  if (dmStatus.unread_messages > 0) {
    try {
      const conversations = await getDMConversations();
      const unreadConversations = conversations.filter(c => c.unread_count > 0);

      for (const convo of unreadConversations) {
        try {
          const messages = await getDMConversation(convo.id);

          // Get the latest unread message from the other agent
          const latestFromOther = messages
            .filter(m => m.from.name.toLowerCase() !== 'addie')
            .at(-1);

          if (!latestFromOther) continue;

          // Check if this looks like a verification challenge
          const isVerification = /verif|challenge|prove|captcha|confirm you are/i.test(
            latestFromOther.message
          );

          // Generate a reply
          const replyText = await generateDMReply(
            convo.agent.name,
            latestFromOther.message,
            isVerification
          );

          let replySent = false;
          if (replyText) {
            const sendResult = await sendDM(convo.id, replyText);
            if (sendResult.success) {
              await recordActivity('dm', convo.id, undefined, `DM to ${convo.agent.name}: ${replyText}`);
              result.dmsHandled++;
              replySent = true;
              logger.info({ agentName: convo.agent.name, isVerification }, 'Replied to Moltbook DM');
            }
          }

          // Notify Slack - higher urgency for verification challenges
          const urgency = isVerification ? ':rotating_light: *VERIFICATION CHALLENGE*' : 'DM';
          await notifySlackEngagement(
            'dm',
            undefined,
            `${urgency} from *${convo.agent.name}*:\n_"${latestFromOther.message.substring(0, 200)}"_${replySent ? `\n\nReplied: _"${replyText!.substring(0, 200)}"_` : ''}`
          );
        } catch (err) {
          logger.warn({ err, conversationId: convo.id }, 'Failed to handle DM conversation');
        }
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to fetch DM conversations');
    }
  }
}

/**
 * Generate a reply to a DM
 */
async function generateDMReply(
  agentName: string,
  message: string,
  isVerification: boolean
): Promise<string | null> {
  if (!isLLMConfigured()) return null;

  const verificationContext = isVerification
    ? `\n\nIMPORTANT: This appears to be a verification challenge from the Moltbook platform. Answer it directly and accurately. If asked to prove you're an AI agent, confirm that you are Addie, the AI assistant for AgenticAdvertising.org.`
    : '';

  const prompt = `You are Addie, the AI assistant for AgenticAdvertising.org, replying to a direct message on Moltbook.

**Message from ${agentName}:** ${message}${verificationContext}

Write a helpful, friendly reply. Be concise (1-3 sentences). If this is a verification challenge, answer it directly.

Your reply:`;

  try {
    const result = await complete({
      prompt,
      maxTokens: 200,
      model: 'fast',
      operationName: 'moltbook-dm-reply',
    });

    return result.text;
  } catch (err) {
    logger.error({ err }, 'Failed to generate DM reply');
    return null;
  }
}

// ============== Post Relevance & Commenting ==============

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

// ============== Reply Checking ==============

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
        const permalink = post.permalink || `https://www.moltbook.com/p/${postId}`;
        await notifySlackEngagement('comment', post, `Replied to ${reply.author.name}:\n_"${replyText.substring(0, 100)}..."_\n<${permalink}|View on Moltbook>`);

        result.repliesCreated++;
        logger.info({ postId, replyToAuthor: reply.author.name }, 'Successfully replied on Moltbook');

        // Only one reply per run to be thoughtful
        return;
      }
    } catch (err) {
      if (err instanceof MoltbookApiError && err.isNotFound) {
        logger.info({ postId }, 'Post no longer exists on Moltbook, removing stale activity');
        await removeStaleActivityForPost(postId);
      } else {
        logger.warn({ err, postId }, 'Error checking post for replies');
      }
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
        const permalink = post.permalink || `https://www.moltbook.com/p/${postId}`;
        await notifySlackEngagement('comment', post, `Replied to ${comment.author.name} on my post:\n_"${replyText.substring(0, 100)}..."_\n<${permalink}|View on Moltbook>`);

        result.repliesCreated++;
        logger.info({ postId, replyToAuthor: comment.author.name }, 'Successfully replied to comment on own post');

        // Only one reply per run to be thoughtful
        return;
      }
    } catch (err) {
      if (err instanceof MoltbookApiError && err.isNotFound) {
        logger.info({ postId }, 'Own post no longer exists on Moltbook, marking stale');
        await markOwnPostStale(postId);
      } else {
        logger.warn({ err, postId }, 'Error checking own post for comments');
      }
    }
  }
}

// ============== Notifications ==============

/**
 * Notify Slack about engagement activity
 */
async function notifySlackEngagement(
  activityType: 'comment' | 'interesting' | 'dm',
  post: MoltbookPost | undefined,
  details?: string
): Promise<void> {
  // Look up the Moltbook channel from the database
  const channel = await getChannelByName(MOLTBOOK_CHANNEL_NAME);
  if (!channel || !channel.is_active) return;

  let message: string;
  if (activityType === 'dm') {
    message = details || 'Moltbook DM activity';
  } else if (activityType === 'comment') {
    message = `Joined a Moltbook discussion: *${post?.title}*\n${details || ''}`;
  } else {
    message = `Found an interesting advertising thread on Moltbook: *${post?.title}*\n${details || ''}`;
  }

  try {
    await sendChannelMessage(channel.slack_channel_id, { text: message });
  } catch (err) {
    logger.warn({ err, channelId: channel.slack_channel_id }, 'Failed to notify Slack about Moltbook engagement');
  }
}

// ============== Post Discovery ==============

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
      if (!searchResult?.posts || !Array.isArray(searchResult.posts)) {
        logger.debug({ term }, 'Search returned invalid result structure');
        continue;
      }
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

// ============== Main Job ==============

/**
 * Run the Moltbook engagement job
 */
export async function runMoltbookEngagementJob(options: {
  limit?: number;
  maxComments?: number;
} = {}): Promise<EngagementResult> {
  const limit = options.limit ?? 5;
  const maxComments = options.maxComments ?? MAX_COMMENTS_PER_RUN;
  const jobRunId = randomUUID();
  const result: EngagementResult = {
    postsSearched: 0,
    commentsCreated: 0,
    repliesCreated: 0,
    dmsHandled: 0,
    interestingThreads: 0,
    skipped: 0,
    errors: 0,
  };

  // Check if Moltbook is enabled
  if (!isMoltbookEnabled()) {
    logger.debug('Moltbook is not enabled or configured');
    return result;
  }

  // Check DMs BEFORE the suspension check - DMs may still work even when
  // posting is suspended, and may contain verification challenges needed
  // to lift the suspension.
  await checkAndRespondToDMs(result);

  // Check if account is suspended (avoids repeated failed API calls for posting)
  if (isAccountSuspended()) {
    logger.debug('Moltbook account is suspended, skipping engagement (DMs already checked)');
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
      const permalink = post.permalink || `https://www.moltbook.com/p/${post.id}`;
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
    const permalink = post.permalink || `https://www.moltbook.com/p/${post.id}`;
    const preview = post.content ? `_"${post.content.substring(0, 100)}..."_\n` : '';
    await notifySlackEngagement('interesting', post, `${preview}<${permalink}|View on Moltbook>`);
    // Record that we shared this so we don't share it again
    await recordSlackShare(post.id, post.title);
  }

  if (interestingToShare.length > 0) {
    logger.info({ count: interestingToShare.length, jobRunId }, 'Shared interesting threads to Slack');
  }

  return result;
}
