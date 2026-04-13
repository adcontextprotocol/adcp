import { query } from './client.js';

export interface InsertBrandLogoInput {
  domain: string;
  content_type: string;
  data: Buffer;
  sha256: string;
  tags: string[];
  width?: number;
  height?: number;
  source: 'brandfetch' | 'community' | 'brand_owner' | 'brand_json';
  review_status?: 'pending' | 'approved' | 'rejected' | 'deleted';
  uploaded_by_user_id?: string;
  uploaded_by_email?: string;
  upload_note?: string;
  original_filename?: string;
}

export interface BrandLogoRow {
  id: string;
  domain: string;
  content_type: string;
  data: Buffer;
  storage_type: string;
  storage_key: string | null;
  sha256: string;
  tags: string[];
  width: number | null;
  height: number | null;
  source: string;
  review_status: string;
  uploaded_by_user_id: string | null;
  uploaded_by_email: string | null;
  upload_note: string | null;
  original_filename: string | null;
  review_note: string | null;
  reviewed_by_user_id: string | null;
  reviewed_at: Date | null;
  deleted_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export type BrandLogoSummary = Omit<BrandLogoRow, 'data'>;

const SUMMARY_COLUMNS = `id, domain, content_type, storage_type, storage_key, sha256,
  tags, width, height, source, review_status, uploaded_by_user_id, uploaded_by_email,
  upload_note, original_filename, review_note, reviewed_by_user_id, reviewed_at,
  deleted_at, created_at, updated_at`;

export interface ListBrandLogosOptions {
  tags?: string[];
  review_status?: string;
  include_all_statuses?: boolean;
}

export class BrandLogoDatabase {
  async insertBrandLogo(input: InsertBrandLogoInput): Promise<BrandLogoRow | null> {
    const result = await query<BrandLogoRow>(
      `INSERT INTO brand_logos (
        domain, content_type, data, sha256, tags, width, height,
        source, review_status, uploaded_by_user_id, uploaded_by_email,
        upload_note, original_filename
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      ON CONFLICT (domain, sha256) WHERE review_status IN ('pending', 'approved')
      DO NOTHING
      RETURNING *`,
      [
        input.domain,
        input.content_type,
        input.data,
        input.sha256,
        input.tags,
        input.width ?? null,
        input.height ?? null,
        input.source,
        input.review_status ?? 'pending',
        input.uploaded_by_user_id ?? null,
        input.uploaded_by_email ?? null,
        input.upload_note ?? null,
        input.original_filename ?? null,
      ]
    );
    return result.rows[0] ?? null;
  }

  async getBrandLogo(
    id: string,
    domain: string,
    opts?: { review_status?: string }
  ): Promise<BrandLogoRow | null> {
    const conditions = ['id = $1', 'domain = $2'];
    const params: unknown[] = [id, domain];

    if (opts?.review_status) {
      conditions.push(`review_status = $${params.length + 1}`);
      params.push(opts.review_status);
    }

    const result = await query<BrandLogoRow>(
      `SELECT * FROM brand_logos WHERE ${conditions.join(' AND ')}`,
      params
    );
    return result.rows[0] ?? null;
  }

  async getByDomainAndSha256(domain: string, sha256: string): Promise<BrandLogoSummary | null> {
    const result = await query<BrandLogoSummary>(
      `SELECT ${SUMMARY_COLUMNS} FROM brand_logos
       WHERE domain = $1 AND sha256 = $2 AND review_status IN ('pending', 'approved')
       LIMIT 1`,
      [domain, sha256]
    );
    return result.rows[0] ?? null;
  }

  async listBrandLogos(
    domain: string,
    opts?: ListBrandLogosOptions
  ): Promise<BrandLogoSummary[]> {
    const conditions = ['domain = $1'];
    const params: unknown[] = [domain];

    if (opts?.tags && opts.tags.length > 0) {
      conditions.push(`tags @> $${params.length + 1}`);
      params.push(opts.tags);
    }

    if (opts?.include_all_statuses) {
      conditions.push("review_status != 'deleted'");
    } else if (opts?.review_status) {
      conditions.push(`review_status = $${params.length + 1}`);
      params.push(opts.review_status);
    } else {
      conditions.push("review_status = 'approved'");
    }

    const result = await query<BrandLogoSummary>(
      `SELECT ${SUMMARY_COLUMNS} FROM brand_logos
       WHERE ${conditions.join(' AND ')}
       ORDER BY
         CASE source
           WHEN 'brand_owner' THEN 0
           WHEN 'community' THEN 1
           WHEN 'brandfetch' THEN 2
           ELSE 3
         END,
         created_at ASC`,
      params
    );
    return result.rows;
  }

  async updateLogoReviewStatus(
    id: string,
    domain: string,
    status: 'approved' | 'rejected' | 'deleted',
    reviewerId: string,
    note?: string
  ): Promise<BrandLogoSummary | null> {
    const result = await query<BrandLogoSummary>(
      `UPDATE brand_logos
       SET review_status = $2,
           reviewed_by_user_id = $3,
           reviewed_at = now(),
           review_note = $4
           ${status === 'deleted' ? ', deleted_at = now()' : ''}
       WHERE id = $1 AND domain = $5
       RETURNING ${SUMMARY_COLUMNS}`,
      [id, status, reviewerId, note ?? null, domain]
    );
    return result.rows[0] ?? null;
  }

  async getLogoRedirect(
    domain: string,
    oldIdx: number
  ): Promise<string | null> {
    const result = await query<{ new_id: string }>(
      'SELECT new_id FROM brand_logo_redirects WHERE domain = $1 AND old_idx = $2',
      [domain, oldIdx]
    );
    return result.rows[0]?.new_id ?? null;
  }

  async countBrandLogos(domain: string): Promise<number> {
    const result = await query<{ count: string }>(
      "SELECT count(*) FROM brand_logos WHERE domain = $1 AND review_status IN ('pending', 'approved')",
      [domain]
    );
    return parseInt(result.rows[0].count, 10);
  }

  async getPendingLogos(
    limit = 50,
    offset = 0
  ): Promise<(BrandLogoSummary & { brand_name?: string })[]> {
    const result = await query<BrandLogoSummary & { brand_name?: string }>(
      `SELECT bl.id, bl.domain, bl.content_type, bl.storage_type, bl.storage_key,
              bl.sha256, bl.tags, bl.width, bl.height, bl.source, bl.review_status,
              bl.uploaded_by_user_id, bl.uploaded_by_email, bl.upload_note,
              bl.original_filename, bl.review_note, bl.reviewed_by_user_id,
              bl.reviewed_at, bl.deleted_at, bl.created_at, bl.updated_at,
              db.brand_name
       FROM brand_logos bl
       LEFT JOIN brands db ON bl.domain = db.domain
       WHERE bl.review_status = 'pending'
       ORDER BY bl.created_at ASC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    return result.rows;
  }
}
