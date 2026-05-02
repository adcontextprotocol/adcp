import type { Agent, AgentHealth, AgentStats } from "./types.js";
import { Cache } from "./cache.js";
import { getPropertyIndex } from "@adcp/sdk";
import { FormatsService } from "./formats.js";
import { AAO_UA_HEALTH_CHECK } from "./config/user-agents.js";
import { logOutboundRequest } from "./db/outbound-log-db.js";

/**
 * Translate an MCP probe failure into a message that hints at the most
 * common operator mistakes. Registration mismatches (wrong path, missing
 * auth, A2A advertised at the host root) all surface as opaque "MCP
 * connection failed" errors today; this classifier puts the likely cause
 * up front so dashboard users notice. See adcp#3066.
 */
export function classifyMCPError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? '');
  const name = error instanceof Error ? error.name : '';
  const code = (error as { code?: string | number } | null)?.code;

  // SDK auth errors — endpoint exists but requires credentials.
  if (
    name === 'AuthenticationRequiredError' ||
    name === 'NeedsAuthorizationError' ||
    /unauthor|forbidden|401|403|www-authenticate/i.test(raw)
  ) {
    return `MCP endpoint requires authentication. Save an auth token or OAuth client credentials, then re-probe. (${raw})`;
  }
  // SDK couldn't find an MCP endpoint at any of the candidate paths.
  if (/discover\s+mcp\s+endpoint|no\s+mcp\s+endpoint|404/i.test(raw)) {
    return `No MCP endpoint at this URL. The agent may live at a sub-path (e.g. /mcp, /adcp/mcp) or be advertised as A2A in /.well-known/agent.json — check the registered URL. (${raw})`;
  }
  // Network reachability — DNS, refused, timed out.
  if (
    code === 'ENOTFOUND' || code === 'ECONNREFUSED' || code === 'ETIMEDOUT' ||
    /network|fetch failed|timeout|unreachable/i.test(raw)
  ) {
    return `Agent host is unreachable. (${raw})`;
  }
  return `MCP connection failed: ${raw}`;
}

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
    const health = protocol === "a2a"
      ? await this.tryA2A(agent, startTime)
      : await this.tryMCP(agent, startTime);

    logOutboundRequest({
      agent_url: agent.url,
      request_type: 'health_check',
      user_agent: AAO_UA_HEALTH_CHECK,
      response_time_ms: health.response_time_ms ?? (Date.now() - startTime),
      success: health.online,
      error_message: health.error,
    });

    return health;
  }

  private async tryMCP(agent: Agent, startTime: number): Promise<AgentHealth> {
    try {
      // Use AdCPClient to handle MCP protocol complexity (sessions, SSE, etc.)
      const { AdCPClient } = await import("@adcp/sdk");
      const multiClient = new AdCPClient([{
        id: "health-check",
        name: "Health Checker",
        agent_uri: agent.url,
        protocol: "mcp",
      }], { userAgent: AAO_UA_HEALTH_CHECK });
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
      const mcpError = classifyMCPError(error);
      const fallback = await this.tryHealthCheckFallback(agent, startTime, mcpError);
      if (fallback) return fallback;
      return {
        online: false,
        checked_at: new Date().toISOString(),
        error: mcpError,
      };
    }
  }

  /**
   * Liveness-only fallback for MCP probe failures. Sellers blocked by other
   * discovery issues (path-prefixed MCP endpoints, auth-required handshakes,
   * etc.) can register a health_check_url; we GET it and treat any 2xx as
   * "online." The fallback never populates type or tools — protocol probe
   * is still the source of truth for capabilities. See adcp#3066.
   */
  private async tryHealthCheckFallback(
    agent: Agent,
    startTime: number,
    mcpError: string,
  ): Promise<AgentHealth | null> {
    if (!agent.health_check_url) return null;
    try {
      const response = await fetch(agent.health_check_url, {
        method: "GET",
        headers: { 'User-Agent': AAO_UA_HEALTH_CHECK },
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) return null;
      return {
        online: true,
        checked_at: new Date().toISOString(),
        response_time_ms: Date.now() - startTime,
        // tools_count / resources_count intentionally absent — fallback
        // is liveness-only; the surfaced error preserves the underlying
        // MCP failure so dashboards can still flag the discovery gap.
        error: `Liveness via health_check_url; protocol probe failed: ${mcpError}`,
      };
    } catch {
      return null;
    }
  }

  private async tryA2A(agent: Agent, startTime: number): Promise<AgentHealth> {
    try {
      // Check for A2A agent card at /.well-known/agent.json
      const agentCardUrl = `${agent.url.replace(/\/$/, "")}/.well-known/agent.json`;
      const response = await fetch(agentCardUrl, {
        headers: { 'User-Agent': AAO_UA_HEALTH_CHECK },
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
