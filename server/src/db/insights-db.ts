import { query } from './client.js';

// =====================================================
// TYPES
// =====================================================

export type InsightConfidence = 'high' | 'medium' | 'low';
export type InsightSourceType = 'conversation' | 'observation' | 'manual';
export type GoalType = 'campaign' | 'persistent';
export type OutreachType = 'account_link' | 'introduction' | 'insight_goal' | 'custom';
export type OutreachTone = 'casual' | 'professional' | 'brief';
export type OutreachApproach = 'direct' | 'conversational' | 'minimal';

export interface MemberInsightType {
  id: number;
  name: string;
  description: string | null;
  example_values: string[] | null;
  is_active: boolean;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface MemberInsight {
  id: number;
  slack_user_id: string;
  workos_user_id: string | null;
  insight_type_id: number;
  value: string;
  confidence: InsightConfidence;
  source_type: InsightSourceType;
  source_thread_id: string | null;
  source_message_id: string | null;
  extracted_from: string | null;
  superseded_by: number | null;
  is_current: boolean;
  created_by: string | null;
  created_at: Date;
  // Joined fields
  insight_type_name?: string;
}

export interface InsightGoal {
  id: number;
  name: string;
  question: string;
  insight_type_id: number | null;
  goal_type: GoalType;
  start_date: Date | null;
  end_date: Date | null;
  is_enabled: boolean;
  priority: number;
  target_mapped_only: boolean;
  target_unmapped_only: boolean;
  target_response_count: number | null;
  current_response_count: number;
  suggested_prompt_title: string | null;
  suggested_prompt_message: string | null;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface OutreachVariant {
  id: number;
  name: string;
  description: string | null;
  tone: OutreachTone;
  approach: OutreachApproach;
  message_template: string;
  is_active: boolean;
  weight: number;
  created_at: Date;
  updated_at: Date;
}

export interface OutreachTestAccount {
  id: number;
  slack_user_id: string;
  description: string | null;
  is_active: boolean;
  created_at: Date;
}

export type ResponseSentiment = 'positive' | 'neutral' | 'negative' | 'refusal';
export type ResponseIntent = 'converted' | 'interested' | 'deferred' | 'question' | 'objection' | 'refusal' | 'ignored';

export interface MemberOutreach {
  id: number;
  slack_user_id: string;
  outreach_type: OutreachType;
  insight_goal_id: number | null;
  thread_id: string | null;
  dm_channel_id: string | null;
  initial_message: string | null;
  variant_id: number | null;
  tone: string | null;
  approach: string | null;
  user_responded: boolean;
  response_received_at: Date | null;
  insight_extracted: boolean;
  // Enhanced response tracking
  response_text: string | null;
  response_sentiment: ResponseSentiment | null;
  response_intent: ResponseIntent | null;
  follow_up_date: Date | null;
  follow_up_reason: string | null;
  sent_at: Date;
  created_at: Date;
}

export interface ResponseAnalysis {
  sentiment: ResponseSentiment;
  intent: ResponseIntent;
  followUpDays: number | null;
  analysisNote: string;
}

export interface MemberOutreachWithUser extends MemberOutreach {
  slack_display_name: string | null;
  slack_real_name: string | null;
}

// Input types
export interface CreateInsightTypeInput {
  name: string;
  description?: string;
  example_values?: string[];
  is_active?: boolean;
  created_by?: string;
}

export interface CreateInsightInput {
  slack_user_id: string;
  workos_user_id?: string;
  insight_type_id: number;
  value: string;
  confidence?: InsightConfidence;
  source_type: InsightSourceType;
  source_thread_id?: string;
  source_message_id?: string;
  extracted_from?: string;
  created_by?: string;
}

export interface CreateGoalInput {
  name: string;
  question: string;
  insight_type_id?: number;
  goal_type?: GoalType;
  start_date?: Date;
  end_date?: Date;
  is_enabled?: boolean;
  priority?: number;
  target_mapped_only?: boolean;
  target_unmapped_only?: boolean;
  target_response_count?: number;
  suggested_prompt_title?: string;
  suggested_prompt_message?: string;
  created_by?: string;
}

export interface CreateVariantInput {
  name: string;
  description?: string;
  tone: OutreachTone;
  approach: OutreachApproach;
  message_template: string;
  is_active?: boolean;
  weight?: number;
}

export interface CreateOutreachInput {
  slack_user_id: string;
  outreach_type: OutreachType;
  insight_goal_id?: number;
  thread_id?: string;
  dm_channel_id?: string;
  initial_message?: string;
  variant_id?: number;
  tone?: string;
  approach?: string;
}

// Summary types
export interface MemberInsightSummary {
  slack_user_id: string;
  slack_email: string | null;
  slack_real_name: string | null;
  slack_display_name: string | null;
  workos_user_id: string | null;
  mapping_status: string;
  insight_count: number;
  last_insight_at: Date | null;
  insight_types: string[];
}

// Unified person view combining Slack and email identities
export interface UnifiedPersonInsights {
  // Identity
  workos_user_id: string | null;
  slack_user_id: string | null;
  email_contact_id: string | null;

  // Display info
  display_name: string | null;
  email: string | null;
  organization_name: string | null;

  // Structured insights from Slack conversations
  slack_insights: MemberInsight[];

  // Free text insights from email correspondence
  email_insights: EmailActivityInsight[];

