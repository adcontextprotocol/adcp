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

// Postgres TEXT and JSONB both reject U+0000. Tool results occasionally
// surface null bytes from upstream APIs, which would otherwise blow up the
// addMessage INSERT with "unsupported Unicode escape sequence" (JSONB) or
// "invalid byte sequence for UTF8" (TEXT). Strip them at the boundary.
const NULL_BYTE = String.fromCharCode(0);
const NULL_BYTE_RE = new RegExp(NULL_BYTE, 'g');

function stripNullBytesString(s: string): string {
  return s.includes(NULL_BYTE) ? s.replace(NULL_BYTE_RE, '') : s;
}

function stripNullBytesFromJson(json: string): string {
  // JSON.stringify encodes a null byte as a six-character backslash-u escape.
  // Strip that encoded form and any raw null byte left in the output.
  return json.replace(/\\u0000/g, '').replace(NULL_BYTE_RE, '');
}

// =====================================================
// TYPES
// =====================================================

export type ThreadChannel = 'slack' | 'web' | 'a2a' | 'email' | 'video';
export type UserType = 'slack' | 'workos' | 'agent' | 'anonymous';
export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';
export type MessageOutcome = 'resolved' | 'partially_resolved' | 'unresolved' | 'escalated' | 'unknown';
export type UserSentiment = 'positive' | 'neutral' | 'negative' | 'unknown';
export type MessageSource = 'typed' | 'cta_chip' | 'voice' | 'paste' | 'unknown';

export interface ThreadContext {
  // Slack-specific
  viewing_channel_id?: string;
  viewing_channel_name?: string;
  viewing_channel_description?: string;
  viewing_channel_topic?: string;
  // Working group associated with the viewing channel (if any)
  viewing_channel_is_private?: boolean;
  viewing_channel_working_group_slug?: string;
  viewing_channel_working_group_name?: string;
  viewing_channel_working_group_id?: string;
  // System channel role (prospect, escalation, billing, error, admin)
  viewing_channel_system_role?: 'prospect' | 'escalation' | 'billing' | 'error' | 'admin';
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
  tool_calls?: Array<{ name: string; input: unknown; result: unknown; duration_ms?: number; is_error?: boolean }>;
  knowledge_ids?: number[];
  model?: string;
  latency_ms?: number;
  tokens_input?: number;
  tokens_output?: number;
  flagged?: boolean;
  flag_reason?: string;
  // Enhanced execution metadata
  timing?: {
    system_prompt_ms?: number;
    total_llm_ms?: number;
    total_tool_ms?: number;
    iterations?: number;
  };
  tokens_cache_creation?: number;
  tokens_cache_read?: number;
  active_rule_ids?: number[];
  // Router decision metadata (for channel messages routed through Haiku)
  router_decision?: {
    action: string;
    reason: string;
    decision_method: 'quick_match' | 'llm';
    tools?: string[];
    confidence?: string;
    latency_ms?: number;
    tokens_input?: number;
    tokens_output?: number;
    model?: string;
  };
  // Configuration version ID (rules + router config snapshot)
  config_version_id?: number;
  // Email threading — RFC 822 Message-ID or Resend ID for threading replies
  email_message_id?: string;
  // Per-message speaker identity. Required to disambiguate speakers in
  // multi-human Slack channel threads where addie_threads.user_id is only
  // the thread starter. Optional for assistant/system rows and legacy paths.
  user_id?: string;
  user_display_name?: string;
  // Input modality — set at write-time so insights jobs can filter CTA chips
  message_source?: MessageSource;
}

export interface ThreadMessage {
  message_id: string;
  thread_id: string;
  role: MessageRole;
  content: string;
  content_sanitized: string | null;
  tools_used: string[] | null;
  tool_calls: Array<{ name: string; input: unknown; result: unknown; duration_ms?: number; is_error?: boolean }> | null;
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
  rating_source: RatingSource | null;
  rated_at: Date | null;
  outcome: MessageOutcome | null;
  user_sentiment: UserSentiment | null;
  intent_category: string | null;
  sequence_number: number;
  created_at: Date;
  // Enhanced execution metadata
  timing_system_prompt_ms: number | null;
  timing_total_llm_ms: number | null;
  timing_total_tool_ms: number | null;
  processing_iterations: number | null;
  tokens_cache_creation: number | null;
  tokens_cache_read: number | null;
  active_rule_ids: number[] | null;
  // Router decision metadata
  router_decision: {
    action: string;
    reason: string;
    decision_method: 'quick_match' | 'llm';
    tools?: string[];
    confidence?: string;
    latency_ms?: number;
    tokens_input?: number;
    tokens_output?: number;
    model?: string;
  } | null;
  // Configuration version ID
  config_version_id: number | null;
  // Email threading
  email_message_id: string | null;
  // Per-message speaker identity (see CreateMessageInput).
  user_id: string | null;
  user_display_name: string | null;
  // Input modality tag (see MessageSource)
  message_source: MessageSource | null;
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
  slack_deleted: boolean;
  slack_channel_name: string | null;
  started_at: Date;
  last_message_at: Date;
  first_user_message: string | null;
  last_assistant_message: string | null;
  avg_rating: number | null;
  total_latency_ms: number | null;
  feedback_count: number;
  user_feedback_count: number;
  positive_feedback_count: number;
  negative_feedback_count: number;
}

