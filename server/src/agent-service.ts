import { MemberDatabase } from "./db/member-db.js";
import { FederatedIndexDatabase, type DiscoveredAgent } from "./db/federated-index-db.js";
import type { Agent, AgentType, AgentConfig, MemberProfile } from "./types.js";
import { isValidAgentType } from "./types.js";

/**
 * Service for accessing agents from member profiles and discovered agents
 * Merges registered agents (from member profiles) with discovered agents (from federated discovery)
 */
export class AgentService {
  private memberDb: MemberDatabase;
  private federatedDb: FederatedIndexDatabase;

  constructor() {
    this.memberDb = new MemberDatabase();
    this.federatedDb = new FederatedIndexDatabase();
  }

  /**
   * List all public agents, optionally filtered by type
   * Includes both registered agents (from member profiles) and discovered agents
   * Registered agents take precedence for deduplication
   */
  async listAgents(type?: AgentType): Promise<Agent[]> {
    const profiles = await this.memberDb.listProfiles({ is_public: true });
    const agentsByUrl = new Map<string, Agent>();

    // First, collect registered agents from member profiles
    for (const profile of profiles) {
      for (const agentConfig of profile.agents || []) {
        if (!agentConfig.is_public) continue;

        const agentType = agentConfig.type || "unknown";
        if (type && agentType !== type) continue;

        agentsByUrl.set(agentConfig.url, this.configToAgent(agentConfig, profile));
      }
    }

    // Then, add discovered agents (if not already registered)
    const discoveredAgents = await this.federatedDb.getAllDiscoveredAgents(type);
    for (const discovered of discoveredAgents) {
      if (agentsByUrl.has(discovered.agent_url)) continue; // Skip if already registered

      const agentType = isValidAgentType(discovered.agent_type) ? discovered.agent_type : "unknown";
      if (type && agentType !== type) continue;

      agentsByUrl.set(discovered.agent_url, this.discoveredToAgent(discovered));
    }

    return Array.from(agentsByUrl.values());
  }

  /**
   * Get agent by URL
   * Checks registered agents first, then discovered agents
   */
  async getAgentByUrl(url: string): Promise<Agent | undefined> {
    // Check registered agents first
    const profiles = await this.memberDb.listProfiles({ is_public: true });

    for (const profile of profiles) {
      for (const agentConfig of profile.agents || []) {
        if (agentConfig.url === url && agentConfig.is_public) {
          return this.configToAgent(agentConfig, profile);
        }
      }
    }

    // Check discovered agents
    const discoveredAgents = await this.federatedDb.getAllDiscoveredAgents();
    for (const discovered of discoveredAgents) {
      if (discovered.agent_url === url) {
        return this.discoveredToAgent(discovered);
      }
    }

    return undefined;
  }

  /**
   * Get agent by identifier (URL or legacy slug format like "type/name")
   * Provides backward compatibility with old registry-based lookups
   */
  async getAgent(identifier: string): Promise<Agent | undefined> {
    // If it looks like a URL, search by URL
    if (identifier.startsWith("http://") || identifier.startsWith("https://")) {
      return this.getAgentByUrl(identifier);
    }

    // Otherwise treat as legacy slug format "type/name" or just name
    // Search all agents and match by slug-like identifier
    const agents = await this.listAgents();

    for (const agent of agents) {
      // Match by type/slugified-name pattern
      const slugName = agent.name.toLowerCase().replace(/\s+/g, "-");
      const agentSlug = `${agent.type}/${slugName}`;

      if (agentSlug === identifier || slugName === identifier) {
        return agent;
      }
    }

    return undefined;
  }

  /**
   * Get all agents as a map keyed by URL
   */
  async getAllAgents(): Promise<Map<string, Agent>> {
    const agents = await this.listAgents();
    const map = new Map<string, Agent>();
    for (const agent of agents) {
      map.set(agent.url, agent);
    }
    return map;
  }

  /**
   * Convert AgentConfig + MemberProfile to Agent format
   */
  private configToAgent(config: AgentConfig, profile: MemberProfile): Agent {
    return {
      name: config.name || profile.display_name,
      url: config.url,
      type: (config.type as AgentType) || "sales",
      protocol: "mcp",
      description: profile.description || "",
      mcp_endpoint: config.url,
      contact: {
        name: profile.display_name,
        email: profile.contact_email || "",
        website: profile.contact_website || "",
      },
      added_date: profile.created_at.toISOString().split("T")[0],
    };
  }

  /**
   * Convert DiscoveredAgent to Agent format
   */
  private discoveredToAgent(discovered: DiscoveredAgent): Agent {
    return {
      name: discovered.name || new URL(discovered.agent_url).hostname,
      url: discovered.agent_url,
      type: isValidAgentType(discovered.agent_type) ? discovered.agent_type : "unknown",
      protocol: (discovered.protocol as "mcp" | "a2a") || "mcp",
      description: `Discovered from ${discovered.source_domain}`,
      mcp_endpoint: discovered.agent_url,
      contact: {
        name: discovered.source_domain,
        email: "",
        website: discovered.source_domain.startsWith("http") ? discovered.source_domain : `https://${discovered.source_domain}`,
      },
      added_date: discovered.discovered_at?.toISOString().split("T")[0] || new Date().toISOString().split("T")[0],
    };
  }
}
