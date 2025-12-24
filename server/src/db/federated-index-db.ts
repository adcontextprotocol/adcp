import { query } from './client.js';

/**
 * Discovered agent from adagents.json or list_authorized_properties
 */
export interface DiscoveredAgent {
  id?: string;
  agent_url: string;
  source_type: 'adagents_json' | 'list_authorized_properties';
  source_domain: string;
  name?: string;
  agent_type?: string;
  protocol?: string;
  discovered_at?: Date;
  last_validated?: Date;
  expires_at?: Date;
}

/**
 * Discovered publisher from sales agent list_authorized_properties
 */
export interface DiscoveredPublisher {
  id?: string;
  domain: string;
  discovered_by_agent: string;
  discovered_at?: Date;
  last_validated?: Date;
  has_valid_adagents?: boolean;
  expires_at?: Date;
}

/**
 * Agent-publisher authorization (from adagents.json or agent claims)
 */
export interface AgentPublisherAuthorization {
  id?: string;
  agent_url: string;
  publisher_domain: string;
  authorized_for?: string;
  property_ids?: string[];
  source: 'adagents_json' | 'agent_claim';
  discovered_at?: Date;
  last_validated?: Date;
}

/**
 * Property identifier from adagents.json
 */
export interface PropertyIdentifier {
  type: string;  // domain, ios_bundle, android_package, etc.
  value: string;
}

/**
 * Discovered property from adagents.json properties array
 */
export interface DiscoveredProperty {
  id?: string;
  property_id?: string;  // Optional ID from adagents.json
  publisher_domain: string;
  property_type: string;  // website, mobile_app, ctv_app, etc.
  name: string;
  identifiers: PropertyIdentifier[];
  tags?: string[];
  discovered_at?: Date;
  last_validated?: Date;
  expires_at?: Date;
}

/**
 * Agent-property authorization
 */
export interface AgentPropertyAuthorization {
  id?: string;
  agent_url: string;
  property_id: string;  // UUID of discovered_properties row
  authorized_for?: string;
  discovered_at?: Date;
}

/**
 * Publisher property selector from AdCP Product schema.
 * Supports three selection patterns: all, by_id, by_tag
 */
export type PublisherPropertySelector =
  | { publisher_domain: string; selection_type: 'all' }
  | { publisher_domain: string; selection_type: 'by_id'; property_ids: string[] }
  | { publisher_domain: string; selection_type: 'by_tag'; property_tags: string[] };

/**
 * Database operations for federated discovery index
 */
export class FederatedIndexDatabase {
  // ============================================
  // Reverse Lookups (indexed for fast queries)
  // ============================================

  /**
   * Get all agents authorized for a specific domain
   * Uses idx_auth_by_publisher index
   */
  async getAgentsForDomain(domain: string): Promise<AgentPublisherAuthorization[]> {
    const result = await query<AgentPublisherAuthorization>(
      `SELECT agent_url, publisher_domain, authorized_for, property_ids, source, discovered_at, last_validated
       FROM agent_publisher_authorizations
       WHERE publisher_domain = $1
       ORDER BY source, agent_url`,
      [domain]
    );
    return result.rows;
  }

  /**
   * Get all publisher domains for a specific agent
   * Uses idx_auth_by_agent index
   */
  async getDomainsForAgent(agentUrl: string): Promise<AgentPublisherAuthorization[]> {
    const result = await query<AgentPublisherAuthorization>(
      `SELECT agent_url, publisher_domain, authorized_for, property_ids, source, discovered_at, last_validated
       FROM agent_publisher_authorizations
       WHERE agent_url = $1
       ORDER BY source, publisher_domain`,
      [agentUrl]
    );
    return result.rows;
  }

  /**
   * Get sales agents that claim to sell for a domain
   * Uses idx_discovered_publishers_domain index
   */
  async getSalesAgentsClaimingDomain(domain: string): Promise<DiscoveredPublisher[]> {
    const result = await query<DiscoveredPublisher>(
      `SELECT domain, discovered_by_agent, discovered_at, last_validated, has_valid_adagents, expires_at
       FROM discovered_publishers
       WHERE domain = $1
       ORDER BY discovered_by_agent`,
      [domain]
    );
    return result.rows;
  }

  // ============================================
  // List All
  // ============================================

