import { query } from './client.js';
import type { PoolClient } from 'pg';

/**
 * A stored AgenticAdvertising.org catalog-only community mirror (#2176). The
 * body is a catalog-only adagents.json (authorized_agents: []) for a platform
 * that has not adopted AdCP, served at /translated/<platform>/adagents.json. One row
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

export type CommunityMirrorProposalStatus = 'pending' | 'approved' | 'rejected';

export interface CommunityMirrorProposal {
  id: string;
  platform: string;
  adagents_json: Record<string, unknown>;
  catalog_etag: string | null;
  superseded_by: string | null;
  proposal_digest: string;
  base_mirror_digest: string | null;
  status: CommunityMirrorProposalStatus;
  proposed_by_user_id: string;
  proposed_by_email: string | null;
  proposed_by_organization_id: string | null;
  proposed_at: string;
  reviewed_by_user_id: string | null;
  reviewed_at: string | null;
  review_notes: string | null;
  published_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CommunityMirrorProposalSummary {
  id: string;
  platform: string;
  catalog_etag: string | null;
  superseded_by: string | null;
  proposal_digest: string;
  base_mirror_digest: string | null;
  status: CommunityMirrorProposalStatus;
  proposed_at: string;
  reviewed_at: string | null;
  published_at: string | null;
  updated_at: string;
}

export interface SubmitCommunityMirrorProposalInput {
  platform: string;
  adagents_json: Record<string, unknown>;
  catalog_etag?: string | null;
  superseded_by?: string | null;
  proposal_digest: string;
  base_mirror_digest?: string | null;
  proposed_by_user_id: string;
  proposed_by_email?: string | null;
  proposed_by_organization_id?: string | null;
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

  /**
   * Create or refresh this caller's pending proposal for a platform. The
   * partial unique indexes keep retries idempotent while preserving completed
   * review records.
   */
  async submitProposal(input: SubmitCommunityMirrorProposalInput): Promise<CommunityMirrorProposal> {
    const organizationId = input.proposed_by_organization_id ?? null;
    const conflictTarget = organizationId
      ? `(platform, proposed_by_organization_id)
         WHERE status = 'pending' AND proposed_by_organization_id IS NOT NULL`
      : `(platform, proposed_by_user_id)
         WHERE status = 'pending' AND proposed_by_organization_id IS NULL`;
    const result = await query<CommunityMirrorProposal>(
      `INSERT INTO community_mirror_proposals
         (platform, adagents_json, catalog_etag, superseded_by,
          proposal_digest, base_mirror_digest,
          proposed_by_user_id, proposed_by_email, proposed_by_organization_id)
       VALUES ($1, $2::jsonb, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT ${conflictTarget} DO UPDATE SET
         adagents_json = EXCLUDED.adagents_json,
         catalog_etag = EXCLUDED.catalog_etag,
         superseded_by = EXCLUDED.superseded_by,
         proposal_digest = EXCLUDED.proposal_digest,
         base_mirror_digest = EXCLUDED.base_mirror_digest,
         proposed_by_user_id = EXCLUDED.proposed_by_user_id,
         proposed_by_email = EXCLUDED.proposed_by_email,
         proposed_at = NOW(),
         reviewed_by_user_id = NULL,
         reviewed_at = NULL,
         review_notes = NULL,
         published_at = NULL,
         updated_at = NOW()
       RETURNING *`,
      [
        input.platform,
        JSON.stringify(input.adagents_json),
        input.catalog_etag ?? null,
        input.superseded_by ?? null,
        input.proposal_digest,
        input.base_mirror_digest ?? null,
        input.proposed_by_user_id,
        input.proposed_by_email ?? null,
        organizationId,
      ],
    );
    return result.rows[0];
  }

  async getProposalById(id: string): Promise<CommunityMirrorProposal | null> {
    const result = await query<CommunityMirrorProposal>(
      `SELECT * FROM community_mirror_proposals WHERE id = $1`,
      [id],
    );
    return result.rows[0] ?? null;
  }

  async getProposalByIdWithClient(client: PoolClient, id: string): Promise<CommunityMirrorProposal | null> {
    const result = await client.query<CommunityMirrorProposal>(
      `SELECT * FROM community_mirror_proposals WHERE id = $1 FOR UPDATE`,
      [id],
    );
    return result.rows[0] ?? null;
  }

  async listProposals(options: {
    status?: CommunityMirrorProposalStatus;
    proposedByUserId?: string;
    proposedByOrganizationId?: string;
    limit?: number;
    offset?: number;
  } = {}): Promise<{ proposals: CommunityMirrorProposalSummary[]; total: number }> {
    const clauses: string[] = [];
    const values: unknown[] = [];
    const add = (clause: string, value: unknown) => {
      values.push(value);
      clauses.push(clause.replace('?', `$${values.length}`));
    };
    if (options.status) add('status = ?', options.status);
    if (options.proposedByOrganizationId) {
      add('proposed_by_organization_id = ?', options.proposedByOrganizationId);
    } else if (options.proposedByUserId) {
      add('proposed_by_user_id = ?', options.proposedByUserId);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = Math.min(Math.max(options.limit ?? 25, 1), 50);
    const offset = Math.max(options.offset ?? 0, 0);
    const listValues = [...values, limit, offset];
    const [rows, count] = await Promise.all([
      query<CommunityMirrorProposalSummary>(
        `SELECT id, platform, catalog_etag, superseded_by, proposal_digest,
                base_mirror_digest, status, proposed_at, reviewed_at,
                published_at, updated_at
           FROM community_mirror_proposals
          ${where}
          ORDER BY proposed_at DESC
          LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
        listValues,
      ),
      query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM community_mirror_proposals ${where}`,
        values,
      ),
    ]);
    return { proposals: rows.rows, total: parseInt(count.rows[0]?.count ?? '0', 10) };
  }

  async approveProposalWithClient(
    client: PoolClient,
    id: string,
    reviewedByUserId: string,
    reviewNotes?: string | null,
  ): Promise<CommunityMirrorProposal | null> {
    const result = await client.query<CommunityMirrorProposal>(
      `UPDATE community_mirror_proposals
          SET status = 'approved',
              reviewed_by_user_id = $2,
              reviewed_at = NOW(),
              review_notes = $3,
              published_at = NOW(),
              updated_at = NOW()
        WHERE id = $1 AND status = 'pending'
        RETURNING *`,
      [id, reviewedByUserId, reviewNotes ?? null],
    );
    return result.rows[0] ?? null;
  }

  async rejectProposal(
    id: string,
    proposalDigest: string,
    reviewedByUserId: string,
    reviewNotes: string,
  ): Promise<CommunityMirrorProposal | null> {
    const result = await query<CommunityMirrorProposal>(
      `UPDATE community_mirror_proposals
          SET status = 'rejected',
              reviewed_by_user_id = $3,
              reviewed_at = NOW(),
              review_notes = $4,
              updated_at = NOW()
        WHERE id = $1 AND status = 'pending' AND proposal_digest = $2
        RETURNING *`,
      [id, proposalDigest, reviewedByUserId, reviewNotes],
    );
    return result.rows[0] ?? null;
  }
}
