/**
 * Unified Thread Service for Addie
 *
 * Provides a consistent interface for managing conversation threads
 * across all channels (Slack, Web, A2A, etc.).
 *
 * This replaces the separate conversation/interaction management in:
 * - addie-db.ts (Slack interactions)
 * - chat-routes.ts (Web conversations)
 */

import { query, getPool } from '../db/client.js';
import { logger } from '../logger.js';

// =====================================================
// TYPES
// =====================================================

export type ThreadChannel = 'slack' | 'web' | 'a2a' | 'email';
export type UserType = 'slack' | 'workos' | 'agent' | 'anonymous';
export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';
export type MessageOutcome = 'resolved' | 'partially_resolved' | 'unresolved' | 'escalated' | 'unknown';
export type UserSentiment = 'positive' | 'neutral' | 'negative' | 'unknown';

export interface ThreadContext {
  // Slack-specific
  viewing_channel_id?: string;
  viewing_channel_name?: string;
  team_id?: string;
  enterprise_id?: string;

  // Web-specific
  referrer?: string;
  page_url?: string;
  user_agent?: string;
  ip_hash?: string;

  // A2A-specific
  agent_url?: string;
  agent_name?: string;
  task_type?: string;

  // Generic
  [key: string]: unknown;
}

export interface CreateThreadInput {
  channel: ThreadChannel;
  external_id: string;
  user_type?: UserType;
  user_id?: string;
  user_display_name?: string;
  context?: ThreadContext;
  title?: string;
  impersonator_user_id?: string;
  impersonation_reason?: string;
}

export interface Thread {
  thread_id: string;
  channel: ThreadChannel;
  external_id: string;
  user_type: UserType;
  user_id: string | null;
  user_display_name: string | null;
  context: ThreadContext;
  title: string | null;
  message_count: number;
  reviewed: boolean;
  reviewed_by: string | null;
  reviewed_at: Date | null;
  review_notes: string | null;
  flagged: boolean;
  flag_reason: string | null;
  experiment_id: number | null;
  experiment_group: 'control' | 'variant' | null;
  active_rules_snapshot: unknown;
  impersonator_user_id: string | null;
  impersonation_reason: string | null;
  started_at: Date;
  last_message_at: Date;
  created_at: Date;
  updated_at: Date;
}

export interface CreateMessageInput {
  thread_id: string;
  role: MessageRole;
  content: string;
  content_sanitized?: string;
  tools_used?: string[];
  tool_calls?: Array<{ name: string; input: unknown; result: unknown }>;
  knowledge_ids?: number[];
  model?: string;
  latency_ms?: number;
  tokens_input?: number;
  tokens_output?: number;
  flagged?: boolean;
  flag_reason?: string;
}

export interface ThreadMessage {
  message_id: string;
  thread_id: string;
  role: MessageRole;
  content: string;
  content_sanitized: string | null;
  tools_used: string[] | null;
  tool_calls: Array<{ name: string; input: unknown; result: unknown }> | null;
  knowledge_ids: number[] | null;
  model: string | null;
  latency_ms: number | null;
  tokens_input: number | null;
  tokens_output: number | null;
  flagged: boolean;
  flag_reason: string | null;
  rating: number | null;
  rating_category: string | null;
  rating_notes: string | null;
  feedback_tags: string[];
  improvement_suggestion: string | null;
  rated_by: string | null;
  rated_at: Date | null;
  outcome: MessageOutcome | null;
  user_sentiment: UserSentiment | null;
  intent_category: string | null;
  sequence_number: number;
  created_at: Date;
}

export interface ThreadWithMessages extends Thread {
  messages: ThreadMessage[];
}

export interface ThreadSummary {
  thread_id: string;
  channel: ThreadChannel;
  external_id: string;
  user_type: UserType;
  user_id: string | null;
  user_display_name: string | null;
  title: string | null;
  message_count: number;
  flagged: boolean;
  reviewed: boolean;
  started_at: Date;
  last_message_at: Date;
  first_user_message: string | null;
  last_assistant_message: string | null;
  avg_rating: number | null;
  total_latency_ms: number | null;
}

export interface ThreadListFilters {
  channel?: ThreadChannel;
  user_id?: string;
  flagged_only?: boolean;
  unreviewed_only?: boolean;
  has_feedback?: boolean;
  since?: Date;
  limit?: number;
  offset?: number;
}

export interface MessageFeedback {
  rating: number;
  rating_category?: string;
  rating_notes?: string;
  feedback_tags?: string[];
  improvement_suggestion?: string;
  rated_by: string;
}