  /**
   * Get all discovered agents, optionally filtered by type
   */
  async getAllDiscoveredAgents(agentType?: string): Promise<DiscoveredAgent[]> {
    let sql = `
      SELECT id, agent_url, source_type, source_domain, name, agent_type, protocol,
             discovered_at, last_validated, expires_at
      FROM discovered_agents
    `;
    const params: unknown[] = [];

    if (agentType) {
      sql += ` WHERE agent_type = $1`;
      params.push(agentType);
    }

    sql += ` ORDER BY discovered_at DESC`;

    const result = await query<DiscoveredAgent>(sql, params);
    return result.rows;
  }

  /**
   * Get all discovered publishers
   */
  async getAllDiscoveredPublishers(): Promise<DiscoveredPublisher[]> {
    const result = await query<DiscoveredPublisher>(
      `SELECT DISTINCT ON (domain)
         domain, discovered_by_agent, discovered_at, last_validated, has_valid_adagents, expires_at
       FROM discovered_publishers
       ORDER BY domain, discovered_at DESC`
    );
    return result.rows;
  }

  /**
   * Get all unique domains from discovered publishers
   */
  async getAllDiscoveredDomains(): Promise<string[]> {
    const result = await query<{ domain: string }>(
      `SELECT DISTINCT domain FROM discovered_publishers ORDER BY domain`
    );
    return result.rows.map(r => r.domain);
  }

  // ============================================
  // CRUD Operations (for crawler)
  // ============================================

  /**
   * Upsert a discovered agent
   */
  async upsertAgent(agent: DiscoveredAgent): Promise<DiscoveredAgent> {
    const result = await query<DiscoveredAgent>(
      `INSERT INTO discovered_agents (
         agent_url, source_type, source_domain, name, agent_type, protocol, expires_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (agent_url) DO UPDATE SET
         source_type = EXCLUDED.source_type,
         source_domain = EXCLUDED.source_domain,
         name = COALESCE(EXCLUDED.name, discovered_agents.name),
         agent_type = COALESCE(EXCLUDED.agent_type, discovered_agents.agent_type),
         protocol = COALESCE(EXCLUDED.protocol, discovered_agents.protocol),
         last_validated = NOW(),
         expires_at = EXCLUDED.expires_at
       RETURNING *`,
      [
        agent.agent_url,
        agent.source_type,
        agent.source_domain,
        agent.name || null,
        agent.agent_type || null,
        agent.protocol || 'mcp',
        agent.expires_at || null,
      ]
    );
    return result.rows[0];
  }

  /**
   * Upsert a discovered publisher
   */
  async upsertPublisher(publisher: DiscoveredPublisher): Promise<DiscoveredPublisher> {
    const result = await query<DiscoveredPublisher>(
      `INSERT INTO discovered_publishers (
         domain, discovered_by_agent, has_valid_adagents, expires_at
       ) VALUES ($1, $2, $3, $4)
       ON CONFLICT (domain, discovered_by_agent) DO UPDATE SET
         last_validated = NOW(),
         has_valid_adagents = COALESCE(EXCLUDED.has_valid_adagents, discovered_publishers.has_valid_adagents),
         expires_at = EXCLUDED.expires_at
       RETURNING *`,
      [
        publisher.domain,
        publisher.discovered_by_agent,
        publisher.has_valid_adagents ?? false,
        publisher.expires_at || null,
      ]
    );
    return result.rows[0];
  }

  /**
   * Upsert an agent-publisher authorization
   */
  async upsertAuthorization(auth: AgentPublisherAuthorization): Promise<AgentPublisherAuthorization> {
    const result = await query<AgentPublisherAuthorization>(
      `INSERT INTO agent_publisher_authorizations (
         agent_url, publisher_domain, authorized_for, property_ids, source
       ) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (agent_url, publisher_domain, source) DO UPDATE SET
         authorized_for = COALESCE(EXCLUDED.authorized_for, agent_publisher_authorizations.authorized_for),
         property_ids = COALESCE(EXCLUDED.property_ids, agent_publisher_authorizations.property_ids),
         last_validated = NOW()
       RETURNING *`,
      [
        auth.agent_url,
        auth.publisher_domain,
        auth.authorized_for || null,
        auth.property_ids || null,
        auth.source,
      ]
    );
    return result.rows[0];
  }

