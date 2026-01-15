import type { Agent } from "./types.js";
import { FormatsService } from "./formats.js";
import { createLogger } from "./logger.js";

const logger = createLogger('capabilities');

export interface ToolCapability {
  name: string;
  description: string;
  input_schema: any;
  verified_at: string;
}

export interface StandardOperations {
  can_search_inventory: boolean;
  can_get_availability: boolean;
  can_reserve_inventory: boolean;
  can_get_pricing: boolean;
  can_create_order: boolean;
  can_list_properties: boolean;
}

export interface CreativeCapabilities {
  formats_supported: string[];
  can_generate: boolean;
  can_validate: boolean;
  can_preview: boolean;
}

export interface SignalsCapabilities {
  audience_types: string[];
  can_match: boolean;
  can_activate: boolean;
  can_get_signals: boolean;
}

export interface AgentCapabilityProfile {
  agent_url: string;
  protocol: "mcp" | "a2a";
  discovered_tools: ToolCapability[];
  standard_operations?: StandardOperations;
  creative_capabilities?: CreativeCapabilities;
  signals_capabilities?: SignalsCapabilities;
  last_discovered: string;
  discovery_error?: string;
}

export class CapabilityDiscovery {
  private cache: Map<string, AgentCapabilityProfile> = new Map();
  private readonly CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
  private formatsService: FormatsService;

  constructor() {
    this.formatsService = new FormatsService();
  }

  async discoverCapabilities(agent: Agent): Promise<AgentCapabilityProfile> {
    const cached = this.cache.get(agent.url);
    if (cached && Date.now() - new Date(cached.last_discovered).getTime() < this.CACHE_TTL_MS) {
      return cached;
    }

    try {
      const protocol = agent.protocol || "mcp";
      const tools = await this.discoverTools(agent.url, protocol);

      const profile: AgentCapabilityProfile = {
        agent_url: agent.url,
        protocol,
        discovered_tools: tools,
        last_discovered: new Date().toISOString(),
      };

      // Analyze tools to determine standard operations
      if (agent.type === "sales") {
        profile.standard_operations = this.analyzeSalesCapabilities(tools);
      } else if (agent.type === "creative") {
        profile.creative_capabilities = await this.analyzeCreativeCapabilities(agent, tools);
      } else if (agent.type === "signals") {
        profile.signals_capabilities = this.analyzeSignalsCapabilities(tools);
      }

      this.cache.set(agent.url, profile);
      return profile;
    } catch (error: any) {
      const errorProfile: AgentCapabilityProfile = {
        agent_url: agent.url,
        protocol: agent.protocol || "mcp",
        discovered_tools: [],
        last_discovered: new Date().toISOString(),
        discovery_error: error.message,
      };
      this.cache.set(agent.url, errorProfile);
      return errorProfile;
    }
  }

  private async discoverTools(url: string, protocol: "mcp" | "a2a"): Promise<ToolCapability[]> {
    if (protocol === "a2a") {
      return this.discoverA2ATools(url);
    } else {
      return this.discoverMCPTools(url);
    }
  }

  private async discoverMCPTools(url: string): Promise<ToolCapability[]> {
    try {
      // Use AdCPClient to connect to agent
      const { AdCPClient } = await import("@adcp/client");
      const multiClient = new AdCPClient([{
        id: "discovery",
        name: "Discovery Client",
        agent_uri: url,
        protocol: "mcp",
      }]);
      const client = multiClient.agent("discovery");

      const agentInfo = await client.getAgentInfo();
      logger.debug({ url, toolCount: agentInfo.tools.length }, 'MCP discovery completed');

      return agentInfo.tools.map((tool: any) => ({
        name: tool.name,
        description: tool.description || "",
        input_schema: tool.inputSchema || tool.parameters || {},
        verified_at: new Date().toISOString(),
      }));
    } catch (error: any) {
      logger.warn({ url, error: error.message }, 'MCP discovery failed');
      return [];
    }
  }

  private async discoverA2ATools(url: string): Promise<ToolCapability[]> {
    try {
      // Use AdCPClient to connect to agent
      const { AdCPClient } = await import("@adcp/client");
      const multiClient = new AdCPClient([{
        id: "discovery",
        name: "Discovery Client",
        agent_uri: url,
        protocol: "a2a",
      }]);
      const client = multiClient.agent("discovery");

      const agentInfo = await client.getAgentInfo();
      logger.debug({ url, toolCount: agentInfo.tools.length }, 'A2A discovery completed');

      return agentInfo.tools.map((tool: any) => ({
        name: tool.name,
        description: tool.description || "",
        input_schema: tool.inputSchema || tool.parameters || {},
        verified_at: new Date().toISOString(),
      }));
    } catch (error: any) {
      logger.warn({ url, error: error.message }, 'A2A discovery failed');
      return [];
    }
  }

  private analyzeSalesCapabilities(tools: ToolCapability[]): StandardOperations {
    const toolNames = new Set(tools.map((t) => t.name.toLowerCase()));

    // Based on actual AdCP spec tools from @adcp/client types
    return {
      can_search_inventory: toolNames.has("get_products"),
      can_get_availability: toolNames.has("get_products"), // Included in get_products
      can_reserve_inventory: toolNames.has("create_media_buy"), // Part of media buy creation
      can_get_pricing: toolNames.has("get_products"), // Included in get_products
      can_create_order: toolNames.has("create_media_buy"),
      can_list_properties: toolNames.has("list_authorized_properties"),
    };
  }

  private async analyzeCreativeCapabilities(agent: Agent, tools: ToolCapability[]): Promise<CreativeCapabilities> {
    const toolNames = new Set(tools.map((t) => t.name.toLowerCase()));
    const hasFormatTool = toolNames.has("list_creative_formats");

    let formats: string[] = [];
    if (hasFormatTool) {
      try {
        const formatsProfile = await this.formatsService.getFormatsForAgent(agent);
        formats = formatsProfile.formats.map(f => f.name);
      } catch (error: any) {
        logger.warn({ url: agent.url, error: error.message }, 'Format discovery failed');
      }
    }

    return {
      formats_supported: formats,
      can_generate: toolNames.has("build_creative") || toolNames.has("generate_creative"),
      can_validate: toolNames.has("validate_creative"),
      can_preview: toolNames.has("preview_creative") || toolNames.has("get_preview"),
    };
  }

  private analyzeSignalsCapabilities(tools: ToolCapability[]): SignalsCapabilities {
    const toolNames = new Set(tools.map((t) => t.name.toLowerCase()));

    return {
      audience_types: [],
      can_match: toolNames.has("match_audience") || toolNames.has("audience_match"),
      can_activate: toolNames.has("activate_signal") || toolNames.has("activate_audience"),
      can_get_signals: toolNames.has("get_signals") || toolNames.has("list_signals"),
    };
  }

  async discoverAll(agents: Agent[]): Promise<Map<string, AgentCapabilityProfile>> {
    const profiles = new Map<string, AgentCapabilityProfile>();

    await Promise.all(
      agents.map(async (agent) => {
        const profile = await this.discoverCapabilities(agent);
        profiles.set(agent.url, profile);
      })
    );

    return profiles;
  }

  getCapabilities(agentUrl: string): AgentCapabilityProfile | undefined {
    return this.cache.get(agentUrl);
  }
}
