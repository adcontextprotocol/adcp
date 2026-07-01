/**
 * Lusha API client for company enrichment
 * https://docs.lusha.com/apis/openapi/enrichment
 */

import { logger } from '../logger.js';
import type { CompanyTypeValue } from '../config/company-types.js';

const LUSHA_API_BASE = 'https://api.lusha.com';
const LUSHA_MAX_BATCH_SIZE = 100;

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
  industryIds?: (number | string)[]; // Industry IDs/labels from /v3/companies/prospecting/filters/industriesLabels
  industryLabels?: string[];        // Industry labels for the V3 industriesLabels filter
  minEmployees?: number;            // Minimum employee count
  maxEmployees?: number;            // Maximum employee count
  companySizeIds?: string[];        // Size filter IDs from /v3/companies/prospecting/filters/sizes
  revenueIds?: string[];            // Revenue range IDs from /v3/companies/prospecting/filters/revenues
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

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : undefined;
}

function nestedRecord(value: unknown, key: string): UnknownRecord | undefined {
  return isRecord(value) && isRecord(value[key]) ? value[key] : undefined;
}

function firstRecord(value: unknown): UnknownRecord | undefined {
  return Array.isArray(value) ? value.find(isRecord) : undefined;
}

function normalizeDomain(domain: string | undefined): string | undefined {
  return domain?.replace(/^www\./i, '');
}

function formatCompactCurrency(value: number): string {
  if (value >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(value % 1_000_000_000 === 0 ? 0 : 1)}B`;
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(value % 1_000 === 0 ? 0 : 1)}K`;
  return `$${value}`;
}

function formatRange(min: number | undefined, max: number | undefined): string | undefined {
  if (min !== undefined && max !== undefined) return `${min}-${max}`;
  if (min !== undefined) return `${min}+`;
  if (max !== undefined) return `Up to ${max}`;
  return undefined;
}

function formatRevenueRangeFromBounds(min: number | undefined, max: number | undefined): string | undefined {
  if (min !== undefined && max !== undefined) return `${formatCompactCurrency(min)}-${formatCompactCurrency(max)}`;
  if (min !== undefined) return `${formatCompactCurrency(min)}+`;
  if (max !== undefined) return `Up to ${formatCompactCurrency(max)}`;
  return undefined;
}

function rangeToken(min: number | undefined, max: number | undefined): string | undefined {
  if (min === undefined && max === undefined) return undefined;
  return `range:${min ?? ''}:${max ?? ''}`;
}

function parseCompactNumberToken(value: string): number | undefined {
  const match = value.match(/(\d+(?:\.\d+)?)\s*([kmb])?/i);
  if (!match) return undefined;

  const base = Number(match[1]);
  if (!Number.isFinite(base)) return undefined;

  const suffix = match[2]?.toLowerCase();
  if (suffix === 'b') return base * 1_000_000_000;
  if (suffix === 'm') return base * 1_000_000;
  if (suffix === 'k') return base * 1_000;
  return base;
}

function parseRangeToken(value: string): { min?: number; max?: number } | null {
  if (value.startsWith('range:')) {
    const [, minRaw, maxRaw] = value.split(':');
    const min = minRaw ? asNumber(minRaw) : undefined;
    const max = maxRaw ? asNumber(maxRaw) : undefined;
    return min !== undefined || max !== undefined ? { min, max } : null;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    if (isRecord(parsed)) {
      const min = asNumber(parsed.min);
      const max = asNumber(parsed.max);
      if (min !== undefined || max !== undefined) return { min, max };
    }
  } catch {
    // Keep parsing common display forms below.
  }

  const numbers = (value.match(/\d+(?:\.\d+)?\s*[kmb]?/gi) ?? [])
    .map(parseCompactNumberToken)
    .filter((number): number is number => number !== undefined);
  if (numbers.length >= 2) return { min: numbers[0], max: numbers[1] };
  if (numbers.length === 1 && /over|\+|plus|above|greater/i.test(value)) return { min: numbers[0] };
  if (numbers.length === 1 && /under|up to|less|below/i.test(value)) return { max: numbers[0] };
  return null;
}

function rangesFromIds(ids: string[] | undefined): Array<{ min?: number; max?: number }> | undefined {
  const ranges = ids?.map(parseRangeToken).filter((range): range is { min?: number; max?: number } => !!range) ?? [];
  return ranges.length ? ranges : undefined;
}

