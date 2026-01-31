import { query } from './client.js';
import type {
  HostedBrand,
  DiscoveredBrand,
  LocalizedName,
  KellerType,
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
        has_brand_manifest = EXCLUDED.has_brand_manifest,
        brand_manifest = EXCLUDED.brand_manifest,
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
        input.has_brand_manifest ?? false,
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
  }>> {
    const limit = options.limit || 100;
    const offset = options.offset || 0;
    const search = options.search ? `%${options.search}%` : null;

    const result = await query<{
      domain: string;
      brand_name: string;
      source: 'hosted' | 'brand_json' | 'community' | 'enriched';
      has_manifest: boolean;
      verified: boolean;
      house_domain?: string;
      keller_type?: string;
    }>(
      `
      SELECT
        brand_domain as domain,
        COALESCE(brand_json->>'name', brand_domain) as brand_name,
        'hosted' as source,
        true as has_manifest,
        domain_verified as verified,
        NULL as house_domain,
        NULL as keller_type
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
        keller_type
      FROM discovered_brands
      WHERE ($1::text IS NULL OR domain ILIKE $1 OR brand_name ILIKE $1)
        AND domain NOT IN (SELECT brand_domain FROM hosted_brands WHERE is_public = true)

      ORDER BY brand_name, domain
      LIMIT $2 OFFSET $3
      `,
      [search, limit, offset]
    );

    return result.rows;
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
