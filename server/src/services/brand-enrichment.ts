/**
 * Brand registry enrichment pipeline
 *
 * Two-phase enrichment:
 * 1. Brandfetch API → visual assets, company metadata (deterministic)
 * 2. Sonnet classification → brand architecture: keller type, house, parent (LLM)
 *
 * Phase 2 is optional — if classification fails, we still save the Brandfetch data.
 */

import { createLogger } from '../logger.js';
import { fetchBrandData, isBrandfetchConfigured } from './brandfetch.js';
import { classifyBrand } from './brand-classifier.js';
import { brandDb } from '../db/brand-db.js';
import { registryRequestsDb } from '../db/registry-requests-db.js';
import { query } from '../db/client.js';
import type { UpsertDiscoveredBrandInput } from '../db/brand-db.js';
import type { BrandfetchEnrichmentResult } from './brandfetch.js';
import type { BrandClassification } from './brand-classifier.js';

const logger = createLogger('brand-enrichment');

export interface BrandEnrichmentResult {
  domain: string;
  status: 'enriched' | 'skipped' | 'failed' | 'not_found';
  brand_name?: string;
  classification?: BrandClassification;
  error?: string;
}

export interface BulkEnrichmentResult {
  total: number;
  enriched: number;
  failed: number;
  skipped: number;
  not_found: number;
  results: BrandEnrichmentResult[];
}

export interface EnrichmentCandidate {
  domain: string;
  brand_name: string | null;
  source: 'community' | 'request';
  request_count?: number;
}

export interface BrandEnrichmentStats {
  total_brands: number;
  enriched: number;
  community_no_manifest: number;
  brand_json: number;
  unresolved_requests: number;
}

/**
 * Enrich a single brand domain via Brandfetch.
 * Skips authoritative (brand_json) and already-enriched brands.
 */
export async function enrichBrand(domain: string): Promise<BrandEnrichmentResult> {
  if (!domain || domain.length > 253 || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) {
    return { domain, status: 'failed', error: 'Invalid domain format' };
  }

  if (!isBrandfetchConfigured()) {
    return { domain, status: 'failed', error: 'BRANDFETCH_API_KEY not configured' };
  }

  // Check existing brand
  const existing = await brandDb.getDiscoveredBrandByDomain(domain);
  if (existing?.source_type === 'brand_json') {
    return { domain, status: 'skipped', error: 'Authoritative brand (managed via brand.json)' };
  }
  if (existing?.source_type === 'enriched' && existing.has_brand_manifest) {
    return { domain, status: 'skipped', brand_name: existing.brand_name, error: 'Already enriched' };
  }

  // Fetch from Brandfetch
  let result: BrandfetchEnrichmentResult;
  try {
    result = await fetchBrandData(domain);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    logger.error({ err, domain }, 'Brandfetch API error');
    return { domain, status: 'failed', error: message };
  }

  if (!result.success || !result.manifest) {
    return { domain, status: 'not_found', error: result.error || 'Brand not found in Brandfetch' };
  }

  // Phase 2: Classify brand architecture (optional — enrichment succeeds without it)
  const classification = await classifyBrand(domain, result);

  // Map to discovered brand input
  const input: UpsertDiscoveredBrandInput = {
    domain,
    brand_name: result.manifest.name,
    brand_manifest: {
      name: result.manifest.name,
      url: result.manifest.url,
      description: result.manifest.description,
      logos: result.manifest.logos,
      colors: result.manifest.colors,
      fonts: result.manifest.fonts,
      ...(result.company ? { company: result.company } : {}),
      ...(classification ? {
        classification: {
          confidence: classification.confidence,
          reasoning: classification.reasoning,
          related_domains: classification.related_domains,
        },
      } : {}),
    },
    has_brand_manifest: true,
    source_type: 'enriched',
    // Apply classification fields if available
    ...(classification ? {
      keller_type: classification.keller_type,
      house_domain: classification.house_domain || undefined,
      parent_brand: classification.parent_brand || undefined,
      canonical_domain: classification.canonical_domain,
    } : {}),
  };

  try {
    await brandDb.upsertDiscoveredBrand(input);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    logger.error({ err, domain }, 'Failed to save enriched brand');
    return { domain, status: 'failed', error: `DB save failed: ${message}` };
  }

  // Mark resolved in registry_requests (fire-and-forget)
  registryRequestsDb.markResolved('brand', domain, domain).catch(err => {
    logger.warn({ err, domain }, 'Failed to mark registry request as resolved');
  });

  logger.info(
    { domain, brandName: result.manifest.name, keller_type: classification?.keller_type },
    'Brand enriched'
  );
  return {
    domain,
    status: 'enriched',
    brand_name: result.manifest.name,
    classification: classification || undefined,
  };
}

