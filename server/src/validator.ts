import type { AdAgentsJson, AuthorizationResult } from "./types.js";
import { Cache } from "./cache.js";

/**
 * Validates that a URL is safe to fetch.
 * Blocks:
 * - Non-HTTPS URLs
 * - Private IP ranges (10.x, 172.16-31.x, 192.168.x)
 * - Loopback addresses (127.x, ::1)
 * - Link-local addresses (169.254.x)
 * - Private hostnames (localhost, localhost.)
 */
function isSafeUrl(url: string): boolean {
  try {
    const parsed = new URL(url);

    // Must use HTTPS
    if (parsed.protocol !== "https:") {
      return false;
    }

    // Check for private/loopback hostnames
    const hostname = parsed.hostname.toLowerCase();
    if (hostname === "localhost" || hostname.endsWith(".localhost")) {
      return false;
    }

    // Parse IP address and check ranges
    // Node.js URL parser returns the hostname as-is for domain names,
    // so we need to detect IP addresses first
    const ips = hostname.split(".");

    // IPv4 check
    if (ips.length === 4) {
      const [a, b, c, d] = ips.map((n) => parseInt(n, 10));
      if (
        // 10.x.x.x
        a === 10 ||
        // 172.16-31.x.x
        (a === 172 && b >= 16 && b <= 31) ||
        // 192.168.x.x
        (a === 192 && b === 168) ||
        // 127.x.x.x (loopback)
        a === 127 ||
        // 169.254.x.x (link-local)
        (a === 169 && b === 254)
      ) {
        return false;
      }
    }

    // Check for IPv6 loopback (::1)
    if (hostname === "::1" || hostname === "localhost") {
      return false;
    }

    return true;
  } catch {
    // Invalid URL
    return false;
  }
}

export class AgentValidator {
  private cache: Cache<AuthorizationResult>;

  constructor(cacheTtlMinutes: number = 15) {
    this.cache = new Cache<AuthorizationResult>(cacheTtlMinutes);
  }

  async validate(domain: string, agentUrl: string): Promise<AuthorizationResult> {
    const cacheKey = `${domain}:${agentUrl}`;
    const cached = this.cache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const result = await this.fetchAndValidate(domain, agentUrl);
    this.cache.set(cacheKey, result);
    return result;
  }

  private async fetchAndValidate(
    domain: string,
    agentUrl: string
  ): Promise<AuthorizationResult> {
    const normalizedDomain = domain.replace(/^https?:\/\//, "").replace(/\/$/, "");
    const adagentsUrl = `https://${normalizedDomain}/.well-known/adagents.json`;

    // Validate URL is safe before fetching (prevent SSRF)
    if (!isSafeUrl(adagentsUrl)) {
      return {
        authorized: false,
        domain: normalizedDomain,
        agent_url: agentUrl,
        checked_at: new Date().toISOString(),
        error: "Invalid or restricted URL (SSRF protection)",
      };
    }

    try {
      const response = await fetch(adagentsUrl, {
        headers: { "User-Agent": "AdCP-Registry/1.0" },
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) {
        return {
          authorized: false,
          domain: normalizedDomain,
          agent_url: agentUrl,
          checked_at: new Date().toISOString(),
          error: `HTTP ${response.status}`,
        };
      }

      const contentType = response.headers.get("content-type") || "";
      if (!contentType.includes("application/json")) {
        return {
          authorized: false,
          domain: normalizedDomain,
          agent_url: agentUrl,
          checked_at: new Date().toISOString(),
          error: `File does not exist or returns ${contentType} instead of JSON`,
        };
      }

      const data = await response.json() as AdAgentsJson;

      if (!data.authorized_agents || !Array.isArray(data.authorized_agents)) {
        return {
          authorized: false,
          domain: normalizedDomain,
          agent_url: agentUrl,
          checked_at: new Date().toISOString(),
          error: "Invalid adagents.json format: missing authorized_agents array",
        };
      }

      const normalizedAgentUrl = agentUrl.replace(/\/$/, "");
      const isAuthorized = data.authorized_agents.some(
        (agent) => agent.url.replace(/\/$/, "") === normalizedAgentUrl
      );

      return {
        authorized: isAuthorized,
        domain: normalizedDomain,
        agent_url: agentUrl,
        checked_at: new Date().toISOString(),
        source: adagentsUrl,
      };
    } catch (error) {
      let errorMsg = "Unknown error";
      if (error instanceof Error) {
        if (error.message.includes("Unexpected token")) {
          errorMsg = "File does not exist or is not valid JSON";
        } else if (error.name === "AbortError") {
          errorMsg = "Request timed out";
        } else {
          errorMsg = error.message;
        }
      }

      return {
        authorized: false,
        domain: normalizedDomain,
        agent_url: agentUrl,
        checked_at: new Date().toISOString(),
        error: errorMsg,
      };
    }
  }

  getCacheStats(): { size: number } {
    return { size: this.cache.size() };
  }

  clearCache(): void {
    this.cache.clear();
  }
}
