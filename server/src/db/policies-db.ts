import { query, getClient } from './client.js';

export interface Policy {
  policy_id: string;
  version: string;
  name: string;
  description: string | null;
  category: 'regulation' | 'standard';
  enforcement: 'must' | 'should' | 'may';
  jurisdictions: string[];
  region_aliases: Record<string, string[]>;
  verticals: string[];
  channels: string[] | null;
  effective_date: string | null;
  source_url: string | null;
  source_name: string | null;
  policy: string;
  guidance: string | null;
  exemplars: { pass?: Array<{ scenario: string; explanation: string }>; fail?: Array<{ scenario: string; explanation: string }> } | null;
  ext: Record<string, unknown> | null;
  source_type: 'registry' | 'community';
  review_status: 'pending' | 'approved';
  created_at: Date;
  updated_at: Date;
}

export interface PolicyRevision {
  id: string;
  policy_id: string;
  revision_number: number;
  snapshot: Record<string, unknown>;
  editor_user_id: string;
  editor_email: string | null;
  editor_name: string | null;
  edit_summary: string;
  is_rollback: boolean;
  rolled_back_to: number | null;
  created_at: Date;
}

export interface ListPoliciesOptions {
  search?: string;
  category?: 'regulation' | 'standard';
  enforcement?: 'must' | 'should' | 'may';
  jurisdiction?: string;
  vertical?: string;
  limit?: number;
  offset?: number;
}

export interface SavePolicyInput {
  policy_id: string;
  version: string;
  name: string;
  description?: string;
  category: 'regulation' | 'standard';
  enforcement: 'must' | 'should' | 'may';
  jurisdictions?: string[];
  region_aliases?: Record<string, string[]>;
  verticals?: string[];
  channels?: string[];
  effective_date?: string;
  source_url?: string;
  source_name?: string;
  policy: string;
  guidance?: string;
  exemplars?: { pass?: Array<{ scenario: string; explanation: string }>; fail?: Array<{ scenario: string; explanation: string }> };
  ext?: Record<string, unknown>;
}

export interface EditorInfo {
  user_id: string;
  email?: string;
  name?: string;
}

function deserializePolicy(row: any): Policy {
  return {
    ...row,
    jurisdictions: typeof row.jurisdictions === 'string' ? JSON.parse(row.jurisdictions) : (row.jurisdictions || []),
    region_aliases: typeof row.region_aliases === 'string' ? JSON.parse(row.region_aliases) : (row.region_aliases || {}),
    verticals: typeof row.verticals === 'string' ? JSON.parse(row.verticals) : (row.verticals || []),
    channels: row.channels == null ? null : (typeof row.channels === 'string' ? JSON.parse(row.channels) : row.channels),
    exemplars: row.exemplars == null ? null : (typeof row.exemplars === 'string' ? JSON.parse(row.exemplars) : row.exemplars),
    ext: row.ext == null ? null : (typeof row.ext === 'string' ? JSON.parse(row.ext) : row.ext),
    created_at: new Date(row.created_at),
    updated_at: new Date(row.updated_at),
  };
}

function deserializeRevision(row: any): PolicyRevision {
  return {
    ...row,
    snapshot: typeof row.snapshot === 'string' ? JSON.parse(row.snapshot) : row.snapshot,
    created_at: new Date(row.created_at),
  };
}

/**
 * List policies with optional filtering and pagination.
 */
