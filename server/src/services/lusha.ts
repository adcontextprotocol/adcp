/**
 * Lusha API client for company enrichment
 * https://docs.lusha.com/apis/openapi/company-enrichment
 */

import { logger } from '../logger.js';

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
 */
export function mapIndustryToCompanyType(
  industry: string | undefined,
  subIndustry: string | undefined
): 'adtech' | 'agency' | 'brand' | 'publisher' | null {
  if (!industry) return null;

  const ind = industry.toLowerCase();
  const sub = (subIndustry || '').toLowerCase();

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
    sub.includes('data management')
  ) {
    // Distinguish between ad tech vendors and agencies
    if (sub.includes('agency') || sub.includes('services')) {
      return 'agency';
    }
    return 'adtech';
  }

  // Agency indicators
  if (
    ind.includes('agency') ||
    sub.includes('agency') ||
    sub.includes('media buying') ||
    sub.includes('creative services') ||
    ind.includes('public relations')
  ) {
    return 'agency';
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
    return 'publisher';
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
    return 'brand';
  }

  // Default: if it's a software/tech company in our space, likely adtech
  if (ind.includes('software') || ind.includes('technology')) {
    return 'adtech';
  }

  return null;
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

      // v2 bulk API may return results in different formats:
      // 1. { data: { companies: { [id]: company } } } - MCP-style indexed by ID
      // 2. { data: [...] } or { results: [...] } - array format
      // 3. Direct array response
      let data: Record<string, unknown> | null = null;

      if (responseData.data?.companies) {
        // MCP-style: companies indexed by ID
        const companies = responseData.data.companies;
        const companyIds = Object.keys(companies);
        if (companyIds.length > 0) {
          data = companies[companyIds[0]];
        }
      } else {
        // Array-style response
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

      // Map Lusha response to our interface
      // The v2 API may nest company data or return it flat
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const companyInfo = (data.company || data) as any;

      const companyData: LushaCompanyData = {
        companyId: String(companyInfo.companyId || companyInfo.id || ''),
        companyName: String(companyInfo.companyName || companyInfo.name || ''),
        domain: String(companyInfo.domain || domain),
        description: companyInfo.description as string | undefined,
        employeeCount: (companyInfo.employeeCount || companyInfo.employees || companyInfo.numberOfEmployees) as number | undefined,
        employeeCountRange: (companyInfo.employeeCountRange || companyInfo.employeesRange || companyInfo.employeeRange) as string | undefined,
        revenue: companyInfo.revenue as number | undefined,
        revenueRange: (companyInfo.revenueRange || companyInfo.estimatedRevenue) as string | undefined,
        mainIndustry: (companyInfo.mainIndustry || companyInfo.industry) as string | undefined,
        subIndustry: companyInfo.subIndustry as string | undefined,
        foundedYear: (companyInfo.foundedYear || companyInfo.founded || companyInfo.yearFounded) as number | undefined,
        country: (companyInfo.country || companyInfo.location?.country) as string | undefined,
        countryIso2: companyInfo.countryIso2 as string | undefined,
        city: (companyInfo.city || companyInfo.location?.city) as string | undefined,
        state: (companyInfo.state || companyInfo.location?.state) as string | undefined,
        fullAddress: (companyInfo.fullAddress || companyInfo.address || companyInfo.location?.address) as string | undefined,
        continent: companyInfo.continent as string | undefined,
        linkedinUrl: (companyInfo.linkedinUrl || companyInfo.linkedin || companyInfo.socialLinks?.linkedin) as string | undefined,
        specialties: companyInfo.specialties as string[] | undefined,
        sicsCode: companyInfo.sicsCode as string | undefined,
        sicsDescription: companyInfo.sicsDescription as string | undefined,
        naicsCode: companyInfo.naicsCode as string | undefined,
        naicsDescription: companyInfo.naicsDescription as string | undefined,
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
