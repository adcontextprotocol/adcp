/**
 * Brand registry enrichment pipeline
 *
 * Two-phase enrichment:
 * 1. Brandfetch API → visual assets, company metadata (deterministic)
 * 2. Sonnet classification → brand architecture: keller type, house, parent (LLM)
 *
 * Phase 2 is optional — if classification fails, we still save the Brandfetch data.
 */

import Anthropic from '@anthropic-ai/sdk';
import { createLogger } from '../logger.js';
import { fetchBrandData, isBrandfetchConfigured } from './brandfetch.js';
import { downloadAndCacheLogos } from './logo-cdn.js';
import { classifyBrand } from './brand-classifier.js';
import { brandDb } from '../db/brand-db.js';
import { registryRequestsDb } from '../db/registry-requests-db.js';
import { query } from '../db/client.js';
import { getPool } from '../db/client.js';
import { ModelConfig } from '../config/models.js';
import { enrichOrganization } from './enrichment.js';
import { isLushaConfigured } from './lusha.js';
import type { UpsertDiscoveredBrandInput } from '../db/brand-db.js';
import type { BrandfetchEnrichmentResult } from './brandfetch.js';
import type { BrandClassification } from './brand-classifier.js';

const logger = createLogger('brand-enrichment');

// Generic page titles that Brandfetch sometimes returns instead of brand names
const GENERIC_NAMES = new Set([
  'about', 'home', 'welcome', 'homepage', 'contact', 'products', 'services',
  'blog', 'news', 'careers', 'login', 'sign in', 'register',
]);

/**
 * Derive a readable brand name from a domain string.
 * e.g., "coca-cola.com" → "Coca Cola", "nike.com" → "Nike"
 */
