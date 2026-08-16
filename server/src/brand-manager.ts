import { getDomain } from 'tldts';
import { Cache } from './cache.js';
import { safeFetchAxiosLike, classifySafeFetchError } from './utils/url-security.js';
import { validateBrandJsonSchema } from './services/brand-json-schema-validator.js';
import type {
  LocalizedName,
  BrandProperty,
  BrandDefinition,
  HouseDefinition,
  BrandAgentConfig,
  ResolvedBrand,
  KellerType,
} from './types';
import { AAO_UA_VALIDATOR } from './config/user-agents.js';
import { withSdkSafeTransport } from './utils/sdk-safe-fetch.js';
import { assertValidBrandDomain } from './services/identifier-normalization.js';
import {
  observeBrandRelationshipDeclaration,
  type BrandRelationshipDeclaration,
} from './db/brand-relationship-db.js';

export interface BrandValidationError {
  field: string;
  message: string;
  severity: 'error';
}

export interface BrandValidationWarning {
  field: string;
  message: string;
  suggestion?: string;
}

export interface BrandValidationResult {
  valid: boolean;
  errors: BrandValidationError[];
  warnings: BrandValidationWarning[];
  domain: string;
  url: string;
  status_code?: number;
  raw_data?: unknown;
  variant?: BrandJsonVariant;
  promoted_from_schema?: string;
}

type BrandJsonVariant =
  | 'authoritative_location'
  | 'house_redirect'
  | 'brand_agent'
  | 'house_portfolio'
  | 'brand_canonical';

// brand.json variant types
export interface AuthoritativeLocationVariant {
  $schema?: string;
  authoritative_location: string;
  last_updated?: string;
}

export interface HouseRedirectVariant {
  $schema?: string;
  house: string;  // Domain string
  region?: string;
  note?: string;
  last_updated?: string;
}

export interface BrandAgentVariant {
  $schema?: string;
  version?: string;
  brand_agent?: BrandAgentConfig;
  agents?: Array<BrandAgentConfig & { type: string }>;
  auth?: {
    required?: boolean;
    method?: 'api_key' | 'oauth2' | 'bearer_token';
    token_endpoint?: string;
    scopes?: string[];
    instructions_url?: string;
  };
  contact?: {
    name: string;
    email?: string;
    domain?: string;
  };
  last_updated?: string;
}

export interface HousePortfolioVariant {
  $schema?: string;
  version?: string;
  house: HouseDefinition;  // Object
  brands?: BrandDefinition[];
  brand_refs?: Array<{
    domain: string;
    brand_id: string;
    managed_by?: string;
    effective_at?: string;
  }>;
  contact?: {
    name: string;
    email?: string;
    domain?: string;
  };
  trademarks?: Array<{
    registry: string;
    number: string;
    mark: string;
  }>;
  last_updated?: string;
}

export type BrandCanonicalDocument = BrandDefinition & {
  $schema?: string;
  version?: string;
  house_domain?: string;
  last_updated?: string;
};

export type BrandJson =
  | AuthoritativeLocationVariant
  | HouseRedirectVariant
  | BrandAgentVariant
  | HousePortfolioVariant
  | BrandCanonicalDocument;

const LEGACY_BRAND_SCHEMA = 'https://schemas.adcontextprotocol.org/brand/v1/brand.json';
const CURRENT_BRAND_SCHEMA = 'https://adcontextprotocol.org/schemas/v3/brand.json';
const BRAND_JSON_MAX_RESPONSE_BYTES = 256 * 1024;
const BRAND_CACHE_MAX_ENTRIES = 200;
const BRAND_FAILED_CACHE_MAX_ENTRIES = 1000;
/**
 * How long a confirmed mutual-assertion edge may be reused while the house
 * side is transiently unreachable, measured from the last successful
 * reciprocal check — not from the last resolution. Past this the edge reports
 * `unverifiable`, per the brand.json edge-aging rule.
 */
const MUTUAL_TRUST_RETENTION_MS = 24 * 60 * 60 * 1000;
/**
 * Maximum age of the house's ownership declaration, independent of how
 * recently both sides were re-validated. This implements the 180-day ceiling
 * documented for the AgenticAdvertising.org reference resolver.
 */
const MUTUAL_DECLARATION_MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000;

type RelationshipDeclarationObserver = (
  declaration: BrandRelationshipDeclaration,
) => Promise<number>;

type CanonicalHouseVerification =
  | {
      status: 'mutual';
      houseDomain: string;
      houseName?: string;
      verifiedAt: number;
      declaredAt: number;
    }
  | { status: 'leaf_only'; declaredAt?: number }
  | { status: 'unverifiable'; transient: boolean };

interface CanonicalResolution {
  result: ResolvedBrand;
  retainCachedMutual: boolean;
}

/**
 * A resolution plus the terminal network attempt that produced it. Diagnostics
 * are per-call so concurrent resolutions never read each other's state.
 */
export interface BrandResolution {
  brand: ResolvedBrand | null;
  /** Terminal validation attempt for this call, without the response body. */
  last_attempt?: BrandValidationResult;
}

interface ResolutionDiagnostics {
  last_attempt?: BrandValidationResult;
}

export interface BrandAgentValidationResult {
  agent_url: string;
  valid: boolean;
  errors: string[];
  status_code?: number;
  response_time_ms?: number;
  agent_data?: unknown;
}

export class BrandManager {
  // Cache for successful brand.json lookups (24 hours)
  private validationCache: Cache<BrandValidationResult>;
  // Cache for resolved brands (24 hours)
  private resolutionCache: Cache<ResolvedBrand | null>;
  // Cache for failed lookups (1 hour)
  private failedLookupCache: Cache<BrandValidationResult>;
  private observeRelationshipDeclaration: RelationshipDeclarationObserver;

  constructor(options: {
    observeRelationshipDeclaration?: RelationshipDeclarationObserver;
  } = {}) {
    this.validationCache = new Cache<BrandValidationResult>(24 * 60, BRAND_CACHE_MAX_ENTRIES); // 24 hours
    this.resolutionCache = new Cache<ResolvedBrand | null>(24 * 60, BRAND_CACHE_MAX_ENTRIES); // 24 hours
    this.failedLookupCache = new Cache<BrandValidationResult>(60, BRAND_FAILED_CACHE_MAX_ENTRIES); // 1 hour
    this.observeRelationshipDeclaration = options.observeRelationshipDeclaration
      ?? observeBrandRelationshipDeclaration;
  }

  /**
   * Clear all caches
   */
  clearCache(): void {
    this.validationCache.clear();
    this.resolutionCache.clear();
    this.failedLookupCache.clear();
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): { validation: number; resolution: number; failed: number } {
    return {
      validation: this.validationCache.size(),
      resolution: this.resolutionCache.size(),
      failed: this.failedLookupCache.size(),
    };
  }

  /**
   * Record the attempt that a caller may report as the reason a resolution
   * fell back. Bodies are dropped and lists capped so the diagnostic stays
   * small enough to return over the wire.
   */
  private recordAttempt(
    diagnostics: ResolutionDiagnostics,
    result: BrandValidationResult
  ): void {
    const { raw_data: _rawData, ...withoutRawData } = result;
    diagnostics.last_attempt = {
      ...withoutRawData,
      errors: result.errors.slice(0, 20),
      warnings: result.warnings.slice(0, 20),
    };
  }

