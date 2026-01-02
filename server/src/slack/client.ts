/**
 * Slack Web API client for AAO integration
 *
 * Provides methods for user lookup, DM sending, and channel management.
 * Uses bot token authentication.
 */

import { logger } from '../logger.js';
import type {
  SlackUser,
  SlackChannel,
  SlackPaginatedResponse,
  SlackBlockMessage,
} from './types.js';

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const ADDIE_BOT_TOKEN = process.env.ADDIE_BOT_TOKEN;
const SLACK_API_BASE = 'https://slack.com/api';

// Rate limiting: Slack's tier 2 methods allow ~20 requests per minute
const RATE_LIMIT_DELAY_MS = 100; // Small delay between requests

// =====================================================
// CHANNEL INFO CACHE
// Channel names/purposes rarely change, so cache for 30 minutes
// =====================================================
const CHANNEL_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const MAX_CHANNEL_CACHE_SIZE = 500;

interface ChannelCacheEntry {
  channel: SlackChannel;
  expiresAt: number;
}

const channelCache = new Map<string, ChannelCacheEntry>();

/**
 * Make an authenticated request to the Slack API
 */
async function slackRequest<T>(
  method: string,
  params: Record<string, string | number | boolean | undefined> = {},
  retries = 3
): Promise<T> {
  if (!SLACK_BOT_TOKEN) {
    throw new Error('SLACK_BOT_TOKEN is not configured');
  }

  const url = new URL(`${SLACK_API_BASE}/${method}`);

  // Add params to URL for GET requests (most Slack API methods use this)
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined) {
      url.searchParams.set(key, String(value));
    }
  });

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url.toString(), {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      });

      const data = (await response.json()) as T & { ok: boolean; error?: string };

      if (!data.ok) {
        // Handle rate limiting
        if (data.error === 'ratelimited') {
          const retryAfter = response.headers.get('Retry-After');
          const delay = retryAfter ? parseInt(retryAfter, 10) * 1000 : 60000;
          logger.warn({ method, delay }, 'Slack rate limited, waiting');
          await sleep(delay);
          continue;
        }

        throw new Error(`Slack API error: ${data.error}`);
      }

      return data;
    } catch (error) {
      logger.error({ error, method, attempt, retries }, 'Slack API request failed');

      if (attempt === retries) {
        throw error;
      }

      // Exponential backoff
      const delay = Math.pow(2, attempt) * 1000;
      await sleep(delay);
    }
  }

  throw new Error(`Slack API request failed after ${retries} retries`);
}

/**
 * Make a POST request to the Slack API (for chat.postMessage, etc.)
 * @param useAddieToken - If true, uses ADDIE_BOT_TOKEN instead of SLACK_BOT_TOKEN
 */
async function slackPostRequest<T>(
  method: string,
  body: Record<string, unknown>,
  retries = 3,
  useAddieToken = false
): Promise<T> {
  const token = useAddieToken ? (ADDIE_BOT_TOKEN || SLACK_BOT_TOKEN) : SLACK_BOT_TOKEN;
  if (!token) {
    throw new Error(useAddieToken ? 'ADDIE_BOT_TOKEN is not configured' : 'SLACK_BOT_TOKEN is not configured');
  }

  const url = `${SLACK_API_BASE}/${method}`;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify(body),
      });

      const data = (await response.json()) as T & { ok: boolean; error?: string };

      if (!data.ok) {
        if (data.error === 'ratelimited') {
          const retryAfter = response.headers.get('Retry-After');
          const delay = retryAfter ? parseInt(retryAfter, 10) * 1000 : 60000;
          logger.warn({ method, delay }, 'Slack rate limited, waiting');
          await sleep(delay);
          continue;
        }

        throw new Error(`Slack API error: ${data.error}`);
      }

      return data;
    } catch (error) {
      logger.error({ error, method, attempt, retries }, 'Slack POST request failed');

      if (attempt === retries) {
        throw error;
      }

      const delay = Math.pow(2, attempt) * 1000;
      await sleep(delay);
    }
  }

  throw new Error(`Slack POST request failed after ${retries} retries`);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Check if Slack integration is configured
 */
export function isSlackConfigured(): boolean {
  return Boolean(SLACK_BOT_TOKEN);
}

/**
 * Get all users in the Slack workspace
 * Handles pagination automatically
 */
export async function getSlackUsers(): Promise<SlackUser[]> {
  const users: SlackUser[] = [];
  let cursor: string | undefined;

  do {
    const response = await slackRequest<SlackPaginatedResponse<SlackUser>>('users.list', {
      limit: 200,
      cursor,
    });

    if (response.members) {
      users.push(...response.members);
    }

    cursor = response.response_metadata?.next_cursor;

    // Small delay between paginated requests
    if (cursor) {
      await sleep(RATE_LIMIT_DELAY_MS);
    }
  } while (cursor);

  logger.info({ count: users.length }, 'Fetched Slack users');
  return users;
}

/**
 * Get a single user by ID
 */