export async function listPolicies(options: ListPoliciesOptions = {}): Promise<{ policies: Policy[]; total: number }> {
  const conditions: string[] = ["review_status = 'approved'"];
  const values: unknown[] = [];
  let paramIndex = 1;

  if (options.search) {
    conditions.push(`(name ILIKE $${paramIndex} OR description ILIKE $${paramIndex} OR policy_id ILIKE $${paramIndex})`);
    values.push(`%${options.search}%`);
    paramIndex++;
  }
  if (options.category) {
    conditions.push(`category = $${paramIndex++}`);
    values.push(options.category);
  }
  if (options.enforcement) {
    conditions.push(`enforcement = $${paramIndex++}`);
    values.push(options.enforcement);
  }
  if (options.jurisdiction) {
    conditions.push(`(jurisdictions @> $${paramIndex}::jsonb OR jurisdictions = '[]'::jsonb OR EXISTS (SELECT 1 FROM jsonb_each(region_aliases) AS ra(key, val) WHERE val @> $${paramIndex}::jsonb))`);
    values.push(JSON.stringify([options.jurisdiction]));
    paramIndex++;
  }
  if (options.vertical) {
    conditions.push(`verticals @> $${paramIndex}::jsonb`);
    values.push(JSON.stringify([options.vertical]));
    paramIndex++;
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = Math.min(options.limit || 100, 1000);
  const offset = options.offset || 0;

  const [dataResult, countResult] = await Promise.all([
    query<any>(
      `SELECT * FROM policies ${where} ORDER BY category, name LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      [...values, limit, offset]
    ),
    query<{ count: string }>(
      `SELECT COUNT(*) as count FROM policies ${where}`,
      values
    ),
  ]);

  return {
    policies: dataResult.rows.map(deserializePolicy),
    total: parseInt(countResult.rows[0].count, 10),
  };
}

/**
 * Resolve a single policy by ID, optionally pinned to a version.
 */
export async function resolvePolicy(policyId: string, version?: string): Promise<Policy | null> {
  const result = await query<any>(
    'SELECT * FROM policies WHERE policy_id = $1',
    [policyId]
  );
  if (result.rows.length === 0) return null;
  const policy = deserializePolicy(result.rows[0]);
  if (version && policy.version !== version) return null;
  return policy;
}

/**
 * Bulk resolve multiple policies by ID.
 */
export async function bulkResolve(policyIds: string[]): Promise<Record<string, Policy | null>> {
  if (policyIds.length === 0) return {};
  const result = await query<any>(
    'SELECT * FROM policies WHERE policy_id = ANY($1)',
    [policyIds]
  );
  const map: Record<string, Policy | null> = {};
  const rows = result.rows.map(deserializePolicy);
  for (const id of policyIds) {
    map[id] = rows.find(r => r.policy_id === id) || null;
  }
  return map;
}

/**
 * Save (create or update) a policy. Registry-sourced policies cannot be edited via community save.
 */
export async function savePolicy(
  input: SavePolicyInput,
  editor: EditorInfo
): Promise<{ policy: Policy; revision_number: number | null }> {
  const client = await getClient();
  try {
    await client.query('BEGIN');

    const existing = await client.query<any>(
      'SELECT * FROM policies WHERE policy_id = $1 FOR UPDATE',
      [input.policy_id]
    );

    if (existing.rows.length > 0) {
      const current = existing.rows[0];
      if (current.source_type === 'registry') {
        throw new Error('Cannot edit authoritative policy (source_type: registry)');
      }
      if (current.review_status === 'pending') {
        throw new Error('Cannot edit policy pending review');
      }

      // Get next revision number
      const revResult = await client.query<{ next_rev: number }>(
        'SELECT COALESCE(MAX(revision_number), 0) + 1 as next_rev FROM policy_revisions WHERE policy_id = $1',
        [input.policy_id]
      );
      const revisionNumber = revResult.rows[0].next_rev;

      // Snapshot current state
      await client.query(
        `INSERT INTO policy_revisions (
          policy_id, revision_number, snapshot,
          editor_user_id, editor_email, editor_name, edit_summary
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          input.policy_id,
          revisionNumber,
          JSON.stringify(current),
          editor.user_id,
          editor.email || null,
          editor.name || null,
          `Updated policy: ${input.name}`,
        ]
      );

      // Update
      const updateResult = await client.query<any>(
        `UPDATE policies SET
          version = $2, name = $3, description = $4, category = $5, enforcement = $6,
          jurisdictions = $7, region_aliases = $8, verticals = $9, channels = $10,
          effective_date = $11, source_url = $12, source_name = $13, policy = $14,
          guidance = $15, exemplars = $16, ext = $17, updated_at = NOW()
        WHERE policy_id = $1 RETURNING *`,
        [
          input.policy_id, input.version, input.name, input.description || null,
          input.category, input.enforcement,
          JSON.stringify(input.jurisdictions || []),
          JSON.stringify(input.region_aliases || {}),
          JSON.stringify(input.verticals || []),
          input.channels ? JSON.stringify(input.channels) : null,
          input.effective_date || null, input.source_url || null, input.source_name || null,
          input.policy, input.guidance || null,
          input.exemplars ? JSON.stringify(input.exemplars) : null,
          input.ext ? JSON.stringify(input.ext) : null,
        ]
      );

      await client.query('COMMIT');
      return { policy: deserializePolicy(updateResult.rows[0]), revision_number: revisionNumber };
    }

    // Insert new policy
    const insertResult = await client.query<any>(
      `INSERT INTO policies (
        policy_id, version, name, description, category, enforcement,
        jurisdictions, region_aliases, verticals, channels,
        effective_date, source_url, source_name, policy,
        guidance, exemplars, ext, source_type
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, 'community')
      RETURNING *`,
      [
        input.policy_id, input.version, input.name, input.description || null,
        input.category, input.enforcement,
        JSON.stringify(input.jurisdictions || []),
        JSON.stringify(input.region_aliases || {}),
        JSON.stringify(input.verticals || []),
        input.channels ? JSON.stringify(input.channels) : null,
        input.effective_date || null, input.source_url || null, input.source_name || null,
        input.policy, input.guidance || null,
        input.exemplars ? JSON.stringify(input.exemplars) : null,
        input.ext ? JSON.stringify(input.ext) : null,
      ]
    );

    await client.query('COMMIT');
    return { policy: deserializePolicy(insertResult.rows[0]), revision_number: null };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Get revision history for a policy.
 */
export async function getPolicyHistory(
  policyId: string,
  options?: { limit?: number; offset?: number }
): Promise<{ revisions: PolicyRevision[]; total: number }> {
  const limit = options?.limit || 20;
  const offset = options?.offset || 0;

  const [dataResult, countResult] = await Promise.all([
    query<any>(
      'SELECT * FROM policy_revisions WHERE policy_id = $1 ORDER BY revision_number DESC LIMIT $2 OFFSET $3',
      [policyId, limit, offset]
    ),
    query<{ count: string }>(
      'SELECT COUNT(*) as count FROM policy_revisions WHERE policy_id = $1',
      [policyId]
    ),
  ]);

  return {
    revisions: dataResult.rows.map(deserializeRevision),
    total: parseInt(countResult.rows[0].count, 10),
  };
}
