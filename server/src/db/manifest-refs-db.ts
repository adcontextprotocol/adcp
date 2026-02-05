import { query } from "./client.js";

// Types

export type ManifestType = "brand.json" | "adagents.json";
export type ReferenceType = "url" | "agent";
export type VerificationStatus = "pending" | "valid" | "invalid" | "unreachable";

export interface ManifestReference {
  id: string;
  domain: string;
  manifest_type: ManifestType;
  reference_type: ReferenceType;
  manifest_url: string | null;
  agent_url: string | null;
  agent_id: string | null;
  contributed_by_org_id: string | null;
  contributed_by_user_id: string | null;
  contributed_by_email: string | null;
  completeness_score: number;
  last_verified_at: Date | null;
  verification_status: VerificationStatus;
  created_at: Date;
  updated_at: Date;
}

export interface CreateUrlReferenceInput {
  domain: string;
  manifest_type: ManifestType;
  manifest_url: string;
  contributed_by_org_id?: string;
  contributed_by_user_id?: string;
  contributed_by_email?: string;
  completeness_score?: number;
}

export interface CreateAgentReferenceInput {
  domain: string;
  manifest_type: ManifestType;
  agent_url: string;
  agent_id: string;
  contributed_by_org_id?: string;
  contributed_by_user_id?: string;
  contributed_by_email?: string;
  completeness_score?: number;
}

export interface UpdateReferenceInput {
  manifest_url?: string;
  agent_url?: string;
  agent_id?: string;
  completeness_score?: number;
  verification_status?: VerificationStatus;
  last_verified_at?: Date;
}

export interface ListReferencesOptions {
  domain?: string;
  manifest_type?: ManifestType;
  contributed_by_org_id?: string;
  verification_status?: VerificationStatus;
  limit?: number;
  offset?: number;
}

// Database operations

export async function createUrlReference(
  input: CreateUrlReferenceInput
): Promise<ManifestReference> {
  const result = await query<ManifestReference>(
    `INSERT INTO manifest_references (
      domain,
      manifest_type,
      reference_type,
      manifest_url,
      contributed_by_org_id,
      contributed_by_user_id,
      contributed_by_email,
      completeness_score
    ) VALUES ($1, $2, 'url', $3, $4, $5, $6, $7)
    RETURNING *`,
    [
      input.domain.toLowerCase(),
      input.manifest_type,
      input.manifest_url,
      input.contributed_by_org_id || null,
      input.contributed_by_user_id || null,
      input.contributed_by_email || null,
      input.completeness_score || 0,
    ]
  );
  return result.rows[0];
}

export async function createAgentReference(
  input: CreateAgentReferenceInput
): Promise<ManifestReference> {
  const result = await query<ManifestReference>(
    `INSERT INTO manifest_references (
      domain,
      manifest_type,
      reference_type,
      agent_url,
      agent_id,
      contributed_by_org_id,
      contributed_by_user_id,
      contributed_by_email,
      completeness_score
    ) VALUES ($1, $2, 'agent', $3, $4, $5, $6, $7, $8)
    RETURNING *`,
    [
      input.domain.toLowerCase(),
      input.manifest_type,
      input.agent_url,
      input.agent_id,
      input.contributed_by_org_id || null,
      input.contributed_by_user_id || null,
      input.contributed_by_email || null,
      input.completeness_score || 0,
    ]
  );
  return result.rows[0];
}

export async function getReference(id: string): Promise<ManifestReference | null> {
  const result = await query<ManifestReference>(
    `SELECT * FROM manifest_references WHERE id = $1`,
    [id]
  );
  return result.rows[0] || null;
}

export async function getReferencesByDomain(
  domain: string,
  manifestType?: ManifestType
): Promise<ManifestReference[]> {
  if (manifestType) {
    const result = await query<ManifestReference>(
      `SELECT * FROM manifest_references
       WHERE domain = $1 AND manifest_type = $2
       ORDER BY completeness_score DESC, last_verified_at DESC NULLS LAST`,
      [domain.toLowerCase(), manifestType]
    );
    return result.rows;
  }

  const result = await query<ManifestReference>(
    `SELECT * FROM manifest_references
     WHERE domain = $1
     ORDER BY manifest_type, completeness_score DESC, last_verified_at DESC NULLS LAST`,
    [domain.toLowerCase()]
  );
  return result.rows;
}

export async function getBestReference(
  domain: string,
  manifestType: ManifestType
): Promise<ManifestReference | null> {
  // Get best verified reference, or best unverified if none verified
  const result = await query<ManifestReference>(
    `SELECT * FROM manifest_references
     WHERE domain = $1 AND manifest_type = $2
     ORDER BY
       CASE verification_status WHEN 'valid' THEN 0 ELSE 1 END,
       completeness_score DESC,
       last_verified_at DESC NULLS LAST
     LIMIT 1`,
    [domain.toLowerCase(), manifestType]
  );
  return result.rows[0] || null;
}

