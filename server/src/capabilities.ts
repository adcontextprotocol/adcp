import type { Agent } from "./types.js";
import { createLogger } from "./logger.js";
import { is401Error, AuthenticationRequiredError } from "@adcp/sdk";
import { AAO_UA_DISCOVERY } from "./config/user-agents.js";
import { logOutboundRequest } from "./db/outbound-log-db.js";
import { agentConfigAuthFields, type SdkAuth } from "./services/sdk-auth-adapter.js";
import { withSdkSafeTransport } from "./utils/sdk-safe-fetch.js";
import Ajv, { type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
  supported_formats: Array<{
    capability_id?: string;
    format: {
      format_kind: string;
      publisher_domain?: string;
      format_option_id?: string;
      params?: Record<string, unknown>;
      [key: string]: unknown;
    };
    operations: Array<'build' | 'validate' | 'preview'>;
    [key: string]: unknown;
  }>;
  preview?: {
    supported_capability_ids: string[];
    fidelity: 'authoritative' | 'representative';
  };
  can_generate: boolean;
  can_validate: boolean;
  can_preview: boolean;
  [key: string]: unknown;
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
  /**
   * Internal persistence hint. A transient/invalid creative capability probe
   * must not erase the last successfully indexed supported_formats catalog.
   */
  creative_capabilities_probe_failed?: boolean;
}

// Resolve from this module rather than process.cwd(): the server test runner
// and production entry points are both valid callers, but they start from
// different working directories.
const SOURCE_SCHEMAS_DIR = path.resolve(fileURLToPath(
  new URL('../../static/schemas/source/', import.meta.url),
));
let productFormatValidatorPromise: Promise<ValidateFunction> | null = null;

function loadLocalSchema(uri: string): object {
  if (!uri.startsWith('/schemas/')) {
    throw new Error(`Cannot resolve non-local schema reference: ${uri}`);
  }
  const fullPath = path.resolve(SOURCE_SCHEMAS_DIR, uri.slice('/schemas/'.length));
  if (fullPath !== SOURCE_SCHEMAS_DIR && !fullPath.startsWith(`${SOURCE_SCHEMAS_DIR}${path.sep}`)) {
    throw new Error(`Refusing schema reference outside source tree: ${uri}`);
  }
  return JSON.parse(readFileSync(fullPath, 'utf8')) as object;
}

function getProductFormatValidator(): Promise<ValidateFunction> {
  if (!productFormatValidatorPromise) {
    productFormatValidatorPromise = (async () => {
      const ajv = new Ajv({
        strict: false,
        allErrors: true,
        discriminator: true,
        loadSchema: async (uri: string) => loadLocalSchema(uri),
      });
      addFormats(ajv);
      return ajv.compileAsync(loadLocalSchema('/schemas/core/product-format-declaration.json'));
    })().catch(error => {
      productFormatValidatorPromise = null;
      throw error;
    });
  }
  return productFormatValidatorPromise;
}

function schemaErrors(validate: ValidateFunction): string {
  return (validate.errors ?? [])
    .slice(0, 8)
    .map(error => `${error.instancePath || '(root)'} ${error.message ?? 'is invalid'}`)
    .join('; ');
}

