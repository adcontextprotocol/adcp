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
import { registryRequestsDb } from '../../db/registry-requests-db.js';
import { fetchBrandData, isBrandfetchConfigured, ENRICHMENT_CACHE_MAX_AGE_MS } from '../../services/brandfetch.js';
import { createLogger } from '../../logger.js';

const logger = createLogger('brand-tools');
const brandManager = new BrandManager();
const brandDb = new BrandDatabase();

/**
 * Brand tool definitions for Addie
 */
export const BRAND_TOOLS: AddieTool[] = [
  {
    name: 'research_brand',
    description: 'Research a brand by domain using Brandfetch API. Returns brand info (logo, colors, company details) if found. Automatically saves enrichment data to the registry — no need to call save_brand after.',
    usage_hints: 'Use when asked to research, enrich, or look up a brand. Enrichment data is cached in the registry automatically.',
    input_schema: {
      type: 'object',
      properties: {
        domain: {
          type: 'string',
          description: 'Domain to research (e.g., "acme-corp.com", "example.com")',
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
          description: 'Domain to resolve (e.g., "acme-corp.com", "example.com")',
        },
      },
      required: ['domain'],
    },
  },
  {
    name: 'save_brand',
    description: 'Save a brand to the registry as a community brand. Use for manually adding brands (not needed after research_brand, which auto-saves). Preserves any existing enrichment data when manifest is not provided.',
    usage_hints: 'Use to add a new community brand by name/domain. Not needed after research_brand — enrichment is auto-saved.',
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
          description: 'Brand identity data (logo, colors, etc.) stored in the registry',
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
  {
    name: 'list_missing_brands',
    description: 'List the most-requested brand domains that are not yet in the registry. Shows demand signals — which brands people are looking for but we don\'t have.',
    usage_hints: 'Use when asked about gaps in the brand registry, or to find brands worth researching. Pair with research_brand to fill gaps.',
    input_schema: {
      type: 'object',
      properties: {
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
    const rawDomain = args.domain as string;
    if (!rawDomain) {
      return JSON.stringify({ error: 'domain is required' });
    }

    // Normalize domain for consistent DB lookups (strip protocol, paths, query strings)
    const domain = rawDomain.replace(/^https?:\/\//, '').replace(/[/?#].*$/, '').replace(/\/$/, '').toLowerCase();

    // Check DB for recently enriched data (avoids redundant Brandfetch API calls)
    const existing = await brandDb.getDiscoveredBrandByDomain(domain);
    if (existing?.has_brand_manifest && existing.brand_manifest && existing.last_validated) {
      const ageMs = Date.now() - new Date(existing.last_validated).getTime();
      if (ageMs < ENRICHMENT_CACHE_MAX_AGE_MS) {
        const manifest = existing.brand_manifest as Record<string, unknown>;
        const response: Record<string, unknown> = {
          success: true,
          domain: existing.domain,
          cached: true,
        };
        response.brand = {
          name: manifest.name,
          description: manifest.description,
          url: manifest.url,
        };
        if (Array.isArray(manifest.logos) && manifest.logos.length > 0) {
          response.logos = (manifest.logos as Array<{ url: string; tags: string[] }>).slice(0, 3);
        }
        if (manifest.colors) {
          response.colors = manifest.colors;
        }
        if (Array.isArray(manifest.fonts) && manifest.fonts.length > 0) {
          response.fonts = manifest.fonts;
        }
        if (manifest.company) {
          response.company = manifest.company;
        }
        return JSON.stringify(response, null, 2);
      }
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

    // Save enrichment to DB for future cache hits
    if (result.manifest) {
      brandDb.upsertDiscoveredBrand({
        domain: result.domain,
        brand_name: result.manifest.name,
        brand_manifest: {
          name: result.manifest.name,
          url: result.manifest.url,
          description: result.manifest.description,
          logos: result.manifest.logos,
          colors: result.manifest.colors,
          fonts: result.manifest.fonts,
          ...(result.company ? { company: result.company } : {}),
        },
        has_brand_manifest: true,
        source_type: 'enriched',
      }).catch((err) => { logger.warn({ err, domain }, 'Failed to cache enrichment result'); });
    }

    // Format response for Addie
    const response: Record<string, unknown> = {
      success: true,
      domain: result.domain,
      cached: false,
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

      registryRequestsDb.trackRequest('brand', domain).catch(() => { /* fire-and-forget */ });
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

    // Check if brand already exists
    const existing = await brandDb.getDiscoveredBrandByDomain(domain);

    if (existing) {
      // Existing brand: use revision-tracked edit (skip brand_json sources)
      if (existing.source_type === 'brand_json') {
        return JSON.stringify({
          error: 'Cannot edit authoritative brand (managed via brand.json)',
          domain,
        });
      }

      // Only update manifest fields when explicitly provided.
      // This prevents overwriting enrichment data from research_brand.
      const editInput: Parameters<typeof brandDb.editDiscoveredBrand>[1] = {
        brand_name: brandName,
        edit_summary: `Addie enrichment: updated brand data`,
        editor_user_id: 'system:addie',
        editor_email: 'addie@agenticadvertising.org',
        editor_name: 'Addie',
      };
      if (brandManifest !== undefined) {
        editInput.brand_manifest = brandManifest;
        editInput.has_brand_manifest = !!brandManifest;
      }

      const { brand, revision_number } = await brandDb.editDiscoveredBrand(domain, editInput);

      return JSON.stringify({
        success: true,
        message: `Brand "${brandName}" updated in registry (revision ${revision_number})`,
        domain: brand.domain,
        id: brand.id,
        revision_number,
      }, null, 2);
    }

    // New brand: upsert directly (Addie is trusted, no pending review)
    // Preserve any existing enrichment data (e.g., from research_brand cache)
    const saved = await brandDb.upsertDiscoveredBrand({
      domain,
      brand_name: brandName,
      brand_manifest: brandManifest,
      has_brand_manifest: brandManifest !== undefined ? !!brandManifest : undefined,
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

  handlers.set('list_missing_brands', async (args) => {
    const rawLimit = typeof args.limit === 'number' ? args.limit : 20;
    const limit = Math.min(Math.max(1, rawLimit), 100);

    const requests = await registryRequestsDb.listUnresolved('brand', { limit });

    if (requests.length === 0) {
      return 'No missing brand requests recorded yet.';
    }

    const result = requests.map(r => ({
      domain: r.domain,
      request_count: r.request_count,
      first_requested_at: r.first_requested_at,
      last_requested_at: r.last_requested_at,
    }));

    return JSON.stringify({ missing_brands: result, count: result.length }, null, 2);
  });

  return handlers;
}