export async function updateReference(
  id: string,
  input: UpdateReferenceInput
): Promise<ManifestReference | null> {
  const updates: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 1;

  if (input.manifest_url !== undefined) {
    updates.push(`manifest_url = $${paramIndex++}`);
    values.push(input.manifest_url);
  }
  if (input.agent_url !== undefined) {
    updates.push(`agent_url = $${paramIndex++}`);
    values.push(input.agent_url);
  }
  if (input.agent_id !== undefined) {
    updates.push(`agent_id = $${paramIndex++}`);
    values.push(input.agent_id);
  }
  if (input.completeness_score !== undefined) {
    updates.push(`completeness_score = $${paramIndex++}`);
    values.push(input.completeness_score);
  }
  if (input.verification_status !== undefined) {
    updates.push(`verification_status = $${paramIndex++}`);
    values.push(input.verification_status);
  }
  if (input.last_verified_at !== undefined) {
    updates.push(`last_verified_at = $${paramIndex++}`);
    values.push(input.last_verified_at);
  }

  if (updates.length === 0) {
    return getReference(id);
  }

  values.push(id);
  const result = await query<ManifestReference>(
    `UPDATE manifest_references
     SET ${updates.join(", ")}
     WHERE id = $${paramIndex}
     RETURNING *`,
    values
  );
  return result.rows[0] || null;
}

export async function deleteReference(id: string): Promise<boolean> {
  const result = await query(
    `DELETE FROM manifest_references WHERE id = $1`,
    [id]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function listReferences(
  options: ListReferencesOptions = {}
): Promise<{ references: ManifestReference[]; total: number }> {
  const conditions: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 1;

  if (options.domain) {
    conditions.push(`domain = $${paramIndex++}`);
    values.push(options.domain.toLowerCase());
  }
  if (options.manifest_type) {
    conditions.push(`manifest_type = $${paramIndex++}`);
    values.push(options.manifest_type);
  }
  if (options.contributed_by_org_id) {
    conditions.push(`contributed_by_org_id = $${paramIndex++}`);
    values.push(options.contributed_by_org_id);
  }
  if (options.verification_status) {
    conditions.push(`verification_status = $${paramIndex++}`);
    values.push(options.verification_status);
  }

  const whereClause =
    conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  // Get total count
  const countResult = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM manifest_references ${whereClause}`,
    values
  );
  const total = parseInt(countResult.rows[0]?.count || "0", 10);

  // Get paginated results
  const limit = options.limit || 50;
  const offset = options.offset || 0;
  values.push(limit, offset);

  const result = await query<ManifestReference>(
    `SELECT * FROM manifest_references
     ${whereClause}
     ORDER BY domain, manifest_type, completeness_score DESC
     LIMIT $${paramIndex++} OFFSET $${paramIndex}`,
    values
  );

  return { references: result.rows, total };
}

export async function getOrgReferences(
  orgId: string
): Promise<ManifestReference[]> {
  const result = await query<ManifestReference>(
    `SELECT * FROM manifest_references
     WHERE contributed_by_org_id = $1
     ORDER BY domain, manifest_type`,
    [orgId]
  );
  return result.rows;
}

// Stats for admin dashboard

export interface ManifestRefStats {
  total_references: number;
  brand_json_count: number;
  adagents_json_count: number;
  verified_count: number;
  pending_count: number;
  url_refs_count: number;
  agent_refs_count: number;
  unique_domains: number;
  unique_orgs: number;
}

export async function getManifestRefStats(): Promise<ManifestRefStats> {
  const result = await query<ManifestRefStats>(
    `SELECT
      COUNT(*)::int as total_references,
      COUNT(*) FILTER (WHERE manifest_type = 'brand.json')::int as brand_json_count,
      COUNT(*) FILTER (WHERE manifest_type = 'adagents.json')::int as adagents_json_count,
      COUNT(*) FILTER (WHERE verification_status = 'valid')::int as verified_count,
      COUNT(*) FILTER (WHERE verification_status = 'pending')::int as pending_count,
      COUNT(*) FILTER (WHERE reference_type = 'url')::int as url_refs_count,
      COUNT(*) FILTER (WHERE reference_type = 'agent')::int as agent_refs_count,
      COUNT(DISTINCT domain)::int as unique_domains,
      COUNT(DISTINCT contributed_by_org_id) FILTER (WHERE contributed_by_org_id IS NOT NULL)::int as unique_orgs
    FROM manifest_references`
  );
  return (
    result.rows[0] || {
      total_references: 0,
      brand_json_count: 0,
      adagents_json_count: 0,
      verified_count: 0,
      pending_count: 0,
      url_refs_count: 0,
      agent_refs_count: 0,
      unique_domains: 0,
      unique_orgs: 0,
    }
  );
}
