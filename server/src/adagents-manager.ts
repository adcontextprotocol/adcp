import { PropertyDefinition, PlacementDefinition } from './types.js';
import { AAO_UA_VALIDATOR } from './config/user-agents.js';
import { safeFetchAxiosLike, classifySafeFetchError } from './utils/url-security.js';
import { canonicalizePublisherDomain } from './services/publisher-domain.js';

export interface ValidationError {
  field: string;
  message: string;
  severity: 'error';
}

export interface ValidationWarning {
  field: string;
  message: string;
  suggestion?: string;
}

export type DiscoveryMethod = 'direct' | 'authoritative_location' | 'ads_txt_managerdomain' | 'adagents_authoritative';

export interface AdAgentsValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
  domain: string;
  url: string;
  status_code?: number;
  /**
   * Response body byte length from the most recent fetch
   * (post-decompression). When `authoritative_location` is followed,
   * measures the canonical document body, not the stub. Set even on
   * non-200 responses for `self_invalid` triage.
   */
  response_bytes?: number;
  /**
   * Final URL after following both HTTP-layer redirects and
   * `authoritative_location`. Differs from the input URL when the
   * publisher's stub redirects elsewhere; lets verifiers audit the
   * TLS chain at the actual canonical origin.
   */
  resolved_url?: string;
  raw_data?: any;
  discovery_method: DiscoveryMethod;
  manager_domain?: string;
}

export interface AuthorizedAgent {
  url: string;
  authorized_for: string;
  authorization_type?: 'property_ids' | 'property_tags' | 'inline_properties' | 'publisher_properties' | 'signal_ids' | 'signal_tags';
  property_ids?: string[];
  property_tags?: string[];
  properties?: PropertyDefinition[];
  publisher_properties?: Array<{
    publisher_domain?: string;
    publisher_domains?: string[];
    selection_type: 'all' | 'by_id' | 'by_tag';
    property_ids?: string[];
    property_tags?: string[];
  }>;
  collections?: Array<{
    publisher_domain: string;
    collection_ids: string[];
  }>;
  placement_ids?: string[];
  placement_tags?: string[];
  delegation_type?: 'direct' | 'delegated' | 'ad_network';
  exclusive?: boolean;
  countries?: string[];
  effective_from?: string;
  effective_until?: string;
  signal_ids?: string[];
  signal_tags?: string[];
  signing_keys?: Array<{
    kid: string;
    kty: string;
    alg?: string;
    use?: string;
    crv?: string;
    x?: string;
    y?: string;
    n?: string;
    e?: string;
  }>;
}

export interface SignalDefinition {
  id: string;
  name: string;
  description?: string;
  value_type: 'binary' | 'categorical' | 'numeric';
  category?: string;
  tags?: string[];
  allowed_values?: string[];  // For categorical signals
  range?: {                   // For numeric signals
    min: number;
    max: number;
    unit?: string;
  };
  pricing_guidance?: {
    cpm_range?: { min: number; max: number };
    currency?: string;
  };
  coverage_notes?: string;
  methodology_url?: string;
}

export interface AgentCardValidationResult {
  agent_url: string;
  valid: boolean;
  errors: string[];
  status_code?: number;
  response_time_ms?: number;
  card_data?: any;
  card_endpoint?: string;
  oauth_required?: boolean;
}

export interface AdAgentsJsonInline {
  $schema?: string;
  authorized_agents: AuthorizedAgent[];
  properties?: PropertyDefinition[];
  placements?: PlacementDefinition[];
  tags?: Record<string, { name: string; description: string }>;
  placement_tags?: Record<string, { name: string; description: string }>;
  signals?: SignalDefinition[];
  signal_tags?: Record<string, { name: string; description: string }>;
  contact?: {
    name: string;
    email?: string;
    domain?: string;
    seller_id?: string;
    tag_id?: string;
  };
  last_updated?: string;
}

export interface AdAgentsJsonReference {
  $schema?: string;
  authoritative_location: string;
  last_updated?: string;
}

export type AdAgentsJson = AdAgentsJsonInline | AdAgentsJsonReference;

/**
 * Valid signal categories per the protocol specification
 */
export const VALID_SIGNAL_CATEGORIES = [
  'purchase_intent',
  'behavioral',
  'ownership',
  'lifestyle',
  'financial',
  'b2b',
  'contextual',
  'location',
  'custom',
] as const;

export type SignalCategory = typeof VALID_SIGNAL_CATEGORIES[number];

/**
 * Options for creating adagents.json
 */
export interface CreateAdAgentsJsonOptions {
  agents: AuthorizedAgent[];
  includeSchema?: boolean;
  includeTimestamp?: boolean;
  properties?: PropertyDefinition[];
  signals?: SignalDefinition[];
  signalTags?: Record<string, { name: string; description: string }>;
}

export class AdAgentsManager {

  /**
   * Validates a domain's adagents.json file
   */
  async validateDomain(domain: string): Promise<AdAgentsValidationResult> {
    return this.validateDomainInternal(domain, 0, new Set<string>());
  }

