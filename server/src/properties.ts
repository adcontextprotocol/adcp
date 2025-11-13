import { AgentClient } from "@adcp/client";
import type { Agent } from "./types.js";
import { AgentValidator } from "./validator.js";

export interface PropertyInfo {
  identifier?: string;
  domain?: string;
  type?: string;
  tags?: string[];
  country?: string;
  description?: string;
  verified?: boolean;
  verification_url?: string;
  verification_error?: string;
}

export interface AgentPropertiesProfile {
  agent_url: string;
  protocol: "mcp" | "a2a";
  properties: PropertyInfo[];
  last_fetched: string;
  error?: string;
}

export class PropertiesService {
  private cache: Map<string, AgentPropertiesProfile> = new Map();
  private readonly CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
  private validator: AgentValidator;

  constructor() {
    this.validator = new AgentValidator();
  }

  async getPropertiesForAgent(agent: Agent): Promise<AgentPropertiesProfile> {
    const cached = this.cache.get(agent.url);
    if (cached && Date.now() - new Date(cached.last_fetched).getTime() < this.CACHE_TTL_MS) {
      return cached;
    }

    let properties: PropertyInfo[] = [];
    let error: string | undefined;

    try {
      // Create agent client with the new API
      const agentConfig = {
        id: agent.name,
        name: agent.name,
        agent_uri: agent.url,
        protocol: (agent.protocol || "mcp") as "mcp" | "a2a",
      };
      const client = new AgentClient(agentConfig);
      const result = await client.executeTask("list_authorized_properties", {});

      if (result.success && result.data) {
        const response = result.data;

        // Handle different response formats:
        // 1. Array of properties directly
        if (Array.isArray(response)) {
          properties = response;
        }
        // 2. Object with publisher_domains (convert to properties format)
        else if (response?.publisher_domains && Array.isArray(response.publisher_domains)) {
          properties = response.publisher_domains.map((domain: string) => ({
            identifier: domain,
            domain: domain,
            type: "domain",
            tags: response.primary_channels ?
              (Array.isArray(response.primary_channels) ? response.primary_channels : [response.primary_channels])
              : undefined,
            country: response.primary_countries ?
              (Array.isArray(response.primary_countries) ? response.primary_countries[0] : response.primary_countries)
              : undefined,
            description: response.portfolio_description,
          }));
        }
        // 3. Any object - try to coerce to PropertyInfo
        else if (response) {
          properties = [response as PropertyInfo];
        }
      } else if (!result.success) {
        error = `Agent returned error: ${result.error || "Unknown error"}`;
      }
    } catch (toolError: any) {
      error = `Agent does not support list_authorized_properties: ${toolError.message}`;
    }

    // Verify each property by checking .well-known/adagents.json
    if (properties.length > 0) {
      await Promise.all(
        properties.map(async (prop) => {
          const domain = prop.domain || prop.identifier;
          if (!domain) return;

          try {
            const normalizedDomain = domain.replace(/^https?:\/\//, "").replace(/\/$/, "");
            const verificationUrl = `https://${normalizedDomain}/.well-known/adagents.json`;
            const validation = await this.validator.validate(domain, agent.url);

            prop.verified = validation.authorized;
            prop.verification_url = verificationUrl;
            if (!validation.authorized) {
              prop.verification_error = validation.error || "Agent not found in adagents.json";
            }
          } catch (verifyError: any) {
            prop.verified = false;
            prop.verification_error = `Verification failed: ${verifyError.message}`;
          }
        })
      );
    }

    const profile: AgentPropertiesProfile = {
      agent_url: agent.url,
      protocol: agent.protocol || "mcp",
      properties,
      last_fetched: new Date().toISOString(),
      error,
    };

    this.cache.set(agent.url, profile);
    return profile;
  }

  async enrichAgentsWithProperties(agents: Agent[]): Promise<Map<string, AgentPropertiesProfile>> {
    const profiles = new Map<string, AgentPropertiesProfile>();

    await Promise.all(
      agents.map(async (agent) => {
        const profile = await this.getPropertiesForAgent(agent);
        profiles.set(agent.url, profile);
      })
    );

    return profiles;
  }

  getPropertiesProfile(agentUrl: string): AgentPropertiesProfile | undefined {
    return this.cache.get(agentUrl);
  }

  getAllPropertiesProfiles(): AgentPropertiesProfile[] {
    return Array.from(this.cache.values());
  }
}
