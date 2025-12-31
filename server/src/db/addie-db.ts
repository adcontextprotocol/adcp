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

export interface AddieApprovalQueueItem {
  id: number;
  action_type: string;
  target_channel_id: string | null;
  target_thread_ts: string | null;
  target_user_id: string | null;
  proposed_content: string;
  trigger_type: string;
  trigger_context: Record<string, unknown> | null;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  reviewed_by: string | null;
  reviewed_at: Date | null;
  edit_notes: string | null;
  final_content: string | null;
  executed_at: Date | null;
  execution_result: Record<string, unknown> | null;
  created_at: Date;
  expires_at: Date | null;
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

/**
 * Context determines when a rule is applied:
 * - null/undefined: Always included in main system prompt
 * - 'engagement': Only for "should I respond?" channel evaluation
 * - 'admin': Only when talking to admin users
 * - 'member': Only when talking to organization members
 * - 'anonymous': Only when talking to anonymous/unlinked users
 */
export type RuleContext = 'engagement' | 'admin' | 'member' | 'anonymous' | null;

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
  /** Context where this rule applies (null = always in main prompt) */
  context: RuleContext;
}

export interface AddieRuleInput {
  rule_type: RuleType;
  name: string;
  description?: string;
  content: string;
  priority?: number;
  created_by?: string;
  /** Context where this rule applies (null = always in main prompt) */
  context?: RuleContext;
}

// ============== Suggestions Types ==============

export type SuggestionType = 'new_rule' | 'modify_rule' | 'disable_rule' | 'merge_rules' | 'experiment' | 'publish_content';
export type SuggestionStatus = 'pending' | 'approved' | 'rejected' | 'applied' | 'superseded';
export type ContentType = 'docs' | 'perspectives' | 'external_link';

export interface AddieRuleSuggestion {
  id: number;
  suggestion_type: SuggestionType;
  target_rule_id: number | null;
  suggested_name: string | null;
  suggested_content: string;
  suggested_rule_type: RuleType | null;
  reasoning: string;
  evidence: Record<string, unknown> | null;
  confidence: number | null;
  expected_impact: string | null;
  supporting_interactions: string[] | null;
  pattern_summary: string | null;
  status: SuggestionStatus;
  reviewed_by: string | null;
  reviewed_at: Date | null;
  review_notes: string | null;
  applied_at: Date | null;
  resulting_rule_id: number | null;
  analysis_batch_id: string | null;
  // Content suggestion fields (for publish_content type)
  content_type: ContentType | null;
  suggested_topic: string | null;
  external_sources: string[] | null;
  created_at: Date;
}

export interface AddieRuleSuggestionInput {
  suggestion_type: SuggestionType;
  target_rule_id?: number;
  suggested_name?: string;
  suggested_content: string;
  suggested_rule_type?: RuleType;
  reasoning: string;
  evidence?: Record<string, unknown>;
  confidence?: number;
  expected_impact?: string;
  supporting_interactions?: string[];
  pattern_summary?: string;
  analysis_batch_id?: string;
  // Content suggestion fields (for publish_content type)
  content_type?: ContentType;
  suggested_topic?: string;
  external_sources?: string[];
}

// ============== Experiments Types ==============

export type ExperimentStatus = 'draft' | 'running' | 'paused' | 'completed' | 'cancelled';
export type ExperimentWinner = 'control' | 'variant' | 'inconclusive' | null;

