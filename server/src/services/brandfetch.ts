/**
 * Brandfetch API integration for brand enrichment
 *
 * When a domain doesn't have a brand.json file, we can use Brandfetch
 * to get brand data (logos, colors, company info) as a fallback.
 *
 * API Docs: https://docs.brandfetch.com/brand-api/overview
 */

import axios from 'axios';
import { createLogger } from '../logger.js';

const logger = createLogger('brandfetch');

const BRANDFETCH_API_KEY = process.env.BRANDFETCH_API_KEY;
const BRANDFETCH_API_URL = 'https://api.brandfetch.io/v2/brands';

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
    industry?: string;
    employees?: string;
    founded?: number;
    location?: string;
  };
  raw?: BrandfetchResponse;
  error?: string;
  cached?: boolean;
}

// Simple in-memory cache with short TTL (rate-limit protection only)
// Enriched data should be saved to discovered_brands table for persistence
const cache = new Map<string, { data: BrandfetchEnrichmentResult; expiresAt: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes (rate-limit protection)

// DB-level cache: callers should check discovered_brands.last_validated before hitting the API
export const ENRICHMENT_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Check if Brandfetch is configured
 */
export function isBrandfetchConfigured(): boolean {
  return !!BRANDFETCH_API_KEY;
}

/**
 * Fetch brand data from Brandfetch API
 */
export async function fetchBrandData(domain: string): Promise<BrandfetchEnrichmentResult> {
  if (!BRANDFETCH_API_KEY) {
    return {
      success: false,
      domain,
      error: 'BRANDFETCH_API_KEY not configured',
    };
  }

  // Normalize domain
  const normalizedDomain = domain.replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase();

  // Check cache
  const cached = cache.get(normalizedDomain);
  if (cached && cached.expiresAt > Date.now()) {
    logger.debug({ domain: normalizedDomain }, 'Brandfetch cache hit');
    return { ...cached.data, cached: true };
  }

  try {
    logger.info({ domain: normalizedDomain }, 'Fetching brand data from Brandfetch');

    const response = await axios.get(
      `${BRANDFETCH_API_URL}/domain/${normalizedDomain}`,
      {
        headers: {
          Authorization: `Bearer ${BRANDFETCH_API_KEY}`,
          Accept: 'application/json',
        },
        timeout: 10000,
        validateStatus: () => true,
        responseType: 'arraybuffer',
      }
    );

    if (response.status === 404) {
      const result: BrandfetchEnrichmentResult = {
        success: false,
        domain: normalizedDomain,
        error: 'Brand not found in Brandfetch',
      };
      // Cache negative results for shorter time
      cache.set(normalizedDomain, { data: result, expiresAt: Date.now() + 5 * 60 * 1000 }); // 5 minutes
      return result;
    }

    if (response.status !== 200) {
      logger.error({ status: response.status, domain: normalizedDomain }, 'Brandfetch API error');
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
      logger.error({ domain: normalizedDomain }, 'Brandfetch returned invalid JSON');
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

    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error({ error, domain: normalizedDomain }, 'Brandfetch fetch error');
    return {
      success: false,
      domain: normalizedDomain,
      error: `Failed to fetch from Brandfetch: ${message}`,
    };
  }
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
        industry: data.company.industries?.[0]?.name,
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
    raw: data,
  };
}

/**
 * Clear the cache (for testing)
 */
export function clearCache(): void {
  cache.clear();
}