export interface ChannelStats {
  channel: ThreadChannel;
  total_threads: number;
  unique_users: number;
  total_messages: number;
  flagged_threads: number;
  reviewed_threads: number;
  threads_last_24h: number;
  threads_last_7d: number;
}

// =====================================================
// THREAD SERVICE CLASS
// =====================================================

export class ThreadService {
  // =====================================================
  // THREAD OPERATIONS
  // =====================================================

  /**
   * Create or get a thread by channel + external_id
   * Uses UPSERT to handle concurrent requests safely
   */
  async getOrCreateThread(input: CreateThreadInput): Promise<Thread> {
    const result = await query<Thread>(
      `INSERT INTO addie_threads (
        channel, external_id, user_type, user_id, user_display_name,
        context, title, impersonator_user_id, impersonation_reason
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (channel, external_id) DO UPDATE SET
        user_display_name = COALESCE(EXCLUDED.user_display_name, addie_threads.user_display_name),
        context = COALESCE(EXCLUDED.context, addie_threads.context),
        updated_at = NOW()
      RETURNING *`,
      [
        input.channel,
        input.external_id,
        input.user_type || 'anonymous',
        input.user_id || null,
        input.user_display_name || null,
        JSON.stringify(input.context || {}),
        input.title || null,
        input.impersonator_user_id || null,
        input.impersonation_reason || null,
      ]
    );
    return result.rows[0];
  }

  /**
   * Get a thread by ID
   */
  async getThread(threadId: string): Promise<Thread | null> {
    const result = await query<Thread>(
      `SELECT * FROM addie_threads WHERE thread_id = $1`,
      [threadId]
    );
    return result.rows[0] || null;
  }

  /**
   * Get a thread by channel + external_id
   */
  async getThreadByExternalId(channel: ThreadChannel, externalId: string): Promise<Thread | null> {
    const result = await query<Thread>(
      `SELECT * FROM addie_threads WHERE channel = $1 AND external_id = $2`,
      [channel, externalId]
    );
    return result.rows[0] || null;
  }

  /**
   * Update thread context (e.g., when user switches channels in Slack)
   */
  async updateThreadContext(threadId: string, context: ThreadContext): Promise<void> {
    await query(
      `UPDATE addie_threads SET context = $2, updated_at = NOW() WHERE thread_id = $1`,
      [threadId, JSON.stringify(context)]
    );
  }

  /**
   * Update thread title
   */
  async updateThreadTitle(threadId: string, title: string): Promise<void> {
    await query(
      `UPDATE addie_threads SET title = $2, updated_at = NOW() WHERE thread_id = $1`,
      [threadId, title]
    );
  }

  /**
   * Mark thread as reviewed
   */
  async reviewThread(
    threadId: string,
    reviewedBy: string,
    notes?: string
  ): Promise<void> {
    await query(
      `UPDATE addie_threads
       SET reviewed = TRUE, reviewed_by = $2, reviewed_at = NOW(), review_notes = $3, updated_at = NOW()
       WHERE thread_id = $1`,
      [threadId, reviewedBy, notes || null]
    );
  }

  /**
   * Flag a thread
   */
  async flagThread(threadId: string, reason: string): Promise<void> {
    await query(
      `UPDATE addie_threads SET flagged = TRUE, flag_reason = $2, updated_at = NOW() WHERE thread_id = $1`,
      [threadId, reason]
    );
  }

  /**
   * Unflag a thread
   */
  async unflagThread(threadId: string): Promise<void> {
    await query(
      `UPDATE addie_threads SET flagged = FALSE, flag_reason = NULL, updated_at = NOW() WHERE thread_id = $1`,
      [threadId]
    );
  }

  // =====================================================
  // MESSAGE OPERATIONS
  // =====================================================

