import { query } from './client.js';
import { v4 as uuidv4 } from 'uuid';

/**
 * Event types for member search analytics
 */
export type MemberSearchEventType =
  | 'search_impression' // Member appeared in search results
  | 'profile_click' // User clicked to view member profile
  | 'introduction_request' // User requested an introduction
  | 'introduction_sent'; // Addie sent the introduction email

/**
 * Input for recording a search impression
 */
export interface SearchImpressionInput {
  member_profile_id: string;
  search_query: string;
  search_session_id: string;
  searcher_user_id?: string;
  addie_thread_id?: string;
  addie_message_id?: string;
  context?: {
    position?: number;
    total_results?: number;
    offerings_filter?: string[];
  };
}

/**
 * Input for recording an introduction request
 */
export interface IntroductionRequestInput {
  member_profile_id: string;
  search_session_id?: string;
  searcher_user_id?: string;
  searcher_email: string;
  searcher_name: string;
  searcher_company?: string;
  addie_thread_id?: string;
  addie_message_id?: string;
  context?: {
    message?: string;
    search_query?: string;
    reasoning?: string;
  };
}

/**
 * Analytics summary for a member profile
 */
export interface MemberSearchAnalyticsSummary {
  member_profile_id: string;
  total_impressions: number;
  total_clicks: number;
  total_intro_requests: number;
  total_intros_sent: number;
  impressions_last_7_days: number;
  impressions_last_30_days: number;
  clicks_last_7_days: number;
  clicks_last_30_days: number;
  intro_requests_last_7_days: number;
  intro_requests_last_30_days: number;
}

/**
 * Database operations for member search analytics
 */
