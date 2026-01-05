/**
 * Lusha API client for company enrichment
 * https://docs.lusha.com/apis/openapi/company-enrichment
 */

import { logger } from '../logger.js';
import type { CompanyTypeValue } from '../config/company-types.js';

const LUSHA_API_BASE = 'https://api.lusha.com';

export interface LushaCompanyData {
  companyId: string;
  companyName: string;
  domain: string;
  description?: string;
  employeeCount?: number;
  employeeCountRange?: string;
  revenue?: number;
  revenueRange?: string;
  mainIndustry?: string;
  subIndustry?: string;
  foundedYear?: number;
  country?: string;
  countryIso2?: string;
  city?: string;
  state?: string;
  fullAddress?: string;
  continent?: string;
  linkedinUrl?: string;
  specialties?: string[];
  sicsCode?: string;
  sicsDescription?: string;
  naicsCode?: string;
  naicsDescription?: string;
}

export interface CompanyEnrichmentResult {
  success: boolean;
  data?: LushaCompanyData;
  error?: string;
  creditsUsed?: number;
}

/**
 * Company search filters for prospecting
 * https://docs.lusha.com/apis/openapi/company-filters
 */
export interface CompanySearchFilters {
  industryIds?: number[];           // Industry IDs from /prospecting/filters/companies/industries_labels
  minEmployees?: number;            // Minimum employee count
  maxEmployees?: number;            // Maximum employee count
  companySizeIds?: string[];        // Size IDs from /prospecting/filters/companies/sizes
  revenueIds?: string[];            // Revenue range IDs from /prospecting/filters/companies/revenues
  countries?: string[];             // Country codes (e.g., ['US', 'UK'])
  states?: string[];                // State/region names
  cities?: string[];                // City names
  keywords?: string[];              // Keywords to search in company data
}

export interface CompanySearchResult {
  success: boolean;
  companies: LushaCompanyData[];
  total: number;
  page: number;
  pageSize: number;
  error?: string;
}

export interface FilterOption {
  id: string | number;
  label: string;
  count?: number;
}

/**
 * Maps Lusha industry to our company_type enum
 * Returns the primary type - for multi-type detection, use mapIndustryToCompanyTypes
 */
export function mapIndustryToCompanyType(
  industry: string | undefined,
  subIndustry: string | undefined
): CompanyTypeValue | null {
  const types = mapIndustryToCompanyTypes(industry, subIndustry);
  return types.length > 0 ? types[0] : null;
}

/**
 * Maps Lusha industry to array of company_type values
 * Companies can have multiple types (e.g., Microsoft is both brand and ai)
 */
export function mapIndustryToCompanyTypes(
  industry: string | undefined,
  subIndustry: string | undefined
): CompanyTypeValue[] {
  if (!industry) return [];

  const ind = industry.toLowerCase();
  const sub = (subIndustry || '').toLowerCase();
  const types: CompanyTypeValue[] = [];

  // AI & Tech Platforms indicators (check first - these are often also other things)
  if (
    ind.includes('artificial intelligence') ||
    ind.includes('machine learning') ||
    sub.includes('ai') ||
    sub.includes('llm') ||
    sub.includes('generative') ||
    sub.includes('cloud computing') ||
    sub.includes('cloud infrastructure') ||
    sub.includes('cloud services') ||
    sub.includes('agent') ||
    sub.includes('ml platform')
  ) {
    types.push('ai');
  }

  // Data & Measurement indicators
  if (
    sub.includes('clean room') ||
    sub.includes('cdp') ||
    sub.includes('customer data') ||
    sub.includes('identity') ||
    sub.includes('measurement') ||
    sub.includes('analytics') ||
    sub.includes('attribution') ||
    ind.includes('data analytics') ||
    ind.includes('business intelligence')
  ) {
    types.push('data');
  }

  // Ad Tech indicators
  if (
    ind.includes('advertising') ||
    ind.includes('marketing') ||
    sub.includes('ad tech') ||
    sub.includes('adtech') ||
    sub.includes('programmatic') ||
    sub.includes('demand side') ||
    sub.includes('supply side') ||
    sub.includes('dsp') ||
    sub.includes('ssp') ||
    sub.includes('ad server')
  ) {
    // Distinguish between ad tech vendors and agencies
    if (sub.includes('agency') || sub.includes('services')) {
      types.push('agency');
    } else {
      types.push('adtech');
    }
  }

  // Agency indicators
  if (
    ind.includes('agency') ||
    sub.includes('agency') ||
    sub.includes('media buying') ||
    sub.includes('creative services') ||
    ind.includes('public relations')
  ) {
    if (!types.includes('agency')) {
      types.push('agency');
    }
  }

  // Publisher indicators
  if (
    ind.includes('media') ||
    ind.includes('publishing') ||
    ind.includes('broadcasting') ||
    ind.includes('entertainment') ||
    ind.includes('news') ||
    sub.includes('publisher') ||
    sub.includes('content') ||
    sub.includes('streaming')
  ) {
    types.push('publisher');
  }

  // Brand indicators (consumer-facing companies)
  if (
    ind.includes('retail') ||
    ind.includes('consumer') ||
    ind.includes('food') ||
    ind.includes('beverage') ||
    ind.includes('apparel') ||
    ind.includes('automotive') ||
    ind.includes('financial services') ||
    ind.includes('insurance') ||
    ind.includes('telecommunications') ||
    ind.includes('travel') ||
    ind.includes('hospitality')
  ) {
    types.push('brand');
  }

  // If nothing matched but it's a software/tech company, default to adtech
  // (unless we already identified it as ai)
  if (types.length === 0 && (ind.includes('software') || ind.includes('technology'))) {
    types.push('adtech');
  }

  // Deduplicate in case multiple conditions matched the same type
  return [...new Set(types)];
}

