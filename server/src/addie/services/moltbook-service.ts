/**
 * Moltbook Service
 *
 * API client for Moltbook, the social network for AI agents.
 * Handles posting, commenting, searching, and fetching content.
 *
 * Rate limits:
 * - 100 requests/minute
 * - 1 post per 30 minutes
 * - 1 comment per 20 seconds, 50 comments/day
 */

import { logger as baseLogger } from '../../logger.js';

const logger = baseLogger.child({ module: 'moltbook-service' });

const MOLTBOOK_API_KEY = process.env.MOLTBOOK_API_KEY;
const MOLTBOOK_BASE_URL = 'https://www.moltbook.com/api/v1';
const MOLTBOOK_ENABLED = process.env.MOLTBOOK_ENABLED !== 'false';

// ============== Types ==============

export interface MoltbookPost {
  id: string;
  title: string;
  content?: string;
  url?: string;
  author: {
    id: string;
    name: string;
  };
  submolt?: string;
  score: number;
  comment_count: number;
  created_at: string;
  permalink?: string;
}

export interface MoltbookComment {
  id: string;
  content: string;
  author: {
    id: string;
    name: string;
  };
  parent_id?: string;
  post_id: string;
  score: number;
  created_at: string;
  replies?: MoltbookComment[];
}

export interface MoltbookSearchResult {
  posts: MoltbookPost[];
  similarity_scores?: number[];
}

export interface MoltbookAgentStatus {
  id: string;
  name: string;
  karma: number;
  post_count: number;
  comment_count: number;
  follower_count: number;
  following_count: number;
  claimed: boolean;
  created_at: string;
}

export interface MoltbookFeedResponse {
  posts: MoltbookPost[];
  next_cursor?: string;
}

export interface CreatePostResult {
  success: boolean;
  post?: MoltbookPost;
  error?: string;
}

export interface CreateCommentResult {
  success: boolean;
  comment?: MoltbookComment;
  error?: string;
}

// ============== API Client ==============

/**
 * Check if Moltbook integration is configured and enabled
 */
export function isMoltbookEnabled(): boolean {
  return MOLTBOOK_ENABLED && !!MOLTBOOK_API_KEY;
}

/**
 * Make an authenticated request to the Moltbook API
 */
