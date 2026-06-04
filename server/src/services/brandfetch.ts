/**
 * Brandfetch API integration for brand enrichment
 *
 * When a domain doesn't have a brand.json file, we can use Brandfetch
 * to get brand data (logos, colors, company info) as a fallback.
 *
 * API Docs:
 * - https://docs.brandfetch.com/brand-api/overview
 * - https://docs.brandfetch.com/brand-context-api/overview
 */

import axios from 'axios';
import { createLogger } from '../logger.js';
import { assertValidBrandDomain, canonicalizeBrandDomain } from './identifier-normalization.js';

const logger = createLogger('brandfetch');

const BRANDFETCH_API_KEY = process.env.BRANDFETCH_API_KEY;
const BRANDFETCH_API_BASE_URL = 'https://api.brandfetch.io/v2';
const BRANDFETCH_BRANDS_API_URL = `${BRANDFETCH_API_BASE_URL}/brands`;
const BRANDFETCH_CONTEXT_API_URL = `${BRANDFETCH_API_BASE_URL}/context`;

const BRANDFETCH_TIMEOUT_MS = 30_000; // 30 seconds
const BRANDFETCH_MAX_RETRIES = 2;
const BRANDFETCH_RETRY_DELAY_MS = 1_000;

/**
 * Brandfetch API response types
 */
export interface BrandfetchLogo {
  type: 'logo' | 'symbol' | 'icon' | 'other';
  theme: 'light' | 'dark' | null;
  formats: Array<{
    src: string;
    format: 'svg' | 'png' | 'webp' | 'jpeg';
    size?: number;
    height?: number;
    width?: number;
  }>;
}

export interface BrandfetchColor {
  hex: string;
  type: 'accent' | 'brand' | 'customizable' | 'dark' | 'light' | 'vibrant';
  brightness: number;
}

export interface BrandfetchFont {
  name: string;
  type: 'title' | 'body' | 'other';
  origin: 'google' | 'custom' | 'system' | 'unknown';
  originId?: string;
  weights: number[];
}

export interface BrandfetchImage {
  type: 'banner' | 'other';
  formats: Array<{
    src: string;
    format: string;
  }>;
}

export interface BrandfetchLink {
  name: string;
  url: string;
}

export interface BrandfetchIndustry {
  score: number;
  id: string;
  name: string;
  emoji: string;
  parent?: {
    id: string;
    name: string;
  };
  slug: string;
}

export interface BrandfetchCompany {
  employees?: string;
  foundedYear?: number;
  industries?: BrandfetchIndustry[];
  kind?: string;
  location?: {
    city?: string;
    country?: string;
    countryCode?: string;
    region?: string;
    state?: string;
    subregion?: string;
  };
}

export interface BrandfetchResponse {
  id: string;
  name: string;
  domain: string;
  claimed: boolean;
  verified: boolean;
  description?: string;
  longDescription?: string;
  qualityScore?: number;
  isNsfw?: boolean;
  logos?: BrandfetchLogo[];
  colors?: BrandfetchColor[];
  fonts?: BrandfetchFont[];
  images?: BrandfetchImage[];
  links?: BrandfetchLink[];
  company?: BrandfetchCompany;
}

export interface BrandfetchContextResponse {
  meta?: {
    domain?: string;
    canonical_name?: string;
    resolved_at?: string;
  };
  identity?: {
    tagline?: string;
    mission?: string;
    description?: string;
    tags?: string[];
  };
  positioning?: {
    value_proposition?: string;
    target_audience?: Array<{
      segment?: string;
      description?: string;
    }>;
    products_and_services?: Array<{
      name?: string;
      type?: string;
      description?: string;
    }>;
  };
  brand?: {
    voice?: {
      summary?: string;
      attributes?: string[];
      avoid?: string[];
    };
    style?: {
      summary?: string;
      attributes?: string[];
    };
  };
}

export interface BrandfetchContextResult {
  success: boolean;
  domain: string;
  context?: BrandfetchContextResponse;
  error?: string;
  cached?: boolean;
}

/**
 * AdCP Brand Manifest format (subset for enrichment)
 */
