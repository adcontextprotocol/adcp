import { query, getClient } from './client.js';
import type {
  HostedBrand,
  DiscoveredBrand,
  LocalizedName,
  KellerType,
  RegistryRevision,
} from '../types.js';

/**
 * Input for creating a hosted brand
 */
export interface CreateHostedBrandInput {
  workos_organization_id?: string;
  created_by_user_id?: string;
  created_by_email?: string;
  brand_domain: string;
  brand_json: Record<string, unknown>;
  is_public?: boolean;
}

/**
 * Input for updating a hosted brand
 */
export interface UpdateHostedBrandInput {
  brand_json?: Record<string, unknown>;
  domain_verified?: boolean;
  verification_token?: string;
  is_public?: boolean;
}

/**
 * Input for creating/updating a discovered brand
 */
export interface UpsertDiscoveredBrandInput {
  domain: string;
  canonical_domain?: string;
  house_domain?: string;
  brand_name?: string;
  brand_names?: LocalizedName[];
  keller_type?: KellerType;
  parent_brand?: string;
  brand_agent_url?: string;
  brand_agent_capabilities?: string[];
  has_brand_manifest?: boolean;
  brand_manifest?: Record<string, unknown>;
  source_type: 'brand_json' | 'community' | 'enriched';
  expires_at?: Date;
}

/**
 * Options for listing brands
 */
export interface ListBrandsOptions {
  source_type?: 'brand_json' | 'community' | 'enriched';
  has_manifest?: boolean;
  house_domain?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

/**
 * Database operations for brands
 */
export class BrandDatabase {
  // ========== Hosted Brands ==========

  /**
   * Create a hosted brand
   */
  async createHostedBrand(input: CreateHostedBrandInput): Promise<HostedBrand> {
    const result = await query<HostedBrand>(
      `INSERT INTO hosted_brands (
        workos_organization_id, created_by_user_id, created_by_email,
        brand_domain, brand_json, is_public
      ) VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *`,
      [
        input.workos_organization_id || null,
        input.created_by_user_id || null,
        input.created_by_email || null,
        input.brand_domain,
        JSON.stringify(input.brand_json),
        input.is_public ?? true,
      ]
    );
    return this.deserializeHostedBrand(result.rows[0]);
  }

  /**
   * Get hosted brand by ID
   */
  async getHostedBrandById(id: string): Promise<HostedBrand | null> {
    const result = await query<HostedBrand>(
      'SELECT * FROM hosted_brands WHERE id = $1',
      [id]
    );
    return result.rows[0] ? this.deserializeHostedBrand(result.rows[0]) : null;
  }

  /**
   * Get hosted brand by domain
   */
  async getHostedBrandByDomain(domain: string): Promise<HostedBrand | null> {
    const result = await query<HostedBrand>(
      'SELECT * FROM hosted_brands WHERE brand_domain = $1',
      [domain.toLowerCase()]
    );
    return result.rows[0] ? this.deserializeHostedBrand(result.rows[0]) : null;
  }

  /**
   * List hosted brands by organization
   */
  async listHostedBrandsByOrg(orgId: string): Promise<HostedBrand[]> {
    const result = await query<HostedBrand>(
      'SELECT * FROM hosted_brands WHERE workos_organization_id = $1 ORDER BY brand_domain',
      [orgId]
    );
    return result.rows.map((row) => this.deserializeHostedBrand(row));
  }

  /**
   * List hosted brands by creator email
   */
  async listHostedBrandsByEmail(email: string): Promise<HostedBrand[]> {
    const result = await query<HostedBrand>(
      'SELECT * FROM hosted_brands WHERE created_by_email = $1 ORDER BY brand_domain',
      [email.toLowerCase()]
    );
    return result.rows.map((row) => this.deserializeHostedBrand(row));
  }