export async function getSlackUser(userId: string): Promise<SlackUser | null> {
  try {
    const response = await slackRequest<{ user: SlackUser }>('users.info', {
      user: userId,
    });
    return response.user;
  } catch (error) {
    logger.error({ error, userId }, 'Failed to get Slack user');
    return null;
  }
}

/**
 * Get a single user by ID using Addie's bot token
 * Use this when Addie needs to look up users in channels it has access to
 */
export async function getSlackUserWithAddieToken(userId: string): Promise<SlackUser | null> {
  if (!ADDIE_BOT_TOKEN) {
    logger.warn('ADDIE_BOT_TOKEN not configured, cannot look up user');
    return null;
  }

  try {
    const url = new URL(`${SLACK_API_BASE}/users.info`);
    url.searchParams.set('user', userId);

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${ADDIE_BOT_TOKEN}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });

    const data = await response.json() as { ok: boolean; user?: SlackUser; error?: string };

    if (!data.ok) {
      logger.warn({ error: data.error, userId }, 'Failed to get Slack user with Addie token');
      return null;
    }

    return data.user || null;
  } catch (error) {
    logger.error({ error, userId }, 'Error fetching Slack user with Addie token');
    return null;
  }
}

/**
 * Look up a user by email address
 */
export async function lookupSlackUserByEmail(email: string): Promise<SlackUser | null> {
  try {
    const response = await slackRequest<{ user: SlackUser }>('users.lookupByEmail', {
      email,
    });
    return response.user;
  } catch (error) {
    // users_not_found is expected when email doesn't exist
    if (error instanceof Error && error.message.includes('users_not_found')) {
      return null;
    }
    logger.error({ error, email }, 'Failed to lookup Slack user by email');
    return null;
  }
}

/**
 * Send a direct message to a user
 */
export async function sendDirectMessage(
  userId: string,
  message: SlackBlockMessage
): Promise<{ ok: boolean; ts?: string; error?: string }> {
  try {
    // First, open a DM channel with the user
    const imResponse = await slackPostRequest<{ channel: { id: string } }>('conversations.open', {
      users: userId,
    });

    const channelId = imResponse.channel.id;

    // Send the message
    const messageResponse = await slackPostRequest<{ ts: string }>('chat.postMessage', {
      channel: channelId,
      text: message.text,
      blocks: message.blocks,
    });

    logger.info({ userId, ts: messageResponse.ts }, 'Sent Slack DM');
    return { ok: true, ts: messageResponse.ts };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error({ error, userId }, 'Failed to send Slack DM');
    return { ok: false, error: errorMessage };
  }
}

/**
 * Send a message to a channel
 * @param useAddieToken - If true, uses ADDIE_BOT_TOKEN for Addie's DM channels
 */
export async function sendChannelMessage(
  channelId: string,
  message: SlackBlockMessage,
  useAddieToken = false
): Promise<{ ok: boolean; ts?: string; error?: string }> {
  try {
    const response = await slackPostRequest<{ ts: string }>('chat.postMessage', {
      channel: channelId,
      text: message.text,
      blocks: message.blocks,
      thread_ts: message.thread_ts,
      reply_broadcast: message.reply_broadcast,
    }, 3, useAddieToken);

    logger.info({ channelId, ts: response.ts, useAddieToken }, 'Sent Slack channel message');
    return { ok: true, ts: response.ts };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error({ error, channelId }, 'Failed to send Slack channel message');
    return { ok: false, error: errorMessage };
  }
}

/**
 * Get all channels in the workspace (public channels only by default)
 */
export async function getSlackChannels(
  options: { types?: string; exclude_archived?: boolean } = {}
): Promise<SlackChannel[]> {
  const channels: SlackChannel[] = [];
  let cursor: string | undefined;

  do {
    const response = await slackRequest<SlackPaginatedResponse<SlackChannel>>(
      'conversations.list',
      {
        types: options.types || 'public_channel',
        exclude_archived: options.exclude_archived ?? true,
        limit: 200,
        cursor,
      }
    );

    if (response.channels) {
      channels.push(...response.channels);
    }

    cursor = response.response_metadata?.next_cursor;

    if (cursor) {
      await sleep(RATE_LIMIT_DELAY_MS);
    }
  } while (cursor);

  logger.info({ count: channels.length }, 'Fetched Slack channels');
  return channels;
}

/**
 * Get channel info by ID (cached for 30 minutes)
 */
export async function getChannelInfo(channelId: string): Promise<SlackChannel | null> {
  const now = Date.now();

  // Check cache
  const cached = channelCache.get(channelId);
  if (cached && cached.expiresAt > now) {
    return cached.channel;
  }

  try {
    const response = await slackRequest<{ channel: SlackChannel }>('conversations.info', {
      channel: channelId,
    });

    // Evict oldest entry if cache is full
    if (channelCache.size >= MAX_CHANNEL_CACHE_SIZE) {
      const oldestKey = channelCache.keys().next().value;
      if (oldestKey) {
        channelCache.delete(oldestKey);
      }
    }

    // Cache the result
    channelCache.set(channelId, {
      channel: response.channel,
      expiresAt: now + CHANNEL_CACHE_TTL_MS,
    });

    return response.channel;
  } catch (error) {
    logger.error({ error, channelId }, 'Failed to get channel info');
    return null;
  }
}

