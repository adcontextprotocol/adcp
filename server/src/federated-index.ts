import { FederatedIndexDatabase, type DiscoveredAgent, type DiscoveredPublisher, type AgentPublisherAuthorization, type DiscoveredProperty, type PropertyIdentifier, type PublisherPropertySelector } from './db/federated-index-db.js';
import { MemberDatabase } from './db/member-db.js';
import type { FederatedAgent, FederatedPublisher, DomainLookupResult, AgentType } from './types.js';

/**
 * Service layer for federated agent/publisher discovery.
 * Merges registered data (from member_profiles) with discovered data (from crawling).
 */
export class FederatedIndexService {
  private db: FederatedIndexDatabase;
  private memberDb: MemberDatabase;

  constructor() {
    this.db = new FederatedIndexDatabase();
    this.memberDb = new MemberDatabase();
  }

  // ============================================
  // List All (merged view)
  // ============================================

  /**
   * List all agents (registered + discovered), optionally filtered by type.
   * Registered agents take precedence for deduplication.
   */
  async listAllAgents(type?: AgentType): Promise<FederatedAgent[]> {
    // Get registered agents from member profiles
    const profiles = await this.memberDb.listProfiles({ is_public: true });
    const registeredAgents = new Map<string, FederatedAgent>();

    for (const profile of profiles) {
      for (const agentConfig of profile.agents || []) {
        if (!agentConfig.is_public) continue;

        const agentType = agentConfig.type || 'unknown';
        if (type && agentType !== type) continue;

        registeredAgents.set(agentConfig.url, {
          url: agentConfig.url,
          name: agentConfig.name || profile.display_name,
          type: agentType as FederatedAgent['type'],
          protocol: 'mcp',
          source: 'registered',
          member: {
            slug: profile.slug,
            display_name: profile.display_name,
          },
        });
      }
    }

    // Get discovered agents
    const discoveredAgents = await this.db.getAllDiscoveredAgents(type);

    // Get authorizations to find which domain discovered each agent
    const allAuths = new Map<string, AgentPublisherAuthorization>();
    for (const agent of discoveredAgents) {
      const auths = await this.db.getDomainsForAgent(agent.agent_url);
      if (auths.length > 0) {
        allAuths.set(agent.agent_url, auths[0]); // Use first authorization as source
      }
    }

    // Merge: registered takes precedence
    const result: FederatedAgent[] = Array.from(registeredAgents.values());

    for (const discovered of discoveredAgents) {
      if (registeredAgents.has(discovered.agent_url)) {
        continue; // Skip if already registered
      }

      const auth = allAuths.get(discovered.agent_url);

      result.push({
        url: discovered.agent_url,
        name: discovered.name,
        type: (discovered.agent_type as FederatedAgent['type']) || 'unknown',
        protocol: (discovered.protocol as 'mcp' | 'a2a') || 'mcp',
        source: 'discovered',
        discovered_from: auth ? {
          publisher_domain: auth.publisher_domain,
          authorized_for: auth.authorized_for,
        } : {
          publisher_domain: discovered.source_domain,
        },
        discovered_at: discovered.discovered_at?.toISOString(),
      });
    }

    return result;
  }

  /**
   * List all publishers (registered + discovered).
   * Registered publishers take precedence for deduplication.
   */
  async listAllPublishers(): Promise<FederatedPublisher[]> {
    // Get registered publishers from member profiles
    const profiles = await this.memberDb.listProfiles({ is_public: true });
    const registeredPublishers = new Map<string, FederatedPublisher>();

    for (const profile of profiles) {
      for (const pubConfig of profile.publishers || []) {
        if (!pubConfig.is_public) continue;

        registeredPublishers.set(pubConfig.domain, {
          domain: pubConfig.domain,
          source: 'registered',
          member: {
            slug: profile.slug,
            display_name: profile.display_name,
          },
          agent_count: pubConfig.agent_count,
          last_validated: pubConfig.last_validated,
        });
      }
    }

    // Get discovered publishers
    const discoveredPublishers = await this.db.getAllDiscoveredPublishers();

    // Merge: registered takes precedence
    const result: FederatedPublisher[] = Array.from(registeredPublishers.values());

    for (const discovered of discoveredPublishers) {
      if (registeredPublishers.has(discovered.domain)) {
        continue; // Skip if already registered
      }

      result.push({
        domain: discovered.domain,
        source: 'discovered',
        discovered_from: {
          agent_url: discovered.discovered_by_agent,
        },
        has_valid_adagents: discovered.has_valid_adagents,
        discovered_at: discovered.discovered_at?.toISOString(),
      });
    }

    return result;
  }

