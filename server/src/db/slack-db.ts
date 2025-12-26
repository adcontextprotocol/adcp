import { query } from './client.js';
import type {
  SlackUserMapping,
  SlackMappingStatus,
  SlackMappingSource,
  SlackMappingStats,
} from '../slack/types.js';

/**
 * Escape LIKE pattern wildcards to prevent SQL injection
 */
function escapeLikePattern(str: string): string {
  return str.replace(/[%_\\]/g, '\\$&');
}

/**
 * Database operations for Slack user mappings
 */
export class SlackDatabase {
  // ============== User Mappings ==============

  /**
   * Upsert a Slack user from sync
   */
  async upsertSlackUser(user: {
    slack_user_id: string;
    slack_email: string | null;
    slack_display_name: string | null;
    slack_real_name: string | null;
    slack_is_bot: boolean;
    slack_is_deleted: boolean;
  }): Promise<SlackUserMapping> {
    const result = await query<SlackUserMapping>(
      `INSERT INTO slack_user_mappings (
        slack_user_id, slack_email, slack_display_name, slack_real_name,
        slack_is_bot, slack_is_deleted, last_slack_sync_at
      ) VALUES ($1, $2, $3, $4, $5, $6, NOW())
      ON CONFLICT (slack_user_id)
      DO UPDATE SET
        slack_email = EXCLUDED.slack_email,
        slack_display_name = EXCLUDED.slack_display_name,
        slack_real_name = EXCLUDED.slack_real_name,
        slack_is_bot = EXCLUDED.slack_is_bot,
        slack_is_deleted = EXCLUDED.slack_is_deleted,
        last_slack_sync_at = NOW(),
        updated_at = NOW()
      RETURNING *`,
      [
        user.slack_user_id,
        user.slack_email,
        user.slack_display_name,
        user.slack_real_name,
        user.slack_is_bot,
        user.slack_is_deleted,
      ]
    );

    return result.rows[0];
  }

  /**
   * Get a Slack user mapping by Slack user ID
   */
  async getBySlackUserId(slackUserId: string): Promise<SlackUserMapping | null> {
    const result = await query<SlackUserMapping>(
      'SELECT * FROM slack_user_mappings WHERE slack_user_id = $1',
      [slackUserId]
    );
    return result.rows[0] || null;
  }

  /**
   * Get a Slack user mapping by WorkOS user ID
   */
  async getByWorkosUserId(workosUserId: string): Promise<SlackUserMapping | null> {
    const result = await query<SlackUserMapping>(
      'SELECT * FROM slack_user_mappings WHERE workos_user_id = $1',
      [workosUserId]
    );
    return result.rows[0] || null;
  }

  /**
   * Find Slack user mapping by email
   */
  async findByEmail(email: string): Promise<SlackUserMapping | null> {
    const result = await query<SlackUserMapping>(
      'SELECT * FROM slack_user_mappings WHERE LOWER(slack_email) = LOWER($1)',
      [email]
    );
    return result.rows[0] || null;
  }

  /**
   * Map a Slack user to a WorkOS user
   */
  async mapUser(input: {
    slack_user_id: string;
    workos_user_id: string;
    mapping_source: SlackMappingSource;
    mapped_by_user_id?: string;
  }): Promise<SlackUserMapping | null> {
    const result = await query<SlackUserMapping>(
      `UPDATE slack_user_mappings
       SET workos_user_id = $1,
           mapping_status = 'mapped',
           mapping_source = $2,
           mapped_at = NOW(),
           mapped_by_user_id = $3,
           updated_at = NOW()
       WHERE slack_user_id = $4
       RETURNING *`,
      [
        input.workos_user_id,
        input.mapping_source,
        input.mapped_by_user_id || null,
        input.slack_user_id,
      ]
    );
    return result.rows[0] || null;
  }

  /**
   * Unmap a Slack user from a WorkOS user
   */
  async unmapUser(slackUserId: string): Promise<SlackUserMapping | null> {
    const result = await query<SlackUserMapping>(
      `UPDATE slack_user_mappings
       SET workos_user_id = NULL,
           mapping_status = 'unmapped',
           mapping_source = NULL,
           mapped_at = NULL,
           mapped_by_user_id = NULL,
           updated_at = NOW()
       WHERE slack_user_id = $1
       RETURNING *`,
      [slackUserId]
    );
    return result.rows[0] || null;
  }