/**
 * Enrich brands in bulk with rate limiting.
 */
export async function enrichBrands(options: {
  source?: 'community' | 'requests' | 'all';
  limit?: number;
  delayMs?: number;
} = {}): Promise<BulkEnrichmentResult> {
  const source = options.source || 'all';
  const limit = Math.min(Math.max(1, options.limit || 25), 50);
  const delayMs = Math.max(0, options.delayMs ?? 1000);

  const candidates = await getEnrichmentCandidates({ source, limit });

  const summary: BulkEnrichmentResult = {
    total: candidates.length,
    enriched: 0,
    failed: 0,
    skipped: 0,
    not_found: 0,
    results: [],
  };

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    const result = await enrichBrand(candidate.domain);
    summary.results.push(result);
    switch (result.status) {
      case 'enriched': summary.enriched++; break;
      case 'skipped': summary.skipped++; break;
      case 'not_found': summary.not_found++; break;
      case 'failed': summary.failed++; break;
    }

    // Rate limit between API calls (skip delay after last item)
    if (delayMs > 0 && i < candidates.length - 1 && result.status !== 'skipped') {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  logger.info(
    { source, limit, ...summary, results: undefined },
    'Bulk brand enrichment complete'
  );

  return summary;
}

/**
 * List brands eligible for enrichment.
 */
export async function getEnrichmentCandidates(options: {
  source?: 'community' | 'requests' | 'all';
  limit?: number;
} = {}): Promise<EnrichmentCandidate[]> {
  const source = options.source || 'all';
  const limit = Math.min(Math.max(1, options.limit || 25), 100);
  const candidates: EnrichmentCandidate[] = [];

  // Community brands without manifests
  if (source === 'community' || source === 'all') {
    const communityResult = await query<{ domain: string; brand_name: string | null }>(
      `SELECT domain, brand_name FROM discovered_brands
       WHERE source_type = 'community' AND has_brand_manifest = false
       ORDER BY brand_name, domain
       LIMIT $1`,
      [limit]
    );
    for (const row of communityResult.rows) {
      candidates.push({ domain: row.domain, brand_name: row.brand_name, source: 'community' });
    }
  }

  // Unresolved registry requests (brands people searched for but don't exist)
  if (source === 'requests' || source === 'all') {
    const remaining = limit - candidates.length;
    if (remaining > 0) {
      const requests = await registryRequestsDb.listUnresolved('brand', { limit: remaining });
      const existingDomains = new Set(candidates.map(c => c.domain));
      for (const req of requests) {
        if (!existingDomains.has(req.domain)) {
          candidates.push({
            domain: req.domain,
            brand_name: null,
            source: 'request',
            request_count: req.request_count,
          });
        }
      }
    }
  }

  return candidates.slice(0, limit);
}

/**
 * Get enrichment stats for the brand registry.
 */
export async function getBrandEnrichmentStats(): Promise<BrandEnrichmentStats> {
  const [totalResult, enrichedResult, communityResult, brandJsonResult, requestsResult] =
    await Promise.all([
      query<{ count: string }>('SELECT COUNT(*) as count FROM discovered_brands'),
      query<{ count: string }>(
        `SELECT COUNT(*) as count FROM discovered_brands
         WHERE source_type = 'enriched' AND has_brand_manifest = true`
      ),
      query<{ count: string }>(
        `SELECT COUNT(*) as count FROM discovered_brands
         WHERE source_type = 'community' AND has_brand_manifest = false`
      ),
      query<{ count: string }>(
        `SELECT COUNT(*) as count FROM discovered_brands WHERE source_type = 'brand_json'`
      ),
      query<{ count: string }>(
        `SELECT COUNT(*) as count FROM registry_requests
         WHERE entity_type = 'brand' AND resolved_at IS NULL`
      ),
    ]);

  return {
    total_brands: parseInt(totalResult.rows[0].count, 10),
    enriched: parseInt(enrichedResult.rows[0].count, 10),
    community_no_manifest: parseInt(communityResult.rows[0].count, 10),
    brand_json: parseInt(brandJsonResult.rows[0].count, 10),
    unresolved_requests: parseInt(requestsResult.rows[0].count, 10),
  };
}
