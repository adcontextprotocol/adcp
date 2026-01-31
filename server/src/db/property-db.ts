import { query } from './client.js';
import type { HostedProperty, ResolvedProperty } from '../types.js';

/**
 * Input for creating a hosted property
 */
export interface CreateHostedPropertyInput {
  workos_organization_id?: string;
  created_by_user_id?: string;
  created_by_email?: string;
  publisher_domain: string;
  adagents_json: Record<string, unknown>;
  source_type?: 'community' | 'enriched';
  is_public?: boolean;
}

/**
 * Input for updating a hosted property
 */
export interface UpdateHostedPropertyInput {
  adagents_json?: Record<string, unknown>;
  domain_verified?: boolean;
  verification_token?: string;
  is_public?: boolean;
}

/**
 * Options for listing properties
 */
export interface ListPropertiesOptions {
  source?: 'adagents_json' | 'hosted' | 'discovered';
  search?: string;
  has_agents?: boolean;
  limit?: number;
  offset?: number;
}

/**
 * Database operations for properties
 */
export class PropertyDatabase {
  // ========== Hosted Properties ==========

  /**
   * Create a hosted property
   */
  async createHostedProperty(input: CreateHostedPropertyInput): Promise<HostedProperty> {
    const result = await query<HostedProperty>(
      `INSERT INTO hosted_properties (
        workos_organization_id, created_by_user_id, created_by_email,
        publisher_domain, adagents_json, source_type, is_public
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *`,
      [
        input.workos_organization_id || null,
        input.created_by_user_id || null,
        input.created_by_email || null,
        input.publisher_domain.toLowerCase(),
        JSON.stringify(input.adagents_json),
        input.source_type || 'community',
        input.is_public ?? true,
      ]
    );
    return this.deserializeHostedProperty(result.rows[0]);
  }

  /**
   * Get hosted property by ID
   */
  async getHostedPropertyById(id: string): Promise<HostedProperty | null> {
    const result = await query<HostedProperty>(
      'SELECT * FROM hosted_properties WHERE id = $1',
      [id]
    );
    return result.rows[0] ? this.deserializeHostedProperty(result.rows[0]) : null;
  }

  /**
   * Get hosted property by domain
   */
  async getHostedPropertyByDomain(domain: string): Promise<HostedProperty | null> {
    const result = await query<HostedProperty>(
      'SELECT * FROM hosted_properties WHERE publisher_domain = $1',
      [domain.toLowerCase()]
    );
    return result.rows[0] ? this.deserializeHostedProperty(result.rows[0]) : null;
  }

  /**
   * List hosted properties by organization
   */
  async listHostedPropertiesByOrg(orgId: string): Promise<HostedProperty[]> {
    const result = await query<HostedProperty>(
      'SELECT * FROM hosted_properties WHERE workos_organization_id = $1 ORDER BY publisher_domain',
      [orgId]
    );
    return result.rows.map((row) => this.deserializeHostedProperty(row));
  }

  /**
   * List hosted properties by creator email
   */
  async listHostedPropertiesByEmail(email: string): Promise<HostedProperty[]> {
    const result = await query<HostedProperty>(
      'SELECT * FROM hosted_properties WHERE created_by_email = $1 ORDER BY publisher_domain',
      [email.toLowerCase()]
    );
    return result.rows.map((row) => this.deserializeHostedProperty(row));
  }

