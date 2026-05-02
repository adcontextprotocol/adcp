import { MemberDatabase } from "./db/member-db.js";
import type { Agent, AgentType, AgentConfig, AgentVisibility, MemberProfile } from "./types.js";

export interface AgentListOptions {
  type?: AgentType;
  /**
   * Viewer has API-access tier (Professional+). Enables members_only
   * agents in the results. Defaults to false (public only).
   */
  viewerHasApiAccess?: boolean;
}

/**
 * Service for accessing agents from member profiles.
 *
 * The registry contains only agents that AAO members have explicitly
 * enrolled on their member profile. Agents found by the crawler in
 * adagents.json but not enrolled by their owner are not surfaced here.
 */
export class AgentService {
  private memberDb: MemberDatabase;

  constructor() {
    this.memberDb = new MemberDatabase();
  }

  /**
   * List agents visible to the requesting viewer, optionally filtered by type.
   */
  async listAgents(typeOrOptions?: AgentType | AgentListOptions): Promise<Agent[]> {
    const options: AgentListOptions = typeof typeOrOptions === 'string' || typeOrOptions === undefined
      ? { type: typeOrOptions as AgentType | undefined }
      : typeOrOptions;
    const { type, viewerHasApiAccess = false } = options;

    // API-access viewers can see members_only agents even on profiles that
    // have opted out of the public directory — that's the entire Scope3
    // use case. Public-only viewers are still scoped to public profiles.
    const profiles = viewerHasApiAccess
      ? await this.memberDb.listProfiles()
      : await this.memberDb.listProfiles({ is_public: true });
    const agentsByUrl = new Map<string, Agent>();

    for (const profile of profiles) {
      for (const agentConfig of profile.agents || []) {
        if (!this.isVisibleToViewer(agentConfig.visibility, viewerHasApiAccess)) continue;
        // Public agents on a profile that opted out of the public directory
        // remain only available to API-access viewers — there is no public
        // surface to leak them to.
        if (agentConfig.visibility === 'public' && !profile.is_public && !viewerHasApiAccess) continue;

        const agentType = agentConfig.type || "unknown";
        if (type && agentType !== type) continue;

        agentsByUrl.set(agentConfig.url, this.configToAgent(agentConfig, profile));
      }
    }

    return Array.from(agentsByUrl.values());
  }

  /**
   * Whether the given agent visibility is visible to a viewer whose tier
   * either does or does not grant API access. Owners see their own agents
   * regardless; this helper is for non-owner listings only.
   */
  private isVisibleToViewer(visibility: AgentVisibility, viewerHasApiAccess: boolean): boolean {
    if (visibility === 'public') return true;
    if (visibility === 'members_only') return viewerHasApiAccess;
    return false;
  }

  /**
   * Get agent by URL.
   */
  async getAgentByUrl(url: string, options: { viewerHasApiAccess?: boolean } = {}): Promise<Agent | undefined> {
    const viewerHasApiAccess = options.viewerHasApiAccess ?? false;
    // Mirror listAgents: API-access viewers can look up members_only agents
    // on private profiles; unauth viewers stay scoped to public profiles.
    const profiles = viewerHasApiAccess
      ? await this.memberDb.listProfiles()
      : await this.memberDb.listProfiles({ is_public: true });

    for (const profile of profiles) {
      for (const agentConfig of profile.agents || []) {
        if (agentConfig.url !== url) continue;
        if (!this.isVisibleToViewer(agentConfig.visibility, viewerHasApiAccess)) continue;
        if (agentConfig.visibility === 'public' && !profile.is_public && !viewerHasApiAccess) continue;
        return this.configToAgent(agentConfig, profile);
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
      type: (config.type as AgentType) || "buying",
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
