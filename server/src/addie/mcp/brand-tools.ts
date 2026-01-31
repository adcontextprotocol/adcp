/**
 * Brand Tools for Addie
 *
 * Provides brand research and registry management capabilities.
 * Allows Addie to research brands using Brandfetch, resolve brand identities,
 * and save enriched brand data to the registry.
 */

import type { AddieTool } from '../types.js';
import { BrandManager } from '../../brand-manager.js';
import { BrandDatabase } from '../../db/brand-db.js';
import { fetchBrandData, isBrandfetchConfigured } from '../../services/brandfetch.js';

const brandManager = new BrandManager();
const brandDb = new BrandDatabase();

/**
 * Brand tool definitions for Addie
 */
export const BRAND_TOOLS: AddieTool[] = [
  {
    name: 'research_brand',
    description: 'Research a brand by domain using Brandfetch API. Returns brand info (logo, colors, company details) if found. Use this when a user asks to look up or research a brand.',
    usage_hints: 'Use when asked to research a brand, look up brand info, or find brand assets. This tool fetches data from Brandfetch API.',
    input_schema: {
      type: 'object',
      properties: {
        domain: {
          type: 'string',
          description: 'Domain to research (e.g., "nike.com", "coca-cola.com")',
        },
      },
      required: ['domain'],
    },
  },
  {
    name: 'resolve_brand',
    description: 'Resolve a domain to its canonical brand identity by checking for brand.json at /.well-known/brand.json. Returns the authoritative brand info if found.',
    usage_hints: 'Use when asked to check if a domain has a published brand.json or to resolve a brand identity.',
    input_schema: {
      type: 'object',
      properties: {
        domain: {
          type: 'string',
          description: 'Domain to resolve (e.g., "jumpman23.com", "nike.com")',
        },
      },
      required: ['domain'],
    },
  },
  {
    name: 'save_brand',
    description: 'Save researched brand data to the registry as an enriched/community brand. Use after researching a brand when the user wants to save the results.',
    usage_hints: 'Use after research_brand when the user confirms they want to save the brand to the registry.',
    input_schema: {
      type: 'object',
      properties: {
        domain: {
          type: 'string',
          description: 'Domain for the brand',
        },
        brand_name: {
          type: 'string',
          description: 'Brand name',
        },
        brand_manifest: {
          type: 'object',
          description: 'Brand manifest data (logo, colors, etc.)',
        },
        source_type: {
          type: 'string',
          enum: ['community', 'enriched'],
          description: 'Source type - "enriched" for Brandfetch data, "community" for manually contributed',
        },
      },
      required: ['domain', 'brand_name'],
    },
  },
  {
    name: 'list_brands',
    description: 'List brands in the registry with optional filters. Can filter by source type and search by name or domain.',
    usage_hints: 'Use when asked about brands in the registry, or to find brands by name.',
    input_schema: {
      type: 'object',
      properties: {
        source_type: {
          type: 'string',
          enum: ['brand_json', 'hosted', 'community', 'enriched'],
          description: 'Filter by source type',
        },
        search: {
          type: 'string',
          description: 'Search term for brand name or domain',
        },
        limit: {
          type: 'number',
          description: 'Maximum results (default: 20)',
        },
      },
    },
  },
];

/**
 * Create handlers for brand tools
 */