  /**
   * Update a hosted property
   */
  async updateHostedProperty(id: string, input: UpdateHostedPropertyInput): Promise<HostedProperty | null> {
    const updates: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (input.adagents_json !== undefined) {
      updates.push(`adagents_json = $${paramIndex++}`);
      values.push(JSON.stringify(input.adagents_json));
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
      return this.getHostedPropertyById(id);
    }

    values.push(id);
    const result = await query<HostedProperty>(
      `UPDATE hosted_properties SET ${updates.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
      values
    );
    return result.rows[0] ? this.deserializeHostedProperty(result.rows[0]) : null;
  }

  /**
   * Delete a hosted property
   */
  async deleteHostedProperty(id: string): Promise<boolean> {
    const result = await query('DELETE FROM hosted_properties WHERE id = $1', [id]);
    return result.rowCount !== null && result.rowCount > 0;
  }

  /**
   * Generate verification token for a hosted property
   */
  async generateVerificationToken(id: string): Promise<string | null> {
    const token = `adcp-property-verify-${crypto.randomUUID()}`;
    const result = await query<HostedProperty>(
      'UPDATE hosted_properties SET verification_token = $1 WHERE id = $2 RETURNING *',
      [token, id]
    );
    return result.rows[0] ? token : null;
  }

  // ========== Discovered Properties ==========

  /**
   * Get discovered properties by publisher domain
   */
  async getDiscoveredPropertiesByDomain(domain: string): Promise<Array<{
    id: string;
    property_id?: string;
    publisher_domain: string;
    property_type: string;
    name: string;
    identifiers: Array<{ type: string; value: string }>;
    tags: string[];
    source_type?: string;
  }>> {
    const result = await query<{
      id: string;
      property_id: string;
      publisher_domain: string;
      property_type: string;
      name: string;
      identifiers: string;
      tags: string[];
      source_type: string;
    }>(
      'SELECT * FROM discovered_properties WHERE publisher_domain = $1',
      [domain.toLowerCase()]
    );
    return result.rows.map((row) => ({
      ...row,
      identifiers: typeof row.identifiers === 'string' ? JSON.parse(row.identifiers) : row.identifiers,
    }));
  }

  /**
   * Get agent authorizations for a property
   */
  async getAgentAuthorizationsForDomain(domain: string): Promise<Array<{
    agent_url: string;
    property_name: string;
    authorized_for?: string;
  }>> {
    const result = await query<{
      agent_url: string;
      name: string;
      authorized_for: string;
    }>(
      `SELECT apa.agent_url, dp.name, apa.authorized_for
       FROM agent_property_authorizations apa
       JOIN discovered_properties dp ON apa.property_id = dp.id
       WHERE dp.publisher_domain = $1`,
      [domain.toLowerCase()]
    );
    return result.rows.map((row) => ({
      agent_url: row.agent_url,
      property_name: row.name,
      authorized_for: row.authorized_for,
    }));
  }

  // ========== Property Registry (Combined View) ==========

  /**
   * Get all properties (hosted + discovered) for registry view
   */
  async getAllPropertiesForRegistry(options: ListPropertiesOptions = {}): Promise<Array<{
    domain: string;
    source: 'adagents_json' | 'hosted' | 'discovered';
    property_count: number;
    agent_count: number;
    verified: boolean;
  }>> {
    const limit = options.limit || 100;
    const offset = options.offset || 0;
    const search = options.search ? `%${options.search}%` : null;

    const result = await query<{
      domain: string;
      source: 'adagents_json' | 'hosted' | 'discovered';
      property_count: number;
      agent_count: number;
      verified: boolean;
    }>(
      `
      -- Hosted properties
      SELECT
        publisher_domain as domain,
        'hosted' as source,
        COALESCE(jsonb_array_length(adagents_json->'properties'), 0)::int as property_count,
        COALESCE(jsonb_array_length(adagents_json->'authorized_agents'), 0)::int as agent_count,
        domain_verified as verified
      FROM hosted_properties
      WHERE is_public = true
        AND ($1::text IS NULL OR publisher_domain ILIKE $1)

      UNION ALL

      -- Discovered properties (from crawled adagents.json)
      SELECT
        publisher_domain as domain,
        CASE WHEN source_type = 'adagents_json' OR source_type IS NULL THEN 'adagents_json' ELSE 'discovered' END as source,
        COUNT(*)::int as property_count,
        (SELECT COUNT(DISTINCT apa.agent_url) FROM agent_property_authorizations apa
         JOIN discovered_properties dp2 ON apa.property_id = dp2.id
         WHERE dp2.publisher_domain = discovered_properties.publisher_domain)::int as agent_count,
        true as verified
      FROM discovered_properties
      WHERE ($1::text IS NULL OR publisher_domain ILIKE $1)
        AND publisher_domain NOT IN (SELECT publisher_domain FROM hosted_properties WHERE is_public = true)
      GROUP BY publisher_domain, source_type

      ORDER BY domain
      LIMIT $2 OFFSET $3
      `,
      [search, limit, offset]
    );

    return result.rows;
  }

  // ========== Helpers ==========

  private deserializeHostedProperty(row: HostedProperty): HostedProperty {
    return {
      ...row,
      adagents_json: typeof row.adagents_json === 'string' ? JSON.parse(row.adagents_json) : row.adagents_json,
      created_at: new Date(row.created_at),
      updated_at: new Date(row.updated_at),
    };
  }
}

// Singleton export
export const propertyDb = new PropertyDatabase();