function buildLocations(filters: CompanySearchFilters): UnknownRecord[] | undefined {
  const { countries, states, cities } = filters;
  const maxLength = Math.max(countries?.length ?? 0, states?.length ?? 0, cities?.length ?? 0);
  if (maxLength === 0) return undefined;

  const locations: UnknownRecord[] = [];
  for (let index = 0; index < maxLength; index += 1) {
    const location: UnknownRecord = {};
    const country = countries?.[index] ?? (countries?.length === 1 ? countries[0] : undefined);
    const state = states?.[index] ?? (states?.length === 1 ? states[0] : undefined);
    const city = cities?.[index] ?? (cities?.length === 1 ? cities[0] : undefined);
    if (country) location.country = country;
    if (state) location.state = state;
    if (city) location.city = city;
    if (Object.keys(location).length) locations.push(location);
  }

  return locations.length ? locations : undefined;
}

function getBillingCredits(responseData: UnknownRecord): number | undefined {
  return asNumber(nestedRecord(responseData, 'billing')?.creditsCharged) ?? asNumber(responseData.creditsUsed);
}

function getErrorMessage(response: Response, errorText: string): string {
  if (response.status === 401) return 'Invalid API key';
  if (response.status === 402) return 'Insufficient Lusha credits';
  if (response.status === 403) return 'Lusha API access forbidden or V3 access not enabled';
  if (response.status === 404) return 'Company not found';
  if (response.status === 429) return 'Rate limit exceeded';

  try {
    const parsed = JSON.parse(errorText) as unknown;
    if (isRecord(parsed) && asString(parsed.message)) {
      return asString(parsed.message)!;
    }
  } catch {
    // Fall through to status-only error.
  }

  return `API error: ${response.status}`;
}

function mapLushaCompanyData(companyInfo: UnknownRecord, fallbackDomain?: string): LushaCompanyData {
  const employeeCount = companyInfo.employeeCount;
  const employeeCountRecord = isRecord(employeeCount) ? employeeCount : undefined;
  const employeeCountArray = Array.isArray(employeeCount) ? employeeCount : undefined;
  const employeeMin = asNumber(employeeCountRecord?.min) ?? asNumber(employeeCountArray?.[0]);
  const employeeMax = asNumber(employeeCountRecord?.max) ?? asNumber(employeeCountArray?.[1]);

  const revenueRange = companyInfo.revenueRange;
  const revenueRangeRecord = isRecord(revenueRange) ? revenueRange : undefined;
  const revenueRangeArray = Array.isArray(revenueRange) ? revenueRange : undefined;
  const revenueMin = asNumber(revenueRangeRecord?.min) ?? asNumber(revenueRangeArray?.[0]);
  const revenueMax = asNumber(revenueRangeRecord?.max) ?? asNumber(revenueRangeArray?.[1]);

  const location = nestedRecord(companyInfo, 'location') ?? companyInfo;
  const socialLinks = nestedRecord(companyInfo, 'socialLinks');
  const sicCode = firstRecord(companyInfo.sicCodes) ?? firstRecord(nestedRecord(companyInfo, 'industryPrimaryGroupDetails')?.sics);
  const naicsCode = firstRecord(companyInfo.naicsCodes) ?? firstRecord(nestedRecord(companyInfo, 'industryPrimaryGroupDetails')?.naics);
  const sicCodeValue = sicCode?.code ?? sicCode?.sic ?? companyInfo.sicsCode;
  const naicsCodeValue = naicsCode?.code ?? naicsCode?.naics ?? companyInfo.naicsCode;
  const foundedYearRaw = companyInfo.yearFounded ?? companyInfo.foundedYear ?? companyInfo.founded;
  const foundedYear = asNumber(foundedYearRaw);
  const domainValue = normalizeDomain(
    asString(companyInfo.domain) ??
    asString(companyInfo.fqdn) ??
    fallbackDomain
  );

  return {
    companyId: String(companyInfo.id ?? companyInfo.companyId ?? companyInfo.lushaCompanyId ?? ''),
    companyName: String(companyInfo.name ?? companyInfo.companyName ?? ''),
    domain: domainValue ?? fallbackDomain ?? '',
    description: asString(companyInfo.description),
    employeeCount: asNumber(employeeCountRecord?.exact) ?? employeeMin ?? asNumber(companyInfo.employeeCount),
    employeeCountRange: formatRange(employeeMin, employeeMax) ?? asString(companyInfo.employeeCountRange),
    revenue: revenueMin ?? asNumber(companyInfo.revenue),
    revenueRange: formatRevenueRangeFromBounds(revenueMin, revenueMax) ?? asString(revenueRange) ?? asString(companyInfo.estimatedRevenue),
    mainIndustry: asString(companyInfo.industry) ?? asString(companyInfo.mainIndustry),
    subIndustry: asString(companyInfo.subIndustry),
    foundedYear,
    country: asString(location.country),
    countryIso2: asString(location.countryIso2),
    city: asString(location.city),
    state: asString(location.state),
    fullAddress: asString(companyInfo.fullAddress) ?? asString(companyInfo.rawLocation) ?? asString(companyInfo.address),
    continent: asString(location.continent),
    linkedinUrl: asString(socialLinks?.linkedin) ?? asString(companyInfo.linkedinUrl) ?? asString(companyInfo.linkedin),
    specialties: asStringArray(companyInfo.specialities) ?? asStringArray(companyInfo.specialties) ?? asStringArray(companyInfo.specialitiesRefactored),
    sicsCode: sicCodeValue === undefined ? undefined : String(sicCodeValue),
    sicsDescription: asString(sicCode?.description) ?? asString(companyInfo.sicsDescription),
    naicsCode: naicsCodeValue === undefined ? undefined : String(naicsCodeValue),
    naicsDescription: asString(naicsCode?.description) ?? asString(companyInfo.naicsDescription),
  };
}