/**
 * Estimates revenue range string from numeric value
 */
export function formatRevenueRange(revenue: number | undefined): string | null {
  if (!revenue) return null;

  if (revenue < 1_000_000) return 'Under $1M';
  if (revenue < 10_000_000) return '$1M - $10M';
  if (revenue < 50_000_000) return '$10M - $50M';
  if (revenue < 100_000_000) return '$50M - $100M';
  if (revenue < 500_000_000) return '$100M - $500M';
  if (revenue < 1_000_000_000) return '$500M - $1B';
  return 'Over $1B';
}

/**
 * Maps enrichment revenue (numeric) to revenue_tier enum value
 * Returns null if revenue is not available or can't be mapped
 */
export function mapRevenueToTier(revenue: number | undefined | null): string | null {
  if (!revenue) return null;

  if (revenue < 1_000_000) return 'under_1m';
  if (revenue < 5_000_000) return '1m_5m';
  if (revenue < 50_000_000) return '5m_50m';
  if (revenue < 250_000_000) return '50m_250m';
  if (revenue < 1_000_000_000) return '250m_1b';
  return '1b_plus';
}

/**
 * Maps enrichment_revenue_range string to revenue_tier enum value
 * Handles various formats from Lusha data
 */
export function mapRevenueRangeToTier(revenueRange: string | undefined | null): string | null {
  if (!revenueRange) return null;

  const range = revenueRange.toLowerCase();

  // Direct matches for common Lusha revenue range values
  if (range.includes('under') && range.includes('1m')) return 'under_1m';
  if (range.includes('<') && range.includes('1')) return 'under_1m';

  // $1M - $5M ranges
  if ((range.includes('1m') || range.includes('1 m')) && (range.includes('5m') || range.includes('5 m') || range.includes('10m'))) {
    return '1m_5m';
  }

  // $5M - $50M ranges
  if ((range.includes('5m') || range.includes('10m')) && (range.includes('50m') || range.includes('100m'))) {
    return '5m_50m';
  }

  // $50M - $250M ranges
  if ((range.includes('50m') || range.includes('100m')) && (range.includes('250m') || range.includes('500m'))) {
    return '50m_250m';
  }

  // $250M - $1B ranges
  if ((range.includes('250m') || range.includes('500m')) && (range.includes('1b') || range.includes('billion'))) {
    return '250m_1b';
  }

  // $1B+ ranges
  if (range.includes('over') && (range.includes('1b') || range.includes('billion'))) return '1b_plus';
  if (range.includes('>') && range.includes('1b')) return '1b_plus';

  return null;
}

/**
 * Lusha API client
 */