  /**
   * Get all Slack user mappings
   */
  async getAllMappings(options: {
    status?: SlackMappingStatus;
    includeBots?: boolean;
    includeDeleted?: boolean;
    search?: string;
    limit?: number;
    offset?: number;
  } = {}): Promise<SlackUserMapping[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIndex = 1;

    if (options.status) {
      conditions.push(`mapping_status = $${paramIndex++}`);
      params.push(options.status);
    }

    if (!options.includeBots) {
      conditions.push('slack_is_bot = false');
    }

    if (!options.includeDeleted) {
      conditions.push('slack_is_deleted = false');
    }

    if (options.search) {
      conditions.push(`(
        slack_email ILIKE $${paramIndex} OR
        slack_display_name ILIKE $${paramIndex} OR
        slack_real_name ILIKE $${paramIndex}
      )`);
      params.push(`%${escapeLikePattern(options.search)}%`);
      paramIndex++;
    }

    const whereClause = conditions.length > 0
      ? `WHERE ${conditions.join(' AND ')}`
      : '';

    let sql = `
      SELECT * FROM slack_user_mappings
      ${whereClause}
      ORDER BY
        CASE WHEN mapping_status = 'mapped' THEN 0
             WHEN mapping_status = 'pending_verification' THEN 1
             ELSE 2
        END,
        slack_real_name NULLS LAST,
        slack_display_name NULLS LAST,
        slack_email NULLS LAST
    `;

    if (options.limit) {
      sql += ` LIMIT $${paramIndex++}`;
      params.push(options.limit);
    }

    if (options.offset) {
      sql += ` OFFSET $${paramIndex++}`;
      params.push(options.offset);
    }

    const result = await query<SlackUserMapping>(sql, params);
    return result.rows;
  }

