/**
 * Slack History Backfill Job
 *
 * Indexes historical Slack messages for Addie's search_slack tool.
 * This job fetches message history from channels and stores them
 * in the addie_knowledge table for full-text search.
 *
 * Features:
 * - Fetches both top-level messages and thread replies
 * - Supports public and private channels
 * - Excludes sensitive channels (admin, billing) by default
 * - Idempotent - running multiple times won't create duplicates
 */

import { logger } from '../../logger.js';
import { AddieDatabase } from '../../db/addie-db.js';
import { WorkingGroupDatabase } from '../../db/working-group-db.js';
import {
  getSlackChannels,
  getFullChannelHistory,
  getThreadReplies,
  getSlackUser,
  getChannelInfo,
  type SlackHistoryMessage,
} from '../../slack/client.js';

const addieDb = new AddieDatabase();
const workingGroupDb = new WorkingGroupDatabase();

/**
 * Default channels to exclude from indexing (sensitive/admin channels)
 * These contain billing info, admin discussions, etc. that shouldn't be searchable
 */
const DEFAULT_EXCLUDED_CHANNELS = [
  'aao-billing',
  'admin',
  'billing',
  'finance',
  'hr',
  'legal',
  'executive',
  'board',
  'confidential',
];

export interface BackfillResult {
  channelsProcessed: number;
  messagesIndexed: number;
  threadRepliesIndexed: number;
  messagesSkipped: number;
  errors: number;
  channels: Array<{
    id: string;
    name: string;
    isPrivate: boolean;
    messagesIndexed: number;
    threadRepliesIndexed: number;
    messagesSkipped: number;
  }>;
}

export interface BackfillOptions {
  /** Number of days of history to fetch (default: 90) */
  daysBack?: number;
  /** Maximum messages per channel (default: 1000) */
  maxMessagesPerChannel?: number;
  /** Specific channel IDs to backfill (default: all accessible channels) */
  channelIds?: string[];
  /** Include private channels (default: true, access controlled at query time) */
  includePrivateChannels?: boolean;
  /** Channel names to exclude (default: admin/billing channels) */
  excludeChannelNames?: string[];
  /** Minimum message length to index (default: 20) */
  minMessageLength?: number;
  /** Include thread replies (default: true) */
  includeThreadReplies?: boolean;
  /** Progress callback */
  onProgress?: (status: {
    channel: string;
    messagesProcessed: number;
    totalChannels: number;
    currentChannel: number;
    phase: 'messages' | 'threads';
  }) => void;
}

/**
 * Run the Slack history backfill job
 *
 * Fetches historical messages from channels and indexes them
 * for Addie's search functionality.
 */