function normalizeFilterOption(value: unknown): FilterOption | null {
  if (typeof value === 'string' || typeof value === 'number') {
    return { id: value, label: String(value) };
  }
  if (!isRecord(value)) return null;

  const range = isRecord(value.range) ? value.range : value;
  const min = asNumber(range.min);
  const max = asNumber(range.max);
  const rangeId = rangeToken(min, max);
  const label =
    asString(value.label) ??
    asString(value.name) ??
    asString(value.value) ??
    asString(value.description) ??
    (min !== undefined || max !== undefined ? formatRange(min, max) : undefined);

  if (!label) return null;

  return {
    id: rangeId ?? (value.id as string | number | undefined) ?? label,
    label,
    count: asNumber(value.count),
  };
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

  private headers(): Record<string, string> {
    return {
      'api_key': this.apiKey,
      'Content-Type': 'application/json',
    };
  }

  /**
   * Enrich company data by domain using the V3 search-and-enrich API.
   * https://docs.lusha.com/apis/openapi/search-and-enrich/searchandenrichcompanies
   */
  async enrichCompanyByDomain(domain: string): Promise<CompanyEnrichmentResult> {
    try {
      const response = await fetch(`${LUSHA_API_BASE}/v3/companies/search-and-enrich`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          companies: [{ clientReferenceId: '1', domain }],
          options: { includePartialProfiles: true },
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        logger.warn({ domain, status: response.status, error: errorText }, 'Lusha API error');

        return { success: false, error: getErrorMessage(response, errorText) };
      }

      const responseData = await response.json() as UnknownRecord;

      // Log the raw response for debugging
      logger.debug({ domain, responseKeys: Object.keys(responseData) }, 'Lusha API raw response');

      const results = Array.isArray(responseData.results) ? responseData.results.filter(isRecord) : [];
      const data = results.find((result) => result.clientReferenceId === '1') ?? results[0] ?? null;

      if (!data) {
        return { success: false, error: 'No results returned' };
      }

      // Check if the company was found
      if (data.status === 'NOT_FOUND' || data.error) {
        const itemError = isRecord(data.error) ? data.error : null;
        return { success: false, error: asString(itemError?.message) ?? asString(data.error) ?? 'Company not found' };
      }

      const companyData = mapLushaCompanyData(data, domain);

      logger.info(
        { domain, companyName: companyData.companyName, industry: companyData.mainIndustry },
        'Lusha company enrichment successful'
      );

      return {
        success: true,
        data: companyData,
        creditsUsed: getBillingCredits(responseData),
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
    for (const domain of domains.slice(0, LUSHA_MAX_BATCH_SIZE)) {
      const result = await this.enrichCompanyByDomain(domain);
      results.set(domain, result);

      // Small delay to respect rate limits (25 req/sec)
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    return results;
  }

  /**
   * Search for companies using the prospecting API
   * https://docs.lusha.com/apis/openapi/prospecting/prospectingcompanies
   */
  async searchCompanies(
    filters: CompanySearchFilters,
    page = 1,
    pageSize = 25
  ): Promise<CompanySearchResult> {
    try {
      const include: UnknownRecord = {};

      const numericIndustryIds = filters.industryIds?.filter((id): id is number => typeof id === 'number');
      const stringIndustryLabels = filters.industryIds?.filter((id): id is string => typeof id === 'string');
      if (numericIndustryIds?.length) {
        include.mainIndustriesIds = numericIndustryIds;
      }
      if (stringIndustryLabels?.length || filters.industryLabels?.length) {
        include.industriesLabels = [...(filters.industryLabels ?? []), ...(stringIndustryLabels ?? [])];
      }

      const explicitEmployeeRange =
        filters.minEmployees !== undefined || filters.maxEmployees !== undefined
          ? [{ min: filters.minEmployees, max: filters.maxEmployees }]
          : [];
      const sizeRanges = rangesFromIds(filters.companySizeIds) ?? [];
      if (explicitEmployeeRange.length || sizeRanges.length) {
        include.sizes = [...explicitEmployeeRange, ...sizeRanges];
      }

      const revenueRanges = rangesFromIds(filters.revenueIds);
      if (revenueRanges?.length) {
        include.revenues = revenueRanges;
      }

      const locations = buildLocations(filters);
      if (locations?.length) {
        include.locations = locations;
      }

      if (filters.keywords?.length) {
        include.searchText = filters.keywords.join(' ');
      }

      const requestedPageSize = Number.isFinite(pageSize) ? Math.floor(pageSize) : 25;
      const responsePageSize = Math.min(Math.max(requestedPageSize, 1), 100);
      const apiPageSize = Math.max(responsePageSize, 10);
      const requestedPage = Number.isFinite(page) ? Math.floor(page) : 1;
      const searchBody = {
        pagination: {
          page: Math.max(requestedPage - 1, 0),
          size: apiPageSize,
        },
        filters: {
          companies: {
            include,
          },
        },
        options: {
          includePartialProfiles: true,
        },
      };

      logger.debug({ filters, searchBody }, 'Lusha company search request');

      const response = await fetch(`${LUSHA_API_BASE}/v3/companies/prospecting`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(searchBody),
      });

      if (!response.ok) {
        const errorText = await response.text();
        logger.warn({ status: response.status, error: errorText }, 'Lusha company search error');

        if (response.status === 401) {
          return { success: false, companies: [], total: 0, page, pageSize, error: 'Invalid API key' };
        }
        if (response.status === 402) {
          return { success: false, companies: [], total: 0, page, pageSize, error: 'Insufficient Lusha credits' };
        }
        if (response.status === 403) {
          return { success: false, companies: [], total: 0, page, pageSize, error: 'Lusha API access forbidden or V3 access not enabled' };
        }
        if (response.status === 429) {
          return { success: false, companies: [], total: 0, page, pageSize, error: 'Rate limit exceeded' };
        }

        return { success: false, companies: [], total: 0, page, pageSize, error: getErrorMessage(response, errorText) };
      }

      const responseData = await response.json() as UnknownRecord;

      logger.debug({ responseKeys: Object.keys(responseData) }, 'Lusha company search response');

      const companiesData = Array.isArray(responseData.results) ? responseData.results : [];
      const companies = companiesData.filter(isRecord).map((company) => mapLushaCompanyData(company)).slice(0, responsePageSize);
      const pagination = nestedRecord(responseData, 'pagination');

      logger.info(
        { total: asNumber(pagination?.total) ?? companies.length, returned: companies.length },
        'Lusha company search successful'
      );

      return {
        success: true,
        companies,
        total: asNumber(pagination?.total) ?? companies.length,
        page: (asNumber(pagination?.page) ?? Math.max(requestedPage - 1, 0)) + 1,
        pageSize: responsePageSize,
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
      const response = await fetch(`${LUSHA_API_BASE}/v3/companies/prospecting/filters/industriesLabels`, {
        method: 'GET',
        headers: this.headers(),
      });

      if (!response.ok) {
        logger.warn({ status: response.status }, 'Failed to fetch industry filters');
        return [];
      }

      const data = await response.json() as UnknownRecord;
      const industries = Array.isArray(data.values) ? data.values : [];

      return industries.map(normalizeFilterOption).filter((option): option is FilterOption => !!option);
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
      const response = await fetch(`${LUSHA_API_BASE}/v3/companies/prospecting/filters/sizes`, {
        method: 'GET',
        headers: this.headers(),
      });

      if (!response.ok) {
        logger.warn({ status: response.status }, 'Failed to fetch size filters');
        return [];
      }

      const data = await response.json() as UnknownRecord;
      const sizes = Array.isArray(data.values) ? data.values : [];

      return sizes.map(normalizeFilterOption).filter((option): option is FilterOption => !!option);
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
      const response = await fetch(`${LUSHA_API_BASE}/v3/companies/prospecting/filters/revenues`, {
        method: 'GET',
        headers: this.headers(),
      });

      if (!response.ok) {
        logger.warn({ status: response.status }, 'Failed to fetch revenue filters');
        return [];
      }

      const data = await response.json() as UnknownRecord;
      const revenues = Array.isArray(data.values) ? data.values : [];

      return revenues.map(normalizeFilterOption).filter((option): option is FilterOption => !!option);
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