export function createBrandToolHandlers(): Map<string, (args: Record<string, unknown>) => Promise<string>> {
  const handlers = new Map<string, (args: Record<string, unknown>) => Promise<string>>();

  handlers.set('research_brand', async (args) => {
    const domain = args.domain as string;
    if (!domain) {
      return JSON.stringify({ error: 'domain is required' });
    }

    if (!isBrandfetchConfigured()) {
      return JSON.stringify({
        error: 'Brandfetch API is not configured',
        hint: 'BRANDFETCH_API_KEY environment variable must be set',
      });
    }

    const result = await fetchBrandData(domain);

    if (!result.success) {
      return JSON.stringify({
        error: result.error || 'Brand not found',
        domain,
      });
    }

    // Format response for Addie
    const response: Record<string, unknown> = {
      success: true,
      domain: result.domain,
      cached: result.cached,
    };

    if (result.manifest) {
      response.brand = {
        name: result.manifest.name,
        description: result.manifest.description,
        url: result.manifest.url,
      };

      if (result.manifest.logos && result.manifest.logos.length > 0) {
        response.logos = result.manifest.logos.slice(0, 3).map(l => ({
          url: l.url,
          tags: l.tags,
        }));
      }

      if (result.manifest.colors) {
        response.colors = result.manifest.colors;
      }

      if (result.manifest.fonts && result.manifest.fonts.length > 0) {
        response.fonts = result.manifest.fonts;
      }
    }

    if (result.company) {
      response.company = result.company;
    }

    return JSON.stringify(response, null, 2);
  });

  handlers.set('resolve_brand', async (args) => {
    const domain = args.domain as string;
    if (!domain) {
      return JSON.stringify({ error: 'domain is required' });
    }

    const resolved = await brandManager.resolveBrand(domain);

    if (!resolved) {
      // Check discovered brands as fallback
      const discovered = await brandDb.getDiscoveredBrandByDomain(domain);
      if (discovered) {
        return JSON.stringify({
          source: 'registry',
          source_type: discovered.source_type,
          domain: discovered.domain,
          canonical_domain: discovered.canonical_domain,
          brand_name: discovered.brand_name,
          has_manifest: discovered.has_brand_manifest,
        }, null, 2);
      }

      return JSON.stringify({
        error: 'Brand not found',
        domain,
        hint: 'No brand.json found at /.well-known/brand.json and not in registry. Use research_brand to fetch from Brandfetch.',
      });
    }

    return JSON.stringify({
      source: resolved.source,
      canonical_id: resolved.canonical_id,
      canonical_domain: resolved.canonical_domain,
      brand_name: resolved.brand_name,
      house_domain: resolved.house_domain,
      house_name: resolved.house_name,
      keller_type: resolved.keller_type,
      brand_agent_url: resolved.brand_agent_url,
      has_manifest: !!resolved.brand_manifest,
    }, null, 2);
  });

  handlers.set('save_brand', async (args) => {
    const domain = args.domain as string;
    const brandName = args.brand_name as string;
    const brandManifest = args.brand_manifest as Record<string, unknown> | undefined;
    const sourceType = (args.source_type as string) || 'enriched';

    if (!domain) {
      return JSON.stringify({ error: 'domain is required' });
    }
    if (!brandName) {
      return JSON.stringify({ error: 'brand_name is required' });
    }

    const saved = await brandDb.upsertDiscoveredBrand({
      domain,
      brand_name: brandName,
      brand_manifest: brandManifest,
      has_brand_manifest: !!brandManifest,
      source_type: sourceType as 'community' | 'enriched',
    });

    return JSON.stringify({
      success: true,
      message: `Brand "${brandName}" saved to registry`,
      domain: saved.domain,
      id: saved.id,
    }, null, 2);
  });

  handlers.set('list_brands', async (args) => {
    const sourceType = args.source_type as 'brand_json' | 'hosted' | 'community' | 'enriched' | undefined;
    const search = args.search as string | undefined;
    const rawLimit = typeof args.limit === 'number' ? args.limit : 20;
    const limit = Math.min(Math.max(1, rawLimit), 100);

    const brands = await brandDb.getAllBrandsForRegistry({
      search,
      limit,
    });

    // Filter by source type if specified
    let filtered = brands;
    if (sourceType) {
      filtered = brands.filter(b => b.source === sourceType);
    }

    if (filtered.length === 0) {
      return sourceType
        ? `No ${sourceType} brands found.`
        : 'No brands found in the registry.';
    }

    const result = filtered.map(b => ({
      domain: b.domain,
      brand_name: b.brand_name,
      source: b.source,
      has_manifest: b.has_manifest,
      house_domain: b.house_domain,
      keller_type: b.keller_type,
    }));

    return JSON.stringify({ brands: result, count: result.length }, null, 2);
  });

  return handlers;
}
