/**
 * Moltbook MCP Tools
 *
 * Tools for Addie to interact with Moltbook, the social network for AI agents.
 * These tools allow humans to ask Addie to search, post, or engage on Moltbook.
 */

import { logger } from '../../logger.js';
import type { AddieTool } from '../types.js';
import {
  isMoltbookEnabled,
  searchPosts,
  getPost,
  createPost,
  createComment,
  getAgentStatus,
  getFeed,
  type MoltbookPost,
  type MoltbookAgentStatus,
} from '../services/moltbook-service.js';
import {
  canPost,
  canComment,
  recordActivity,
  getActivityStats,
} from '../../db/moltbook-db.js';

/**
 * Tool definitions for Moltbook interaction
 */
export const MOLTBOOK_TOOLS: AddieTool[] = [
  {
    name: 'search_moltbook',
    description: 'Search Moltbook for posts about a topic. Moltbook is a social network for AI agents. Returns posts matching the search query with author, score, and comment count.',
    usage_hints: 'Use when asked about what AI agents are discussing, Moltbook discussions, or to find agent conversations on a topic.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query (e.g., "programmatic advertising", "AI agents")',
        },
        limit: {
          type: 'number',
          description: 'Number of results to return (default 5, max 20)',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_moltbook_thread',
    description: 'Get a Moltbook post and its comments. Returns the full post content and discussion thread.',
    usage_hints: 'Use when asked to read a specific Moltbook thread or see the discussion on a post.',
    input_schema: {
      type: 'object',
      properties: {
        post_id: {
          type: 'string',
          description: 'The Moltbook post ID',
        },
      },
      required: ['post_id'],
    },
  },
  {
    name: 'post_to_moltbook',
    description: 'Create a new post on Moltbook. Rate limited to 1 post per 30 minutes. Use for sharing insights, asking questions, or starting discussions with other AI agents.',
    usage_hints: 'Use when asked to post something to Moltbook or share content with the AI agent community.',
    input_schema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Post title (concise, engaging)',
        },
        content: {
          type: 'string',
          description: 'Post content (optional for link posts)',
        },
        url: {
          type: 'string',
          description: 'External URL for link posts (optional)',
        },
      },
      required: ['title'],
    },
  },
  {
    name: 'comment_on_moltbook',
    description: 'Add a comment to a Moltbook post. Rate limited to 1 comment per 20 seconds and 50 comments per day. Use for engaging in discussions with other AI agents.',
    usage_hints: 'Use when asked to reply to or comment on a Moltbook post.',
    input_schema: {
      type: 'object',
      properties: {
        post_id: {
          type: 'string',
          description: 'The post ID to comment on',
        },
        content: {
          type: 'string',
          description: 'Comment content',
        },
        parent_id: {
          type: 'string',
          description: 'Parent comment ID for nested replies (optional)',
        },
      },
      required: ['post_id', 'content'],
    },
  },
  {
    name: 'get_moltbook_stats',
    description: "Get Addie's Moltbook profile stats including karma, post count, follower count, and today's activity.",
    usage_hints: "Use when asked about Addie's Moltbook presence, karma, or activity stats.",
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'get_moltbook_feed',
    description: 'Get the latest posts from Moltbook sorted by hot, new, top, or rising.',
    usage_hints: "Use when asked what's trending on Moltbook or to see recent AI agent discussions.",
    input_schema: {
      type: 'object',
      properties: {
        sort: {
          type: 'string',
          enum: ['hot', 'new', 'top', 'rising'],
          description: 'How to sort posts (default: hot)',
        },
        limit: {
          type: 'number',
          description: 'Number of posts to return (default 10, max 25)',
        },
      },
    },
  },
];

/**
 * Format a post for display
 */
function formatPost(post: MoltbookPost): string {
  const lines = [
    `**${post.title}**`,
    `by ${post.author.name} | Score: ${post.score} | Comments: ${post.comment_count}`,
  ];

  if (post.content) {
    lines.push('', post.content.substring(0, 500) + (post.content.length > 500 ? '...' : ''));
  }

  if (post.permalink) {
    lines.push('', `View: ${post.permalink}`);
  }

  return lines.join('\n');
}

/**
 * Create tool handlers for Moltbook
 */
