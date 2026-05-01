import type { Agent } from "./types.js";
import { FormatsService } from "./formats.js";
import { createLogger } from "./logger.js";
import { is401Error, AuthenticationRequiredError } from "@adcp/sdk";
import { AAO_UA_DISCOVERY } from "./config/user-agents.js";
import { logOutboundRequest } from "./db/outbound-log-db.js";

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

/**
 * Measurement capability block, mirrored from `get_adcp_capabilities`'s
 * `measurement` response (AdCP 3.x, PR #3652). The catalog of metrics this
 * vendor computes — buyers query against `metrics[].metric_id` and
 * `metrics[].accreditations[].accrediting_body` for cross-vendor discovery.
 *
 * Strings are vendor-asserted and pass through to anonymous JSON callers; see
 * `sanitizeMeasurementCapabilities` in this file for the write-time cleaning
 * that strips control chars, rejects scriptish content, and constrains URI
 * schemes. The DB CHECK on `measurement_capabilities_size_cap` is the
 * belt-and-braces backstop (see migration 461).
 */
export interface MeasurementAccreditation {
  accrediting_body: string;
  certification_id?: string;
  valid_until?: string;
  evidence_url?: string;
  /**
   * Always `false` on the public registry surface — the vendor self-asserts
   * accreditation; AAO does not independently verify. Buyers rendering the
   * value should treat it as a vendor claim, not an AAO endorsement.
   */
  verified_by_aao: false;
}

export interface MeasurementMetric {
  metric_id: string;
  standard_reference?: string;
  accreditations?: MeasurementAccreditation[];
  unit?: string;
  description?: string;
  methodology_url?: string;
  methodology_version?: string;
}

export interface MeasurementCapabilities {
  metrics: MeasurementMetric[];
}

export interface AgentCapabilityProfile {
  agent_url: string;
  protocol: "mcp" | "a2a";
  discovered_tools: ToolCapability[];
  standard_operations?: StandardOperations;
  creative_capabilities?: CreativeCapabilities;
  signals_capabilities?: SignalsCapabilities;
  measurement_capabilities?: MeasurementCapabilities;
  last_discovered: string;
  discovery_error?: string;
  oauth_required?: boolean;
}

/**
 * Per-field caps on the measurement capability payload. These are
 * application-side bounds enforced at write time; the column-level
 * `measurement_capabilities_size_cap` CHECK is the catastrophic backstop.
 *
 * A hostile vendor publishing 100k metrics or a 50 MB description must be
 * rejected at crawl time so the failure is visible in the registry panel
 * (via `discovery_error`) rather than silently truncated.
 */
const MEASUREMENT_LIMITS = {
  MAX_METRICS: 500,
  MAX_DESCRIPTION_LEN: 2000,
  MAX_METRIC_ID_LEN: 256,
  MAX_URI_LEN: 2048,
  MAX_ACCREDITATIONS_PER_METRIC: 32,
  MAX_ACCREDITING_BODY_LEN: 128,
} as const;

const SCRIPTISH_PATTERN = /<script\b|javascript:|data:text\/html|on[a-z]+\s*=/i;
const ALLOWED_URI_SCHEMES = process.env.NODE_ENV === 'production'
  ? new Set(['https:'])
  : new Set(['https:', 'http:']);

function stripControlChars(value: string): string {
  // Keep whitespace controls (\t = U+0009, \n = U+000A, \r = U+000D); strip
  // the rest of the C0 set and DEL. The character class deliberately skips
  // 0x09, 0x0A, and 0x0D so copy-paste from documents that contain real line
  // breaks survives.
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}

function rejectIfScriptish(value: string, field: string): void {
  if (SCRIPTISH_PATTERN.test(value.normalize('NFKC'))) {
    throw new Error(`measurement.${field}: rejected scriptish content`);
  }
}

function validateUri(value: string, field: string): string {
  if (value.length > MEASUREMENT_LIMITS.MAX_URI_LEN) {
    throw new Error(`measurement.${field}: URI exceeds ${MEASUREMENT_LIMITS.MAX_URI_LEN} chars`);
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`measurement.${field}: invalid URI`);
  }
  if (!ALLOWED_URI_SCHEMES.has(parsed.protocol)) {
    throw new Error(`measurement.${field}: scheme '${parsed.protocol}' not allowed`);
  }
  return parsed.toString();
}

function clampString(value: unknown, max: number, field: string): string {
  if (typeof value !== 'string') {
    throw new Error(`measurement.${field}: expected string`);
  }
  const stripped = stripControlChars(value);
  if (stripped.length > max) {
    throw new Error(`measurement.${field}: exceeds ${max} chars`);
  }
  rejectIfScriptish(stripped, field);
  return stripped;
}

