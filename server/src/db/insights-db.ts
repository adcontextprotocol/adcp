import { query } from './client.js';
import { logger } from '../logger.js';

// =====================================================
// TYPES
// =====================================================

export type OutreachType = 'account_link' | 'introduction' | 'insight_goal' | 'custom';
export type OutreachTone = 'casual' | 'professional' | 'brief';
export type OutreachApproach = 'direct' | 'conversational' | 'minimal';

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
  thread_id: string | null;
  dm_channel_id: string | null;
  initial_message: string | null;
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

export interface CreateOutreachInput {
  slack_user_id: string;
  outreach_type: OutreachType;
  thread_id?: string;
  dm_channel_id?: string;
  initial_message?: string;
  tone?: string;
  approach?: string;
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

export interface OutreachStats {
  sent_today: number;
  sent_this_week: number;
  total_responded: number;
  total_sent: number;
  response_rate: number;
  insights_gathered: number;
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
 * Database operations for outreach, sensitive topic detection, and media contacts
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
        slack_user_id, outreach_type, thread_id, dm_channel_id,
        initial_message, tone, approach
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *`,
      [
        input.slack_user_id,
        input.outreach_type,
        input.thread_id || null,
        input.dm_channel_id || null,
        input.initial_message || null,
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
   * Mark outreach as responded
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

    // Update linked user_goal_history status to 'responded'
    const goalStatus = analysis.sentiment === 'refusal' ? 'declined' : 'responded';
    await query(
      `UPDATE user_goal_history
       SET status = $2,
           response_text = $3,
           response_sentiment = $4,
           response_intent = $5,
           updated_at = NOW()
       WHERE outreach_id = $1
         AND status = 'sent'`,
      [id, goalStatus, responseText, analysis.sentiment, analysis.intent]
    );

    return analysis;
  }

  /**
   * Mark outreach as converted (user completed the desired action, e.g., clicked link and signed up)
   */
  async markOutreachConverted(id: number, conversionNote: string): Promise<void> {
    await query(
      `UPDATE member_outreach
       SET
         user_responded = TRUE,
         response_received_at = NOW(),
         insight_extracted = TRUE,
         response_text = $2,
         response_sentiment = 'positive',
         response_intent = 'converted'
       WHERE id = $1`,
      [id, conversionNote]
    );
  }

  /**
   * Link an outreach record to a conversation thread
   * Called when a user responds to outreach and a thread is created
   */
  async linkOutreachToThread(outreachId: number, threadId: string): Promise<void> {
    // Validate UUID format for data integrity
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(threadId)) {
      throw new Error('Invalid thread ID format');
    }
    await query(
      `UPDATE member_outreach SET thread_id = $2 WHERE id = $1`,
      [outreachId, threadId]
    );
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
      total_sent: totalSent,
      response_rate: totalSent > 0 ? Math.round((100 * totalResponded) / totalSent) : 0,
      insights_gathered: parseInt(row.insights_gathered, 10),
    };
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
   * Get outreach history for a specific user
   */
  async getOutreachForUser(slackUserId: string, limit = 20): Promise<MemberOutreachWithUser[]> {
    const result = await query<MemberOutreachWithUser>(
      `SELECT mo.*, sm.slack_display_name, sm.slack_real_name
       FROM member_outreach mo
       LEFT JOIN slack_user_mappings sm ON sm.slack_user_id = mo.slack_user_id
       WHERE mo.slack_user_id = $1
       ORDER BY mo.sent_at DESC
       LIMIT $2`,
      [slackUserId, limit]
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