export interface EnrichedBrandManifest {
  name: string;
  url: string;
  description?: string;
  logos?: Array<{
    url: string;
    tags: string[];
  }>;
  colors?: {
    primary?: string;
    secondary?: string;
    accent?: string;
  };
  fonts?: Array<{
    name: string;
    role: string;
  }>;
  tone?: string;
}

export interface BrandfetchEnrichmentResult {
  success: boolean;
  domain: string;
  manifest?: EnrichedBrandManifest;
  company?: {
    name: string;
    industries?: string[];
    employees?: string;
    founded?: number;
    location?: string;
  };
  /** Whether Brandfetch returned meaningful brand data (logos, description, decent quality score).
   * When false, the result should be saved as 'community' rather than 'enriched'. */
  highQuality?: boolean;
  raw?: BrandfetchResponse;
  context?: BrandfetchContextResponse;
  contextError?: string;
  error?: string;
  cached?: boolean;
}

export interface FetchBrandDataOptions {
  /**
   * When true, also fetch Brandfetch Brand Context API data and return it as
   * ephemeral context. Context text must not be persisted into brand_manifest.
   */
  includeContext?: boolean;
}

// Simple in-memory cache with short TTL (rate-limit protection only)
// Enriched data should be saved to brands table for persistence
const cache = new Map<string, { data: BrandfetchEnrichmentResult; expiresAt: number }>();
const contextCache = new Map<string, { data: BrandfetchContextResult; expiresAt: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes (rate-limit protection)

// DB-level cache: callers should check brands.last_validated before hitting the API
export const ENRICHMENT_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// Minimum Brandfetch qualityScore (0-1) to consider a result genuine vs. a placeholder
export const QUALITY_SCORE_THRESHOLD = 0.3;

/**
 * Check if Brandfetch is configured
 */
export function isBrandfetchConfigured(): boolean {
  return !!BRANDFETCH_API_KEY;
}

export function summarizeBrandfetchError(error: unknown): { name?: string; message: string; code?: string; status?: number } {
  if (!axios.isAxiosError(error)) {
    return error instanceof Error
      ? { name: error.name, message: error.message }
      : { message: String(error) };
  }

  return {
    name: error.name,
    message: error.message,
    code: error.code,
    status: error.response?.status,
  };
}

function normalizeBrandfetchDomain(domain: string): { domain: string } | { error: string; domain: string } {
  const normalizedDomain = canonicalizeBrandDomain(domain);
  try {
    assertValidBrandDomain(normalizedDomain);
  } catch {
    return {
      domain: normalizedDomain,
      error: 'Invalid domain format',
    };
  }

  return { domain: normalizedDomain };
}

/**
 * Fetch brand data from Brandfetch API
 */
export async function fetchBrandData(domain: string, options: FetchBrandDataOptions = {}): Promise<BrandfetchEnrichmentResult> {
  if (!BRANDFETCH_API_KEY) {
    return {
      success: false,
      domain,
      error: 'BRANDFETCH_API_KEY not configured',
    };
  }

  const normalized = normalizeBrandfetchDomain(domain);
  const normalizedDomain = normalized.domain;
  if ('error' in normalized) {
    return {
      success: false,
      domain: normalizedDomain,
      error: normalized.error,
    };
  }

  // Check cache
  const cached = cache.get(normalizedDomain);
  if (cached && cached.expiresAt > Date.now()) {
    logger.debug({ domain: normalizedDomain }, 'Brandfetch cache hit');
    const cachedResult = { ...cached.data, cached: true };
    if (!options.includeContext) return cachedResult;
    return withBrandContext(cachedResult);
  }

  for (let attempt = 0; attempt <= BRANDFETCH_MAX_RETRIES; attempt++) {
    try {
      logger.info({ domain: normalizedDomain, attempt }, 'Fetching brand data from Brandfetch');

      // CodeQL: BRANDFETCH_BRANDS_API_URL is from constant config, domain is normalized
      const response = await axios.get( // lgtm[js/request-forgery]
        `${BRANDFETCH_BRANDS_API_URL}/domain/${normalizedDomain}`,
        {
          headers: {
            Authorization: `Bearer ${BRANDFETCH_API_KEY}`,
            Accept: 'application/json',
          },
          timeout: BRANDFETCH_TIMEOUT_MS,
          validateStatus: () => true,
          responseType: 'arraybuffer',
        }
      );

      if (response.status === 404) {
        if (options.includeContext) {
          const contextResult = await fetchBrandContext(normalizedDomain);
          if (contextResult.success && contextResult.context) {
            const result = mapContextToEnrichmentResult(normalizedDomain, contextResult.context);
            return result;
          }
        }

        const result: BrandfetchEnrichmentResult = {
          success: false,
          domain: normalizedDomain,
          error: 'Brand not found in Brandfetch',
        };
        // Cache negative results for shorter time
        cache.set(normalizedDomain, { data: result, expiresAt: Date.now() + 5 * 60 * 1000 }); // 5 minutes
        return result;
      }

      const isRetryableStatus = response.status === 429 || (response.status >= 500 && response.status < 600);
      if (isRetryableStatus && attempt < BRANDFETCH_MAX_RETRIES) {
        const delay = BRANDFETCH_RETRY_DELAY_MS * Math.pow(2, attempt);
        logger.warn({ status: response.status, domain: normalizedDomain, attempt, delay }, 'Brandfetch transient error, retrying');
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }

      if (response.status !== 200) {
        logger.warn({ status: response.status, domain: normalizedDomain }, 'Brandfetch API non-2xx response');
        return {
          success: false,
          domain: normalizedDomain,
          error: `Brandfetch API error: ${response.status}`,
        };
      }

      let data: BrandfetchResponse;
      try {
        const text = Buffer.from(response.data as Buffer).toString('utf-8');
        data = JSON.parse(text) as BrandfetchResponse;
      } catch {
        logger.warn({ domain: normalizedDomain }, 'Brandfetch returned invalid JSON');
        return {
          success: false,
          domain: normalizedDomain,
          error: 'Brandfetch returned invalid JSON',
        };
      }
      const result = mapToEnrichmentResult(normalizedDomain, data);

      // Cache successful results
      cache.set(normalizedDomain, { data: result, expiresAt: Date.now() + CACHE_TTL_MS });

      logger.info(
        { domain: normalizedDomain, brandName: data.name, qualityScore: data.qualityScore },
        'Brand data fetched successfully'
      );

      if (!options.includeContext) return result;
      return withBrandContext(result);
    } catch (error) {
      const isTimeout = axios.isAxiosError(error) && (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT');
      const isRetryable = isTimeout || (axios.isAxiosError(error) && !error.response);

      if (isRetryable && attempt < BRANDFETCH_MAX_RETRIES) {
        const delay = BRANDFETCH_RETRY_DELAY_MS * Math.pow(2, attempt);
        logger.warn({ domain: normalizedDomain, attempt, delay, code: axios.isAxiosError(error) ? error.code : undefined }, 'Brandfetch request failed, retrying');
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }

      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.warn({ error: summarizeBrandfetchError(error), domain: normalizedDomain, attempt }, 'Brandfetch fetch failed after retries');
      return {
        success: false,
        domain: normalizedDomain,
        error: `Failed to fetch from Brandfetch: ${message}`,
      };
    }
  }

  // Should not reach here, but satisfy TypeScript
  return {
    success: false,
    domain: normalizedDomain,
    error: 'Brandfetch fetch exhausted retries',
  };
}

/**
 * Fetch AI-oriented brand context from Brandfetch Brand Context API.
 */
export async function fetchBrandContext(domain: string): Promise<BrandfetchContextResult> {
  if (!BRANDFETCH_API_KEY) {
    return {
      success: false,
      domain,
      error: 'BRANDFETCH_API_KEY not configured',
    };
  }

  const normalized = normalizeBrandfetchDomain(domain);
  const normalizedDomain = normalized.domain;
  if ('error' in normalized) {
    return {
      success: false,
      domain: normalizedDomain,
      error: normalized.error,
    };
  }

  const cached = contextCache.get(normalizedDomain);
  if (cached && cached.expiresAt > Date.now()) {
    logger.debug({ domain: normalizedDomain }, 'Brandfetch context cache hit');
    return { ...cached.data, cached: true };
  }

  for (let attempt = 0; attempt <= BRANDFETCH_MAX_RETRIES; attempt++) {
    try {
      logger.info({ domain: normalizedDomain, attempt }, 'Fetching brand context from Brandfetch');

      // CodeQL: BRANDFETCH_CONTEXT_API_URL is from constant config, domain is normalized
      const response = await axios.get( // lgtm[js/request-forgery]
        `${BRANDFETCH_CONTEXT_API_URL}/${normalizedDomain}`,
        {
          headers: {
            Authorization: `Bearer ${BRANDFETCH_API_KEY}`,
            Accept: 'application/json',
          },
          timeout: BRANDFETCH_TIMEOUT_MS,
          validateStatus: () => true,
          responseType: 'arraybuffer',
        }
      );

      if (response.status === 404) {
        const result: BrandfetchContextResult = {
          success: false,
          domain: normalizedDomain,
          error: 'Brand context not found in Brandfetch',
        };
        contextCache.set(normalizedDomain, { data: result, expiresAt: Date.now() + 5 * 60 * 1000 });
        return result;
      }

      const isRetryableStatus = response.status === 429 || (response.status >= 500 && response.status < 600);
      if (isRetryableStatus && attempt < BRANDFETCH_MAX_RETRIES) {
        const delay = BRANDFETCH_RETRY_DELAY_MS * Math.pow(2, attempt);
        logger.warn({ status: response.status, domain: normalizedDomain, attempt, delay }, 'Brandfetch context transient error, retrying');
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }

      if (response.status !== 200) {
        logger.warn({ status: response.status, domain: normalizedDomain }, 'Brandfetch context API non-2xx response');
        return {
          success: false,
          domain: normalizedDomain,
          error: `Brandfetch context API error: ${response.status}`,
        };
      }

      let context: BrandfetchContextResponse;
      try {
        const text = Buffer.from(response.data as Buffer).toString('utf-8');
        context = JSON.parse(text) as BrandfetchContextResponse;
      } catch {
        logger.warn({ domain: normalizedDomain }, 'Brandfetch context returned invalid JSON');
        return {
          success: false,
          domain: normalizedDomain,
          error: 'Brandfetch context returned invalid JSON',
        };
      }

      const result: BrandfetchContextResult = {
        success: true,
        domain: normalizedDomain,
        context,
      };
      contextCache.set(normalizedDomain, { data: result, expiresAt: Date.now() + CACHE_TTL_MS });
      return result;
    } catch (error) {
      const isTimeout = axios.isAxiosError(error) && (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT');
      const isRetryable = isTimeout || (axios.isAxiosError(error) && !error.response);

      if (isRetryable && attempt < BRANDFETCH_MAX_RETRIES) {
        const delay = BRANDFETCH_RETRY_DELAY_MS * Math.pow(2, attempt);
        logger.warn({ domain: normalizedDomain, attempt, delay, code: axios.isAxiosError(error) ? error.code : undefined }, 'Brandfetch context request failed, retrying');
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }

      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.warn({ error: summarizeBrandfetchError(error), domain: normalizedDomain, attempt }, 'Brandfetch context fetch failed after retries');
      return {
        success: false,
        domain: normalizedDomain,
        error: `Failed to fetch Brandfetch context: ${message}`,
      };
    }
  }

  return {
    success: false,
    domain: normalizedDomain,
    error: 'Brandfetch context fetch exhausted retries',
  };
}

async function withBrandContext(result: BrandfetchEnrichmentResult): Promise<BrandfetchEnrichmentResult> {
  const contextResult = await fetchBrandContext(result.domain);
  if (!contextResult.success || !contextResult.context) {
    return {
      ...result,
      contextError: contextResult.error,
    };
  }

  const context = contextResult.context;
  if (!result.manifest) {
    return mapContextToEnrichmentResult(result.domain, context);
  }

  return {
    ...result,
    context,
  };
}

function mapContextToEnrichmentResult(
  domain: string,
  context: BrandfetchContextResponse
): BrandfetchEnrichmentResult {
  const name = context.meta?.canonical_name || domain;

  return {
    success: true,
    domain,
    manifest: {
      name,
      url: `https://${domain}`,
    },
    highQuality: false,
    context,
  };
}

/**
 * Check if a Brandfetch response contains meaningful brand data.
 * Low-quality results (generic fallbacks, missing data) should be saved
 * as 'community' rather than 'enriched' to avoid incorrect metadata.
 */
export function isHighQualityResult(data: BrandfetchResponse): boolean {
  // NSFW brands should not be auto-enriched without review
  if (data.isNsfw) return false;

  const hasLogos = Array.isArray(data.logos) && data.logos.length > 0 &&
    data.logos.some(l => Array.isArray(l.formats) && l.formats.length > 0);

  const hasDescription = !!data.description && data.description.trim().length > 10;

  const hasAcceptableScore = data.qualityScore === undefined || data.qualityScore >= QUALITY_SCORE_THRESHOLD;

  // Must have acceptable quality AND at least one of: logos or description
  return hasAcceptableScore && (hasLogos || hasDescription);
}

/**
 * Map Brandfetch response to AdCP enrichment result
 */
function mapToEnrichmentResult(
  domain: string,
  data: BrandfetchResponse
): BrandfetchEnrichmentResult {
  // Build brand manifest
  const manifest: EnrichedBrandManifest = {
    name: data.name,
    url: `https://${domain}`,
    description: data.description,
  };

  // Map logos - prefer SVG, then PNG
  if (data.logos && data.logos.length > 0) {
    manifest.logos = data.logos
      .filter((logo) => logo.type === 'logo' || logo.type === 'symbol')
      .flatMap((logo) => {
        // Sort formats: prefer SVG, then larger PNG
        const sortedFormats = [...logo.formats].sort((a, b) => {
          if (a.format === 'svg' && b.format !== 'svg') return -1;
          if (b.format === 'svg' && a.format !== 'svg') return 1;
          return (b.size || 0) - (a.size || 0);
        });

        const bestFormat = sortedFormats[0];
        if (!bestFormat) return [];

        const tags: string[] = [logo.type];
        if (logo.theme) tags.push(logo.theme);

        return [{ url: bestFormat.src, tags }];
      });
  }

  // Map colors
  if (data.colors && data.colors.length > 0) {
    const colorMap: Record<string, string> = {};

    // Find primary brand color
    const brandColor = data.colors.find((c) => c.type === 'brand');
    if (brandColor) colorMap.primary = brandColor.hex;

    // Find accent color
    const accentColor = data.colors.find((c) => c.type === 'accent');
    if (accentColor) colorMap.accent = accentColor.hex;

    // Find secondary (or vibrant as fallback)
    const secondaryColor = data.colors.find((c) => c.type === 'vibrant' || c.type === 'dark');
    if (secondaryColor && !colorMap.secondary) colorMap.secondary = secondaryColor.hex;

    if (Object.keys(colorMap).length > 0) {
      manifest.colors = colorMap as EnrichedBrandManifest['colors'];
    }
  }

  // Map fonts
  if (data.fonts && data.fonts.length > 0) {
    manifest.fonts = data.fonts.map((font) => ({
      name: font.name,
      role: font.type,
    }));
  }

  // Build company info
  const company = data.company
    ? {
        name: data.name,
        industries: data.company.industries?.map(i => i.name),
        employees: data.company.employees,
        founded: data.company.foundedYear,
        location: data.company.location
          ? [data.company.location.city, data.company.location.country].filter(Boolean).join(', ')
          : undefined,
      }
    : undefined;

  return {
    success: true,
    domain,
    manifest,
    company,
    highQuality: isHighQualityResult(data),
    raw: data,
  };
}

/**
 * Clear the cache (for testing)
 */
export function clearCache(): void {
  cache.clear();
  contextCache.clear();
}