export class LushaClient {
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  /**
   * Enrich company data by domain using the v2 bulk API
   * https://docs.lusha.com/apis/openapi/company-enrichment
   */
  async enrichCompanyByDomain(domain: string): Promise<CompanyEnrichmentResult> {
    try {
      // Use the v2 bulk API with a single company
      // Each company needs a unique `id` string to correlate request/response
      const response = await fetch(`${LUSHA_API_BASE}/bulk/company/v2`, {
        method: 'POST',
        headers: {
          'api_key': this.apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          companies: [{ id: '1', domain }],
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        logger.warn({ domain, status: response.status, error: errorText }, 'Lusha API error');

        if (response.status === 404) {
          return { success: false, error: 'Company not found' };
        }
        if (response.status === 401) {
          return { success: false, error: 'Invalid API key' };
        }
        if (response.status === 429) {
          return { success: false, error: 'Rate limit exceeded' };
        }

        return { success: false, error: `API error: ${response.status}` };
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const responseData = await response.json() as any;

      // Log the raw response for debugging
      logger.debug({ domain, responseKeys: Object.keys(responseData) }, 'Lusha API raw response');

      // v2 bulk API returns results indexed by the request ID we provided
      // Format: { "1": { id, name, ... }, "2": { ... }, ... }
      // The key matches the `id` field we sent in the request
      let data: Record<string, unknown> | null = null;

      // Check if response is directly indexed by our request ID
      if (responseData['1']) {
        data = responseData['1'];
      } else if (responseData.data?.companies) {
        // Fallback: MCP-style companies indexed by ID
        const companies = responseData.data.companies;
        const companyIds = Object.keys(companies);
        if (companyIds.length > 0) {
          data = companies[companyIds[0]];
        }
      } else {
        // Fallback: Array-style response
        const results = responseData.data || responseData.results || responseData;
        const companyResults = Array.isArray(results) ? results : [results];
        if (companyResults.length > 0) {
          data = companyResults[0];
        }
      }

      if (!data) {
        return { success: false, error: 'No results returned' };
      }

      // Check if the company was found
      if (data.status === 'NOT_FOUND' || data.error) {
        return { success: false, error: String(data.error) || 'Company not found' };
      }

      // Map Lusha v2 bulk API response to our interface
      // Response format example:
      // { id, lushaCompanyId, name, companySize: [min, max], revenueRange: [min, max],
      //   fqdn, founded, description, logoUrl, linkedin, mainIndustry, subIndustry,
      //   city, state, country, countryIso2, continent, rawLocation, specialities }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const companyInfo = (data.company || data) as any;

      // Parse employee count from companySize array [min, max]
      let employeeCount: number | undefined;
      let employeeCountRange: string | undefined;
      if (Array.isArray(companyInfo.companySize) && companyInfo.companySize.length >= 2) {
        const [min, max] = companyInfo.companySize;
        employeeCount = min; // Use min as primary count
        employeeCountRange = `${min}-${max}`;
      } else if (companyInfo.employeeCount) {
        employeeCount = companyInfo.employeeCount;
        employeeCountRange = companyInfo.employeeCountRange;
      }

      // Parse revenue from revenueRange array [min, max]
      let revenue: number | undefined;
      let revenueRange: string | undefined;
      if (Array.isArray(companyInfo.revenueRange) && companyInfo.revenueRange.length >= 2) {
        const [min, max] = companyInfo.revenueRange;
        revenue = min; // Use min as primary revenue
        revenueRange = `$${(min / 1000000).toFixed(0)}M-$${(max / 1000000).toFixed(0)}M`;
      } else if (companyInfo.revenue) {
        revenue = companyInfo.revenue;
        revenueRange = companyInfo.revenueRange;
      }

      // Parse founded year (may be string like "1995")
      let foundedYear: number | undefined;
      if (companyInfo.founded) {
        const parsed = parseInt(String(companyInfo.founded), 10);
        if (!isNaN(parsed)) foundedYear = parsed;
      } else if (companyInfo.foundedYear) {
        foundedYear = companyInfo.foundedYear;
      }

      // Get domain from fqdn (may include www.)
      const domainValue = companyInfo.fqdn?.replace(/^www\./, '') || companyInfo.domain || domain;

      const companyData: LushaCompanyData = {
        companyId: String(companyInfo.lushaCompanyId || companyInfo.companyId || companyInfo.id || ''),
        companyName: String(companyInfo.name || companyInfo.companyName || ''),
        domain: domainValue,
        description: companyInfo.description as string | undefined,
        employeeCount,
        employeeCountRange,
        revenue,
        revenueRange,
        mainIndustry: companyInfo.mainIndustry as string | undefined,
        subIndustry: companyInfo.subIndustry as string | undefined,
        foundedYear,
        country: companyInfo.country as string | undefined,
        countryIso2: companyInfo.countryIso2 as string | undefined,
        city: companyInfo.city as string | undefined,
        state: companyInfo.state as string | undefined,
        fullAddress: companyInfo.rawLocation as string | undefined,
        continent: companyInfo.continent as string | undefined,
        linkedinUrl: companyInfo.linkedin as string | undefined,
        specialties: (companyInfo.specialities || companyInfo.specialties) as string[] | undefined,
        sicsCode: companyInfo.industryPrimaryGroupDetails?.sics?.[0]?.sic?.toString() as string | undefined,
        sicsDescription: companyInfo.industryPrimaryGroupDetails?.sics?.[0]?.description as string | undefined,
        naicsCode: companyInfo.industryPrimaryGroupDetails?.naics?.[0]?.naics?.toString() as string | undefined,
        naicsDescription: companyInfo.industryPrimaryGroupDetails?.naics?.[0]?.description as string | undefined,
      };

      logger.info(
        { domain, companyName: companyData.companyName, industry: companyData.mainIndustry },
        'Lusha company enrichment successful'
      );

      return {
        success: true,
        data: companyData,
        creditsUsed: responseData.creditsUsed || 1,
      };
    } catch (error) {
      logger.error({ err: error, domain }, 'Lusha API request failed');
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Bulk enrich multiple domains (up to 100 at a time)
   */
  async enrichCompaniesInBulk(domains: string[]): Promise<Map<string, CompanyEnrichmentResult>> {
    const results = new Map<string, CompanyEnrichmentResult>();

    // Lusha supports up to 100 in bulk, but we'll do sequential for simplicity
    // and to avoid burning credits on errors
    for (const domain of domains.slice(0, 100)) {
      const result = await this.enrichCompanyByDomain(domain);
      results.set(domain, result);

      // Small delay to respect rate limits (25 req/sec)
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    return results;
  }

  /**
   * Search for companies using the prospecting API
   * https://docs.lusha.com/apis/openapi/company-search-and-enrich
   */
  async searchCompanies(
    filters: CompanySearchFilters,
    page = 1,
    pageSize = 25
  ): Promise<CompanySearchResult> {
    try {
      // Build the search request body
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const searchBody: Record<string, any> = {
        page,
        pageSize: Math.min(pageSize, 100), // Max 100 per request
      };

      // Add filters
      if (filters.industryIds?.length) {
        searchBody.industries = filters.industryIds;
      }
      if (filters.minEmployees !== undefined || filters.maxEmployees !== undefined) {
        searchBody.employeeCount = {};
        if (filters.minEmployees !== undefined) {
          searchBody.employeeCount.min = filters.minEmployees;
        }
        if (filters.maxEmployees !== undefined) {
          searchBody.employeeCount.max = filters.maxEmployees;
        }
      }
      if (filters.companySizeIds?.length) {
        searchBody.companySizes = filters.companySizeIds;
      }
      if (filters.revenueIds?.length) {
        searchBody.revenues = filters.revenueIds;
      }
      if (filters.countries?.length) {
        searchBody.countries = filters.countries;
      }
      if (filters.states?.length) {
        searchBody.states = filters.states;
      }
      if (filters.cities?.length) {
        searchBody.cities = filters.cities;
      }
      if (filters.keywords?.length) {
        searchBody.keywords = filters.keywords;
      }

      logger.debug({ filters, searchBody }, 'Lusha company search request');

      const response = await fetch(`${LUSHA_API_BASE}/prospecting/company/search`, {
        method: 'POST',
        headers: {
          'api_key': this.apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(searchBody),
      });

      if (!response.ok) {
        const errorText = await response.text();
        logger.warn({ status: response.status, error: errorText }, 'Lusha company search error');

        if (response.status === 401) {
          return { success: false, companies: [], total: 0, page, pageSize, error: 'Invalid API key' };
        }
        if (response.status === 429) {
          return { success: false, companies: [], total: 0, page, pageSize, error: 'Rate limit exceeded' };
        }

        return { success: false, companies: [], total: 0, page, pageSize, error: `API error: ${response.status}` };
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const responseData = await response.json() as any;

      logger.debug({ responseKeys: Object.keys(responseData) }, 'Lusha company search response');

      // Parse the response - may be in different formats
      const companiesData = responseData.data?.companies || responseData.companies || responseData.data || [];
      const companiesArray = Array.isArray(companiesData) ? companiesData : Object.values(companiesData);

      // Map each company to our interface
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const companies: LushaCompanyData[] = companiesArray.map((c: any) => ({
        companyId: String(c.companyId || c.id || ''),
        companyName: String(c.companyName || c.name || ''),
        domain: String(c.domain || ''),
        description: c.description as string | undefined,
        employeeCount: (c.employeeCount || c.employees || c.numberOfEmployees) as number | undefined,
        employeeCountRange: (c.employeeCountRange || c.employeesRange || c.employeeRange) as string | undefined,
        revenue: c.revenue as number | undefined,
        revenueRange: (c.revenueRange || c.estimatedRevenue) as string | undefined,
        mainIndustry: (c.mainIndustry || c.industry) as string | undefined,
        subIndustry: c.subIndustry as string | undefined,
        foundedYear: (c.foundedYear || c.founded || c.yearFounded) as number | undefined,
        country: (c.country || c.location?.country) as string | undefined,
        countryIso2: c.countryIso2 as string | undefined,
        city: (c.city || c.location?.city) as string | undefined,
        state: (c.state || c.location?.state) as string | undefined,
        fullAddress: (c.fullAddress || c.address || c.location?.address) as string | undefined,
        continent: c.continent as string | undefined,
        linkedinUrl: (c.linkedinUrl || c.linkedin || c.socialLinks?.linkedin) as string | undefined,
        specialties: c.specialties as string[] | undefined,
        sicsCode: c.sicsCode as string | undefined,
        sicsDescription: c.sicsDescription as string | undefined,
        naicsCode: c.naicsCode as string | undefined,
        naicsDescription: c.naicsDescription as string | undefined,
      }));

      logger.info(
        { total: responseData.total || companies.length, returned: companies.length },
        'Lusha company search successful'
      );

      return {
        success: true,
        companies,
        total: responseData.total || responseData.totalResults || companies.length,
        page: responseData.page || page,
        pageSize: responseData.pageSize || pageSize,
      };
    } catch (error) {
      logger.error({ err: error }, 'Lusha company search failed');
      return {
        success: false,
        companies: [],
        total: 0,
        page,
        pageSize,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Get available industry filter options
   */
  async getIndustryFilters(): Promise<FilterOption[]> {
    try {
      const response = await fetch(`${LUSHA_API_BASE}/prospecting/filters/companies/industries_labels`, {
        method: 'GET',
        headers: {
          'api_key': this.apiKey,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        logger.warn({ status: response.status }, 'Failed to fetch industry filters');
        return [];
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data = await response.json() as any;
      const industries = data.industries || data.data || data || [];

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return industries.map((i: any) => ({
        id: i.id || i.industryId,
        label: i.label || i.name || i.industryName,
        count: i.count,
      }));
    } catch (error) {
      logger.error({ err: error }, 'Failed to fetch industry filters');
      return [];
    }
  }

  /**
   * Get available company size filter options
   */
  async getCompanySizeFilters(): Promise<FilterOption[]> {
    try {
      const response = await fetch(`${LUSHA_API_BASE}/prospecting/filters/companies/sizes`, {
        method: 'GET',
        headers: {
          'api_key': this.apiKey,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        logger.warn({ status: response.status }, 'Failed to fetch size filters');
        return [];
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data = await response.json() as any;
      const sizes = data.sizes || data.data || data || [];

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return sizes.map((s: any) => ({
        id: s.id || s.sizeId,
        label: s.label || s.name || s.range,
        count: s.count,
      }));
    } catch (error) {
      logger.error({ err: error }, 'Failed to fetch size filters');
      return [];
    }
  }

  /**
   * Get available revenue filter options
   */
  async getRevenueFilters(): Promise<FilterOption[]> {
    try {
      const response = await fetch(`${LUSHA_API_BASE}/prospecting/filters/companies/revenues`, {
        method: 'GET',
        headers: {
          'api_key': this.apiKey,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        logger.warn({ status: response.status }, 'Failed to fetch revenue filters');
        return [];
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data = await response.json() as any;
      const revenues = data.revenues || data.data || data || [];

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return revenues.map((r: any) => ({
        id: r.id || r.revenueId,
        label: r.label || r.name || r.range,
        count: r.count,
      }));
    } catch (error) {
      logger.error({ err: error }, 'Failed to fetch revenue filters');
      return [];
    }
  }
}

// Singleton instance - initialized lazily
let lushaClient: LushaClient | null = null;

export function getLushaClient(): LushaClient | null {
  if (!lushaClient) {
    const apiKey = process.env.LUSHA_API_KEY;
    if (!apiKey) {
      logger.debug('LUSHA_API_KEY not configured');
      return null;
    }
    lushaClient = new LushaClient(apiKey);
  }
  return lushaClient;
}

export function isLushaConfigured(): boolean {
  return !!process.env.LUSHA_API_KEY;
}