export async function runSlackHistoryBackfill(options: BackfillOptions = {}): Promise<BackfillResult> {
  const {
    daysBack = 90,
    maxMessagesPerChannel = 1000,
    channelIds,
    includePrivateChannels = true, // Access controlled at query time via membership checks
    excludeChannelNames = DEFAULT_EXCLUDED_CHANNELS,
    minMessageLength = 20,
    includeThreadReplies = true,
    onProgress,
  } = options;

  logger.info({
    daysBack,
    maxMessagesPerChannel,
    channelIds,
    includePrivateChannels,
    excludeChannelNames,
    includeThreadReplies,
  }, 'Starting Slack history backfill');

  const result: BackfillResult = {
    channelsProcessed: 0,
    messagesIndexed: 0,
    threadRepliesIndexed: 0,
    messagesSkipped: 0,
    errors: 0,
    channels: [],
  };

  // Calculate oldest timestamp
  const oldestDate = new Date();
  oldestDate.setDate(oldestDate.getDate() - daysBack);
  const oldestTs = (oldestDate.getTime() / 1000).toString();

  // Normalize excluded channel names for comparison
  const excludedNamesLower = excludeChannelNames.map(n => n.toLowerCase());

  // Get channels to process
  let channels: Array<{ id: string; name: string; isPrivate: boolean }>;

  if (channelIds && channelIds.length > 0) {
    // Use specific channels
    channels = [];
    for (const id of channelIds) {
      const channelInfo = await getChannelInfo(id);
      if (channelInfo) {
        const name = channelInfo.name || 'unknown';
        // Check exclusion list even for specific channel IDs
        if (excludedNamesLower.includes(name.toLowerCase())) {
          logger.info({ channelId: id, name }, 'Skipping excluded channel');
          continue;
        }
        channels.push({
          id,
          name,
          isPrivate: channelInfo.is_private || false,
        });
      } else {
        logger.warn({ channelId: id }, 'Could not fetch channel info, skipping');
      }
    }
  } else {
    // Get channels based on type preference
    const channelTypes = includePrivateChannels
      ? 'public_channel,private_channel'
      : 'public_channel';

    const allChannels = await getSlackChannels({
      types: channelTypes,
      exclude_archived: true,
    });

    // Filter out excluded channels
    channels = allChannels
      .filter(c => !excludedNamesLower.includes((c.name || '').toLowerCase()))
      .map(c => ({
        id: c.id,
        name: c.name || 'unknown',
        isPrivate: c.is_private || false,
      }));
  }

  // Filter private channels to only include those with working groups
  // (enables fast local access checks without Slack API calls)
  const privateChannelsBefore = channels.filter(c => c.isPrivate).length;
  const filteredChannels: typeof channels = [];
  for (const channel of channels) {
    if (!channel.isPrivate) {
      // Public channels - always include
      filteredChannels.push(channel);
    } else {
      // Private channels - only include if they have a working group
      const workingGroup = await workingGroupDb.getWorkingGroupBySlackChannelId(channel.id);
      if (workingGroup) {
        filteredChannels.push(channel);
      } else {
        logger.debug({ channelId: channel.id, channelName: channel.name }, 'Skipping private channel without working group');
      }
    }
  }
  channels = filteredChannels;
  const privateChannelsAfter = channels.filter(c => c.isPrivate).length;

  logger.info({
    channelCount: channels.length,
    publicCount: channels.filter(c => !c.isPrivate).length,
    privateCount: privateChannelsAfter,
    privateChannelsSkipped: privateChannelsBefore - privateChannelsAfter,
  }, 'Backfilling channels (private channels without working groups skipped)');

  // User cache to avoid repeated lookups
  const userCache = new Map<string, { displayName: string } | null>();

  async function getUserDisplayName(userId: string): Promise<string> {
    if (userCache.has(userId)) {
      return userCache.get(userId)?.displayName || 'unknown';
    }

    try {
      const user = await getSlackUser(userId);
      if (user) {
        const displayName = user.profile?.display_name || user.profile?.real_name || user.name || 'unknown';
        userCache.set(userId, { displayName });
        return displayName;
      }
    } catch (error) {
      logger.debug({ error, userId }, 'Failed to fetch user info');
    }

    userCache.set(userId, null);
    return 'unknown';
  }

  async function indexMessage(
    channelId: string,
    channelName: string,
    message: { user?: string; text?: string; ts: string; bot_id?: string; subtype?: string },
    channelResult: { messagesIndexed: number; threadRepliesIndexed: number; messagesSkipped: number },
    isThreadReply: boolean = false
  ): Promise<boolean> {
    // Skip bot messages, subtypes (edits, deletes, etc.), and messages without text
    if (message.bot_id || message.subtype || !message.text || !message.user) {
      channelResult.messagesSkipped++;
      return false;
    }

    // Skip short messages
    if (message.text.length < minMessageLength) {
      channelResult.messagesSkipped++;
      return false;
    }

    try {
      const username = await getUserDisplayName(message.user);

      // Construct permalink using env var or default workspace
      const workspaceUrl = process.env.SLACK_WORKSPACE_URL || 'https://agenticads.slack.com';
      const tsForLink = message.ts.replace('.', '');
      const permalink = `${workspaceUrl}/archives/${channelId}/p${tsForLink}`;

      await addieDb.indexSlackMessage({
        channel_id: channelId,
        channel_name: channelName,
        user_id: message.user,
        username,
        ts: message.ts,
        text: message.text,
        permalink,
      });

      if (isThreadReply) {
        channelResult.threadRepliesIndexed++;
      } else {
        channelResult.messagesIndexed++;
      }
      return true;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Unique constraint violations are expected for duplicates - log at debug
      if (errorMessage.includes('duplicate') || errorMessage.includes('unique') || errorMessage.includes('violates unique constraint')) {
        logger.debug({ channelId, ts: message.ts }, 'Skipping duplicate message');
      } else {
        // Unexpected error - log at warning level
        logger.warn({ error, channelId, ts: message.ts }, 'Unexpected error indexing message');
      }

      channelResult.messagesSkipped++;
      return false;
    }
  }

  // Process each channel
  for (let i = 0; i < channels.length; i++) {
    const channel = channels[i];
    const channelResult = {
      id: channel.id,
      name: channel.name,
      isPrivate: channel.isPrivate,
      messagesIndexed: 0,
      threadRepliesIndexed: 0,
      messagesSkipped: 0,
    };

    try {
      logger.info({
        channel: channel.name,
        channelId: channel.id,
        isPrivate: channel.isPrivate,
      }, 'Fetching channel history');

      // Fetch messages
      const messages = await getFullChannelHistory(channel.id, {
        oldest: oldestTs,
        maxMessages: maxMessagesPerChannel,
        onProgress: (count) => {
          if (onProgress) {
            onProgress({
              channel: channel.name,
              messagesProcessed: count,
              totalChannels: channels.length,
              currentChannel: i + 1,
              phase: 'messages',
            });
          }
        },
      });

      logger.info({ channel: channel.name, messageCount: messages.length }, 'Processing messages');

      // Track threads that need reply fetching
      const threadsToFetch: string[] = [];

      // Index each message
      for (const message of messages) {
        await indexMessage(channel.id, channel.name, message, channelResult, false);

        // Track threads with replies for later fetching
        if (includeThreadReplies && message.thread_ts === message.ts && 'reply_count' in message) {
          const replyCount = (message as SlackHistoryMessage & { reply_count?: number }).reply_count;
          if (replyCount && replyCount > 0) {
            threadsToFetch.push(message.ts);
          }
        }
      }

      // Fetch and index thread replies
      if (includeThreadReplies && threadsToFetch.length > 0) {
        logger.info({
          channel: channel.name,
          threadCount: threadsToFetch.length,
        }, 'Fetching thread replies');

        for (let t = 0; t < threadsToFetch.length; t++) {
          const threadTs = threadsToFetch[t];

          if (onProgress) {
            onProgress({
              channel: channel.name,
              messagesProcessed: t + 1,
              totalChannels: channels.length,
              currentChannel: i + 1,
              phase: 'threads',
            });
          }

          try {
            const replies = await getThreadReplies(channel.id, threadTs);

            // Skip the first message (it's the parent, already indexed)
            for (const reply of replies.slice(1)) {
              await indexMessage(channel.id, channel.name, reply, channelResult, true);
            }
          } catch (error) {
            logger.debug({ error, channelId: channel.id, threadTs }, 'Failed to fetch thread replies');
          }

          // Rate limit between thread fetches to avoid hitting Slack API limits
          await new Promise(resolve => setTimeout(resolve, 200));
        }
      }

      result.channelsProcessed++;
      result.messagesIndexed += channelResult.messagesIndexed;
      result.threadRepliesIndexed += channelResult.threadRepliesIndexed;
      result.messagesSkipped += channelResult.messagesSkipped;
      result.channels.push(channelResult);

      logger.info({
        channel: channel.name,
        isPrivate: channel.isPrivate,
        indexed: channelResult.messagesIndexed,
        threadReplies: channelResult.threadRepliesIndexed,
        skipped: channelResult.messagesSkipped,
      }, 'Channel backfill complete');

    } catch (error) {
      logger.error({ error, channel: channel.name, channelId: channel.id }, 'Failed to process channel');
      result.errors++;
      result.channels.push({
        ...channelResult,
        messagesIndexed: 0,
        threadRepliesIndexed: 0,
        messagesSkipped: 0,
      });
    }
  }

  logger.info({
    channelsProcessed: result.channelsProcessed,
    messagesIndexed: result.messagesIndexed,
    threadRepliesIndexed: result.threadRepliesIndexed,
    messagesSkipped: result.messagesSkipped,
    errors: result.errors,
  }, 'Slack history backfill complete');

  return result;
}

/**
 * Get current backfill status
 * Returns stats about what's currently indexed
 */
export async function getBackfillStatus(): Promise<{
  totalMessages: number;
  channelCounts: Array<{ channel: string; count: number }>;
  oldestMessage: Date | null;
  newestMessage: Date | null;
}> {
  const count = await addieDb.getSlackMessageCount();

  // Get channel breakdown - this requires a custom query
  // For now, return basic stats
  return {
    totalMessages: count,
    channelCounts: [], // Would need to add a method to AddieDatabase
    oldestMessage: null,
    newestMessage: null,
  };
}