  // Metadata
  first_seen_at: Date | null;
  last_activity_at: Date | null;
}

export interface EmailActivityInsight {
  id: string;
  subject: string | null;
  insights: string | null;
  direction: 'inbound' | 'outbound';
  email_date: Date | null;
  role: 'sender' | 'recipient' | 'cc';
}

// Sensitive topic detection types
export type SensitiveCategory =
  | 'vulnerable_populations'
  | 'political'
  | 'named_individual'
  | 'organization_position'
  | 'competitive'
  | 'privacy_surveillance'
  | 'ethical_concerns'
  | 'media_inquiry';

export type SensitiveSeverity = 'high' | 'medium' | 'low';

export interface SensitiveTopicResult {
  isSensitive: boolean;
  patternId: number | null;
  category: SensitiveCategory | null;
  severity: SensitiveSeverity | null;
  deflectResponse: string | null;
}

export interface KnownMediaContact {
  id: number;
  slackUserId: string | null;
  email: string | null;
  name: string | null;
  organization: string | null;
  role: string | null;
  handlingLevel: 'standard' | 'careful' | 'executive_only';
}

export interface FlaggedConversation {
  id: number;
  slackUserId: string;
  slackChannelId: string | null;
  messageText: string;
  matchedCategory: SensitiveCategory | null;
  severity: SensitiveSeverity | null;
  responseGiven: string | null;
  wasDeflected: boolean;
  createdAt: Date;
}

export interface OutreachVariantStats {
  variant_id: number;
  variant_name: string;
  tone: string;
  approach: string;
  total_sent: number;
  total_responded: number;
  total_insights: number;
  response_rate_pct: number | null;
  insight_rate_pct: number | null;
}

export interface OutreachStats {
  sent_today: number;
  sent_this_week: number;
  total_responded: number;
  response_rate: number;
  insights_gathered: number;
}

export interface OutreachGoalStats {
  goal_id: number;
  goal_name: string;
  goal_question: string;
  goal_type: GoalType;
  is_enabled: boolean;
  total_sent: number;
  total_responded: number;
  total_insights: number;
  response_rate_pct: number | null;
  insight_conversion_rate_pct: number | null;
  positive_responses: number;
  neutral_responses: number;
  negative_responses: number;
  refusal_responses: number;
  converted_count: number;
  interested_count: number;
  deferred_count: number;
  question_count: number;
  objection_count: number;
  first_outreach_at: Date | null;
  last_outreach_at: Date | null;
}

export interface OutreachTimeStats {
  sent_today: number;
  responded_today: number;
  sent_this_week: number;
  responded_this_week: number;
  sent_this_month: number;
  responded_this_month: number;
  total_sent: number;
  total_responded: number;
  total_insights: number;
  overall_response_rate_pct: number | null;
}

// =====================================================
// DATABASE CLASS
// =====================================================

/**
 * Database operations for member insights and proactive engagement
 */
export class InsightsDatabase {
  /**
   * Execute a raw query (for admin routes that need direct access)
   */
  async query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[]
  ): Promise<{ rows: T[] }> {
    return query<T>(sql, params);
  }

  // ============== Insight Types ==============