async function moltbookRequest<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  if (!MOLTBOOK_API_KEY) {
    throw new Error('MOLTBOOK_API_KEY not configured');
  }

  const url = `${MOLTBOOK_BASE_URL}${endpoint}`;

  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${MOLTBOOK_API_KEY}`,
      ...options.headers,
    },
    signal: AbortSignal.timeout(30000),
  });

  if (!response.ok) {
    const errorText = await response.text();
    // Truncate error text to avoid leaking sensitive info in logs
    const sanitizedError = errorText.substring(0, 200);
    logger.error({ status: response.status, endpoint }, 'Moltbook API error');
    throw new Error(`Moltbook API error: ${response.status} - ${sanitizedError}`);
  }

  try {
    return await response.json() as T;
  } catch {
    throw new Error('Invalid JSON response from Moltbook API');
  }
}

// ============== Feed & Discovery ==============

/**
 * Get posts from a feed
 * @param sort - 'hot', 'new', 'top', or 'rising'
 * @param submolt - Optional submolt name to filter by
 * @param limit - Number of posts to fetch (default 25)
 */
export async function getFeed(
  sort: 'hot' | 'new' | 'top' | 'rising' = 'hot',
  submolt?: string,
  limit = 25
): Promise<MoltbookFeedResponse> {
  const params = new URLSearchParams({ sort, limit: String(limit) });
  if (submolt) {
    params.set('submolt', submolt);
  }

  return moltbookRequest<MoltbookFeedResponse>(`/posts?${params}`);
}

/**
 * Semantic search for posts
 * @param query - Search query
 * @param limit - Number of results (default 10)
 */
export async function searchPosts(query: string, limit = 10): Promise<MoltbookSearchResult> {
  const params = new URLSearchParams({ q: query, limit: String(limit) });
  return moltbookRequest<MoltbookSearchResult>(`/search?${params}`);
}

/**
 * Get a single post with its comments
 */
export async function getPost(postId: string): Promise<{ post: MoltbookPost; comments: MoltbookComment[] }> {
  return moltbookRequest<{ post: MoltbookPost; comments: MoltbookComment[] }>(`/posts/${postId}`);
}

// ============== Posting & Engagement ==============

/**
 * Create a new post
 * @param title - Post title
 * @param content - Post content (optional for link posts)
 * @param submolt - Which submolt to post to (optional)
 * @param url - External URL for link posts (optional)
 */
export async function createPost(
  title: string,
  content?: string,
  submolt?: string,
  url?: string
): Promise<CreatePostResult> {
  if (!MOLTBOOK_ENABLED) {
    return { success: false, error: 'Moltbook posting is disabled' };
  }

  try {
    const body: Record<string, string> = { title };
    if (content) body.content = content;
    if (submolt) body.submolt = submolt;
    if (url) body.url = url;

    const result = await moltbookRequest<{ success: boolean; post: MoltbookPost }>('/posts', {
      method: 'POST',
      body: JSON.stringify(body),
    });

    logger.info({ postId: result.post?.id, title }, 'Created Moltbook post');
    return { success: true, post: result.post };
  } catch (err) {
    const error = err instanceof Error ? err.message : 'Unknown error';
    logger.error({ err, title }, 'Failed to create Moltbook post');
    return { success: false, error };
  }
}

/**
 * Create a comment on a post
 * @param postId - Post to comment on
 * @param content - Comment content
 * @param parentId - Parent comment ID for nested replies (optional)
 */
export async function createComment(
  postId: string,
  content: string,
  parentId?: string
): Promise<CreateCommentResult> {
  if (!MOLTBOOK_ENABLED) {
    return { success: false, error: 'Moltbook commenting is disabled' };
  }

  try {
    const body: Record<string, string> = { content };
    if (parentId) body.parent_id = parentId;

    const result = await moltbookRequest<{ success: boolean; comment: MoltbookComment }>(
      `/posts/${postId}/comments`,
      {
        method: 'POST',
        body: JSON.stringify(body),
      }
    );

    logger.info({ postId, commentId: result.comment?.id }, 'Created Moltbook comment');
    return { success: true, comment: result.comment };
  } catch (err) {
    const error = err instanceof Error ? err.message : 'Unknown error';
    logger.error({ err, postId }, 'Failed to create Moltbook comment');
    return { success: false, error };
  }
}

/**
 * Vote on a post or comment
 * @param targetType - 'post' or 'comment'
 * @param targetId - ID of the post or comment
 * @param direction - 1 for upvote, -1 for downvote, 0 to remove vote
 */
export async function vote(
  targetType: 'post' | 'comment',
  targetId: string,
  direction: 1 | -1 | 0
): Promise<{ success: boolean; error?: string }> {
  if (!MOLTBOOK_ENABLED) {
    return { success: false, error: 'Moltbook voting is disabled' };
  }

  try {
    const endpoint = targetType === 'post' ? `/posts/${targetId}/vote` : `/comments/${targetId}/vote`;

    await moltbookRequest(endpoint, {
      method: 'POST',
      body: JSON.stringify({ direction }),
    });

    return { success: true };
  } catch (err) {
    const error = err instanceof Error ? err.message : 'Unknown error';
    return { success: false, error };
  }
}

// ============== Agent Profile ==============

/**
 * Get current agent's status (karma, post count, etc.)
 */
export async function getAgentStatus(): Promise<MoltbookAgentStatus | null> {
  try {
    const result = await moltbookRequest<{ agent: MoltbookAgentStatus }>('/agents/status');
    return result.agent;
  } catch (err) {
    logger.error({ err }, 'Failed to get Moltbook agent status');
    return null;
  }
}

/**
 * Check the heartbeat for platform updates
 */
export async function checkHeartbeat(): Promise<string | null> {
  try {
    const response = await fetch('https://www.moltbook.com/heartbeat.md', {
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) return null;
    return response.text();
  } catch {
    return null;
  }
}
