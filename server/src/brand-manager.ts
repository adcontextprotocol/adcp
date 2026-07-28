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
const LAST_VALIDATION_ATTEMPT_TTL_MS = 5 * 60 * 1000;
const LAST_VALIDATION_ATTEMPT_MAX_ENTRIES = 500;

interface LastValidationAttemptEntry {
  value: BrandValidationResult;
  expiresAt: number;
}

type CanonicalHouseVerification =
  | { status: 'mutual'; houseDomain: string; houseName?: string }
  | { status: 'leaf_only' }
  | { status: 'unverifiable' };

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
  // Most recent network attempt per domain, including fresh failures. Used to
  // report the attempt that actually caused a fallback instead of an older
  // positive cache entry.
  private lastValidationAttempt = new Map<string, LastValidationAttemptEntry>();

  constructor() {
    this.validationCache = new Cache<BrandValidationResult>(24 * 60, BRAND_CACHE_MAX_ENTRIES); // 24 hours
    this.resolutionCache = new Cache<ResolvedBrand | null>(24 * 60, BRAND_CACHE_MAX_ENTRIES); // 24 hours
    this.failedLookupCache = new Cache<BrandValidationResult>(60, BRAND_FAILED_CACHE_MAX_ENTRIES); // 1 hour
  }

  /**
   * Clear all caches
   */
  clearCache(): void {
    this.validationCache.clear();
    this.resolutionCache.clear();
    this.failedLookupCache.clear();
    this.lastValidationAttempt.clear();
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

  getLastValidationResult(domain: string): BrandValidationResult | undefined {
    const normalized = domain.trim().toLowerCase();
    const entry = this.lastValidationAttempt.get(normalized);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.lastValidationAttempt.delete(normalized);
      return undefined;
    }
    return entry.value;
  }

  private recordLastValidationAttempt(domain: string, result: BrandValidationResult): void {
    const normalized = domain.trim().toLowerCase();
    const { raw_data: _rawData, ...withoutRawData } = result;
    const diagnostic: BrandValidationResult = {
      ...withoutRawData,
      errors: result.errors.slice(0, 20),
      warnings: result.warnings.slice(0, 20),
    };

    // Refresh insertion order so the cap evicts the least-recently recorded
    // domain. The diagnostic cache intentionally never retains response bodies.
    this.lastValidationAttempt.delete(normalized);
    this.lastValidationAttempt.set(normalized, {
      value: diagnostic,
      expiresAt: Date.now() + LAST_VALIDATION_ATTEMPT_TTL_MS,
    });
    while (this.lastValidationAttempt.size > LAST_VALIDATION_ATTEMPT_MAX_ENTRIES) {
      const oldestKey = this.lastValidationAttempt.keys().next().value;
      if (oldestKey === undefined) break;
      this.lastValidationAttempt.delete(oldestKey);
    }
  }

  private normalizeLookupDomain(domain: string): string | null {
    const normalized = domain.trim().toLowerCase();
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

    // Compatibility promotion is identity-only. Require exactly one explicit
    // website match to the TLS origin; never infer identity from array position.
    const originMatches: Array<{ brand: Record<string, unknown>; brandIndex: number; propertyIndex: number }> = [];
    for (const [brandIndex, brand] of brands.entries()) {
      if (!Array.isArray(brand.properties)) continue;
      for (const [propertyIndex, property] of brand.properties.entries()) {
        if (
          this.isRecord(property) &&
          property.type === 'website' &&
          typeof property.identifier === 'string' &&
          property.identifier.toLowerCase() === originDomain &&
          property.relationship === 'owned'
        ) {
          originMatches.push({ brand, brandIndex, propertyIndex });
        }
      }
    }

    if (originMatches.length !== 1) {
      warnings.push({
        field: 'brands',
        message: `Legacy promotion requires exactly one owned website property matching ${originDomain}; found ${originMatches.length}`,
      });
      return { data, warnings, promotedFromSchema: LEGACY_BRAND_SCHEMA };
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
      return { data, warnings, promotedFromSchema: LEGACY_BRAND_SCHEMA };
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
    if (house) metadata.legacy_house = house;

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
      this.recordLastValidationAttempt(domain, invalidResult);
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
        this.recordLastValidationAttempt(cacheKey, result);
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
        this.recordLastValidationAttempt(cacheKey, result);
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

    this.recordLastValidationAttempt(cacheKey, result);

    return result;
  }

  private async validateBrandData(
    brandData: unknown,
    attributedDomain: string,
    result: BrandValidationResult
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
      await this.validateBrandData(data, attributedDomain, result);
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
    const { maxRedirects = 3, skipCache = false } = options;
    const normalizedDomain = this.normalizeLookupDomain(domain);
    if (!normalizedDomain) return null;
    const cacheKey = `resolve:${normalizedDomain}`;

    // Check resolution cache unless explicitly skipped
    if (!skipCache) {
      const cached = this.resolutionCache.get(cacheKey);
      if (cached !== undefined) {
        return cached;
      }
    }

    let currentDomain = normalizedDomain;
    let currentUrl: string | undefined;
    let redirectCount = 0;

    while (redirectCount <= maxRedirects) {
      const validationResult = currentUrl
        ? await this.validateBrandJsonUrl(currentUrl, currentDomain)
        : await this.validateDomain(currentDomain, { skipCache });
      this.recordLastValidationAttempt(normalizedDomain, validationResult);

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
          currentDomain = redirectData.house;
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
          const result: ResolvedBrand = {
            canonical_id: currentDomain,
            canonical_domain: currentDomain,
            brand_name: currentDomain, // Agent should provide the name via MCP
            brand_agent_url: agent.url,
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
              normalizedDomain
            );
            this.resolutionCache.set(cacheKey, pointed);
            return pointed;
          }

          // Check if the query domain is the house domain itself
          if (currentDomain === portfolioData.house.domain) {
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

          if (!skipCache) this.resolutionCache.set(cacheKey, null);
          return null;
        }

        case 'brand_canonical': {
          const result = await this.resolveCanonicalDocument(
            data as BrandCanonicalDocument,
            currentDomain,
            {
              skipCache,
              maxRedirects,
              ...this.promotionMetadata(validationResult),
            }
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
        return this.resolveBrandPointer(pointer, options, portfolio.house.domain, ref.domain);
      }
    }

    return null;
  }

  private async resolveBrandPointer(
    pointer: NonNullable<HousePortfolioVariant['brand_refs']>[number],
    options: { skipCache?: boolean },
    expectedHouseDomain: string,
    diagnosticDomain: string
  ): Promise<ResolvedBrand | null> {
    const validation = await this.validateCanonicalPointer(pointer.domain, options);
    this.recordLastValidationAttempt(diagnosticDomain, validation);
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
    return this.resolveCanonicalDocument(canonical, pointer.domain, {
      skipCache: options.skipCache,
      maxRedirects: 3,
      knownRelationship: reciprocal ? 'mutual' : 'house_only',
      verifiedHouseDomain: reciprocal ? expectedHouseDomain : undefined,
      ...this.promotionMetadata(validation),
    });
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
      knownRelationship?: 'mutual' | 'house_only';
      verifiedHouseDomain?: string;
      promoted_from_schema?: string;
      migration_warnings?: BrandValidationWarning[];
    }
  ): Promise<ResolvedBrand> {
    const primaryName = this.getPrimaryName(data.names);
    const claimedHouseDomain = data.house_domain?.toLowerCase();
    let relationshipTrust: ResolvedBrand['relationship_trust'] = claimedHouseDomain
      ? 'unverifiable'
      : 'standalone';
    let verifiedHouseDomain = options.verifiedHouseDomain;
    let houseName: string | undefined;

    if (options.knownRelationship) {
      relationshipTrust = options.knownRelationship;
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
    }

    return {
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
      promoted_from_schema: options.promoted_from_schema,
      migration_warnings: options.migration_warnings,
      brand_manifest: this.buildBrandManifest(data),
      source: 'brand_json',
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
      if (seen.has(visitKey)) return { status: 'unverifiable' };
      seen.add(visitKey);
      const validation = currentUrl
        ? await this.validateBrandJsonUrl(currentUrl, current)
        : await this.validateDomain(current, { skipCache: options.skipCache });
      if (!validation.valid || !validation.raw_data) return { status: 'unverifiable' };

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
      if (validation.variant !== 'house_portfolio') return { status: 'unverifiable' };

      const portfolio = validation.raw_data as HousePortfolioVariant;
      const reciprocal = portfolio.brand_refs?.some((ref) =>
        ref.domain.toLowerCase() === leafDomain.toLowerCase() && ref.brand_id === brandId
      );
      return reciprocal
        ? {
            status: 'mutual',
            houseDomain: portfolio.house.domain,
            houseName: portfolio.house.name,
          }
        : { status: 'leaf_only' };
    }
    return { status: 'unverifiable' };
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
   * Find a brand in a portfolio by property identifier
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
          if (prop.identifier === identifier) {
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
