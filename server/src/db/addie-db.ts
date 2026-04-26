import { query, getClient } from './client.js';
import type { AddieInteractionLog } from '../addie/types.js';

/**
 * Database row type for addie_interactions
 * Maps to the AddieInteractionLog type for application use
 */
interface AddieInteractionRow {
  id: string;
  event_type: string;
  channel_id: string;
  thread_ts: string | null;
  user_id: string;
  input_text: string;
  input_sanitized: string;
  output_text: string;
  tools_used: string[];
  knowledge_ids: number[] | null;
  model: string;
  latency_ms: number;
  flagged: boolean;
  flag_reason: string | null;
  reviewed: boolean;
  reviewed_by: string | null;
  reviewed_at: Date | null;
  created_at: Date;
}

/**
 * Types for Addie database operations
 */
export interface AddieKnowledge {
  id: number;
  title: string;
  category: string;
  source_url: string | null;
  content: string;
  is_active: boolean;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
  // Slack-specific fields
  source_type: string;
  slack_channel_id: string | null;
  slack_channel_name: string | null;
  slack_user_id: string | null;
  slack_username: string | null;
  slack_ts: string | null;
  slack_permalink: string | null;
  // Curated content fields
  fetch_url: string | null;
  last_fetched_at: Date | null;
  fetch_status: string | null;
  summary: string | null;
  key_insights: KeyInsight[] | null;
  addie_notes: string | null;
  relevance_tags: string[] | null;
  quality_score: number | null;
  discovery_source: string | null;
  discovery_context: Record<string, unknown> | null;
}

export interface KeyInsight {
  insight: string;
  importance: 'high' | 'medium' | 'low';
}

export interface AddieKnowledgeInput {
  title: string;
  category: string;
  content: string;
  source_url?: string;
  created_by?: string;
}

export interface SlackMessageInput {
  channel_id: string;
  channel_name: string;
  user_id: string;
  username: string;
  ts: string;
  text: string;
  permalink: string;
}

export interface AddieSearchResult {
  id: number;
  title: string;
  category: string;
  source_url: string | null;
  content: string;
  rank: number;
  headline: string;
}

export interface SlackSearchResult {
  id: number;
  text: string;
  channel_name: string;
  username: string;
  permalink: string;
  rank: number;
  headline: string;
}

export interface CuratedResourceInput {
  url: string;
  title: string;
  category: string;
  discovery_source: 'perspective_publish' | 'web_search' | 'slack_link' | 'manual';
  discovery_context?: Record<string, unknown>;
  relevance_tags?: string[];
  /** Who created this resource - Slack user ID, WorkOS user ID, or 'system' */
  created_by?: string;
}

export interface CuratedResourceSearchResult {
  id: number;
  title: string;
  source_url: string;
  summary: string | null;
  addie_notes: string | null;
  relevance_tags: string[] | null;
  quality_score: number | null;
  rank: number;
  headline: string;
}

export interface RecentNewsResult {
  id: number;
  title: string;
  source_url: string;
  summary: string | null;
  addie_notes: string | null;
  relevance_tags: string[] | null;
  quality_score: number | null;
  last_fetched_at: Date;
  discovery_source: string | null;
}

export interface AddieInteractionStats {
  total: number;
  flagged: number;
  unreviewed: number;
  by_event_type: Record<string, number>;
  avg_latency_ms: number;
}

// ============== Web Conversation Types ==============

export interface WebConversationSummary {
  conversation_id: string;
  user_id: string | null;
  user_name: string | null;
  channel: string;
  message_count: number;
  last_message_at: Date;
  created_at: Date;
  // Summary of first message
  first_message_preview: string | null;
  // Indicates if there were tool uses
  has_tool_uses: boolean;
}

export interface WebConversationMessage {
  id: number;
  role: 'user' | 'assistant' | 'system';
  content: string;
  tool_use: string[] | null;
  tool_results: unknown[] | null;
  tokens_input: number | null;
  tokens_output: number | null;
  model: string | null;
  latency_ms: number | null;
  created_at: Date;
}

export interface WebConversationDetail {
  conversation_id: string;
  user_id: string | null;
  user_name: string | null;
  channel: string;
  message_count: number;
  metadata: Record<string, unknown> | null;
  created_at: Date;
  last_message_at: Date;
  messages: WebConversationMessage[];
}

export interface WebConversationStats {
  total_conversations: number;
  total_messages: number;
  avg_messages_per_conversation: number;
  conversations_last_24h: number;
  avg_latency_ms: number;
  tool_usage: Record<string, number>;
}

// ============== Rules Types ==============

export type RuleType = 'system_prompt' | 'behavior' | 'knowledge' | 'constraint' | 'response_style';

export interface AddieRule {
  id: number;
  rule_type: RuleType;
  name: string;
  description: string | null;
  content: string;
  priority: number;
  is_active: boolean;
  version: number;
  supersedes_rule_id: number | null;
  interactions_count: number;
  positive_ratings: number;
  negative_ratings: number;
  avg_rating: number | null;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface AddieRuleInput {
  rule_type: RuleType;
  name: string;
  description?: string;
  content: string;
  priority?: number;
  created_by?: string;
}

/**
 * Database operations for Addie
 */
export class AddieDatabase {
  // ============== Knowledge Management ==============