  /**
   * Update agent metadata (name, type, protocol) after probing
   */
  async updateAgentMetadata(
    agentUrl: string,
    metadata: { name?: string; agent_type?: string; protocol?: string }
  ): Promise<void> {
    await query(
      `UPDATE discovered_agents
       SET name = COALESCE($2, name),
           agent_type = COALESCE($3, agent_type),
           protocol = COALESCE($4, protocol),
           last_validated = NOW()
       WHERE agent_url = $1`,
      [agentUrl, metadata.name || null, metadata.agent_type || null, metadata.protocol || null]
    );
  }

  /**
   * Mark publisher as having valid adagents.json
   */
  async markPublisherHasValidAdagents(domain: string): Promise<void> {
    await query(
      `UPDATE discovered_publishers
       SET has_valid_adagents = TRUE, last_validated = NOW()
       WHERE domain = $1`,
      [domain]
    );
  }

  // ============================================
  // Property CRUD (for crawler)
  // ============================================

  /**
   * Upsert a discovered property
   */
  async upsertProperty(property: DiscoveredProperty): Promise<DiscoveredProperty> {
    const result = await query<DiscoveredProperty>(
      `INSERT INTO discovered_properties (
         property_id, publisher_domain, property_type, name, identifiers, tags, expires_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (publisher_domain, name, property_type) DO UPDATE SET
         property_id = COALESCE(EXCLUDED.property_id, discovered_properties.property_id),
         identifiers = EXCLUDED.identifiers,
         tags = EXCLUDED.tags,
         last_validated = NOW(),
         expires_at = EXCLUDED.expires_at
       RETURNING *`,
      [
        property.property_id || null,
        property.publisher_domain,
        property.property_type,
        property.name,
        JSON.stringify(property.identifiers),
        property.tags || [],
        property.expires_at || null,
      ]
    );
    return this.deserializeProperty(result.rows[0]);
  }

  /**
   * Link an agent to a property
   */
  async upsertAgentPropertyAuthorization(auth: AgentPropertyAuthorization): Promise<AgentPropertyAuthorization> {
    const result = await query<AgentPropertyAuthorization>(
      `INSERT INTO agent_property_authorizations (
         agent_url, property_id, authorized_for
       ) VALUES ($1, $2, $3)
       ON CONFLICT (agent_url, property_id) DO UPDATE SET
         authorized_for = COALESCE(EXCLUDED.authorized_for, agent_property_authorizations.authorized_for)
       RETURNING *`,
      [
        auth.agent_url,
        auth.property_id,
        auth.authorized_for || null,
      ]
    );
    return result.rows[0];
  }

  /**
   * Get all properties for an agent (via agent_property_authorizations)
   */
  async getPropertiesForAgent(agentUrl: string): Promise<DiscoveredProperty[]> {
    const result = await query<DiscoveredProperty>(
      `SELECT p.*
       FROM discovered_properties p
       JOIN agent_property_authorizations apa ON apa.property_id = p.id
       WHERE apa.agent_url = $1
       ORDER BY p.publisher_domain, p.property_type, p.name`,
      [agentUrl]
    );
    return result.rows.map(row => this.deserializeProperty(row));
  }

  /**
   * Get all properties for a publisher domain
   */
  async getPropertiesForDomain(domain: string): Promise<DiscoveredProperty[]> {
    const result = await query<DiscoveredProperty>(
      `SELECT * FROM discovered_properties
       WHERE publisher_domain = $1
       ORDER BY property_type, name`,
      [domain]
    );
    return result.rows.map(row => this.deserializeProperty(row));
  }

  /**
   * Get publisher domains for an agent (from properties)
   */
  async getPublisherDomainsForAgent(agentUrl: string): Promise<string[]> {
    const result = await query<{ publisher_domain: string }>(
      `SELECT DISTINCT p.publisher_domain
       FROM discovered_properties p
       JOIN agent_property_authorizations apa ON apa.property_id = p.id
       WHERE apa.agent_url = $1
       ORDER BY p.publisher_domain`,
      [agentUrl]
    );
    return result.rows.map(r => r.publisher_domain);
  }

