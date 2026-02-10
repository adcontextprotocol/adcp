import axios from 'axios';
import { Cache } from './cache.js';
import type {
  LocalizedName,
  BrandProperty,
  BrandDefinition,
  HouseDefinition,
  BrandAgentConfig,
  ResolvedBrand,
  KellerType,
} from './types';

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
  variant?: 'authoritative_location' | 'house_redirect' | 'brand_agent' | 'house_portfolio';
}

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
  brand_agent: BrandAgentConfig;
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
  brands: BrandDefinition[];
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

export type BrandJson = AuthoritativeLocationVariant | HouseRedirectVariant | BrandAgentVariant | HousePortfolioVariant;

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

  constructor() {
    this.validationCache = new Cache<BrandValidationResult>(24 * 60); // 24 hours
    this.resolutionCache = new Cache<ResolvedBrand | null>(24 * 60); // 24 hours
    this.failedLookupCache = new Cache<BrandValidationResult>(60); // 1 hour
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
   * Validates a domain's brand.json file
   */
  async validateDomain(domain: string, options?: { skipCache?: boolean }): Promise<BrandValidationResult> {
    const normalizedDomain = domain.replace(/^https?:\/\//, '').replace(/\/$/, '');
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
      const response = await axios.get(url, {
        timeout: 10000,
        headers: {
          Accept: 'application/json',
          'User-Agent': 'AdCP-Brand-Validator/1.0',
        },
        validateStatus: () => true,
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

      result.raw_data = response.data;
      const brandData = response.data;

      // Determine which variant this is and validate
      const variant = this.detectVariant(brandData);
      result.variant = variant || undefined;

      switch (variant) {
        case 'authoritative_location':
          await this.validateAuthoritativeLocationVariant(brandData, result);
          break;
        case 'house_redirect':
          this.validateHouseRedirectVariant(brandData, result);
          break;
        case 'brand_agent':
          this.validateBrandAgentVariant(brandData, result);
          break;
        case 'house_portfolio':
          this.validateHousePortfolioVariant(brandData, result);
          break;
        default:
          result.errors.push({
            field: 'root',
            message: 'Unable to determine brand.json variant. Must contain one of: authoritative_location, house (string), brand_agent, or house (object) + brands',
            severity: 'error',
          });
      }

      result.valid = result.errors.length === 0;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
          result.errors.push({
            field: 'connection',
            message: `Cannot connect to ${normalizedDomain}`,
            severity: 'error',
          });
        } else if (error.code === 'ECONNABORTED') {
          result.errors.push({
            field: 'timeout',
            message: 'Request timed out after 10 seconds',
            severity: 'error',
          });
        } else {
          result.errors.push({
            field: 'network',
            message: error.message,
            severity: 'error',
          });
        }
      } else {
        result.errors.push({
          field: 'unknown',
          message: 'Unknown error occurred',
          severity: 'error',
        });
      }
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
   * Detect which variant of brand.json this is
   */
  private detectVariant(
    data: unknown
  ): 'authoritative_location' | 'house_redirect' | 'brand_agent' | 'house_portfolio' | null {
    if (typeof data !== 'object' || data === null) {
      return null;
    }

    const obj = data as Record<string, unknown>;

    // Check for authoritative_location redirect
    if ('authoritative_location' in obj && typeof obj.authoritative_location === 'string') {
      return 'authoritative_location';
    }

    // Check for brand_agent
    if ('brand_agent' in obj && typeof obj.brand_agent === 'object') {
      return 'brand_agent';
    }

    // Check for house - could be string (redirect) or object (portfolio)
    if ('house' in obj) {
      if (typeof obj.house === 'string') {
        return 'house_redirect';
      }
      if (typeof obj.house === 'object' && 'brands' in obj) {
        return 'house_portfolio';
      }
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
    if (!data.brand_agent || typeof data.brand_agent !== 'object') {
      result.errors.push({
        field: 'brand_agent',
        message: 'brand_agent object is required',
        severity: 'error',
      });
      return;
    }

    if (!data.brand_agent.id) {
      result.errors.push({
        field: 'brand_agent.id',
        message: 'brand_agent.id is required',
        severity: 'error',
      });
    }

    if (!data.brand_agent.url) {
      result.errors.push({
        field: 'brand_agent.url',
        message: 'brand_agent.url is required',
        severity: 'error',
      });
    } else {
      try {
        const url = new URL(data.brand_agent.url);
        if (!url.protocol.startsWith('https:')) {
          result.errors.push({
            field: 'brand_agent.url',
            message: 'brand_agent.url must use HTTPS',
            severity: 'error',
          });
        }
      } catch {
        result.errors.push({
          field: 'brand_agent.url',
          message: 'brand_agent.url must be a valid URL',
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

    // Validate brands array
    if (!data.brands || !Array.isArray(data.brands)) {
      result.errors.push({
        field: 'brands',
        message: 'brands array is required',
        severity: 'error',
      });
      return;
    }

    if (data.brands.length === 0) {
      result.errors.push({
        field: 'brands',
        message: 'brands array must contain at least one brand',
        severity: 'error',
      });
      return;
    }

    // Validate each brand
    data.brands.forEach((brand, index) => {
      this.validateBrand(brand, index, result);
    });

    // Check for duplicate brand IDs
    const seenIds = new Set<string>();
    data.brands.forEach((brand, index) => {
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

    // Validate parent_brand references
    data.brands.forEach((brand, index) => {
      if (brand.parent_brand && !seenIds.has(brand.parent_brand)) {
        result.warnings.push({
          field: `brands[${index}].parent_brand`,
          message: `parent_brand "${brand.parent_brand}" not found in this portfolio`,
          suggestion: 'Ensure parent brand is defined in the same portfolio, or reference an external brand',
        });
      }
    });
  }

  /**
   * Validate a single brand definition
   */
  private validateBrand(
    brand: BrandDefinition,
    index: number,
    result: BrandValidationResult
  ): void {
    const prefix = `brands[${index}]`;

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
      brand.properties.forEach((prop, propIndex) => {
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
    const normalizedDomain = domain.replace(/^https?:\/\//, '').replace(/\/$/, '');
    const cacheKey = `resolve:${normalizedDomain}`;

    // Check resolution cache unless explicitly skipped
    if (!skipCache) {
      const cached = this.resolutionCache.get(cacheKey);
      if (cached !== undefined) {
        return cached;
      }
    }

    let currentDomain = normalizedDomain;
    let redirectCount = 0;

    while (redirectCount < maxRedirects) {
      const validationResult = await this.validateDomain(currentDomain, { skipCache });

      if (!validationResult.valid || !validationResult.raw_data) {
        this.resolutionCache.set(cacheKey, null);
        return null;
      }

      const data = validationResult.raw_data as BrandJson;

      switch (validationResult.variant) {
        case 'authoritative_location': {
          const authData = data as AuthoritativeLocationVariant;
          try {
            const url = new URL(authData.authoritative_location);
            currentDomain = url.hostname + url.pathname;
            redirectCount++;
            continue;
          } catch {
            this.resolutionCache.set(cacheKey, null);
            return null;
          }
        }

        case 'house_redirect': {
          const redirectData = data as HouseRedirectVariant;
          currentDomain = redirectData.house;
          redirectCount++;
          continue;
        }

        case 'brand_agent': {
          const agentData = data as BrandAgentVariant;
          const result: ResolvedBrand = {
            canonical_id: currentDomain,
            canonical_domain: currentDomain,
            brand_name: currentDomain, // Agent should provide the name via MCP
            brand_agent_url: agentData.brand_agent.url,
            source: 'brand_json',
          };
          this.resolutionCache.set(cacheKey, result);
          return result;
        }

        case 'house_portfolio': {
          const portfolioData = data as HousePortfolioVariant;
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
              brand_manifest: brand.brand_manifest as Record<string, unknown> | undefined,
              source: 'brand_json',
            };
            this.resolutionCache.set(cacheKey, result);
            return result;
          }

          // Check if the query domain is the house domain itself
          if (currentDomain === portfolioData.house.domain) {
            // Return the master brand if there is one
            const masterBrand = portfolioData.brands.find((b) => b.keller_type === 'master');
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
                source: 'brand_json',
              };
              this.resolutionCache.set(cacheKey, result);
              return result;
            }
          }

          this.resolutionCache.set(cacheKey, null);
          return null;
        }

        default:
          this.resolutionCache.set(cacheKey, null);
          return null;
      }
    }

    this.resolutionCache.set(cacheKey, null);
    return null; // Max redirects exceeded
  }

  /**
   * Find a brand in a portfolio by property identifier
   */
  private findBrandByProperty(
    portfolio: HousePortfolioVariant,
    identifier: string
  ): BrandDefinition | null {
    for (const brand of portfolio.brands) {
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
      const { AdCPClient } = await import('@adcp/client');
      const multiClient = new AdCPClient([
        {
          id: 'brand-agent-check',
          name: 'Brand Agent Checker',
          agent_uri: agentUrl,
          protocol: 'mcp',
        },
      ]);
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
      $schema: 'https://adcontextprotocol.org/schemas/v1/brand.json',
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
      $schema: 'https://adcontextprotocol.org/schemas/v1/brand.json',
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
      $schema: 'https://adcontextprotocol.org/schemas/v1/brand.json',
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
      $schema: 'https://adcontextprotocol.org/schemas/v1/brand.json',
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
