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

// Track account suspension to avoid repeated failed requests
let suspendedUntil: number | null = null;

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

export interface MoltbookSubmolt {
  id: string;
  name: string;
  display_name: string;
  description: string | null;
  subscriber_count: number;
}

export interface MoltbookSubmoltsResponse {
  success: boolean;
  submolts: MoltbookSubmolt[];
}

// ============== DM Types ==============

export interface MoltbookDMCheck {
  pending_requests: number;
  unread_messages: number;
}

export interface MoltbookDMRequest {
  id: string;
  from: { id: string; name: string };
  message: string;
  created_at: string;
}

export interface MoltbookDMConversation {
  id: string;
  agent: { id: string; name: string };
  unread_count: number;
  last_message?: string;
}

export interface MoltbookDMMessage {
  id: string;
  from: { id: string; name: string };
  message: string;
  created_at: string;
  needs_human_input?: boolean;
}

// ============== Error Types ==============

export class MoltbookApiError extends Error {
  public readonly body: string;

  constructor(
    public readonly status: number,
    body: string,
    public readonly endpoint: string
  ) {
    super(`Moltbook API error: ${status} - ${body.substring(0, 200)}`);
    this.body = body.substring(0, 1000);
  }

  get isNotFound(): boolean {
    return this.status === 404;
  }

  get isSuspended(): boolean {
    return this.status === 401 && this.body.includes('Account suspended');
  }
}

// ============== API Client ==============

/**
 * Check if Moltbook integration is configured and enabled
 */
export function isMoltbookEnabled(): boolean {
  return MOLTBOOK_ENABLED && !!MOLTBOOK_API_KEY;
}

/**
 * Check if the account is currently suspended
 */
export function isAccountSuspended(): boolean {
  if (!suspendedUntil) return false;
  if (Date.now() > suspendedUntil) {
    suspendedUntil = null;
    return false;
  }
  return true;
}

/**
 * Parse suspension duration from error message and cache it
 */
function handleSuspension(body: string): void {
  // Parse "Suspension ends in N days" from error body
  const match = body.match(/Suspension ends in (\d+) days?/i);
  const days = match ? parseInt(match[1], 10) : 1; // Default to 1 day if unparseable
  const alreadyKnown = isAccountSuspended();
  suspendedUntil = Date.now() + days * 24 * 60 * 60 * 1000;
  if (!alreadyKnown) {
    logger.warn({ suspendedUntilDate: new Date(suspendedUntil).toISOString(), days }, 'Moltbook account is suspended');
  }
}

/**
 * Make an authenticated request to the Moltbook API
 */
async function moltbookRequest<T>(
  endpoint: string,
  options: RequestInit = {},
  { bypassSuspensionCheck = false }: { bypassSuspensionCheck?: boolean } = {}
): Promise<T> {
  if (!MOLTBOOK_API_KEY) {
    throw new Error('MOLTBOOK_API_KEY not configured');
  }

  if (!bypassSuspensionCheck && isAccountSuspended()) {
    throw new MoltbookApiError(401, 'Account is suspended (cached)', endpoint);
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

    // Detect and cache suspension (not an unexpected error, so skip error logging)
    if (response.status === 401 && errorText.includes('Account suspended')) {
      handleSuspension(errorText);
    } else {
      logger.error({ status: response.status, endpoint }, 'Moltbook API error');
    }

    throw new MoltbookApiError(response.status, errorText, endpoint);
  }

  try {
    return await response.json() as T;
  } catch {
    throw new Error('Invalid JSON response from Moltbook API');
  }
}

// ============== Submolts Cache ==============

let submoltsCache: MoltbookSubmolt[] | null = null;
let submoltsCacheTime = 0;
const SUBMOLTS_CACHE_TTL = 60 * 60 * 1000; // 1 hour

/**
 * Get all submolts (cached for 1 hour)
 */
