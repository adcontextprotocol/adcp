import { query } from './client.js';
import type { PoolClient } from 'pg';

/**
 * A stored AAO catalog-only community mirror (#2176). The body is a
 * catalog-only adagents.json (authorized_agents: []) for a platform that has
 * not adopted AdCP, served at /translated/<platform>/adagents.json. One row
 * per platform; re-publishing the same platform updates the row in place.
 */
export interface CommunityMirror {
  platform: string;
  adagents_json: Record<string, unknown>;
  catalog_etag: string | null;
  superseded_by: string | null;
  created_by_user_id: string | null;
  created_by_email: string | null;
  created_at: string;
  updated_at: string;
}

/** List projection — enough to verify presence + currency without the body. */
export interface CommunityMirrorSummary {
  platform: string;
  catalog_etag: string | null;
  superseded_by: string | null;
  updated_at: string;
}

export interface UpsertCommunityMirrorInput {
  platform: string;
  adagents_json: Record<string, unknown>;
  catalog_etag?: string | null;
  superseded_by?: string | null;
  created_by_user_id?: string | null;
  created_by_email?: string | null;
}

export class CommunityMirrorDatabase {
  /**
   * Idempotent publish: insert a mirror, or update it in place when the
   * platform already exists. `created_by_*` is preserved across re-publishes
   * (it records the original creator); `updated_at` is bumped by the trigger.
   */
  async upsert(input: UpsertCommunityMirrorInput): Promise<CommunityMirror> {
    const result = await query<CommunityMirror>(
      `INSERT INTO community_mirrors
         (platform, adagents_json, catalog_etag, superseded_by,
          created_by_user_id, created_by_email)
       VALUES ($1, $2::jsonb, $3, $4, $5, $6)
       ON CONFLICT (platform) DO UPDATE SET
         adagents_json = EXCLUDED.adagents_json,
         catalog_etag = EXCLUDED.catalog_etag,
         superseded_by = EXCLUDED.superseded_by,
         updated_at = NOW()
       RETURNING *`,
      [
        input.platform,
        JSON.stringify(input.adagents_json),
        input.catalog_etag ?? null,
        input.superseded_by ?? null,
        input.created_by_user_id ?? null,
        input.created_by_email ?? null,
      ]
    );
    return result.rows[0];
  }

  async upsertWithClient(client: PoolClient, input: UpsertCommunityMirrorInput): Promise<CommunityMirror> {
    const result = await client.query<CommunityMirror>(
      `INSERT INTO community_mirrors
         (platform, adagents_json, catalog_etag, superseded_by,
          created_by_user_id, created_by_email)
       VALUES ($1, $2::jsonb, $3, $4, $5, $6)
       ON CONFLICT (platform) DO UPDATE SET
         adagents_json = EXCLUDED.adagents_json,
         catalog_etag = EXCLUDED.catalog_etag,
         superseded_by = EXCLUDED.superseded_by,
         updated_at = NOW()
       RETURNING *`,
      [
        input.platform,
        JSON.stringify(input.adagents_json),
        input.catalog_etag ?? null,
        input.superseded_by ?? null,
        input.created_by_user_id ?? null,
        input.created_by_email ?? null,
      ]
    );
    return result.rows[0];
  }

  async getByPlatform(platform: string): Promise<CommunityMirror | null> {
    const result = await query<CommunityMirror>(
      `SELECT * FROM community_mirrors WHERE platform = $1`,
      [platform]
    );
    return result.rows[0] ?? null;
  }

  async getByPlatformWithClient(client: PoolClient, platform: string): Promise<CommunityMirror | null> {
    const result = await client.query<CommunityMirror>(
      `SELECT * FROM community_mirrors WHERE platform = $1`,
      [platform]
    );
    return result.rows[0] ?? null;
  }

  async list(
    options: { limit?: number; offset?: number } = {}
  ): Promise<{ mirrors: CommunityMirrorSummary[]; total: number }> {
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    const offset = Math.max(options.offset ?? 0, 0);
    const [rows, count] = await Promise.all([
      query<CommunityMirrorSummary>(
        `SELECT platform, catalog_etag, superseded_by, updated_at
           FROM community_mirrors
          ORDER BY updated_at DESC
          LIMIT $1 OFFSET $2`,
        [limit, offset]
      ),
      query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM community_mirrors`
      ),
    ]);
    return {
      mirrors: rows.rows,
      total: parseInt(count.rows[0]?.count ?? '0', 10),
    };
  }

  /** Delete a mirror. Returns true if a row was removed, false if absent. */
  async deleteByPlatform(platform: string): Promise<boolean> {
    const result = await query('DELETE FROM community_mirrors WHERE platform = $1', [platform]);
    return (result.rowCount ?? 0) > 0;
  }

  async deleteByPlatformWithClient(client: PoolClient, platform: string): Promise<boolean> {
    const result = await client.query('DELETE FROM community_mirrors WHERE platform = $1', [platform]);
    return (result.rowCount ?? 0) > 0;
  }
}