  /**
   * Find agents that can sell a specific property by identifier
   */
  async findAgentsForPropertyIdentifier(
    identifierType: string,
    identifierValue: string
  ): Promise<Array<{ agent_url: string; property: DiscoveredProperty; publisher_domain: string }>> {
    // Query properties that have matching identifier in JSONB array
    const result = await query<{
      agent_url: string;
      publisher_domain: string;
      id: string;
      property_id: string;
      property_type: string;
      name: string;
      identifiers: string;
      tags: string[];
    }>(
      `SELECT apa.agent_url, p.publisher_domain, p.id, p.property_id, p.property_type, p.name, p.identifiers, p.tags
       FROM discovered_properties p
       JOIN agent_property_authorizations apa ON apa.property_id = p.id
       WHERE p.identifiers @> $1::jsonb
       ORDER BY p.publisher_domain, apa.agent_url`,
      [JSON.stringify([{ type: identifierType, value: identifierValue }])]
    );

    return result.rows.map(row => ({
      agent_url: row.agent_url,
      publisher_domain: row.publisher_domain,
      property: this.deserializeProperty(row),
    }));
  }

  /**
   * Deserialize property row (parse JSONB identifiers)
   */
  private deserializeProperty(row: any): DiscoveredProperty {
    return {
      ...row,
      identifiers: typeof row.identifiers === 'string'
        ? JSON.parse(row.identifiers)
        : row.identifiers || [],
    };
  }

  // ============================================
  // Validation Queries
  // ============================================

  /**
   * Validate agent authorization against publisher_properties array (Product schema format).
   * Returns detailed breakdown per selector showing what's authorized vs not.
   *
   * @param agentUrl - The agent URL to validate
   * @param publisherProperties - Array of publisher property selectors (same format as Product.publisher_properties)
   * @returns Detailed validation result per selector
   */
  async validateAgentForProduct(
    agentUrl: string,
    publisherProperties: PublisherPropertySelector[]
  ): Promise<{
    authorized: boolean;
    coverage_percentage: number;
    total_requested: number;
    total_authorized: number;
    selectors: Array<{
      publisher_domain: string;
      selection_type: 'all' | 'by_id' | 'by_tag';
      requested_count: number;
      authorized_count: number;
      unauthorized_items?: string[];  // IDs or tags not covered
      source: 'adagents_json' | 'agent_claim' | 'none';
    }>;
  }> {
    const selectorResults: Array<{
      publisher_domain: string;
      selection_type: 'all' | 'by_id' | 'by_tag';
      requested_count: number;
      authorized_count: number;
      unauthorized_items?: string[];
      source: 'adagents_json' | 'agent_claim' | 'none';
    }> = [];

    let totalRequested = 0;
    let totalAuthorized = 0;

    for (const selector of publisherProperties) {
      let result: { requested: number; authorized: number; unauthorized?: string[]; source: 'adagents_json' | 'agent_claim' | 'none' };

      switch (selector.selection_type) {
        case 'all':
          result = await this.validateSelectorAll(agentUrl, selector.publisher_domain);
          break;
        case 'by_id':
          result = await this.validateSelectorByIds(agentUrl, selector.publisher_domain, selector.property_ids);
          break;
        case 'by_tag':
          result = await this.validateSelectorByTags(agentUrl, selector.publisher_domain, selector.property_tags);
          break;
      }

      selectorResults.push({
        publisher_domain: selector.publisher_domain,
        selection_type: selector.selection_type,
        requested_count: result.requested,
        authorized_count: result.authorized,
        unauthorized_items: result.unauthorized,
        source: result.source,
      });

      totalRequested += result.requested;
      totalAuthorized += result.authorized;
    }

    const coveragePercentage = totalRequested > 0 ? Math.round((totalAuthorized / totalRequested) * 100) : 0;

    return {
      authorized: totalAuthorized === totalRequested && totalRequested > 0,
      coverage_percentage: coveragePercentage,
      total_requested: totalRequested,
      total_authorized: totalAuthorized,
      selectors: selectorResults,
    };
  }

  /**
   * Validate "all" selector - agent must have authorization for the publisher domain
   */
  private async validateSelectorAll(
    agentUrl: string,
    publisherDomain: string
  ): Promise<{ requested: number; authorized: number; source: 'adagents_json' | 'agent_claim' | 'none' }> {
    // Count total properties for this publisher
    const totalResult = await query<{ count: string }>(
      `SELECT COUNT(*) as count FROM discovered_properties WHERE publisher_domain = $1`,
      [publisherDomain]
    );
    const totalCount = parseInt(totalResult.rows[0]?.count || '0', 10);

    // Count properties the agent is authorized for
    const authorizedResult = await query<{ count: string }>(
      `SELECT COUNT(*) as count
       FROM discovered_properties p
       JOIN agent_property_authorizations apa ON apa.property_id = p.id
       WHERE p.publisher_domain = $1 AND apa.agent_url = $2`,
      [publisherDomain, agentUrl]
    );
    const authorizedCount = parseInt(authorizedResult.rows[0]?.count || '0', 10);

    // Check authorization source
    const source = await this.getAuthorizationSource(agentUrl, publisherDomain);

    return {
      requested: totalCount,
      authorized: authorizedCount,
      source,
    };
  }