  private async validateDomainInternal(
    domain: string,
    managerFallbackDepth: number,
    visitedDomains: Set<string>
  ): Promise<AdAgentsValidationResult> {
    // Normalize domain - remove protocol and trailing slash
    const normalizedDomain = domain.replace(/^https?:\/\//, '').replace(/\/$/, '');
    const url = `https://${normalizedDomain}/.well-known/adagents.json`;
    
    const result: AdAgentsValidationResult = {
      valid: false,
      errors: [],
      warnings: [],
      domain: normalizedDomain,
      url,
      discovery_method: 'direct',
    };

    try {
      // Fetch the adagents.json file via safeFetch — connect-time DNS-
      // rebind defense + private-IP / loopback / link-local block via
      // the SSRF-safe dispatcher in utils/url-security.ts. The previous
      // axios call was suppressed with `lgtm[js/request-forgery]` but
      // had none of those guarantees once the publisher endpoint became
      // unauthenticated and reachable on view (see PR #4128 / issue #4129).
      const response = await safeFetchAxiosLike(url, {
        timeoutMs: 10000,
        headers: {
          'Accept': 'application/json',
          'User-Agent': AAO_UA_VALIDATOR,
        },
      });

      result.status_code = response.status;
      result.response_bytes = response.data.byteLength;
      // Final URL after HTTP-layer redirects (Response.url). May
      // equal `url` when no redirects fired, or a third-party origin
      // when the publisher returned a 301/302. Captured even on
      // non-200 responses for downstream `self_invalid` triage.
      result.resolved_url = response.url;

      // Check HTTP status
      if (response.status !== 200) {
        // Fallback for publisher-manager patterns: if the publisher does not
        // serve /.well-known/adagents.json but does serve ads.txt with a
        // managerdomain declaration, attempt discovery on the manager domain.
        if (response.status === 404) {
          const managerDomains = await this.tryResolveManagerDomains(normalizedDomain);
          const isHopAllowed = managerFallbackDepth < 1;
          if (managerDomains.length > 0 && isHopAllowed) {
            const managerDomain = managerDomains[managerDomains.length - 1];
            const nextVisited = new Set(visitedDomains);
            nextVisited.add(normalizedDomain);
            const isCycle = nextVisited.has(managerDomain);
            if (isCycle) {
              result.warnings.push({
                field: 'managerdomain',
                message: `Ignoring ads.txt managerdomain ${managerDomain} due to cycle detection`,
              });
            } else {
              const managerResult = await this.validateDomainInternal(
                managerDomain,
                managerFallbackDepth + 1,
                nextVisited
              );
              if (managerResult.valid) {
                if (!this.hasExplicitPublisherScope(managerResult.raw_data, normalizedDomain)) {
                  result.errors.push({
                    field: 'managerdomain_scope',
                    message: `Manager domain ${managerDomain} must explicitly scope authorization to publisher ${normalizedDomain}`,
                    severity: 'error',
                  });
                  return result;
                }
                return {
                  ...managerResult,
                  domain: normalizedDomain,
                  url,
                  discovery_method: 'ads_txt_managerdomain',
                  manager_domain: managerDomain,
                  warnings: [
                    ...managerResult.warnings,
                    {
                      field: 'managerdomain',
                      message: `No adagents.json at ${url}; used ads.txt managerdomain ${managerDomain}`,
                    },
                  ],
                };
              }
              // Surface manager-side warnings (e.g. nested depth/cycle) on the
              // outer result so callers can see why the fallback didn't validate.
              for (const w of managerResult.warnings) {
                result.warnings.push(w);
              }
            }
          } else if (managerDomains.length > 0 && !isHopAllowed) {
            result.warnings.push({
              field: 'managerdomain',
              message: `Ignoring ads.txt managerdomain entries: max fallback depth reached`,
            });
          }
        }
        const statusMessage = response.status === 404
          ? `File not found at ${url}`
          : `HTTP ${response.status} error fetching ${url}`;
        result.errors.push({
          field: 'http_status',
          message: statusMessage,
          severity: 'error'
        });
        // Don't include raw HTML error pages - they're not useful for validation
        return result;
      }

      // Decode as UTF-8 regardless of Content-Type charset declaration
      let adagentsData: unknown;
      try {
        const text = response.data.toString('utf-8');
        adagentsData = JSON.parse(text);
      } catch {
        result.errors.push({
          field: 'json',
          message: `Invalid JSON response from ${url}`,
          severity: 'error'
        });
        return result;
      }

      // Only include raw data for successful responses
      result.raw_data = adagentsData;

      // Check if this is a URL reference
      let wasUrlReference = false;
      if (this.isUrlReference(adagentsData)) {
        wasUrlReference = true;
        // Follow the reference to get the authoritative file
        const authoritativeData = await this.fetchAuthoritativeFile(
          adagentsData.authoritative_location,
          result
        );

        if (authoritativeData) {
          adagentsData = authoritativeData;
        } else {
          // Error already added to result by fetchAuthoritativeFile
          return result;
        }
      }

      this.validateStructure(adagentsData, result);
      this.validateContent(adagentsData, result);

      if (wasUrlReference) result.discovery_method = 'authoritative_location';
      // If no errors, mark as valid
      result.valid = result.errors.length === 0;

    } catch (error) {
      const classified = classifySafeFetchError(error, normalizedDomain);
      result.errors.push({ ...classified, severity: 'error' });
    }

    return result;
  }

  private async tryResolveManagerDomains(domain: string): Promise<string[]> {
    const adsTxtUrl = `https://${domain}/ads.txt`;
    try {
      const response = await safeFetchAxiosLike(adsTxtUrl, {
        timeoutMs: 10000,
        maxRedirects: 1,
        headers: {
          'Accept': 'text/plain',
          'User-Agent': AAO_UA_VALIDATOR,
        },
      });
      if (response.status !== 200) return [];
      return this.parseManagerDomains(response.data.toString('utf-8'));
    } catch {
      return [];
    }
  }

  private parseManagerDomains(adsTxtContent: string): string[] {
    const managers: string[] = [];
    const lines = adsTxtContent.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      const match = trimmed.match(/^managerdomain\s*=\s*([A-Za-z0-9.-]+)(?:\s+#\s*(.*))?$/i);
      if (match?.[1]) {
        const trailingComment = (match[2] || '').toLowerCase();
        if (/\bnoagents\b/.test(trailingComment)) {
          continue;
        }
        managers.push(match[1].toLowerCase());
      }
    }
    return managers;
  }

  /**
   * Verify that a manager-served adagents.json explicitly authorizes the
   * source publisher domain. Required by the ads.txt MANAGERDOMAIN
   * fallback (#4173) so a manager-side compromise can't auto-implicate
   * publishers that merely point at the manager via ads.txt.
   *
   * Two ways the manifest can express that scope:
   *
   * 1. **Per-agent paths.** An authorized_agents[] entry directly names
   *    the publisher under publisher_properties[].publisher_domain
   *    (singular) or publisher_properties[].publisher_domains[] (compact
   *    managed-network form — exactly equivalent to repeating the entry
   *    once per listed domain) or collections[].publisher_domain.
   *
   * 2. **Property-level paths.** A top-level properties[] entry carries
   *    publisher_domain matching the source, AND at least one
   *    authorized_agents[] entry references that property indirectly via
   *    property_ids or property_tags. This is the shape Mediavine and
   *    other managed networks use in production: the property declares
   *    its publisher_domain once, and many agents reference it through
   *    a tag without re-spelling the publisher.
   *
   * Both shapes establish the same invariant: the manager has
   * positively named the publisher in its own manifest. Inline or
   * implicit references that don't tie back to a publisher_domain
   * field do not satisfy the gate — fail closed.
   */
  private hasExplicitPublisherScope(rawData: unknown, publisherDomain: string): boolean {
    if (!rawData || typeof rawData !== 'object') return false;
    const data = rawData as AdAgentsJsonInline;
    const agents = Array.isArray(data.authorized_agents) ? data.authorized_agents : [];
    const properties = Array.isArray(data.properties) ? data.properties : [];
    const normalizedPublisher = canonicalizePublisherDomain(publisherDomain);

    // Index properties by id and by tag for the per-agent reference lookup.
    // Both indexes filter to properties whose publisher_domain matches the
    // source — properties belonging to other publishers can't satisfy the
    // gate even if an agent references them.
    const matchingPropertyIds = new Set<string>();
    const matchingPropertyTags = new Set<string>();
    for (const prop of properties) {
      if (typeof prop?.publisher_domain !== 'string') continue;
      if (canonicalizePublisherDomain(prop.publisher_domain) !== normalizedPublisher) continue;
      if (typeof prop.property_id === 'string' && prop.property_id.length > 0) {
        matchingPropertyIds.add(prop.property_id);
      }
      if (Array.isArray(prop.tags)) {
        for (const tag of prop.tags) {
          if (typeof tag === 'string' && tag.length > 0) matchingPropertyTags.add(tag);
        }
      }
    }

    return agents.some((agent) => {
      const hasPublisherProperties = Array.isArray(agent.publisher_properties)
        && agent.publisher_properties.some((p) => {
          if (typeof p.publisher_domain === 'string' && canonicalizePublisherDomain(p.publisher_domain) === normalizedPublisher) {
            return true;
          }
          if (Array.isArray(p.publisher_domains)) {
            return p.publisher_domains.some((d) => typeof d === 'string' && canonicalizePublisherDomain(d) === normalizedPublisher);
          }
          return false;
        });
      const hasCollections = Array.isArray(agent.collections)
        && agent.collections.some((c) => canonicalizePublisherDomain(c.publisher_domain) === normalizedPublisher);

      // Property-level scoping: the agent reaches a property whose
      // publisher_domain matches the source. by_id walks property_ids;
      // by_tag walks property_tags.
      const hasPropertyIdLink = Array.isArray(agent.property_ids)
        && agent.property_ids.some((id) => typeof id === 'string' && matchingPropertyIds.has(id));
      const hasPropertyTagLink = Array.isArray(agent.property_tags)
        && agent.property_tags.some((tag) => typeof tag === 'string' && matchingPropertyTags.has(tag));

      return hasPublisherProperties || hasCollections || hasPropertyIdLink || hasPropertyTagLink;
    });
  }

  /**
   * Type guard to check if data is a URL reference
   */
  private isUrlReference(data: any): data is AdAgentsJsonReference {
    return (
      typeof data === 'object' &&
      data !== null &&
      'authoritative_location' in data &&
      typeof data.authoritative_location === 'string'
    );
  }

  /**
   * Fetches the authoritative adagents.json file from a URL reference
   */
  private async fetchAuthoritativeFile(
    url: string,
    result: AdAgentsValidationResult
  ): Promise<AdAgentsJsonInline | null> {
    try {
      // Validate URL format
      try {
        const parsedUrl = new URL(url);
        if (!parsedUrl.protocol.startsWith('https:')) {
          result.errors.push({
            field: 'authoritative_location',
            message: 'Authoritative location must use HTTPS',
            severity: 'error'
          });
          return null;
        }
      } catch {
        result.errors.push({
          field: 'authoritative_location',
          message: 'authoritative_location must be a valid URL',
          severity: 'error'
        });
        return null;
      }

      // Fetch the authoritative file. safeFetch follows redirects with
      // per-hop SSRF validation, which matters more here than on the
      // /.well-known fetch — the authoritative_location URL was named
      // by the publisher and could redirect anywhere.
      const response = await safeFetchAxiosLike(url, {
        timeoutMs: 10000,
        headers: {
          'Accept': 'application/json',
          'User-Agent': AAO_UA_VALIDATOR,
        },
      });

      // Overwrite the resolved URL — when authoritative_location is
      // followed, the canonical document body came from THIS fetch,
      // not the original /.well-known. Verifiers should pin trust to
      // the authoritative location's TLS chain, not the publisher's.
      // Bytes likewise reflect the canonical body, not the stub.
      result.response_bytes = response.data.byteLength;
      result.resolved_url = response.url;

      if (response.status !== 200) {
        const statusMessage = response.status === 404
          ? `File not found at ${url}`
          : `HTTP ${response.status} error fetching ${url}`;
        result.errors.push({
          field: 'authoritative_location',
          message: statusMessage,
          severity: 'error'
        });
        return null;
      }

      // Decode as UTF-8 regardless of Content-Type charset declaration
      let authData: unknown;
      try {
        const text = response.data.toString('utf-8');
        authData = JSON.parse(text);
      } catch {
        result.errors.push({
          field: 'authoritative_location',
          message: `Invalid JSON at authoritative location ${url}`,
          severity: 'error'
        });
        return null;
      }

      // Ensure the authoritative file is not also a reference (prevent infinite loops)
      if (this.isUrlReference(authData)) {
        result.errors.push({
          field: 'authoritative_location',
          message: 'Authoritative file cannot be another URL reference (nested references not allowed)',
          severity: 'error'
        });
        return null;
      }

      return authData as AdAgentsJsonInline;
    } catch (error) {
      const msg = (error as Error)?.message;
      result.errors.push({
        field: 'authoritative_location',
        message: msg ? `Failed to fetch authoritative file: ${msg}` : 'Unknown error fetching authoritative file',
        severity: 'error',
      });
      return null;
    }
  }

  /**
   * Validates the structure of adagents.json
   */
  private validateStructure(data: any, result: AdAgentsValidationResult): void {
    if (typeof data !== 'object' || data === null) {
      result.errors.push({
        field: 'root',
        message: 'adagents.json must be a valid JSON object',
        severity: 'error'
      });
      return;
    }

    // Check required fields
    if (!data.authorized_agents) {
      result.errors.push({
        field: 'authorized_agents',
        message: 'authorized_agents field is required',
        severity: 'error'
      });
      return;
    }

    if (!Array.isArray(data.authorized_agents)) {
      result.errors.push({
        field: 'authorized_agents',
        message: 'authorized_agents must be an array',
        severity: 'error'
      });
      return;
    }

    // Validate each agent
    data.authorized_agents.forEach((agent: any, index: number) => {
      this.validateAgent(agent, index, result);
    });

    // Validate signals array if present (for data providers)
    if (data.signals !== undefined) {
      if (!Array.isArray(data.signals)) {
        result.errors.push({
          field: 'signals',
          message: 'signals must be an array',
          severity: 'error'
        });
      } else {
        data.signals.forEach((signal: any, index: number) => {
          this.validateSignal(signal, index, result);
        });
      }
    }

    // Validate signal_tags if present
    if (data.signal_tags !== undefined) {
      if (typeof data.signal_tags !== 'object' || data.signal_tags === null || Array.isArray(data.signal_tags)) {
        result.errors.push({
          field: 'signal_tags',
          message: 'signal_tags must be an object mapping tag IDs to tag definitions',
          severity: 'error'
        });
      } else {
        Object.entries(data.signal_tags).forEach(([tagId, tagDef]: [string, any]) => {
          if (typeof tagDef !== 'object' || tagDef === null) {
            result.errors.push({
              field: `signal_tags.${tagId}`,
              message: 'Each signal tag must be an object with name and description',
              severity: 'error'
            });
          } else {
            if (!tagDef.name || typeof tagDef.name !== 'string') {
              result.errors.push({
                field: `signal_tags.${tagId}.name`,
                message: 'Signal tag name is required and must be a string',
                severity: 'error'
              });
            }
          }
        });
      }
    }

    // Validate placement_tags if present
    if (data.placement_tags !== undefined) {
      if (typeof data.placement_tags !== 'object' || data.placement_tags === null || Array.isArray(data.placement_tags)) {
        result.errors.push({
          field: 'placement_tags',
          message: 'placement_tags must be an object mapping tag IDs to tag definitions',
          severity: 'error'
        });
      } else {
        Object.entries(data.placement_tags).forEach(([tagId, tagDef]: [string, any]) => {
          if (typeof tagDef !== 'object' || tagDef === null) {
            result.errors.push({
              field: `placement_tags.${tagId}`,
              message: 'Each placement tag must be an object with name and description',
              severity: 'error'
            });
          } else {
            if (!tagDef.name || typeof tagDef.name !== 'string') {
              result.errors.push({
                field: `placement_tags.${tagId}.name`,
                message: 'Placement tag name is required and must be a string',
                severity: 'error'
              });
            }
          }
        });
      }
    }

    // Check optional fields
    if (data.$schema && typeof data.$schema !== 'string') {
      result.errors.push({
        field: '$schema',
        message: '$schema must be a string',
        severity: 'error'
      });
    }

    if (data.last_updated) {
      if (typeof data.last_updated !== 'string') {
        result.errors.push({
          field: 'last_updated',
          message: 'last_updated must be an ISO 8601 timestamp string',
          severity: 'error'
        });
      } else {
        // Validate ISO 8601 format
        const isoRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
        if (!isoRegex.test(data.last_updated)) {
          result.warnings.push({
            field: 'last_updated',
            message: 'last_updated should be in ISO 8601 format (YYYY-MM-DDTHH:mm:ssZ)',
            suggestion: 'Use new Date().toISOString() format'
          });
        }
      }
    }

    // Recommendations
    if (!data.$schema) {
      result.warnings.push({
        field: '$schema',
        message: 'Consider adding $schema field for validation',
        suggestion: 'Add "$schema": "https://adcontextprotocol.org/schemas/v3/adagents.json"'
      });
    }

    if (!data.last_updated) {
      result.warnings.push({
        field: 'last_updated',
        message: 'Consider adding last_updated timestamp',
        suggestion: 'Add "last_updated": "' + new Date().toISOString() + '"'
      });
    }
  }

  /**
   * Validates an individual agent entry
   */
  private validateAgent(agent: any, index: number, result: AdAgentsValidationResult): void {
    const prefix = `authorized_agents[${index}]`;

    if (typeof agent !== 'object' || agent === null) {
      result.errors.push({
        field: prefix,
        message: 'Each agent must be an object',
        severity: 'error'
      });
      return;
    }

    // Required fields
    if (!agent.url) {
      result.errors.push({
        field: `${prefix}.url`,
        message: 'url field is required',
        severity: 'error'
      });
    } else if (typeof agent.url !== 'string') {
      result.errors.push({
        field: `${prefix}.url`,
        message: 'url must be a string',
        severity: 'error'
      });
    } else {
      // Validate URL format
      try {
        new URL(agent.url);
        
        // Check HTTPS requirement
        if (!agent.url.startsWith('https://')) {
          result.errors.push({
            field: `${prefix}.url`,
            message: 'Agent URL must use HTTPS',
            severity: 'error'
          });
        }
      } catch {
        result.errors.push({
          field: `${prefix}.url`,
          message: 'url must be a valid URL',
          severity: 'error'
        });
      }
    }

    if (!agent.authorized_for) {
      result.errors.push({
        field: `${prefix}.authorized_for`,
        message: 'authorized_for field is required',
        severity: 'error'
      });
    } else if (typeof agent.authorized_for !== 'string') {
      result.errors.push({
        field: `${prefix}.authorized_for`,
        message: 'authorized_for must be a string',
        severity: 'error'
      });
    } else {
      // Validate length constraints
      if (agent.authorized_for.length < 1) {
        result.errors.push({
          field: `${prefix}.authorized_for`,
          message: 'authorized_for cannot be empty',
          severity: 'error'
        });
      } else if (agent.authorized_for.length > 500) {
        result.errors.push({
          field: `${prefix}.authorized_for`,
          message: 'authorized_for must be 500 characters or less',
          severity: 'error'
        });
      }
    }

    // Optional property_ids must be an array
    if (agent.property_ids !== undefined && !Array.isArray(agent.property_ids)) {
      result.errors.push({
        field: `${prefix}.property_ids`,
        message: 'property_ids must be an array',
        severity: 'error'
      });
    }

    // Optional property_tags must be an array
    if (agent.property_tags !== undefined && !Array.isArray(agent.property_tags)) {
      result.errors.push({
        field: `${prefix}.property_tags`,
        message: 'property_tags must be an array',
        severity: 'error'
      });
    }

    // Optional signal_ids must be an array
    if (agent.signal_ids !== undefined && !Array.isArray(agent.signal_ids)) {
      result.errors.push({
        field: `${prefix}.signal_ids`,
        message: 'signal_ids must be an array',
        severity: 'error'
      });
    }

    // Optional signal_tags must be an array
    if (agent.signal_tags !== undefined && !Array.isArray(agent.signal_tags)) {
      result.errors.push({
        field: `${prefix}.signal_tags`,
        message: 'signal_tags must be an array',
        severity: 'error'
      });
    }

    if (agent.placement_ids !== undefined && !Array.isArray(agent.placement_ids)) {
      result.errors.push({
        field: `${prefix}.placement_ids`,
        message: 'placement_ids must be an array',
        severity: 'error'
      });
    }

    if (agent.placement_tags !== undefined && !Array.isArray(agent.placement_tags)) {
      result.errors.push({
        field: `${prefix}.placement_tags`,
        message: 'placement_tags must be an array',
        severity: 'error'
      });
    }

    if (agent.countries !== undefined) {
      if (!Array.isArray(agent.countries)) {
        result.errors.push({
          field: `${prefix}.countries`,
          message: 'countries must be an array',
          severity: 'error'
        });
      } else {
        const countryPattern = /^[A-Z]{2}$/;
        agent.countries.forEach((country: unknown, countryIndex: number) => {
          if (typeof country !== 'string' || !countryPattern.test(country)) {
            result.errors.push({
              field: `${prefix}.countries[${countryIndex}]`,
              message: 'countries entries must be ISO 3166-1 alpha-2 codes',
              severity: 'error'
            });
          }
        });
      }
    }

    if (agent.delegation_type !== undefined) {
      const validDelegationTypes = ['direct', 'delegated', 'ad_network'];
      if (!validDelegationTypes.includes(agent.delegation_type)) {
        result.errors.push({
          field: `${prefix}.delegation_type`,
          message: `delegation_type must be one of: ${validDelegationTypes.join(', ')}`,
          severity: 'error'
        });
      }
    }

    if (agent.exclusive !== undefined && typeof agent.exclusive !== 'boolean') {
      result.errors.push({
        field: `${prefix}.exclusive`,
        message: 'exclusive must be a boolean',
        severity: 'error'
      });
    }

    let effectiveFromMs: number | undefined;
    let effectiveUntilMs: number | undefined;

    if (agent.effective_from !== undefined) {
      effectiveFromMs = Date.parse(agent.effective_from);
      if (typeof agent.effective_from !== 'string' || Number.isNaN(effectiveFromMs)) {
        result.errors.push({
          field: `${prefix}.effective_from`,
          message: 'effective_from must be a valid ISO 8601 date-time string',
          severity: 'error'
        });
      }
    }

    if (agent.effective_until !== undefined) {
      effectiveUntilMs = Date.parse(agent.effective_until);
      if (typeof agent.effective_until !== 'string' || Number.isNaN(effectiveUntilMs)) {
        result.errors.push({
          field: `${prefix}.effective_until`,
          message: 'effective_until must be a valid ISO 8601 date-time string',
          severity: 'error'
        });
      }
    }

    if (
      effectiveFromMs !== undefined &&
      effectiveUntilMs !== undefined &&
      !Number.isNaN(effectiveFromMs) &&
      !Number.isNaN(effectiveUntilMs) &&
      effectiveFromMs > effectiveUntilMs
    ) {
      result.errors.push({
        field: `${prefix}.effective_until`,
        message: 'effective_until must be later than or equal to effective_from',
        severity: 'error'
      });
    }

    if (agent.signing_keys !== undefined) {
      if (!Array.isArray(agent.signing_keys)) {
        result.errors.push({
          field: `${prefix}.signing_keys`,
          message: 'signing_keys must be an array',
          severity: 'error'
        });
      } else {
        agent.signing_keys.forEach((key: unknown, keyIndex: number) => {
          if (typeof key !== 'object' || key === null) {
            result.errors.push({
              field: `${prefix}.signing_keys[${keyIndex}]`,
              message: 'signing_keys entries must be objects',
              severity: 'error'
            });
            return;
          }
          const signingKey = key as Record<string, unknown>;
          if (typeof signingKey.kid !== 'string' || signingKey.kid.length === 0) {
            result.errors.push({
              field: `${prefix}.signing_keys[${keyIndex}].kid`,
              message: 'signing key kid is required',
              severity: 'error'
            });
          }
          if (typeof signingKey.kty !== 'string' || signingKey.kty.length === 0) {
            result.errors.push({
              field: `${prefix}.signing_keys[${keyIndex}].kty`,
              message: 'signing key kty is required',
              severity: 'error'
            });
          }
        });
      }
    }

    // Validate authorization_type per v3 schema. Every authorized_agents[]
    // entry must declare an authorization_type and ship the matching
    // non-empty selector — that's the schema's oneOf invariant, and it's
    // what downstream resolvers (Python/TS SDKs) rely on to decide whether
    // an agent is actually authorized for a given property/signal. Without
    // it, publishers see valid:true while consumers see "agent not
    // authorized" — issue #4476.
    const validAuthTypes = ['property_ids', 'property_tags', 'inline_properties', 'publisher_properties', 'signal_ids', 'signal_tags'] as const;
    const selectorByType: Record<typeof validAuthTypes[number], string> = {
      property_ids: 'property_ids',
      property_tags: 'property_tags',
      inline_properties: 'properties',
      publisher_properties: 'publisher_properties',
      signal_ids: 'signal_ids',
      signal_tags: 'signal_tags',
    };

    if (!agent.authorization_type) {
      result.errors.push({
        field: `${prefix}.authorization_type`,
        message: `missing required field \`authorization_type\` (one of ${validAuthTypes.map((t) => `\`${t}\``).join(', ')})`,
        severity: 'error',
      });
    } else if (!validAuthTypes.includes(agent.authorization_type)) {
      result.errors.push({
        field: `${prefix}.authorization_type`,
        message: `authorization_type must be one of: ${validAuthTypes.join(', ')}`,
        severity: 'error',
      });
    } else {
      const selectorField = selectorByType[agent.authorization_type as typeof validAuthTypes[number]];
      const selectorValue = (agent as Record<string, unknown>)[selectorField];
      if (!Array.isArray(selectorValue) || selectorValue.length === 0) {
        result.errors.push({
          field: `${prefix}.${selectorField}`,
          message: `authorization_type is "${agent.authorization_type}" but \`${selectorField}\` is missing or empty`,
          severity: 'error',
        });
      }
    }
  }

  /**
   * Validates an individual signal definition
   */
  private validateSignal(signal: any, index: number, result: AdAgentsValidationResult): void {
    const prefix = `signals[${index}]`;

    if (typeof signal !== 'object' || signal === null) {
      result.errors.push({
        field: prefix,
        message: 'Each signal must be an object',
        severity: 'error'
      });
      return;
    }

    // Required fields: id, name, value_type
    if (!signal.id) {
      result.errors.push({
        field: `${prefix}.id`,
        message: 'Signal id is required',
        severity: 'error'
      });
    } else if (typeof signal.id !== 'string') {
      result.errors.push({
        field: `${prefix}.id`,
        message: 'Signal id must be a string',
        severity: 'error'
      });
    } else {
      // Validate id pattern
      const idPattern = /^[a-zA-Z0-9_-]+$/;
      if (!idPattern.test(signal.id)) {
        result.errors.push({
          field: `${prefix}.id`,
          message: 'Signal id must contain only alphanumeric characters, underscores, and hyphens',
          severity: 'error'
        });
      }
    }

    if (!signal.name) {
      result.errors.push({
        field: `${prefix}.name`,
        message: 'Signal name is required',
        severity: 'error'
      });
    } else if (typeof signal.name !== 'string') {
      result.errors.push({
        field: `${prefix}.name`,
        message: 'Signal name must be a string',
        severity: 'error'
      });
    }

    if (!signal.value_type) {
      result.errors.push({
        field: `${prefix}.value_type`,
        message: 'Signal value_type is required',
        severity: 'error'
      });
    } else {
      const validValueTypes = ['binary', 'categorical', 'numeric'];
      if (!validValueTypes.includes(signal.value_type)) {
        result.errors.push({
          field: `${prefix}.value_type`,
          message: `Signal value_type must be one of: ${validValueTypes.join(', ')}`,
          severity: 'error'
        });
      }

      // Validate type-specific fields
      if (signal.value_type === 'categorical') {
        if (signal.allowed_values !== undefined) {
          if (!Array.isArray(signal.allowed_values)) {
            result.errors.push({
              field: `${prefix}.allowed_values`,
              message: 'allowed_values must be an array',
              severity: 'error'
            });
          } else if (signal.allowed_values.length === 0) {
            result.warnings.push({
              field: `${prefix}.allowed_values`,
              message: 'Categorical signal has empty allowed_values array',
              suggestion: 'Add the valid values for this categorical signal'
            });
          }
        } else {
          result.warnings.push({
            field: `${prefix}.allowed_values`,
            message: 'Categorical signal should define allowed_values',
            suggestion: 'Add allowed_values array with valid values'
          });
        }
      }

      if (signal.value_type === 'numeric') {
        if (signal.range !== undefined) {
          if (typeof signal.range !== 'object' || signal.range === null) {
            result.errors.push({
              field: `${prefix}.range`,
              message: 'range must be an object with min and max',
              severity: 'error'
            });
          } else {
            if (typeof signal.range.min !== 'number') {
              result.errors.push({
                field: `${prefix}.range.min`,
                message: 'range.min must be a number',
                severity: 'error'
              });
            }
            if (typeof signal.range.max !== 'number') {
              result.errors.push({
                field: `${prefix}.range.max`,
                message: 'range.max must be a number',
                severity: 'error'
              });
            }
            if (typeof signal.range.min === 'number' && typeof signal.range.max === 'number') {
              if (signal.range.min > signal.range.max) {
                result.errors.push({
                  field: `${prefix}.range`,
                  message: 'range.min cannot be greater than range.max',
                  severity: 'error'
                });
              }
            }
          }
        }
      }
    }

    // Optional category validation - warn about non-standard categories
    if (signal.category !== undefined) {
      if (typeof signal.category !== 'string') {
        result.errors.push({
          field: `${prefix}.category`,
          message: 'Signal category must be a string',
          severity: 'error'
        });
      } else if (!VALID_SIGNAL_CATEGORIES.includes(signal.category as SignalCategory)) {
        result.warnings.push({
          field: `${prefix}.category`,
          message: `Signal category "${signal.category}" is not a standard category`,
          suggestion: `Consider using one of: ${VALID_SIGNAL_CATEGORIES.join(', ')}`
        });
      }
    }

    // Optional tags validation
    if (signal.tags !== undefined) {
      if (!Array.isArray(signal.tags)) {
        result.errors.push({
          field: `${prefix}.tags`,
          message: 'Signal tags must be an array',
          severity: 'error'
        });
      } else {
        signal.tags.forEach((tag: any, tagIndex: number) => {
          if (typeof tag !== 'string') {
            result.errors.push({
              field: `${prefix}.tags[${tagIndex}]`,
              message: 'Each tag must be a string',
              severity: 'error'
            });
          } else {
            const tagPattern = /^[a-z0-9_-]+$/;
            if (!tagPattern.test(tag)) {
              result.errors.push({
                field: `${prefix}.tags[${tagIndex}]`,
                message: 'Tags must contain only lowercase alphanumeric characters, underscores, and hyphens',
                severity: 'error'
              });
            }
          }
        });
      }
    }
  }

  /**
   * Validates business logic and content
   */
  private validateContent(data: any, result: AdAgentsValidationResult): void {
    if (!data.authorized_agents || !Array.isArray(data.authorized_agents)) {
      return; // Structure validation should have caught this
    }

    // Check for duplicate agent URLs
    const seenUrls = new Set<string>();
    data.authorized_agents.forEach((agent: any, index: number) => {
      if (agent.url && typeof agent.url === 'string') {
        if (seenUrls.has(agent.url)) {
          result.warnings.push({
            field: `authorized_agents[${index}].url`,
            message: 'Duplicate agent URL found',
            suggestion: 'Remove duplicate entries or consolidate authorization scopes'
          });
        }
        seenUrls.add(agent.url);
      }
    });

    // Check if no agents are defined
    if (data.authorized_agents.length === 0) {
      result.warnings.push({
        field: 'authorized_agents',
        message: 'No authorized agents defined',
        suggestion: 'Add at least one authorized agent'
      });
    }

    // Validate signals content if present
    if (data.signals && Array.isArray(data.signals)) {
      // Check for duplicate signal IDs
      const seenSignalIds = new Set<string>();
      data.signals.forEach((signal: any, index: number) => {
        if (signal.id && typeof signal.id === 'string') {
          if (seenSignalIds.has(signal.id)) {
            result.warnings.push({
              field: `signals[${index}].id`,
              message: `Duplicate signal ID: ${signal.id}`,
              suggestion: 'Remove duplicate signal or use unique IDs'
            });
          }
          seenSignalIds.add(signal.id);
        }
      });

      // Build set of defined signal tags from signals
      const definedSignalTags = new Set<string>();
      data.signals.forEach((signal: any) => {
        if (signal.tags && Array.isArray(signal.tags)) {
          signal.tags.forEach((tag: string) => definedSignalTags.add(tag));
        }
      });

      // Build set of signal_tags definitions
      const signalTagDefinitions = new Set<string>(
        data.signal_tags ? Object.keys(data.signal_tags) : []
      );

      // Warn about tags used in signals but not defined in signal_tags
      definedSignalTags.forEach((tag) => {
        if (!signalTagDefinitions.has(tag)) {
          result.warnings.push({
            field: 'signal_tags',
            message: `Signal tag "${tag}" is used in signals but not defined in signal_tags`,
            suggestion: `Add "${tag}" to signal_tags with a name and description`
          });
        }
      });

      // Validate authorized_agents signal references
      data.authorized_agents.forEach((agent: any, index: number) => {
        // Check signal_ids references
        if (agent.signal_ids && Array.isArray(agent.signal_ids)) {
          agent.signal_ids.forEach((signalId: string) => {
            if (!seenSignalIds.has(signalId)) {
              result.warnings.push({
                field: `authorized_agents[${index}].signal_ids`,
                message: `Signal ID "${signalId}" not found in signals catalog`,
                suggestion: 'Ensure signal_ids reference signals defined in the signals array'
              });
            }
          });
        }

        // Check signal_tags references
        if (agent.signal_tags && Array.isArray(agent.signal_tags)) {
          agent.signal_tags.forEach((tag: string) => {
            if (!definedSignalTags.has(tag) && !signalTagDefinitions.has(tag)) {
              result.warnings.push({
                field: `authorized_agents[${index}].signal_tags`,
                message: `Signal tag "${tag}" not found in any signal or signal_tags`,
                suggestion: 'Ensure signal_tags reference tags used in signals'
              });
            }
          });
        }
      });
    }

    const placementTagDefinitions = new Set<string>(
      data.placement_tags ? Object.keys(data.placement_tags) : []
    );
    const definedPlacementTags = new Set<string>();

    if (data.placements && Array.isArray(data.placements)) {
      data.placements.forEach((placement: any, index: number) => {
        if (placement.tags && Array.isArray(placement.tags)) {
          placement.tags.forEach((tag: string) => definedPlacementTags.add(tag));
        }

        if (placement.property_ids && Array.isArray(placement.property_ids) && data.properties && Array.isArray(data.properties)) {
          const definedPropertyIds = new Set(
            data.properties
              .map((property: any) => property.property_id)
              .filter((propertyId: unknown) => typeof propertyId === 'string')
          );

          placement.property_ids.forEach((propertyId: string) => {
            if (!definedPropertyIds.has(propertyId)) {
              result.warnings.push({
                field: `placements[${index}].property_ids`,
                message: `Placement property_id "${propertyId}" not found in properties`,
                suggestion: 'Ensure placement property_ids reference properties defined in the top-level properties array'
              });
            }
          });
        }
      });

      definedPlacementTags.forEach((tag) => {
        if (!placementTagDefinitions.has(tag)) {
          result.warnings.push({
            field: 'placement_tags',
            message: `Placement tag "${tag}" is used in placements but not defined in placement_tags`,
            suggestion: `Add "${tag}" to placement_tags with a name and description`
          });
        }
      });
    }

    data.authorized_agents.forEach((agent: any, index: number) => {
      if (agent.placement_tags && Array.isArray(agent.placement_tags)) {
        agent.placement_tags.forEach((tag: string) => {
          if (!definedPlacementTags.has(tag) && !placementTagDefinitions.has(tag)) {
            result.warnings.push({
              field: `authorized_agents[${index}].placement_tags`,
              message: `Placement tag "${tag}" not found in any placement or placement_tags`,
              suggestion: 'Ensure placement_tags reference tags used in the placements array'
            });
          }
        });
      }
    });
  }

  /**
   * Validates agent cards for all agents in adagents.json
   */
  async validateAgentCards(agents: AuthorizedAgent[]): Promise<AgentCardValidationResult[]> {
    const results: AgentCardValidationResult[] = [];
    
    // Validate each agent in parallel
    const validationPromises = agents.map(agent => this.validateSingleAgentCard(agent.url));
    const validationResults = await Promise.allSettled(validationPromises);
    
    validationResults.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        results.push(result.value);
      } else {
        results.push({
          agent_url: agents[index].url,
          valid: false,
          errors: [`Validation failed: ${result.reason}`]
        });
      }
    });

    return results;
  }

  /**
   * Validates a single agent's card endpoint (supports both A2A and MCP protocols)
   */
  private async validateSingleAgentCard(agentUrl: string): Promise<AgentCardValidationResult> {
    const result: AgentCardValidationResult = {
      agent_url: agentUrl,
      valid: false,
      errors: []
    };

    const startTime = Date.now();

    // Try A2A first (agent-card.json endpoints)
    const a2aResult = await this.tryA2AValidation(agentUrl, startTime);
    if (a2aResult.valid) {
      return a2aResult;
    }

    // If A2A failed, try MCP protocol
    const mcpResult = await this.tryMCPValidation(agentUrl, startTime);
    if (mcpResult.valid) {
      return mcpResult;
    }

    // Both failed - return combined errors
    result.response_time_ms = Date.now() - startTime;
    result.errors = [
      'Agent not reachable via A2A or MCP protocols',
      ...a2aResult.errors.map(e => `A2A: ${e}`),
      ...mcpResult.errors.map(e => `MCP: ${e}`)
    ];

    return result;
  }

  /**
   * Try A2A protocol validation (agent-card.json)
   */
  private async tryA2AValidation(agentUrl: string, startTime: number): Promise<AgentCardValidationResult> {
    const result: AgentCardValidationResult = {
      agent_url: agentUrl,
      valid: false,
      errors: []
    };

    // Try to fetch agent card (A2A standard and root fallback)
    const cardEndpoints = [
      `${agentUrl}/.well-known/agent-card.json`, // A2A protocol standard
      agentUrl // Sometimes the main URL returns the card
    ];

    for (const endpoint of cardEndpoints) {
      try {
        // Agent URL comes from the DB registry but agent operators
        // control DNS for their hostname; safeFetch's connect-time
        // dispatcher closes the rebind window.
        const response = await safeFetchAxiosLike(endpoint, {
          timeoutMs: 3000, // Keep short for responsive UX
          headers: {
            'Accept': 'application/json',
            'User-Agent': AAO_UA_VALIDATOR,
          },
        });

        result.response_time_ms = Date.now() - startTime;
        result.status_code = response.status;

        if (response.status === 200) {
          // Decode the buffer as UTF-8 and parse as JSON. axios used
          // to do this for us via content-type sniffing; safeFetch
          // returns raw bytes so the parse + content-type check are
          // explicit.
          const contentType = response.headers['content-type'] ?? '';
          const isJsonContentType = contentType.includes('application/json');
          let parsed: unknown = null;
          try {
            parsed = JSON.parse(Buffer.from(response.data).toString('utf-8'));
          } catch {
            // parsed stays null; falls through to the "not JSON" branch
          }
          result.card_data = parsed;
          result.card_endpoint = endpoint;

          // Basic validation of card structure
          if (typeof parsed === 'object' && parsed !== null) {
            if (!isJsonContentType) {
              result.errors.push(`Endpoint returned JSON data but with content-type: ${contentType}. Should be application/json`);
              result.valid = false;
            } else {
              result.valid = true;
            }
          } else {
            if (contentType.includes('text/html')) {
              result.errors.push('Agent card endpoint returned HTML instead of JSON. This appears to be a website, not an agent card endpoint.');
            } else {
              result.errors.push(`Agent card is not a valid JSON object (content-type: ${contentType})`);
            }
          }
          return result;
        }
      } catch (endpointError) {
        // Try next endpoint
        continue;
      }
    }

    result.errors.push('No agent card found at /.well-known/agent-card.json or root URL');
    return result;
  }

  /**
   * Try MCP protocol validation (streamable HTTP)
   */
  private async tryMCPValidation(agentUrl: string, startTime: number): Promise<AgentCardValidationResult> {
    const result: AgentCardValidationResult = {
      agent_url: agentUrl,
      valid: false,
      errors: []
    };

    const MCP_TIMEOUT_MS = 5000; // Match timeout used in health.ts

    // First, do a preflight HTTP check to detect 401 errors
    // The @adcp/sdk library wraps 401s in generic errors, so we need to detect them directly
    try {
      // safeFetch with method=POST + body — same SSRF defenses as the
      // GET path, plus method/body rewriting on redirect (POST→GET on
      // 301/302/303 with body dropped, preserved on 307/308).
      const preflightResponse = await safeFetchAxiosLike(agentUrl, {
        method: 'POST',
        timeoutMs: 3000,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'initialize', params: {}, id: 1 }),
      });

      if (preflightResponse.status === 401) {
        result.response_time_ms = Date.now() - startTime;
        result.oauth_required = true;
        result.valid = true; // Agent is reachable, just needs auth
        result.status_code = 401;
        result.card_endpoint = agentUrl;
        result.card_data = {
          protocol: 'mcp',
          requires_auth: true,
        };
        return result;
      }
    } catch (preflightError) {
      // Preflight failed (network error, DNS issue, etc.) - continue to try full MCP connection
      // This is expected for agents that don't respond to raw HTTP POST
    }

    try {
      const { AdCPClient } = await import('@adcp/sdk');
      const multiClient = new AdCPClient([{
        id: 'health-check',
        name: 'Health Checker',
        agent_uri: agentUrl,
        protocol: 'mcp',
      }]);
      const client = multiClient.agent('health-check');

      // Add timeout to prevent hanging on slow/unresponsive agents
      const agentInfo = await Promise.race([
        client.getAgentInfo(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('MCP connection timed out')), MCP_TIMEOUT_MS)
        ),
      ]);

      result.response_time_ms = Date.now() - startTime;
      result.valid = true;
      result.card_endpoint = agentUrl;
      result.card_data = {
        name: agentInfo.name,
        protocol: 'mcp',
        tools: agentInfo.tools?.map(t => t.name) || [],
        tools_count: agentInfo.tools?.length || 0,
      };
    } catch (error) {
      result.response_time_ms = Date.now() - startTime;

      // Check if this is an OAuth/authentication error - agent is reachable but requires auth
      // Note: We use is401Error() rather than instanceof check because dynamic imports
      // create separate module instances, making instanceof unreliable
      const { is401Error } = await import('@adcp/sdk');
      if (is401Error(error)) {
        result.oauth_required = true;
        result.valid = true; // Agent is reachable, just needs auth
        result.card_endpoint = agentUrl;
        result.card_data = {
          protocol: 'mcp',
          requires_auth: true,
        };
        return result;
      }

      const message = error instanceof Error ? error.message : 'Unknown error';
      result.errors.push(`MCP connection failed: ${message}`);
    }

    return result;
  }

  /**
   * Creates a properly formatted adagents.json file
   * @param optionsOrAgents - Options object or array of agents (for backward compatibility)
   * @param includeSchema - (deprecated) Use options.includeSchema instead
   * @param includeTimestamp - (deprecated) Use options.includeTimestamp instead
   * @param properties - (deprecated) Use options.properties instead
   * @param signals - (deprecated) Use options.signals instead
   * @param signalTags - (deprecated) Use options.signalTags instead
   */
  createAdAgentsJson(options: CreateAdAgentsJsonOptions): string;
  createAdAgentsJson(
    agents: AuthorizedAgent[],
    includeSchema?: boolean,
    includeTimestamp?: boolean,
    properties?: PropertyDefinition[],
    signals?: SignalDefinition[],
    signalTags?: Record<string, { name: string; description: string }>
  ): string;
  createAdAgentsJson(
    optionsOrAgents: CreateAdAgentsJsonOptions | AuthorizedAgent[],
    includeSchema: boolean = true,
    includeTimestamp: boolean = true,
    properties?: PropertyDefinition[],
    signals?: SignalDefinition[],
    signalTags?: Record<string, { name: string; description: string }>
  ): string {
    // Normalize to options object
    const opts: CreateAdAgentsJsonOptions = Array.isArray(optionsOrAgents)
      ? { agents: optionsOrAgents, includeSchema, includeTimestamp, properties, signals, signalTags }
      : optionsOrAgents;

    const adagents: AdAgentsJson = {
      authorized_agents: opts.agents
    };

    if (opts.properties && opts.properties.length > 0) {
      adagents.properties = opts.properties;
    }

    if (opts.signals && opts.signals.length > 0) {
      adagents.signals = opts.signals;
    }

    if (opts.signalTags && Object.keys(opts.signalTags).length > 0) {
      adagents.signal_tags = opts.signalTags;
    }

    if (opts.includeSchema !== false) {
      adagents.$schema = 'https://adcontextprotocol.org/schemas/v3/adagents.json';
    }

    if (opts.includeTimestamp !== false) {
      adagents.last_updated = new Date().toISOString();
    }

    return JSON.stringify(adagents, null, 2);
  }

  /**
   * Validates a proposed adagents.json structure before creation
   */
  validateProposed(agents: AuthorizedAgent[]): AdAgentsValidationResult {
    const mockData = {
      $schema: 'https://adcontextprotocol.org/schemas/v3/adagents.json',
      authorized_agents: agents,
      last_updated: new Date().toISOString()
    };

    const result: AdAgentsValidationResult = {
      valid: false,
      errors: [],
      warnings: [],
      domain: 'proposed',
      url: 'proposed',
      discovery_method: 'direct',
    };

    this.validateStructure(mockData, result);
    this.validateContent(mockData, result);

    result.valid = result.errors.length === 0;
    return result;
  }
}