  // ============================================
  // Reverse Lookups
  // ============================================

  /**
   * Lookup a domain to find all authorized agents and sales agents claiming it.
   */
  async lookupDomain(domain: string): Promise<DomainLookupResult> {
    // Build a map of registered agents for enrichment
    const profiles = await this.memberDb.listProfiles({ is_public: true });
    const registeredAgentUrls = new Map<string, { slug: string; display_name: string }>();

    for (const profile of profiles) {
      for (const agentConfig of profile.agents || []) {
        if (agentConfig.is_public) {
          registeredAgentUrls.set(agentConfig.url, {
            slug: profile.slug,
            display_name: profile.display_name,
          });
        }
      }
    }

    // Get agents authorized via adagents.json
    const authorizations = await this.db.getAgentsForDomain(domain);
    const authorizedAgents = authorizations
      .filter(auth => auth.source === 'adagents_json')
      .map(auth => {
        const member = registeredAgentUrls.get(auth.agent_url);
        return {
          url: auth.agent_url,
          authorized_for: auth.authorized_for,
          source: member ? 'registered' as const : 'discovered' as const,
          member,
        };
      });

    // Get sales agents claiming this domain
    const claims = await this.db.getSalesAgentsClaimingDomain(domain);
    const salesAgentsClaiming = claims.map(claim => {
      const member = registeredAgentUrls.get(claim.discovered_by_agent);
      return {
        url: claim.discovered_by_agent,
        source: member ? 'registered' as const : 'discovered' as const,
        member,
      };
    });

    return {
      domain,
      authorized_agents: authorizedAgents,
      sales_agents_claiming: salesAgentsClaiming,
    };
  }

  /**
   * Get all domains an agent is authorized for.
   */
  async getDomainsForAgent(agentUrl: string): Promise<string[]> {
    const authorizations = await this.db.getDomainsForAgent(agentUrl);
    return authorizations.map(auth => auth.publisher_domain);
  }

  // ============================================
  // Recording discoveries (for crawler)
  // ============================================

  /**
   * Record an agent discovered from an adagents.json file.
   */
  async recordAgentFromAdagentsJson(
    agentUrl: string,
    publisherDomain: string,
    authorizedFor?: string,
    propertyIds?: string[]
  ): Promise<void> {
    // Record the agent
    await this.db.upsertAgent({
      agent_url: agentUrl,
      source_type: 'adagents_json',
      source_domain: publisherDomain,
    });

    // Record the authorization
    await this.db.upsertAuthorization({
      agent_url: agentUrl,
      publisher_domain: publisherDomain,
      authorized_for: authorizedFor,
      property_ids: propertyIds,
      source: 'adagents_json',
    });
  }

  /**
   * Record a publisher discovered from a sales agent's list_authorized_properties.
   */
  async recordPublisherFromAgent(
    domain: string,
    salesAgentUrl: string,
    hasValidAdagents?: boolean
  ): Promise<void> {
    await this.db.upsertPublisher({
      domain,
      discovered_by_agent: salesAgentUrl,
      has_valid_adagents: hasValidAdagents,
    });

    // Also record the claim (unverified authorization)
    await this.db.upsertAuthorization({
      agent_url: salesAgentUrl,
      publisher_domain: domain,
      source: 'agent_claim',
    });
  }

  /**
   * Update agent metadata after probing.
   */
  async updateAgentMetadata(
    agentUrl: string,
    metadata: { name?: string; agent_type?: string; protocol?: string }
  ): Promise<void> {
    await this.db.updateAgentMetadata(agentUrl, metadata);
  }

  /**
   * Mark a publisher domain as having valid adagents.json.
   */
  async markPublisherHasValidAdagents(domain: string): Promise<void> {
    await this.db.markPublisherHasValidAdagents(domain);
  }

  // ============================================
  // Property Recording (for crawler)
  // ============================================

  /**
   * Record a property discovered from adagents.json and link it to authorized agents.
   */
  async recordProperty(
    property: {
      property_id?: string;
      publisher_domain: string;
      property_type: string;
      name: string;
      identifiers: PropertyIdentifier[];
      tags?: string[];
    },
    agentUrl: string,
    authorizedFor?: string
  ): Promise<void> {
    // Upsert the property
    const savedProperty = await this.db.upsertProperty({
      property_id: property.property_id,
      publisher_domain: property.publisher_domain,
      property_type: property.property_type,
      name: property.name,
      identifiers: property.identifiers,
      tags: property.tags,
    });

    // Link agent to property
    if (savedProperty.id) {
      await this.db.upsertAgentPropertyAuthorization({
        agent_url: agentUrl,
        property_id: savedProperty.id,
        authorized_for: authorizedFor,
      });
    }
  }