  /**
   * Validate "by_id" selector - check specific property IDs
   */
  private async validateSelectorByIds(
    agentUrl: string,
    publisherDomain: string,
    propertyIds: string[]
  ): Promise<{ requested: number; authorized: number; unauthorized: string[]; source: 'adagents_json' | 'agent_claim' | 'none' }> {
    if (propertyIds.length === 0) {
      return { requested: 0, authorized: 0, unauthorized: [], source: 'none' };
    }

    // Find which property IDs the agent is authorized for
    const result = await query<{ property_id: string }>(
      `SELECT p.property_id
       FROM discovered_properties p
       JOIN agent_property_authorizations apa ON apa.property_id = p.id
       WHERE p.publisher_domain = $1
         AND apa.agent_url = $2
         AND p.property_id = ANY($3)`,
      [publisherDomain, agentUrl, propertyIds]
    );

    const authorizedIds = new Set(result.rows.map(r => r.property_id));
    const unauthorizedIds = propertyIds.filter(id => !authorizedIds.has(id));
    const source = await this.getAuthorizationSource(agentUrl, publisherDomain);

    return {
      requested: propertyIds.length,
      authorized: authorizedIds.size,
      unauthorized: unauthorizedIds,
      source,
    };
  }

  /**
   * Validate "by_tag" selector - check properties matching tags
   */
  private async validateSelectorByTags(
    agentUrl: string,
    publisherDomain: string,
    propertyTags: string[]
  ): Promise<{ requested: number; authorized: number; unauthorized: string[]; source: 'adagents_json' | 'agent_claim' | 'none' }> {
    if (propertyTags.length === 0) {
      return { requested: 0, authorized: 0, unauthorized: [], source: 'none' };
    }

    // Count total properties matching these tags for this publisher
    const totalResult = await query<{ count: string }>(
      `SELECT COUNT(*) as count
       FROM discovered_properties
       WHERE publisher_domain = $1 AND tags && $2`,
      [publisherDomain, propertyTags]
    );
    const totalCount = parseInt(totalResult.rows[0]?.count || '0', 10);

    // Count authorized properties matching these tags
    const authorizedResult = await query<{ count: string }>(
      `SELECT COUNT(*) as count
       FROM discovered_properties p
       JOIN agent_property_authorizations apa ON apa.property_id = p.id
       WHERE p.publisher_domain = $1
         AND apa.agent_url = $2
         AND p.tags && $3`,
      [publisherDomain, agentUrl, propertyTags]
    );
    const authorizedCount = parseInt(authorizedResult.rows[0]?.count || '0', 10);

    // Find which tags have no coverage
    const unauthorizedTags: string[] = [];
    for (const tag of propertyTags) {
      const tagResult = await query<{ count: string }>(
        `SELECT COUNT(*) as count
         FROM discovered_properties p
         JOIN agent_property_authorizations apa ON apa.property_id = p.id
         WHERE p.publisher_domain = $1
           AND apa.agent_url = $2
           AND $3 = ANY(p.tags)`,
        [publisherDomain, agentUrl, tag]
      );
      if (parseInt(tagResult.rows[0]?.count || '0', 10) === 0) {
        unauthorizedTags.push(tag);
      }
    }

    const source = await this.getAuthorizationSource(agentUrl, publisherDomain);

    return {
      requested: totalCount,
      authorized: authorizedCount,
      unauthorized: unauthorizedTags,
      source,
    };
  }

  /**
   * Get authorization source for an agent/publisher pair
   */
  private async getAuthorizationSource(
    agentUrl: string,
    publisherDomain: string
  ): Promise<'adagents_json' | 'agent_claim' | 'none'> {
    const authResult = await query<{ source: string }>(
      `SELECT source FROM agent_publisher_authorizations
       WHERE agent_url = $1 AND publisher_domain = $2
       ORDER BY CASE source WHEN 'adagents_json' THEN 0 ELSE 1 END
       LIMIT 1`,
      [agentUrl, publisherDomain]
    );

    if (authResult.rows.length === 0) return 'none';
    return authResult.rows[0].source as 'adagents_json' | 'agent_claim';
  }