function nameFromDomain(domain: string): string {
  const base = domain.split('.')[0];
  return base
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

/**
 * Check if a Brandfetch name looks legitimate.
 * Returns a clean brand name, falling back to domain-derived name.
 */
function sanitizeBrandName(name: string | undefined, domain: string): string {
  if (!name) return nameFromDomain(domain);
  const trimmed = name.trim();
  if (trimmed.length === 0) return nameFromDomain(domain);
  if (GENERIC_NAMES.has(trimmed.toLowerCase())) return nameFromDomain(domain);
  // Single character names are suspicious
  if (trimmed.length <= 1) return nameFromDomain(domain);
  return trimmed;
}

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

  // Handle regional/variant domains: if the classifier identifies a different canonical domain,
  // this is a variant (e.g., amazon.co.uk → amazon.com). Don't create a full brand entry —
  // just point to the canonical via canonical_domain and delete the variant row.
  const isVariant = classification &&
    classification.canonical_domain &&
    classification.canonical_domain.toLowerCase() !== domain.toLowerCase();

  if (isVariant) {
    // Remove the variant from discovered_brands (it's just a regional redirect)
    try {
      await brandDb.deleteDiscoveredBrand(domain);
    } catch {
      // May not exist, that's fine
    }

    logger.info(
      { domain, canonical: classification!.canonical_domain },
      'Variant domain removed (canonical is different)'
    );

    // Mark resolved pointing to canonical
    registryRequestsDb.markResolved('brand', domain, classification!.canonical_domain).catch(err => {
      logger.warn({ err, domain }, 'Failed to mark registry request as resolved');
    });

    return {
      domain,
      status: 'skipped',
      brand_name: result.manifest.name,
      classification: classification || undefined,
      error: `Variant of ${classification!.canonical_domain}`,
    };
  }

  // Sanitize brand name — Brandfetch sometimes returns garbage (e.g., "About", "Home")
  const brandName = sanitizeBrandName(result.manifest.name, domain);

  // Download logos to our CDN so external agents can access them without hotlink restrictions
  const logos = (result.manifest.logos && result.manifest.logos.length > 0)
    ? await downloadAndCacheLogos(domain, result.manifest.logos)
    : result.manifest.logos;

  // Map to discovered brand input
  const input: UpsertDiscoveredBrandInput = {
    domain,
    brand_name: brandName,
    brand_manifest: {
      name: brandName,
      url: result.manifest.url,
      description: result.manifest.description,
      logos,
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
    { domain, brandName, keller_type: classification?.keller_type },
    'Brand enriched'
  );
  return {
    domain,
    status: 'enriched',
    brand_name: brandName,
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
 * Migrate existing enriched brands that still have Brandfetch CDN logo URLs.
 * Downloads logos to our CDN and updates the manifest in the DB.
 */
export async function migrateLogosToHosted(options: {
  limit?: number;
  delayMs?: number;
} = {}): Promise<{ total: number; migrated: number; failed: number; skipped: number }> {
  const limit = Math.min(Math.max(1, options.limit || 50), 200);
  const delayMs = Math.max(0, options.delayMs ?? 500);

  const result = await query<{ domain: string; brand_manifest: Record<string, unknown> }>(
    `SELECT domain, brand_manifest FROM discovered_brands
     WHERE source_type IN ('enriched', 'community')
       AND has_brand_manifest = true
       AND EXISTS (
         SELECT 1 FROM jsonb_array_elements(brand_manifest->'logos') AS logo
         WHERE logo->>'url' LIKE '%cdn.brandfetch.io%'
       )
     ORDER BY domain
     LIMIT $1`,
    [limit]
  );

  const summary = { total: result.rows.length, migrated: 0, failed: 0, skipped: 0 };

  for (let i = 0; i < result.rows.length; i++) {
    const row = result.rows[i];
    const logos = (row.brand_manifest.logos as Array<{ url: string; tags: string[] }> | undefined);

    if (!logos || logos.length === 0) {
      summary.skipped++;
      continue;
    }

    try {
      const hosted = await downloadAndCacheLogos(row.domain, logos);
      await query(
        `UPDATE discovered_brands
         SET brand_manifest = brand_manifest || $2::jsonb
         WHERE domain = $1`,
        [row.domain, JSON.stringify({ logos: hosted })]
      );
      summary.migrated++;
      logger.info({ domain: row.domain }, 'Logos migrated to CDN');
    } catch (err) {
      logger.warn({ err, domain: row.domain }, 'Logo migration failed');
      summary.failed++;
    }

    if (delayMs > 0 && i < result.rows.length - 1) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  logger.info(summary, 'Logo migration complete');
  return summary;
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

// ========== House Expansion ==========

interface DiscoveredSubBrand {
  brand_name: string;
  domain: string;
  keller_type: 'sub_brand' | 'endorsed';
}

const DISCOVER_PROMPT = `You are listing the major consumer/product brands owned by a corporate house.

For the given company, list their well-known consumer-facing brands. Each brand must have:
- brand_name: The consumer-facing brand name (e.g., "Tide", "Gillette")
- domain: The primary consumer website domain (e.g., "tide.com", "gillette.com")
- keller_type: "sub_brand" (uses parent name, e.g., "Disney+") or "endorsed" (standalone brand backed by parent, e.g., "Tide" by P&G)

Rules:
- Only include brands with their OWN consumer-facing domain (not just a page on the parent site)
- Do NOT include the house/parent brand itself
- Do NOT include regional variants (e.g., skip amazon.co.uk if amazon.com is listed)
- Do NOT include B2B-only brands, internal divisions, or holding companies
- Focus on the top consumer brands — aim for completeness but prioritize well-known brands
- Domains must be real, active consumer websites

Respond with ONLY valid JSON (no markdown fences):
{
  "brands": [
    { "brand_name": "Tide", "domain": "tide.com", "keller_type": "sub_brand" }
  ]
}`;

/**
 * Use Sonnet to discover sub-brands for a house, then seed and enrich each one.
 */
export async function expandHouse(houseDomain: string, options: {
  delayMs?: number;
  enrichAfterSeed?: boolean;
} = {}): Promise<{
  house_domain: string;
  house_name: string;
  discovered: number;
  seeded: number;
  enriched: number;
  enriching: number;
  failed: number;
  brands: Array<{ domain: string; brand_name: string; status: string }>;
}> {
  const delayMs = options.delayMs ?? 1000;
  const enrichAfterSeed = options.enrichAfterSeed ?? true;

  // Look up the house brand
  const house = await brandDb.getDiscoveredBrandByDomain(houseDomain);
  if (!house) {
    throw new Error(`House brand not found: ${houseDomain}`);
  }
  if (house.keller_type !== 'master' && house.keller_type !== 'independent') {
    throw new Error(`${houseDomain} is not a house brand (keller_type: ${house.keller_type})`);
  }

  const houseName = house.brand_name || nameFromDomain(houseDomain);
  logger.info({ houseDomain, houseName }, 'Expanding house brand');

  // Ask Sonnet to discover sub-brands
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY not configured');
  }

  const anthropic = new Anthropic();
  const response = await anthropic.messages.create({
    model: ModelConfig.primary,
    max_tokens: 4096,
    messages: [{
      role: 'user',
      content: `${DISCOVER_PROMPT}\n\nCompany: ${houseName}\nCorporate domain: ${houseDomain}\nIndustry: ${(house.brand_manifest?.company as Record<string, unknown>)?.industry || 'unknown'}`,
    }],
  });

  const text = response.content[0].type === 'text' ? response.content[0].text : '';
  const cleaned = text.replace(/^```(?:json)?\s*\n?/m, '').replace(/\n?```\s*$/m, '').trim();

  let discovered: DiscoveredSubBrand[];
  try {
    const parsed = JSON.parse(cleaned);
    discovered = Array.isArray(parsed.brands) ? parsed.brands : [];
  } catch {
    logger.error({ houseDomain, text: cleaned.slice(0, 200) }, 'Failed to parse Sonnet response');
    throw new Error('Failed to parse brand discovery response');
  }

  logger.info({ houseDomain, count: discovered.length }, 'Discovered sub-brands');

  // Filter out already-known brands
  const existingBrands = new Set<string>();
  const existing = await query<{ domain: string }>(
    'SELECT domain FROM discovered_brands WHERE house_domain = $1',
    [houseDomain]
  );
  for (const row of existing.rows) {
    existingBrands.add(row.domain.toLowerCase());
  }

  // Phase 1: Seed all discovered brands synchronously (fast — just DB inserts)
  const results: Array<{ domain: string; brand_name: string; status: string }> = [];
  const toEnrich: string[] = [];
  let seeded = 0;
  let failed = 0;

  for (const brand of discovered) {
    const domain = brand.domain?.toLowerCase().trim();

    if (!domain || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) {
      results.push({ domain: domain || 'invalid', brand_name: brand.brand_name, status: 'invalid_domain' });
      failed++;
      continue;
    }

    if (existingBrands.has(domain)) {
      results.push({ domain, brand_name: brand.brand_name, status: 'already_known' });
      continue;
    }

    try {
      await brandDb.upsertDiscoveredBrand({
        domain,
        brand_name: brand.brand_name,
        source_type: 'enriched',
        has_brand_manifest: false,
        keller_type: brand.keller_type || 'sub_brand',
        house_domain: houseDomain,
        parent_brand: houseName,
      });
      seeded++;
      existingBrands.add(domain);
      results.push({ domain, brand_name: brand.brand_name, status: 'seeded' });
      toEnrich.push(domain);
    } catch (err) {
      logger.warn({ err, domain }, 'Failed to seed sub-brand');
      results.push({ domain, brand_name: brand.brand_name, status: 'seed_failed' });
      failed++;
    }
  }

  // Phase 2: Enrich via Brandfetch in the background (fire-and-forget)
  // This runs after the response is sent so we don't hit proxy timeouts
  if (enrichAfterSeed && isBrandfetchConfigured() && toEnrich.length > 0) {
    const enrichInBackground = async () => {
      let enriched = 0;
      let enrichFailed = 0;
      for (let i = 0; i < toEnrich.length; i++) {
        try {
          const result = await enrichBrand(toEnrich[i]);
          if (result.status === 'enriched') enriched++;
          else if (result.status === 'failed') enrichFailed++;
        } catch (err) {
          logger.warn({ err, domain: toEnrich[i] }, 'Background enrichment failed');
          enrichFailed++;
        }
        if (delayMs > 0 && i < toEnrich.length - 1) {
          await new Promise(resolve => setTimeout(resolve, delayMs));
        }
      }
      logger.info(
        { houseDomain, total: toEnrich.length, enriched, failed: enrichFailed },
        'Background enrichment complete'
      );
    };
    // Fire and forget — don't await
    enrichInBackground().catch(err => {
      logger.error({ err, houseDomain }, 'Background enrichment crashed');
    });
  }

  logger.info(
    { houseDomain, discovered: discovered.length, seeded, failed, enriching: toEnrich.length },
    'House expansion seeded (enrichment running in background)'
  );

  return {
    house_domain: houseDomain,
    house_name: houseName,
    discovered: discovered.length,
    seeded,
    enriched: 0, // enrichment happens in background
    failed,
    enriching: toEnrich.length,
    brands: results,
  };
}

// ========== Domain Research (Unified Enrichment) ==========

// Concurrency guard: prevent duplicate API calls for the same domain
const researchInProgress = new Set<string>();

// Rate limiter: track enrichments in the last hour
const recentResearchTimestamps: number[] = [];
const HOURLY_RESEARCH_LIMIT = 50;

function isRateLimited(): boolean {
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  // Prune old entries
  while (recentResearchTimestamps.length > 0 && recentResearchTimestamps[0] < oneHourAgo) {
    recentResearchTimestamps.shift();
  }
  return recentResearchTimestamps.length >= HOURLY_RESEARCH_LIMIT;
}

export interface DomainResearchOptions {
  skip_brandfetch?: boolean;
  skip_classification?: boolean;
  skip_lusha?: boolean;
  org_id?: string;
}

export interface DomainResearchAction {
  source: 'brandfetch' | 'sonnet' | 'lusha' | 'db';
  action: 'fetched' | 'skipped_fresh' | 'skipped_config' | 'skipped_in_progress' | 'skipped_rate_limit' | 'failed' | 'not_found';
  detail?: string;
}

export interface DomainResearchResult {
  domain: string;
  brand?: {
    brand_name: string;
    keller_type?: string;
    house_domain?: string;
    parent_brand?: string;
    source_type: string;
    classification_confidence?: string;
  };
  firmographics?: {
    company_name?: string;
    employee_count?: number;
    revenue_range?: string;
    industry?: string;
    country?: string;
  };
  org?: {
    workos_organization_id: string;
    name: string;
    subscription_status: string | null;
  };
  actions: DomainResearchAction[];
}

/**
 * Progressive domain research: checks what's known, fills gaps from external APIs.
 *
 * 1. Check discovered_brands — skip Brandfetch+Sonnet if enriched & fresh (< 30 days)
 * 2. Check organizations — skip Lusha if org has fresh enrichment data
 * 3. Call enrichBrand() for brand data gaps (Brandfetch + Sonnet classification)
 * 4. Call enrichOrganization() for firmographic gaps (Lusha)
 * 5. Return unified result with actions log
 */
export async function researchDomain(
  domain: string,
  options: DomainResearchOptions = {}
): Promise<DomainResearchResult> {
  const normalizedDomain = domain.toLowerCase().trim();
  const actions: DomainResearchAction[] = [];

  // Concurrency guard
  if (researchInProgress.has(normalizedDomain)) {
    return {
      domain: normalizedDomain,
      actions: [{ source: 'brandfetch', action: 'skipped_in_progress', detail: 'Research already in progress for this domain' }],
    };
  }

  researchInProgress.add(normalizedDomain);
  try {
    const pool = getPool();
    const FRESHNESS_DAYS = 30;
    const freshThreshold = new Date();
    freshThreshold.setDate(freshThreshold.getDate() - FRESHNESS_DAYS);

    // Step 1: Check existing brand data
    const existingBrand = await brandDb.getDiscoveredBrandByDomain(normalizedDomain);
    const brandIsFresh = existingBrand?.source_type === 'enriched'
      && existingBrand.has_brand_manifest
      && existingBrand.last_validated
      && new Date(existingBrand.last_validated) > freshThreshold;

    // Step 2: Check existing org + Lusha data
    const orgResult = await pool.query(
      `SELECT workos_organization_id, name, subscription_status, enrichment_at
       FROM organizations WHERE email_domain = $1 LIMIT 1`,
      [normalizedDomain]
    );
    const org = orgResult.rows[0] || null;
    const orgId = options.org_id || org?.workos_organization_id || null;
    const lushaIsFresh = org?.enrichment_at && new Date(org.enrichment_at) > freshThreshold;

    // Step 3: Enrich brand if needed
    if (brandIsFresh) {
      actions.push({ source: 'brandfetch', action: 'skipped_fresh', detail: `Last validated ${existingBrand!.last_validated}` });
    } else if (options.skip_brandfetch) {
      actions.push({ source: 'brandfetch', action: 'skipped_config' });
    } else if (existingBrand?.source_type === 'brand_json') {
      actions.push({ source: 'brandfetch', action: 'skipped_fresh', detail: 'Authoritative brand (brand.json)' });
    } else if (isRateLimited()) {
      actions.push({ source: 'brandfetch', action: 'skipped_rate_limit', detail: `>${HOURLY_RESEARCH_LIMIT} enrichments in the last hour` });
    } else if (!isBrandfetchConfigured()) {
      actions.push({ source: 'brandfetch', action: 'skipped_config', detail: 'BRANDFETCH_API_KEY not set' });
    } else {
      recentResearchTimestamps.push(Date.now());
      const brandResult = await enrichBrand(normalizedDomain);
      if (brandResult.status === 'enriched') {
        actions.push({ source: 'brandfetch', action: 'fetched', detail: brandResult.brand_name });
        if (brandResult.classification) {
          actions.push({ source: 'sonnet', action: 'fetched', detail: `${brandResult.classification.keller_type} (${brandResult.classification.confidence})` });
        }
      } else if (brandResult.status === 'not_found') {
        actions.push({ source: 'brandfetch', action: 'not_found', detail: brandResult.error });
      } else if (brandResult.status === 'failed') {
        actions.push({ source: 'brandfetch', action: 'failed', detail: brandResult.error });
      } else {
        actions.push({ source: 'brandfetch', action: 'skipped_fresh', detail: brandResult.error });
      }
    }

    // Step 4: Enrich firmographics if needed
    if (lushaIsFresh) {
      actions.push({ source: 'lusha', action: 'skipped_fresh', detail: `Enriched ${org.enrichment_at}` });
    } else if (options.skip_lusha) {
      actions.push({ source: 'lusha', action: 'skipped_config' });
    } else if (!orgId) {
      actions.push({ source: 'lusha', action: 'skipped_config', detail: 'No organization found for domain' });
    } else if (isRateLimited()) {
      actions.push({ source: 'lusha', action: 'skipped_rate_limit' });
    } else if (!isLushaConfigured()) {
      actions.push({ source: 'lusha', action: 'skipped_config', detail: 'LUSHA_API_KEY not set' });
    } else {
      const lushaResult = await enrichOrganization(orgId, normalizedDomain);
      if (lushaResult.success && lushaResult.enriched) {
        actions.push({ source: 'lusha', action: lushaResult.cached ? 'skipped_fresh' : 'fetched', detail: lushaResult.data?.companyName });
      } else {
        actions.push({ source: 'lusha', action: 'failed', detail: lushaResult.error });
      }
    }

    // Assemble result from current DB state (may have just been updated)
    const finalBrand = await brandDb.getDiscoveredBrandByDomain(normalizedDomain);
    const finalOrg = orgId ? (await pool.query(
      `SELECT workos_organization_id, name, subscription_status,
              enrichment_industry, enrichment_employee_count,
              enrichment_revenue_range, enrichment_country,
              enrichment_data
       FROM organizations WHERE workos_organization_id = $1`,
      [orgId]
    )).rows[0] : null;

    const result: DomainResearchResult = {
      domain: normalizedDomain,
      actions,
    };

    if (finalBrand) {
      const classification = finalBrand.brand_manifest?.classification as
        { confidence?: string } | undefined;
      result.brand = {
        brand_name: finalBrand.brand_name || normalizedDomain,
        keller_type: finalBrand.keller_type || undefined,
        house_domain: finalBrand.house_domain || undefined,
        parent_brand: finalBrand.parent_brand || undefined,
        source_type: finalBrand.source_type,
        classification_confidence: classification?.confidence,
      };
    }

    if (finalOrg) {
      result.org = {
        workos_organization_id: finalOrg.workos_organization_id,
        name: finalOrg.name,
        subscription_status: finalOrg.subscription_status,
      };
      if (finalOrg.enrichment_industry || finalOrg.enrichment_employee_count) {
        result.firmographics = {
          company_name: finalOrg.enrichment_data?.companyName,
          employee_count: finalOrg.enrichment_employee_count || undefined,
          revenue_range: finalOrg.enrichment_revenue_range || undefined,
          industry: finalOrg.enrichment_industry || undefined,
          country: finalOrg.enrichment_country || undefined,
        };
      }
    }

    logger.info(
      { domain: normalizedDomain, actions: actions.map(a => `${a.source}:${a.action}`) },
      'Domain research complete'
    );

    return result;
  } finally {
    researchInProgress.delete(normalizedDomain);
  }
}