  /**
   * Get all properties an agent can sell (from database).
   */
  async getPropertiesForAgent(agentUrl: string): Promise<DiscoveredProperty[]> {
    return this.db.getPropertiesForAgent(agentUrl);
  }

  /**
   * Get all publisher domains for an agent (from properties).
   */
  async getPublisherDomainsForAgent(agentUrl: string): Promise<string[]> {
    return this.db.getPublisherDomainsForAgent(agentUrl);
  }

  /**
   * Get all properties for a publisher domain.
   */
  async getPropertiesForDomain(domain: string): Promise<DiscoveredProperty[]> {
    return this.db.getPropertiesForDomain(domain);
  }

  /**
   * Find agents that can sell a specific property by identifier.
   */
  async findAgentsForPropertyIdentifier(
    identifierType: string,
    identifierValue: string
  ): Promise<Array<{ agent_url: string; property: DiscoveredProperty; publisher_domain: string }>> {
    return this.db.findAgentsForPropertyIdentifier(identifierType, identifierValue);
  }

  // ============================================
  // Validation (for real-time checks)
  // ============================================

  /**
   * Validate agent authorization against a product's publisher_properties.
   * Accepts the same format as Product.publisher_properties from get_products.
   *
   * Use cases:
   * - "Does agent X have rights to sell this product's inventory?"
   * - "What percentage of this product is covered by agent X?"
   *
   * @param agentUrl - The agent URL to validate
   * @param publisherProperties - Array of selectors (same format as Product.publisher_properties)
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
      unauthorized_items?: string[];
      source: 'adagents_json' | 'agent_claim' | 'none';
    }>;
  }> {
    return this.db.validateAgentForProduct(agentUrl, publisherProperties);
  }

  /**
   * Expand publisher_properties selectors to all concrete property identifiers.
   * Used by real-time systems to pre-cache all valid identifiers for a product.
   *
   * Use case: Real-time ad server needs to validate incoming requests against
   * a product's authorized inventory. This expands the selectors to a flat list
   * of all identifiers (domains, bundle IDs, etc.) that the system can cache.
   *
   * @param agentUrl - The agent URL
   * @param publisherProperties - Array of selectors to expand
   */
  async expandPublisherPropertiesToIdentifiers(
    agentUrl: string,
    publisherProperties: PublisherPropertySelector[]
  ): Promise<Array<{
    publisher_domain: string;
    property_id: string;
    property_name: string;
    property_type: string;
    identifiers: Array<{ type: string; value: string }>;
    tags: string[];
  }>> {
    return this.db.expandPublisherPropertiesToIdentifiers(agentUrl, publisherProperties);
  }

  /**
   * Quick check if a property identifier is authorized for an agent.
   * Optimized for real-time ad request validation.
   * Use case: "Is this property ID/domain authorized for this agent?"
   *
   * @param agentUrl - The agent URL to check
   * @param identifierType - Type (domain, ios_bundle, android_package, etc.)
   * @param identifierValue - The identifier value
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
    return this.db.isPropertyAuthorizedForAgent(agentUrl, identifierType, identifierValue);
  }

  // ============================================
  // Maintenance
  // ============================================

  /**
   * Clean up expired records.
   */
  async cleanupExpired(): Promise<{ agents: number; publishers: number; authorizations: number }> {
    return this.db.deleteExpired();
  }

  /**
   * Get statistics about the federated index.
   */
  async getStats(): Promise<{
    registered_agents: number;
    registered_publishers: number;
    discovered_agents: number;
    discovered_publishers: number;
    discovered_properties: number;
    authorizations: number;
    authorizations_by_source: { adagents_json: number; agent_claim: number };
    properties_by_type: Record<string, number>;
  }> {
    // Count registered
    const profiles = await this.memberDb.listProfiles({ is_public: true });
    let registeredAgents = 0;
    let registeredPublishers = 0;

    for (const profile of profiles) {
      registeredAgents += (profile.agents || []).filter(a => a.is_public).length;
      registeredPublishers += (profile.publishers || []).filter(p => p.is_public).length;
    }

    // Get discovered stats
    const dbStats = await this.db.getStats();

    return {
      registered_agents: registeredAgents,
      registered_publishers: registeredPublishers,
      ...dbStats,
    };
  }

  /**
   * Clear all discovered data (for testing or reset).
   */
  async clearDiscovered(): Promise<void> {
    await this.db.clearAll();
  }
}
