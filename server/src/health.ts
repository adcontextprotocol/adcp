import type { Agent, AgentHealth, AgentStats, ProbeErrorKind } from "./types.js";
import { Cache } from "./cache.js";
import { getPropertyIndex } from "@adcp/sdk";
import { FormatsService } from "./formats.js";
import { AAO_UA_HEALTH_CHECK } from "./config/user-agents.js";
import { logOutboundRequest } from "./db/outbound-log-db.js";
import { safeFetch } from "./utils/url-security.js";
import { logger } from "./logger.js";

export interface ClassifiedProbeError {
  kind: ProbeErrorKind;
  /** Actionable hint for humans — what to fix, not what failed */
  message: string;
  /** Raw underlying error string for debugging / detail expansion */
  raw: string;
}

/**
 * Walk an Error's `cause` chain and collect codes / messages so the SDK's
 * wrapped errors (e.g. "Failed to discover MCP endpoint" wrapping a real
 * ENOTFOUND) can still be classified by the original cause.
 */
function collectErrorChain(error: unknown): { codes: Set<string | number>; messages: string[]; names: Set<string> } {
  const codes = new Set<string | number>();
  const messages: string[] = [];
  const names = new Set<string>();
  let current: unknown = error;
  let depth = 0;
  while (current && depth < 8) {
    if (current instanceof Error) {
      if (current.name) names.add(current.name);
      if (current.message) messages.push(current.message);
      const code = (current as { code?: string | number }).code;
      if (code !== undefined) codes.add(code);
      current = (current as { cause?: unknown }).cause;
    } else if (typeof current === 'string') {
      messages.push(current);
      break;
    } else {
      break;
    }
    depth++;
  }
  return { codes, messages, names };
}

/**
 * Translate an MCP probe failure into a structured classification with an
 * actionable hint for humans. Registration mismatches (wrong path, missing
 * auth, A2A advertised at the host root) and network failures all surface
 * as opaque "MCP connection failed" errors today; this classifier puts the
 * likely cause up front so dashboard users notice. See adcp#3066.
 */
export function classifyMCPError(error: unknown): ClassifiedProbeError {
  const { codes, messages, names } = collectErrorChain(error);
  const joined = messages.join(' | ');
  const raw = messages[0] || String(error ?? '');

  // Network reachability — checked first because the SDK wraps DNS errors
  // into a generic "Failed to discover MCP endpoint" string. The cause
  // chain still surfaces ENOTFOUND / ECONNREFUSED / ETIMEDOUT codes.
  const NETWORK_CODES = new Set(['ENOTFOUND', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ECONNRESET']);
  for (const c of codes) if (typeof c === 'string' && NETWORK_CODES.has(c)) {
    return {
      kind: 'unreachable',
      message: 'Agent host is unreachable. Check that the URL is correct and the host is running.',
      raw,
    };
  }
  // Some SDK paths surface DNS failures as a literal `getaddrinfo ENOTFOUND` line.
  if (/getaddrinfo|enotfound|econnrefused|etimedout|fetch failed.*timeout|host.*unreachable/i.test(joined)) {
    return {
      kind: 'unreachable',
      message: 'Agent host is unreachable. Check that the URL is correct and the host is running.',
      raw,
    };
  }

  // SDK auth errors — endpoint exists but requires credentials. Anchor on
  // typed error names and explicit phrasing; avoid bare "401" matches that
  // would false-positive on stack traces or response bodies that mention
  // status codes incidentally.
  if (
    names.has('AuthenticationRequiredError') ||
    names.has('NeedsAuthorizationError') ||
    /\brequires?\b.*\b(auth|authoriz)/i.test(joined) ||
    /\bauthentication\s+required\b/i.test(joined) ||
    /\bwww-authenticate\b/i.test(joined) ||
    /\bunauthorized\b/i.test(joined) ||
    /\bforbidden\b/i.test(joined)
  ) {
    return {
      kind: 'auth_required',
      message: 'MCP endpoint requires authentication. Save an auth token or OAuth client credentials, then re-probe.',
      raw,
    };
  }

  // SDK couldn't find an MCP endpoint at any of the candidate paths.
  // Anchor on the SDK's explicit phrasing — bare "404" matches were too
  // loose (a successful handshake whose tool call later 404s would have
  // been mis-classified).
  if (/\b(failed\s+to\s+)?discover\s+mcp\s+endpoint\b/i.test(joined) ||
      /\bno\s+mcp\s+endpoint\b/i.test(joined)) {
    return {
      kind: 'wrong_path',
      message: 'No MCP endpoint at this URL. The agent may live at a sub-path (e.g. /mcp, /adcp/mcp) or be advertised as A2A in /.well-known/agent.json — check the registered URL.',
      raw,
    };
  }

  return { kind: 'unknown', message: `MCP connection failed: ${raw}`, raw };
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
      const classified = classifyMCPError(error);
      const fallback = await this.tryHealthCheckFallback(agent, startTime, classified);
      if (fallback) return fallback;
      return {
        online: false,
        checked_at: new Date().toISOString(),
        error: classified.message,
        error_kind: classified.kind,
        error_detail: classified.raw,
      };
    }
  }

  /**
   * Liveness-only fallback for MCP probe failures. Sellers blocked by other
   * discovery issues (path-prefixed MCP endpoints, auth-required handshakes,
   * etc.) can register a health_check_url; we GET it and treat any 2xx as
   * "online." The fallback never populates type or tools — protocol probe
   * is still the source of truth for capabilities. See adcp#3066.
   *
   * Routed through `safeFetch` so the validated URL can't be redirected to
   * cloud metadata or RFC1918 ranges between save time and dial time.
   */
  private async tryHealthCheckFallback(
    agent: Agent,
    startTime: number,
    classified: ClassifiedProbeError,
  ): Promise<AgentHealth | null> {
    if (!agent.health_check_url) return null;
    try {
      const response = await safeFetch(agent.health_check_url, {
        method: "GET",
        headers: { 'User-Agent': AAO_UA_HEALTH_CHECK },
        signal: AbortSignal.timeout(5000),
        maxRedirects: 0,
      });
      if (!response.ok) return null;
      return {
        online: true,
        checked_at: new Date().toISOString(),
        response_time_ms: Date.now() - startTime,
        // tools_count / resources_count intentionally absent — fallback
        // is liveness-only; the surfaced error preserves the underlying
        // MCP failure so dashboards can still flag the discovery gap.
        error: `Liveness via health_check_url; protocol probe failed: ${classified.message}`,
        error_kind: classified.kind,
        error_detail: classified.raw,
      };
    } catch (err) {
      // Don't surface fallback fetch failures to the dashboard — the MCP
      // error is the load-bearing signal. Log for debuggability.
      logger.debug({ err, agentUrl: agent.url, healthUrl: agent.health_check_url }, 'health_check_url fallback failed');
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