/**
 * Validate, sanitize, and bound the `measurement` block from a vendor's
 * capabilities response. Throws on any violation — the caller stores the
 * error in `discovery_error` so the failure is visible in the panel rather
 * than silently truncated.
 */
export function sanitizeMeasurementCapabilities(raw: unknown): MeasurementCapabilities {
  if (!raw || typeof raw !== 'object') {
    throw new Error('measurement: not an object');
  }
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.metrics)) {
    throw new Error('measurement.metrics: expected array');
  }
  if (obj.metrics.length === 0) {
    throw new Error('measurement.metrics: empty array');
  }
  if (obj.metrics.length > MEASUREMENT_LIMITS.MAX_METRICS) {
    throw new Error(`measurement.metrics: exceeds ${MEASUREMENT_LIMITS.MAX_METRICS} entries`);
  }

  const seenIds = new Set<string>();
  const metrics: MeasurementMetric[] = [];
  for (let i = 0; i < obj.metrics.length; i++) {
    const m = obj.metrics[i];
    if (!m || typeof m !== 'object') {
      throw new Error(`measurement.metrics[${i}]: not an object`);
    }
    const metric = m as Record<string, unknown>;
    const metric_id = clampString(metric.metric_id, MEASUREMENT_LIMITS.MAX_METRIC_ID_LEN, `metrics[${i}].metric_id`);
    if (seenIds.has(metric_id)) {
      throw new Error(`measurement.metrics[${i}].metric_id: duplicate '${metric_id}'`);
    }
    seenIds.add(metric_id);

    const out: MeasurementMetric = { metric_id };
    if (metric.standard_reference !== undefined) {
      out.standard_reference = validateUri(String(metric.standard_reference), `metrics[${i}].standard_reference`);
    }
    if (metric.unit !== undefined) {
      out.unit = clampString(metric.unit, 64, `metrics[${i}].unit`);
    }
    if (metric.description !== undefined) {
      out.description = clampString(metric.description, MEASUREMENT_LIMITS.MAX_DESCRIPTION_LEN, `metrics[${i}].description`);
    }
    if (metric.methodology_url !== undefined) {
      out.methodology_url = validateUri(String(metric.methodology_url), `metrics[${i}].methodology_url`);
    }
    if (metric.methodology_version !== undefined) {
      out.methodology_version = clampString(metric.methodology_version, 64, `metrics[${i}].methodology_version`);
    }
    if (metric.accreditations !== undefined) {
      if (!Array.isArray(metric.accreditations)) {
        throw new Error(`measurement.metrics[${i}].accreditations: expected array`);
      }
      if (metric.accreditations.length > MEASUREMENT_LIMITS.MAX_ACCREDITATIONS_PER_METRIC) {
        throw new Error(`measurement.metrics[${i}].accreditations: exceeds ${MEASUREMENT_LIMITS.MAX_ACCREDITATIONS_PER_METRIC} entries`);
      }
      const accs: MeasurementAccreditation[] = [];
      for (let j = 0; j < metric.accreditations.length; j++) {
        const a = metric.accreditations[j];
        if (!a || typeof a !== 'object') {
          throw new Error(`measurement.metrics[${i}].accreditations[${j}]: not an object`);
        }
        const acc = a as Record<string, unknown>;
        const accrediting_body = clampString(acc.accrediting_body, MEASUREMENT_LIMITS.MAX_ACCREDITING_BODY_LEN, `metrics[${i}].accreditations[${j}].accrediting_body`);
        const out_a: MeasurementAccreditation = { accrediting_body, verified_by_aao: false };
        if (acc.certification_id !== undefined) {
          out_a.certification_id = clampString(acc.certification_id, 256, `metrics[${i}].accreditations[${j}].certification_id`);
        }
        if (acc.valid_until !== undefined) {
          const v = String(acc.valid_until);
          if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) {
            throw new Error(`measurement.metrics[${i}].accreditations[${j}].valid_until: not ISO 8601 date`);
          }
          out_a.valid_until = v;
        }
        if (acc.evidence_url !== undefined) {
          out_a.evidence_url = validateUri(String(acc.evidence_url), `metrics[${i}].accreditations[${j}].evidence_url`);
        }
        accs.push(out_a);
      }
      out.accreditations = accs;
    }
    metrics.push(out);
  }

  const result: MeasurementCapabilities = { metrics };
  // Final size guard — the column-level CHECK will reject anyway, but
  // surfacing a clear error here keeps the panel diagnostic and stops the
  // wasted INSERT round-trip.
  const serialized = JSON.stringify(result);
  if (serialized.length >= 262144) {
    throw new Error(`measurement: serialized payload ${serialized.length} bytes exceeds 256KB ceiling`);
  }
  return result;
}

