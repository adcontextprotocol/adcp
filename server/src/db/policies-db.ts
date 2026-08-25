import { query, getClient } from './client.js';
import { z } from 'zod';

const AcceptancePolicyRuleSchema = z.object({
  rule_id: z.string(),
  subject_category: z.string(),
  subject_facets: z.array(z.string()).optional(),
  advertiser_roles: z.array(z.string()).optional(),
  jurisdictions: z.array(z.string()).optional(),
  jurisdiction_groups: z.array(z.string()).optional(),
  applies_to: z.array(z.enum(['account', 'media_buy', 'creative', 'landing_page', 'targeting', 'delivery', 'format'])),
  disposition: z.enum(['allowed', 'conditional', 'prohibited']),
  requirements: z.array(z.record(z.string(), z.unknown())).optional(),
  policy_ids: z.array(z.string()).optional(),
  description: z.string().optional(),
  effective_at: z.string().optional(),
  expires_at: z.string().optional(),
  ext: z.record(z.string(), z.unknown()).optional(),
}).strict();

export const AcceptancePolicyProfileSchema = z.object({
  profile_id: z.string(),
  version: z.string(),
  content_digest: z.string(),
  policy_refs: z.array(z.object({
    policy_id: z.string(),
    version: z.string(),
    content_digest: z.string(),
  }).strict()),
  coverage: z.enum(['partial', 'complete']),
  scope: z.object({
    subject_categories: z.array(z.string()),
    applies_to: z.array(z.enum(['account', 'media_buy', 'creative', 'landing_page', 'targeting', 'delivery', 'format'])),
    jurisdictions: z.array(z.string()).optional(),
    jurisdiction_groups: z.array(z.string()).optional(),
    all_jurisdictions: z.literal(true).optional(),
  }).strict().optional(),
  region_aliases: z.record(z.string(), z.array(z.string())).optional(),
  description: z.string().optional(),
  rules: z.array(AcceptancePolicyRuleSchema),
  ext: z.record(z.string(), z.unknown()).optional(),
}).strict();
export type AcceptancePolicyProfile = z.infer<typeof AcceptancePolicyProfileSchema>;

const CanonicalPolicyDocumentSchema = z.object({
  policy_id: z.string(),
  source: z.enum(['registry', 'inline']).optional(),
  version: z.string(),
  name: z.string(),
  description: z.string().optional(),
  category: z.enum(['regulation', 'standard']),
  enforcement: z.enum(['must', 'should', 'may']),
  requires_human_review: z.boolean().optional(),
  jurisdictions: z.array(z.string()).optional(),
  region_aliases: z.record(z.string(), z.array(z.string())).optional(),
  policy_categories: z.array(z.string()).optional(),
  channels: z.array(z.string()).optional(),
  governance_domains: z.array(z.string()).optional(),
  effective_date: z.string().optional(),
  sunset_date: z.string().optional(),
  source_url: z.string().optional(),
  source_name: z.string().optional(),
  issuer: z.object({ domain: z.string(), name: z.string().optional() }).strict().optional(),
  acceptance_profile: AcceptancePolicyProfileSchema.optional(),
  policy: z.string(),
  guidance: z.string().optional(),
  exemplars: z.object({
    pass: z.array(z.object({ scenario: z.string(), explanation: z.string() }).strict()).optional(),
    fail: z.array(z.object({ scenario: z.string(), explanation: z.string() }).strict()).optional(),
  }).strict().optional(),
  ext: z.record(z.string(), z.unknown()).optional(),
}).strict();
type CanonicalPolicyDocument = z.infer<typeof CanonicalPolicyDocumentSchema>;