  /**
   * Add a message to a thread
   * Automatically assigns sequence_number
   */
  async addMessage(input: CreateMessageInput): Promise<ThreadMessage> {
    const pool = getPool();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Get next sequence number
      const seqResult = await client.query<{ next_seq: number }>(
        `SELECT COALESCE(MAX(sequence_number), 0) + 1 as next_seq
         FROM addie_thread_messages WHERE thread_id = $1`,
        [input.thread_id]
      );
      const sequenceNumber = seqResult.rows[0].next_seq;

      // Insert message
      const result = await client.query<ThreadMessage>(
        `INSERT INTO addie_thread_messages (
          thread_id, role, content, content_sanitized, tools_used, tool_calls,
          knowledge_ids, model, latency_ms, tokens_input, tokens_output,
          flagged, flag_reason, sequence_number
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
        RETURNING *`,
        [
          input.thread_id,
          input.role,
          input.content,
          input.content_sanitized || null,
          input.tools_used || null,
          input.tool_calls ? JSON.stringify(input.tool_calls) : null,
          input.knowledge_ids || null,
          input.model || null,
          input.latency_ms || null,
          input.tokens_input || null,
          input.tokens_output || null,
          input.flagged || false,
          input.flag_reason || null,
          sequenceNumber,
        ]
      );

      await client.query('COMMIT');
      return result.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Get all messages in a thread
   */
  async getThreadMessages(threadId: string): Promise<ThreadMessage[]> {
    const result = await query<ThreadMessage>(
      `SELECT * FROM addie_thread_messages
       WHERE thread_id = $1
       ORDER BY sequence_number ASC`,
      [threadId]
    );
    return result.rows;
  }

  /**
   * Get a thread with all its messages
   */
  async getThreadWithMessages(threadId: string): Promise<ThreadWithMessages | null> {
    const thread = await this.getThread(threadId);
    if (!thread) return null;

    const messages = await this.getThreadMessages(threadId);
    return { ...thread, messages };
  }

  /**
   * Add feedback to a message
   */
  async addMessageFeedback(
    messageId: string,
    feedback: MessageFeedback
  ): Promise<void> {
    await query(
      `UPDATE addie_thread_messages
       SET
         rating = $2,
         rating_category = $3,
         rating_notes = $4,
         feedback_tags = $5,
         improvement_suggestion = $6,
         rated_by = $7,
         rated_at = NOW()
       WHERE message_id = $1`,
      [
        messageId,
        feedback.rating,
        feedback.rating_category || null,
        feedback.rating_notes || null,
        JSON.stringify(feedback.feedback_tags || []),
        feedback.improvement_suggestion || null,
        feedback.rated_by,
      ]
    );
  }

  /**
   * Flag a message
   */
  async flagMessage(messageId: string, reason: string): Promise<void> {
    await query(
      `UPDATE addie_thread_messages SET flagged = TRUE, flag_reason = $2 WHERE message_id = $1`,
      [messageId, reason]
    );
  }

  /**
   * Set outcome/sentiment on a message (typically assistant message)
   */
  async setMessageOutcome(
    messageId: string,
    outcome: MessageOutcome,
    sentiment?: UserSentiment,
    intentCategory?: string
  ): Promise<void> {
    await query(
      `UPDATE addie_thread_messages
       SET outcome = $2, user_sentiment = $3, intent_category = $4
       WHERE message_id = $1`,
      [messageId, outcome, sentiment || null, intentCategory || null]
    );
  }

  // =====================================================
  // LISTING & SEARCH
  // =====================================================

  /**
   * List threads with filters
   */
  async listThreads(filters: ThreadListFilters = {}): Promise<ThreadSummary[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIndex = 1;

    if (filters.channel) {
      conditions.push(`channel = $${paramIndex++}`);
      params.push(filters.channel);
    }

    if (filters.user_id) {
      conditions.push(`user_id = $${paramIndex++}`);
      params.push(filters.user_id);
    }

    if (filters.flagged_only) {
      conditions.push(`flagged = TRUE`);
    }

    if (filters.unreviewed_only) {
      conditions.push(`reviewed = FALSE`);
    }

    if (filters.since) {
      conditions.push(`started_at >= $${paramIndex++}`);
      params.push(filters.since);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = filters.limit || 50;
    const offset = filters.offset || 0;

    params.push(limit, offset);

    const result = await query<ThreadSummary>(
      `SELECT * FROM addie_threads_summary
       ${whereClause}
       ORDER BY last_message_at DESC
       LIMIT $${paramIndex++} OFFSET $${paramIndex}`,
      params
    );

    return result.rows;
  }

  /**
   * Get threads for a specific user (across all channels)
   */
  async getUserThreads(
    userId: string,
    userType: UserType,
    limit = 20
  ): Promise<ThreadSummary[]> {
    const result = await query<ThreadSummary>(
      `SELECT * FROM addie_threads_summary
       WHERE user_type = $1 AND user_id = $2
       ORDER BY last_message_at DESC
       LIMIT $3`,
      [userType, userId, limit]
    );
    return result.rows;
  }

  /**
   * Get a user's most recent thread (for proactive messages)
   */
  async getUserRecentThread(
    userId: string,
    userType: UserType,
    maxAgeMinutes = 30
  ): Promise<Thread | null> {
    const result = await query<Thread>(
      `SELECT * FROM addie_threads
       WHERE user_type = $1 AND user_id = $2
         AND last_message_at > NOW() - INTERVAL '${maxAgeMinutes} minutes'
       ORDER BY last_message_at DESC
       LIMIT 1`,
      [userType, userId]
    );
    return result.rows[0] || null;
  }

  // =====================================================
  // STATISTICS
  // =====================================================

  /**
   * Get stats by channel
   */
  async getChannelStats(): Promise<ChannelStats[]> {
    const result = await query<ChannelStats>(
      `SELECT * FROM addie_channel_stats`
    );
    return result.rows;
  }

  /**
   * Get overall stats
   */
  async getStats(): Promise<{
    total_threads: number;
    total_messages: number;
    unique_users: number;
    avg_messages_per_thread: number;
    threads_last_24h: number;
    flagged_threads: number;
    unreviewed_threads: number;
    avg_rating: number | null;
    avg_latency_ms: number | null;
    total_input_tokens: number;
    total_output_tokens: number;
  }> {
    const result = await query<{
      total_threads: string;
      total_messages: string;
      unique_users: string;
      avg_messages_per_thread: string;
      threads_last_24h: string;
      flagged_threads: string;
      unreviewed_threads: string;
      avg_rating: string | null;
      avg_latency_ms: string | null;
      total_input_tokens: string;
      total_output_tokens: string;
    }>(
      `SELECT
        COUNT(DISTINCT t.thread_id) as total_threads,
        (SELECT COUNT(*) FROM addie_thread_messages) as total_messages,
        COUNT(DISTINCT t.user_id) FILTER (WHERE t.user_id IS NOT NULL) as unique_users,
        ROUND(AVG(t.message_count)::numeric, 1) as avg_messages_per_thread,
        COUNT(*) FILTER (WHERE t.started_at > NOW() - INTERVAL '24 hours') as threads_last_24h,
        COUNT(*) FILTER (WHERE t.flagged) as flagged_threads,
        COUNT(*) FILTER (WHERE NOT t.reviewed) as unreviewed_threads,
        (SELECT ROUND(AVG(rating)::numeric, 2) FROM addie_thread_messages WHERE rating IS NOT NULL) as avg_rating,
        (SELECT ROUND(AVG(latency_ms)::numeric, 0) FROM addie_thread_messages WHERE latency_ms IS NOT NULL) as avg_latency_ms,
        (SELECT COALESCE(SUM(tokens_input), 0) FROM addie_thread_messages WHERE tokens_input IS NOT NULL) as total_input_tokens,
        (SELECT COALESCE(SUM(tokens_output), 0) FROM addie_thread_messages WHERE tokens_output IS NOT NULL) as total_output_tokens
      FROM addie_threads t`
    );

    const row = result.rows[0];
    return {
      total_threads: parseInt(row.total_threads, 10) || 0,
      total_messages: parseInt(row.total_messages, 10) || 0,
      unique_users: parseInt(row.unique_users, 10) || 0,
      avg_messages_per_thread: parseFloat(row.avg_messages_per_thread) || 0,
      threads_last_24h: parseInt(row.threads_last_24h, 10) || 0,
      flagged_threads: parseInt(row.flagged_threads, 10) || 0,
      unreviewed_threads: parseInt(row.unreviewed_threads, 10) || 0,
      avg_rating: row.avg_rating ? parseFloat(row.avg_rating) : null,
      avg_latency_ms: row.avg_latency_ms ? parseInt(row.avg_latency_ms, 10) : null,
      total_input_tokens: parseInt(row.total_input_tokens, 10) || 0,
      total_output_tokens: parseInt(row.total_output_tokens, 10) || 0,
    };
  }

  // =====================================================
  // CLEANUP
  // =====================================================

  /**
   * Clean up old anonymous threads (no user_id, older than N days)
   */
  async cleanupAnonymousThreads(olderThanDays = 30): Promise<number> {
    const result = await query(
      `DELETE FROM addie_threads
       WHERE user_id IS NULL
         AND updated_at < NOW() - INTERVAL '${olderThanDays} days'`
    );
    return result.rowCount ?? 0;
  }
}

// Singleton instance
let threadService: ThreadService | null = null;

export function getThreadService(): ThreadService {
  if (!threadService) {
    threadService = new ThreadService();
  }
  return threadService;
}