export class CapabilityDiscovery {
  private cache: Map<string, AgentCapabilityProfile> = new Map();
  private readonly CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
  private formatsService: FormatsService;

  private static readonly SALES_TOOLS = ['get_products', 'create_media_buy', 'list_authorized_properties'];
  private static readonly CREATIVE_TOOLS = ['list_creative_formats', 'build_creative', 'generate_creative', 'validate_creative'];
  private static readonly SIGNALS_TOOLS = ['get_signals', 'list_signals', 'match_audience', 'activate_signal', 'activate_audience'];

  constructor() {
    this.formatsService = new FormatsService();
  }

  async discoverCapabilities(agent: Agent): Promise<AgentCapabilityProfile> {
    const cached = this.cache.get(agent.url);
    if (cached && Date.now() - new Date(cached.last_discovered).getTime() < this.CACHE_TTL_MS) {
      return cached;
    }

    const startTime = Date.now();
    try {
      const protocol = agent.protocol || "mcp";
      const tools = await this.discoverTools(agent.url, protocol);

      logOutboundRequest({
        agent_url: agent.url,
        request_type: 'discovery',
        user_agent: AAO_UA_DISCOVERY,
        response_time_ms: Date.now() - startTime,
        success: true,
      });

      const profile: AgentCapabilityProfile = {
        agent_url: agent.url,
        protocol,
        discovered_tools: tools,
        last_discovered: new Date().toISOString(),
      };

      // Analyze all matching capabilities (agent may support multiple types)
      const toolNames = new Set(tools.map((t) => t.name.toLowerCase()));

      if (CapabilityDiscovery.SALES_TOOLS.some(t => toolNames.has(t))) {
        profile.standard_operations = this.analyzeSalesCapabilities(tools);
      }
      if (CapabilityDiscovery.CREATIVE_TOOLS.some(t => toolNames.has(t))) {
        profile.creative_capabilities = await this.analyzeCreativeCapabilities(agent, tools);
      }
      if (CapabilityDiscovery.SIGNALS_TOOLS.some(t => toolNames.has(t))) {
        profile.signals_capabilities = this.analyzeSignalsCapabilities(tools);
      }
      // Measurement comes from get_adcp_capabilities, not from inferring on
      // tool names — only fetch when the agent actually exposes the tool, so
      // sales/creative/signals agents don't incur an extra round-trip.
      if (toolNames.has('get_adcp_capabilities')) {
        const measurement = await this.fetchMeasurementCapabilities(agent);
        if (measurement) profile.measurement_capabilities = measurement;
      }

      this.cache.set(agent.url, profile);
      return profile;
    } catch (error: any) {
      logOutboundRequest({
        agent_url: agent.url,
        request_type: 'discovery',
        user_agent: AAO_UA_DISCOVERY,
        response_time_ms: Date.now() - startTime,
        success: false,
        error_message: error.message,
      });

      const isOAuthError = error instanceof AuthenticationRequiredError;
      const errorProfile: AgentCapabilityProfile = {
        agent_url: agent.url,
        protocol: agent.protocol || "mcp",
        discovered_tools: [],
        last_discovered: new Date().toISOString(),
        discovery_error: error.message,
        oauth_required: isOAuthError,
      };
      // Don't cache OAuth errors - user may authorize and retry
      if (!isOAuthError) {
        this.cache.set(agent.url, errorProfile);
      }
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
      const { AdCPClient } = await import("@adcp/sdk");
      const multiClient = new AdCPClient([{
        id: "discovery",
        name: "Discovery Client",
        agent_uri: url,
        protocol: "mcp",
      }], { userAgent: AAO_UA_DISCOVERY });
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
      // Re-throw AuthenticationRequiredError to preserve OAuth metadata for callers
      if (error instanceof AuthenticationRequiredError) {
        logger.info({ url, hasOAuth: error.hasOAuth }, 'MCP agent requires OAuth authentication');
        throw error;
      }
      // For generic 401 errors, wrap in AuthenticationRequiredError
      if (is401Error(error)) {
        logger.info({ url }, 'MCP agent returned 401');
        throw new AuthenticationRequiredError(url, undefined, 'Agent requires authentication');
      }
      logger.debug({ url, error: error.message }, 'MCP discovery failed');
      throw error;
    }
  }

