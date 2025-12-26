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

  /**
   * Get all WorkOS user IDs that are currently mapped to Slack users
   * Used to efficiently check for existing mappings without N+1 queries
   */
  async getMappedWorkosUserIds(): Promise<Set<string>> {
    const result = await query<{ workos_user_id: string }>(
      `SELECT workos_user_id FROM slack_user_mappings WHERE workos_user_id IS NOT NULL`
    );
    return new Set(result.rows.map(row => row.workos_user_id));
  }

}
