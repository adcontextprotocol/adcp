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
    authorizations: number;
    authorizations_by_source: { adagents_json: number; agent_claim: number };
  }> {
    const [agentsResult, publishersResult, authResult, authBySourceResult] = await Promise.all([
      query<{ count: string }>('SELECT COUNT(*) as count FROM discovered_agents'),
      query<{ count: string }>('SELECT COUNT(DISTINCT domain) as count FROM discovered_publishers'),
      query<{ count: string }>('SELECT COUNT(*) as count FROM agent_publisher_authorizations'),
      query<{ source: string; count: string }>(
        `SELECT source, COUNT(*) as count FROM agent_publisher_authorizations GROUP BY source`
      ),
    ]);

    const bySource = { adagents_json: 0, agent_claim: 0 };
    for (const row of authBySourceResult.rows) {
      if (row.source === 'adagents_json') bySource.adagents_json = parseInt(row.count, 10);
      if (row.source === 'agent_claim') bySource.agent_claim = parseInt(row.count, 10);
    }

    return {
      discovered_agents: parseInt(agentsResult.rows[0].count, 10),
      discovered_publishers: parseInt(publishersResult.rows[0].count, 10),
      authorizations: parseInt(authResult.rows[0].count, 10),
      authorizations_by_source: bySource,
    };
  }
}
