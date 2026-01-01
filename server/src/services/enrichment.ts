/**
 * Automatic company enrichment service
 *
 * This service handles automatic enrichment of companies using Lusha API.
 * It enriches organizations transparently in the background so users
 * don't need to manage enrichment manually.
 */

import { getPool } from '../db/client.js';
import { createLogger } from '../logger.js';
import {
  getLushaClient,
  isLushaConfigured,
  mapIndustryToCompanyType,
  mapRevenueToTier,
  formatRevenueRange,
  type LushaCompanyData,
} from './lusha.js';

const logger = createLogger('enrichment-service');

// How old enrichment data can be before we refresh it (30 days)
const ENRICHMENT_STALE_DAYS = 30;

// Maximum number of enrichments per batch to avoid rate limits
const MAX_BATCH_SIZE = 10;

export interface EnrichmentResult {
  success: boolean;
  domain: string;
  enriched?: boolean;
  cached?: boolean;
  error?: string;
  data?: {
    companyName?: string;
    employeeCount?: number;
    revenue?: number;
    revenueRange?: string;
    industry?: string;
    suggestedCompanyType?: string | null;
  };
}

/**
 * Check if enrichment data is stale and needs refresh
 */
function isEnrichmentStale(enrichmentAt: Date | null): boolean {
  if (!enrichmentAt) return true;
  const staleThreshold = new Date();
  staleThreshold.setDate(staleThreshold.getDate() - ENRICHMENT_STALE_DAYS);
  return enrichmentAt < staleThreshold;
}

/**
 * Save enrichment data to an organization
 */
async function saveEnrichmentToOrg(
  orgId: string,
  enrichmentData: LushaCompanyData
): Promise<void> {
  const pool = getPool();
  const suggestedCompanyType = mapIndustryToCompanyType(
    enrichmentData.mainIndustry,
    enrichmentData.subIndustry
  );
  const revenueRange =
    enrichmentData.revenueRange || formatRevenueRange(enrichmentData.revenue);
  const suggestedRevenueTier = mapRevenueToTier(enrichmentData.revenue);

  await pool.query(
    `UPDATE organizations SET
      enrichment_data = $1,
      enrichment_source = 'lusha',
      enrichment_at = NOW(),
      enrichment_revenue = $2,
      enrichment_revenue_range = $3,
      enrichment_employee_count = $4,
      enrichment_employee_count_range = $5,
      enrichment_industry = $6,
      enrichment_sub_industry = $7,
      enrichment_founded_year = $8,
      enrichment_country = $9,
      enrichment_city = $10,
      enrichment_linkedin_url = $11,
      enrichment_description = $12,
      company_type = COALESCE(company_type, $13),
      revenue_tier = COALESCE(revenue_tier, $14),
      updated_at = NOW()
    WHERE workos_organization_id = $15`,
    [
      JSON.stringify(enrichmentData),
      enrichmentData.revenue || null,
      revenueRange,
      enrichmentData.employeeCount || null,
      enrichmentData.employeeCountRange || null,
      enrichmentData.mainIndustry || null,
      enrichmentData.subIndustry || null,
      enrichmentData.foundedYear || null,
      enrichmentData.country || null,
      enrichmentData.city || null,
      enrichmentData.linkedinUrl || null,
      enrichmentData.description || null,
      suggestedCompanyType,
      suggestedRevenueTier,
      orgId,
    ]
  );

  logger.info(
    { orgId, companyName: enrichmentData.companyName, suggestedCompanyType, suggestedRevenueTier },
    'Saved enrichment data to organization'
  );
}

/**
 * Enrich a single organization by its domain
 * Returns immediately if already enriched (within ENRICHMENT_STALE_DAYS)
 */
export async function enrichOrganization(
  orgId: string,
  domain: string
): Promise<EnrichmentResult> {
  if (!isLushaConfigured()) {
    return {
      success: false,
      domain,
      error: 'Enrichment not configured (LUSHA_API_KEY not set)',
    };
  }

  const pool = getPool();

  // Check if already enriched and not stale
  const existingResult = await pool.query(
    `SELECT enrichment_at, enrichment_data, enrichment_industry, enrichment_revenue,
            enrichment_revenue_range, enrichment_employee_count, company_type
     FROM organizations WHERE workos_organization_id = $1`,
    [orgId]
  );

  if (existingResult.rows.length > 0) {
    const existing = existingResult.rows[0];
    if (!isEnrichmentStale(existing.enrichment_at)) {
      // Return cached data
      return {
        success: true,
        domain,
        enriched: true,
        cached: true,
        data: {
          companyName: existing.enrichment_data?.companyName,
          employeeCount: existing.enrichment_employee_count,
          revenue: existing.enrichment_revenue,
          revenueRange: existing.enrichment_revenue_range,
          industry: existing.enrichment_industry,
          suggestedCompanyType: existing.company_type,
        },
      };
    }
  }

  // Fetch fresh enrichment data
  const lusha = getLushaClient();
  if (!lusha) {
    return {
      success: false,
      domain,
      error: 'Lusha client not available',
    };
  }

  const result = await lusha.enrichCompanyByDomain(domain);

  if (!result.success || !result.data) {
    logger.debug({ domain, error: result.error }, 'Enrichment failed for domain');
    return {
      success: false,
      domain,
      error: result.error || 'No data returned',
    };
  }

  // Save to organization
  await saveEnrichmentToOrg(orgId, result.data);

  const suggestedType = mapIndustryToCompanyType(
    result.data.mainIndustry,
    result.data.subIndustry
  );

  return {
    success: true,
    domain,
    enriched: true,
    cached: false,
    data: {
      companyName: result.data.companyName,
      employeeCount: result.data.employeeCount,
      revenue: result.data.revenue,
      revenueRange: result.data.revenueRange || formatRevenueRange(result.data.revenue) || undefined,
      industry: result.data.mainIndustry,
      suggestedCompanyType: suggestedType,
    },
  };
}

