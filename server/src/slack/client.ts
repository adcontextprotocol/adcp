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
const SLACK_API_BASE = 'https://slack.com/api';

// Rate limiting: Slack's tier 2 methods allow ~20 requests per minute
const RATE_LIMIT_DELAY_MS = 100; // Small delay between requests

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
 */
async function slackPostRequest<T>(
  method: string,
  body: Record<string, unknown>,
  retries = 3
): Promise<T> {
  if (!SLACK_BOT_TOKEN) {
    throw new Error('SLACK_BOT_TOKEN is not configured');
  }

  const url = `${SLACK_API_BASE}/${method}`;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
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
 */
export async function sendChannelMessage(
  channelId: string,
  message: SlackBlockMessage
): Promise<{ ok: boolean; ts?: string; error?: string }> {
  try {
    const response = await slackPostRequest<{ ts: string }>('chat.postMessage', {
      channel: channelId,
      text: message.text,
      blocks: message.blocks,
      thread_ts: message.thread_ts,
      reply_broadcast: message.reply_broadcast,
    });

    logger.info({ channelId, ts: response.ts }, 'Sent Slack channel message');
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