  /**
   * Expand publisher_properties selectors to concrete property identifiers.
   * Used by real-time systems to cache all valid identifiers for a product.
   *
   * @param agentUrl - The agent URL
   * @param publisherProperties - Array of selectors to expand
   * @returns All property identifiers covered by the selectors
   */
  async expandPublisherPropertiesToIdentifiers(
    agentUrl: string,
    publisherProperties: PublisherPropertySelector[]
  ): Promise<Array<{
    publisher_domain: string;
    property_id: string;
    property_name: string;
    property_type: string;
    identifiers: PropertyIdentifier[];
    tags: string[];
  }>> {
    const results: Array<{
      publisher_domain: string;
      property_id: string;
      property_name: string;
      property_type: string;
      identifiers: PropertyIdentifier[];
      tags: string[];
    }> = [];

    for (const selector of publisherProperties) {
      let properties: DiscoveredProperty[];

      switch (selector.selection_type) {
        case 'all':
          properties = await this.getAuthorizedPropertiesForDomain(agentUrl, selector.publisher_domain);
          break;
        case 'by_id':
          properties = await this.getAuthorizedPropertiesByIds(agentUrl, selector.publisher_domain, selector.property_ids);
          break;
        case 'by_tag':
          properties = await this.getAuthorizedPropertiesByTags(agentUrl, selector.publisher_domain, selector.property_tags);
          break;
      }

      for (const prop of properties) {
        results.push({
          publisher_domain: prop.publisher_domain,
          property_id: prop.property_id || prop.id || '',
          property_name: prop.name,
          property_type: prop.property_type,
          identifiers: prop.identifiers,
          tags: prop.tags || [],
        });
      }
    }

    return results;
  }

  /**
   * Get all authorized properties for an agent in a specific domain
   */
  private async getAuthorizedPropertiesForDomain(
    agentUrl: string,
    publisherDomain: string
  ): Promise<DiscoveredProperty[]> {
    const result = await query<DiscoveredProperty>(
      `SELECT p.*
       FROM discovered_properties p
       JOIN agent_property_authorizations apa ON apa.property_id = p.id
       WHERE p.publisher_domain = $1 AND apa.agent_url = $2
       ORDER BY p.property_type, p.name`,
      [publisherDomain, agentUrl]
    );
    return result.rows.map(row => this.deserializeProperty(row));
  }

  /**
   * Get authorized properties by specific IDs
   */
  private async getAuthorizedPropertiesByIds(
    agentUrl: string,
    publisherDomain: string,
    propertyIds: string[]
  ): Promise<DiscoveredProperty[]> {
    if (propertyIds.length === 0) return [];

    const result = await query<DiscoveredProperty>(
      `SELECT p.*
       FROM discovered_properties p
       JOIN agent_property_authorizations apa ON apa.property_id = p.id
       WHERE p.publisher_domain = $1
         AND apa.agent_url = $2
         AND p.property_id = ANY($3)
       ORDER BY p.property_type, p.name`,
      [publisherDomain, agentUrl, propertyIds]
    );
    return result.rows.map(row => this.deserializeProperty(row));
  }

  /**
   * Get authorized properties by tags
   */
  private async getAuthorizedPropertiesByTags(
    agentUrl: string,
    publisherDomain: string,
    propertyTags: string[]
  ): Promise<DiscoveredProperty[]> {
    if (propertyTags.length === 0) return [];

    const result = await query<DiscoveredProperty>(
      `SELECT p.*
       FROM discovered_properties p
       JOIN agent_property_authorizations apa ON apa.property_id = p.id
       WHERE p.publisher_domain = $1
         AND apa.agent_url = $2
         AND p.tags && $3
       ORDER BY p.property_type, p.name`,
      [publisherDomain, agentUrl, propertyTags]
    );
    return result.rows.map(row => this.deserializeProperty(row));
  }