/**
 * Enrich a domain without an organization (for discovery purposes)
 * Does not save to database, just returns enrichment data
 */
export async function enrichDomain(domain: string): Promise<EnrichmentResult> {
  if (!isLushaConfigured()) {
    return {
      success: false,
      domain,
      error: 'Enrichment not configured',
    };
  }

  const lusha = getLushaClient();
  if (!lusha) {
    return {
      success: false,
      domain,
      error: 'Lusha client not available',
    };
  }

  const result = await lusha.enrichCompanyByDomain(domain);

  if (!result.success || !result.data) {
    return {
      success: false,
      domain,
      error: result.error || 'No data returned',
    };
  }

  const suggestedType = mapIndustryToCompanyType(
    result.data.mainIndustry,
    result.data.subIndustry
  );

  return {
    success: true,
    domain,
    enriched: true,
    cached: false,
    data: {
      companyName: result.data.companyName,
      employeeCount: result.data.employeeCount,
      revenue: result.data.revenue,
      revenueRange: result.data.revenueRange || formatRevenueRange(result.data.revenue) || undefined,
      industry: result.data.mainIndustry,
      suggestedCompanyType: suggestedType,
    },
  };
}

/**
 * Batch enrich multiple domains (for discovery page)
 * Returns enrichment data without requiring org IDs
 */
export async function enrichDomainsInBatch(
  domains: string[]
): Promise<Map<string, EnrichmentResult>> {
  const results = new Map<string, EnrichmentResult>();

  if (!isLushaConfigured()) {
    for (const domain of domains) {
      results.set(domain, {
        success: false,
        domain,
        error: 'Enrichment not configured',
      });
    }
    return results;
  }

  // Process in batches to avoid rate limits
  const batches: string[][] = [];
  for (let i = 0; i < domains.length; i += MAX_BATCH_SIZE) {
    batches.push(domains.slice(i, i + MAX_BATCH_SIZE));
  }

  for (const batch of batches) {
    const batchPromises = batch.map((domain) => enrichDomain(domain));
    const batchResults = await Promise.all(batchPromises);

    for (let i = 0; i < batch.length; i++) {
      results.set(batch[i], batchResults[i]);
    }

    // Small delay between batches to respect rate limits
    if (batches.length > 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  return results;
}

/**
 * Enrich organizations that are missing enrichment data
 * This can be run on startup or periodically
 */
export async function enrichMissingOrganizations(): Promise<{
  total: number;
  enriched: number;
  failed: number;
  skipped: number;
}> {
  if (!isLushaConfigured()) {
    logger.debug('Enrichment not configured, skipping auto-enrichment');
    return { total: 0, enriched: 0, failed: 0, skipped: 0 };
  }

  const pool = getPool();

  // Find organizations without enrichment data that have a domain
  // Priority: those with member profiles or recent activity
  const result = await pool.query(`
    SELECT o.workos_organization_id, o.name, o.email_domain
    FROM organizations o
    LEFT JOIN member_profiles mp ON mp.workos_organization_id = o.workos_organization_id
    WHERE o.enrichment_at IS NULL
      AND o.email_domain IS NOT NULL
      AND o.email_domain != ''
    ORDER BY
      CASE WHEN mp.id IS NOT NULL THEN 0 ELSE 1 END,
      o.last_activity_at DESC NULLS LAST
    LIMIT 20
  `);

  let enriched = 0;
  let failed = 0;
  let skipped = 0;

  for (const org of result.rows) {
    try {
      const enrichResult = await enrichOrganization(
        org.workos_organization_id,
        org.email_domain
      );

      if (enrichResult.success) {
        enriched++;
      } else if (enrichResult.error === 'Company not found') {
        skipped++;
      } else {
        failed++;
      }

      // Delay between requests
      await new Promise((resolve) => setTimeout(resolve, 100));
    } catch (error) {
      logger.error(
        { err: error, orgId: org.workos_organization_id },
        'Error enriching organization'
      );
      failed++;
    }
  }

  if (enriched > 0 || failed > 0) {
    logger.info(
      { total: result.rows.length, enriched, failed, skipped },
      'Auto-enrichment batch complete'
    );
  }

  return {
    total: result.rows.length,
    enriched,
    failed,
    skipped,
  };
}

/**
 * Extract domain from an email address
 */
export function extractDomainFromEmail(email: string): string | null {
  const parts = email.split('@');
  if (parts.length !== 2) return null;
  return parts[1].toLowerCase();
}

/**
 * Try to get a domain for an organization
 * Checks email_domain field, then WorkOS domains
 */
export async function getOrganizationDomain(orgId: string): Promise<string | null> {
  const pool = getPool();

  const result = await pool.query(
    `SELECT email_domain FROM organizations WHERE workos_organization_id = $1`,
    [orgId]
  );

  if (result.rows.length > 0 && result.rows[0].email_domain) {
    return result.rows[0].email_domain;
  }

  return null;
}

/**
 * Auto-enrich an organization if it has a domain and isn't already enriched
 * This is safe to call multiple times - it checks for existing enrichment
 */
export async function autoEnrichOrganization(orgId: string): Promise<EnrichmentResult | null> {
  const domain = await getOrganizationDomain(orgId);

  if (!domain) {
    logger.debug({ orgId }, 'No domain found for organization, skipping auto-enrichment');
    return null;
  }

  return enrichOrganization(orgId, domain);
}
