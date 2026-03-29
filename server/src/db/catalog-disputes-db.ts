/**
 * Catalog Disputes Database — CRUD for dispute tracking.
 */

import { query } from './client.js';
import { uuidv7 } from './uuid.js';

export interface CatalogDispute {
  id: string;
  dispute_type: string;
  subject_type: string;
  subject_value: string;
  reported_by: string;
  reported_by_email: string | null;
  claim: string;
  evidence: string | null;
  status: string;
  resolution: string | null;
  resolved_by: string | null;
  resolved_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export type DisputeType = 'identifier_link' | 'classification' | 'property_data' | 'false_merge';
export type DisputeStatus = 'open' | 'investigating' | 'resolved' | 'rejected' | 'escalated';

export class CatalogDisputesDatabase {
  async createDispute(input: {
    dispute_type: DisputeType;
    subject_type: string;
    subject_value: string;
    reported_by: string;
    reported_by_email?: string;
    claim: string;
    evidence?: string;
  }): Promise<CatalogDispute> {
    const id = uuidv7();
    const result = await query<CatalogDispute>(
      `INSERT INTO catalog_disputes (id, dispute_type, subject_type, subject_value, reported_by, reported_by_email, claim, evidence)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [id, input.dispute_type, input.subject_type, input.subject_value, input.reported_by, input.reported_by_email ?? null, input.claim, input.evidence ?? null]
    );
    return result.rows[0];
  }

  async getDispute(id: string): Promise<CatalogDispute | null> {
    const result = await query<CatalogDispute>(
      'SELECT * FROM catalog_disputes WHERE id = $1',
      [id]
    );
    return result.rows[0] ?? null;
  }

  async listDisputes(options: {
    status?: DisputeStatus;
    subject_type?: string;
    reported_by?: string;
    limit?: number;
    offset?: number;
  } = {}): Promise<{ disputes: CatalogDispute[]; total: number }> {
    const conditions: string[] = [];
    const params: any[] = [];
    let idx = 1;

    if (options.status) {
      conditions.push(`status = $${idx++}`);
      params.push(options.status);
    }
    if (options.subject_type) {
      conditions.push(`subject_type = $${idx++}`);
      params.push(options.subject_type);
    }
    if (options.reported_by) {
      conditions.push(`reported_by = $${idx++}`);
      params.push(options.reported_by);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = Math.min(options.limit ?? 50, 200);
    const offset = options.offset ?? 0;

    const countResult = await query<{ count: string }>(
      `SELECT count(*) FROM catalog_disputes ${where}`,
      params
    );

    params.push(limit, offset);
    const result = await query<CatalogDispute>(
      `SELECT * FROM catalog_disputes ${where} ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx++}`,
      params
    );

    return {
      disputes: result.rows,
      total: parseInt(countResult.rows[0].count, 10),
    };
  }

  async updateDisputeStatus(
    id: string,
    status: DisputeStatus,
    resolution?: string,
    resolvedBy?: string
  ): Promise<CatalogDispute | null> {
    const result = await query<CatalogDispute>(
      `UPDATE catalog_disputes
       SET status = $2, resolution = $3, resolved_by = $4,
           resolved_at = CASE WHEN $2 IN ('resolved', 'rejected') THEN NOW() ELSE resolved_at END,
           updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [id, status, resolution ?? null, resolvedBy ?? null]
    );
    return result.rows[0] ?? null;
  }

  async getOpenDisputesForSubject(subjectType: string, subjectValue: string): Promise<CatalogDispute[]> {
    const result = await query<CatalogDispute>(
      `SELECT * FROM catalog_disputes
       WHERE subject_type = $1 AND subject_value = $2 AND status IN ('open', 'investigating', 'escalated')
       ORDER BY created_at DESC`,
      [subjectType, subjectValue]
    );
    return result.rows;
  }
}
