import { query } from './client.js';
import type { RegistryEditBan } from '../types.js';

/**
 * Input for creating an edit ban
 */
export interface CreateEditBanInput {
  entity_type: 'brand' | 'property';
  banned_user_id: string;
  banned_email?: string;
  entity_domain?: string;
  banned_by_user_id: string;
  banned_by_email?: string;
  reason: string;
  expires_at?: Date;
}

/**
 * Options for listing edit bans
 */
export interface ListEditBansOptions {
  entity_type?: 'brand' | 'property';
  banned_user_id?: string;
  entity_domain?: string;
}

/**
 * Database operations for registry edit bans
 */
export class RegistryBansDatabase {
  /**
   * Create an edit ban
   */
  async createEditBan(input: CreateEditBanInput): Promise<RegistryEditBan> {
    const result = await query<RegistryEditBan>(
      `INSERT INTO registry_edit_bans (
        entity_type, banned_user_id, banned_email, entity_domain,
        banned_by_user_id, banned_by_email, reason, expires_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *`,
      [
        input.entity_type,
        input.banned_user_id,
        input.banned_email || null,
        input.entity_domain || null,
        input.banned_by_user_id,
        input.banned_by_email || null,
        input.reason,
        input.expires_at || null,
      ]
    );
    return this.deserialize(result.rows[0]);
  }

  /**
   * Remove an edit ban by ID
   */
  async removeEditBan(banId: string): Promise<boolean> {
    const result = await query('DELETE FROM registry_edit_bans WHERE id = $1', [banId]);
    return result.rowCount !== null && result.rowCount > 0;
  }

  /**
   * Check if a user is banned from editing a specific entity.
   * Checks both domain-specific bans and global bans, respecting expiry.
   */
  async isUserBanned(
    entityType: 'brand' | 'property',
    userId: string,
    domain: string
  ): Promise<{ banned: boolean; ban?: RegistryEditBan }> {
    const result = await query<RegistryEditBan>(
      `SELECT * FROM registry_edit_bans
       WHERE entity_type = $1
         AND banned_user_id = $2
         AND (entity_domain = $3 OR entity_domain IS NULL)
         AND (expires_at IS NULL OR expires_at > NOW())
       ORDER BY entity_domain NULLS LAST
       LIMIT 1`,
      [entityType, userId, domain.toLowerCase()]
    );

    if (result.rows.length > 0) {
      return { banned: true, ban: this.deserialize(result.rows[0]) };
    }
    return { banned: false };
  }

  /**
   * List active edit bans with optional filters
   */
  async listEditBans(options: ListEditBansOptions = {}): Promise<RegistryEditBan[]> {
    const conditions: string[] = ['(expires_at IS NULL OR expires_at > NOW())'];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (options.entity_type) {
      conditions.push(`entity_type = $${paramIndex++}`);
      values.push(options.entity_type);
    }
    if (options.banned_user_id) {
      conditions.push(`banned_user_id = $${paramIndex++}`);
      values.push(options.banned_user_id);
    }
    if (options.entity_domain) {
      conditions.push(`entity_domain = $${paramIndex++}`);
      values.push(options.entity_domain.toLowerCase());
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await query<RegistryEditBan>(
      `SELECT * FROM registry_edit_bans ${whereClause} ORDER BY created_at DESC`,
      values
    );
    return result.rows.map((row) => this.deserialize(row));
  }

  private deserialize(row: RegistryEditBan): RegistryEditBan {
    return {
      ...row,
      expires_at: row.expires_at ? new Date(row.expires_at) : undefined,
      created_at: new Date(row.created_at),
    };
  }
}

export const registryBansDb = new RegistryBansDatabase();