export interface Policy {
  policy_id: string;
  version: string;
  name: string;
  description: string | null;
  category: 'regulation' | 'standard';
  enforcement: 'must' | 'should' | 'may';
  jurisdictions: string[];
  region_aliases: Record<string, string[]>;
  policy_categories: string[];
  channels: string[] | null;
  governance_domains: string[];
  effective_date: string | null;
  sunset_date: string | null;
  source_url: string | null;
  source_name: string | null;
  issuer: { domain: string; name?: string } | null;
  acceptance_profile: AcceptancePolicyProfile | null;
  content_digest?: string | null;
  canonical_content?: Record<string, unknown> | null;
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
  policy_category?: string;
  domain?: string;
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
  policy_categories?: string[];
  channels?: string[];
  effective_date?: string;
  sunset_date?: string;
  governance_domains?: string[];
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

type PolicyRow = Omit<Policy,
  'jurisdictions' | 'region_aliases' | 'policy_categories' | 'channels' |
  'governance_domains' | 'exemplars' | 'issuer' | 'acceptance_profile' |
  'canonical_content' | 'ext' | 'created_at' | 'updated_at'
> & Record<string, unknown>;

interface PolicyPublicationRow {
  policy_id: string;
  version: string;
  content_digest: string;
  canonical_content: unknown;
  acceptance_profile: unknown;
  published_at: string | Date;
}

function parsedJson(value: unknown): unknown {
  return typeof value === 'string' ? JSON.parse(value) : value;
}

function deserializePolicy(row: PolicyRow): Policy {
  const acceptanceProfile = row.acceptance_profile == null
    ? null
    : AcceptancePolicyProfileSchema.parse(parsedJson(row.acceptance_profile));
  return {
    ...row,
    jurisdictions: typeof row.jurisdictions === 'string' ? JSON.parse(row.jurisdictions) : (row.jurisdictions || []),
    region_aliases: typeof row.region_aliases === 'string' ? JSON.parse(row.region_aliases) : (row.region_aliases || {}),
    policy_categories: typeof row.policy_categories === 'string' ? JSON.parse(row.policy_categories) : (row.policy_categories || []),
    channels: row.channels == null ? null : (typeof row.channels === 'string' ? JSON.parse(row.channels) : row.channels),
    governance_domains: typeof row.governance_domains === 'string' ? JSON.parse(row.governance_domains) : (row.governance_domains || []),
    exemplars: row.exemplars == null ? null : (typeof row.exemplars === 'string' ? JSON.parse(row.exemplars) : row.exemplars),
    issuer: row.issuer == null ? null : (typeof row.issuer === 'string' ? JSON.parse(row.issuer) : row.issuer),
    acceptance_profile: acceptanceProfile,
    ...(row.content_digest !== undefined ? { content_digest: row.content_digest } : {}),
    ...(row.canonical_content !== undefined ? {
      canonical_content: row.canonical_content == null
        ? null
        : (typeof row.canonical_content === 'string' ? JSON.parse(row.canonical_content) : row.canonical_content),
    } : {}),
    ext: row.ext == null ? null : (typeof row.ext === 'string' ? JSON.parse(row.ext) : row.ext),
    created_at: new Date(String(row.created_at)),
    updated_at: new Date(String(row.updated_at)),
  } as Policy;
}

function deserializePublishedPolicy(row: PolicyPublicationRow): Policy {
  const canonical = CanonicalPolicyDocumentSchema.parse(parsedJson(row.canonical_content));
  const publishedAt = new Date(row.published_at);
  return deserializePolicy({
    policy_id: canonical.policy_id,
    version: canonical.version,
    name: canonical.name,
    description: canonical.description ?? null,
    category: canonical.category,
    enforcement: canonical.enforcement,
    jurisdictions: canonical.jurisdictions ?? [],
    region_aliases: canonical.region_aliases ?? {},
    policy_categories: canonical.policy_categories ?? [],
    channels: canonical.channels ?? null,
    governance_domains: canonical.governance_domains ?? [],
    effective_date: canonical.effective_date ?? null,
    sunset_date: canonical.sunset_date ?? null,
    source_url: canonical.source_url ?? null,
    source_name: canonical.source_name ?? null,
    issuer: canonical.issuer ?? null,
    acceptance_profile: row.acceptance_profile == null
      ? null
      : AcceptancePolicyProfileSchema.parse(parsedJson(row.acceptance_profile)),
    policy: canonical.policy,
    guidance: canonical.guidance ?? null,
    exemplars: canonical.exemplars ?? null,
    ext: canonical.ext ?? null,
    source_type: 'registry',
    review_status: 'approved',
    content_digest: row.content_digest,
    canonical_content: canonical,
    created_at: publishedAt,
    updated_at: publishedAt,
  });
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
export async function listPolicies(options: ListPoliciesOptions = {}): Promise<{ policies: Policy[]; total: number; regulation: number; standard: number }> {
  const conditions: string[] = ["review_status = 'approved'"];
  const values: unknown[] = [];
  let paramIndex = 1;

  if (options.search) {
    conditions.push(`(to_tsvector('english', name || ' ' || COALESCE(description, '')) @@ plainto_tsquery('english', $${paramIndex}) OR policy_id ILIKE $${paramIndex + 1})`);
    const escapedSearch = options.search.replace(/[%_\\]/g, '\\$&');
    values.push(options.search, `%${escapedSearch}%`);
    paramIndex += 2;
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
    conditions.push(`(jurisdictions @> $${paramIndex}::jsonb OR (jurisdictions = '[]'::jsonb AND region_aliases = '{}'::jsonb) OR EXISTS (SELECT 1 FROM jsonb_each(region_aliases) AS ra(key, val) WHERE val @> $${paramIndex}::jsonb))`);
    values.push(JSON.stringify([options.jurisdiction]));
    paramIndex++;
  }
  if (options.policy_category) {
    conditions.push(`policy_categories @> $${paramIndex}::jsonb`);
    values.push(JSON.stringify([options.policy_category]));
    paramIndex++;
  }
  if (options.domain) {
    conditions.push(`governance_domains @> $${paramIndex}::jsonb`);
    values.push(JSON.stringify([options.domain]));
    paramIndex++;
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = Math.min(options.limit || 20, 1000);
  const offset = options.offset || 0;

  const [dataResult, statsResult] = await Promise.all([
    query<any>(
      `SELECT policy_id, version, name, description, category, enforcement,
              jurisdictions, region_aliases, policy_categories, channels,
              governance_domains, effective_date, sunset_date,
              source_url, source_name, issuer, source_type, review_status,
              created_at, updated_at
       FROM policies ${where} ORDER BY category, name LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      [...values, limit, offset]
    ),
    query<{ total: string; regulation: string; standard: string }>(
      `SELECT COUNT(*) as total,
              COUNT(*) FILTER (WHERE category = 'regulation') as regulation,
              COUNT(*) FILTER (WHERE category = 'standard') as standard
       FROM policies ${where}`,
      values
    ),
  ]);

  const stats = statsResult.rows[0];
  return {
    policies: dataResult.rows.map(deserializePolicy),
    total: parseInt(stats.total, 10),
    regulation: parseInt(stats.regulation, 10),
    standard: parseInt(stats.standard, 10),
  };
}

/**
 * Resolve a single policy by ID, optionally pinned to a version.
 */
export async function resolvePolicy(policyId: string, version?: string): Promise<Policy | null> {
  if (version) {
    const publication = await query<PolicyPublicationRow>(
      `SELECT policy_id, version, content_digest, canonical_content,
              acceptance_profile, published_at
       FROM policy_publications
       WHERE policy_id = $1 AND version = $2`,
      [policyId, version]
    );
    if (publication.rows.length > 0) return deserializePublishedPolicy(publication.rows[0]);
  }
  const result = await query<PolicyRow>(
    `SELECT policy.*, publication.content_digest, publication.canonical_content
     FROM policies policy
     LEFT JOIN policy_publications publication
       ON publication.policy_id = policy.policy_id
      AND publication.version = policy.version
     WHERE policy.policy_id = $1`,
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
  const result = await query<PolicyRow>(
    `SELECT policy.*, publication.content_digest, publication.canonical_content
     FROM policies policy
     LEFT JOIN policy_publications publication
       ON publication.policy_id = policy.policy_id
      AND publication.version = policy.version
     WHERE policy.policy_id = ANY($1)`,
    [policyIds]
  );
  const map: Record<string, Policy | null> = Object.create(null);
  const rows = result.rows.map(deserializePolicy);
  for (const id of policyIds) {
    // Validate property name to prevent prototype pollution
    if (typeof id === 'string' && !['__proto__', 'constructor', 'prototype'].includes(id)) {
      map[id] = rows.find(r => r.policy_id === id) || null;
    }
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
          jurisdictions = $7, region_aliases = $8, policy_categories = $9, channels = $10,
          effective_date = $11, sunset_date = $12, governance_domains = $13,
          source_url = $14, source_name = $15, policy = $16,
          guidance = $17, exemplars = $18, ext = $19, updated_at = NOW()
        WHERE policy_id = $1 RETURNING *`,
        [
          input.policy_id, input.version, input.name, input.description || null,
          input.category, input.enforcement,
          JSON.stringify(input.jurisdictions || []),
          JSON.stringify(input.region_aliases || {}),
          JSON.stringify(input.policy_categories || []),
          input.channels ? JSON.stringify(input.channels) : null,
          input.effective_date || null, input.sunset_date || null,
          JSON.stringify(input.governance_domains || []),
          input.source_url || null, input.source_name || null,
          input.policy, input.guidance || null,
          input.exemplars ? JSON.stringify(input.exemplars) : null,
          input.ext ? JSON.stringify(input.ext) : null,
        ]
      );

      await client.query('COMMIT');
      return { policy: deserializePolicy(updateResult.rows[0]), revision_number: revisionNumber };
    }

    // Insert new policy (community policies start as pending review)
    const insertResult = await client.query<any>(
      `INSERT INTO policies (
        policy_id, version, name, description, category, enforcement,
        jurisdictions, region_aliases, policy_categories, channels,
        effective_date, sunset_date, governance_domains,
        source_url, source_name, policy,
        guidance, exemplars, ext, source_type, review_status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, 'community', 'pending')
      RETURNING *`,
      [
        input.policy_id, input.version, input.name, input.description || null,
        input.category, input.enforcement,
        JSON.stringify(input.jurisdictions || []),
        JSON.stringify(input.region_aliases || {}),
        JSON.stringify(input.policy_categories || []),
        input.channels ? JSON.stringify(input.channels) : null,
        input.effective_date || null, input.sunset_date || null,
        JSON.stringify(input.governance_domains || []),
        input.source_url || null, input.source_name || null,
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
