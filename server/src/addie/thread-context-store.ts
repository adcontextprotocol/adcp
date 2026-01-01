/**
 * Database-backed Thread Context Store for Addie
 *
 * Stores thread context (which channel the user is viewing) in PostgreSQL.
 * This is necessary because message.im events don't include context,
 * so we need to persist it from assistant_thread_started and
 * assistant_thread_context_changed events.
 *
 * Implements Bolt's AssistantThreadContextStore interface.
 */

// Import internal types from Bolt's internal modules
import type {
  AssistantThreadContextStore,
  AssistantThreadContext,
} from '@slack/bolt/dist/AssistantThreadContextStore';
import type { AllAssistantMiddlewareArgs } from '@slack/bolt/dist/Assistant';
import { logger } from '../logger.js';
import { AddieDatabase } from '../db/addie-db.js';

/**
 * Extract channel ID and thread timestamp from Bolt middleware args
 */
function extractChannelAndThread(args: AllAssistantMiddlewareArgs): { channelId: string; threadTs: string } | null {
  const payload = args.payload;

  // For assistant_thread_started and assistant_thread_context_changed events
  // The channel_id and thread_ts are inside the assistant_thread object
  if ('assistant_thread' in payload && payload.assistant_thread) {
    const assistantThread = payload.assistant_thread as {
      channel_id?: string;
      thread_ts?: string;
    };
    if (assistantThread.channel_id && assistantThread.thread_ts) {
      return {
        channelId: assistantThread.channel_id,
        threadTs: assistantThread.thread_ts,
      };
    }
  }

  // For message events in assistant threads
  if ('channel' in payload && 'thread_ts' in payload) {
    return {
      channelId: payload.channel as string,
      threadTs: (payload.thread_ts || payload.ts) as string,
    };
  }

  return null;
}

export class DatabaseThreadContextStore implements AssistantThreadContextStore {
  private db: AddieDatabase;

  constructor(db: AddieDatabase) {
    this.db = db;
  }

  /**
   * Get thread context from middleware args
   */
  async get(args: AllAssistantMiddlewareArgs): Promise<AssistantThreadContext> {
    const ids = extractChannelAndThread(args);
    if (!ids) {
      logger.debug('ThreadContextStore: Could not extract channel/thread from args');
      return {};
    }

    const { channelId, threadTs } = ids;

    try {
      const context = await this.db.getThreadContext(channelId, threadTs);
      if (context) {
        return {
          channel_id: context.context_channel_id,
          team_id: context.context_team_id,
          enterprise_id: context.context_enterprise_id || undefined,
        };
      }
      return {};
    } catch (error) {
      logger.error({ error, channelId, threadTs }, 'ThreadContextStore: Failed to get context');
      return {};
    }
  }

  /**
   * Save thread context from middleware args
   */
  async save(args: AllAssistantMiddlewareArgs): Promise<void> {
    const ids = extractChannelAndThread(args);
    if (!ids) {
      logger.debug('ThreadContextStore: Could not extract channel/thread from args for save');
      return;
    }

    const { channelId, threadTs } = ids;
    const payload = args.payload;

    // Extract context from the event payload
    let context: AssistantThreadContext = {};
    if ('assistant_thread' in payload && payload.assistant_thread?.context) {
      context = payload.assistant_thread.context;
    }

    if (!context.channel_id || !context.team_id) {
      logger.warn({ channelId, threadTs }, 'ThreadContextStore: No context to save');
      return;
    }

    try {
      await this.db.saveThreadContext({
        channel_id: channelId,
        thread_ts: threadTs,
        context_channel_id: context.channel_id,
        context_team_id: context.team_id,
        context_enterprise_id: context.enterprise_id || null,
      });
      logger.debug({ channelId, threadTs, viewingChannel: context.channel_id }, 'ThreadContextStore: Saved context');
    } catch (error) {
      logger.error({ error, channelId, threadTs }, 'ThreadContextStore: Failed to save context');
      throw error;
    }
  }
}