export interface ThreadListFilters {
  channel?: ThreadChannel;
  user_id?: string;
  flagged_only?: boolean;
  unreviewed_only?: boolean;
  has_feedback?: boolean;
  has_user_feedback?: boolean;
  min_messages?: number;
  since?: Date;
  limit?: number;
  offset?: number;
  // Search filters
  search_text?: string;
  tool_name?: string;
  user_search?: string;
}

export type RatingSource = 'user' | 'admin';

export interface MessageFeedback {
  rating: number;
  rating_category?: string;
  rating_notes?: string;
  feedback_tags?: string[];
  improvement_suggestion?: string;
  rated_by: string;
  rating_source: RatingSource;
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
      [threadId, title.slice(0, 500)]
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
   * Merge keys into a thread's context JSONB (top-level merge, not deep)
   */
  async patchThreadContext(threadId: string, patch: Record<string, unknown>): Promise<void> {
    await query(
      `UPDATE addie_threads SET context = COALESCE(context, '{}'::jsonb) || $2::jsonb, updated_at = NOW() WHERE thread_id = $1`,
      [threadId, JSON.stringify(patch)]
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

  /**
   * Mark a thread's originating Slack message as deleted.
   * The thread remains visible in admin for auditing.
   * Returns true if a thread was found and flagged.
   */
  async markSlackDeleted(channel: ThreadChannel, externalId: string): Promise<boolean> {
    const result = await query(
      `UPDATE addie_threads
         SET slack_deleted = TRUE, updated_at = NOW()
         WHERE channel = $1 AND external_id = $2 AND slack_deleted = FALSE`,
      [channel, externalId]
    );
    return (result.rowCount ?? 0) > 0;
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

      // Insert message with enhanced execution metadata
      const result = await client.query<ThreadMessage>(
        `INSERT INTO addie_thread_messages (
          thread_id, role, content, content_sanitized, tools_used, tool_calls,
          knowledge_ids, model, latency_ms, tokens_input, tokens_output,
          flagged, flag_reason, sequence_number,
          timing_system_prompt_ms, timing_total_llm_ms, timing_total_tool_ms,
          processing_iterations, tokens_cache_creation, tokens_cache_read, active_rule_ids,
          router_decision, config_version_id, email_message_id,
          user_id, user_display_name, message_source
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27)
        RETURNING *`,
        [
          input.thread_id,
          input.role,
          stripNullBytesString(input.content),
          input.content_sanitized != null ? stripNullBytesString(input.content_sanitized) : null,
          input.tools_used ? input.tools_used.map(stripNullBytesString) : null,
          input.tool_calls ? stripNullBytesFromJson(JSON.stringify(input.tool_calls)) : null,
          input.knowledge_ids ?? null,
          input.model ?? null,
          input.latency_ms ?? null,
          input.tokens_input ?? null,
          input.tokens_output ?? null,
          input.flagged ?? false,
          input.flag_reason != null ? stripNullBytesString(input.flag_reason) : null,
          sequenceNumber,
          input.timing?.system_prompt_ms ?? null,
          input.timing?.total_llm_ms ?? null,
          input.timing?.total_tool_ms ?? null,
          input.timing?.iterations ?? null,
          input.tokens_cache_creation ?? null,
          input.tokens_cache_read ?? null,
          input.active_rule_ids ?? null,
          input.router_decision ? stripNullBytesFromJson(JSON.stringify(input.router_decision)) : null,
          input.config_version_id ?? null,
          input.email_message_id != null ? stripNullBytesString(input.email_message_id) : null,
          input.user_id ?? null,
          input.user_display_name != null ? stripNullBytesString(input.user_display_name) : null,
          input.message_source ?? null,
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
   * Find a thread by looking up an email Message-ID in thread messages.
   * Used to link inbound email replies to existing conversations.
   */
  async findThreadByEmailMessageId(emailMessageId: string): Promise<Thread | null> {
    const result = await query<Thread>(
      `SELECT t.* FROM addie_threads t
       JOIN addie_thread_messages m ON m.thread_id = t.thread_id
       WHERE m.email_message_id = $1
       LIMIT 1`,
      [emailMessageId]
    );
    return result.rows[0] || null;
  }

  /**
   * Find the most recent email thread for a sender with the same subject.
   * Fallback when In-Reply-To header doesn't match any stored message IDs.
   * Requires subject match to avoid mixing unrelated conversations.
   */
  async findRecentEmailThread(senderIdentifier: string, subject: string, withinDays: number = 2): Promise<Thread | null> {
    const result = await query<Thread>(
      `SELECT * FROM addie_threads
       WHERE channel = 'email'
         AND user_id = $1
         AND last_message_at > NOW() - INTERVAL '1 day' * $2
         AND title = $3
       ORDER BY last_message_at DESC
       LIMIT 1`,
      [senderIdentifier, withinDays, subject]
    );
    return result.rows[0] || null;
  }

  /**
   * Count recent email messages from a sender within a time window.
   * Used for rate limiting email conversations.
   */
  async countRecentEmailMessages(senderEmail: string, withinHours: number = 1): Promise<number> {
    const result = await query<{ count: string }>(
      `SELECT COUNT(*) as count FROM addie_thread_messages m
       JOIN addie_threads t ON t.thread_id = m.thread_id
       WHERE t.channel = 'email'
         AND t.user_id = $1
         AND m.role = 'user'
         AND m.created_at > NOW() - INTERVAL '1 hour' * $2`,
      [senderEmail, withinHours]
    );
    return parseInt(result.rows[0]?.count || '0', 10);
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
  ): Promise<boolean> {
    const result = await query(
      `UPDATE addie_thread_messages
       SET
         rating = $2,
         rating_category = $3,
         rating_notes = $4,
         feedback_tags = $5,
         improvement_suggestion = $6,
         rated_by = $7,
         rating_source = $8,
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
        feedback.rating_source,
      ]
    );
    return result.rowCount !== null && result.rowCount > 0;
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

    // Determine if we need to join with messages table for search/tool filtering
    const needsMessageJoin = !!(filters.search_text || filters.tool_name);

    // user_search matches across all identifiers an admin might describe a
    // person by — full name, Slack handle, real name, WorkOS first/last
    // name, or any of the email addresses we know about. Without these
    // joins, harmonizing thread.user_display_name to "Brian O'Kelley"
    // would orphan admins searching by Slack handle "bokelley".
    const needsUserSearchJoins = !!filters.user_search;

    if (filters.channel) {
      conditions.push(`s.channel = $${paramIndex++}`);
      params.push(filters.channel);
    }

    if (filters.user_id) {
      conditions.push(`s.user_id = $${paramIndex++}`);
      params.push(filters.user_id);
    }

    if (filters.flagged_only) {
      conditions.push(`s.flagged = TRUE`);
    }

    if (filters.unreviewed_only) {
      conditions.push(`s.reviewed = FALSE`);
    }

    if (filters.has_feedback) {
      conditions.push(`s.feedback_count > 0`);
    }

    if (filters.has_user_feedback) {
      conditions.push(`s.user_feedback_count > 0`);
    }

    if (filters.min_messages !== undefined && filters.min_messages > 0) {
      conditions.push(`s.message_count >= $${paramIndex++}`);
      params.push(filters.min_messages);
    }

    if (filters.since) {
      conditions.push(`s.started_at >= $${paramIndex++}`);
      params.push(filters.since);
    }

    // Cross-identifier user search: match the term against every name and
    // email we have for the thread's owner — thread display name, raw
    // user_id (which carries the email for email threads), Slack mapping
    // fields (handle/real name/Slack email), and WorkOS profile fields
    // (email/first/last). The `sm.*` and `u.*` aliases below are valid
    // only because `needsUserSearchJoins` adds the matching LEFT JOINs
    // when this filter is set — keep the two in lockstep.
    if (filters.user_search) {
      const idx = paramIndex++;
      conditions.push(`(
        s.user_display_name ILIKE $${idx} OR
        s.user_id ILIKE $${idx} OR
        sm.slack_display_name ILIKE $${idx} OR
        sm.slack_real_name ILIKE $${idx} OR
        sm.slack_email ILIKE $${idx} OR
        u.email ILIKE $${idx} OR
        u.first_name ILIKE $${idx} OR
        u.last_name ILIKE $${idx}
      )`);
      params.push(`%${filters.user_search}%`);
    }

    // Text search in message content (requires join)
    if (filters.search_text) {
      conditions.push(`m.content ILIKE $${paramIndex++}`);
      params.push(`%${filters.search_text}%`);
    }

    // Tool name filter (requires join, searches tools_used array)
    if (filters.tool_name) {
      conditions.push(`$${paramIndex++} = ANY(m.tools_used)`);
      params.push(filters.tool_name);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = filters.limit || 50;
    const offset = filters.offset || 0;

    params.push(limit, offset);

    // User-search joins: slack_user_mappings keys off the Slack thread's
    // user_id; users keys off the WorkOS id (either the thread's own
    // user_id when user_type='workos', or the WorkOS id resolved through
    // the Slack mapping). Both are LEFT JOINs so threads without a
    // matching row simply contribute NULLs and fall out of the OR match.
    const userSearchJoins = needsUserSearchJoins
      ? `LEFT JOIN slack_user_mappings sm ON sm.slack_user_id = s.user_id
         LEFT JOIN users u ON u.workos_user_id = COALESCE(
           sm.workos_user_id,
           CASE WHEN s.user_type = 'workos' THEN s.user_id END
         )`
      : '';

    let sql: string;
    if (needsMessageJoin) {
      // Join with messages table for text/tool search, use DISTINCT to avoid duplicates
      sql = `SELECT DISTINCT ON (s.last_message_at, s.thread_id) s.*
             FROM addie_threads_summary s
             ${userSearchJoins}
             JOIN addie_thread_messages m ON s.thread_id = m.thread_id
             ${whereClause}
             ORDER BY s.last_message_at DESC, s.thread_id
             LIMIT $${paramIndex++} OFFSET $${paramIndex}`;
    } else {
      // Simple query without join
      sql = `SELECT s.*
             FROM addie_threads_summary s
             ${userSearchJoins}
             ${whereClause}
             ORDER BY s.last_message_at DESC
             LIMIT $${paramIndex++} OFFSET $${paramIndex}`;
    }

    const result = await query<ThreadSummary>(sql, params);
    return result.rows;
  }

  /**
   * Get list of distinct tool names used across all threads
   */
  async getAvailableTools(): Promise<string[]> {
    const result = await query<{ tool_name: string }>(
      `SELECT DISTINCT unnest(tools_used) as tool_name
       FROM addie_thread_messages
       WHERE tools_used IS NOT NULL AND array_length(tools_used, 1) > 0
       ORDER BY tool_name`
    );
    return result.rows.map(r => r.tool_name);
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
   * Get threads for a user across all channels (web + linked Slack)
   * This fetches both the user's web threads and any threads from their linked Slack account
   */
  async getUserCrossChannelThreads(
    workosUserId: string,
    slackUserId: string | null,
    limit = 20
  ): Promise<ThreadSummary[]> {
    if (slackUserId) {
      // User has linked Slack - fetch threads from both channels
      const result = await query<ThreadSummary>(
        `SELECT * FROM addie_threads_summary
         WHERE (user_type = 'workos' AND user_id = $1)
            OR (user_type = 'slack' AND user_id = $2)
         ORDER BY last_message_at DESC
         LIMIT $3`,
        [workosUserId, slackUserId, limit]
      );
      return result.rows;
    } else {
      // No linked Slack - just return web threads
      return this.getUserThreads(workosUserId, 'workos', limit);
    }
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
         AND last_message_at > NOW() - make_interval(mins => $3)
       ORDER BY last_message_at DESC
       LIMIT 1`,
      [userType, userId, maxAgeMinutes]
    );
    return result.rows[0] || null;
  }

  /**
   * Get activity stats for a specific user (messages and active days in last 30 days)
   * Combines activity across all channels (Slack and web chat)
   */
  async getUserActivityStats(
    userId: string,
    userType: UserType,
    days = 30
  ): Promise<{
    total_messages: number;
    active_days: number;
    last_activity_at: Date | null;
  }> {
    const result = await query<{
      total_messages: string;
      active_days: string;
      last_activity_at: Date | null;
    }>(
      `SELECT
        COALESCE(SUM(message_count), 0)::text as total_messages,
        COUNT(DISTINCT DATE(last_message_at))::text as active_days,
        MAX(last_message_at) as last_activity_at
       FROM addie_threads
       WHERE user_type = $1 AND user_id = $2
         AND last_message_at >= NOW() - make_interval(days => $3)`,
      [userType, userId, days]
    );

    const row = result.rows[0];
    return {
      total_messages: parseInt(row?.total_messages || '0', 10),
      active_days: parseInt(row?.active_days || '0', 10),
      last_activity_at: row?.last_activity_at || null,
    };
  }

  // =====================================================
  // STATISTICS
  // =====================================================

  /**
   * Get stats by channel (optionally filtered by timeframe)
   * @param timeframe - '24h', '7d', '30d', or 'all'
   */
  async getChannelStats(timeframe: '24h' | '7d' | '30d' | 'all' = 'all'): Promise<ChannelStats[]> {
    // For 'all', use the view which has pre-computed stats
    if (timeframe === 'all') {
      const result = await query<ChannelStats>(
        `SELECT * FROM addie_channel_stats`
      );
      return result.rows;
    }

    // Use explicit SQL for each timeframe to avoid string interpolation (security)
    const baseQuery = `SELECT
        channel,
        COUNT(DISTINCT thread_id) as total_threads,
        COUNT(DISTINCT user_id) as unique_users,
        SUM(message_count) as total_messages,
        COUNT(*) FILTER (WHERE flagged) as flagged_threads,
        COUNT(*) FILTER (WHERE reviewed) as reviewed_threads,
        COUNT(*) FILTER (WHERE started_at > NOW() - INTERVAL '24 hours') as threads_last_24h,
        COUNT(*) FILTER (WHERE started_at > NOW() - INTERVAL '7 days') as threads_last_7d
      FROM addie_threads`;

    let result;
    if (timeframe === '24h') {
      result = await query<ChannelStats>(`${baseQuery} WHERE started_at > NOW() - INTERVAL '24 hours' GROUP BY channel`);
    } else if (timeframe === '7d') {
      result = await query<ChannelStats>(`${baseQuery} WHERE started_at > NOW() - INTERVAL '7 days' GROUP BY channel`);
    } else {
      // 30d
      result = await query<ChannelStats>(`${baseQuery} WHERE started_at > NOW() - INTERVAL '30 days' GROUP BY channel`);
    }
    return result.rows;
  }

  /**
   * Get overall stats (optionally filtered by timeframe)
   * @param timeframe - '24h', '7d', '30d', or 'all'
   */
  async getStats(timeframe: '24h' | '7d' | '30d' | 'all' = 'all'): Promise<{
    total_threads: number;
    total_messages: number;
    unique_users: number;
    avg_messages_per_thread: number;
    threads_last_24h: number;
    threads_30d: number;
    messages_30d: number;
    flagged_threads: number;
    unreviewed_threads: number;
    avg_rating: number | null;
    avg_latency_ms: number | null;
    total_input_tokens: number;
    total_output_tokens: number;
  }> {
    // Use explicit SQL for each timeframe to avoid string interpolation (security)
    type StatsRow = {
      total_threads: string;
      total_messages: string;
      unique_users: string;
      avg_messages_per_thread: string;
      threads_last_24h: string;
      threads_30d: string;
      messages_30d: string;
      flagged_threads: string;
      unreviewed_threads: string;
      avg_rating: string | null;
      avg_latency_ms: string | null;
      total_input_tokens: string;
      total_output_tokens: string;
    };

    // Build query based on timeframe - using explicit SQL to avoid injection
    let result;
    if (timeframe === 'all') {
      result = await query<StatsRow>(
        `SELECT
          COUNT(DISTINCT t.thread_id) as total_threads,
          (SELECT COUNT(*) FROM addie_thread_messages) as total_messages,
          COUNT(DISTINCT t.user_id) FILTER (WHERE t.user_id IS NOT NULL) as unique_users,
          ROUND(AVG(t.message_count)::numeric, 1) as avg_messages_per_thread,
          COUNT(*) FILTER (WHERE t.started_at > NOW() - INTERVAL '24 hours') as threads_last_24h,
          COUNT(*) FILTER (WHERE t.started_at > NOW() - INTERVAL '30 days') as threads_30d,
          (SELECT COUNT(*) FROM addie_thread_messages WHERE created_at > NOW() - INTERVAL '30 days') as messages_30d,
          COUNT(*) FILTER (WHERE t.flagged) as flagged_threads,
          COUNT(*) FILTER (WHERE NOT t.reviewed) as unreviewed_threads,
          (SELECT ROUND(AVG(rating)::numeric, 2) FROM addie_thread_messages WHERE rating IS NOT NULL) as avg_rating,
          (SELECT ROUND(AVG(latency_ms)::numeric, 0) FROM addie_thread_messages WHERE latency_ms IS NOT NULL) as avg_latency_ms,
          (SELECT COALESCE(SUM(tokens_input), 0) FROM addie_thread_messages WHERE tokens_input IS NOT NULL) as total_input_tokens,
          (SELECT COALESCE(SUM(tokens_output), 0) FROM addie_thread_messages WHERE tokens_output IS NOT NULL) as total_output_tokens
        FROM addie_threads t`
      );
    } else if (timeframe === '24h') {
      result = await query<StatsRow>(
        `SELECT
          COUNT(DISTINCT t.thread_id) as total_threads,
          (SELECT COUNT(*) FROM addie_thread_messages m WHERE m.created_at > NOW() - INTERVAL '24 hours') as total_messages,
          COUNT(DISTINCT t.user_id) FILTER (WHERE t.user_id IS NOT NULL) as unique_users,
          ROUND(AVG(t.message_count)::numeric, 1) as avg_messages_per_thread,
          COUNT(*) FILTER (WHERE t.started_at > NOW() - INTERVAL '24 hours') as threads_last_24h,
          COUNT(*) FILTER (WHERE t.started_at > NOW() - INTERVAL '30 days') as threads_30d,
          (SELECT COUNT(*) FROM addie_thread_messages WHERE created_at > NOW() - INTERVAL '30 days') as messages_30d,
          COUNT(*) FILTER (WHERE t.flagged) as flagged_threads,
          COUNT(*) FILTER (WHERE NOT t.reviewed) as unreviewed_threads,
          (SELECT ROUND(AVG(rating)::numeric, 2) FROM addie_thread_messages m WHERE m.created_at > NOW() - INTERVAL '24 hours' AND rating IS NOT NULL) as avg_rating,
          (SELECT ROUND(AVG(latency_ms)::numeric, 0) FROM addie_thread_messages m WHERE m.created_at > NOW() - INTERVAL '24 hours' AND latency_ms IS NOT NULL) as avg_latency_ms,
          (SELECT COALESCE(SUM(tokens_input), 0) FROM addie_thread_messages m WHERE m.created_at > NOW() - INTERVAL '24 hours' AND tokens_input IS NOT NULL) as total_input_tokens,
          (SELECT COALESCE(SUM(tokens_output), 0) FROM addie_thread_messages m WHERE m.created_at > NOW() - INTERVAL '24 hours' AND tokens_output IS NOT NULL) as total_output_tokens
        FROM addie_threads t WHERE t.started_at > NOW() - INTERVAL '24 hours'`
      );
    } else if (timeframe === '7d') {
      result = await query<StatsRow>(
        `SELECT
          COUNT(DISTINCT t.thread_id) as total_threads,
          (SELECT COUNT(*) FROM addie_thread_messages m WHERE m.created_at > NOW() - INTERVAL '7 days') as total_messages,
          COUNT(DISTINCT t.user_id) FILTER (WHERE t.user_id IS NOT NULL) as unique_users,
          ROUND(AVG(t.message_count)::numeric, 1) as avg_messages_per_thread,
          COUNT(*) FILTER (WHERE t.started_at > NOW() - INTERVAL '24 hours') as threads_last_24h,
          COUNT(*) FILTER (WHERE t.started_at > NOW() - INTERVAL '30 days') as threads_30d,
          (SELECT COUNT(*) FROM addie_thread_messages WHERE created_at > NOW() - INTERVAL '30 days') as messages_30d,
          COUNT(*) FILTER (WHERE t.flagged) as flagged_threads,
          COUNT(*) FILTER (WHERE NOT t.reviewed) as unreviewed_threads,
          (SELECT ROUND(AVG(rating)::numeric, 2) FROM addie_thread_messages m WHERE m.created_at > NOW() - INTERVAL '7 days' AND rating IS NOT NULL) as avg_rating,
          (SELECT ROUND(AVG(latency_ms)::numeric, 0) FROM addie_thread_messages m WHERE m.created_at > NOW() - INTERVAL '7 days' AND latency_ms IS NOT NULL) as avg_latency_ms,
          (SELECT COALESCE(SUM(tokens_input), 0) FROM addie_thread_messages m WHERE m.created_at > NOW() - INTERVAL '7 days' AND tokens_input IS NOT NULL) as total_input_tokens,
          (SELECT COALESCE(SUM(tokens_output), 0) FROM addie_thread_messages m WHERE m.created_at > NOW() - INTERVAL '7 days' AND tokens_output IS NOT NULL) as total_output_tokens
        FROM addie_threads t WHERE t.started_at > NOW() - INTERVAL '7 days'`
      );
    } else {
      // 30d
      result = await query<StatsRow>(
        `SELECT
          COUNT(DISTINCT t.thread_id) as total_threads,
          (SELECT COUNT(*) FROM addie_thread_messages m WHERE m.created_at > NOW() - INTERVAL '30 days') as total_messages,
          COUNT(DISTINCT t.user_id) FILTER (WHERE t.user_id IS NOT NULL) as unique_users,
          ROUND(AVG(t.message_count)::numeric, 1) as avg_messages_per_thread,
          COUNT(*) FILTER (WHERE t.started_at > NOW() - INTERVAL '24 hours') as threads_last_24h,
          COUNT(*) FILTER (WHERE t.started_at > NOW() - INTERVAL '30 days') as threads_30d,
          (SELECT COUNT(*) FROM addie_thread_messages WHERE created_at > NOW() - INTERVAL '30 days') as messages_30d,
          COUNT(*) FILTER (WHERE t.flagged) as flagged_threads,
          COUNT(*) FILTER (WHERE NOT t.reviewed) as unreviewed_threads,
          (SELECT ROUND(AVG(rating)::numeric, 2) FROM addie_thread_messages m WHERE m.created_at > NOW() - INTERVAL '30 days' AND rating IS NOT NULL) as avg_rating,
          (SELECT ROUND(AVG(latency_ms)::numeric, 0) FROM addie_thread_messages m WHERE m.created_at > NOW() - INTERVAL '30 days' AND latency_ms IS NOT NULL) as avg_latency_ms,
          (SELECT COALESCE(SUM(tokens_input), 0) FROM addie_thread_messages m WHERE m.created_at > NOW() - INTERVAL '30 days' AND tokens_input IS NOT NULL) as total_input_tokens,
          (SELECT COALESCE(SUM(tokens_output), 0) FROM addie_thread_messages m WHERE m.created_at > NOW() - INTERVAL '30 days' AND tokens_output IS NOT NULL) as total_output_tokens
        FROM addie_threads t WHERE t.started_at > NOW() - INTERVAL '30 days'`
      );
    }

    const row = result.rows[0];
    return {
      total_threads: parseInt(row.total_threads, 10) || 0,
      total_messages: parseInt(row.total_messages, 10) || 0,
      unique_users: parseInt(row.unique_users, 10) || 0,
      avg_messages_per_thread: parseFloat(row.avg_messages_per_thread) || 0,
      threads_last_24h: parseInt(row.threads_last_24h, 10) || 0,
      threads_30d: parseInt(row.threads_30d, 10) || 0,
      messages_30d: parseInt(row.messages_30d, 10) || 0,
      flagged_threads: parseInt(row.flagged_threads, 10) || 0,
      unreviewed_threads: parseInt(row.unreviewed_threads, 10) || 0,
      avg_rating: row.avg_rating ? parseFloat(row.avg_rating) : null,
      avg_latency_ms: row.avg_latency_ms ? parseInt(row.avg_latency_ms, 10) : null,
      total_input_tokens: parseInt(row.total_input_tokens, 10) || 0,
      total_output_tokens: parseInt(row.total_output_tokens, 10) || 0,
    };
  }

  // =====================================================
  // PERFORMANCE METRICS
  // =====================================================

  /**
   * Get performance metrics including per-tool timing
   * @param hours - Number of hours to look back (default 168 = 7 days)
   */
  async getPerformanceMetrics(hours = 168): Promise<{
    period_hours: number;
    summary: {
      total_messages: number;
      total_assistant_messages: number;
      avg_latency_ms: number | null;
      p50_latency_ms: number | null;
      p95_latency_ms: number | null;
      max_latency_ms: number | null;
      total_input_tokens: number;
      total_output_tokens: number;
      avg_input_tokens: number | null;
      avg_output_tokens: number | null;
    };
    latency_distribution: Array<{
      bucket: string;
      count: number;
    }>;
    by_model: Array<{
      model: string;
      count: number;
      avg_latency_ms: number;
      p50_latency_ms: number | null;
      total_input_tokens: number;
      total_output_tokens: number;
    }>;
    by_tool: Array<{
      tool_name: string;
      call_count: number;
      avg_duration_ms: number | null;
      p50_duration_ms: number | null;
      p95_duration_ms: number | null;
      error_count: number;
    }>;
    by_channel: Array<{
      channel: string;
      message_count: number;
      avg_latency_ms: number | null;
    }>;
    daily_trend: Array<{
      date: string;
      message_count: number;
      avg_latency_ms: number | null;
      total_tokens: number;
    }>;
  }> {
    // Summary stats
    const summaryResult = await query<{
      total_messages: string;
      total_assistant_messages: string;
      avg_latency_ms: string | null;
      p50_latency_ms: string | null;
      p95_latency_ms: string | null;
      max_latency_ms: string | null;
      total_input_tokens: string;
      total_output_tokens: string;
      avg_input_tokens: string | null;
      avg_output_tokens: string | null;
    }>(
      `SELECT
        COUNT(*) as total_messages,
        COUNT(*) FILTER (WHERE role = 'assistant') as total_assistant_messages,
        ROUND((AVG(latency_ms) FILTER (WHERE role = 'assistant'))::numeric, 0) as avg_latency_ms,
        ROUND((PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY latency_ms) FILTER (WHERE role = 'assistant'))::numeric, 0) as p50_latency_ms,
        ROUND((PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY latency_ms) FILTER (WHERE role = 'assistant'))::numeric, 0) as p95_latency_ms,
        MAX(latency_ms) FILTER (WHERE role = 'assistant') as max_latency_ms,
        COALESCE(SUM(tokens_input), 0) as total_input_tokens,
        COALESCE(SUM(tokens_output), 0) as total_output_tokens,
        ROUND((AVG(tokens_input) FILTER (WHERE tokens_input IS NOT NULL))::numeric, 0) as avg_input_tokens,
        ROUND((AVG(tokens_output) FILTER (WHERE tokens_output IS NOT NULL))::numeric, 0) as avg_output_tokens
      FROM addie_thread_messages
      WHERE created_at > NOW() - make_interval(hours => $1)`,
      [hours]
    );

    // Latency distribution (includes background API calls)
    const latencyResult = await query<{ bucket: string; count: string }>(
      `WITH all_api_calls AS (
        -- Chat responses from thread messages
        SELECT latency_ms
        FROM addie_thread_messages
        WHERE role = 'assistant'
          AND latency_ms IS NOT NULL
          AND created_at > NOW() - make_interval(hours => $1)
        UNION ALL
        -- Background API calls (router, insight extraction, etc.)
        SELECT latency_ms
        FROM addie_api_calls
        WHERE latency_ms IS NOT NULL
          AND created_at > NOW() - make_interval(hours => $1)
      )
      SELECT
        CASE
          WHEN latency_ms < 5000 THEN '0-5s'
          WHEN latency_ms < 10000 THEN '5-10s'
          WHEN latency_ms < 20000 THEN '10-20s'
          WHEN latency_ms < 30000 THEN '20-30s'
          WHEN latency_ms < 45000 THEN '30-45s'
          ELSE '45s+'
        END as bucket,
        COUNT(*) as count
      FROM all_api_calls
      GROUP BY 1
      ORDER BY MIN(latency_ms)`,
      [hours]
    );

    // By model (combines thread messages + background API calls)
    const modelResult = await query<{
      model: string;
      count: string;
      avg_latency_ms: string;
      p50_latency_ms: string | null;
      total_input_tokens: string;
      total_output_tokens: string;
    }>(
      `WITH all_api_calls AS (
        -- Chat responses from thread messages
        SELECT model, latency_ms, tokens_input, tokens_output
        FROM addie_thread_messages
        WHERE role = 'assistant'
          AND created_at > NOW() - make_interval(hours => $1)
        UNION ALL
        -- Background API calls (router, insight extraction, etc.)
        SELECT model, latency_ms, tokens_input, tokens_output
        FROM addie_api_calls
        WHERE created_at > NOW() - make_interval(hours => $1)
      )
      SELECT
        COALESCE(model, 'unknown') as model,
        COUNT(*) as count,
        ROUND((AVG(latency_ms))::numeric, 0) as avg_latency_ms,
        ROUND((PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY latency_ms))::numeric, 0) as p50_latency_ms,
        COALESCE(SUM(tokens_input), 0) as total_input_tokens,
        COALESCE(SUM(tokens_output), 0) as total_output_tokens
      FROM all_api_calls
      GROUP BY model
      ORDER BY count DESC`,
      [hours]
    );

    // By tool (using JSONB)
    const toolResult = await query<{
      tool_name: string;
      call_count: string;
      avg_duration_ms: string | null;
      p50_duration_ms: string | null;
      p95_duration_ms: string | null;
      error_count: string;
    }>(
      `WITH tool_calls AS (
        SELECT
          jsonb_array_elements(tool_calls) as tool
        FROM addie_thread_messages
        WHERE tool_calls IS NOT NULL
          AND tool_calls != '[]'::jsonb
          AND created_at > NOW() - make_interval(hours => $1)
      )
      SELECT
        tool->>'name' as tool_name,
        COUNT(*) as call_count,
        ROUND((AVG((tool->>'duration_ms')::numeric))::numeric, 0) as avg_duration_ms,
        ROUND((PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY (tool->>'duration_ms')::numeric))::numeric, 0) as p50_duration_ms,
        ROUND((PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY (tool->>'duration_ms')::numeric))::numeric, 0) as p95_duration_ms,
        COUNT(*) FILTER (WHERE tool->>'is_error' = 'true') as error_count
      FROM tool_calls
      GROUP BY tool->>'name'
      ORDER BY call_count DESC`,
      [hours]
    );

    // By channel (with timing breakdown to explain latency differences)
    const channelResult = await query<{
      channel: string;
      message_count: string;
      avg_latency_ms: string | null;
      avg_llm_ms: string | null;
      avg_tool_ms: string | null;
      avg_iterations: string | null;
    }>(
      `SELECT
        t.channel,
        COUNT(m.message_id) as message_count,
        ROUND((AVG(m.latency_ms) FILTER (WHERE m.role = 'assistant'))::numeric, 0) as avg_latency_ms,
        ROUND((AVG(m.timing_total_llm_ms) FILTER (WHERE m.role = 'assistant'))::numeric, 0) as avg_llm_ms,
        ROUND((AVG(m.timing_total_tool_ms) FILTER (WHERE m.role = 'assistant'))::numeric, 0) as avg_tool_ms,
        ROUND((AVG(m.processing_iterations) FILTER (WHERE m.role = 'assistant'))::numeric, 1) as avg_iterations
      FROM addie_threads t
      JOIN addie_thread_messages m ON t.thread_id = m.thread_id
      WHERE m.created_at > NOW() - make_interval(hours => $1)
      GROUP BY t.channel
      ORDER BY message_count DESC`,
      [hours]
    );

    // Daily trend
    const dailyResult = await query<{
      date: string;
      message_count: string;
      avg_latency_ms: string | null;
      total_tokens: string;
    }>(
      `SELECT
        DATE_TRUNC('day', created_at)::date::text as date,
        COUNT(*) as message_count,
        ROUND((AVG(latency_ms) FILTER (WHERE role = 'assistant'))::numeric, 0) as avg_latency_ms,
        COALESCE(SUM(tokens_input), 0) + COALESCE(SUM(tokens_output), 0) as total_tokens
      FROM addie_thread_messages
      WHERE created_at > NOW() - make_interval(hours => $1)
      GROUP BY DATE_TRUNC('day', created_at)
      ORDER BY date DESC`,
      [hours]
    );

    const summary = summaryResult.rows[0];

    return {
      period_hours: hours,
      summary: {
        total_messages: parseInt(summary.total_messages, 10) || 0,
        total_assistant_messages: parseInt(summary.total_assistant_messages, 10) || 0,
        avg_latency_ms: summary.avg_latency_ms ? parseInt(summary.avg_latency_ms, 10) : null,
        p50_latency_ms: summary.p50_latency_ms ? parseInt(summary.p50_latency_ms, 10) : null,
        p95_latency_ms: summary.p95_latency_ms ? parseInt(summary.p95_latency_ms, 10) : null,
        max_latency_ms: summary.max_latency_ms ? parseInt(summary.max_latency_ms, 10) : null,
        total_input_tokens: parseInt(summary.total_input_tokens, 10) || 0,
        total_output_tokens: parseInt(summary.total_output_tokens, 10) || 0,
        avg_input_tokens: summary.avg_input_tokens ? parseInt(summary.avg_input_tokens, 10) : null,
        avg_output_tokens: summary.avg_output_tokens ? parseInt(summary.avg_output_tokens, 10) : null,
      },
      latency_distribution: latencyResult.rows.map(r => ({
        bucket: r.bucket,
        count: parseInt(r.count, 10) || 0,
      })),
      by_model: modelResult.rows.map(r => ({
        model: r.model,
        count: parseInt(r.count, 10) || 0,
        avg_latency_ms: parseInt(r.avg_latency_ms, 10) || 0,
        p50_latency_ms: r.p50_latency_ms ? parseInt(r.p50_latency_ms, 10) : null,
        total_input_tokens: parseInt(r.total_input_tokens, 10) || 0,
        total_output_tokens: parseInt(r.total_output_tokens, 10) || 0,
      })),
      by_tool: toolResult.rows.map(r => ({
        tool_name: r.tool_name,
        call_count: parseInt(r.call_count, 10) || 0,
        avg_duration_ms: r.avg_duration_ms ? parseInt(r.avg_duration_ms, 10) : null,
        p50_duration_ms: r.p50_duration_ms ? parseInt(r.p50_duration_ms, 10) : null,
        p95_duration_ms: r.p95_duration_ms ? parseInt(r.p95_duration_ms, 10) : null,
        error_count: parseInt(r.error_count, 10) || 0,
      })),
      by_channel: channelResult.rows.map(r => ({
        channel: r.channel,
        message_count: parseInt(r.message_count, 10) || 0,
        avg_latency_ms: r.avg_latency_ms ? parseInt(r.avg_latency_ms, 10) : null,
        avg_llm_ms: r.avg_llm_ms ? parseInt(r.avg_llm_ms, 10) : null,
        avg_tool_ms: r.avg_tool_ms ? parseInt(r.avg_tool_ms, 10) : null,
        avg_iterations: r.avg_iterations ? parseFloat(r.avg_iterations) : null,
      })),
      daily_trend: dailyResult.rows.map(r => ({
        date: r.date,
        message_count: parseInt(r.message_count, 10) || 0,
        avg_latency_ms: r.avg_latency_ms ? parseInt(r.avg_latency_ms, 10) : null,
        total_tokens: parseInt(r.total_tokens, 10) || 0,
      })),
    };
  }

  // =====================================================
  // PERSON RELATIONSHIP THREADS
  // =====================================================

  /**
   * Get all threads linked to a person
   */
  async getPersonThreads(personId: string, limit = 50): Promise<Thread[]> {
    const result = await query<Thread>(
      `SELECT * FROM addie_threads
       WHERE person_id = $1
       ORDER BY last_message_at DESC
       LIMIT $2`,
      [personId, limit]
    );
    return result.rows;
  }

  /**
   * Link an existing thread to a person
   */
  async linkThreadToPerson(threadId: string, personId: string): Promise<void> {
    await query(
      `UPDATE addie_threads SET person_id = $1, updated_at = NOW() WHERE thread_id = $2`,
      [personId, threadId]
    );
  }

  /**
   * Get recent messages across all threads for a person
   */
  async getPersonRecentMessages(personId: string, limit = 30): Promise<ThreadMessage[]> {
    const result = await query<ThreadMessage>(
      `SELECT m.* FROM addie_thread_messages m
       JOIN addie_threads t ON t.thread_id = m.thread_id
       WHERE t.person_id = $1
       ORDER BY m.created_at DESC
       LIMIT $2`,
      [personId, limit]
    );
    return result.rows;
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
         AND updated_at < NOW() - make_interval(days => $1)`,
      [olderThanDays]
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