export function createMoltbookToolHandlers(): Record<string, (input: Record<string, unknown>) => Promise<string>> {
  return {
    search_moltbook: async (input) => {
      const query = input.query as string;
      const limit = Math.min((input.limit as number) || 5, 20);

      if (!isMoltbookEnabled()) {
        return 'Moltbook integration is not configured. Please set MOLTBOOK_API_KEY.';
      }

      try {
        const result = await searchPosts(query, limit);

        if (result.posts.length === 0) {
          return `No posts found for "${query}"`;
        }

        const formatted = result.posts.map((post, i) => `${i + 1}. ${formatPost(post)}`);
        return `Found ${result.posts.length} posts for "${query}":\n\n${formatted.join('\n\n---\n\n')}`;
      } catch (err) {
        logger.error({ err, query }, 'Failed to search Moltbook');
        return `Error searching Moltbook: ${err instanceof Error ? err.message : 'Unknown error'}`;
      }
    },

    get_moltbook_thread: async (input) => {
      const postId = input.post_id as string;

      if (!isMoltbookEnabled()) {
        return 'Moltbook integration is not configured.';
      }

      try {
        const { post, comments } = await getPost(postId);

        const lines = [formatPost(post), '', `--- ${comments.length} Comments ---`];

        for (const comment of comments.slice(0, 10)) {
          lines.push('', `**${comment.author.name}** (Score: ${comment.score})`);
          lines.push(comment.content);
        }

        if (comments.length > 10) {
          lines.push('', `... and ${comments.length - 10} more comments`);
        }

        return lines.join('\n');
      } catch (err) {
        logger.error({ err, postId }, 'Failed to get Moltbook thread');
        return `Error getting thread: ${err instanceof Error ? err.message : 'Unknown error'}`;
      }
    },

    post_to_moltbook: async (input) => {
      const title = input.title as string;
      const content = input.content as string | undefined;
      const url = input.url as string | undefined;

      if (!isMoltbookEnabled()) {
        return 'Moltbook integration is not configured.';
      }

      // Check rate limit
      const allowed = await canPost();
      if (!allowed) {
        return 'Rate limited - must wait 30 minutes between posts.';
      }

      try {
        const result = await createPost(title, content, undefined, url);

        if (!result.success) {
          return `Failed to post: ${result.error}`;
        }

        // Record activity
        await recordActivity('post', result.post?.id, undefined, title);

        return `Successfully posted to Moltbook!\n\nTitle: ${title}\n${result.post?.permalink ? `View: ${result.post.permalink}` : ''}`;
      } catch (err) {
        logger.error({ err, title }, 'Failed to post to Moltbook');
        return `Error posting: ${err instanceof Error ? err.message : 'Unknown error'}`;
      }
    },

    comment_on_moltbook: async (input) => {
      const postId = input.post_id as string;
      const content = input.content as string;
      const parentId = input.parent_id as string | undefined;

      if (!isMoltbookEnabled()) {
        return 'Moltbook integration is not configured.';
      }

      // Check rate limit
      const rateCheck = await canComment();
      if (!rateCheck.allowed) {
        return `Rate limited: ${rateCheck.reason}`;
      }

      try {
        const result = await createComment(postId, content, parentId);

        if (!result.success) {
          return `Failed to comment: ${result.error}`;
        }

        // Record activity
        await recordActivity('comment', result.comment?.id, postId, content);

        return `Successfully commented on post ${postId}`;
      } catch (err) {
        logger.error({ err, postId }, 'Failed to comment on Moltbook');
        return `Error commenting: ${err instanceof Error ? err.message : 'Unknown error'}`;
      }
    },

    get_moltbook_stats: async () => {
      if (!isMoltbookEnabled()) {
        return 'Moltbook integration is not configured.';
      }

      try {
        const [agentStatus, localStats] = await Promise.all([
          getAgentStatus(),
          getActivityStats(),
        ]);

        const lines = ["**Addie's Moltbook Stats**", ''];

        if (agentStatus) {
          lines.push(`Karma: ${agentStatus.karma ?? 'N/A'}`);
          lines.push(`Total Posts: ${agentStatus.post_count ?? 0}`);
          lines.push(`Total Comments: ${agentStatus.comment_count ?? 0}`);
          lines.push(`Followers: ${agentStatus.follower_count ?? 0}`);
          lines.push(`Following: ${agentStatus.following_count ?? 0}`);
          lines.push(`Claimed: ${agentStatus.claimed ? 'Yes' : 'No'}`);
        }

        lines.push('', "**Today's Activity**");
        lines.push(`Posts today: ${localStats.postsToday}`);
        lines.push(`Comments today: ${localStats.commentsToday} / 50`);

        return lines.join('\n');
      } catch (err) {
        logger.error({ err }, 'Failed to get Moltbook stats');
        return `Error getting stats: ${err instanceof Error ? err.message : 'Unknown error'}`;
      }
    },

    get_moltbook_feed: async (input) => {
      const sort = (input.sort as 'hot' | 'new' | 'top' | 'rising') || 'hot';
      const limit = Math.min((input.limit as number) || 10, 25);

      if (!isMoltbookEnabled()) {
        return 'Moltbook integration is not configured.';
      }

      try {
        const result = await getFeed(sort, undefined, limit);

        if (result.posts.length === 0) {
          return 'No posts found in feed';
        }

        const formatted = result.posts.map((post, i) => `${i + 1}. ${formatPost(post)}`);
        return `**Moltbook ${sort.charAt(0).toUpperCase() + sort.slice(1)} Feed**\n\n${formatted.join('\n\n---\n\n')}`;
      } catch (err) {
        logger.error({ err, sort }, 'Failed to get Moltbook feed');
        return `Error getting feed: ${err instanceof Error ? err.message : 'Unknown error'}`;
      }
    },
  };
}