  private async discoverA2ATools(url: string): Promise<ToolCapability[]> {
    try {
      // Use AdCPClient to connect to agent
      const { AdCPClient } = await import("@adcp/sdk");
      const multiClient = new AdCPClient([{
        id: "discovery",
        name: "Discovery Client",
        agent_uri: url,
        protocol: "a2a",
      }], { userAgent: AAO_UA_DISCOVERY });
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
      // Re-throw AuthenticationRequiredError to preserve OAuth metadata for callers
      if (error instanceof AuthenticationRequiredError) {
        logger.info({ url, hasOAuth: error.hasOAuth }, 'A2A agent requires OAuth authentication');
        throw error;
      }
      // For generic 401 errors, wrap in AuthenticationRequiredError
      if (is401Error(error)) {
        logger.info({ url }, 'A2A agent returned 401');
        throw new AuthenticationRequiredError(url, undefined, 'Agent requires authentication');
      }
      logger.debug({ url, error: error.message }, 'A2A discovery failed');
      throw error;
    }
  }

  /**
   * Infer agent type from the tool list a remote agent advertises.
   *
   * The discovery vector is "what tools does this agent EXPOSE" — sell-side
   * agents publish get_products / create_media_buy / list_authorized_
   * properties for buyers to call; buy-side agents typically do NOT
   * advertise those (they call them). So advertising SALES_TOOLS maps to
   * type 'sales'. Buy-side agents are not reliably typed from this signal
   * and return 'unknown' until a stronger source (e.g. member self-
   * registration) sets the type.
   */
  private inferAgentType(tools: ToolCapability[]): 'sales' | 'creative' | 'signals' | 'unknown' {
    const toolNames = new Set(tools.map((t) => t.name.toLowerCase()));

    // Priority: sales > creative > signals when an agent advertises tools
    // from multiple buckets — sell-side wins because the rest of the
    // registry UI treats it as the primary integration surface.
    if (CapabilityDiscovery.SALES_TOOLS.some(t => toolNames.has(t))) return 'sales';
    if (CapabilityDiscovery.CREATIVE_TOOLS.some(t => toolNames.has(t))) return 'creative';
    if (CapabilityDiscovery.SIGNALS_TOOLS.some(t => toolNames.has(t))) return 'signals';

    return 'unknown';
  }

  private analyzeSalesCapabilities(tools: ToolCapability[]): StandardOperations {
    const toolNames = new Set(tools.map((t) => t.name.toLowerCase()));

    // Based on actual AdCP spec tools from @adcp/sdk types
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
        logger.debug({ url: agent.url, error: error.message }, 'Format discovery failed');
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

  /**
   * Call the agent's `get_adcp_capabilities` tool and extract the
   * `measurement` block, if present. Returns `undefined` for agents that
   * don't claim measurement (i.e. capability response omits the block).
   *
   * Validation/sanitization is delegated to `sanitizeMeasurementCapabilities`
   * — a hostile vendor publishing a 100k-metric or 50 MB-description response
   * gets rejected with a clear error rather than silently truncated. The
   * caller (the catch block in discoverCapabilities) records the error in
   * `discovery_error` so the registry panel surfaces it.
   */
  private async fetchMeasurementCapabilities(agent: Agent): Promise<MeasurementCapabilities | undefined> {
    try {
      const { AdCPClient } = await import("@adcp/sdk");
      const multiClient = new AdCPClient([{
        id: "discovery",
        name: "Discovery Client",
        agent_uri: agent.url,
        protocol: agent.protocol || "mcp",
      }], { userAgent: AAO_UA_DISCOVERY });
      const client = multiClient.agent("discovery");

      // 10s timeout matches the existing tools/list discovery budget.
      const result = await client.getAdcpCapabilities({}, undefined, { timeout: 10_000 });
      const measurement = (result?.data as Record<string, unknown> | undefined)?.measurement;
      if (measurement === undefined || measurement === null) return undefined;

      return sanitizeMeasurementCapabilities(measurement);
    } catch (err: any) {
      // Don't fail the whole discovery on a measurement-block error — the
      // agent may still have valid sales/creative/signals capability. Log
      // and continue; the panel won't show measurement filters for this
      // agent until the next crawl succeeds.
      logger.debug({ url: agent.url, err: err?.message }, 'Measurement capability fetch failed');
      return undefined;
    }
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

  /**
   * Infer agent type from a capability profile.
   * Use this to avoid duplicating the type inference logic.
   */
  inferTypeFromProfile(profile: AgentCapabilityProfile): 'sales' | 'creative' | 'signals' | 'measurement' | 'unknown' {
    if (profile.standard_operations) return 'sales';
    if (profile.creative_capabilities) return 'creative';
    if (profile.signals_capabilities) return 'signals';
    if (profile.measurement_capabilities) return 'measurement';
    return 'unknown';
  }
}