  /**
   * Create a new insight type
   */
  async createInsightType(input: CreateInsightTypeInput): Promise<MemberInsightType> {
    const result = await query<MemberInsightType>(
      `INSERT INTO member_insight_types (name, description, example_values, is_active, created_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [
        input.name,
        input.description || null,
        input.example_values || null,
        input.is_active ?? true,
        input.created_by || null,
      ]
    );
    return result.rows[0];
  }

  /**
   * Get all insight types
   */
  async listInsightTypes(activeOnly = false): Promise<MemberInsightType[]> {
    const whereClause = activeOnly ? 'WHERE is_active = TRUE' : '';
    const result = await query<MemberInsightType>(
      `SELECT * FROM member_insight_types ${whereClause} ORDER BY name`
    );
    return result.rows;
  }

  /**
   * Get insight type by ID
   */
  async getInsightType(id: number): Promise<MemberInsightType | null> {
    const result = await query<MemberInsightType>(
      'SELECT * FROM member_insight_types WHERE id = $1',
      [id]
    );
    return result.rows[0] || null;
  }

  /**
   * Get insight type by name
   */
  async getInsightTypeByName(name: string): Promise<MemberInsightType | null> {
    const result = await query<MemberInsightType>(
      'SELECT * FROM member_insight_types WHERE name = $1',
      [name]
    );
    return result.rows[0] || null;
  }

  /**
   * Update an insight type
   */
  async updateInsightType(
    id: number,
    updates: Partial<CreateInsightTypeInput>
  ): Promise<MemberInsightType | null> {
    const setClauses: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (updates.name !== undefined) {
      setClauses.push(`name = $${paramIndex++}`);
      values.push(updates.name);
    }
    if (updates.description !== undefined) {
      setClauses.push(`description = $${paramIndex++}`);
      values.push(updates.description);
    }
    if (updates.example_values !== undefined) {
      setClauses.push(`example_values = $${paramIndex++}`);
      values.push(updates.example_values);
    }
    if (updates.is_active !== undefined) {
      setClauses.push(`is_active = $${paramIndex++}`);
      values.push(updates.is_active);
    }

    if (setClauses.length === 0) return this.getInsightType(id);

    setClauses.push('updated_at = NOW()');
    values.push(id);

    const result = await query<MemberInsightType>(
      `UPDATE member_insight_types SET ${setClauses.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
      values
    );
    return result.rows[0] || null;
  }

  /**
   * Delete an insight type (soft delete by deactivating)
   */
  async deleteInsightType(id: number): Promise<boolean> {
    const result = await query(
      'UPDATE member_insight_types SET is_active = FALSE, updated_at = NOW() WHERE id = $1',
      [id]
    );
    return (result.rowCount ?? 0) > 0;
  }

  // ============== Member Insights ==============

  /**
   * Add a new insight about a member
   */
  async addInsight(input: CreateInsightInput): Promise<MemberInsight> {
    // First, supersede any existing current insights of the same type for this user
    await query(
      `UPDATE member_insights
       SET is_current = FALSE
       WHERE slack_user_id = $1 AND insight_type_id = $2 AND is_current = TRUE`,
      [input.slack_user_id, input.insight_type_id]
    );

    const result = await query<MemberInsight>(
      `INSERT INTO member_insights (
        slack_user_id, workos_user_id, insight_type_id, value, confidence,
        source_type, source_thread_id, source_message_id, extracted_from, created_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING *`,
      [
        input.slack_user_id,
        input.workos_user_id || null,
        input.insight_type_id,
        input.value,
        input.confidence || 'medium',
        input.source_type,
        input.source_thread_id || null,
        input.source_message_id || null,
        input.extracted_from || null,
        input.created_by || null,
      ]
    );
    return result.rows[0];
  }

  /**
   * Get all current insights for a user
   */
  async getInsightsForUser(slackUserId: string): Promise<MemberInsight[]> {
    const result = await query<MemberInsight>(
      `SELECT i.*, t.name as insight_type_name
       FROM member_insights i
       JOIN member_insight_types t ON i.insight_type_id = t.id
       WHERE i.slack_user_id = $1 AND i.is_current = TRUE
       ORDER BY i.created_at DESC`,
      [slackUserId]
    );
    return result.rows;
  }

  /**
   * Get all insights by type
   */
  async getInsightsByType(typeId: number, limit = 100): Promise<MemberInsight[]> {
    const result = await query<MemberInsight>(
      `SELECT i.*, t.name as insight_type_name
       FROM member_insights i
       JOIN member_insight_types t ON i.insight_type_id = t.id
       WHERE i.insight_type_id = $1 AND i.is_current = TRUE
       ORDER BY i.created_at DESC
       LIMIT $2`,
      [typeId, limit]
    );
    return result.rows;
  }

  /**
   * Get member insight summary for admin dashboard
   */
  async getMemberInsightSummaries(options: {
    search?: string;
    hasInsights?: boolean;
    limit?: number;
    offset?: number;
  } = {}): Promise<MemberInsightSummary[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIndex = 1;

    if (options.search) {
      conditions.push(`(
        slack_email ILIKE $${paramIndex} OR
        slack_real_name ILIKE $${paramIndex} OR
        slack_display_name ILIKE $${paramIndex}
      )`);
      params.push(`%${options.search}%`);
      paramIndex++;
    }

    if (options.hasInsights === true) {
      conditions.push('insight_count > 0');
    } else if (options.hasInsights === false) {
      conditions.push('insight_count = 0');
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    let sql = `SELECT * FROM member_insight_summary ${whereClause} ORDER BY insight_count DESC, slack_real_name`;

    if (options.limit) {
      sql += ` LIMIT $${paramIndex++}`;
      params.push(options.limit);
    }
    if (options.offset) {
      sql += ` OFFSET $${paramIndex++}`;
      params.push(options.offset);
    }

    const result = await query<MemberInsightSummary>(sql, params);
    return result.rows.map(row => ({
      ...row,
      insight_count: Number(row.insight_count),
    }));
  }

  /**
   * Delete an insight
   */
  async deleteInsight(id: number): Promise<boolean> {
    const result = await query('DELETE FROM member_insights WHERE id = $1', [id]);
    return (result.rowCount ?? 0) > 0;
  }

  // ============== Insight Goals ==============

  /**
   * Create a new insight goal
   */
  async createGoal(input: CreateGoalInput): Promise<InsightGoal> {
    const result = await query<InsightGoal>(
      `INSERT INTO insight_goals (
        name, question, insight_type_id, goal_type, start_date, end_date,
        is_enabled, priority, target_mapped_only, target_unmapped_only,
        target_response_count, suggested_prompt_title, suggested_prompt_message, created_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      RETURNING *`,
      [
        input.name,
        input.question,
        input.insight_type_id || null,
        input.goal_type || 'persistent',
        input.start_date || null,
        input.end_date || null,
        input.is_enabled ?? true,
        input.priority ?? 50,
        input.target_mapped_only ?? false,
        input.target_unmapped_only ?? false,
        input.target_response_count || null,
        input.suggested_prompt_title || null,
        input.suggested_prompt_message || null,
        input.created_by || null,
      ]
    );
    return result.rows[0];
  }

  /**
   * Get all insight goals
   */
  async listGoals(options: { activeOnly?: boolean } = {}): Promise<InsightGoal[]> {
    let whereClause = '';
    if (options.activeOnly) {
      whereClause = `WHERE is_enabled = TRUE AND (
        goal_type = 'persistent' OR
        (goal_type = 'campaign' AND start_date <= CURRENT_DATE AND end_date >= CURRENT_DATE)
      )`;
    }

    const result = await query<InsightGoal>(
      `SELECT * FROM insight_goals ${whereClause} ORDER BY priority DESC, created_at DESC`
    );
    return result.rows;
  }

  /**
   * Get active goals for a specific user context
   */
  async getActiveGoalsForUser(isMapped: boolean): Promise<InsightGoal[]> {
    const result = await query<InsightGoal>(
      `SELECT * FROM insight_goals
       WHERE is_enabled = TRUE
         AND (goal_type = 'persistent' OR
              (goal_type = 'campaign' AND start_date <= CURRENT_DATE AND end_date >= CURRENT_DATE))
         AND (
           (target_mapped_only = FALSE AND target_unmapped_only = FALSE) OR
           (target_mapped_only = TRUE AND $1 = TRUE) OR
           (target_unmapped_only = TRUE AND $1 = FALSE)
         )
       ORDER BY priority DESC`,
      [isMapped]
    );
    return result.rows;
  }

  /**
   * Get a specific goal
   */
  async getGoal(id: number): Promise<InsightGoal | null> {
    const result = await query<InsightGoal>(
      'SELECT * FROM insight_goals WHERE id = $1',
      [id]
    );
    return result.rows[0] || null;
  }

  /**
   * Update an insight goal
   */
  async updateGoal(id: number, updates: Partial<CreateGoalInput>): Promise<InsightGoal | null> {
    const setClauses: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    const fields: Array<keyof CreateGoalInput> = [
      'name', 'question', 'insight_type_id', 'goal_type', 'start_date', 'end_date',
      'is_enabled', 'priority', 'target_mapped_only', 'target_unmapped_only',
      'target_response_count', 'suggested_prompt_title', 'suggested_prompt_message',
    ];

    for (const field of fields) {
      if (updates[field] !== undefined) {
        setClauses.push(`${field} = $${paramIndex++}`);
        values.push(updates[field]);
      }
    }

    if (setClauses.length === 0) return this.getGoal(id);

    setClauses.push('updated_at = NOW()');
    values.push(id);

    const result = await query<InsightGoal>(
      `UPDATE insight_goals SET ${setClauses.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
      values
    );
    return result.rows[0] || null;
  }

  /**
   * Increment goal response count
   */
  async incrementGoalResponseCount(id: number): Promise<void> {
    await query(
      'UPDATE insight_goals SET current_response_count = current_response_count + 1, updated_at = NOW() WHERE id = $1',
      [id]
    );
  }

  /**
   * Delete an insight goal
   */
  async deleteGoal(id: number): Promise<boolean> {
    const result = await query('DELETE FROM insight_goals WHERE id = $1', [id]);
    return (result.rowCount ?? 0) > 0;
  }

  // ============== Outreach Variants ==============

  /**
   * Create a new outreach variant
   */
  async createVariant(input: CreateVariantInput): Promise<OutreachVariant> {
    const result = await query<OutreachVariant>(
      `INSERT INTO outreach_variants (name, description, tone, approach, message_template, is_active, weight)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        input.name,
        input.description || null,
        input.tone,
        input.approach,
        input.message_template,
        input.is_active ?? true,
        input.weight ?? 100,
      ]
    );
    return result.rows[0];
  }

  /**
   * Get all outreach variants
   */
  async listVariants(activeOnly = false): Promise<OutreachVariant[]> {
    const whereClause = activeOnly ? 'WHERE is_active = TRUE' : '';
    const result = await query<OutreachVariant>(
      `SELECT * FROM outreach_variants ${whereClause} ORDER BY name`
    );
    return result.rows;
  }

  /**
   * Get variant by ID
   */
  async getVariant(id: number): Promise<OutreachVariant | null> {
    const result = await query<OutreachVariant>(
      'SELECT * FROM outreach_variants WHERE id = $1',
      [id]
    );
    return result.rows[0] || null;
  }

  /**
   * Update an outreach variant
   */
  async updateVariant(
    id: number,
    updates: Partial<CreateVariantInput>
  ): Promise<OutreachVariant | null> {
    const setClauses: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    const fields: Array<keyof CreateVariantInput> = [
      'name', 'description', 'tone', 'approach', 'message_template', 'is_active', 'weight',
    ];

    for (const field of fields) {
      if (updates[field] !== undefined) {
        setClauses.push(`${field} = $${paramIndex++}`);
        values.push(updates[field]);
      }
    }

    if (setClauses.length === 0) return this.getVariant(id);

    setClauses.push('updated_at = NOW()');
    values.push(id);

    const result = await query<OutreachVariant>(
      `UPDATE outreach_variants SET ${setClauses.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
      values
    );
    return result.rows[0] || null;
  }

  /**
   * Delete an outreach variant
   */
  async deleteVariant(id: number): Promise<boolean> {
    const result = await query('DELETE FROM outreach_variants WHERE id = $1', [id]);
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Get variant stats for A/B testing analysis
   */
  async getVariantStats(): Promise<OutreachVariantStats[]> {
    const result = await query<OutreachVariantStats>(
      'SELECT * FROM outreach_variant_stats ORDER BY total_sent DESC'
    );
    return result.rows.map(row => ({
      ...row,
      total_sent: Number(row.total_sent),
      total_responded: Number(row.total_responded),
      total_insights: Number(row.total_insights),
      response_rate_pct: row.response_rate_pct ? Number(row.response_rate_pct) : null,
      insight_rate_pct: row.insight_rate_pct ? Number(row.insight_rate_pct) : null,
    }));
  }

  // ============== Outreach Test Accounts ==============

  /**
   * Add a test account
   */
  async addTestAccount(slackUserId: string, description?: string): Promise<OutreachTestAccount> {
    const result = await query<OutreachTestAccount>(
      `INSERT INTO outreach_test_accounts (slack_user_id, description)
       VALUES ($1, $2)
       ON CONFLICT (slack_user_id) DO UPDATE SET description = EXCLUDED.description, is_active = TRUE
       RETURNING *`,
      [slackUserId, description || null]
    );
    return result.rows[0];
  }

  /**
   * Get all test accounts
   */
  async listTestAccounts(): Promise<OutreachTestAccount[]> {
    const result = await query<OutreachTestAccount>(
      'SELECT * FROM outreach_test_accounts WHERE is_active = TRUE ORDER BY created_at'
    );
    return result.rows;
  }

  /**
   * Check if a user is a test account
   */
  async isTestAccount(slackUserId: string): Promise<boolean> {
    const result = await query<{ exists: boolean }>(
      'SELECT EXISTS(SELECT 1 FROM outreach_test_accounts WHERE slack_user_id = $1 AND is_active = TRUE) as exists',
      [slackUserId]
    );
    return result.rows[0]?.exists ?? false;
  }

  /**
   * Remove a test account
   */
  async removeTestAccount(slackUserId: string): Promise<boolean> {
    const result = await query(
      'UPDATE outreach_test_accounts SET is_active = FALSE WHERE slack_user_id = $1',
      [slackUserId]
    );
    return (result.rowCount ?? 0) > 0;
  }

  // ============== Member Outreach ==============

  /**
   * Record an outreach attempt
   */
  async recordOutreach(input: CreateOutreachInput): Promise<MemberOutreach> {
    const result = await query<MemberOutreach>(
      `INSERT INTO member_outreach (
        slack_user_id, outreach_type, insight_goal_id, thread_id, dm_channel_id,
        initial_message, variant_id, tone, approach
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *`,
      [
        input.slack_user_id,
        input.outreach_type,
        input.insight_goal_id || null,
        input.thread_id || null,
        input.dm_channel_id || null,
        input.initial_message || null,
        input.variant_id || null,
        input.tone || null,
        input.approach || null,
      ]
    );

    // Update last_outreach_at on slack_user_mappings
    await query(
      'UPDATE slack_user_mappings SET last_outreach_at = NOW(), updated_at = NOW() WHERE slack_user_id = $1',
      [input.slack_user_id]
    );

    return result.rows[0];
  }

  /**
   * Get outreach history for a user
   */
  async getOutreachHistory(slackUserId: string): Promise<MemberOutreach[]> {
    const result = await query<MemberOutreach>(
      'SELECT * FROM member_outreach WHERE slack_user_id = $1 ORDER BY sent_at DESC',
      [slackUserId]
    );
    return result.rows;
  }

  /**
   * Mark outreach as responded (legacy - use markOutreachRespondedWithAnalysis for full tracking)
   */
  async markOutreachResponded(id: number, insightExtracted = false): Promise<void> {
    await query(
      `UPDATE member_outreach
       SET user_responded = TRUE, response_received_at = NOW(), insight_extracted = $2
       WHERE id = $1`,
      [id, insightExtracted]
    );
  }

  /**
   * Analyze a response to detect sentiment, intent, and scheduling needs
   * Uses database functions for pattern matching
   */
  async analyzeResponse(responseText: string): Promise<ResponseAnalysis> {
    const result = await query<{
      sentiment: ResponseSentiment;
      intent: ResponseIntent;
      follow_up_days: number | null;
      analysis_note: string;
    }>(
      'SELECT * FROM analyze_outreach_response($1)',
      [responseText]
    );

    const row = result.rows[0];
    return {
      sentiment: row.sentiment,
      intent: row.intent,
      followUpDays: row.follow_up_days,
      analysisNote: row.analysis_note,
    };
  }

  /**
   * Mark outreach as responded with full sentiment/intent analysis
   */
  async markOutreachRespondedWithAnalysis(
    id: number,
    responseText: string,
    insightExtracted = false
  ): Promise<ResponseAnalysis> {
    // Analyze the response
    const analysis = await this.analyzeResponse(responseText);

    // Calculate follow-up date if needed
    const followUpDate = analysis.followUpDays
      ? new Date(Date.now() + analysis.followUpDays * 24 * 60 * 60 * 1000)
      : null;

    // Update the outreach record with all analysis
    await query(
      `UPDATE member_outreach
       SET
         user_responded = TRUE,
         response_received_at = NOW(),
         insight_extracted = $2,
         response_text = $3,
         response_sentiment = $4,
         response_intent = $5,
         follow_up_date = $6,
         follow_up_reason = $7
       WHERE id = $1`,
      [
        id,
        insightExtracted,
        responseText,
        analysis.sentiment,
        analysis.intent,
        followUpDate,
        analysis.followUpDays ? analysis.analysisNote : null,
      ]
    );

    // If this is a hard refusal, update the user's opt-out status
    if (analysis.sentiment === 'refusal') {
      const outreach = await query<{ slack_user_id: string }>(
        'SELECT slack_user_id FROM member_outreach WHERE id = $1',
        [id]
      );
      if (outreach.rows[0]) {
        await query(
          `UPDATE slack_user_mappings
           SET outreach_opt_out = TRUE, outreach_opt_out_at = NOW()
           WHERE slack_user_id = $1`,
          [outreach.rows[0].slack_user_id]
        );
      }
    }

    return analysis;
  }

  /**
   * Check if a user should be contacted (respects refusals, rate limits, grace period)
   */
  async canContactUser(slackUserId: string): Promise<{
    canContact: boolean;
    reason: string;
    nextContactDate?: Date;
  }> {
    const result = await query<{
      outreach_opt_out: boolean;
      last_outreach_at: Date | null;
      slack_joined_at: Date | null;
      has_refusal: boolean;
      has_pending_follow_up: boolean;
      follow_up_date: Date | null;
    }>(
      `SELECT
        sm.outreach_opt_out,
        sm.last_outreach_at,
        sm.slack_joined_at,
        EXISTS(
          SELECT 1 FROM member_outreach mo
          WHERE mo.slack_user_id = sm.slack_user_id
            AND mo.response_sentiment = 'refusal'
        ) as has_refusal,
        EXISTS(
          SELECT 1 FROM member_outreach mo
          WHERE mo.slack_user_id = sm.slack_user_id
            AND mo.follow_up_date IS NOT NULL
            AND mo.follow_up_date > CURRENT_DATE
        ) as has_pending_follow_up,
        (
          SELECT mo.follow_up_date FROM member_outreach mo
          WHERE mo.slack_user_id = sm.slack_user_id
            AND mo.follow_up_date IS NOT NULL
          ORDER BY mo.follow_up_date DESC LIMIT 1
        ) as follow_up_date
      FROM slack_user_mappings sm
      WHERE sm.slack_user_id = $1`,
      [slackUserId]
    );

    if (result.rows.length === 0) {
      return { canContact: false, reason: 'User not found' };
    }

    const user = result.rows[0];
    const RATE_LIMIT_DAYS = 7;
    const GRACE_PERIOD_HOURS = 24;

    // Check for explicit opt-out
    if (user.outreach_opt_out) {
      return { canContact: false, reason: 'User has opted out of outreach' };
    }

    // Check for past refusal
    if (user.has_refusal) {
      return { canContact: false, reason: 'User previously refused - requires human review' };
    }

    // Check grace period for new users
    if (user.slack_joined_at) {
      const hoursSinceJoined = (Date.now() - new Date(user.slack_joined_at).getTime()) / (1000 * 60 * 60);
      if (hoursSinceJoined < GRACE_PERIOD_HOURS) {
        const nextDate = new Date(new Date(user.slack_joined_at).getTime() + GRACE_PERIOD_HOURS * 60 * 60 * 1000);
        return {
          canContact: false,
          reason: `User joined recently - grace period until ${nextDate.toISOString()}`,
          nextContactDate: nextDate,
        };
      }
    }

    // Check for pending scheduled follow-up
    if (user.has_pending_follow_up && user.follow_up_date) {
      const followUpDate = new Date(user.follow_up_date);
      if (followUpDate > new Date()) {
        return {
          canContact: false,
          reason: `Scheduled follow-up on ${followUpDate.toISOString().split('T')[0]}`,
          nextContactDate: followUpDate,
        };
      }
    }

    // Check rate limit
    if (user.last_outreach_at) {
      const daysSinceOutreach = (Date.now() - new Date(user.last_outreach_at).getTime()) / (1000 * 60 * 60 * 24);
      if (daysSinceOutreach < RATE_LIMIT_DAYS) {
        const nextDate = new Date(new Date(user.last_outreach_at).getTime() + RATE_LIMIT_DAYS * 24 * 60 * 60 * 1000);
        return {
          canContact: false,
          reason: `Rate limited - last contact ${Math.round(daysSinceOutreach)} days ago`,
          nextContactDate: nextDate,
        };
      }
    }

    return { canContact: true, reason: 'OK' };
  }

  /**
   * Get users with scheduled follow-ups that are due
   */
  async getDueFollowUps(): Promise<Array<{
    outreachId: number;
    slackUserId: string;
    userName: string | null;
    email: string | null;
    followUpDate: Date;
    followUpReason: string | null;
    responseText: string | null;
  }>> {
    const result = await query<{
      outreach_id: number;
      slack_user_id: string;
      slack_real_name: string | null;
      slack_email: string | null;
      follow_up_date: Date;
      follow_up_reason: string | null;
      response_text: string | null;
    }>(
      `SELECT * FROM outreach_scheduled_followups
       WHERE follow_up_date <= CURRENT_DATE`
    );

    return result.rows.map(row => ({
      outreachId: row.outreach_id,
      slackUserId: row.slack_user_id,
      userName: row.slack_real_name,
      email: row.slack_email,
      followUpDate: row.follow_up_date,
      followUpReason: row.follow_up_reason,
      responseText: row.response_text,
    }));
  }

  /**
   * Get users who have explicitly refused outreach (for human review)
   */
  async getRefusedUsers(): Promise<Array<{
    slackUserId: string;
    userName: string | null;
    email: string | null;
    responseText: string | null;
    refusedAt: Date;
  }>> {
    const result = await query<{
      slack_user_id: string;
      slack_real_name: string | null;
      slack_email: string | null;
      response_text: string | null;
      refused_at: Date;
    }>('SELECT * FROM outreach_refused_users');

    return result.rows.map(row => ({
      slackUserId: row.slack_user_id,
      userName: row.slack_real_name,
      email: row.slack_email,
      responseText: row.response_text,
      refusedAt: row.refused_at,
    }));
  }

  /**
   * Get outreach statistics
   */
  async getOutreachStats(): Promise<OutreachStats> {
    const result = await query<{
      sent_today: string;
      sent_this_week: string;
      total_responded: string;
      total_sent: string;
      insights_gathered: string;
    }>(`
      SELECT
        COUNT(*) FILTER (WHERE sent_at > CURRENT_DATE)::text as sent_today,
        COUNT(*) FILTER (WHERE sent_at > CURRENT_DATE - INTERVAL '7 days')::text as sent_this_week,
        COUNT(*) FILTER (WHERE user_responded)::text as total_responded,
        COUNT(*)::text as total_sent,
        COUNT(*) FILTER (WHERE insight_extracted)::text as insights_gathered
      FROM member_outreach
    `);

    const row = result.rows[0];
    const totalSent = parseInt(row.total_sent, 10);
    const totalResponded = parseInt(row.total_responded, 10);

    return {
      sent_today: parseInt(row.sent_today, 10),
      sent_this_week: parseInt(row.sent_this_week, 10),
      total_responded: totalResponded,
      response_rate: totalSent > 0 ? Math.round((100 * totalResponded) / totalSent) : 0,
      insights_gathered: parseInt(row.insights_gathered, 10),
    };
  }

  /**
   * Get outreach response rates broken down by goal
   */
  async getOutreachGoalStats(): Promise<OutreachGoalStats[]> {
    const result = await query<{
      goal_id: string;
      goal_name: string;
      goal_question: string;
      goal_type: GoalType;
      is_enabled: boolean;
      total_sent: string;
      total_responded: string;
      total_insights: string;
      response_rate_pct: string | null;
      insight_conversion_rate_pct: string | null;
      positive_responses: string;
      neutral_responses: string;
      negative_responses: string;
      refusal_responses: string;
      converted_count: string;
      interested_count: string;
      deferred_count: string;
      question_count: string;
      objection_count: string;
      first_outreach_at: Date | null;
      last_outreach_at: Date | null;
    }>('SELECT * FROM outreach_goal_stats ORDER BY total_sent DESC');

    return result.rows.map(row => ({
      goal_id: parseInt(row.goal_id, 10),
      goal_name: row.goal_name,
      goal_question: row.goal_question,
      goal_type: row.goal_type,
      is_enabled: row.is_enabled,
      total_sent: parseInt(row.total_sent, 10),
      total_responded: parseInt(row.total_responded, 10),
      total_insights: parseInt(row.total_insights, 10),
      response_rate_pct: row.response_rate_pct ? parseFloat(row.response_rate_pct) : null,
      insight_conversion_rate_pct: row.insight_conversion_rate_pct ? parseFloat(row.insight_conversion_rate_pct) : null,
      positive_responses: parseInt(row.positive_responses, 10),
      neutral_responses: parseInt(row.neutral_responses, 10),
      negative_responses: parseInt(row.negative_responses, 10),
      refusal_responses: parseInt(row.refusal_responses, 10),
      converted_count: parseInt(row.converted_count, 10),
      interested_count: parseInt(row.interested_count, 10),
      deferred_count: parseInt(row.deferred_count, 10),
      question_count: parseInt(row.question_count, 10),
      objection_count: parseInt(row.objection_count, 10),
      first_outreach_at: row.first_outreach_at,
      last_outreach_at: row.last_outreach_at,
    }));
  }

  /**
   * Get outreach time-windowed statistics
   */
  async getOutreachTimeStats(): Promise<OutreachTimeStats> {
    const result = await query<{
      sent_today: string;
      responded_today: string;
      sent_this_week: string;
      responded_this_week: string;
      sent_this_month: string;
      responded_this_month: string;
      total_sent: string;
      total_responded: string;
      total_insights: string;
      overall_response_rate_pct: string | null;
    }>('SELECT * FROM outreach_time_stats');

    const row = result.rows[0];
    if (!row) {
      return {
        sent_today: 0,
        responded_today: 0,
        sent_this_week: 0,
        responded_this_week: 0,
        sent_this_month: 0,
        responded_this_month: 0,
        total_sent: 0,
        total_responded: 0,
        total_insights: 0,
        overall_response_rate_pct: null,
      };
    }

    return {
      sent_today: parseInt(row.sent_today, 10),
      responded_today: parseInt(row.responded_today, 10),
      sent_this_week: parseInt(row.sent_this_week, 10),
      responded_this_week: parseInt(row.responded_this_week, 10),
      sent_this_month: parseInt(row.sent_this_month, 10),
      responded_this_month: parseInt(row.responded_this_month, 10),
      total_sent: parseInt(row.total_sent, 10),
      total_responded: parseInt(row.total_responded, 10),
      total_insights: parseInt(row.total_insights, 10),
      overall_response_rate_pct: row.overall_response_rate_pct ? parseFloat(row.overall_response_rate_pct) : null,
    };
  }

  /**
   * Get recent outreach history for admin dashboard
   */
  async getRecentOutreach(limit = 50): Promise<MemberOutreachWithUser[]> {
    const result = await query<MemberOutreachWithUser>(
      `SELECT mo.*, sm.slack_display_name, sm.slack_real_name
       FROM member_outreach mo
       LEFT JOIN slack_user_mappings sm ON sm.slack_user_id = mo.slack_user_id
       ORDER BY mo.sent_at DESC
       LIMIT $1`,
      [limit]
    );
    return result.rows;
  }

  /**
   * Get pending outreach (for tracking responses)
   */
  async getPendingOutreach(slackUserId: string): Promise<MemberOutreach | null> {
    const result = await query<MemberOutreach>(
      `SELECT * FROM member_outreach
       WHERE slack_user_id = $1 AND user_responded = FALSE
       ORDER BY sent_at DESC LIMIT 1`,
      [slackUserId]
    );
    return result.rows[0] || null;
  }

  /**
   * Get insight statistics for admin dashboard
   */
  async getInsightStats(): Promise<{
    members_with_insights: number;
    total_insights: number;
    from_conversation: number;
    from_manual: number;
  }> {
    const result = await query<{
      members_with_insights: string;
      total_insights: string;
      from_conversation: string;
      from_manual: string;
    }>(`
      SELECT
        COUNT(DISTINCT slack_user_id)::text as members_with_insights,
        COUNT(*)::text as total_insights,
        COUNT(*) FILTER (WHERE source_type = 'conversation')::text as from_conversation,
        COUNT(*) FILTER (WHERE source_type = 'manual')::text as from_manual
      FROM member_insights
      WHERE is_current = TRUE
    `);

    const row = result.rows[0];
    return {
      members_with_insights: parseInt(row.members_with_insights, 10),
      total_insights: parseInt(row.total_insights, 10),
      from_conversation: parseInt(row.from_conversation, 10),
      from_manual: parseInt(row.from_manual, 10),
    };
  }

  // ============== Unified Person View ==============

  /**
   * Get unified insights for a person by WorkOS user ID
   * Joins insights from both Slack conversations and email correspondence
   */
  async getUnifiedInsightsByWorkosUser(workosUserId: string): Promise<UnifiedPersonInsights | null> {
    // Fetch Slack user and email contact in parallel (independent queries)
    const [slackResult, emailResult] = await Promise.all([
      query<{
        slack_user_id: string;
        slack_email: string | null;
        slack_real_name: string | null;
        slack_display_name: string | null;
        created_at: Date;
        last_slack_activity_at: Date | null;
      }>(
        `SELECT slack_user_id, slack_email, slack_real_name, slack_display_name, created_at, last_slack_activity_at
         FROM slack_user_mappings
         WHERE workos_user_id = $1`,
        [workosUserId]
      ),
      query<{
        id: string;
        email: string;
        display_name: string | null;
        organization_id: string | null;
        first_seen_at: Date;
        last_seen_at: Date;
      }>(
        `SELECT id, email, display_name, organization_id, first_seen_at, last_seen_at
         FROM email_contacts
         WHERE workos_user_id = $1`,
        [workosUserId]
      ),
    ]);

    const slackUser = slackResult.rows[0];
    const emailContact = emailResult.rows[0];

    // If neither exists, return null
    if (!slackUser && !emailContact) {
      return null;
    }

    // Fetch organization, Slack insights, and email insights in parallel
    const [orgResult, slackInsights, emailActivityResult] = await Promise.all([
      // Organization name
      emailContact?.organization_id
        ? query<{ name: string }>(
            'SELECT name FROM organizations WHERE workos_organization_id = $1',
            [emailContact.organization_id]
          )
        : Promise.resolve({ rows: [] }),
      // Slack insights
      slackUser
        ? this.getInsightsForUser(slackUser.slack_user_id)
        : Promise.resolve([]),
      // Email activity insights
      emailContact
        ? query<EmailActivityInsight>(
            `SELECT
               eca.id,
               eca.subject,
               eca.insights,
               eca.direction,
               eca.email_date,
               eac.role
             FROM email_contact_activities eca
             INNER JOIN email_activity_contacts eac ON eac.activity_id = eca.id
             WHERE eac.contact_id = $1
             ORDER BY eca.email_date DESC`,
            [emailContact.id]
          )
        : Promise.resolve({ rows: [] }),
    ]);

    const organizationName = orgResult.rows[0]?.name || null;
    const emailInsights = emailActivityResult.rows;

    // Determine display name and email
    const displayName = slackUser?.slack_real_name ||
                        slackUser?.slack_display_name ||
                        emailContact?.display_name ||
                        null;
    const email = slackUser?.slack_email || emailContact?.email || null;

    // Calculate first seen and last activity
    const dates = [
      slackUser?.created_at,
      emailContact?.first_seen_at,
    ].filter(Boolean) as Date[];
    const firstSeenAt = dates.length > 0 ? new Date(Math.min(...dates.map(d => d.getTime()))) : null;

    const activityDates = [
      slackUser?.last_slack_activity_at,
      emailContact?.last_seen_at,
    ].filter(Boolean) as Date[];
    const lastActivityAt = activityDates.length > 0
      ? new Date(Math.max(...activityDates.map(d => d.getTime())))
      : null;

    return {
      workos_user_id: workosUserId,
      slack_user_id: slackUser?.slack_user_id || null,
      email_contact_id: emailContact?.id || null,
      display_name: displayName,
      email,
      organization_name: organizationName,
      slack_insights: slackInsights,
      email_insights: emailInsights,
      first_seen_at: firstSeenAt,
      last_activity_at: lastActivityAt,
    };
  }

  /**
   * Get unified insights for a person by Slack user ID
   * First looks up the WorkOS user ID, then fetches unified view
   */
  async getUnifiedInsightsBySlackUser(slackUserId: string): Promise<UnifiedPersonInsights> {
    // Look up workos_user_id from slack mapping
    const mappingResult = await query<{
      workos_user_id: string | null;
      slack_email: string | null;
      slack_real_name: string | null;
      slack_display_name: string | null;
      created_at: Date;
      last_slack_activity_at: Date | null;
    }>(
      `SELECT workos_user_id, slack_email, slack_real_name, slack_display_name, created_at, last_slack_activity_at
       FROM slack_user_mappings
       WHERE slack_user_id = $1`,
      [slackUserId]
    );
    const slackUser = mappingResult.rows[0];

    // If user has workos_user_id, get the full unified view
    if (slackUser?.workos_user_id) {
      const unified = await this.getUnifiedInsightsByWorkosUser(slackUser.workos_user_id);
      if (unified) return unified;
    }

    // Otherwise, just get Slack insights (no email link yet)
    const slackInsights = await this.getInsightsForUser(slackUserId);

    return {
      workos_user_id: slackUser?.workos_user_id || null,
      slack_user_id: slackUserId,
      email_contact_id: null,
      display_name: slackUser?.slack_real_name || slackUser?.slack_display_name || null,
      email: slackUser?.slack_email || null,
      organization_name: null,
      slack_insights: slackInsights,
      email_insights: [],
      first_seen_at: slackUser?.created_at || null,
      last_activity_at: slackUser?.last_slack_activity_at || null,
    };
  }

  /**
   * Get unified insights for a person by email address
   * First looks up the email contact, then fetches unified view via WorkOS ID
   */
  async getUnifiedInsightsByEmail(email: string): Promise<UnifiedPersonInsights | null> {
    // Look up email contact
    const contactResult = await query<{
      id: string;
      email: string;
      display_name: string | null;
      workos_user_id: string | null;
      organization_id: string | null;
      first_seen_at: Date;
      last_seen_at: Date;
    }>(
      `SELECT id, email, display_name, workos_user_id, organization_id, first_seen_at, last_seen_at
       FROM email_contacts
       WHERE LOWER(email) = LOWER($1)`,
      [email]
    );
    const emailContact = contactResult.rows[0];

    if (!emailContact) {
      return null;
    }

    // If contact has workos_user_id, get the full unified view
    if (emailContact.workos_user_id) {
      return this.getUnifiedInsightsByWorkosUser(emailContact.workos_user_id);
    }

    // Otherwise, just get email insights (no Slack link yet)
    const emailActivityResult = await query<EmailActivityInsight>(
      `SELECT
         eca.id,
         eca.subject,
         eca.insights,
         eca.direction,
         eca.email_date,
         eac.role
       FROM email_contact_activities eca
       INNER JOIN email_activity_contacts eac ON eac.activity_id = eca.id
       WHERE eac.contact_id = $1
       ORDER BY eca.email_date DESC`,
      [emailContact.id]
    );

    // Get organization name
    let organizationName: string | null = null;
    if (emailContact.organization_id) {
      const orgResult = await query<{ name: string }>(
        'SELECT name FROM organizations WHERE workos_organization_id = $1',
        [emailContact.organization_id]
      );
      organizationName = orgResult.rows[0]?.name || null;
    }

    return {
      workos_user_id: null,
      slack_user_id: null,
      email_contact_id: emailContact.id,
      display_name: emailContact.display_name,
      email: emailContact.email,
      organization_name: organizationName,
      slack_insights: [],
      email_insights: emailActivityResult.rows,
      first_seen_at: emailContact.first_seen_at,
      last_activity_at: emailContact.last_seen_at,
    };
  }

  // ============== Sensitive Topic Detection ==============

  /**
   * Check if a message contains sensitive topics
   * Uses database patterns for journalist-proofing
   */
  async checkSensitiveTopic(messageText: string): Promise<SensitiveTopicResult> {
    const result = await query<{
      is_sensitive: boolean;
      pattern_id: number | null;
      category: SensitiveCategory | null;
      severity: SensitiveSeverity | null;
      deflect_response: string | null;
    }>(
      'SELECT * FROM check_sensitive_topic($1)',
      [messageText]
    );

    const row = result.rows[0];
    return {
      isSensitive: row?.is_sensitive ?? false,
      patternId: row?.pattern_id ?? null,
      category: row?.category ?? null,
      severity: row?.severity ?? null,
      deflectResponse: row?.deflect_response ?? null,
    };
  }

  /**
   * Check if a Slack user is a known media contact
   */
  async isKnownMediaContact(slackUserId: string): Promise<KnownMediaContact | null> {
    const result = await query<{
      id: number;
      slack_user_id: string | null;
      email: string | null;
      name: string | null;
      organization: string | null;
      role: string | null;
      handling_level: 'standard' | 'careful' | 'executive_only';
    }>(
      `SELECT id, slack_user_id, email, name, organization, role, handling_level
       FROM known_media_contacts
       WHERE slack_user_id = $1 AND is_active = TRUE`,
      [slackUserId]
    );

    const row = result.rows[0];
    if (!row) return null;

    return {
      id: row.id,
      slackUserId: row.slack_user_id,
      email: row.email,
      name: row.name,
      organization: row.organization,
      role: row.role,
      handlingLevel: row.handling_level,
    };
  }

  /**
   * Flag a conversation for review
   */
  async flagConversation(params: {
    slackUserId: string;
    slackChannelId?: string;
    messageText: string;
    matchedPatternId?: number;
    matchedCategory?: SensitiveCategory;
    severity?: SensitiveSeverity;
    responseGiven?: string;
    wasDeflected?: boolean;
  }): Promise<FlaggedConversation> {
    const result = await query<{
      id: number;
      slack_user_id: string;
      slack_channel_id: string | null;
      message_text: string;
      matched_category: SensitiveCategory | null;
      severity: SensitiveSeverity | null;
      response_given: string | null;
      was_deflected: boolean;
      created_at: Date;
    }>(
      `INSERT INTO flagged_conversations (
        slack_user_id, slack_channel_id, message_text,
        matched_pattern_id, matched_category, severity,
        response_given, was_deflected
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING id, slack_user_id, slack_channel_id, message_text,
                matched_category, severity, response_given, was_deflected, created_at`,
      [
        params.slackUserId,
        params.slackChannelId || null,
        params.messageText,
        params.matchedPatternId || null,
        params.matchedCategory || null,
        params.severity || null,
        params.responseGiven || null,
        params.wasDeflected ?? false,
      ]
    );

    const row = result.rows[0];
    return {
      id: row.id,
      slackUserId: row.slack_user_id,
      slackChannelId: row.slack_channel_id,
      messageText: row.message_text,
      matchedCategory: row.matched_category,
      severity: row.severity,
      responseGiven: row.response_given,
      wasDeflected: row.was_deflected,
      createdAt: row.created_at,
    };
  }

  /**
   * Add a known media contact
   */
  async addMediaContact(params: {
    slackUserId?: string;
    email?: string;
    name?: string;
    organization?: string;
    role?: string;
    notes?: string;
    handlingLevel?: 'standard' | 'careful' | 'executive_only';
    addedBy?: number;
  }): Promise<KnownMediaContact> {
    const result = await query<{
      id: number;
      slack_user_id: string | null;
      email: string | null;
      name: string | null;
      organization: string | null;
      role: string | null;
      handling_level: 'standard' | 'careful' | 'executive_only';
    }>(
      `INSERT INTO known_media_contacts (
        slack_user_id, email, name, organization, role, notes, handling_level, added_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (slack_user_id) DO UPDATE SET
        email = EXCLUDED.email,
        name = EXCLUDED.name,
        organization = EXCLUDED.organization,
        role = EXCLUDED.role,
        notes = EXCLUDED.notes,
        handling_level = EXCLUDED.handling_level,
        updated_at = NOW()
      RETURNING id, slack_user_id, email, name, organization, role, handling_level`,
      [
        params.slackUserId || null,
        params.email || null,
        params.name || null,
        params.organization || null,
        params.role || null,
        params.notes || null,
        params.handlingLevel || 'standard',
        params.addedBy || null,
      ]
    );

    const row = result.rows[0];
    return {
      id: row.id,
      slackUserId: row.slack_user_id,
      email: row.email,
      name: row.name,
      organization: row.organization,
      role: row.role,
      handlingLevel: row.handling_level,
    };
  }

  /**
   * Get flagged conversations pending review
   */
  async getFlaggedConversations(options: {
    unreviewedOnly?: boolean;
    severity?: SensitiveSeverity;
    limit?: number;
  } = {}): Promise<Array<FlaggedConversation & { userName?: string; userEmail?: string }>> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIndex = 1;

    if (options.unreviewedOnly) {
      conditions.push('reviewed_at IS NULL');
    }
    if (options.severity) {
      conditions.push(`severity = $${paramIndex++}`);
      params.push(options.severity);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = options.limit || 100;

    const result = await query<{
      id: number;
      slack_user_id: string;
      slack_channel_id: string | null;
      message_text: string;
      matched_category: SensitiveCategory | null;
      severity: SensitiveSeverity | null;
      response_given: string | null;
      was_deflected: boolean;
      created_at: Date;
      user_name: string | null;
      user_email: string | null;
    }>(
      `SELECT
        fc.id, fc.slack_user_id, fc.slack_channel_id, fc.message_text,
        fc.matched_category, fc.severity, fc.response_given, fc.was_deflected, fc.created_at,
        sm.slack_real_name as user_name, sm.slack_email as user_email
      FROM flagged_conversations fc
      LEFT JOIN slack_user_mappings sm ON sm.slack_user_id = fc.slack_user_id
      ${whereClause}
      ORDER BY
        CASE fc.severity WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 END,
        fc.created_at DESC
      LIMIT $${paramIndex}`,
      [...params, limit]
    );

    return result.rows.map(row => ({
      id: row.id,
      slackUserId: row.slack_user_id,
      slackChannelId: row.slack_channel_id,
      messageText: row.message_text,
      matchedCategory: row.matched_category,
      severity: row.severity,
      responseGiven: row.response_given,
      wasDeflected: row.was_deflected,
      createdAt: row.created_at,
      userName: row.user_name ?? undefined,
      userEmail: row.user_email ?? undefined,
    }));
  }

  /**
   * Mark a flagged conversation as reviewed
   */
  async reviewFlaggedConversation(
    id: number,
    reviewedBy: number,
    notes?: string
  ): Promise<void> {
    await query(
      `UPDATE flagged_conversations
       SET reviewed_by = $2, reviewed_at = NOW(), review_notes = $3
       WHERE id = $1`,
      [id, reviewedBy, notes || null]
    );
  }
}