  /**
   * Update a hosted brand
   */
  async updateHostedBrand(id: string, input: UpdateHostedBrandInput): Promise<HostedBrand | null> {
    const updates: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (input.brand_json !== undefined) {
      updates.push(`brand_json = $${paramIndex++}`);
      values.push(JSON.stringify(input.brand_json));
    }
    if (input.domain_verified !== undefined) {
      updates.push(`domain_verified = $${paramIndex++}`);
      values.push(input.domain_verified);
    }
    if (input.verification_token !== undefined) {
      updates.push(`verification_token = $${paramIndex++}`);
      values.push(input.verification_token);
    }
    if (input.is_public !== undefined) {
      updates.push(`is_public = $${paramIndex++}`);
      values.push(input.is_public);
    }

    if (updates.length === 0) {
      return this.getHostedBrandById(id);
    }

    values.push(id);
    const result = await query<HostedBrand>(
      `UPDATE hosted_brands SET ${updates.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
      values
    );
    return result.rows[0] ? this.deserializeHostedBrand(result.rows[0]) : null;
  }

  /**
   * Delete a hosted brand
   */
  async deleteHostedBrand(id: string): Promise<boolean> {
    const result = await query('DELETE FROM hosted_brands WHERE id = $1', [id]);
    return result.rowCount !== null && result.rowCount > 0;
  }

  /**
   * Generate verification token for a hosted brand
   */
  async generateVerificationToken(id: string): Promise<string | null> {
    const token = `adcp-brand-verify-${crypto.randomUUID()}`;
    const result = await query<HostedBrand>(
      'UPDATE hosted_brands SET verification_token = $1 WHERE id = $2 RETURNING *',
      [token, id]
    );
    return result.rows[0] ? token : null;
  }

  // ========== Discovered Brands ==========

  /**
   * Upsert a discovered brand (insert or update on conflict)
   */
  async upsertDiscoveredBrand(input: UpsertDiscoveredBrandInput): Promise<DiscoveredBrand> {
    const result = await query<DiscoveredBrand>(
      `INSERT INTO discovered_brands (
        domain, canonical_domain, house_domain, brand_name, brand_names,
        keller_type, parent_brand, brand_agent_url, brand_agent_capabilities,
        has_brand_manifest, brand_manifest, source_type, last_validated, expires_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW(), $13)
      ON CONFLICT (domain) DO UPDATE SET
        canonical_domain = EXCLUDED.canonical_domain,
        house_domain = EXCLUDED.house_domain,
        brand_name = EXCLUDED.brand_name,
        brand_names = EXCLUDED.brand_names,
        keller_type = EXCLUDED.keller_type,
        parent_brand = EXCLUDED.parent_brand,
        brand_agent_url = EXCLUDED.brand_agent_url,
        brand_agent_capabilities = EXCLUDED.brand_agent_capabilities,
        has_brand_manifest = COALESCE(EXCLUDED.has_brand_manifest, discovered_brands.has_brand_manifest),
        brand_manifest = COALESCE(EXCLUDED.brand_manifest, discovered_brands.brand_manifest),
        source_type = EXCLUDED.source_type,
        last_validated = NOW(),
        expires_at = EXCLUDED.expires_at
      RETURNING *`,
      [
        input.domain.toLowerCase(),
        input.canonical_domain || null,
        input.house_domain || null,
        input.brand_name || null,
        input.brand_names ? JSON.stringify(input.brand_names) : '[]',
        input.keller_type || null,
        input.parent_brand || null,
        input.brand_agent_url || null,
        input.brand_agent_capabilities || null,
        input.has_brand_manifest != null ? input.has_brand_manifest : null,
        input.brand_manifest ? JSON.stringify(input.brand_manifest) : null,
        input.source_type,
        input.expires_at || null,
      ]
    );
    return this.deserializeDiscoveredBrand(result.rows[0]);
  }

  /**
   * Get discovered brand by domain
   */
  async getDiscoveredBrandByDomain(domain: string): Promise<DiscoveredBrand | null> {
    const result = await query<DiscoveredBrand>(
      'SELECT * FROM discovered_brands WHERE domain = $1',
      [domain.toLowerCase()]
    );
    return result.rows[0] ? this.deserializeDiscoveredBrand(result.rows[0]) : null;
  }

  /**
   * List discovered brands with filters
   */
  async listDiscoveredBrands(options: ListBrandsOptions = {}): Promise<DiscoveredBrand[]> {
    const conditions: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (options.source_type) {
      conditions.push(`source_type = $${paramIndex++}`);
      values.push(options.source_type);
    }
    if (options.has_manifest !== undefined) {
      conditions.push(`has_brand_manifest = $${paramIndex++}`);
      values.push(options.has_manifest);
    }
    if (options.house_domain) {
      conditions.push(`house_domain = $${paramIndex++}`);
      values.push(options.house_domain.toLowerCase());
    }
    if (options.search) {
      conditions.push(`(brand_name ILIKE $${paramIndex} OR domain ILIKE $${paramIndex})`);
      values.push(`%${options.search}%`);
      paramIndex++;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limitClause = options.limit ? `LIMIT $${paramIndex++}` : '';
    const offsetClause = options.offset ? `OFFSET $${paramIndex++}` : '';

    if (options.limit) values.push(options.limit);
    if (options.offset) values.push(options.offset);

    const result = await query<DiscoveredBrand>(
      `SELECT * FROM discovered_brands ${whereClause} ORDER BY brand_name, domain ${limitClause} ${offsetClause}`,
      values
    );
    return result.rows.map((row) => this.deserializeDiscoveredBrand(row));
  }

  /**
   * Delete a discovered brand
   */
  async deleteDiscoveredBrand(domain: string): Promise<boolean> {
    const result = await query('DELETE FROM discovered_brands WHERE domain = $1', [domain.toLowerCase()]);
    return result.rowCount !== null && result.rowCount > 0;
  }

  /**
   * Delete expired discovered brands
   */
  async deleteExpiredBrands(): Promise<number> {
    const result = await query('DELETE FROM discovered_brands WHERE expires_at < NOW()');
    return result.rowCount || 0;
  }

  // ========== Brand Registry (Combined View) ==========

  /**
   * Get all brands (hosted + discovered) for registry view
   */
  async getAllBrandsForRegistry(options: ListBrandsOptions = {}): Promise<Array<{
    domain: string;
    brand_name: string;
    source: 'hosted' | 'brand_json' | 'community' | 'enriched';
    has_manifest: boolean;
    verified: boolean;
    house_domain?: string;
    keller_type?: string;
    logo_url?: string;
    primary_color?: string;
    industry?: string;
    sub_brand_count: number;
    employee_count: number;
  }>> {
    const offset = options.offset || 0;
    const escapedSearch = options.search ? options.search.replace(/[%_\\]/g, '\\$&') : null;
    const search = escapedSearch ? `%${escapedSearch}%` : null;

    const params: (string | number | null)[] = [search, offset];
    const limitClause = options.limit ? `LIMIT $3` : '';
    if (options.limit) params.push(options.limit);

    const result = await query<{
      domain: string;
      brand_name: string;
      source: 'hosted' | 'brand_json' | 'community' | 'enriched';
      has_manifest: boolean;
      verified: boolean;
      house_domain?: string;
      keller_type?: string;
      logo_url?: string;
      primary_color?: string;
      industry?: string;
      sub_brand_count: number;
      employee_count: number;
    }>(
      `
      SELECT
        brand_domain as domain,
        COALESCE(brand_json->>'name', brand_domain) as brand_name,
        'hosted' as source,
        true as has_manifest,
        domain_verified as verified,
        NULL as house_domain,
        NULL as keller_type,
        brand_json->'logos'->0->>'url' as logo_url,
        brand_json->'colors'->>'primary' as primary_color,
        brand_json->'company'->>'industry' as industry,
        (SELECT COUNT(*)::int FROM discovered_brands sub WHERE sub.house_domain = brand_domain) as sub_brand_count,
        COALESCE((brand_json->'company'->>'employees')::int, 0) as employee_count
      FROM hosted_brands
      WHERE is_public = true
        AND ($1::text IS NULL OR brand_domain ILIKE $1 OR brand_json->>'name' ILIKE $1)

      UNION ALL

      SELECT
        domain,
        COALESCE(brand_name, domain) as brand_name,
        source_type as source,
        has_brand_manifest as has_manifest,
        true as verified,
        house_domain,
        keller_type,
        brand_manifest->'logos'->0->>'url' as logo_url,
        brand_manifest->'colors'->>'primary' as primary_color,
        brand_manifest->'company'->>'industry' as industry,
        (SELECT COUNT(*)::int FROM discovered_brands sub WHERE sub.house_domain = discovered_brands.domain) as sub_brand_count,
        COALESCE((brand_manifest->'company'->>'employees')::int, 0) as employee_count
      FROM discovered_brands
      WHERE ($1::text IS NULL OR domain ILIKE $1 OR brand_name ILIKE $1)
        AND (review_status IS NULL OR review_status = 'approved')
        AND domain NOT IN (SELECT brand_domain FROM hosted_brands WHERE is_public = true)

      ORDER BY employee_count DESC, brand_name, domain
      ${limitClause}
      OFFSET $2
      `,
      params
    );

    return result.rows;
  }

  // ========== Wiki Editing ==========

  /**
   * Create a new community brand with pending review status and initial revision.
   */
  async createDiscoveredBrand(
    input: UpsertDiscoveredBrandInput,
    editor: { user_id: string; email?: string; name?: string }
  ): Promise<DiscoveredBrand> {
    const client = await getClient();
    try {
      await client.query('BEGIN');

      const insertResult = await client.query<DiscoveredBrand>(
        `INSERT INTO discovered_brands (
          domain, canonical_domain, house_domain, brand_name, brand_names,
          keller_type, parent_brand, brand_agent_url, brand_agent_capabilities,
          has_brand_manifest, brand_manifest, source_type, review_status, last_validated, expires_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'pending', NOW(), $13)
        RETURNING *`,
        [
          input.domain.toLowerCase(),
          input.canonical_domain || null,
          input.house_domain || null,
          input.brand_name || null,
          input.brand_names ? JSON.stringify(input.brand_names) : '[]',
          input.keller_type || null,
          input.parent_brand || null,
          input.brand_agent_url || null,
          input.brand_agent_capabilities || null,
          input.has_brand_manifest ?? false,
          input.brand_manifest ? JSON.stringify(input.brand_manifest) : null,
          input.source_type,
          input.expires_at || null,
        ]
      );

      const brand = insertResult.rows[0];

      // Create revision #1
      await client.query(
        `INSERT INTO brand_revisions (
          brand_domain, revision_number, snapshot,
          editor_user_id, editor_email, editor_name, edit_summary
        ) VALUES ($1, 1, $2, $3, $4, $5, 'Initial record')`,
        [
          brand.domain,
          JSON.stringify(brand),
          editor.user_id,
          editor.email || null,
          editor.name || null,
        ]
      );

      await client.query('COMMIT');
      return this.deserializeDiscoveredBrand(brand);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Approve a pending brand (called by Addie after review).
   */
  async approveBrand(domain: string): Promise<boolean> {
    const result = await query(
      `UPDATE discovered_brands SET review_status = 'approved' WHERE domain = $1`,
      [domain.toLowerCase()]
    );
    return result.rowCount !== null && result.rowCount > 0;
  }

  /**
   * Edit a discovered brand with revision tracking.
   * Rejects edits to authoritative (brand_json) or pending records.
   */
  async editDiscoveredBrand(
    domain: string,
    input: {
      brand_name?: string;
      brand_names?: LocalizedName[];
      keller_type?: KellerType;
      parent_brand?: string;
      house_domain?: string;
      canonical_domain?: string;
      brand_agent_url?: string;
      brand_agent_capabilities?: string[];
      brand_manifest?: Record<string, unknown>;
      has_brand_manifest?: boolean;
      edit_summary: string;
      editor_user_id: string;
      editor_email?: string;
      editor_name?: string;
    }
  ): Promise<{ brand: DiscoveredBrand; revision_number: number }> {
    const client = await getClient();
    try {
      await client.query('BEGIN');

      // Lock the row
      const lockResult = await client.query<DiscoveredBrand>(
        'SELECT * FROM discovered_brands WHERE domain = $1 FOR UPDATE',
        [domain.toLowerCase()]
      );
      if (lockResult.rows.length === 0) {
        throw new Error(`Brand not found: ${domain}`);
      }

      const current = lockResult.rows[0];

      if (current.source_type === 'brand_json') {
        throw new Error('Cannot edit authoritative brand (managed via brand.json)');
      }
      if (current.review_status === 'pending') {
        throw new Error('Cannot edit brand pending review');
      }

      // Get next revision number
      const revResult = await client.query<{ next_rev: number }>(
        'SELECT COALESCE(MAX(revision_number), 0) + 1 as next_rev FROM brand_revisions WHERE brand_domain = $1',
        [domain.toLowerCase()]
      );
      const revisionNumber = revResult.rows[0].next_rev;

      // Snapshot current state as revision
      await client.query(
        `INSERT INTO brand_revisions (
          brand_domain, revision_number, snapshot,
          editor_user_id, editor_email, editor_name, edit_summary
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          domain.toLowerCase(),
          revisionNumber,
          JSON.stringify(current),
          input.editor_user_id,
          input.editor_email || null,
          input.editor_name || null,
          input.edit_summary,
        ]
      );

      // Build dynamic UPDATE
      const updates: string[] = [];
      const values: unknown[] = [];
      let paramIndex = 1;

      if (input.brand_name !== undefined) {
        updates.push(`brand_name = $${paramIndex++}`);
        values.push(input.brand_name);
      }
      if (input.brand_names !== undefined) {
        updates.push(`brand_names = $${paramIndex++}`);
        values.push(JSON.stringify(input.brand_names));
      }
      if (input.keller_type !== undefined) {
        updates.push(`keller_type = $${paramIndex++}`);
        values.push(input.keller_type);
      }
      if (input.parent_brand !== undefined) {
        updates.push(`parent_brand = $${paramIndex++}`);
        values.push(input.parent_brand);
      }
      if (input.house_domain !== undefined) {
        updates.push(`house_domain = $${paramIndex++}`);
        values.push(input.house_domain);
      }
      if (input.canonical_domain !== undefined) {
        updates.push(`canonical_domain = $${paramIndex++}`);
        values.push(input.canonical_domain);
      }
      if (input.brand_agent_url !== undefined) {
        updates.push(`brand_agent_url = $${paramIndex++}`);
        values.push(input.brand_agent_url);
      }
      if (input.brand_agent_capabilities !== undefined) {
        updates.push(`brand_agent_capabilities = $${paramIndex++}`);
        values.push(input.brand_agent_capabilities);
      }
      if (input.brand_manifest !== undefined) {
        updates.push(`brand_manifest = $${paramIndex++}`);
        values.push(JSON.stringify(input.brand_manifest));
      }
      if (input.has_brand_manifest !== undefined) {
        updates.push(`has_brand_manifest = $${paramIndex++}`);
        values.push(input.has_brand_manifest);
      }

      if (updates.length === 0) {
        await client.query('COMMIT');
        return { brand: this.deserializeDiscoveredBrand(current), revision_number: revisionNumber };
      }

      values.push(domain.toLowerCase());
      const updateResult = await client.query<DiscoveredBrand>(
        `UPDATE discovered_brands SET ${updates.join(', ')} WHERE domain = $${paramIndex} RETURNING *`,
        values
      );

      await client.query('COMMIT');
      return {
        brand: this.deserializeDiscoveredBrand(updateResult.rows[0]),
        revision_number: revisionNumber,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Rollback a brand to a previous revision.
   */
  async rollbackBrand(
    domain: string,
    toRevisionNumber: number,
    editor: { user_id: string; email?: string; name?: string }
  ): Promise<{ brand: DiscoveredBrand; revision_number: number }> {
    const client = await getClient();
    try {
      await client.query('BEGIN');

      // Get target revision
      const targetResult = await client.query<{ snapshot: string }>(
        'SELECT snapshot FROM brand_revisions WHERE brand_domain = $1 AND revision_number = $2',
        [domain.toLowerCase(), toRevisionNumber]
      );
      if (targetResult.rows.length === 0) {
        throw new Error(`Revision ${toRevisionNumber} not found for ${domain}`);
      }

      const snapshot = typeof targetResult.rows[0].snapshot === 'string'
        ? JSON.parse(targetResult.rows[0].snapshot)
        : targetResult.rows[0].snapshot;

      // Lock current row and get current state for the new revision snapshot
      const currentResult = await client.query<DiscoveredBrand>(
        'SELECT * FROM discovered_brands WHERE domain = $1 FOR UPDATE',
        [domain.toLowerCase()]
      );
      if (currentResult.rows.length === 0) {
        throw new Error(`Brand not found: ${domain}`);
      }

      // Get next revision number
      const revResult = await client.query<{ next_rev: number }>(
        'SELECT COALESCE(MAX(revision_number), 0) + 1 as next_rev FROM brand_revisions WHERE brand_domain = $1',
        [domain.toLowerCase()]
      );
      const revisionNumber = revResult.rows[0].next_rev;

      // Create rollback revision (snapshots current state before rollback)
      await client.query(
        `INSERT INTO brand_revisions (
          brand_domain, revision_number, snapshot,
          editor_user_id, editor_email, editor_name,
          edit_summary, is_rollback, rolled_back_to
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, true, $8)`,
        [
          domain.toLowerCase(),
          revisionNumber,
          JSON.stringify(currentResult.rows[0]),
          editor.user_id,
          editor.email || null,
          editor.name || null,
          `Rollback to revision ${toRevisionNumber}`,
          toRevisionNumber,
        ]
      );

      // Restore from snapshot
      const updateResult = await client.query<DiscoveredBrand>(
        `UPDATE discovered_brands SET
          canonical_domain = $2,
          house_domain = $3,
          brand_name = $4,
          brand_names = $5,
          keller_type = $6,
          parent_brand = $7,
          brand_agent_url = $8,
          brand_agent_capabilities = $9,
          has_brand_manifest = $10,
          brand_manifest = $11
        WHERE domain = $1
        RETURNING *`,
        [
          domain.toLowerCase(),
          snapshot.canonical_domain || null,
          snapshot.house_domain || null,
          snapshot.brand_name || null,
          snapshot.brand_names ? JSON.stringify(snapshot.brand_names) : '[]',
          snapshot.keller_type || null,
          snapshot.parent_brand || null,
          snapshot.brand_agent_url || null,
          snapshot.brand_agent_capabilities || null,
          snapshot.has_brand_manifest ?? false,
          snapshot.brand_manifest ? JSON.stringify(snapshot.brand_manifest) : null,
        ]
      );

      await client.query('COMMIT');
      return {
        brand: this.deserializeDiscoveredBrand(updateResult.rows[0]),
        revision_number: revisionNumber,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Get revision history for a brand, newest first.
   */
  async getBrandRevisions(
    domain: string,
    options?: { limit?: number; offset?: number }
  ): Promise<RegistryRevision[]> {
    const limit = options?.limit || 50;
    const offset = options?.offset || 0;
    const result = await query<RegistryRevision & { brand_domain: string }>(
      `SELECT * FROM brand_revisions WHERE brand_domain = $1
       ORDER BY revision_number DESC LIMIT $2 OFFSET $3`,
      [domain.toLowerCase(), limit, offset]
    );
    return result.rows.map((row) => this.deserializeRevision(row));
  }

  /**
   * Get a single revision.
   */
  async getBrandRevision(domain: string, revisionNumber: number): Promise<RegistryRevision | null> {
    const result = await query<RegistryRevision & { brand_domain: string }>(
      'SELECT * FROM brand_revisions WHERE brand_domain = $1 AND revision_number = $2',
      [domain.toLowerCase(), revisionNumber]
    );
    return result.rows[0] ? this.deserializeRevision(result.rows[0]) : null;
  }

  /**
   * Count revisions for a brand.
   */
  async getBrandRevisionCount(domain: string): Promise<number> {
    const result = await query<{ count: string }>(
      'SELECT COUNT(*) as count FROM brand_revisions WHERE brand_domain = $1',
      [domain.toLowerCase()]
    );
    return parseInt(result.rows[0].count, 10);
  }

  // ========== Helpers ==========

  private deserializeHostedBrand(row: HostedBrand): HostedBrand {
    return {
      ...row,
      brand_json: typeof row.brand_json === 'string' ? JSON.parse(row.brand_json) : row.brand_json,
      created_at: new Date(row.created_at),
      updated_at: new Date(row.updated_at),
    };
  }

  private deserializeRevision(row: RegistryRevision & { brand_domain?: string }): RegistryRevision {
    return {
      ...row,
      domain: row.brand_domain || row.domain,
      snapshot: typeof row.snapshot === 'string' ? JSON.parse(row.snapshot) : row.snapshot,
      created_at: new Date(row.created_at),
    };
  }

  private deserializeDiscoveredBrand(row: DiscoveredBrand): DiscoveredBrand {
    return {
      ...row,
      brand_names: typeof row.brand_names === 'string' ? JSON.parse(row.brand_names) : row.brand_names,
      brand_manifest: typeof row.brand_manifest === 'string' ? JSON.parse(row.brand_manifest) : row.brand_manifest,
      discovered_at: new Date(row.discovered_at),
      last_validated: row.last_validated ? new Date(row.last_validated) : undefined,
      expires_at: row.expires_at ? new Date(row.expires_at) : undefined,
    };
  }
}

// Singleton export
export const brandDb = new BrandDatabase();