  /**
   * Agents call the MCP tools with whatever identifier a human gave them, so a
   * bare `https://` prefix or trailing slash is stripped before validating.
   * Everything else — ports, paths, queries — is still rejected outright
   * rather than guessed at.
   */
  private normalizeLookupDomain(domain: string): string | null {
    const normalized = domain
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/\/$/, '');
    try {
      assertValidBrandDomain(normalized);
      return normalized;
    } catch {
      return null;
    }
  }

  /**
   * Promote the narrowly identified pre-v3 shape used by early integrations.
   *
   * The legacy schema URL was never part of the canonical AdCP schema tree, so
   * this adapter intentionally does not guess at trust semantics. Only the
   * exact TLS-origin identity property is active; every other legacy property
   * is preserved opaquely instead of being rewritten as a v3 trust claim.
   */
  private normalizeLegacyBrandJson(
    data: unknown,
    originDomain: string
  ): { data: unknown; warnings: BrandValidationWarning[]; promotedFromSchema?: string } {
    if (!this.isRecord(data) || data.$schema !== LEGACY_BRAND_SCHEMA) {
      return { data, warnings: [] };
    }

    const document = structuredClone(data) as Record<string, unknown>;
    const warnings: BrandValidationWarning[] = [{
      field: '$schema',
      message: `Promoted legacy brand.json shape to ${CURRENT_BRAND_SCHEMA}`,
      suggestion: `Publish the document directly against ${CURRENT_BRAND_SCHEMA}`,
    }];
    const brands = Array.isArray(document.brands)
      ? document.brands.filter((brand): brand is Record<string, unknown> => this.isRecord(brand))
      : [];

    // Compatibility promotion is identity-only. Require exactly one website
    // match to the TLS origin; never infer identity from array position.
    // `relationship` defaults to `owned` and predates these documents, so an
    // absent value counts — otherwise promotion never fires for the shape it
    // exists to carry.
    const originMatches: Array<{ brand: Record<string, unknown>; brandIndex: number; propertyIndex: number }> = [];
    for (const [brandIndex, brand] of brands.entries()) {
      if (!Array.isArray(brand.properties)) continue;
      for (const [propertyIndex, property] of brand.properties.entries()) {
        if (
          this.isRecord(property) &&
          property.type === 'website' &&
          typeof property.identifier === 'string' &&
          property.identifier.toLowerCase() === originDomain &&
          this.isOwnedProperty(property as BrandProperty)
        ) {
          originMatches.push({ brand, brandIndex, propertyIndex });
        }
      }
    }

    // The early exits below return the document untouched. They keep the
    // warnings that explain why, but must not report a promotion that did not
    // happen — `promoted_from_schema` describes the document in the response.
    if (originMatches.length !== 1) {
      warnings.push({
        field: 'brands',
        message: `Legacy promotion requires exactly one owned website property matching ${originDomain}; found ${originMatches.length}`,
      });
      return { data, warnings };
    }

    const originMatch = originMatches[0];
    const originBrand = structuredClone(originMatch.brand);
    const originIndex = originMatch.brandIndex;
    const legacyProperties: unknown[] = [];
    const activeProperties: unknown[] = [];
    for (const [propertyIndex, property] of (
      Array.isArray(originBrand.properties) ? originBrand.properties : []
    ).entries()) {
      if (propertyIndex !== originMatch.propertyIndex) {
        legacyProperties.push(property);
        warnings.push({
          field: `brands[${originIndex}].properties[${propertyIndex}]`,
          message: 'Preserved a non-origin legacy property as opaque data; compatibility promotion does not turn it into a v3 trust assertion',
          suggestion: `Publish the property explicitly in a ${CURRENT_BRAND_SCHEMA} document`,
        });
      } else {
        activeProperties.push(property);
      }
    }
    originBrand.properties = activeProperties;
    if (legacyProperties.length > 0) originBrand.legacy_properties = legacyProperties;

    if (typeof originBrand.name === 'string' && originBrand.name.trim()) {
      originBrand.names = [{ und: originBrand.name }];
      delete originBrand.name;
      warnings.push({
        field: `brands[${originIndex}].name`,
        message: 'Promoted legacy name to names[] using the undetermined-language tag "und"',
      });
    }
    if (!Array.isArray(originBrand.names) || originBrand.names.length === 0) {
      warnings.push({ field: `brands[${originIndex}].names`, message: 'Legacy origin brand has no promotable name' });
      return { data, warnings };
    }

    const topName = typeof document.name === 'string' ? document.name.trim() : '';
    if (
      topName &&
      !(originBrand.names as unknown[]).some((entry) =>
        this.isRecord(entry) && Object.values(entry).includes(topName)
      )
    ) {
      (originBrand.names as unknown[]).push({ und: topName });
    }
    if (typeof document.description === 'string' && originBrand.description === undefined) {
      originBrand.description = document.description;
    }
    if (typeof document.logo === 'string') {
      const logos = Array.isArray(originBrand.logos) ? originBrand.logos : [];
      if (!logos.some((logo) => this.isRecord(logo) && logo.url === document.logo)) {
        logos.push({ url: document.logo });
      }
      originBrand.logos = logos;
    }
    if (this.isRecord(document.colors) && !this.isRecord(originBrand.colors)) {
      originBrand.colors = document.colors;
    }

    const metadata: Record<string, unknown> = {};
    for (const key of ['legal_operator', 'related_domains', 'operator_domain_evidence'] as const) {
      if (!(key in document)) continue;
      metadata[key] = document[key];
      warnings.push({
        field: key,
        message: `Preserved legacy ${key} as opaque metadata; it is not treated as v3 trust evidence`,
      });
    }
    const otherBrands = brands.filter((brand) => brand !== originMatch.brand);
    if (otherBrands.length > 0) {
      metadata.unpromoted_brands = otherBrands;
      warnings.push({
        field: 'brands',
        message: `Preserved ${otherBrands.length} non-origin legacy brand entries as opaque metadata; no ownership relationship was promoted`,
      });
    }

    const house = this.isRecord(document.house) ? document.house : undefined;
    if (house) {
      metadata.legacy_house = house;
      warnings.push({
        field: 'house',
        message: 'Preserved legacy house object as opaque metadata; it is not treated as a v3 portfolio claim.',
        suggestion: 'Set house_domain on this Brand Canonical Document pointing at the parent domain. The parent must declare this domain in brand_refs[] for mutual-assertion trust.',
      });
    }

    const canonical: Record<string, unknown> = {
      ...originBrand,
      $schema: CURRENT_BRAND_SCHEMA,
      ...(Object.keys(metadata).length > 0 ? { legacy_metadata: metadata } : {}),
    };
    warnings.push({
      field: 'root',
      message: 'Promoted only the TLS-origin brand identity to a v3 Brand Canonical Document',
    });
    return { data: canonical, warnings, promotedFromSchema: LEGACY_BRAND_SCHEMA };
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  /**
   * Validates a domain's brand.json file
   */
  async validateDomain(domain: string, options?: { skipCache?: boolean }): Promise<BrandValidationResult> {
    const normalizedDomain = this.normalizeLookupDomain(domain);
    if (!normalizedDomain) {
      const invalidResult: BrandValidationResult = {
        valid: false,
        errors: [{
          field: 'domain',
          message: 'Domain must be a bare multi-label DNS hostname without a scheme, port, path, query, or fragment',
          severity: 'error',
        }],
        warnings: [],
        domain: domain.trim().toLowerCase(),
        url: '',
      };
      return invalidResult;
    }
    const cacheKey = normalizedDomain;

    // Check caches unless explicitly skipped
    if (!options?.skipCache) {
      // Check successful validation cache first
      const cachedValid = this.validationCache.get(cacheKey);
      if (cachedValid) {
        return cachedValid;
      }

      // Check failed lookup cache
      const cachedFailed = this.failedLookupCache.get(cacheKey);
      if (cachedFailed) {
        return cachedFailed;
      }
    }

    const url = `https://${normalizedDomain}/.well-known/brand.json`;

    const result: BrandValidationResult = {
      valid: false,
      errors: [],
      warnings: [],
      domain: normalizedDomain,
      url,
    };

    try {
      // safeFetch: SSRF-defended fetch (private-IP / DNS-rebind / per-hop
      // redirect validation). Replaces a previously `lgtm`-suppressed
      // axios.get that became unauthenticated-reachable via the
      // /api/registry/publisher auto-crawl path (PR #4128 / issue #4129).
      const response = await safeFetchAxiosLike(url, {
        timeoutMs: 10000,
        maxResponseBytes: BRAND_JSON_MAX_RESPONSE_BYTES,
        sameSiteRedirectsOnly: true,
        headers: {
          Accept: 'application/json',
          'User-Agent': AAO_UA_VALIDATOR,
        },
      });

      result.status_code = response.status;

      if (response.status !== 200) {
        const statusMessage =
          response.status === 404
            ? `File not found at ${url}`
            : `HTTP ${response.status} error fetching ${url}`;
        result.errors.push({
          field: 'http_status',
          message: statusMessage,
          severity: 'error',
        });
        // Cache failed lookups for 1 hour
        this.failedLookupCache.set(cacheKey, result);
        return result;
      }

      let brandData: unknown;
      try {
        const text = response.data.toString('utf-8');
        brandData = JSON.parse(text);
      } catch {
        result.errors.push({
          field: 'json',
          message: `Invalid JSON response from ${url}`,
          severity: 'error',
        });
        this.failedLookupCache.set(cacheKey, result);
        return result;
      }

      await this.validateBrandData(brandData, normalizedDomain, result);
    } catch (error) {
      const classified = classifySafeFetchError(error, normalizedDomain);
      result.errors.push({ ...classified, severity: 'error' });
    }

    // Cache the result
    if (result.valid) {
      // Cache successful lookups for 24 hours
      this.validationCache.set(cacheKey, result);
    } else {
      // Cache failed lookups for 1 hour
      this.failedLookupCache.set(cacheKey, result);
    }

    return result;
  }

  /**
   * @param fetchedFrom URL the document was actually served from, when that is
   *   not the attributed domain's own well-known path.
   */
  private async validateBrandData(
    brandData: unknown,
    attributedDomain: string,
    result: BrandValidationResult,
    fetchedFrom?: string
  ): Promise<void> {
    const normalized = this.normalizeLegacyBrandJson(brandData, attributedDomain);
    brandData = normalized.data;
    result.warnings.push(...normalized.warnings);
    result.promoted_from_schema = normalized.promotedFromSchema;
    const schemaValidation = validateBrandJsonSchema(brandData);
    if (!schemaValidation.valid) {
      for (const issue of schemaValidation.errors.slice(0, 20)) {
        result.errors.push({
          field: issue.instancePath || 'root',
          message: issue.message ?? 'Invalid brand.json field',
          severity: 'error',
        });
      }
    }

    const variant = this.detectVariant(brandData);
    result.variant = variant || undefined;
    if (schemaValidation.valid && variant === 'house_portfolio') {
      const houseDomain = (brandData as HousePortfolioVariant).house.domain.toLowerCase();
      if (houseDomain !== attributedDomain.toLowerCase()) {
        result.errors.push({
          field: 'house.domain',
          message: 'House Portfolio house.domain must match the TLS-attributed domain',
          severity: 'error',
        });
      }
    }
    if (schemaValidation.valid) switch (variant) {
      case 'authoritative_location':
        await this.validateAuthoritativeLocationVariant(brandData as AuthoritativeLocationVariant, result);
        break;
      case 'house_redirect':
        this.validateHouseRedirectVariant(brandData as HouseRedirectVariant, result);
        break;
      case 'brand_agent':
        this.validateBrandAgentVariant(brandData as BrandAgentVariant, result);
        break;
      case 'house_portfolio':
        this.validateHousePortfolioVariant(brandData as HousePortfolioVariant, result);
        break;
      case 'brand_canonical':
        this.validateCanonicalDocument(brandData as BrandCanonicalDocument, result);
        this.validateCanonicalDocumentAttribution(
          brandData as BrandCanonicalDocument,
          attributedDomain,
          result,
          fetchedFrom
        );
        break;
      default:
        result.errors.push({
          field: 'root',
          message: 'Unable to determine brand.json variant. Expected a redirect, brand agent, house portfolio, or canonical brand document',
          severity: 'error',
        });
    }
    result.valid = result.errors.length === 0;
    if (result.valid) result.raw_data = brandData;
    else delete result.raw_data;
  }

  private async validateBrandJsonUrl(
    url: string,
    attributedDomain: string
  ): Promise<BrandValidationResult> {
    const result: BrandValidationResult = {
      valid: false,
      errors: [],
      warnings: [],
      domain: attributedDomain,
      url,
    };
    try {
      const response = await safeFetchAxiosLike(url, {
        timeoutMs: 10000,
        maxResponseBytes: BRAND_JSON_MAX_RESPONSE_BYTES,
        sameSiteRedirectsOnly: true,
        headers: { Accept: 'application/json', 'User-Agent': AAO_UA_VALIDATOR },
      });
      result.status_code = response.status;
      if (response.status !== 200) {
        result.errors.push({ field: 'http_status', message: `HTTP ${response.status} fetching authoritative_location`, severity: 'error' });
        return result;
      }
      let data: unknown;
      try {
        data = JSON.parse(response.data.toString('utf-8'));
      } catch {
        result.errors.push({ field: 'json', message: 'Invalid JSON at authoritative_location', severity: 'error' });
        return result;
      }
      await this.validateBrandData(data, attributedDomain, result, url);
    } catch (error) {
      const classified = classifySafeFetchError(error, attributedDomain);
      result.errors.push({ ...classified, severity: 'error' });
    }
    return result;
  }

  /**
   * Detect which variant of brand.json this is
   */
  private detectVariant(
    data: unknown
  ): BrandJsonVariant | null {
    if (typeof data !== 'object' || data === null) {
      return null;
    }

    const obj = data as Record<string, unknown>;

    // Check for authoritative_location redirect
    if ('authoritative_location' in obj && typeof obj.authoritative_location === 'string') {
      return 'authoritative_location';
    }

    // Check for house - could be string (redirect) or object (portfolio)
    if ('house' in obj) {
      if (typeof obj.house === 'string') {
        return 'house_redirect';
      }
      if (
        typeof obj.house === 'object' && obj.house !== null &&
        (Array.isArray(obj.brands) || Array.isArray(obj.brand_refs))
      ) {
        return 'house_portfolio';
      }
    }

    // Canonical documents may themselves declare agents, so detect their
    // top-level identity fields before the agent-only variant.
    if (typeof obj.id === 'string' && Array.isArray(obj.names)) {
      return 'brand_canonical';
    }

    if (
      ('brand_agent' in obj && typeof obj.brand_agent === 'object') ||
      Array.isArray(obj.agents)
    ) {
      return 'brand_agent';
    }

    return null;
  }

  /**
   * Validate authoritative_location variant
   */
  private async validateAuthoritativeLocationVariant(
    data: AuthoritativeLocationVariant,
    result: BrandValidationResult
  ): Promise<void> {
    if (!data.authoritative_location) {
      result.errors.push({
        field: 'authoritative_location',
        message: 'authoritative_location is required',
        severity: 'error',
      });
      return;
    }

    try {
      const url = new URL(data.authoritative_location);
      if (!url.protocol.startsWith('https:')) {
        result.errors.push({
          field: 'authoritative_location',
          message: 'authoritative_location must use HTTPS',
          severity: 'error',
        });
      }
    } catch {
      result.errors.push({
        field: 'authoritative_location',
        message: 'authoritative_location must be a valid URL',
        severity: 'error',
      });
    }
  }

  /**
   * Validate house redirect variant
   */
  private validateHouseRedirectVariant(
    data: HouseRedirectVariant,
    result: BrandValidationResult
  ): void {
    if (!data.house || typeof data.house !== 'string') {
      result.errors.push({
        field: 'house',
        message: 'house (string) is required for redirect variant',
        severity: 'error',
      });
      return;
    }

    // Validate domain format
    const domainRegex = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
    if (!domainRegex.test(data.house)) {
      result.errors.push({
        field: 'house',
        message: 'house must be a valid domain name',
        severity: 'error',
      });
    }

    // Validate optional region
    if (data.region) {
      const regionRegex = /^[A-Z]{2}$/;
      if (!regionRegex.test(data.region)) {
        result.errors.push({
          field: 'region',
          message: 'region must be an ISO 3166-1 alpha-2 country code (e.g., US, GB)',
          severity: 'error',
        });
      }
    }
  }

  /**
   * Validate brand_agent variant
   */
  private validateBrandAgentVariant(
    data: BrandAgentVariant,
    result: BrandValidationResult
  ): void {
    const agent = data.brand_agent ?? data.agents?.find((entry) => entry.type === 'brand');
    if (!agent) {
      result.errors.push({
        field: 'agents',
        message: 'A brand agent entry is required',
        severity: 'error',
      });
      return;
    }

    if (!agent.id) {
      result.errors.push({
        field: 'agents.id',
        message: 'agent id is required',
        severity: 'error',
      });
    }

    if (!agent.url) {
      result.errors.push({
        field: 'agents.url',
        message: 'agent url is required',
        severity: 'error',
      });
    } else {
      try {
        const url = new URL(agent.url);
        if (!url.protocol.startsWith('https:')) {
          result.errors.push({
            field: 'agents.url',
            message: 'agent url must use HTTPS',
            severity: 'error',
          });
        }
      } catch {
        result.errors.push({
          field: 'agents.url',
          message: 'agent url must be a valid URL',
          severity: 'error',
        });
      }
    }

    // Validate auth if present
    if (data.auth) {
      if (data.auth.method === 'oauth2' && !data.auth.token_endpoint) {
        result.warnings.push({
          field: 'auth.token_endpoint',
          message: 'token_endpoint is recommended when using oauth2 authentication',
          suggestion: 'Add token_endpoint for OAuth2 authentication flow',
        });
      }
    }
  }

  /**
   * Validate house_portfolio variant
   */
  private validateHousePortfolioVariant(
    data: HousePortfolioVariant,
    result: BrandValidationResult
  ): void {
    // Validate house object
    if (!data.house || typeof data.house !== 'object') {
      result.errors.push({
        field: 'house',
        message: 'house object is required',
        severity: 'error',
      });
      return;
    }

    if (!data.house.domain) {
      result.errors.push({
        field: 'house.domain',
        message: 'house.domain is required',
        severity: 'error',
      });
    }

    if (!data.house.name) {
      result.errors.push({
        field: 'house.name',
        message: 'house.name is required',
        severity: 'error',
      });
    }

    const brands = Array.isArray(data.brands) ? data.brands : [];
    const brandRefs = Array.isArray(data.brand_refs) ? data.brand_refs : [];

    if (brands.length === 0 && brandRefs.length === 0) {
      result.errors.push({
        field: 'brands',
        message: 'At least one of brands[] or brand_refs[] is required',
        severity: 'error',
      });
      return;
    }

    // Validate each brand
    brands.forEach((brand, index) => {
      this.validateBrand(brand, index, result);
    });

    // Check for duplicate brand IDs
    const seenIds = new Set<string>();
    brands.forEach((brand, index) => {
      if (brand.id) {
        if (seenIds.has(brand.id)) {
          result.errors.push({
            field: `brands[${index}].id`,
            message: `Duplicate brand id: ${brand.id}`,
            severity: 'error',
          });
        }
        seenIds.add(brand.id);
      }
    });

    const seenRefDomains = new Set<string>();
    brandRefs.forEach((ref, index) => {
      const domain = ref.domain.toLowerCase();
      if (seenRefDomains.has(domain)) {
        result.errors.push({
          field: `brand_refs[${index}].domain`,
          message: `Duplicate brand_refs domain: ${ref.domain}`,
          severity: 'error',
        });
      }
      if (seenIds.has(ref.brand_id)) {
        result.errors.push({
          field: `brand_refs[${index}].brand_id`,
          message: `brand_id "${ref.brand_id}" cannot appear in both brands[] and brand_refs[]`,
          severity: 'error',
        });
      }
      seenRefDomains.add(domain);
      seenIds.add(ref.brand_id);
    });

    // Validate parent_brand references
    brands.forEach((brand, index) => {
      if (brand.parent_brand && !seenIds.has(brand.parent_brand)) {
        result.warnings.push({
          field: `brands[${index}].parent_brand`,
          message: `parent_brand "${brand.parent_brand}" not found in this portfolio`,
          suggestion: 'Ensure parent brand is defined in the same portfolio, or reference an external brand',
        });
      }
    });
  }

  private validateCanonicalDocument(
    data: BrandCanonicalDocument,
    result: BrandValidationResult
  ): void {
    this.validateBrand(data, 'root', result);
  }

  /**
   * An `authoritative_location` may point off-site — central hosting by a
   * service provider is the documented use for it, and the target is still
   * "the brand's own document". A document served from another site therefore
   * has to be consistent with the domain it is answering for: if it declares
   * owned websites at all, the requested domain must be among them. A document
   * that names no websites contradicts nothing and still resolves.
   */
  private validateCanonicalDocumentAttribution(
    data: BrandCanonicalDocument,
    attributedDomain: string,
    result: BrandValidationResult,
    fetchedFrom?: string
  ): void {
    if (!fetchedFrom || this.isSameSite(fetchedFrom, attributedDomain)) return;

    const ownedWebsites = (data.properties ?? []).filter(
      (property: BrandProperty) => property.type === 'website' && this.isOwnedProperty(property)
    );
    if (ownedWebsites.length === 0) return;

    const namesDomain = ownedWebsites.some(
      (property: BrandProperty) =>
        typeof property.identifier === 'string' &&
        property.identifier.toLowerCase() === attributedDomain.toLowerCase()
    );
    if (!namesDomain) {
      result.errors.push({
        field: 'properties',
        message: `Document served from ${fetchedFrom} declares owned websites that do not include ${attributedDomain}, so it is not this domain's brand document`,
        severity: 'error',
      });
    }
  }

  /** Same registrable domain (eTLD+1), with the PSL private section as the registrant boundary. */
  private isSameSite(url: string, domain: string): boolean {
    try {
      const host = new URL(url).hostname;
      const site = getDomain(host, { allowPrivateDomains: true });
      return site !== null && site === getDomain(domain, { allowPrivateDomains: true });
    } catch {
      return false;
    }
  }

  /**
   * Validate a single brand definition
   */
  private validateBrand(
    brand: BrandDefinition,
    index: number | 'root',
    result: BrandValidationResult
  ): void {
    const prefix = index === 'root' ? 'root' : `brands[${index}]`;

    if (!brand.id) {
      result.errors.push({
        field: `${prefix}.id`,
        message: 'id is required',
        severity: 'error',
      });
    }

    if (!brand.names || !Array.isArray(brand.names) || brand.names.length === 0) {
      result.errors.push({
        field: `${prefix}.names`,
        message: 'names array with at least one entry is required',
        severity: 'error',
      });
    }

    // Validate keller_type if present
    if (brand.keller_type) {
      const validTypes: KellerType[] = ['master', 'sub_brand', 'endorsed', 'independent'];
      if (!validTypes.includes(brand.keller_type)) {
        result.errors.push({
          field: `${prefix}.keller_type`,
          message: `Invalid keller_type. Must be one of: ${validTypes.join(', ')}`,
          severity: 'error',
        });
      }
    }

    // Validate properties if present
    if (brand.properties) {
      brand.properties.forEach((prop: BrandProperty, propIndex: number) => {
        this.validateProperty(prop, `${prefix}.properties[${propIndex}]`, result);
      });
    }
  }

  /**
   * Validate a property definition
   */
  private validateProperty(
    property: BrandProperty,
    prefix: string,
    result: BrandValidationResult
  ): void {
    const validTypes = [
      'website',
      'mobile_app',
      'ctv_app',
      'desktop_app',
      'dooh',
      'podcast',
      'radio',
      'streaming_audio',
    ];

    if (!property.type || !validTypes.includes(property.type)) {
      result.errors.push({
        field: `${prefix}.type`,
        message: `Invalid property type. Must be one of: ${validTypes.join(', ')}`,
        severity: 'error',
      });
    }

    if (!property.identifier) {
      result.errors.push({
        field: `${prefix}.identifier`,
        message: 'identifier is required',
        severity: 'error',
      });
    }

    // App properties should have store
    if (property.type === 'mobile_app' && !property.store) {
      result.warnings.push({
        field: `${prefix}.store`,
        message: 'store is recommended for mobile_app properties',
        suggestion: 'Add store field (apple, google, etc.)',
      });
    }
  }

  /**
   * Resolve a domain to its canonical brand identity
   * Follows redirects and resolves through house portfolios
   */
  async resolveBrand(
    domain: string,
    options: { maxRedirects?: number; skipCache?: boolean } = {}
  ): Promise<ResolvedBrand | null> {
    return (await this.resolveBrandWithDiagnostics(domain, options)).brand;
  }

  /**
   * Resolve a domain and report the terminal validation attempt alongside the
   * result, so a caller can explain a fallback without repeating the fetch.
   */
  async resolveBrandWithDiagnostics(
    domain: string,
    options: { maxRedirects?: number; skipCache?: boolean } = {}
  ): Promise<BrandResolution> {
    const diagnostics: ResolutionDiagnostics = {};
    const brand = await this.resolveBrandInternal(domain, options, diagnostics);
    return { brand, last_attempt: diagnostics.last_attempt };
  }

  private async resolveBrandInternal(
    domain: string,
    options: { maxRedirects?: number; skipCache?: boolean },
    diagnostics: ResolutionDiagnostics
  ): Promise<ResolvedBrand | null> {
    const { maxRedirects = 3, skipCache = false } = options;
    const normalizedDomain = this.normalizeLookupDomain(domain);
    if (!normalizedDomain) return null;
    const cacheKey = `resolve:${normalizedDomain}`;
    const cachedBeforeRefresh = skipCache
      ? this.resolutionCache.get(cacheKey)
      : undefined;

    // Check resolution cache unless explicitly skipped
    if (!skipCache) {
      const cached = this.resolutionCache.get(cacheKey);
      if (cached !== undefined) {
        const aged = this.applyDeclarationAgeCeiling(cached);
        if (aged !== cached) this.resolutionCache.set(cacheKey, aged);
        return aged;
      }
    }

    let currentDomain = normalizedDomain;
    let currentUrl: string | undefined;
    let redirectCount = 0;
    // Set once a House Redirect moves resolution to another domain. From that
    // point the document we are reading belongs to the house, not to the
    // requested domain, so it may only answer for a domain it names.
    let redirectedHouseDomain: string | undefined;

    while (redirectCount <= maxRedirects) {
      const validationResult = currentUrl
        ? await this.validateBrandJsonUrl(currentUrl, currentDomain)
        : await this.validateDomain(currentDomain, { skipCache });
      this.recordAttempt(diagnostics, validationResult);

      if (!validationResult.valid || !validationResult.raw_data) {
        if (!skipCache) this.resolutionCache.set(cacheKey, null);
        return null;
      }

      const data = validationResult.raw_data as BrandJson;

      switch (validationResult.variant) {
        case 'authoritative_location': {
          const authData = data as AuthoritativeLocationVariant;
          try {
            const url = new URL(authData.authoritative_location);
            currentUrl = url.toString();
            redirectCount++;
            continue;
          } catch {
            if (!skipCache) this.resolutionCache.set(cacheKey, null);
            return null;
          }
        }

        case 'house_redirect': {
          const redirectData = data as HouseRedirectVariant;
          currentDomain = redirectData.house.toLowerCase();
          redirectedHouseDomain = currentDomain === normalizedDomain
            ? undefined
            : currentDomain;
          currentUrl = undefined;
          redirectCount++;
          continue;
        }

        case 'brand_agent': {
          const agentData = data as BrandAgentVariant;
          const agent = agentData.brand_agent ?? agentData.agents?.find((entry) => entry.type === 'brand');
          if (!agent) {
            if (!skipCache) this.resolutionCache.set(cacheKey, null);
            return null;
          }
          // A house's agent is authoritative for the house. Reached through a
          // redirect it has not yet spoken for the requested domain, so the
          // identity stays with the requested domain and the house stays a claim.
          const result: ResolvedBrand = {
            canonical_id: normalizedDomain,
            canonical_domain: normalizedDomain,
            brand_name: normalizedDomain, // Agent should provide the name via MCP
            brand_agent_url: agent.url,
            ...(redirectedHouseDomain
              ? {
                  claimed_house_domain: redirectedHouseDomain,
                  relationship_trust: 'leaf_only' as const,
                }
              : {}),
            ...this.promotionMetadata(validationResult),
            source: 'brand_json',
          };
          this.resolutionCache.set(cacheKey, result);
          return result;
        }

        case 'house_portfolio': {
          const portfolioData = data as HousePortfolioVariant;
          const brands = portfolioData.brands ?? [];
          // Find the brand that owns this domain
          const brand = this.findBrandByProperty(portfolioData, normalizedDomain);
          if (brand) {
            const primaryName = this.getPrimaryName(brand.names);
            const result: ResolvedBrand = {
              canonical_id: brand.parent_brand
                ? `${brand.parent_brand}#${brand.id}`
                : brand.id,
              canonical_domain: brand.id,
              brand_name: primaryName || brand.id,
              names: brand.names,
              keller_type: brand.keller_type,
              parent_brand: brand.parent_brand,
              house_domain: portfolioData.house.domain,
              house_name: portfolioData.house.name,
              relationship_trust: 'inline',
              brand_manifest: this.buildBrandManifest(brand),
              ...this.promotionMetadata(validationResult),
              source: 'brand_json',
            };
            this.resolutionCache.set(cacheKey, result);
            return result;
          }

          const pointer = portfolioData.brand_refs?.find(
            (ref) => ref.domain.toLowerCase() === normalizedDomain
          );
          if (pointer) {
            const pointed = await this.resolveBrandPointer(
              pointer,
              { skipCache },
              portfolioData.house.domain,
              diagnostics
            );
            // Same rule as every other branch: a fresh probe that fails must
            // not overwrite a live entry with a negative one.
            if (pointed || !skipCache) this.resolutionCache.set(cacheKey, pointed);
            return pointed;
          }

          // The house's own master brand answers only for the house domain.
          // Reached through a redirect from another domain, returning it would
          // let any domain adopt the house's identity unreciprocated.
          if (normalizedDomain === portfolioData.house.domain.toLowerCase()) {
            // Return the master brand if there is one
            const masterBrand = brands.find((b) => b.keller_type === 'master');
            if (masterBrand) {
              const primaryName = this.getPrimaryName(masterBrand.names);
              const result: ResolvedBrand = {
                canonical_id: masterBrand.id,
                canonical_domain: masterBrand.id,
                brand_name: primaryName || masterBrand.id,
                names: masterBrand.names,
                keller_type: masterBrand.keller_type,
                house_domain: portfolioData.house.domain,
                house_name: portfolioData.house.name,
                relationship_trust: 'inline',
                brand_manifest: this.buildBrandManifest(masterBrand),
                ...this.promotionMetadata(validationResult),
                source: 'brand_json',
              };
              this.resolutionCache.set(cacheKey, result);
              return result;
            }
          }

          if (redirectedHouseDomain) {
            const claim = this.unreciprocatedHouseClaim(
              normalizedDomain,
              redirectedHouseDomain,
              validationResult
            );
            this.resolutionCache.set(cacheKey, claim);
            return claim;
          }

          if (!skipCache) this.resolutionCache.set(cacheKey, null);
          return null;
        }

        case 'brand_canonical': {
          const canonical = data as BrandCanonicalDocument;
          // The house's own brand document answers for the requested domain
          // only when it names that domain as an owned property.
          if (redirectedHouseDomain && !this.documentOwnsWebsite(canonical, normalizedDomain)) {
            const claim = this.unreciprocatedHouseClaim(
              normalizedDomain,
              redirectedHouseDomain,
              validationResult
            );
            this.resolutionCache.set(cacheKey, claim);
            return claim;
          }
          const freshResolution = await this.resolveCanonicalDocument(
            canonical,
            currentDomain,
            {
              skipCache,
              maxRedirects,
              ...this.promotionMetadata(validationResult),
            }
          );
          const result = this.retainCachedMutualRelationship(
            cachedBeforeRefresh,
            freshResolution.result,
            freshResolution.retainCachedMutual,
          );
          this.resolutionCache.set(cacheKey, result);
          return result;
        }

        default:
          if (!skipCache) this.resolutionCache.set(cacheKey, null);
          return null;
      }
    }

    if (!skipCache) this.resolutionCache.set(cacheKey, null);
    return null; // Max redirects exceeded
  }

  /**
   * Resolve a brand reference (domain + optional brand_id) to a ResolvedBrand.
   * For single-brand domains (no brand_id), delegates to resolveBrand(domain).
   * For multi-brand domains (with brand_id), resolves the house portfolio and
   * finds the specific brand by id.
   */
  async resolveBrandRef(
    ref: { domain: string; brand_id?: string },
    options: { skipCache?: boolean } = {}
  ): Promise<ResolvedBrand | null> {
    const resolved = await this.resolveBrand(ref.domain, options);
    if (!ref.brand_id) {
      return resolved;
    }

    // If the resolved brand already matches the requested brand_id, return it
    if (
      resolved &&
      (resolved.canonical_id === ref.brand_id || resolved.canonical_domain === ref.brand_id)
    ) {
      return resolved;
    }

    // For house portfolios, look up the specific brand by id
    const validationResult = await this.validateDomain(ref.domain, { skipCache: options.skipCache });
    if (
      validationResult.valid &&
      validationResult.variant === 'house_portfolio' &&
      validationResult.raw_data
    ) {
      const portfolio = validationResult.raw_data as HousePortfolioVariant;
      const brand = portfolio.brands?.find((b) => b.id === ref.brand_id);
      if (brand) {
        const primaryName = this.getPrimaryName(brand.names);
        return {
          canonical_id: brand.parent_brand ? `${brand.parent_brand}#${brand.id}` : brand.id,
          canonical_domain: brand.id,
          brand_name: primaryName || brand.id,
          names: brand.names,
          keller_type: brand.keller_type,
          parent_brand: brand.parent_brand,
          house_domain: portfolio.house.domain,
          house_name: portfolio.house.name,
          relationship_trust: 'inline',
          brand_manifest: this.buildBrandManifest(brand),
          ...this.promotionMetadata(validationResult),
          source: 'brand_json',
        };
      }


      const pointer = portfolio.brand_refs?.find((entry) => entry.brand_id === ref.brand_id);
      if (pointer) {
        return this.resolveBrandPointer(pointer, options, portfolio.house.domain);
      }
    }

    return null;
  }

  /**
   * Resolve a leaf named by a known house portfolio. Unlike resolveBrand(),
   * this preserves the house-side assertion when the leaf does not point
   * back, producing `house_only` instead of incorrectly classifying the leaf
   * as standalone. The crawler uses this while indexing brand_refs[].
   */
  async resolveHouseBrandReference(
    ref: NonNullable<HousePortfolioVariant['brand_refs']>[number],
    houseDomain: string,
    options: { skipCache?: boolean } = {},
  ): Promise<ResolvedBrand | null> {
    return this.resolveBrandPointer(ref, options, houseDomain);
  }

  /**
   * A House Redirect the named house has not reciprocated. The requested
   * domain keeps its own identity and the house stays a claim — the house's
   * brand is never handed to a domain it does not name.
   */
  private unreciprocatedHouseClaim(
    domain: string,
    claimedHouseDomain: string,
    validation: BrandValidationResult
  ): ResolvedBrand {
    return {
      canonical_id: domain,
      canonical_domain: domain,
      brand_name: domain,
      claimed_house_domain: claimedHouseDomain,
      relationship_trust: 'leaf_only',
      ...this.promotionMetadata(validation),
      source: 'brand_json',
    };
  }

  /**
   * Whether a document declares the domain as a website property it owns.
   * `relationship` defaults to `owned` per the brand.json schema; the other
   * values (`direct`, `delegated`, `ad_network`) describe monetization paths,
   * not identity, so they never bind the domain to this brand.
   */
  private documentOwnsWebsite(
    brand: BrandDefinition | BrandCanonicalDocument,
    domain: string
  ): boolean {
    return (brand.properties ?? []).some(
      (property: BrandProperty) =>
        property.type === 'website' &&
        typeof property.identifier === 'string' &&
        property.identifier.toLowerCase() === domain &&
        this.isOwnedProperty(property)
    );
  }

  private isOwnedProperty(property: BrandProperty): boolean {
    const relationship = property.relationship as string | undefined;
    return relationship === undefined || relationship === 'owned';
  }

  private async resolveBrandPointer(
    pointer: NonNullable<HousePortfolioVariant['brand_refs']>[number],
    options: { skipCache?: boolean },
    expectedHouseDomain: string,
    diagnostics: ResolutionDiagnostics = {}
  ): Promise<ResolvedBrand | null> {
    const validation = await this.validateCanonicalPointer(pointer.domain, options);
    this.recordAttempt(diagnostics, validation);
    if (
      !validation.valid ||
      validation.variant !== 'brand_canonical' ||
      !validation.raw_data
    ) {
      return null;
    }

    const canonical = validation.raw_data as BrandCanonicalDocument;
    if (canonical.id !== pointer.brand_id) return null;
    const reciprocal = canonical.house_domain?.toLowerCase() === expectedHouseDomain.toLowerCase();
    let knownRelationship: 'mutual' | 'house_only' | 'unverifiable' = reciprocal
      ? 'mutual'
      : 'house_only';
    let relationshipDeclaredAt: number | undefined;
    if (reciprocal) {
      try {
        relationshipDeclaredAt = await this.relationshipDeclaredAt(
          pointer,
          pointer.domain,
          pointer.brand_id,
          expectedHouseDomain,
        );
      } catch {
        knownRelationship = 'unverifiable';
      }
    }
    const resolution = await this.resolveCanonicalDocument(canonical, pointer.domain, {
      skipCache: options.skipCache,
      maxRedirects: 3,
      knownRelationship,
      verifiedHouseDomain: knownRelationship === 'mutual' ? expectedHouseDomain : undefined,
      relationshipDeclaredAt,
      ...this.promotionMetadata(validation),
    });
    return resolution.result;
  }

  private async validateCanonicalPointer(
    domain: string,
    options: { skipCache?: boolean }
  ): Promise<BrandValidationResult> {
    let validation = await this.validateDomain(domain, { skipCache: options.skipCache });
    for (let redirects = 0; redirects < 3 && validation.variant === 'authoritative_location'; redirects++) {
      const location = (validation.raw_data as AuthoritativeLocationVariant).authoritative_location;
      validation = await this.validateBrandJsonUrl(location, domain);
    }
    return validation;
  }

  private async resolveCanonicalDocument(
    data: BrandCanonicalDocument,
    domain: string,
    options: {
      skipCache?: boolean;
      maxRedirects: number;
      knownRelationship?: 'mutual' | 'house_only' | 'unverifiable';
      verifiedHouseDomain?: string;
      relationshipDeclaredAt?: number;
      promoted_from_schema?: string;
      migration_warnings?: BrandValidationWarning[];
    }
  ): Promise<CanonicalResolution> {
    const primaryName = this.getPrimaryName(data.names);
    const claimedHouseDomain = data.house_domain?.toLowerCase();
    let relationshipTrust: ResolvedBrand['relationship_trust'] = claimedHouseDomain
      ? 'unverifiable'
      : 'standalone';
    let verifiedHouseDomain = options.verifiedHouseDomain;
    let houseName: string | undefined;
    let retainCachedMutual = false;
    let relationshipVerifiedAt: string | undefined;
    let relationshipDeclaredAt = options.relationshipDeclaredAt;

    if (options.knownRelationship) {
      relationshipTrust = options.knownRelationship;
      if (options.knownRelationship === 'mutual') {
        if (
          relationshipDeclaredAt !== undefined &&
          this.withinDeclarationAgeCeiling(relationshipDeclaredAt)
        ) {
          relationshipVerifiedAt = new Date().toISOString();
        } else {
          relationshipTrust = 'leaf_only';
          verifiedHouseDomain = undefined;
        }
      }
    } else if (claimedHouseDomain) {
      const verification = await this.verifyCanonicalHouseRelationship(
        domain,
        data.id,
        claimedHouseDomain,
        options
      );
      relationshipTrust = verification.status;
      verifiedHouseDomain = verification.status === 'mutual' ? verification.houseDomain : undefined;
      houseName = verification.status === 'mutual' ? verification.houseName : undefined;
      relationshipDeclaredAt = verification.status === 'mutual' || verification.status === 'leaf_only'
        ? verification.declaredAt
        : undefined;
      relationshipVerifiedAt = verification.status === 'mutual'
        ? new Date(verification.verifiedAt).toISOString()
        : undefined;
      retainCachedMutual = verification.status === 'unverifiable' && verification.transient;
    }

    return {
      result: {
        canonical_id: data.id,
        canonical_domain: domain,
        brand_name: primaryName || data.id,
        names: data.names,
        keller_type: data.keller_type,
        parent_brand: data.parent_brand,
        house_domain: verifiedHouseDomain,
        claimed_house_domain: claimedHouseDomain,
        house_name: houseName,
        relationship_trust: relationshipTrust,
        relationship_verified_at: relationshipVerifiedAt,
        relationship_declared_at: relationshipDeclaredAt === undefined
          ? undefined
          : new Date(relationshipDeclaredAt).toISOString(),
        promoted_from_schema: options.promoted_from_schema,
        migration_warnings: options.migration_warnings,
        brand_manifest: this.buildBrandManifest(data),
        source: 'brand_json',
      },
      retainCachedMutual,
    };
  }

  private promotionMetadata(validation: BrandValidationResult): Pick<
    ResolvedBrand,
    'promoted_from_schema' | 'migration_warnings'
  > {
    if (!validation.promoted_from_schema) return {};
    return {
      promoted_from_schema: validation.promoted_from_schema,
      migration_warnings: validation.warnings.slice(0, 20),
    };
  }

  /**
   * A fresh leaf document can succeed while its reciprocal house check fails
   * transiently. Reuse a still-live mutual verification only when the leaf's
   * identity and claimed house are unchanged; otherwise the fresh relationship
   * result replaces the cache normally (including a verified leaf_only result).
   *
   * The retained edge keeps its original verification timestamp, so repeated
   * transient failures cannot renew it past MUTUAL_TRUST_RETENTION_MS.
   */
  private retainCachedMutualRelationship(
    cached: ResolvedBrand | null | undefined,
    fresh: ResolvedBrand,
    verificationFailedTransiently: boolean,
  ): ResolvedBrand {
    if (
      !verificationFailedTransiently ||
      cached?.relationship_trust !== 'mutual' ||
      fresh.relationship_trust !== 'unverifiable' ||
      cached.canonical_id !== fresh.canonical_id ||
      cached.canonical_domain !== fresh.canonical_domain ||
      !cached.house_domain ||
      cached.house_domain.toLowerCase() !== fresh.claimed_house_domain?.toLowerCase() ||
      !this.withinMutualRetentionWindow(cached.relationship_verified_at)
    ) {
      return fresh;
    }

    if (!this.withinDeclarationAgeCeiling(cached.relationship_declared_at)) {
      return {
        ...fresh,
        relationship_trust: 'leaf_only',
        relationship_declared_at: cached.relationship_declared_at,
      };
    }

    return {
      ...fresh,
      house_domain: cached.house_domain,
      house_name: cached.house_name,
      relationship_trust: 'mutual',
      relationship_verified_at: cached.relationship_verified_at,
      relationship_declared_at: cached.relationship_declared_at,
    };
  }

  private withinMutualRetentionWindow(verifiedAt: string | undefined): boolean {
    if (!verifiedAt) return false;
    const verifiedAtMs = Date.parse(verifiedAt);
    if (Number.isNaN(verifiedAtMs)) return false;
    return Date.now() - verifiedAtMs <= MUTUAL_TRUST_RETENTION_MS;
  }

  private withinDeclarationAgeCeiling(declaredAt: number | string | undefined): boolean {
    if (declaredAt === undefined) return false;
    const declaredAtMs = typeof declaredAt === 'number' ? declaredAt : Date.parse(declaredAt);
    if (Number.isNaN(declaredAtMs)) return false;
    const now = Date.now();
    return declaredAtMs <= now
      && now - declaredAtMs <= MUTUAL_DECLARATION_MAX_AGE_MS;
  }

  private applyDeclarationAgeCeiling(cached: ResolvedBrand | null): ResolvedBrand | null {
    if (
      cached?.relationship_trust !== 'mutual' ||
      this.withinDeclarationAgeCeiling(cached.relationship_declared_at)
    ) {
      return cached;
    }
    return {
      ...cached,
      house_domain: undefined,
      house_name: undefined,
      relationship_trust: 'leaf_only',
      relationship_verified_at: undefined,
    };
  }

  private async relationshipDeclaredAt(
    ref: NonNullable<HousePortfolioVariant['brand_refs']>[number],
    leafDomain: string,
    brandId: string,
    houseDomain: string,
  ): Promise<number> {
    try {
      return await this.observeRelationshipDeclaration({
        houseDomain,
        leafDomain,
        brandId,
        effectiveAt: ref.effective_at,
      });
    } catch (error) {
      // An explicit publisher timestamp is still usable if persistence is
      // temporarily unavailable. Missing effective_at must fail closed: using
      // Date.now() would silently renew an edge after every storage outage.
      if (ref.effective_at) {
        const declaredAt = Date.parse(ref.effective_at);
        if (!Number.isNaN(declaredAt)) return declaredAt;
      }
      throw error;
    }
  }

  private async verifyCanonicalHouseRelationship(
    leafDomain: string,
    brandId: string,
    claimedHouseDomain: string,
    options: { skipCache?: boolean; maxRedirects: number }
  ): Promise<CanonicalHouseVerification> {
    let current = claimedHouseDomain;
    let currentUrl: string | undefined;
    const seen = new Set<string>();

    for (let redirects = 0; redirects <= options.maxRedirects; redirects++) {
      const visitKey = currentUrl ? `url:${currentUrl}` : `domain:${current}`;
      if (seen.has(visitKey)) return { status: 'unverifiable', transient: false };
      seen.add(visitKey);
      const validation = currentUrl
        ? await this.validateBrandJsonUrl(currentUrl, current)
        : await this.validateDomain(current, { skipCache: options.skipCache });
      if (!validation.valid || !validation.raw_data) {
        return {
          status: 'unverifiable',
          transient: this.isTransientValidationFailure(validation),
        };
      }

      if (validation.variant === 'house_redirect') {
        current = (validation.raw_data as HouseRedirectVariant).house.toLowerCase();
        currentUrl = undefined;
        continue;
      }
      if (validation.variant === 'authoritative_location') {
        const location = (validation.raw_data as AuthoritativeLocationVariant).authoritative_location;
        currentUrl = location;
        continue;
      }
      if (validation.variant !== 'house_portfolio') {
        return { status: 'unverifiable', transient: false };
      }

      const portfolio = validation.raw_data as HousePortfolioVariant;
      const reciprocal = portfolio.brand_refs?.find((ref) =>
        ref.domain.toLowerCase() === leafDomain.toLowerCase() && ref.brand_id === brandId
      );
      if (!reciprocal) return { status: 'leaf_only' };
      let declaredAt: number;
      try {
        declaredAt = await this.relationshipDeclaredAt(
          reciprocal,
          leafDomain,
          brandId,
          portfolio.house.domain,
        );
      } catch {
        return { status: 'unverifiable', transient: true };
      }
      if (!this.withinDeclarationAgeCeiling(declaredAt)) {
        return { status: 'leaf_only', declaredAt };
      }
      return {
        status: 'mutual',
        houseDomain: portfolio.house.domain,
        houseName: portfolio.house.name,
        verifiedAt: Date.now(),
        declaredAt,
      };
    }
    return { status: 'unverifiable', transient: false };
  }

  private isTransientValidationFailure(validation: BrandValidationResult): boolean {
    if (validation.status_code === 429 || (validation.status_code ?? 0) >= 500) {
      return true;
    }
    if (validation.status_code !== undefined) return false;
    return validation.errors.some((error) =>
      ['timeout', 'connection', 'network', 'unknown'].includes(error.field)
    );
  }

  /**
   * Build the brand_manifest payload (creative asset data) from a brand by
   * stripping identity (`id`, `names`, `keller_type`, `parent_brand`) and
   * ownership (`properties`) fields that have separate semantic meaning.
   * Returns undefined when no manifest data remains.
   *
   * Brand fields are flat on the brand object per the unified brand.json
   * schema. A legacy nested `brand_manifest` sub-key, if present, is merged
   * in for backwards compatibility; flat fields take precedence.
   */
  private buildBrandManifest(
    brand: BrandDefinition | BrandCanonicalDocument
  ): Record<string, unknown> | undefined {
    const {
      $schema: _schema,
      version: _version,
      last_updated: _lastUpdated,
      house_domain: _houseDomain,
      id: _id,
      names: _names,
      keller_type: _kellerType,
      parent_brand: _parentBrand,
      properties: _properties,
      legacy_properties: _legacyProperties,
      legacy_metadata: _legacyMetadata,
      brand_manifest: brandManifest,
      ...rest
    } = brand as BrandCanonicalDocument & Record<string, unknown>;

    const legacy =
      brandManifest && typeof brandManifest === 'object'
        ? (brandManifest as Record<string, unknown>)
        : undefined;

    const merged: Record<string, unknown> = { ...(legacy ?? {}), ...rest };
    return Object.keys(merged).length > 0 ? merged : undefined;
  }

  /**
   * Find a brand in a portfolio by property identifier. Only owned properties
   * bind an identifier to a brand's identity — a house that merely sells or
   * operates a property does not become that property's brand.
   */
  private findBrandByProperty(
    portfolio: HousePortfolioVariant,
    identifier: string
  ): BrandDefinition | null {
    for (const brand of portfolio.brands ?? []) {
      // Check if identifier matches brand id
      if (brand.id === identifier) {
        return brand;
      }

      // Check properties
      if (brand.properties) {
        for (const prop of brand.properties) {
          if (prop.identifier === identifier && this.isOwnedProperty(prop)) {
            return brand;
          }
        }
      }
    }
    return null;
  }

  /**
   * Get the primary (English or first) name from names array
   */
  private getPrimaryName(names: LocalizedName[]): string | null {
    if (!names || names.length === 0) return null;

    // First try to find English name
    for (const nameObj of names) {
      if ('en' in nameObj) {
        return nameObj.en;
      }
    }

    // Fall back to first name
    const firstEntry = Object.values(names[0])[0];
    return firstEntry || null;
  }

  /**
   * Validate that a brand agent is reachable
   */
  async validateBrandAgent(agentUrl: string): Promise<BrandAgentValidationResult> {
    const result: BrandAgentValidationResult = {
      agent_url: agentUrl,
      valid: false,
      errors: [],
    };

    const startTime = Date.now();
    const MCP_TIMEOUT_MS = 5000;

    try {
      const { AdCPClient } = await import('@adcp/sdk');
      const multiClient = new AdCPClient([
        {
          id: 'brand-agent-check',
          name: 'Brand Agent Checker',
          agent_uri: agentUrl,
          protocol: 'mcp',
        },
      ], withSdkSafeTransport({ userAgent: AAO_UA_VALIDATOR }));
      const client = multiClient.agent('brand-agent-check');

      const agentInfo = await Promise.race([
        client.getAgentInfo(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('MCP connection timed out')), MCP_TIMEOUT_MS)
        ),
      ]);

      result.response_time_ms = Date.now() - startTime;
      result.valid = true;
      result.agent_data = {
        name: agentInfo.name,
        protocol: 'mcp',
        tools: agentInfo.tools?.map((t: { name: string }) => t.name) || [],
        tools_count: agentInfo.tools?.length || 0,
      };
    } catch (error) {
      result.response_time_ms = Date.now() - startTime;
      const message = error instanceof Error ? error.message : 'Unknown error';
      result.errors.push(`MCP connection failed: ${message}`);
    }

    return result;
  }

  /**
   * Create a house redirect brand.json file
   */
  createHouseRedirect(houseDomain: string, options?: { region?: string; note?: string }): string {
    const brandJson: HouseRedirectVariant = {
      $schema: 'https://adcontextprotocol.org/schemas/latest/brand.json',
      house: houseDomain,
    };

    if (options?.region) {
      brandJson.region = options.region;
    }

    if (options?.note) {
      brandJson.note = options.note;
    }

    brandJson.last_updated = new Date().toISOString();

    return JSON.stringify(brandJson, null, 2);
  }

  /**
   * Create an authoritative location redirect brand.json file
   */
  createAuthoritativeRedirect(authoritativeUrl: string): string {
    const brandJson: AuthoritativeLocationVariant = {
      $schema: 'https://adcontextprotocol.org/schemas/latest/brand.json',
      authoritative_location: authoritativeUrl,
      last_updated: new Date().toISOString(),
    };

    return JSON.stringify(brandJson, null, 2);
  }

  /**
   * Create a brand agent brand.json file
   */
  createBrandAgentFile(
    agentUrl: string,
    agentId: string,
    capabilities?: string[],
    auth?: BrandAgentVariant['auth']
  ): string {
    const brandJson: BrandAgentVariant = {
      $schema: 'https://adcontextprotocol.org/schemas/latest/brand.json',
      version: '1.0',
      brand_agent: {
        url: agentUrl,
        id: agentId,
        capabilities: capabilities || [],
      },
      last_updated: new Date().toISOString(),
    };

    if (auth) {
      brandJson.auth = auth;
    }

    return JSON.stringify(brandJson, null, 2);
  }

  /**
   * Create a house portfolio brand.json file
   */
  createHousePortfolio(
    house: HouseDefinition,
    brands: BrandDefinition[],
    options?: { contact?: HousePortfolioVariant['contact'] }
  ): string {
    const brandJson: HousePortfolioVariant = {
      $schema: 'https://adcontextprotocol.org/schemas/latest/brand.json',
      version: '1.0',
      house,
      brands,
      last_updated: new Date().toISOString(),
    };

    if (options?.contact) {
      brandJson.contact = options.contact;
    }

    return JSON.stringify(brandJson, null, 2);
  }
}
