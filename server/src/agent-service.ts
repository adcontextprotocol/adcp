import { MemberDatabase } from "./db/member-db.js";
import type { Agent, AgentType, AgentConfig, MemberProfile } from "./types.js";

/**
 * Service for accessing agents from member profiles
 * Replaces the old Registry class
 */
export class AgentService {
  private memberDb: MemberDatabase;

  constructor() {
    this.memberDb = new MemberDatabase();
  }

  /**
   * List all public agents, optionally filtered by type
   */
  async listAgents(type?: AgentType): Promise<Agent[]> {
    const profiles = await this.memberDb.listProfiles({ is_public: true });
    const agents: Agent[] = [];

    for (const profile of profiles) {
      for (const agentConfig of profile.agents || []) {
        if (!agentConfig.is_public) continue;

        const agentType = agentConfig.type || "unknown";
        if (type && agentType !== type) continue;

        agents.push(this.configToAgent(agentConfig, profile));
      }
    }

    return agents;
  }

  /**
   * Get agent by URL
   */
  async getAgentByUrl(url: string): Promise<Agent | undefined> {
    const profiles = await this.memberDb.listProfiles({ is_public: true });

    for (const profile of profiles) {
      for (const agentConfig of profile.agents || []) {
        if (agentConfig.url === url && agentConfig.is_public) {
          return this.configToAgent(agentConfig, profile);
        }
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
}