/**
 * Get members of a channel
 */
export async function getChannelMembers(channelId: string): Promise<string[]> {
  const members: string[] = [];
  let cursor: string | undefined;

  do {
    const response = await slackRequest<{
      members: string[];
      response_metadata?: { next_cursor?: string };
    }>('conversations.members', {
      channel: channelId,
      limit: 200,
      cursor,
    });

    if (response.members) {
      members.push(...response.members);
    }

    cursor = response.response_metadata?.next_cursor;

    if (cursor) {
      await sleep(RATE_LIMIT_DELAY_MS);
    }
  } while (cursor);

  return members;
}

/**
 * Search message result
 */
export interface SlackSearchMatch {
  iid: string;
  team: string;
  channel: { id: string; name: string };
  type: string;
  user: string;
  username: string;
  ts: string;
  text: string;
  permalink: string;
}

/**
 * Search for messages across public channels
 * Requires search:read scope
 */
export async function searchSlackMessages(
  query: string,
  options: { count?: number; sort?: 'score' | 'timestamp' } = {}
): Promise<{ matches: SlackSearchMatch[]; total: number }> {
  try {
    const response = await slackRequest<{
      messages: {
        total: number;
        matches: SlackSearchMatch[];
      };
    }>('search.messages', {
      query,
      count: options.count ?? 10,
      sort: options.sort ?? 'score',
      sort_dir: 'desc',
    });

    return {
      matches: response.messages?.matches ?? [],
      total: response.messages?.total ?? 0,
    };
  } catch (error) {
    // search:read scope might not be granted
    logger.error({ error, query }, 'Failed to search Slack messages');
    return { matches: [], total: 0 };
  }
}

/**
 * Message from conversations.replies
 */
export interface SlackThreadMessage {
  type: string;
  user?: string;
  text: string;
  ts: string;
  thread_ts?: string;
  reply_count?: number;
  parent_user_id?: string;
}

/**
 * Get thread replies (conversations.replies)
 * Returns all messages in a thread, including the parent message
 * @param useAddieToken - If true, uses ADDIE_BOT_TOKEN
 */
export async function getThreadReplies(
  channelId: string,
  threadTs: string,
  useAddieToken = false
): Promise<SlackThreadMessage[]> {
  let token: string | undefined;
  if (useAddieToken) {
    if (!ADDIE_BOT_TOKEN) {
      throw new Error('ADDIE_BOT_TOKEN is not configured');
    }
    token = ADDIE_BOT_TOKEN;
  } else {
    if (!SLACK_BOT_TOKEN) {
      throw new Error('SLACK_BOT_TOKEN is not configured');
    }
    token = SLACK_BOT_TOKEN;
  }

  try {
    const url = new URL(`${SLACK_API_BASE}/conversations.replies`);
    url.searchParams.set('channel', channelId);
    url.searchParams.set('ts', threadTs);
    url.searchParams.set('limit', '100'); // Get up to 100 messages in thread

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });

    const data = await response.json() as {
      ok: boolean;
      messages?: SlackThreadMessage[];
      error?: string;
    };

    if (!data.ok) {
      logger.warn({ error: data.error, channelId, threadTs }, 'Failed to get thread replies');
      return [];
    }

    return data.messages || [];
  } catch (error) {
    logger.error({ error, channelId, threadTs }, 'Error fetching thread replies');
    return [];
  }
}

/**
 * Open a group DM (multi-person direct message) with multiple users
 * Slack calls these "mpim" (multi-person instant message)
 *
 * @param userIds - Array of 2-8 Slack user IDs (do NOT include the bot's user ID)
 * @returns The channel ID of the group DM, or null on error
 */
export async function openGroupDM(
  userIds: string[]
): Promise<{ channelId: string } | null> {
  if (userIds.length < 2) {
    logger.warn({ userIds }, 'openGroupDM requires at least 2 users');
    return null;
  }

  if (userIds.length > 8) {
    logger.warn({ userIds, count: userIds.length }, 'openGroupDM supports max 8 users, truncating');
    userIds = userIds.slice(0, 8);
  }

  try {
    // conversations.open with multiple users creates an mpim (group DM)
    const response = await slackPostRequest<{ channel: { id: string } }>('conversations.open', {
      users: userIds.join(','),
    });

    logger.info({ channelId: response.channel.id, userCount: userIds.length }, 'Opened group DM');
    return { channelId: response.channel.id };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error({ error: errorMessage, userIds }, 'Failed to open group DM');
    return null;
  }
}

/**
 * Test the Slack connection (auth.test)
 */
export async function testSlackConnection(): Promise<{
  ok: boolean;
  team?: string;
  team_id?: string;
  user?: string;
  user_id?: string;
  bot_id?: string;
  error?: string;
}> {
  try {
    const response = await slackRequest<{
      team: string;
      team_id: string;
      user: string;
      user_id: string;
      bot_id: string;
    }>('auth.test');

    return {
      ok: true,
      ...response,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { ok: false, error: errorMessage };
  }
}
