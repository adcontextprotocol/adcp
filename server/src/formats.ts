import { AdCPClient } from "@adcp/client";
import type { Agent, FormatInfo } from "./types.js";

export interface AgentFormatsProfile {
  agent_url: string;
  protocol: "mcp" | "a2a";
  formats: FormatInfo[];
  last_fetched: string;
  error?: string;
}

export class FormatsService {
  private cache: Map<string, AgentFormatsProfile> = new Map();
  private readonly CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

  async getFormatsForAgent(agent: Agent): Promise<AgentFormatsProfile> {
    const cached = this.cache.get(agent.url);
    if (cached && Date.now() - new Date(cached.last_fetched).getTime() < this.CACHE_TTL_MS) {
      return cached;
    }

    let formats: FormatInfo[] = [];
    let error: string | undefined;

    try {
      const agentConfig = {
        id: agent.name,
        name: agent.name,
        agent_uri: agent.url,
        protocol: (agent.protocol || "mcp") as "mcp" | "a2a",
      };
      const multiClient = new AdCPClient([agentConfig]);
      const client = multiClient.agent(agent.name);
      const result = await client.executeTask("list_creative_formats", {});

      if (result.success && result.data) {
        const response = result.data;

        // Handle different response formats:
        // 1. Array of formats directly
        if (Array.isArray(response)) {
          formats = response.map(this.normalizeFormat);
        }
        // 2. Object with formats array
        else if (response?.formats && Array.isArray(response.formats)) {
          formats = response.formats.map(this.normalizeFormat);
        }
        // 3. Single format object
        else if (response && typeof response === "object") {
          formats = [this.normalizeFormat(response)];
        }
      } else if (!result.success) {
        error = `Agent returned error: ${result.error || "Unknown error"}`;
      }
    } catch (toolError: any) {
      error = `Agent does not support list_creative_formats: ${toolError.message}`;
    }

    const profile: AgentFormatsProfile = {
      agent_url: agent.url,
      protocol: agent.protocol || "mcp",
      formats,
      last_fetched: new Date().toISOString(),
      error,
    };

    this.cache.set(agent.url, profile);
    return profile;
  }

  private normalizeFormat(format: any): FormatInfo {
    // Handle string format (just a name)
    if (typeof format === "string") {
      return { name: format };
    }

    // Handle object format
    return {
      name: format.name || format.format || "unknown",
      dimensions: format.dimensions || format.size,
      aspect_ratio: format.aspect_ratio || format.aspectRatio,
      type: format.type || format.format_type,
      description: format.description,
    };
  }

  async enrichAgentsWithFormats(agents: Agent[]): Promise<Map<string, AgentFormatsProfile>> {
    const profiles = new Map<string, AgentFormatsProfile>();

    await Promise.all(
      agents.map(async (agent) => {
        const profile = await this.getFormatsForAgent(agent);
        profiles.set(agent.url, profile);
      })
    );

    return profiles;
  }

  getFormatsProfile(agentUrl: string): AgentFormatsProfile | undefined {
    return this.cache.get(agentUrl);
  }

  getAllFormatsProfiles(): AgentFormatsProfile[] {
    return Array.from(this.cache.values());
  }
}