  /**
   * Get unmapped Slack users (for nudge targeting)
   */
  async getUnmappedUsers(options: {
    excludeOptedOut?: boolean;
    excludeRecentlyNudged?: boolean;
    recentNudgeDays?: number;
    limit?: number;
  } = {}): Promise<SlackUserMapping[]> {
    const conditions: string[] = [
      "mapping_status = 'unmapped'",
      'slack_is_bot = false',
      'slack_is_deleted = false',
    ];
    const params: unknown[] = [];
    let paramIndex = 1;

    if (options.excludeOptedOut !== false) {
      conditions.push('nudge_opt_out = false');
    }

    if (options.excludeRecentlyNudged !== false) {
      const days = options.recentNudgeDays ?? 30;
      conditions.push(`(last_nudge_at IS NULL OR last_nudge_at < NOW() - INTERVAL '${days} days')`);
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    let sql = `
      SELECT * FROM slack_user_mappings
      ${whereClause}
      ORDER BY nudge_count ASC, created_at ASC
    `;

    if (options.limit) {
      sql += ` LIMIT $${paramIndex++}`;
      params.push(options.limit);
    }

    const result = await query<SlackUserMapping>(sql, params);
    return result.rows;
  }

  /**
   * Get mapped users
   */
  async getMappedUsers(options: {
    search?: string;
    limit?: number;
    offset?: number;
  } = {}): Promise<SlackUserMapping[]> {
    return this.getAllMappings({
      ...options,
      status: 'mapped',
    });
  }

  /**
   * Get mapping statistics
   */
  async getStats(): Promise<SlackMappingStats> {
    const result = await query<{
      total: string;
      mapped: string;
      unmapped: string;
      pending_verification: string;
      bots: string;
      deleted: string;
      opted_out: string;
    }>(
      `SELECT
        COUNT(*)::text AS total,
        COUNT(*) FILTER (WHERE mapping_status = 'mapped')::text AS mapped,
        COUNT(*) FILTER (WHERE mapping_status = 'unmapped' AND slack_is_bot = false AND slack_is_deleted = false)::text AS unmapped,
        COUNT(*) FILTER (WHERE mapping_status = 'pending_verification')::text AS pending_verification,
        COUNT(*) FILTER (WHERE slack_is_bot = true)::text AS bots,
        COUNT(*) FILTER (WHERE slack_is_deleted = true)::text AS deleted,
        COUNT(*) FILTER (WHERE nudge_opt_out = true)::text AS opted_out
       FROM slack_user_mappings`
    );

    const row = result.rows[0];
    return {
      total: parseInt(row.total, 10),
      mapped: parseInt(row.mapped, 10),
      unmapped: parseInt(row.unmapped, 10),
      pending_verification: parseInt(row.pending_verification, 10),
      bots: parseInt(row.bots, 10),
      deleted: parseInt(row.deleted, 10),
      opted_out: parseInt(row.opted_out, 10),
    };
  }

  // ============== Nudge Tracking ==============

  /**
   * Record that a nudge was sent to a user
   */
  async recordNudge(slackUserId: string): Promise<void> {
    await query(
      `UPDATE slack_user_mappings
       SET last_nudge_at = NOW(),
           nudge_count = nudge_count + 1,
           updated_at = NOW()
       WHERE slack_user_id = $1`,
      [slackUserId]
    );
  }

  /**
   * Set opt-out status for a user
   */
  async setOptOut(slackUserId: string, optOut: boolean): Promise<SlackUserMapping | null> {
    const result = await query<SlackUserMapping>(
      `UPDATE slack_user_mappings
       SET nudge_opt_out = $1,
           nudge_opt_out_at = CASE WHEN $1 THEN NOW() ELSE NULL END,
           updated_at = NOW()
       WHERE slack_user_id = $2
       RETURNING *`,
      [optOut, slackUserId]
    );
    return result.rows[0] || null;
  }

  // ============== Domain Aggregation for Prospect Discovery ==============

  /**
   * Get unique email domains from unmapped Slack users
   * These are potential organizations to add as prospects
   */
  async getUnmappedDomains(options: {
    excludeFreeEmailProviders?: boolean;
    minUsers?: number;
    limit?: number;
  } = {}): Promise<Array<{
    domain: string;
    user_count: number;
    users: Array<{
      slack_user_id: string;
      slack_email: string;
      slack_real_name: string | null;
      slack_display_name: string | null;
    }>;
  }>> {
    const excludeFree = options.excludeFreeEmailProviders !== false;
    const minUsers = options.minUsers ?? 1;

    // Common free email providers to exclude
    const freeEmailDomains = [
      'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.uk', 'hotmail.com',
      'outlook.com', 'live.com', 'msn.com', 'aol.com', 'icloud.com', 'me.com',
      'mac.com', 'protonmail.com', 'proton.me', 'mail.com', 'zoho.com',
      'yandex.com', 'gmx.com', 'gmx.net', 'fastmail.com', 'tutanota.com',
    ];

    let domainExcludeClause = '';
    if (excludeFree) {
      const placeholders = freeEmailDomains.map((_, i) => `$${i + 1}`).join(', ');
      domainExcludeClause = `AND LOWER(SPLIT_PART(slack_email, '@', 2)) NOT IN (${placeholders})`;
    }

    // First, get the domains with counts
    const domainQuery = `
      SELECT
        LOWER(SPLIT_PART(slack_email, '@', 2)) as domain,
        COUNT(*) as user_count
      FROM slack_user_mappings
      WHERE mapping_status = 'unmapped'
        AND slack_is_bot = false
        AND slack_is_deleted = false
        AND slack_email IS NOT NULL
        AND slack_email LIKE '%@%'
        ${domainExcludeClause}
      GROUP BY LOWER(SPLIT_PART(slack_email, '@', 2))
      HAVING COUNT(*) >= $${excludeFree ? freeEmailDomains.length + 1 : 1}
      ORDER BY COUNT(*) DESC, domain ASC
      ${options.limit ? `LIMIT $${excludeFree ? freeEmailDomains.length + 2 : 2}` : ''}
    `;

    const domainParams: unknown[] = excludeFree ? [...freeEmailDomains, minUsers] : [minUsers];
    if (options.limit) {
      domainParams.push(options.limit);
    }

    const domainResult = await query<{ domain: string; user_count: string }>(
      domainQuery,
      domainParams
    );

    // Now get the users for each domain
    const results: Array<{
      domain: string;
      user_count: number;
      users: Array<{
        slack_user_id: string;
        slack_email: string;
        slack_real_name: string | null;
        slack_display_name: string | null;
      }>;
    }> = [];

    for (const row of domainResult.rows) {
      const usersResult = await query<{
        slack_user_id: string;
        slack_email: string;
        slack_real_name: string | null;
        slack_display_name: string | null;
      }>(
        `SELECT slack_user_id, slack_email, slack_real_name, slack_display_name
         FROM slack_user_mappings
         WHERE mapping_status = 'unmapped'
           AND slack_is_bot = false
           AND slack_is_deleted = false
           AND LOWER(SPLIT_PART(slack_email, '@', 2)) = $1
         ORDER BY slack_real_name NULLS LAST, slack_display_name NULLS LAST`,
        [row.domain]
      );

      results.push({
        domain: row.domain,
        user_count: parseInt(row.user_count, 10),
        users: usersResult.rows,
      });
    }

    return results;
  }

  /**
   * Check if a domain already exists as an organization (by checking member emails)
   */
  async isDomainInOrganization(domain: string): Promise<{
    exists: boolean;
    organization_id?: string;
    organization_name?: string;
  }> {
    // This checks if any mapped user has this domain
    const result = await query<{
      workos_user_id: string;
    }>(
      `SELECT workos_user_id
       FROM slack_user_mappings
       WHERE mapping_status = 'mapped'
         AND LOWER(SPLIT_PART(slack_email, '@', 2)) = LOWER($1)
       LIMIT 1`,
      [domain]
    );

    if (result.rows.length === 0) {
      return { exists: false };
    }

    // We found a mapped user with this domain, but we'd need to lookup
    // their org via WorkOS - return true but without org details for now
    return { exists: true };
  }

  // ============== Slack Activity Tracking ==============

  /**
   * Record a Slack activity event
   */
  async recordActivity(activity: {
    slack_user_id: string;
    activity_type: string;
    channel_id?: string;
    channel_name?: string;
    activity_timestamp: Date;
    organization_id?: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    // Insert raw activity
    await query(
      `INSERT INTO slack_activities (
        slack_user_id, activity_type, channel_id, channel_name,
        activity_timestamp, organization_id, metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        activity.slack_user_id,
        activity.activity_type,
        activity.channel_id || null,
        activity.channel_name || null,
        activity.activity_timestamp,
        activity.organization_id || null,
        activity.metadata ? JSON.stringify(activity.metadata) : null,
      ]
    );

    // Update daily aggregation
    const activityDate = activity.activity_timestamp.toISOString().split('T')[0];
    const columnMap: Record<string, string> = {
      message: 'message_count',
      reaction: 'reaction_count',
      thread_reply: 'thread_reply_count',
      channel_join: 'channel_join_count',
    };
    const countColumn = columnMap[activity.activity_type] || null;

    if (countColumn) {
      await query(
        `INSERT INTO slack_activity_daily (
          slack_user_id, activity_date, ${countColumn}, total_activity, organization_id
        ) VALUES ($1, $2, 1, 1, $3)
        ON CONFLICT (slack_user_id, activity_date)
        DO UPDATE SET
          ${countColumn} = slack_activity_daily.${countColumn} + 1,
          total_activity = slack_activity_daily.total_activity + 1,
          organization_id = COALESCE(EXCLUDED.organization_id, slack_activity_daily.organization_id),
          updated_at = NOW()`,
        [activity.slack_user_id, activityDate, activity.organization_id || null]
      );
    } else {
      // Unknown activity type - just increment total
      await query(
        `INSERT INTO slack_activity_daily (
          slack_user_id, activity_date, total_activity, organization_id
        ) VALUES ($1, $2, 1, $3)
        ON CONFLICT (slack_user_id, activity_date)
        DO UPDATE SET
          total_activity = slack_activity_daily.total_activity + 1,
          organization_id = COALESCE(EXCLUDED.organization_id, slack_activity_daily.organization_id),
          updated_at = NOW()`,
        [activity.slack_user_id, activityDate, activity.organization_id || null]
      );
    }

    // Update last_slack_activity_at on the user mapping
    await query(
      `UPDATE slack_user_mappings
       SET last_slack_activity_at = $2, updated_at = NOW()
       WHERE slack_user_id = $1
         AND (last_slack_activity_at IS NULL OR last_slack_activity_at < $2)`,
      [activity.slack_user_id, activity.activity_timestamp]
    );
  }

  /**
   * Get activity summary for a Slack user
   */
  async getActivitySummary(slackUserId: string, options: {
    days?: number;
  } = {}): Promise<{
    total_messages: number;
    total_reactions: number;
    total_thread_replies: number;
    total_channel_joins: number;
    total_activity: number;
    active_days: number;
    last_activity_at: Date | null;
  }> {
    const days = options.days ?? 30;

    const result = await query<{
      total_messages: string;
      total_reactions: string;
      total_thread_replies: string;
      total_channel_joins: string;
      total_activity: string;
      active_days: string;
    }>(
      `SELECT
        COALESCE(SUM(message_count), 0)::text as total_messages,
        COALESCE(SUM(reaction_count), 0)::text as total_reactions,
        COALESCE(SUM(thread_reply_count), 0)::text as total_thread_replies,
        COALESCE(SUM(channel_join_count), 0)::text as total_channel_joins,
        COALESCE(SUM(total_activity), 0)::text as total_activity,
        COUNT(*)::text as active_days
       FROM slack_activity_daily
       WHERE slack_user_id = $1
         AND activity_date >= CURRENT_DATE - $2::integer`,
      [slackUserId, days]
    );

    const mapping = await this.getBySlackUserId(slackUserId);

    const row = result.rows[0];
    return {
      total_messages: parseInt(row.total_messages, 10),
      total_reactions: parseInt(row.total_reactions, 10),
      total_thread_replies: parseInt(row.total_thread_replies, 10),
      total_channel_joins: parseInt(row.total_channel_joins, 10),
      total_activity: parseInt(row.total_activity, 10),
      active_days: parseInt(row.active_days, 10),
      last_activity_at: mapping?.last_slack_activity_at || null,
    };
  }

  /**
   * Get organization activity summary from Slack (aggregates all mapped users)
   */
  async getOrgActivitySummary(organizationId: string, options: {
    days?: number;
  } = {}): Promise<{
    total_messages: number;
    total_reactions: number;
    total_thread_replies: number;
    total_activity: number;
    active_users: number;
    active_days: number;
  }> {
    const days = options.days ?? 30;

    const result = await query<{
      total_messages: string;
      total_reactions: string;
      total_thread_replies: string;
      total_activity: string;
      active_users: string;
      active_days: string;
    }>(
      `SELECT
        COALESCE(SUM(message_count), 0)::text as total_messages,
        COALESCE(SUM(reaction_count), 0)::text as total_reactions,
        COALESCE(SUM(thread_reply_count), 0)::text as total_thread_replies,
        COALESCE(SUM(total_activity), 0)::text as total_activity,
        COUNT(DISTINCT slack_user_id)::text as active_users,
        COUNT(DISTINCT activity_date)::text as active_days
       FROM slack_activity_daily
       WHERE organization_id = $1
         AND activity_date >= CURRENT_DATE - $2::integer`,
      [organizationId, days]
    );

    const row = result.rows[0];
    return {
      total_messages: parseInt(row.total_messages, 10),
      total_reactions: parseInt(row.total_reactions, 10),
      total_thread_replies: parseInt(row.total_thread_replies, 10),
      total_activity: parseInt(row.total_activity, 10),
      active_users: parseInt(row.active_users, 10),
      active_days: parseInt(row.active_days, 10),
    };
  }

  /**
   * Get most active Slack users (for engagement insights)
   */
  async getMostActiveUsers(options: {
    days?: number;
    limit?: number;
    mappedOnly?: boolean;
  } = {}): Promise<Array<{
    slack_user_id: string;
    slack_email: string | null;
    slack_real_name: string | null;
    workos_user_id: string | null;
    mapping_status: SlackMappingStatus;
    total_activity: number;
    active_days: number;
  }>> {
    const days = options.days ?? 30;
    const limit = options.limit ?? 50;
    const mappedOnly = options.mappedOnly ?? false;

    const mappedClause = mappedOnly ? "AND m.mapping_status = 'mapped'" : '';

    const result = await query<{
      slack_user_id: string;
      slack_email: string | null;
      slack_real_name: string | null;
      workos_user_id: string | null;
      mapping_status: SlackMappingStatus;
      total_activity: string;
      active_days: string;
    }>(
      `SELECT
        m.slack_user_id,
        m.slack_email,
        m.slack_real_name,
        m.workos_user_id,
        m.mapping_status,
        COALESCE(SUM(d.total_activity), 0)::text as total_activity,
        COUNT(DISTINCT d.activity_date)::text as active_days
       FROM slack_user_mappings m
       LEFT JOIN slack_activity_daily d ON m.slack_user_id = d.slack_user_id
         AND d.activity_date >= CURRENT_DATE - $1::integer
       WHERE m.slack_is_bot = false
         AND m.slack_is_deleted = false
         ${mappedClause}
       GROUP BY m.slack_user_id, m.slack_email, m.slack_real_name, m.workos_user_id, m.mapping_status
       HAVING COALESCE(SUM(d.total_activity), 0) > 0
       ORDER BY COALESCE(SUM(d.total_activity), 0) DESC
       LIMIT $2`,
      [days, limit]
    );

    return result.rows.map(row => ({
      ...row,
      total_activity: parseInt(row.total_activity, 10),
      active_days: parseInt(row.active_days, 10),
    }));
  }

}