export async function sanitizeCreativeCapabilities(raw: unknown): Promise<CreativeCapabilities> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('creative: expected object');
  }
  const block = raw as Record<string, unknown>;
  const rawFormats = block.supported_formats;
  if (rawFormats !== undefined && !Array.isArray(rawFormats)) {
    throw new Error('creative.supported_formats: expected array');
  }
  if (Array.isArray(rawFormats) && rawFormats.length > 500) {
    throw new Error('creative.supported_formats: exceeds 500 entries');
  }

  const validateFormat = await getProductFormatValidator();
  const capabilityIds = new Set<string>();
  const supportedFormats: CreativeCapabilities['supported_formats'] = [];
  for (const [index, rawEntry] of (rawFormats ?? []).entries()) {
    if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) {
      throw new Error(`creative.supported_formats[${index}]: expected object`);
    }
    const entry = rawEntry as Record<string, unknown>;
    const capabilityId = entry.capability_id;
    const format = entry.format;
    const operations = entry.operations ?? ['build'];
    if (capabilityId !== undefined) {
      if (typeof capabilityId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(capabilityId)) {
        throw new Error(`creative.supported_formats[${index}].capability_id: expected stable identifier when present`);
      }
      if (capabilityIds.has(capabilityId)) {
        throw new Error(`creative.supported_formats[${index}].capability_id: duplicate '${capabilityId}'`);
      }
      capabilityIds.add(capabilityId);
    }
    if (!validateFormat(format)) {
      throw new Error(`creative.supported_formats[${index}].format: ${schemaErrors(validateFormat)}`);
    }
    if (!Array.isArray(operations)
      || operations.length === 0
      || new Set(operations).size !== operations.length
      || operations.some(operation => !['build', 'validate', 'preview'].includes(String(operation)))) {
      throw new Error(`creative.supported_formats[${index}].operations: unique non-empty build/validate/preview array required`);
    }
    supportedFormats.push({
      ...entry,
      ...(capabilityId === undefined ? {} : { capability_id: capabilityId }),
      format: format as CreativeCapabilities['supported_formats'][number]['format'],
      operations: operations as CreativeCapabilities['supported_formats'][number]['operations'],
    });
  }

  const hasBuildCapability = supportedFormats.some(entry => entry.operations.includes('build'));
  const previewCapabilityIds = supportedFormats
    .filter(entry => entry.operations.includes('preview'))
    .map(entry => entry.capability_id);
  const rawPreview = block.preview;
  let preview: CreativeCapabilities['preview'];
  if (previewCapabilityIds.length > 0 || rawPreview !== undefined) {
    if (!rawPreview || typeof rawPreview !== 'object' || Array.isArray(rawPreview)) {
      throw new Error('creative.preview: required object when supported_formats advertises preview');
    }
    const previewBlock = rawPreview as Record<string, unknown>;
    const supportedCapabilityIds = previewBlock.supported_capability_ids;
    if (!Array.isArray(supportedCapabilityIds)
      || supportedCapabilityIds.length === 0
      || supportedCapabilityIds.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(id))
      || new Set(supportedCapabilityIds).size !== supportedCapabilityIds.length) {
      throw new Error('creative.preview.supported_capability_ids: unique non-empty capability ID array required');
    }
    if (!['authoritative', 'representative'].includes(String(previewBlock.fidelity))) {
      throw new Error('creative.preview.fidelity: expected authoritative or representative');
    }
    if (previewCapabilityIds.some(id => id === undefined)) {
      throw new Error('creative.supported_formats: every preview operation requires capability_id');
    }
    const advertisedIds = [...previewCapabilityIds].sort();
    const declaredIds = [...supportedCapabilityIds].sort();
    if (advertisedIds.length !== declaredIds.length
      || advertisedIds.some((id, index) => id !== declaredIds[index])) {
      throw new Error('creative.preview.supported_capability_ids: must equal advertised preview capability IDs');
    }
    preview = {
      supported_capability_ids: supportedCapabilityIds as string[],
      fidelity: previewBlock.fidelity as 'authoritative' | 'representative',
    };
  }
  const declaresBuild = ['supports_generation', 'supports_transformation', 'supports_transformers', 'supports_refinement']
    .some(flag => block[flag] === true);

  const sanitized: CreativeCapabilities = {
    ...block,
    supported_formats: supportedFormats,
    ...(preview === undefined ? {} : { preview }),
    can_generate: hasBuildCapability || declaresBuild,
    can_validate: supportedFormats.some(entry => entry.operations.includes('validate')),
    can_preview: supportedFormats.some(entry => entry.operations.includes('preview')),
  };
  if (Buffer.byteLength(JSON.stringify(sanitized), 'utf8') >= 262144) {
    throw new Error('creative: serialized payload exceeds 256KB ceiling');
  }
  return sanitized;
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
  private static readonly SALES_TOOLS = ['get_products', 'create_media_buy', 'list_authorized_properties'];
  private static readonly CREATIVE_TOOLS = ['list_creative_formats', 'build_creative', 'generate_creative', 'validate_creative', 'validate_input', 'preview_creative'];
  private static readonly SIGNALS_TOOLS = ['get_signals', 'list_signals', 'match_audience', 'activate_signal', 'activate_audience'];

  constructor() {}

  async discoverCapabilities(agent: Agent, auth?: SdkAuth, forceRefresh = false): Promise<AgentCapabilityProfile> {
    // Skip cache when auth is provided — manual owner-triggered refresh
    // wants fresh data and may previously have cached an unauthed
    // discovery_error result. Periodic crawls (no auth) keep the cache.
    // `forceRefresh` covers the same manual-refresh intent for agents with
    // no saved auth (e.g. the "Recheck Status" button on an unowned/public
    // agent) — without it, a fresh probe would still be shadowed by a stale
    // unauthed cache entry for up to CACHE_TTL_MS.
    if (!auth && !forceRefresh) {
      const cached = this.cache.get(agent.url);
      if (cached && Date.now() - new Date(cached.last_discovered).getTime() < this.CACHE_TTL_MS) {
        return cached;
      }
    }

    const startTime = Date.now();
    try {
      const protocol = agent.protocol || "mcp";
      const tools = await this.discoverTools(agent.url, protocol, auth);

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
      // Pre-fetch get_adcp_capabilities once when the agent exposes the tool.
      // Both creative analysis and measurement extraction read from the same
      // response; two sequential 10-second calls inside a 10-second discovery
      // deadline can cause the probe to time out on a healthy but slow endpoint.
      const hasGetAdcpCaps = toolNames.has('get_adcp_capabilities');
      const rawAdcpCaps: Record<string, unknown> | undefined = hasGetAdcpCaps
        ? await this.fetchRawAdcpCapabilities(agent, auth)
        : undefined;

      if (CapabilityDiscovery.CREATIVE_TOOLS.some(t => toolNames.has(t))) {
        const creativeResult = await this.analyzeCreativeCapabilities(agent, tools, auth, rawAdcpCaps);
        profile.creative_capabilities = creativeResult.capabilities;
        if (creativeResult.probeFailed) profile.creative_capabilities_probe_failed = true;
      }
      if (CapabilityDiscovery.SIGNALS_TOOLS.some(t => toolNames.has(t))) {
        profile.signals_capabilities = this.analyzeSignalsCapabilities(tools);
      }
      // Measurement comes from get_adcp_capabilities — reuse the pre-fetched
      // rawAdcpCaps to avoid a second round-trip to the agent.
      if (hasGetAdcpCaps && rawAdcpCaps !== undefined) {
        const measurementRaw = rawAdcpCaps.measurement;
        if (measurementRaw !== undefined && measurementRaw !== null) {
          try {
            profile.measurement_capabilities = sanitizeMeasurementCapabilities(measurementRaw);
          } catch (err: any) {
            logger.debug({ url: agent.url, err: err?.message }, 'Measurement capability sanitization failed');
          }
        }
      }

      // Don't cache authed-discovery results in the shared cache — the
      // tool list an agent advertises behind auth may differ from the
      // public-facing one, and the cache is read by unauthed periodic
      // crawls + the public registry render.
      if (!auth) this.cache.set(agent.url, profile);
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
      // Don't cache OAuth errors - user may authorize and retry.
      // Don't cache authed probes (see successful-path comment above).
      if (!isOAuthError && !auth) {
        this.cache.set(agent.url, errorProfile);
      }
      return errorProfile;
    }
  }

  private async discoverTools(url: string, protocol: "mcp" | "a2a", auth?: SdkAuth): Promise<ToolCapability[]> {
    if (protocol === "a2a") {
      return this.discoverA2ATools(url, auth);
    } else {
      return this.discoverMCPTools(url, auth);
    }
  }

  private async discoverMCPTools(url: string, auth?: SdkAuth): Promise<ToolCapability[]> {
    try {
      // Use AdCPClient to connect to agent
      const { AdCPClient } = await import("@adcp/sdk");
      const multiClient = new AdCPClient([{
        id: "discovery",
        name: "Discovery Client",
        agent_uri: url,
        protocol: "mcp",
        ...agentConfigAuthFields(auth),
      // TODO(adcp-client#1799): maxResponseBytes is currently dormant on
      // getAgentInfo/listTools — the SDK doesn't yet wrap that path in
      // withResponseSizeLimit. Re-verify when upstream lands.
      }], withSdkSafeTransport({
        userAgent: AAO_UA_DISCOVERY,
        transport: { maxResponseBytes: 4 * 1024 * 1024 },
      }));
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
      // For generic 401 errors, unauthenticated probes can offer the OAuth
      // affordance. Authed probes should surface as credential failures
      // instead of relabeling a sent-but-rejected bearer as "OAuth required."
      if (is401Error(error) && !auth) {
        logger.info({ url }, 'MCP agent returned 401');
        throw new AuthenticationRequiredError(url, undefined, 'Agent requires authentication');
      }
      logger.debug({ url, error: error.message }, 'MCP discovery failed');
      throw error;
    }
  }

  private async discoverA2ATools(url: string, auth?: SdkAuth): Promise<ToolCapability[]> {
    try {
      // Use AdCPClient to connect to agent
      const { AdCPClient } = await import("@adcp/sdk");
      const multiClient = new AdCPClient([{
        id: "discovery",
        name: "Discovery Client",
        agent_uri: url,
        protocol: "a2a",
        ...agentConfigAuthFields(auth),
      // TODO(adcp-client#1799): cap dormant on A2AClient.fromCardUrl until upstream wraps it.
      }], withSdkSafeTransport({
        userAgent: AAO_UA_DISCOVERY,
        transport: { maxResponseBytes: 4 * 1024 * 1024 },
      }));
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
      // For generic 401 errors, unauthenticated probes can offer the OAuth
      // affordance. Authed probes should surface as credential failures
      // instead of relabeling a sent-but-rejected bearer as "OAuth required."
      if (is401Error(error) && !auth) {
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
   * and return 'unknown' here.
   *
   * The `'buying'` value in `AgentType` is preserved exclusively through
   * member self-declaration. `resolveAgentTypes` in `routes/member-profiles.ts`
   * carries member-set `'buying'` through the null-inferred-snapshot
   * override (closes #3549). Inference here intentionally never returns
   * `'buying'` because no passive probe signal can distinguish a buy-side
   * agent from a broken/empty MCP server.
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

  private async analyzeCreativeCapabilities(
    agent: Agent,
    tools: ToolCapability[],
    auth?: SdkAuth,
    rawAdcpCaps?: Record<string, unknown>,
  ): Promise<{ capabilities: CreativeCapabilities; probeFailed: boolean }> {
    const toolNames = new Set(tools.map((t) => t.name.toLowerCase()));
    let declared: { ok: true; capabilities?: CreativeCapabilities } | { ok: false };
    if (toolNames.has('get_adcp_capabilities')) {
      if (rawAdcpCaps !== undefined) {
        const creative = rawAdcpCaps.creative;
        if (creative === undefined || creative === null) {
          declared = { ok: true };
        } else {
          try {
            declared = { ok: true, capabilities: await sanitizeCreativeCapabilities(creative) };
          } catch (err: any) {
            logger.debug({ url: agent.url, err: err?.message }, 'Creative capability sanitization failed');
            declared = { ok: false };
          }
        }
      } else {
        declared = await this.fetchCreativeCapabilities(agent, auth);
      }
    } else {
      declared = { ok: true, capabilities: undefined };
    }
    const legacyToolFallback = !declared.ok
      || (declared.capabilities?.supported_formats.length ?? 0) === 0;

    return {
      probeFailed: !declared.ok,
      capabilities: {
        ...(declared.ok ? declared.capabilities : undefined),
        supported_formats: declared.ok ? declared.capabilities?.supported_formats ?? [] : [],
        can_generate: (declared.ok && declared.capabilities?.can_generate === true)
          || (legacyToolFallback && (toolNames.has("build_creative") || toolNames.has("generate_creative"))),
        can_validate: (declared.ok && declared.capabilities?.can_validate === true)
          || (legacyToolFallback && (toolNames.has("validate_input") || toolNames.has("validate_creative"))),
        can_preview: (declared.ok && declared.capabilities?.can_preview === true)
          || (legacyToolFallback && (toolNames.has("preview_creative") || toolNames.has("get_preview"))),
      },
    };
  }

  /**
   * Read the canonical creative capability catalog directly from
   * get_adcp_capabilities. list_creative_formats is a deprecated compatibility
   * task in 3.2 and must never be the registry's source of truth.
   */
  private async fetchCreativeCapabilities(
    agent: Agent,
    auth?: SdkAuth,
  ): Promise<{ ok: true; capabilities?: CreativeCapabilities } | { ok: false }> {
    try {
      const { AdCPClient } = await import("@adcp/sdk");
      const multiClient = new AdCPClient([{
        id: "discovery",
        name: "Discovery Client",
        agent_uri: agent.url,
        protocol: agent.protocol || "mcp",
        ...agentConfigAuthFields(auth),
      }], withSdkSafeTransport({
        userAgent: AAO_UA_DISCOVERY,
        transport: { maxResponseBytes: 1024 * 1024 },
      }));
      const client = multiClient.agent("discovery");
      const result = await client.getAdcpCapabilities({}, undefined, { timeout: 10_000 });
      if (!result?.success) {
        logger.debug({ url: agent.url, error: result?.error }, 'Creative capability probe returned an error result');
        return { ok: false };
      }
      const creative = (result?.data as Record<string, unknown> | undefined)?.creative;
      if (creative === undefined || creative === null) return { ok: true };
      return { ok: true, capabilities: await sanitizeCreativeCapabilities(creative) };
    } catch (err: any) {
      logger.debug({ url: agent.url, err: err?.message }, 'Creative capability fetch failed');
      return { ok: false };
    }
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

  private async fetchRawAdcpCapabilities(
    agent: Agent,
    auth?: SdkAuth,
  ): Promise<Record<string, unknown> | undefined> {
    try {
      const { AdCPClient } = await import("@adcp/sdk");
      const multiClient = new AdCPClient([{
        id: "discovery",
        name: "Discovery Client",
        agent_uri: agent.url,
        protocol: agent.protocol || "mcp",
        ...agentConfigAuthFields(auth),
      }], withSdkSafeTransport({
        userAgent: AAO_UA_DISCOVERY,
        transport: { maxResponseBytes: 1024 * 1024 },
      }));
      const client = multiClient.agent("discovery");
      const result = await client.getAdcpCapabilities({}, undefined, { timeout: 10_000 });
      if (!result?.success) return undefined;
      return result.data as Record<string, unknown> | undefined;
    } catch (err: any) {
      logger.debug({ url: agent.url, err: err?.message }, 'get_adcp_capabilities fetch failed');
      return undefined;
    }
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
  private async fetchMeasurementCapabilities(agent: Agent, auth?: SdkAuth): Promise<MeasurementCapabilities | undefined> {
    try {
      const { AdCPClient } = await import("@adcp/sdk");
      const multiClient = new AdCPClient([{
        id: "discovery",
        name: "Discovery Client",
        agent_uri: agent.url,
        protocol: agent.protocol || "mcp",
        ...agentConfigAuthFields(auth),
      }], withSdkSafeTransport({
        userAgent: AAO_UA_DISCOVERY,
        transport: { maxResponseBytes: 1024 * 1024 },
      }));
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