export interface AddieExperiment {
  id: number;
  name: string;
  description: string | null;
  hypothesis: string;
  control_rules: number[];
  variant_rules: number[];
  traffic_split: number;
  status: ExperimentStatus;
  started_at: Date | null;
  ended_at: Date | null;
  target_interactions: number | null;
  control_interactions: number;
  variant_interactions: number;
  control_positive: number;
  control_negative: number;
  variant_positive: number;
  variant_negative: number;
  control_avg_rating: number | null;
  variant_avg_rating: number | null;
  winner: ExperimentWinner;
  statistical_significance: number | null;
  conclusion: string | null;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

// ============== Analysis Types ==============

export type AnalysisType = 'scheduled' | 'manual' | 'threshold' | 'feedback';
export type AnalysisStatus = 'running' | 'completed' | 'failed';

export interface AddieAnalysisRun {
  id: number;
  analysis_type: AnalysisType;
  interactions_analyzed: number;
  date_range_start: Date | null;
  date_range_end: Date | null;
  suggestions_generated: number;
  patterns_found: Record<string, unknown> | null;
  summary: string | null;
  status: AnalysisStatus;
  error_message: string | null;
  started_at: Date;
  completed_at: Date | null;
  model_used: string | null;
  tokens_used: number | null;
}

// ============== Extended Interaction Types ==============

export interface AddieInteractionWithRating extends AddieInteractionLog {
  rating?: number;
  rating_by?: string;
  rating_notes?: string;
  rated_at?: Date;
  outcome?: string;
  user_sentiment?: string;
  intent_category?: string;
  active_rules_snapshot?: Record<string, unknown>;
  experiment_id?: number;
  experiment_group?: 'control' | 'variant';
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
  } = {}): Promise<AddieKnowledge[]> {
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

    let sql = `
      SELECT * FROM addie_knowledge
      ${whereClause}
      ORDER BY
        CASE WHEN source_type = 'curated' AND fetch_status = 'pending' THEN 0 ELSE 1 END,
        updated_at DESC,
        category,
        title
    `;

    if (options.limit) {
      sql += ` LIMIT $${paramIndex++}`;
      params.push(options.limit);
    }

    if (options.offset) {
      sql += ` OFFSET $${paramIndex++}`;
      params.push(options.offset);
    }

    const result = await query<AddieKnowledge>(sql, params);
    return result.rows;
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
   */
  async searchSlackMessages(searchQuery: string, options: {
    limit?: number;
  } = {}): Promise<SlackSearchResult[]> {
    const limit = options.limit ?? 10;

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
       ORDER BY rank DESC
       LIMIT $2`,
      [searchQuery, limit]
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
      ) VALUES ($1, $2, '', $3, $3, $4, 'pending', $5, $6, $7, 'system')
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
   */
  async searchCuratedResources(searchQuery: string, options: {
    limit?: number;
    minQuality?: number;
    tags?: string[];
  } = {}): Promise<CuratedResourceSearchResult[]> {
    const limit = options.limit ?? 10;
    const conditions: string[] = [
      'is_active = TRUE',
      "source_type IN ('curated', 'perspective_link', 'web_search')",
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

  // ============== Approval Queue ==============

  /**
   * Add an item to the approval queue
   */
  async queueForApproval(item: {
    action_type: string;
    target_channel_id?: string;
    target_thread_ts?: string;
    target_user_id?: string;
    proposed_content: string;
    trigger_type: string;
    trigger_context?: Record<string, unknown>;
    expires_at?: Date;
  }): Promise<AddieApprovalQueueItem> {
    const result = await query<AddieApprovalQueueItem>(
      `INSERT INTO addie_approval_queue (
        action_type, target_channel_id, target_thread_ts, target_user_id,
        proposed_content, trigger_type, trigger_context, expires_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *`,
      [
        item.action_type,
        item.target_channel_id || null,
        item.target_thread_ts || null,
        item.target_user_id || null,
        item.proposed_content,
        item.trigger_type,
        item.trigger_context ? JSON.stringify(item.trigger_context) : null,
        item.expires_at || null,
      ]
    );
    return result.rows[0];
  }

  /**
   * Get pending approval items
   */
  async getPendingApprovals(options: { limit?: number } = {}): Promise<AddieApprovalQueueItem[]> {
    const limit = options.limit ?? 50;
    const result = await query<AddieApprovalQueueItem>(
      `SELECT * FROM addie_approval_queue
       WHERE status = 'pending'
         AND (expires_at IS NULL OR expires_at > NOW())
       ORDER BY created_at ASC
       LIMIT $1`,
      [limit]
    );
    return result.rows;
  }

  /**
   * Approve a queued item
   */
  async approveItem(
    id: number,
    reviewedBy: string,
    options: { editNotes?: string; finalContent?: string } = {}
  ): Promise<AddieApprovalQueueItem | null> {
    const result = await query<AddieApprovalQueueItem>(
      `UPDATE addie_approval_queue
       SET status = 'approved',
           reviewed_by = $1,
           reviewed_at = NOW(),
           edit_notes = $2,
           final_content = $3
       WHERE id = $4 AND status = 'pending'
       RETURNING *`,
      [reviewedBy, options.editNotes || null, options.finalContent || null, id]
    );
    return result.rows[0] || null;
  }

  /**
   * Reject a queued item
   */
  async rejectItem(id: number, reviewedBy: string, reason?: string): Promise<AddieApprovalQueueItem | null> {
    const result = await query<AddieApprovalQueueItem>(
      `UPDATE addie_approval_queue
       SET status = 'rejected',
           reviewed_by = $1,
           reviewed_at = NOW(),
           edit_notes = $2
       WHERE id = $3 AND status = 'pending'
       RETURNING *`,
      [reviewedBy, reason || null, id]
    );
    return result.rows[0] || null;
  }

  /**
   * Mark a queued item as executed
   */
  async markExecuted(id: number, result: Record<string, unknown>): Promise<void> {
    await query(
      `UPDATE addie_approval_queue
       SET executed_at = NOW(), execution_result = $1
       WHERE id = $2`,
      [JSON.stringify(result), id]
    );
  }

  /**
   * Expire old pending items
   */
  async expireOldItems(): Promise<number> {
    const result = await query(
      `UPDATE addie_approval_queue
       SET status = 'expired'
       WHERE status = 'pending'
         AND expires_at IS NOT NULL
         AND expires_at <= NOW()`
    );
    return result.rowCount ?? 0;
  }

  /**
   * Get approval queue stats
   */
  async getApprovalStats(): Promise<{
    pending: number;
    approved_today: number;
    rejected_today: number;
    total_approved: number;
    total_rejected: number;
  }> {
    const result = await query<{
      pending: string;
      approved_today: string;
      rejected_today: string;
      total_approved: string;
      total_rejected: string;
    }>(
      `SELECT
        COUNT(*) FILTER (WHERE status = 'pending')::text as pending,
        COUNT(*) FILTER (WHERE status = 'approved' AND reviewed_at::date = CURRENT_DATE)::text as approved_today,
        COUNT(*) FILTER (WHERE status = 'rejected' AND reviewed_at::date = CURRENT_DATE)::text as rejected_today,
        COUNT(*) FILTER (WHERE status = 'approved')::text as total_approved,
        COUNT(*) FILTER (WHERE status = 'rejected')::text as total_rejected
       FROM addie_approval_queue`
    );

    const row = result.rows[0];
    return {
      pending: parseInt(row.pending, 10),
      approved_today: parseInt(row.approved_today, 10),
      rejected_today: parseInt(row.rejected_today, 10),
      total_approved: parseInt(row.total_approved, 10),
      total_rejected: parseInt(row.total_rejected, 10),
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

  /**
   * Get active rules by context
   * @param context - The context to filter by (null for default/main prompt rules)
   */
  async getRulesByContext(context: RuleContext): Promise<AddieRule[]> {
    const result = await query<AddieRule>(
      context === null
        ? `SELECT * FROM addie_rules WHERE is_active = TRUE AND context IS NULL ORDER BY priority DESC, rule_type, name`
        : `SELECT * FROM addie_rules WHERE is_active = TRUE AND context = $1 ORDER BY priority DESC, rule_type, name`,
      context === null ? [] : [context]
    );
    return result.rows;
  }

  /**
   * Build system prompt from active rules
   * Only includes rules with context = NULL (default rules)
   */
  async buildSystemPrompt(): Promise<string> {
    // Only get rules without a specific context (main prompt rules)
    const rules = await this.getRulesByContext(null);

    const sections: Record<RuleType, string[]> = {
      system_prompt: [],
      behavior: [],
      knowledge: [],
      constraint: [],
      response_style: [],
    };

    for (const rule of rules) {
      sections[rule.rule_type].push(`## ${rule.name}\n${rule.content}`);
    }

    const parts: string[] = [];

    if (sections.system_prompt.length > 0) {
      parts.push('# Core Identity\n\n' + sections.system_prompt.join('\n\n'));
    }

    if (sections.behavior.length > 0) {
      parts.push('# Behaviors\n\n' + sections.behavior.join('\n\n'));
    }

    if (sections.knowledge.length > 0) {
      parts.push('# Knowledge\n\n' + sections.knowledge.join('\n\n'));
    }

    if (sections.constraint.length > 0) {
      parts.push('# Constraints\n\n' + sections.constraint.join('\n\n'));
    }

    if (sections.response_style.length > 0) {
      parts.push('# Response Style\n\n' + sections.response_style.join('\n\n'));
    }

    return parts.join('\n\n---\n\n');
  }

  /**
   * Increment rule usage count
   */
  async incrementRuleUsage(ruleIds: number[]): Promise<void> {
    if (ruleIds.length === 0) return;
    await query(
      `UPDATE addie_rules SET interactions_count = interactions_count + 1 WHERE id = ANY($1)`,
      [ruleIds]
    );
  }

  /**
   * Update rule ratings based on interaction feedback
   *
   * Average rating is approximated as: (positive * 5 + negative * 1) / total
   * This assumes positive ratings (4-5) are treated as "5 stars" and
   * negative ratings (1-2) as "1 star". Neutral ratings (3) don't affect the average.
   */
  async updateRuleRatings(ruleIds: number[], rating: number): Promise<void> {
    if (ruleIds.length === 0) return;
    const isPositive = rating >= 4;
    const isNegative = rating <= 2;

    if (isPositive) {
      await query(
        `UPDATE addie_rules
         SET positive_ratings = positive_ratings + 1,
             avg_rating = ((positive_ratings + 1) * 5.0 + negative_ratings * 1.0) /
                          NULLIF(positive_ratings + negative_ratings + 1, 0)
         WHERE id = ANY($1)`,
        [ruleIds]
      );
    } else if (isNegative) {
      await query(
        `UPDATE addie_rules
         SET negative_ratings = negative_ratings + 1,
             avg_rating = (positive_ratings * 5.0 + (negative_ratings + 1) * 1.0) /
                          NULLIF(positive_ratings + negative_ratings + 1, 0)
         WHERE id = ANY($1)`,
        [ruleIds]
      );
    }
  }

  // ============== Suggestions Management ==============

  /**
   * Create a suggestion
   */
  async createSuggestion(input: AddieRuleSuggestionInput): Promise<AddieRuleSuggestion> {
    const result = await query<AddieRuleSuggestion>(
      `INSERT INTO addie_rule_suggestions (
        suggestion_type, target_rule_id, suggested_name, suggested_content,
        suggested_rule_type, reasoning, evidence, confidence, expected_impact,
        supporting_interactions, pattern_summary, analysis_batch_id,
        content_type, suggested_topic, external_sources
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
      RETURNING *`,
      [
        input.suggestion_type,
        input.target_rule_id || null,
        input.suggested_name || null,
        input.suggested_content,
        input.suggested_rule_type || null,
        input.reasoning,
        input.evidence ? JSON.stringify(input.evidence) : null,
        input.confidence || null,
        input.expected_impact || null,
        input.supporting_interactions ? JSON.stringify(input.supporting_interactions) : null,
        input.pattern_summary || null,
        input.analysis_batch_id || null,
        input.content_type || null,
        input.suggested_topic || null,
        input.external_sources ? JSON.stringify(input.external_sources) : null,
      ]
    );
    return result.rows[0];
  }

  /**
   * Get pending suggestions
   */
  async getPendingSuggestions(limit = 50): Promise<AddieRuleSuggestion[]> {
    const result = await query<AddieRuleSuggestion>(
      `SELECT * FROM addie_rule_suggestions
       WHERE status = 'pending'
       ORDER BY confidence DESC NULLS LAST, created_at DESC
       LIMIT $1`,
      [limit]
    );
    return result.rows;
  }

  /**
   * Get a suggestion by ID
   */
  async getSuggestionById(id: number): Promise<AddieRuleSuggestion | null> {
    const result = await query<AddieRuleSuggestion>(
      'SELECT * FROM addie_rule_suggestions WHERE id = $1',
      [id]
    );
    return result.rows[0] || null;
  }

  /**
   * Approve a suggestion
   */
  async approveSuggestion(id: number, reviewedBy: string, notes?: string): Promise<AddieRuleSuggestion | null> {
    const result = await query<AddieRuleSuggestion>(
      `UPDATE addie_rule_suggestions
       SET status = 'approved', reviewed_by = $1, reviewed_at = NOW(), review_notes = $2
       WHERE id = $3 AND status = 'pending'
       RETURNING *`,
      [reviewedBy, notes || null, id]
    );
    return result.rows[0] || null;
  }

  /**
   * Reject a suggestion
   */
  async rejectSuggestion(id: number, reviewedBy: string, notes?: string): Promise<AddieRuleSuggestion | null> {
    const result = await query<AddieRuleSuggestion>(
      `UPDATE addie_rule_suggestions
       SET status = 'rejected', reviewed_by = $1, reviewed_at = NOW(), review_notes = $2
       WHERE id = $3 AND status = 'pending'
       RETURNING *`,
      [reviewedBy, notes || null, id]
    );
    return result.rows[0] || null;
  }

  /**
   * Apply a suggestion (create or update rule)
   */
  async applySuggestion(id: number, appliedBy: string): Promise<{ suggestion: AddieRuleSuggestion; rule: AddieRule } | null> {
    const suggestion = await this.getSuggestionById(id);
    if (!suggestion || suggestion.status !== 'approved') return null;

    let rule: AddieRule;

    if (suggestion.suggestion_type === 'new_rule') {
      rule = await this.createRule({
        rule_type: suggestion.suggested_rule_type || 'behavior',
        name: suggestion.suggested_name || 'Unnamed Rule',
        content: suggestion.suggested_content,
        created_by: appliedBy,
      });
    } else if (suggestion.suggestion_type === 'modify_rule' && suggestion.target_rule_id) {
      const updated = await this.updateRule(
        suggestion.target_rule_id,
        { content: suggestion.suggested_content },
        appliedBy
      );
      if (!updated) return null;
      rule = updated;
    } else if (suggestion.suggestion_type === 'disable_rule' && suggestion.target_rule_id) {
      const disabled = await this.setRuleActive(suggestion.target_rule_id, false);
      if (!disabled) return null;
      rule = disabled;
    } else {
      return null;
    }

    // Mark suggestion as applied
    await query(
      `UPDATE addie_rule_suggestions
       SET status = 'applied', applied_at = NOW(), resulting_rule_id = $1
       WHERE id = $2`,
      [rule.id, id]
    );

    const updatedSuggestion = await this.getSuggestionById(id);
    return { suggestion: updatedSuggestion!, rule };
  }

  /**
   * Get suggestion statistics
   */
  async getSuggestionStats(): Promise<{
    pending: number;
    approved: number;
    rejected: number;
    applied: number;
    by_type: Record<SuggestionType, number>;
  }> {
    const result = await query<{
      pending: string;
      approved: string;
      rejected: string;
      applied: string;
    }>(
      `SELECT
        COUNT(*) FILTER (WHERE status = 'pending')::text as pending,
        COUNT(*) FILTER (WHERE status = 'approved')::text as approved,
        COUNT(*) FILTER (WHERE status = 'rejected')::text as rejected,
        COUNT(*) FILTER (WHERE status = 'applied')::text as applied
       FROM addie_rule_suggestions`
    );

    const byTypeResult = await query<{ suggestion_type: SuggestionType; count: string }>(
      `SELECT suggestion_type, COUNT(*)::text as count
       FROM addie_rule_suggestions
       GROUP BY suggestion_type`
    );

    const row = result.rows[0];
    const byType: Record<SuggestionType, number> = {
      new_rule: 0,
      modify_rule: 0,
      disable_rule: 0,
      merge_rules: 0,
      experiment: 0,
      publish_content: 0,
    };

    for (const typeRow of byTypeResult.rows) {
      byType[typeRow.suggestion_type] = parseInt(typeRow.count, 10);
    }

    return {
      pending: parseInt(row.pending, 10),
      approved: parseInt(row.approved, 10),
      rejected: parseInt(row.rejected, 10),
      applied: parseInt(row.applied, 10),
      by_type: byType,
    };
  }

  // ============== Experiments ==============

  /**
   * Get the currently running experiment (if any)
   */
  async getRunningExperiment(): Promise<AddieExperiment | null> {
    const result = await query<AddieExperiment>(
      `SELECT * FROM addie_experiments WHERE status = 'running' LIMIT 1`
    );
    return result.rows[0] || null;
  }

  /**
   * Assign an interaction to an experiment group
   */
  async assignExperimentGroup(experimentId: number, trafficSplit: number): Promise<'control' | 'variant'> {
    return Math.random() < trafficSplit ? 'variant' : 'control';
  }

  /**
   * Record experiment interaction result
   */
  async recordExperimentResult(
    experimentId: number,
    group: 'control' | 'variant',
    rating?: number
  ): Promise<void> {
    const isPositive = rating && rating >= 4;
    const isNegative = rating && rating <= 2;

    if (group === 'control') {
      await query(
        `UPDATE addie_experiments
         SET control_interactions = control_interactions + 1,
             control_positive = control_positive + $1,
             control_negative = control_negative + $2
         WHERE id = $3`,
        [isPositive ? 1 : 0, isNegative ? 1 : 0, experimentId]
      );
    } else {
      await query(
        `UPDATE addie_experiments
         SET variant_interactions = variant_interactions + 1,
             variant_positive = variant_positive + $1,
             variant_negative = variant_negative + $2
         WHERE id = $3`,
        [isPositive ? 1 : 0, isNegative ? 1 : 0, experimentId]
      );
    }
  }

  // ============== Analysis Runs ==============

  /**
   * Start an analysis run
   */
  async startAnalysisRun(type: AnalysisType): Promise<AddieAnalysisRun> {
    const result = await query<AddieAnalysisRun>(
      `INSERT INTO addie_analysis_runs (analysis_type)
       VALUES ($1)
       RETURNING *`,
      [type]
    );
    return result.rows[0];
  }

  /**
   * Complete an analysis run
   */
  async completeAnalysisRun(
    id: number,
    data: {
      interactions_analyzed: number;
      suggestions_generated: number;
      patterns_found?: Record<string, unknown>;
      summary?: string;
      model_used?: string;
      tokens_used?: number;
    }
  ): Promise<void> {
    await query(
      `UPDATE addie_analysis_runs
       SET status = 'completed',
           completed_at = NOW(),
           interactions_analyzed = $1,
           suggestions_generated = $2,
           patterns_found = $3,
           summary = $4,
           model_used = $5,
           tokens_used = $6
       WHERE id = $7`,
      [
        data.interactions_analyzed,
        data.suggestions_generated,
        data.patterns_found ? JSON.stringify(data.patterns_found) : null,
        data.summary || null,
        data.model_used || null,
        data.tokens_used || null,
        id,
      ]
    );
  }

  /**
   * Fail an analysis run
   */
  async failAnalysisRun(id: number, errorMessage: string): Promise<void> {
    await query(
      `UPDATE addie_analysis_runs
       SET status = 'failed', completed_at = NOW(), error_message = $1
       WHERE id = $2`,
      [errorMessage, id]
    );
  }

  /**
   * Get recent analysis runs
   */
  async getRecentAnalysisRuns(limit = 10): Promise<AddieAnalysisRun[]> {
    const result = await query<AddieAnalysisRun>(
      `SELECT * FROM addie_analysis_runs ORDER BY started_at DESC LIMIT $1`,
      [limit]
    );
    return result.rows;
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

    // Update rule ratings if we have the snapshot
    const interaction = await query<{ active_rules_snapshot: { rule_ids: number[] } | null }>(
      'SELECT active_rules_snapshot FROM addie_interactions WHERE id = $1',
      [id]
    );

    if (interaction.rows[0]?.active_rules_snapshot?.rule_ids) {
      await this.updateRuleRatings(interaction.rows[0].active_rules_snapshot.rule_ids, rating);
    }
  }

  /**
   * Get interactions for analysis (with ratings and outcomes)
   */
  async getInteractionsForAnalysis(options: {
    days?: number;
    minRating?: number;
    maxRating?: number;
    limit?: number;
  } = {}): Promise<AddieInteractionWithRating[]> {
    const days = options.days ?? 30;
    const conditions: string[] = [`created_at >= NOW() - $1::integer * INTERVAL '1 day'`];
    const params: unknown[] = [days];
    let paramIndex = 2;

    if (options.minRating !== undefined) {
      conditions.push(`rating >= $${paramIndex++}`);
      params.push(options.minRating);
    }

    if (options.maxRating !== undefined) {
      conditions.push(`rating <= $${paramIndex++}`);
      params.push(options.maxRating);
    }

    let sql = `
      SELECT * FROM addie_interactions
      WHERE ${conditions.join(' AND ')}
      ORDER BY created_at DESC
    `;

    if (options.limit) {
      sql += ` LIMIT $${paramIndex++}`;
      params.push(options.limit);
    }

    const result = await query<AddieInteractionRow & {
      rating: number | null;
      rating_by: string | null;
      rating_notes: string | null;
      rated_at: Date | null;
      outcome: string | null;
      user_sentiment: string | null;
      intent_category: string | null;
      active_rules_snapshot: Record<string, unknown> | null;
      experiment_id: number | null;
      experiment_group: 'control' | 'variant' | null;
    }>(sql, params);

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
      rating: row.rating ?? undefined,
      rating_by: row.rating_by ?? undefined,
      rating_notes: row.rating_notes ?? undefined,
      rated_at: row.rated_at ?? undefined,
      outcome: row.outcome ?? undefined,
      user_sentiment: row.user_sentiment ?? undefined,
      intent_category: row.intent_category ?? undefined,
      active_rules_snapshot: row.active_rules_snapshot ?? undefined,
      experiment_id: row.experiment_id ?? undefined,
      experiment_group: row.experiment_group ?? undefined,
    }));
  }

  /**
   * Log interaction with rules snapshot
   */
  async logInteractionWithRules(
    log: AddieInteractionLog,
    knowledgeIds?: number[],
    ruleIds?: number[],
    experimentId?: number,
    experimentGroup?: 'control' | 'variant'
  ): Promise<void> {
    await query(
      `INSERT INTO addie_interactions (
        id, event_type, channel_id, thread_ts, user_id,
        input_text, input_sanitized, output_text,
        tools_used, knowledge_ids, model, latency_ms,
        flagged, flag_reason, active_rules_snapshot,
        experiment_id, experiment_group
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
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
        ruleIds ? JSON.stringify({ rule_ids: ruleIds }) : null,
        experimentId || null,
        experimentGroup || null,
      ]
    );

    // Increment rule usage
    if (ruleIds && ruleIds.length > 0) {
      await this.incrementRuleUsage(ruleIds);
    }
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
}