export class MemberSearchAnalyticsDatabase {
  /**
   * Record a search impression for a member
   */
  async recordSearchImpression(input: SearchImpressionInput): Promise<string> {
    const id = uuidv4();
    await query(
      `INSERT INTO member_search_analytics (
        id, member_profile_id, event_type, search_query, search_session_id,
        searcher_user_id, addie_thread_id, addie_message_id, context
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        id,
        input.member_profile_id,
        'search_impression',
        input.search_query,
        input.search_session_id,
        input.searcher_user_id || null,
        input.addie_thread_id || null,
        input.addie_message_id || null,
        JSON.stringify(input.context || {}),
      ]
    );
    return id;
  }

  /**
   * Record multiple search impressions in batch (more efficient)
   */
  async recordSearchImpressionsBatch(
    impressions: SearchImpressionInput[]
  ): Promise<string[]> {
    if (impressions.length === 0) return [];

    const ids: string[] = [];
    const values: string[] = [];
    const params: unknown[] = [];
    let paramIndex = 1;

    for (const input of impressions) {
      const id = uuidv4();
      ids.push(id);
      values.push(
        `($${paramIndex++}, $${paramIndex++}, 'search_impression', $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++})`
      );
      params.push(
        id,
        input.member_profile_id,
        input.search_query,
        input.search_session_id,
        input.searcher_user_id || null,
        input.addie_thread_id || null,
        input.addie_message_id || null,
        JSON.stringify(input.context || {})
      );
    }

    await query(
      `INSERT INTO member_search_analytics (
        id, member_profile_id, event_type, search_query, search_session_id,
        searcher_user_id, addie_thread_id, addie_message_id, context
      ) VALUES ${values.join(', ')}`,
      params
    );

    return ids;
  }

  /**
   * Record a profile click
   */
  async recordProfileClick(input: {
    member_profile_id: string;
    searcher_user_id?: string;
    search_session_id?: string;
    addie_thread_id?: string;
  }): Promise<string> {
    const id = uuidv4();
    await query(
      `INSERT INTO member_search_analytics (
        id, member_profile_id, event_type, search_session_id, searcher_user_id, addie_thread_id
      ) VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        id,
        input.member_profile_id,
        'profile_click',
        input.search_session_id || null,
        input.searcher_user_id || null,
        input.addie_thread_id || null,
      ]
    );
    return id;
  }

  /**
   * Record an introduction request
   */
  async recordIntroductionRequest(input: IntroductionRequestInput): Promise<string> {
    const id = uuidv4();
    await query(
      `INSERT INTO member_search_analytics (
        id, member_profile_id, event_type, search_session_id,
        searcher_user_id, searcher_email, searcher_name, searcher_company,
        addie_thread_id, addie_message_id, context
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        id,
        input.member_profile_id,
        'introduction_request',
        input.search_session_id || null,
        input.searcher_user_id || null,
        input.searcher_email,
        input.searcher_name,
        input.searcher_company || null,
        input.addie_thread_id || null,
        input.addie_message_id || null,
        JSON.stringify(input.context || {}),
      ]
    );
    return id;
  }

  /**
   * Record that an introduction email was sent
   */
  async recordIntroductionSent(input: {
    member_profile_id: string;
    introduction_request_id?: string;
    searcher_email: string;
    searcher_name: string;
    context?: { email_id?: string };
  }): Promise<string> {
    const id = uuidv4();
    await query(
      `INSERT INTO member_search_analytics (
        id, member_profile_id, event_type, searcher_email, searcher_name, context
      ) VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        id,
        input.member_profile_id,
        'introduction_sent',
        input.searcher_email,
        input.searcher_name,
        JSON.stringify(input.context || {}),
      ]
    );
    return id;
  }

  /**
   * Get analytics summary for a member profile
   */
  async getAnalyticsSummary(memberProfileId: string): Promise<MemberSearchAnalyticsSummary> {
    const result = await query<{
      total_impressions: string;
      total_clicks: string;
      total_intro_requests: string;
      total_intros_sent: string;
      impressions_last_7_days: string;
      impressions_last_30_days: string;
      clicks_last_7_days: string;
      clicks_last_30_days: string;
      intro_requests_last_7_days: string;
      intro_requests_last_30_days: string;
    }>(
      `SELECT
        COUNT(*) FILTER (WHERE event_type = 'search_impression') as total_impressions,
        COUNT(*) FILTER (WHERE event_type = 'profile_click') as total_clicks,
        COUNT(*) FILTER (WHERE event_type = 'introduction_request') as total_intro_requests,
        COUNT(*) FILTER (WHERE event_type = 'introduction_sent') as total_intros_sent,
        COUNT(*) FILTER (WHERE event_type = 'search_impression' AND created_at >= NOW() - INTERVAL '7 days') as impressions_last_7_days,
        COUNT(*) FILTER (WHERE event_type = 'search_impression' AND created_at >= NOW() - INTERVAL '30 days') as impressions_last_30_days,
        COUNT(*) FILTER (WHERE event_type = 'profile_click' AND created_at >= NOW() - INTERVAL '7 days') as clicks_last_7_days,
        COUNT(*) FILTER (WHERE event_type = 'profile_click' AND created_at >= NOW() - INTERVAL '30 days') as clicks_last_30_days,
        COUNT(*) FILTER (WHERE event_type = 'introduction_request' AND created_at >= NOW() - INTERVAL '7 days') as intro_requests_last_7_days,
        COUNT(*) FILTER (WHERE event_type = 'introduction_request' AND created_at >= NOW() - INTERVAL '30 days') as intro_requests_last_30_days
      FROM member_search_analytics
      WHERE member_profile_id = $1`,
      [memberProfileId]
    );

    const row = result.rows[0];
    return {
      member_profile_id: memberProfileId,
      total_impressions: parseInt(row?.total_impressions || '0', 10),
      total_clicks: parseInt(row?.total_clicks || '0', 10),
      total_intro_requests: parseInt(row?.total_intro_requests || '0', 10),
      total_intros_sent: parseInt(row?.total_intros_sent || '0', 10),
      impressions_last_7_days: parseInt(row?.impressions_last_7_days || '0', 10),
      impressions_last_30_days: parseInt(row?.impressions_last_30_days || '0', 10),
      clicks_last_7_days: parseInt(row?.clicks_last_7_days || '0', 10),
      clicks_last_30_days: parseInt(row?.clicks_last_30_days || '0', 10),
      intro_requests_last_7_days: parseInt(row?.intro_requests_last_7_days || '0', 10),
      intro_requests_last_30_days: parseInt(row?.intro_requests_last_30_days || '0', 10),
    };
  }

  /**
   * Get global search analytics (for admin dashboard)
   */
  async getGlobalAnalytics(days: number = 30): Promise<{
    total_searches: number;
    total_impressions: number;
    total_clicks: number;
    total_intro_requests: number;
    total_intros_sent: number;
    unique_searchers: number;
    top_queries: Array<{ query: string; count: number }>;
    top_members: Array<{ member_profile_id: string; impressions: number }>;
  }> {
    // Get totals
    const totalsResult = await query<{
      total_searches: string;
      total_impressions: string;
      total_clicks: string;
      total_intro_requests: string;
      total_intros_sent: string;
      unique_searchers: string;
    }>(
      `SELECT
        COUNT(DISTINCT search_session_id) FILTER (WHERE event_type = 'search_impression') as total_searches,
        COUNT(*) FILTER (WHERE event_type = 'search_impression') as total_impressions,
        COUNT(*) FILTER (WHERE event_type = 'profile_click') as total_clicks,
        COUNT(*) FILTER (WHERE event_type = 'introduction_request') as total_intro_requests,
        COUNT(*) FILTER (WHERE event_type = 'introduction_sent') as total_intros_sent,
        COUNT(DISTINCT COALESCE(searcher_user_id, searcher_email)) as unique_searchers
      FROM member_search_analytics
      WHERE created_at >= NOW() - INTERVAL '1 day' * $1`,
      [days]
    );

    // Get top queries
    const queriesResult = await query<{ query: string; count: string }>(
      `SELECT search_query as query, COUNT(DISTINCT search_session_id) as count
      FROM member_search_analytics
      WHERE event_type = 'search_impression'
        AND search_query IS NOT NULL
        AND created_at >= NOW() - INTERVAL '1 day' * $1
      GROUP BY search_query
      ORDER BY count DESC
      LIMIT 10`,
      [days]
    );

    // Get top members by impressions
    const membersResult = await query<{ member_profile_id: string; impressions: string }>(
      `SELECT member_profile_id, COUNT(*) as impressions
      FROM member_search_analytics
      WHERE event_type = 'search_impression'
        AND created_at >= NOW() - INTERVAL '1 day' * $1
      GROUP BY member_profile_id
      ORDER BY impressions DESC
      LIMIT 10`,
      [days]
    );

    const totals = totalsResult.rows[0];
    return {
      total_searches: parseInt(totals?.total_searches || '0', 10),
      total_impressions: parseInt(totals?.total_impressions || '0', 10),
      total_clicks: parseInt(totals?.total_clicks || '0', 10),
      total_intro_requests: parseInt(totals?.total_intro_requests || '0', 10),
      total_intros_sent: parseInt(totals?.total_intros_sent || '0', 10),
      unique_searchers: parseInt(totals?.unique_searchers || '0', 10),
      top_queries: queriesResult.rows.map((r) => ({
        query: r.query,
        count: parseInt(r.count, 10),
      })),
      top_members: membersResult.rows.map((r) => ({
        member_profile_id: r.member_profile_id,
        impressions: parseInt(r.impressions, 10),
      })),
    };
  }

  /**
   * Get recent introduction requests for a member (for their dashboard)
   */
  async getRecentIntroductions(
    memberProfileId: string,
    limit: number = 10
  ): Promise<Array<{
    id: string;
    event_type: MemberSearchEventType;
    searcher_name: string;
    searcher_email: string;
    searcher_company: string | null;
    search_query: string | null;
    created_at: Date;
  }>> {
    const result = await query<{
      id: string;
      event_type: MemberSearchEventType;
      searcher_name: string;
      searcher_email: string;
      searcher_company: string | null;
      context: string;
      created_at: Date;
    }>(
      `SELECT id, event_type, searcher_name, searcher_email, searcher_company, context, created_at
      FROM member_search_analytics
      WHERE member_profile_id = $1
        AND event_type IN ('introduction_request', 'introduction_sent')
      ORDER BY created_at DESC
      LIMIT $2`,
      [memberProfileId, limit]
    );

    return result.rows.map((row) => {
      const context = typeof row.context === 'string' ? JSON.parse(row.context) : row.context;
      return {
        id: row.id,
        event_type: row.event_type,
        searcher_name: row.searcher_name,
        searcher_email: row.searcher_email,
        searcher_company: row.searcher_company,
        search_query: context?.search_query || null,
        created_at: row.created_at,
      };
    });
  }

  /**
   * Get all recent introductions (for admin dashboard)
   */
  async getRecentIntroductionsGlobal(
    limit: number = 20
  ): Promise<Array<{
    id: string;
    event_type: MemberSearchEventType;
    member_profile_id: string;
    searcher_name: string;
    searcher_email: string;
    searcher_company: string | null;
    search_query: string | null;
    reasoning: string | null;
    message: string | null;
    created_at: Date;
  }>> {
    const result = await query<{
      id: string;
      event_type: MemberSearchEventType;
      member_profile_id: string;
      searcher_name: string;
      searcher_email: string;
      searcher_company: string | null;
      context: string;
      created_at: Date;
    }>(
      `SELECT id, event_type, member_profile_id, searcher_name, searcher_email, searcher_company, context, created_at
      FROM member_search_analytics
      WHERE event_type IN ('introduction_request', 'introduction_sent')
      ORDER BY created_at DESC
      LIMIT $1`,
      [limit]
    );

    return result.rows.map((row) => {
      const context = typeof row.context === 'string' ? JSON.parse(row.context) : row.context;
      return {
        id: row.id,
        event_type: row.event_type,
        member_profile_id: row.member_profile_id,
        searcher_name: row.searcher_name,
        searcher_email: row.searcher_email,
        searcher_company: row.searcher_company,
        search_query: context?.search_query || null,
        reasoning: context?.reasoning || null,
        message: context?.message || null,
        created_at: row.created_at,
      };
    });
  }
}