  /**
   * Check if a specific property identifier is authorized for an agent.
   * Optimized for real-time ad request validation.
   *
   * @param agentUrl - The agent URL to check
   * @param identifierType - Type of identifier (domain, ios_bundle, android_package, etc.)
   * @param identifierValue - The identifier value to look up
   * @returns Quick validation result
   */
  async isPropertyAuthorizedForAgent(
    agentUrl: string,
    identifierType: string,
    identifierValue: string
  ): Promise<{
    authorized: boolean;
    property_id?: string;
    publisher_domain?: string;
  }> {
    const result = await query<{
      id: string;
      publisher_domain: string;
    }>(
      `SELECT p.id, p.publisher_domain
       FROM discovered_properties p
       JOIN agent_property_authorizations apa ON apa.property_id = p.id
       WHERE apa.agent_url = $1
         AND p.identifiers @> $2::jsonb
       LIMIT 1`,
      [agentUrl, JSON.stringify([{ type: identifierType, value: identifierValue }])]
    );

    if (result.rows.length === 0) {
      return { authorized: false };
    }

    return {
      authorized: true,
      property_id: result.rows[0].id,
      publisher_domain: result.rows[0].publisher_domain,
    };
  }

  // ============================================
  // Cleanup
  // ============================================

  /**
   * Delete expired records
   */
  async deleteExpired(): Promise<{ agents: number; publishers: number; authorizations: number }> {
    const agentsResult = await query(
      `DELETE FROM discovered_agents WHERE expires_at IS NOT NULL AND expires_at < NOW()`
    );
    const publishersResult = await query(
      `DELETE FROM discovered_publishers WHERE expires_at IS NOT NULL AND expires_at < NOW()`
    );
    // Clean up authorizations for agents that no longer exist
    const authResult = await query(
      `DELETE FROM agent_publisher_authorizations
       WHERE agent_url NOT IN (SELECT agent_url FROM discovered_agents)
         AND agent_url NOT IN (
           SELECT a.url FROM member_profiles m, jsonb_array_elements(m.agents) AS a(url)
           WHERE a.url IS NOT NULL
         )`
    );

    return {
      agents: agentsResult.rowCount || 0,
      publishers: publishersResult.rowCount || 0,
      authorizations: authResult.rowCount || 0,
    };
  }

  /**
   * Clear all federated discovery data (for testing or reset)
   */
  async clearAll(): Promise<void> {
    await query('DELETE FROM agent_property_authorizations');
    await query('DELETE FROM discovered_properties');
    await query('DELETE FROM agent_publisher_authorizations');
    await query('DELETE FROM discovered_publishers');
    await query('DELETE FROM discovered_agents');
  }

  // ============================================
  // Stats
  // ============================================

  /**
   * Get statistics about the federated index
   */
  async getStats(): Promise<{
    discovered_agents: number;
    discovered_publishers: number;
    discovered_properties: number;
    authorizations: number;
    authorizations_by_source: { adagents_json: number; agent_claim: number };
    properties_by_type: Record<string, number>;
  }> {
    const [agentsResult, publishersResult, propertiesResult, authResult, authBySourceResult, propsByTypeResult] = await Promise.all([
      query<{ count: string }>('SELECT COUNT(*) as count FROM discovered_agents'),
      query<{ count: string }>('SELECT COUNT(DISTINCT domain) as count FROM discovered_publishers'),
      query<{ count: string }>('SELECT COUNT(*) as count FROM discovered_properties'),
      query<{ count: string }>('SELECT COUNT(*) as count FROM agent_publisher_authorizations'),
      query<{ source: string; count: string }>(
        `SELECT source, COUNT(*) as count FROM agent_publisher_authorizations GROUP BY source`
      ),
      query<{ property_type: string; count: string }>(
        `SELECT property_type, COUNT(*) as count FROM discovered_properties GROUP BY property_type`
      ),
    ]);

    const bySource = { adagents_json: 0, agent_claim: 0 };
    for (const row of authBySourceResult.rows) {
      if (row.source === 'adagents_json') bySource.adagents_json = parseInt(row.count, 10);
      if (row.source === 'agent_claim') bySource.agent_claim = parseInt(row.count, 10);
    }

    const propsByType: Record<string, number> = {};
    for (const row of propsByTypeResult.rows) {
      propsByType[row.property_type] = parseInt(row.count, 10);
    }

    return {
      discovered_agents: parseInt(agentsResult.rows[0].count, 10),
      discovered_publishers: parseInt(publishersResult.rows[0].count, 10),
      discovered_properties: parseInt(propertiesResult.rows[0].count, 10),
      authorizations: parseInt(authResult.rows[0].count, 10),
      authorizations_by_source: bySource,
      properties_by_type: propsByType,
    };
  }
}
