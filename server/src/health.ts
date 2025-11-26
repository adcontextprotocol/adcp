import type { Agent, AgentHealth, AgentStats } from "./types.js";
import { Cache } from "./cache.js";
import { getPropertyIndex } from "@adcp/client";
import { FormatsService } from "./formats.js";

export class HealthChecker {
  private healthCache: Cache<AgentHealth>;
  private statsCache: Cache<AgentStats>;
  private formatsService: FormatsService;

  constructor(cacheTtlMinutes: number = 15) {
    this.healthCache = new Cache<AgentHealth>(cacheTtlMinutes);
    this.statsCache = new Cache<AgentStats>(cacheTtlMinutes);
    this.formatsService = new FormatsService();
  }

  async checkHealth(agent: Agent): Promise<AgentHealth> {
    const cached = this.healthCache.get(agent.url);
    if (cached) return cached;

    const health = await this.performHealthCheck(agent);
    this.healthCache.set(agent.url, health);
    return health;
  }

  private async performHealthCheck(agent: Agent): Promise<AgentHealth> {
    const startTime = Date.now();
    const protocol = agent.protocol || "mcp";

    // Only try the protocol the agent declares
    if (protocol === "a2a") {
      return await this.tryA2A(agent, startTime);
    } else {
      return await this.tryMCP(agent, startTime);
    }
  }

  private async tryMCP(agent: Agent, startTime: number): Promise<AgentHealth> {
    try {
      // Use AdCPClient to handle MCP protocol complexity (sessions, SSE, etc.)
      const { AdCPClient } = await import("@adcp/client");
      const multiClient = new AdCPClient([{
        id: "health-check",
        name: "Health Checker",
        agent_uri: agent.url,
        protocol: "mcp",
      }]);
      const client = multiClient.agent("health-check");

      const agentInfo = await client.getAgentInfo();
      const responseTime = Date.now() - startTime;

      return {
        online: true,
        checked_at: new Date().toISOString(),
        response_time_ms: responseTime,
        tools_count: agentInfo.tools.length,
        resources_count: (agentInfo as any).resources?.length || 0,
      };
    } catch (error: any) {
      return {
        online: false,
        checked_at: new Date().toISOString(),
        error: `MCP connection failed: ${error.message}`,
      };
    }
  }

  private async tryA2A(agent: Agent, startTime: number): Promise<AgentHealth> {
    try {
      // Check for A2A agent card at /.well-known/agent.json
      const agentCardUrl = `${agent.url.replace(/\/$/, "")}/.well-known/agent.json`;
      const response = await fetch(agentCardUrl, {
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) {
        return {
          online: false,
          checked_at: new Date().toISOString(),
          error: `A2A agent card not found (HTTP ${response.status})`,
        };
      }

      const agentCard = (await response.json()) as any;
      const responseTime = Date.now() - startTime;

      // Agent card exists, agent supports A2A
      const toolsCount = agentCard.tools?.length || agentCard.capabilities?.length || 0;

      return {
        online: true,
        checked_at: new Date().toISOString(),
        response_time_ms: responseTime,
        tools_count: toolsCount,
      };
    } catch (error) {
      return {
        online: false,
        checked_at: new Date().toISOString(),
        error: error instanceof Error ? error.message : "A2A connection failed",
      };
    }
  }

  async getStats(agent: Agent): Promise<AgentStats> {
    const cached = this.statsCache.get(agent.url);
    if (cached) return cached;

    const stats = await this.fetchStats(agent);
    this.statsCache.set(agent.url, stats);
    return stats;
  }

  private async fetchStats(agent: Agent): Promise<AgentStats> {
    const stats: AgentStats = {};

    try {
      if (agent.type === "sales") {
        // Use PropertyIndex if available (populated by crawler)
        const index = getPropertyIndex();
        const auth = index.getAgentAuthorizations(agent.url);

        if (auth && auth.properties.length > 0) {
          stats.property_count = auth.properties.length;
          stats.publishers = auth.publisher_domains;
          stats.publisher_count = auth.publisher_domains.length;
        }
      } else if (agent.type === "creative") {
        // For creative agents, get format count from FormatsService
        try {
          const formatsProfile = await this.formatsService.getFormatsForAgent(agent);
          if (formatsProfile.formats && formatsProfile.formats.length > 0) {
            stats.creative_formats = formatsProfile.formats.length;
          }
        } catch {
          // Creative format listing failed
        }
      }
    } catch {
      // Stats are optional, failure is ok
    }

    return stats;
  }

  clearCache(): void {
    this.healthCache.clear();
    this.statsCache.clear();
  }
}