  /**
   * Create a knowledge document
   */
  async createKnowledge(input: AddieKnowledgeInput): Promise<AddieKnowledge> {
    const result = await query<AddieKnowledge>(
      `INSERT INTO addie_knowledge (title, category, content, source_url, created_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [input.title, input.category, input.content, input.source_url || null, input.created_by || null]
    );
    return result.rows[0];
  }

  /**
   * Update a knowledge document
   */
  async updateKnowledge(
    id: number,
    updates: Partial<Omit<AddieKnowledgeInput, 'created_by'>>
  ): Promise<AddieKnowledge | null> {
    const fields: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (updates.title !== undefined) {
      fields.push(`title = $${paramIndex++}`);
      values.push(updates.title);
    }
    if (updates.category !== undefined) {
      fields.push(`category = $${paramIndex++}`);
      values.push(updates.category);
    }
    if (updates.content !== undefined) {
      fields.push(`content = $${paramIndex++}`);
      values.push(updates.content);
    }
    if (updates.source_url !== undefined) {
      fields.push(`source_url = $${paramIndex++}`);
      values.push(updates.source_url);
    }

    if (fields.length === 0) {
      return this.getKnowledgeById(id);
    }

    values.push(id);
    const result = await query<AddieKnowledge>(
      `UPDATE addie_knowledge SET ${fields.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
      values
    );
    return result.rows[0] || null;
  }

  /**
   * Get a knowledge document by ID
   */
  async getKnowledgeById(id: number): Promise<AddieKnowledge | null> {
    const result = await query<AddieKnowledge>(
      'SELECT * FROM addie_knowledge WHERE id = $1',
      [id]
    );
    return result.rows[0] || null;
  }

  /**
   * List all knowledge documents
   */
  async listKnowledge(options: {
    category?: string;
    sourceType?: string;
    fetchStatus?: string;
    activeOnly?: boolean;
    limit?: number;
    offset?: number;
  } = {}): Promise<{ rows: AddieKnowledge[]; total: number }> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIndex = 1;

    if (options.category) {
      conditions.push(`category = $${paramIndex++}`);
      params.push(options.category);
    }

    if (options.sourceType) {
      conditions.push(`source_type = $${paramIndex++}`);
      params.push(options.sourceType);
    }

    if (options.fetchStatus) {
      conditions.push(`fetch_status = $${paramIndex++}`);
      params.push(options.fetchStatus);
    }

    if (options.activeOnly !== false) {
      conditions.push('is_active = TRUE');
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const limit = options.limit ?? 100;
    const offset = options.offset ?? 0;

    params.push(limit);
    const limitParam = `$${paramIndex++}`;
    params.push(offset);
    const offsetParam = `$${paramIndex++}`;

    const sql = `
      SELECT id, title, category, source_url, source_type, is_active,
        LEFT(content, 250) as content,
        fetch_url, fetch_status, last_fetched_at, summary, addie_notes,
        relevance_tags, quality_score, discovery_source,
        slack_channel_name, slack_username, slack_permalink,
        created_by, created_at, updated_at,
        COUNT(*) OVER()::int as total_count
      FROM addie_knowledge
      ${whereClause}
      ORDER BY
        CASE WHEN source_type = 'curated' AND fetch_status = 'pending' THEN 0 ELSE 1 END,
        updated_at DESC,
        category,
        title
      LIMIT ${limitParam} OFFSET ${offsetParam}
    `;

    const result = await query<AddieKnowledge & { total_count: number }>(sql, params);
    const total = result.rows[0]?.total_count ?? 0;
    return { rows: result.rows, total };
  }

  /**
   * Search knowledge using PostgreSQL full-text search
   */
  async searchKnowledge(searchQuery: string, options: {
    category?: string;
    limit?: number;
  } = {}): Promise<AddieSearchResult[]> {
    const limit = options.limit ?? 10;
    const params: unknown[] = [searchQuery, limit];
    let paramIndex = 3;

    let categoryFilter = '';
    if (options.category) {
      categoryFilter = `AND category = $${paramIndex++}`;
      params.push(options.category);
    }

    const result = await query<AddieSearchResult>(
      `SELECT
        id,
        title,
        category,
        source_url,
        content,
        ts_rank(search_vector, websearch_to_tsquery('english', $1)) as rank,
        ts_headline('english', content, websearch_to_tsquery('english', $1),
          'StartSel=**, StopSel=**, MaxWords=50, MinWords=20') as headline
       FROM addie_knowledge
       WHERE is_active = TRUE
         AND search_vector @@ websearch_to_tsquery('english', $1)
         ${categoryFilter}
       ORDER BY rank DESC
       LIMIT $2`,
      params
    );
    return result.rows;
  }

  /**
   * Activate/deactivate a knowledge document
   */
  async setKnowledgeActive(id: number, isActive: boolean): Promise<AddieKnowledge | null> {
    const result = await query<AddieKnowledge>(
      `UPDATE addie_knowledge SET is_active = $1 WHERE id = $2 RETURNING *`,
      [isActive, id]
    );
    return result.rows[0] || null;
  }

  /**
   * Delete a knowledge document
   */
  async deleteKnowledge(id: number): Promise<boolean> {
    const result = await query('DELETE FROM addie_knowledge WHERE id = $1', [id]);
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Get knowledge categories with counts
   */
  async getKnowledgeCategories(): Promise<Array<{ category: string; count: number }>> {
    const result = await query<{ category: string; count: string }>(
      `SELECT category, COUNT(*)::text as count
       FROM addie_knowledge
       WHERE is_active = TRUE
       GROUP BY category
       ORDER BY category`
    );
    return result.rows.map(row => ({
      category: row.category,
      count: parseInt(row.count, 10),
    }));
  }

  // ============== Slack Message Indexing ==============

  /**
   * Store a Slack message for local search
   * Uses upsert to avoid duplicates based on channel_id + ts
   */
  async indexSlackMessage(input: SlackMessageInput): Promise<void> {
    // Create a title from the first 100 chars of the message
    const title = input.text.substring(0, 100) + (input.text.length > 100 ? '...' : '');

    await query(
      `INSERT INTO addie_knowledge (
        title, category, content, source_url, source_type,
        slack_channel_id, slack_channel_name, slack_user_id, slack_username, slack_ts, slack_permalink,
        created_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      ON CONFLICT (slack_channel_id, slack_ts) WHERE source_type = 'slack'
      DO UPDATE SET
        content = EXCLUDED.content,
        title = EXCLUDED.title,
        slack_username = EXCLUDED.slack_username,
        updated_at = NOW()`,
      [
        title,
        'slack',
        input.text,
        input.permalink,
        'slack',
        input.channel_id,
        input.channel_name,
        input.user_id,
        input.username,
        input.ts,
        input.permalink,
        'system',
      ]
    );
  }

  /**
   * Search Slack messages stored locally using PostgreSQL full-text search
   *
   * @param accessiblePrivateChannelIds - List of private channel IDs the user has access to.
   *   If provided, results will only include public channels OR private channels in this list.
   *   If not provided (undefined), no access filtering is applied (use for internal/admin queries).
   */
  async searchSlackMessages(searchQuery: string, options: {
    limit?: number;
    channel?: string;
    accessiblePrivateChannelIds?: string[];
  } = {}): Promise<SlackSearchResult[]> {
    const limit = options.limit ?? 10;
    const channel = options.channel;
    const accessiblePrivateChannelIds = options.accessiblePrivateChannelIds;

    // Build dynamic query with optional filters
    const params: (string | number | string[])[] = [searchQuery, limit];
    let paramIndex = 3;

    // Channel name filter
    let channelFilter = '';
    if (channel) {
      channelFilter = `AND LOWER(slack_channel_name) LIKE LOWER($${paramIndex})`;
      params.push(`%${channel}%`);
      paramIndex++;
    }

    // Access control filter for private channels
    // Only include messages from:
    // 1. Public channels (those without a working group - tracked via slack_channel_id)
    // 2. Private channels the user has access to (in accessiblePrivateChannelIds)
    let accessFilter = '';
    if (accessiblePrivateChannelIds !== undefined) {
      if (accessiblePrivateChannelIds.length > 0) {
        // Include public channels (not in any working group) OR accessible private channels
        accessFilter = `AND (
          NOT EXISTS (
            SELECT 1 FROM working_groups wg
            WHERE wg.slack_channel_id = addie_knowledge.slack_channel_id
          )
          OR slack_channel_id = ANY($${paramIndex}::text[])
        )`;
        params.push(accessiblePrivateChannelIds);
      } else {
        // User has no private channel access - only show public channels
        accessFilter = `AND NOT EXISTS (
          SELECT 1 FROM working_groups wg
          WHERE wg.slack_channel_id = addie_knowledge.slack_channel_id
        )`;
      }
    }

    const result = await query<SlackSearchResult>(
      `SELECT
        id,
        content as text,
        slack_channel_name as channel_name,
        slack_username as username,
        slack_permalink as permalink,
        ts_rank(search_vector, websearch_to_tsquery('english', $1)) as rank,
        ts_headline('english', content, websearch_to_tsquery('english', $1),
          'StartSel=**, StopSel=**, MaxWords=50, MinWords=20') as headline
       FROM addie_knowledge
       WHERE is_active = TRUE
         AND source_type = 'slack'
         AND search_vector @@ websearch_to_tsquery('english', $1)
         ${channelFilter}
         ${accessFilter}
       ORDER BY rank DESC
       LIMIT $2`,
      params
    );
    return result.rows;
  }

  /**
   * Get count of indexed Slack messages
   */
  async getSlackMessageCount(): Promise<number> {
    const result = await query<{ count: string }>(
      `SELECT COUNT(*)::text as count FROM addie_knowledge WHERE source_type = 'slack' AND is_active = TRUE`
    );
    return parseInt(result.rows[0]?.count ?? '0', 10);
  }

  /**
   * Get recent messages from a channel (no keyword search, just by recency)
   * Uses the actual Slack message timestamp (slack_ts) for filtering, not the DB record creation time
   */
  async getChannelActivity(channel: string, options: {
    days?: number;
    limit?: number;
  } = {}): Promise<Array<{
    text: string;
    channel_name: string;
    username: string;
    permalink: string;
    created_at: Date;
  }>> {
    const days = Math.min(options.days ?? 30, 90);
    const limit = Math.min(options.limit ?? 25, 50);

    const result = await query<{
      text: string;
      channel_name: string;
      username: string;
      permalink: string;
      created_at: Date;
    }>(
      `SELECT
        content as text,
        slack_channel_name as channel_name,
        slack_username as username,
        slack_permalink as permalink,
        TO_TIMESTAMP(slack_ts::numeric) as created_at
       FROM addie_knowledge
       WHERE is_active = TRUE
         AND source_type = 'slack'
         AND LOWER(slack_channel_name) LIKE LOWER($1)
         AND slack_ts IS NOT NULL
         AND TO_TIMESTAMP(slack_ts::numeric) >= NOW() - INTERVAL '1 day' * $2
       ORDER BY slack_ts::numeric DESC
       LIMIT $3`,
      [`%${channel}%`, days, limit]
    );
    return result.rows;
  }

  // ============== Curated Resource Indexing ==============

  /**
   * Queue a URL for fetching and indexing
   * Creates a pending record that will be processed by the content fetcher
   */
  async queueResourceForIndexing(input: CuratedResourceInput): Promise<number> {
    const result = await query<{ id: number }>(
      `INSERT INTO addie_knowledge (
        title, category, content, source_url, fetch_url, source_type,
        fetch_status, discovery_source, discovery_context, relevance_tags,
        created_by
      ) VALUES ($1, $2, '', $3, $3, $4, 'pending', $5, $6, $7, $8)
      ON CONFLICT DO NOTHING
      RETURNING id`,
      [
        input.title,
        input.category,
        input.url,
        'curated',
        input.discovery_source,
        input.discovery_context ? JSON.stringify(input.discovery_context) : null,
        input.relevance_tags || null,
        input.created_by || 'system',
      ]
    );
    return result.rows[0]?.id ?? 0;
  }

  /**
   * Get resources that need fetching (pending or stale)
   */
  async getResourcesNeedingFetch(options: {
    limit?: number;
    staleAfterDays?: number;
  } = {}): Promise<Array<{ id: number; fetch_url: string; title: string }>> {
    const limit = options.limit ?? 10;
    const staleAfterDays = options.staleAfterDays ?? 7;

    const result = await query<{ id: number; fetch_url: string; title: string }>(
      `SELECT id, fetch_url, title
       FROM addie_knowledge
       WHERE source_type IN ('curated', 'perspective_link', 'web_search')
         AND is_active = TRUE
         AND (
           fetch_status = 'pending'
           OR (fetch_status = 'success' AND last_fetched_at < NOW() - $1::integer * INTERVAL '1 day')
           OR (fetch_status = 'failed' AND last_fetched_at < NOW() - INTERVAL '6 hours')
         )
       ORDER BY
         CASE WHEN fetch_status = 'pending' THEN 0 ELSE 1 END,
         last_fetched_at ASC NULLS FIRST
       LIMIT $2`,
      [staleAfterDays, limit]
    );
    return result.rows;
  }

  /**
   * Update a resource after fetching content
   */
  async updateFetchedResource(
    id: number,
    data: {
      content: string;
      summary?: string;
      key_insights?: KeyInsight[];
      addie_notes?: string;
      relevance_tags?: string[];
      quality_score?: number | null;
      fetch_status: 'success' | 'failed';
      error_message?: string;
    }
  ): Promise<void> {
    if (data.fetch_status === 'failed') {
      await query(
        `UPDATE addie_knowledge
         SET fetch_status = 'failed',
             last_fetched_at = NOW(),
             updated_at = NOW()
         WHERE id = $1`,
        [id]
      );
      return;
    }

    await query(
      `UPDATE addie_knowledge
       SET content = $1,
           summary = $2,
           key_insights = $3,
           addie_notes = $4,
           relevance_tags = COALESCE($5, relevance_tags),
           quality_score = $6,
           fetch_status = 'success',
           last_fetched_at = NOW(),
           updated_at = NOW()
       WHERE id = $7`,
      [
        data.content,
        data.summary || null,
        data.key_insights ? JSON.stringify(data.key_insights) : null,
        data.addie_notes || null,
        data.relevance_tags || null,
        data.quality_score || null,
        id,
      ]
    );
  }

  /**
   * Search curated resources (with summaries and notes)
   *
   * @param options.excludeUserSubmitted - When true, omit `web_search`-sourced
   *   rows (queued via `bookmark_resource`). Anonymous callers must pass true
   *   so attacker-controlled URLs can't ride into unauthenticated context.
   */
  async searchCuratedResources(searchQuery: string, options: {
    limit?: number;
    minQuality?: number;
    tags?: string[];
    excludeUserSubmitted?: boolean;
  } = {}): Promise<CuratedResourceSearchResult[]> {
    const limit = options.limit ?? 10;
    const sourceTypes = options.excludeUserSubmitted
      ? "'curated', 'perspective_link'"
      : "'curated', 'perspective_link', 'web_search'";
    const conditions: string[] = [
      'is_active = TRUE',
      `source_type IN (${sourceTypes})`,
      "fetch_status = 'success'",
      "search_vector @@ websearch_to_tsquery('english', $1)",
    ];
    const params: unknown[] = [searchQuery];
    let paramIndex = 2;

    if (options.minQuality) {
      conditions.push(`quality_score >= $${paramIndex++}`);
      params.push(options.minQuality);
    }

    if (options.tags && options.tags.length > 0) {
      conditions.push(`relevance_tags && $${paramIndex++}`);
      params.push(options.tags);
    }

    params.push(limit);

    const result = await query<CuratedResourceSearchResult>(
      `SELECT
        id,
        title,
        source_url,
        summary,
        addie_notes,
        relevance_tags,
        quality_score,
        ts_rank(search_vector, websearch_to_tsquery('english', $1)) as rank,
        ts_headline('english', COALESCE(summary, content), websearch_to_tsquery('english', $1),
          'StartSel=**, StopSel=**, MaxWords=50, MinWords=20') as headline
       FROM addie_knowledge
       WHERE ${conditions.join(' AND ')}
       ORDER BY quality_score DESC NULLS LAST, rank DESC
       LIMIT $${paramIndex}`,
      params
    );
    return result.rows;
  }

  /**
   * Get recent news/articles from curated resources sorted by date
   * Used for "what's happening in the news?" type queries
   */
  async getRecentNews(options: {
    days?: number;
    limit?: number;
    minQuality?: number;
    tags?: string[];
    topic?: string;
    excludeUserSubmitted?: boolean;
  } = {}): Promise<RecentNewsResult[]> {
    // Clamp inputs to reasonable ranges for safety
    const days = Math.max(1, Math.min(options.days ?? 7, 365));
    const limit = Math.max(1, Math.min(options.limit ?? 10, 100));
    // Anonymous callers omit `web_search` (URLs queued via bookmark_resource —
    // attacker-controllable) and `community` (free-form member submissions).
    const sourceTypes = options.excludeUserSubmitted
      ? "'curated', 'perspective_link', 'rss'"
      : "'curated', 'perspective_link', 'web_search', 'rss', 'community'";
    const conditions: string[] = [
      'is_active = TRUE',
      `source_type IN (${sourceTypes})`,
      "fetch_status = 'success'",
      `last_fetched_at >= NOW() - $1::integer * INTERVAL '1 day'`,
    ];
    const params: unknown[] = [days];
    let paramIndex = 2;

    // Filter by quality score (defaults to 3 to filter low-relevance content)
    const minQuality = options.minQuality ?? 3;
    conditions.push(`quality_score >= $${paramIndex++}`);
    params.push(minQuality);

    if (options.tags && options.tags.length > 0) {
      conditions.push(`relevance_tags && $${paramIndex++}`);
      params.push(options.tags);
    }

    // Optional topic filter using full-text search
    if (options.topic) {
      conditions.push(`search_vector @@ websearch_to_tsquery('english', $${paramIndex++})`);
      params.push(options.topic);
    }

    params.push(limit);

    const result = await query<RecentNewsResult>(
      `SELECT
        id,
        title,
        source_url,
        summary,
        addie_notes,
        relevance_tags,
        quality_score,
        last_fetched_at,
        discovery_source
       FROM addie_knowledge
       WHERE ${conditions.join(' AND ')}
       ORDER BY last_fetched_at DESC, quality_score DESC NULLS LAST
       LIMIT $${paramIndex}`,
      params
    );
    return result.rows;
  }

  /**
   * Check if a URL is already indexed
   */
  async isUrlIndexed(url: string): Promise<boolean> {
    const result = await query<{ count: string }>(
      `SELECT COUNT(*)::text as count FROM addie_knowledge
       WHERE (source_url = $1 OR fetch_url = $1) AND is_active = TRUE`,
      [url]
    );
    return parseInt(result.rows[0]?.count ?? '0', 10) > 0;
  }

  /**
   * Get curated resource stats
   */
  async getCuratedResourceStats(): Promise<{
    total: number;
    pending: number;
    success: number;
    failed: number;
    by_source: Record<string, number>;
  }> {
    const result = await query<{
      total: string;
      pending: string;
      success: string;
      failed: string;
    }>(
      `SELECT
        COUNT(*)::text as total,
        COUNT(*) FILTER (WHERE fetch_status = 'pending')::text as pending,
        COUNT(*) FILTER (WHERE fetch_status = 'success')::text as success,
        COUNT(*) FILTER (WHERE fetch_status = 'failed')::text as failed
       FROM addie_knowledge
       WHERE source_type IN ('curated', 'perspective_link', 'web_search')
         AND is_active = TRUE`
    );

    const bySourceResult = await query<{ discovery_source: string; count: string }>(
      `SELECT discovery_source, COUNT(*)::text as count
       FROM addie_knowledge
       WHERE source_type IN ('curated', 'perspective_link', 'web_search')
         AND is_active = TRUE
         AND discovery_source IS NOT NULL
       GROUP BY discovery_source`
    );

    const row = result.rows[0];
    const bySource: Record<string, number> = {};
    for (const sourceRow of bySourceResult.rows) {
      bySource[sourceRow.discovery_source] = parseInt(sourceRow.count, 10);
    }

    return {
      total: parseInt(row.total, 10),
      pending: parseInt(row.pending, 10),
      success: parseInt(row.success, 10),
      failed: parseInt(row.failed, 10),
      by_source: bySource,
    };
  }

  /**
   * List curated resources for admin view
   */
  async listCuratedResources(options: {
    status?: string;
    limit?: number;
    offset?: number;
  } = {}): Promise<AddieKnowledge[]> {
    const limit = options.limit ?? 50;
    const offset = options.offset ?? 0;

    const conditions: string[] = [
      "source_type IN ('curated', 'perspective_link', 'web_search')",
      'is_active = TRUE',
    ];
    const params: unknown[] = [];
    let paramIndex = 1;

    if (options.status) {
      conditions.push(`fetch_status = $${paramIndex++}`);
      params.push(options.status);
    }

    params.push(limit, offset);

    const result = await query<AddieKnowledge>(
      `SELECT *
       FROM addie_knowledge
       WHERE ${conditions.join(' AND ')}
       ORDER BY
         CASE WHEN fetch_status = 'pending' THEN 0 ELSE 1 END,
         updated_at DESC
       LIMIT $${paramIndex++} OFFSET $${paramIndex}`,
      params
    );
    return result.rows;
  }

  /**
   * Update a curated resource (for editing addie_notes, quality_score, tags)
   */
  async updateCuratedResource(
    id: number,
    data: {
      addie_notes?: string;
      quality_score?: number;
      relevance_tags?: string[];
    }
  ): Promise<AddieKnowledge | null> {
    const updates: string[] = ['updated_at = NOW()'];
    const params: unknown[] = [];
    let paramIndex = 1;

    if (data.addie_notes !== undefined) {
      updates.push(`addie_notes = $${paramIndex++}`);
      params.push(data.addie_notes);
    }

    if (data.quality_score !== undefined) {
      updates.push(`quality_score = $${paramIndex++}`);
      params.push(data.quality_score);
    }

    if (data.relevance_tags !== undefined) {
      updates.push(`relevance_tags = $${paramIndex++}`);
      params.push(data.relevance_tags);
    }

    params.push(id);

    const result = await query<AddieKnowledge>(
      `UPDATE addie_knowledge
       SET ${updates.join(', ')}
       WHERE id = $${paramIndex}
       RETURNING *`,
      params
    );

    return result.rows[0] || null;
  }

  /**
   * Reset a resource for refetching
   */
  async resetResourceForRefetch(id: number): Promise<void> {
    await query(
      `UPDATE addie_knowledge
       SET fetch_status = 'pending',
           updated_at = NOW()
       WHERE id = $1`,
      [id]
    );
  }

  // ============== Interaction Logging ==============

  /**
   * Log an interaction
   */
  async logInteraction(log: AddieInteractionLog, knowledgeIds?: number[]): Promise<void> {
    await query(
      `INSERT INTO addie_interactions (
        id, event_type, channel_id, thread_ts, user_id,
        input_text, input_sanitized, output_text,
        tools_used, knowledge_ids, model, latency_ms,
        flagged, flag_reason
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        log.id,
        log.event_type,
        log.channel_id,
        log.thread_ts || null,
        log.user_id,
        log.input_text,
        log.input_sanitized,
        log.output_text,
        log.tools_used,
        knowledgeIds || null,
        log.model,
        log.latency_ms,
        log.flagged,
        log.flag_reason || null,
      ]
    );
  }

  /**
   * Get recent interactions
   */
  async getInteractions(options: {
    flaggedOnly?: boolean;
    unreviewedOnly?: boolean;
    userId?: string;
    limit?: number;
    offset?: number;
  } = {}): Promise<AddieInteractionLog[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIndex = 1;

    if (options.flaggedOnly) {
      conditions.push('flagged = TRUE');
    }

    if (options.unreviewedOnly) {
      conditions.push('reviewed = FALSE');
    }

    if (options.userId) {
      conditions.push(`user_id = $${paramIndex++}`);
      params.push(options.userId);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    let sql = `
      SELECT * FROM addie_interactions
      ${whereClause}
      ORDER BY created_at DESC
    `;

    if (options.limit) {
      sql += ` LIMIT $${paramIndex++}`;
      params.push(options.limit);
    }

    if (options.offset) {
      sql += ` OFFSET $${paramIndex++}`;
      params.push(options.offset);
    }

    const result = await query<AddieInteractionRow>(sql, params);
    return result.rows.map(row => ({
      id: row.id,
      timestamp: row.created_at,
      event_type: row.event_type as 'assistant_thread' | 'mention' | 'dm',
      channel_id: row.channel_id,
      thread_ts: row.thread_ts ?? undefined,
      user_id: row.user_id,
      input_text: row.input_text,
      input_sanitized: row.input_sanitized,
      output_text: row.output_text,
      tools_used: row.tools_used,
      model: row.model,
      latency_ms: row.latency_ms,
      flagged: row.flagged,
      flag_reason: row.flag_reason ?? undefined,
    }));
  }

  /**
   * Mark an interaction as reviewed
   */
  async markInteractionReviewed(id: string, reviewedBy: string): Promise<void> {
    await query(
      `UPDATE addie_interactions
       SET reviewed = TRUE, reviewed_by = $1, reviewed_at = NOW()
       WHERE id = $2`,
      [reviewedBy, id]
    );
  }

  /**
   * Get interaction statistics
   */
  async getInteractionStats(options: { days?: number } = {}): Promise<AddieInteractionStats> {
    const days = options.days ?? 30;

    const result = await query<{
      total: string;
      flagged: string;
      unreviewed: string;
      avg_latency_ms: string;
    }>(
      `SELECT
        COUNT(*)::text as total,
        COUNT(*) FILTER (WHERE flagged = TRUE)::text as flagged,
        COUNT(*) FILTER (WHERE reviewed = FALSE)::text as unreviewed,
        COALESCE(AVG(latency_ms), 0)::text as avg_latency_ms
       FROM addie_interactions
       WHERE created_at >= NOW() - $1::integer * INTERVAL '1 day'`,
      [days]
    );

    const byTypeResult = await query<{ event_type: string; count: string }>(
      `SELECT event_type, COUNT(*)::text as count
       FROM addie_interactions
       WHERE created_at >= NOW() - $1::integer * INTERVAL '1 day'
       GROUP BY event_type`,
      [days]
    );

    const row = result.rows[0];
    const byEventType: Record<string, number> = {};
    for (const typeRow of byTypeResult.rows) {
      byEventType[typeRow.event_type] = parseInt(typeRow.count, 10);
    }

    return {
      total: parseInt(row.total, 10),
      flagged: parseInt(row.flagged, 10),
      unreviewed: parseInt(row.unreviewed, 10),
      by_event_type: byEventType,
      avg_latency_ms: parseFloat(row.avg_latency_ms),
    };
  }

  // ============== Rules Management ==============

  /**
   * Get all active rules, ordered by priority
   */
  async getActiveRules(): Promise<AddieRule[]> {
    const result = await query<AddieRule>(
      `SELECT * FROM addie_rules
       WHERE is_active = TRUE
       ORDER BY priority DESC, rule_type, name`
    );
    return result.rows;
  }

  /**
   * Get rules by type
   */
  async getRulesByType(ruleType: RuleType): Promise<AddieRule[]> {
    const result = await query<AddieRule>(
      `SELECT * FROM addie_rules
       WHERE rule_type = $1 AND is_active = TRUE
       ORDER BY priority DESC, name`,
      [ruleType]
    );
    return result.rows;
  }

  /**
   * Get all rules (including inactive) for admin
   */
  async getAllRules(): Promise<AddieRule[]> {
    const result = await query<AddieRule>(
      `SELECT * FROM addie_rules
       ORDER BY is_active DESC, priority DESC, rule_type, name`
    );
    return result.rows;
  }

  /**
   * Get a rule by ID
   */
  async getRuleById(id: number): Promise<AddieRule | null> {
    const result = await query<AddieRule>(
      'SELECT * FROM addie_rules WHERE id = $1',
      [id]
    );
    return result.rows[0] || null;
  }

  /**
   * Create a new rule
   */
  async createRule(input: AddieRuleInput): Promise<AddieRule> {
    const result = await query<AddieRule>(
      `INSERT INTO addie_rules (rule_type, name, description, content, priority, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        input.rule_type,
        input.name,
        input.description || null,
        input.content,
        input.priority ?? 0,
        input.created_by || null,
      ]
    );
    return result.rows[0];
  }

  /**
   * Update a rule (creates new version)
   * Uses a transaction to ensure atomicity of deactivation and new version creation
   */
  async updateRule(id: number, updates: Partial<Omit<AddieRuleInput, 'created_by'>>, updatedBy?: string): Promise<AddieRule | null> {
    // Get current rule
    const current = await this.getRuleById(id);
    if (!current) return null;

    const client = await getClient();
    try {
      await client.query('BEGIN');

      // Deactivate current rule
      await client.query(
        'UPDATE addie_rules SET is_active = FALSE WHERE id = $1',
        [id]
      );

      // Create new version
      const result = await client.query<AddieRule>(
        `INSERT INTO addie_rules (rule_type, name, description, content, priority, version, supersedes_rule_id, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [
          updates.rule_type ?? current.rule_type,
          updates.name ?? current.name,
          updates.description ?? current.description,
          updates.content ?? current.content,
          updates.priority ?? current.priority,
          current.version + 1,
          id,
          updatedBy || null,
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
   * Toggle rule active status
   */
  async setRuleActive(id: number, isActive: boolean): Promise<AddieRule | null> {
    const result = await query<AddieRule>(
      `UPDATE addie_rules SET is_active = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
      [isActive, id]
    );
    return result.rows[0] || null;
  }

  /**
   * Delete a rule (soft delete by deactivating)
   */
  async deleteRule(id: number): Promise<boolean> {
    const result = await query(
      'UPDATE addie_rules SET is_active = FALSE WHERE id = $1',
      [id]
    );
    return (result.rowCount ?? 0) > 0;
  }

  // ============== Thread Context Store ==============

  /**
   * Save thread context for Bolt Assistant
   * Stores what channel/team the user was viewing when they opened the assistant
   */
  async saveThreadContext(data: {
    channel_id: string;
    thread_ts: string;
    context_channel_id: string;
    context_team_id: string;
    context_enterprise_id: string | null;
  }): Promise<void> {
    await query(
      `INSERT INTO addie_thread_context (channel_id, thread_ts, context_channel_id, context_team_id, context_enterprise_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (channel_id, thread_ts)
       DO UPDATE SET
         context_channel_id = EXCLUDED.context_channel_id,
         context_team_id = EXCLUDED.context_team_id,
         context_enterprise_id = EXCLUDED.context_enterprise_id,
         updated_at = NOW()`,
      [data.channel_id, data.thread_ts, data.context_channel_id, data.context_team_id, data.context_enterprise_id]
    );
  }

  /**
   * Get thread context for Bolt Assistant
   */
  async getThreadContext(channelId: string, threadTs: string): Promise<{
    context_channel_id: string;
    context_team_id: string;
    context_enterprise_id: string | null;
  } | null> {
    const result = await query<{
      context_channel_id: string;
      context_team_id: string;
      context_enterprise_id: string | null;
    }>(
      `SELECT context_channel_id, context_team_id, context_enterprise_id
       FROM addie_thread_context
       WHERE channel_id = $1 AND thread_ts = $2`,
      [channelId, threadTs]
    );
    return result.rows[0] || null;
  }

  /**
   * Clean up old thread contexts (older than 7 days)
   */
  async cleanupOldThreadContexts(): Promise<number> {
    const result = await query(
      `DELETE FROM addie_thread_context WHERE updated_at < NOW() - INTERVAL '7 days'`
    );
    return result.rowCount ?? 0;
  }

  /**
   * Get a user's most recent Addie thread within a time window
   * Used for sending proactive messages after account linking
   */
  async getUserRecentThread(
    slackUserId: string,
    maxAgeMinutes: number = 30
  ): Promise<{ channel_id: string; thread_ts: string } | null> {
    const result = await query<{ channel_id: string; thread_ts: string }>(
      `SELECT channel_id, thread_ts
       FROM addie_interactions
       WHERE user_id = $1
         AND thread_ts IS NOT NULL
         AND event_type = 'assistant_thread'
         AND created_at >= NOW() - $2::integer * INTERVAL '1 minute'
       ORDER BY created_at DESC
       LIMIT 1`,
      [slackUserId, maxAgeMinutes]
    );
    return result.rows[0] || null;
  }

  // ============== Interaction Rating ==============

  /**
   * Rate an interaction
   */
  async rateInteraction(
    id: string,
    rating: number,
    ratedBy: string,
    options: {
      notes?: string;
      outcome?: string;
      user_sentiment?: string;
      intent_category?: string;
    } = {}
  ): Promise<void> {
    await query(
      `UPDATE addie_interactions
       SET rating = $1, rating_by = $2, rating_notes = $3, rated_at = NOW(),
           outcome = $4, user_sentiment = $5, intent_category = $6
       WHERE id = $7`,
      [
        rating,
        ratedBy,
        options.notes || null,
        options.outcome || null,
        options.user_sentiment || null,
        options.intent_category || null,
        id,
      ]
    );
  }

  // ============== Web Conversations Methods ==============

  /**
   * Get list of web conversations with summary info
   */
  async getWebConversations(options: {
    limit?: number;
    offset?: number;
  } = {}): Promise<WebConversationSummary[]> {
    const limit = options.limit ?? 50;
    const offset = options.offset ?? 0;

    const result = await query(
      `SELECT
        c.conversation_id,
        c.user_id,
        c.user_name,
        c.channel,
        c.message_count,
        c.last_message_at,
        c.created_at,
        (SELECT content FROM addie_messages WHERE conversation_id = c.conversation_id AND role = 'user' ORDER BY created_at ASC LIMIT 1) as first_message_preview,
        EXISTS(SELECT 1 FROM addie_messages WHERE conversation_id = c.conversation_id AND tool_use IS NOT NULL) as has_tool_uses
      FROM addie_conversations c
      ORDER BY c.last_message_at DESC
      LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    return result.rows.map(row => ({
      conversation_id: row.conversation_id,
      user_id: row.user_id,
      user_name: row.user_name,
      channel: row.channel,
      message_count: row.message_count,
      last_message_at: row.last_message_at,
      created_at: row.created_at,
      first_message_preview: row.first_message_preview ?
        (row.first_message_preview.length > 100 ? row.first_message_preview.substring(0, 100) + '...' : row.first_message_preview) : null,
      has_tool_uses: row.has_tool_uses,
    }));
  }

  /**
   * Get a single web conversation with all messages and execution details
   */
  async getWebConversationWithMessages(conversationId: string): Promise<WebConversationDetail | null> {
    // Get conversation info
    const convResult = await query(
      `SELECT
        conversation_id, user_id, user_name, channel, message_count,
        metadata, created_at, last_message_at
      FROM addie_conversations
      WHERE conversation_id = $1`,
      [conversationId]
    );

    if (convResult.rows.length === 0) {
      return null;
    }

    const conv = convResult.rows[0];

    // Get all messages
    const msgResult = await query(
      `SELECT
        id, role, content, tool_use, tool_results,
        tokens_input, tokens_output, model, latency_ms, created_at
      FROM addie_messages
      WHERE conversation_id = $1
      ORDER BY created_at ASC`,
      [conversationId]
    );

    return {
      conversation_id: conv.conversation_id,
      user_id: conv.user_id,
      user_name: conv.user_name,
      channel: conv.channel,
      message_count: conv.message_count,
      metadata: conv.metadata,
      created_at: conv.created_at,
      last_message_at: conv.last_message_at,
      messages: msgResult.rows.map(row => ({
        id: row.id,
        role: row.role,
        content: row.content,
        tool_use: row.tool_use,
        tool_results: row.tool_results,
        tokens_input: row.tokens_input,
        tokens_output: row.tokens_output,
        model: row.model,
        latency_ms: row.latency_ms,
        created_at: row.created_at,
      })),
    };
  }

  /**
   * Get statistics about web conversations
   */
  async getWebConversationStats(): Promise<WebConversationStats> {
    const statsResult = await query(`
      SELECT
        COUNT(DISTINCT c.conversation_id) as total_conversations,
        COUNT(m.id) as total_messages,
        ROUND(AVG(c.message_count)::numeric, 1) as avg_messages_per_conversation,
        COUNT(DISTINCT c.conversation_id) FILTER (WHERE c.created_at > NOW() - INTERVAL '24 hours') as conversations_last_24h,
        ROUND(AVG(m.latency_ms) FILTER (WHERE m.latency_ms IS NOT NULL)::numeric, 0) as avg_latency_ms
      FROM addie_conversations c
      LEFT JOIN addie_messages m ON c.conversation_id = m.conversation_id
    `);

    // Get tool usage breakdown
    const toolResult = await query(`
      SELECT
        jsonb_array_elements_text(tool_use::jsonb) as tool_name,
        COUNT(*) as usage_count
      FROM addie_messages
      WHERE tool_use IS NOT NULL AND tool_use != '[]'
      GROUP BY tool_name
      ORDER BY usage_count DESC
    `);

    const toolUsage: Record<string, number> = {};
    for (const row of toolResult.rows) {
      toolUsage[row.tool_name] = parseInt(row.usage_count, 10);
    }

    const stats = statsResult.rows[0];
    return {
      total_conversations: parseInt(stats.total_conversations, 10) || 0,
      total_messages: parseInt(stats.total_messages, 10) || 0,
      avg_messages_per_conversation: parseFloat(stats.avg_messages_per_conversation) || 0,
      conversations_last_24h: parseInt(stats.conversations_last_24h, 10) || 0,
      avg_latency_ms: parseInt(stats.avg_latency_ms, 10) || 0,
      tool_usage: toolUsage,
    };
  }

  // ============== Search Tracking ==============

  /**
   * Log a search query for pattern analysis
   */
  async logSearch(params: {
    query: string;
    tool_name: string;
    category?: string;
    limit_requested?: number;
    results_count: number;
    result_ids?: string[];
    top_result_score?: number;
    thread_id?: string;
    channel?: string;
    search_latency_ms?: number;
  }): Promise<number> {
    // Truncate query to prevent storage bloat
    const truncatedQuery = params.query.slice(0, 1000);

    const result = await query<{ id: number }>(
      `INSERT INTO addie_search_logs (
        query, tool_name, category, limit_requested,
        results_count, result_ids, top_result_score,
        thread_id, channel, search_latency_ms
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING id`,
      [
        truncatedQuery,
        params.tool_name,
        params.category || null,
        params.limit_requested || null,
        params.results_count,
        params.result_ids || null,
        params.top_result_score || null,
        params.thread_id || null,
        params.channel || null,
        params.search_latency_ms || null,
      ]
    );
    return result.rows[0]?.id ?? 0;
  }

  /**
   * Get search analytics for a time period
   */
  async getSearchAnalytics(days: number = 7): Promise<{
    total_searches: number;
    zero_result_rate: number;
    avg_results: number;
    avg_latency_ms: number;
    top_queries: Array<{ query: string; count: number }>;
    by_tool: Record<string, number>;
  }> {
    // Get overall stats
    const statsResult = await query<{
      total: string;
      zero_results: string;
      avg_results: string;
      avg_latency: string;
    }>(
      `SELECT
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE results_count = 0) as zero_results,
        ROUND(AVG(results_count), 1) as avg_results,
        ROUND(AVG(search_latency_ms), 0) as avg_latency
       FROM addie_search_logs
       WHERE created_at > NOW() - $1 * INTERVAL '1 day'`,
      [days]
    );

    // Get top queries
    const topQueriesResult = await query<{ query: string; count: string }>(
      `SELECT query, COUNT(*) as count
       FROM addie_search_logs
       WHERE created_at > NOW() - $1 * INTERVAL '1 day'
       GROUP BY query
       ORDER BY count DESC
       LIMIT 20`,
      [days]
    );

    // Get by tool
    const byToolResult = await query<{ tool_name: string; count: string }>(
      `SELECT tool_name, COUNT(*) as count
       FROM addie_search_logs
       WHERE created_at > NOW() - $1 * INTERVAL '1 day'
       GROUP BY tool_name
       ORDER BY count DESC`,
      [days]
    );

    const stats = statsResult.rows[0];
    const total = parseInt(stats.total, 10) || 0;
    const zeroResults = parseInt(stats.zero_results, 10) || 0;

    const byTool: Record<string, number> = {};
    for (const row of byToolResult.rows) {
      byTool[row.tool_name] = parseInt(row.count, 10);
    }

    return {
      total_searches: total,
      zero_result_rate: total > 0 ? zeroResults / total : 0,
      avg_results: parseFloat(stats.avg_results) || 0,
      avg_latency_ms: parseInt(stats.avg_latency, 10) || 0,
      top_queries: topQueriesResult.rows.map(r => ({
        query: r.query,
        count: parseInt(r.count, 10),
      })),
      by_tool: byTool,
    };
  }

  /**
   * Get queries with zero results (content gaps)
   */
  async getZeroResultQueries(limit: number = 50): Promise<Array<{
    query: string;
    count: number;
    last_seen: Date;
  }>> {
    const result = await query<{ query: string; count: string; last_seen: Date }>(
      `SELECT query, COUNT(*) as count, MAX(created_at) as last_seen
       FROM addie_search_logs
       WHERE results_count = 0
         AND created_at > NOW() - INTERVAL '30 days'
       GROUP BY query
       ORDER BY count DESC
       LIMIT $1`,
      [limit]
    );

    return result.rows.map(r => ({
      query: r.query,
      count: parseInt(r.count, 10),
      last_seen: r.last_seen,
    }));
  }

  /**
   * Get current Addie config version info
   */
  async getCurrentConfigVersion(): Promise<ConfigVersionInfo | null> {
    const result = await query<ConfigVersionInfo>(
      `SELECT
         cv.version_id,
         cv.config_hash,
         cv.code_version,
         cv.created_at,
         array_length(cv.active_rule_ids, 1) as rule_count,
         cv.message_count,
         cv.positive_feedback,
         cv.negative_feedback,
         cv.avg_rating,
         cv.source_synthesis_run_ids
       FROM addie_config_versions cv
       ORDER BY cv.version_id DESC
       LIMIT 1`
    );
    return result.rows[0] || null;
  }

  /**
   * Get config version history with metrics
   */
  async getConfigVersionHistory(limit = 20): Promise<ConfigVersionInfo[]> {
    const result = await query<ConfigVersionInfo>(
      `SELECT
         cv.version_id,
         cv.config_hash,
         cv.code_version,
         cv.created_at,
         array_length(cv.active_rule_ids, 1) as rule_count,
         cv.message_count,
         cv.positive_feedback,
         cv.negative_feedback,
         cv.avg_rating,
         cv.source_synthesis_run_ids
       FROM addie_config_versions cv
       ORDER BY cv.version_id DESC
       LIMIT $1`,
      [limit]
    );
    return result.rows;
  }
}

// Config version info type
export interface ConfigVersionInfo {
  version_id: number;
  config_hash: string;
  code_version: string | null;
  created_at: Date;
  rule_count: number;
  message_count: number;
  positive_feedback: number;
  negative_feedback: number;
  avg_rating: number | null;
  source_synthesis_run_ids: number[] | null;
}