export async function getSubmolts(): Promise<MoltbookSubmolt[]> {
  const now = Date.now();
  if (submoltsCache && now - submoltsCacheTime < SUBMOLTS_CACHE_TTL) {
    return submoltsCache;
  }

  try {
    const result = await moltbookRequest<MoltbookSubmoltsResponse>('/submolts');
    submoltsCache = result.submolts;
    submoltsCacheTime = now;
    logger.debug({ count: result.submolts.length }, 'Refreshed submolts cache');
    return result.submolts;
  } catch (err) {
    if (err instanceof MoltbookApiError && err.status === 401) {
      logger.debug('Cannot fetch submolts - account suspended');
    } else {
      logger.error({ err }, 'Failed to fetch submolts');
    }
    // Return cached data if available, even if stale
    if (submoltsCache) return submoltsCache;
    throw err;
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
    if (err instanceof MoltbookApiError && err.status === 401) {
      logger.debug({ title }, 'Cannot create Moltbook post - account suspended');
    } else {
      logger.error({ err, title }, 'Failed to create Moltbook post');
    }
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
    if (err instanceof MoltbookApiError && err.status === 401) {
      logger.debug({ postId }, 'Cannot create Moltbook comment - account suspended');
    } else {
      logger.error({ err, postId }, 'Failed to create Moltbook comment');
    }
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

// ============== Social Graph ==============

/**
 * Follow another agent
 * @param agentId - The agent ID to follow
 */
export async function followAgent(agentId: string): Promise<{ success: boolean; error?: string }> {
  if (!MOLTBOOK_ENABLED) {
    return { success: false, error: 'Moltbook is disabled' };
  }

  // Validate agentId format (alphanumeric, hyphens, underscores)
  if (!agentId || !/^[a-zA-Z0-9_-]+$/.test(agentId)) {
    return { success: false, error: 'Invalid agent ID format' };
  }

  try {
    await moltbookRequest(`/agents/${agentId}/follow`, {
      method: 'POST',
    });

    logger.info({ agentId }, 'Followed agent on Moltbook');
    return { success: true };
  } catch (err) {
    const error = err instanceof Error ? err.message : 'Unknown error';
    logger.debug({ err, agentId }, 'Failed to follow agent');
    return { success: false, error };
  }
}

/**
 * Unfollow an agent
 * @param agentId - The agent ID to unfollow
 */
export async function unfollowAgent(agentId: string): Promise<{ success: boolean; error?: string }> {
  if (!MOLTBOOK_ENABLED) {
    return { success: false, error: 'Moltbook is disabled' };
  }

  // Validate agentId format (alphanumeric, hyphens, underscores)
  if (!agentId || !/^[a-zA-Z0-9_-]+$/.test(agentId)) {
    return { success: false, error: 'Invalid agent ID format' };
  }

  try {
    await moltbookRequest(`/agents/${agentId}/follow`, {
      method: 'DELETE',
    });

    logger.info({ agentId }, 'Unfollowed agent on Moltbook');
    return { success: true };
  } catch (err) {
    const error = err instanceof Error ? err.message : 'Unknown error';
    return { success: false, error };
  }
}

// ============== Direct Messages ==============
// DM functions bypass the suspension check because DMs may contain
// platform verification challenges needed to lift suspensions.

const MOLTBOOK_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

/**
 * Check for pending DM requests and unread messages
 */
export async function checkDMs(): Promise<MoltbookDMCheck> {
  return moltbookRequest<MoltbookDMCheck>('/agents/dm/check', {}, { bypassSuspensionCheck: true });
}

/**
 * Get pending DM requests from other agents
 */
export async function getDMRequests(): Promise<MoltbookDMRequest[]> {
  const result = await moltbookRequest<{ requests: MoltbookDMRequest[] }>(
    '/agents/dm/requests', {}, { bypassSuspensionCheck: true }
  );
  return result.requests ?? [];
}

/**
 * Approve a DM request to start a conversation
 */
export async function approveDMRequest(requestId: string): Promise<{ success: boolean; error?: string }> {
  if (!requestId || !MOLTBOOK_ID_PATTERN.test(requestId)) {
    return { success: false, error: 'Invalid request ID format' };
  }

  try {
    await moltbookRequest(
      `/agents/dm/requests/${requestId}/approve`,
      { method: 'POST' },
      { bypassSuspensionCheck: true }
    );
    return { success: true };
  } catch (err) {
    const error = err instanceof Error ? err.message : 'Unknown error';
    return { success: false, error };
  }
}

/**
 * Get all DM conversations
 */
export async function getDMConversations(): Promise<MoltbookDMConversation[]> {
  const result = await moltbookRequest<{ conversations: MoltbookDMConversation[] }>(
    '/agents/dm/conversations', {}, { bypassSuspensionCheck: true }
  );
  return result.conversations ?? [];
}

/**
 * Get messages in a specific conversation (marks as read)
 */
export async function getDMConversation(conversationId: string): Promise<MoltbookDMMessage[]> {
  if (!conversationId || !MOLTBOOK_ID_PATTERN.test(conversationId)) {
    return [];
  }

  const result = await moltbookRequest<{ messages: MoltbookDMMessage[] }>(
    `/agents/dm/conversations/${conversationId}`, {}, { bypassSuspensionCheck: true }
  );
  return result.messages ?? [];
}

/**
 * Send a message in a DM conversation
 */
export async function sendDM(
  conversationId: string,
  message: string
): Promise<{ success: boolean; error?: string }> {
  if (!conversationId || !MOLTBOOK_ID_PATTERN.test(conversationId)) {
    return { success: false, error: 'Invalid conversation ID format' };
  }

  try {
    await moltbookRequest(
      `/agents/dm/conversations/${conversationId}/send`,
      { method: 'POST', body: JSON.stringify({ message }) },
      { bypassSuspensionCheck: true }
    );
    return { success: true };
  } catch (err) {
    const error = err instanceof Error ? err.message : 'Unknown error';
    return { success: false, error };
  }
}
