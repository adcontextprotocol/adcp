import { AdCPClient } from "@adcp/sdk";
import type { Agent, FormatInfo } from "./types.js";
import { AAO_UA_DISCOVERY } from "./config/user-agents.js";
import { agentConfigAuthFields, type SdkAuth } from "./services/sdk-auth-adapter.js";
import { withSdkSafeTransport } from "./utils/sdk-safe-fetch.js";

type AdCPClientInstance = InstanceType<typeof AdCPClient>;

export interface AgentFormatsProfile {
  agent_url: string;
  protocol: "mcp" | "a2a";
  formats: FormatInfo[];
  last_fetched: string;
  error?: string;
}

export class FormatsService {
  private cache: Map<string, AgentFormatsProfile> = new Map();
  private clients: Map<string, AdCPClientInstance> = new Map();
  private authedClients: WeakMap<SdkAuth, Map<string, AdCPClientInstance>> = new WeakMap();
  private readonly CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

  async getFormatsForAgent(agent: Agent, auth?: SdkAuth, forceRefresh = false): Promise<AgentFormatsProfile> {
    if (!auth && !forceRefresh) {
      const cached = this.cache.get(agent.url);
      if (cached && Date.now() - new Date(cached.last_fetched).getTime() < this.CACHE_TTL_MS) {
        return cached;
      }
    }

    let formats: FormatInfo[] = [];
    let error: string | undefined;

    try {
      const multiClient = this.getClient(agent, auth);
      const client = multiClient.agent(agent.name);
      const result = await client.getAdcpCapabilities({}, undefined, { timeout: 10_000 });

      if (result.success && result.data) {
        const creative = (result.data as unknown as Record<string, unknown>).creative;
        const supported = creative && typeof creative === 'object' && !Array.isArray(creative)
          ? (creative as Record<string, unknown>).supported_formats
          : undefined;
        if (!Array.isArray(supported)) {
          error = 'Agent did not declare creative.supported_formats in get_adcp_capabilities';
        } else {
          formats = supported
            .filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === 'object' && !Array.isArray(entry)))
            .map(entry => this.normalizeCapability(entry));
        }
      } else if (!result.success) {
        error = `Agent returned error: ${result.error || "Unknown error"}`;
      }
    } catch (toolError: any) {
      error = `Agent does not support canonical capability discovery: ${toolError.message}`;
    }

    const profile: AgentFormatsProfile = {
      agent_url: agent.url,
      protocol: agent.protocol || "mcp",
      formats,
      last_fetched: new Date().toISOString(),
      error,
    };

    // Don't cache authed-discovery results — the format list returned
    // with credentials may differ from the public-facing one, and this
    // cache feeds unauthed callers.
    if (!auth) this.cache.set(agent.url, profile);
    return profile;
  }

  private getClient(agent: Agent, auth?: SdkAuth): AdCPClientInstance {
    const key = this.clientCacheKey(agent);
    const clientPool = auth ? this.getAuthedClientPool(auth) : this.clients;
    const cached = clientPool.get(key);
    if (cached) return cached;

    const agentConfig = {
      id: agent.name,
      name: agent.name,
      agent_uri: agent.url,
      protocol: (agent.protocol || "mcp") as "mcp" | "a2a",
      ...agentConfigAuthFields(auth),
    };
    const client = new AdCPClient(
      [agentConfig],
      withSdkSafeTransport({ userAgent: AAO_UA_DISCOVERY }),
    );
    clientPool.set(key, client);
    return client;
  }

  private getAuthedClientPool(auth: SdkAuth): Map<string, AdCPClientInstance> {
    let pool = this.authedClients.get(auth);
    if (!pool) {
      pool = new Map();
      this.authedClients.set(auth, pool);
    }
    return pool;
  }

  private clientCacheKey(agent: Agent): string {
    const protocol = agent.protocol || "mcp";
    return `${agent.name}:${protocol}:${agent.url}`;
  }

  private normalizeCapability(entry: Record<string, unknown>): FormatInfo {
    const format = entry.format && typeof entry.format === 'object' && !Array.isArray(entry.format)
      ? entry.format as Record<string, unknown>
      : {};
    const params = format.params && typeof format.params === 'object' && !Array.isArray(format.params)
      ? format.params as Record<string, unknown>
      : {};
    const width = typeof params.width === 'number' ? params.width : undefined;
    const height = typeof params.height === 'number' ? params.height : undefined;
    return {
      name: typeof entry.capability_id === 'string'
        ? entry.capability_id
        : typeof format.format_kind === 'string' ? format.format_kind : 'unknown',
      ...(width !== undefined && height !== undefined ? { dimensions: `${width}x${height}` } : {}),
      ...(typeof params.aspect_ratio === 'string' ? { aspect_ratio: params.aspect_ratio } : {}),
      ...(typeof format.display_name === 'string' ? { description: format.display_name } : {}),
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
