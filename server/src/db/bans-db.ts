import { query } from './client.js';
import type { Ban } from '../types.js';

export type BanType = 'user' | 'organization' | 'api_key';
export type BanScope = 'platform' | 'registry_brand' | 'registry_property';

export interface CreateBanInput {
  ban_type: BanType;
  entity_id: string;
  scope: BanScope;
  scope_target?: string;
  banned_by_user_id: string;
  banned_by_email?: string;
  banned_email?: string;
  reason: string;
  expires_at?: Date;
}

export interface ListBansOptions {
  ban_type?: BanType;
  scope?: BanScope;
  entity_id?: string;
}

export class BansDatabase {
  /**
   * Create a ban.
   */
  async createBan(input: CreateBanInput): Promise<Ban> {
    const result = await query<Ban>(
      `INSERT INTO bans (
        ban_type, entity_id, scope, scope_target,
        banned_by_user_id, banned_by_email, banned_email,
        reason, expires_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *`,
      [
        input.ban_type,
        input.entity_id,
        input.scope,
        input.scope_target || null,
        input.banned_by_user_id,
        input.banned_by_email || null,
        input.banned_email || null,
        input.reason,
        input.expires_at || null,
      ]
    );
    return this.deserialize(result.rows[0]);
  }

  /**
   * Remove a ban by ID.
   */
  async removeBan(banId: string): Promise<Ban | null> {
    const result = await query<Ban>(
      'DELETE FROM bans WHERE id = $1 RETURNING *',
      [banId]
    );
    return result.rows[0] ? this.deserialize(result.rows[0]) : null;
  }

  /**
   * Get a single ban by ID.
   */
  async getBan(banId: string): Promise<Ban | null> {
    const result = await query<Ban>('SELECT * FROM bans WHERE id = $1', [banId]);
    return result.rows[0] ? this.deserialize(result.rows[0]) : null;
  }

  /**
   * List active bans with optional filters.
   */
  async listBans(options: ListBansOptions = {}): Promise<Ban[]> {
    const conditions: string[] = ['(expires_at IS NULL OR expires_at > NOW())'];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (options.ban_type) {
      conditions.push(`ban_type = $${paramIndex++}`);
      values.push(options.ban_type);
    }
    if (options.scope) {
      conditions.push(`scope = $${paramIndex++}`);
      values.push(options.scope);
    }
    if (options.entity_id) {
      conditions.push(`entity_id = $${paramIndex++}`);
      values.push(options.entity_id);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await query<Ban>(
      `SELECT * FROM bans ${whereClause} ORDER BY created_at DESC`,
      values
    );
    return result.rows.map((row) => this.deserialize(row));
  }

  // ---------------------------------------------------------------------------
  // Platform ban checks (used by requireAuth middleware)
  // ---------------------------------------------------------------------------

  /**
   * Check if a cookie-authenticated user has an active platform ban.
   * Checks both direct user bans and organization-level bans via membership.
   */
  async checkPlatformBan(workosUserId: string): Promise<{ banned: boolean; ban?: Ban }> {
    const result = await query<Ban>(
      `SELECT * FROM bans
       WHERE scope = 'platform'
         AND (expires_at IS NULL OR expires_at > NOW())
         AND (
           (ban_type = 'user' AND entity_id = $1)
           OR (ban_type = 'organization' AND entity_id IN (
             SELECT workos_organization_id FROM organization_memberships
             WHERE workos_user_id = $1
           ))
         )
       LIMIT 1`,
      [workosUserId]
    );

    if (result.rows.length > 0) {
      return { banned: true, ban: this.deserialize(result.rows[0]) };
    }
    return { banned: false };
  }

  /**
   * Check if an API key has an active platform ban.
   * Checks both direct API key bans and organization-level bans.
   */
  async checkPlatformBanForApiKey(
    apiKeyId: string,
    organizationId: string
  ): Promise<{ banned: boolean; ban?: Ban }> {
    const result = await query<Ban>(
      `SELECT * FROM bans
       WHERE scope = 'platform'
         AND (expires_at IS NULL OR expires_at > NOW())
         AND (
           (ban_type = 'api_key' AND entity_id = $1)
           OR (ban_type = 'organization' AND entity_id = $2)
         )
       LIMIT 1`,
      [apiKeyId, organizationId]
    );

    if (result.rows.length > 0) {
      return { banned: true, ban: this.deserialize(result.rows[0]) };
    }
    return { banned: false };
  }

  // ---------------------------------------------------------------------------
  // Registry ban checks (used by per-endpoint checks in http.ts / mcp-tools.ts)
  // ---------------------------------------------------------------------------

  /**
   * Check if a user is banned from registry edits.
   * Checks user-level and org-level registry bans, plus domain-specific and global.
   */
  async isUserBannedFromRegistry(
    scope: 'registry_brand' | 'registry_property',
    userId: string,
    domain: string
  ): Promise<{ banned: boolean; ban?: Ban }> {
    const result = await query<Ban>(
      `SELECT * FROM bans
       WHERE scope = $1
         AND (expires_at IS NULL OR expires_at > NOW())
         AND (scope_target = $2 OR scope_target IS NULL)
         AND (
           (ban_type = 'user' AND entity_id = $3)
           OR (ban_type = 'organization' AND entity_id IN (
             SELECT workos_organization_id FROM organization_memberships
             WHERE workos_user_id = $3
           ))
         )
       ORDER BY scope_target NULLS LAST
       LIMIT 1`,
      [scope, domain.toLowerCase(), userId]
    );

    if (result.rows.length > 0) {
      return { banned: true, ban: this.deserialize(result.rows[0]) };
    }
    return { banned: false };
  }

  /**
   * Check if an API key is banned from registry edits.
   * Checks api_key-level and org-level registry bans.
   */
  async isApiKeyBannedFromRegistry(
    scope: 'registry_brand' | 'registry_property',
    apiKeyId: string,
    organizationId: string,
    domain: string
  ): Promise<{ banned: boolean; ban?: Ban }> {
    const result = await query<Ban>(
      `SELECT * FROM bans
       WHERE scope = $1
         AND (expires_at IS NULL OR expires_at > NOW())
         AND (scope_target = $2 OR scope_target IS NULL)
         AND (
           (ban_type = 'api_key' AND entity_id = $3)
           OR (ban_type = 'organization' AND entity_id = $4)
         )
       ORDER BY scope_target NULLS LAST
       LIMIT 1`,
      [scope, domain.toLowerCase(), apiKeyId, organizationId]
    );

    if (result.rows.length > 0) {
      return { banned: true, ban: this.deserialize(result.rows[0]) };
    }
    return { banned: false };
  }

  private deserialize(row: Ban): Ban {
    return {
      ...row,
      expires_at: row.expires_at ? new Date(row.expires_at) : undefined,
      created_at: new Date(row.created_at),
    };
  }
}

export const bansDb = new BansDatabase();
