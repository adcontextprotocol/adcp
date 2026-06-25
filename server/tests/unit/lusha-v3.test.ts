import { afterEach, describe, expect, it, vi } from 'vitest';
import { LushaClient } from '../../src/services/lusha.js';

function mockJsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn(async () => body),
    text: vi.fn(async () => JSON.stringify(body)),
  };
}

describe('LushaClient V3 migration', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('enriches companies through V3 search-and-enrich and normalizes the result', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockJsonResponse({
      results: [{
        clientReferenceId: '1',
        id: '16303253',
        name: 'Lusha',
        domain: 'www.lusha.com',
        description: 'Business data platform',
        yearFounded: 2016,
        employeeCount: { exact: 364, min: 201, max: 500 },
        revenueRange: { min: 10_000_000, max: 50_000_000 },
        industry: 'Technology, Information & Media',
        subIndustry: 'Software Development',
        location: {
          city: 'Boston',
          state: 'Massachusetts',
          country: 'United States',
          countryIso2: 'US',
          continent: 'North America',
        },
        socialLinks: {
          linkedin: 'https://www.linkedin.com/company/lushadata',
        },
        specialities: ['data enrichment'],
        sicCodes: [{ code: 7371, description: 'Custom computer programming services' }],
        naicsCodes: [{ code: 541511, description: 'Custom Computer Programming Services' }],
      }],
      billing: { creditsCharged: 1, resultsReturned: 1 },
    }) as never);

    const client = new LushaClient('test-key');
    const result = await client.enrichCompanyByDomain('lusha.com');

    expect(fetchMock).toHaveBeenCalledWith('https://api.lusha.com/v3/companies/search-and-enrich', {
      method: 'POST',
      headers: {
        api_key: 'test-key',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        companies: [{ clientReferenceId: '1', domain: 'lusha.com' }],
        options: { includePartialProfiles: true },
      }),
    });
    expect(result.success).toBe(true);
    expect(result.creditsUsed).toBe(1);
    expect(result.data).toMatchObject({
      companyId: '16303253',
      companyName: 'Lusha',
      domain: 'lusha.com',
      employeeCount: 364,
      employeeCountRange: '201-500',
      revenue: 10_000_000,
      revenueRange: '$10M-$50M',
      mainIndustry: 'Technology, Information & Media',
      subIndustry: 'Software Development',
      country: 'United States',
      linkedinUrl: 'https://www.linkedin.com/company/lushadata',
      sicsCode: '7371',
      naicsCode: '541511',
    });
  });

  it('surfaces V3 item-level not-found errors', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockJsonResponse({
      results: [{
        clientReferenceId: '1',
        error: {
          code: 'NOT_FOUND',
          message: 'Company not found',
        },
      }],
      billing: { creditsCharged: 0, resultsReturned: 0 },
    }) as never);

    const client = new LushaClient('test-key');
    const result = await client.enrichCompanyByDomain('missing.example');

    expect(result).toEqual({
      success: false,
      error: 'Company not found',
    });
  });

  it('searches companies through V3 prospecting and translates legacy filters', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockJsonResponse({
      results: [{
        id: '12790225',
        name: 'Salesforce',
        domain: 'www.salesforce.com',
        employeeCount: { exact: 88711, min: 100001, max: 10000000 },
        industry: 'Technology, Information & Media',
        location: {
          city: 'San Francisco',
          state: 'California',
          country: 'United States',
          countryIso2: 'US',
        },
      }],
      pagination: { page: 1, size: 25, total: 87 },
      billing: { creditsCharged: 1, resultsReturned: 1 },
    }) as never);

    const client = new LushaClient('test-key');
    const result = await client.searchCompanies({
      industryIds: [1, 'Software'],
      minEmployees: 50,
      maxEmployees: 500,
      companySizeIds: ['range:1000:5000'],
      revenueIds: ['$10M-$50M'],
      countries: ['United States'],
      states: ['California'],
      cities: ['San Francisco'],
      keywords: ['crm', 'ai'],
    }, 2, 25);

    expect(fetchMock).toHaveBeenCalledWith('https://api.lusha.com/v3/companies/prospecting', expect.objectContaining({
      method: 'POST',
      headers: {
        api_key: 'test-key',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        pagination: { page: 1, size: 25 },
        filters: {
          companies: {
            include: {
              mainIndustriesIds: [1],
              industriesLabels: ['Software'],
              sizes: [{ min: 50, max: 500 }, { min: 1000, max: 5000 }],
              revenues: [{ min: 10000000, max: 50000000 }],
              locations: [{ country: 'United States', state: 'California', city: 'San Francisco' }],
              searchText: 'crm ai',
            },
          },
        },
        options: { includePartialProfiles: true },
      }),
    }));
    expect(result).toMatchObject({
      success: true,
      total: 87,
      page: 2,
      pageSize: 25,
      companies: [{
        companyId: '12790225',
        companyName: 'Salesforce',
        domain: 'salesforce.com',
        employeeCount: 88711,
        mainIndustry: 'Technology, Information & Media',
      }],
    });
  });

  it('fetches V3 company filter endpoints and preserves range IDs', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockJsonResponse({
      values: [
        { min: 1, max: 10, count: 5 },
        { label: 'Enterprise', min: 1000 },
      ],
    }) as never);

    const client = new LushaClient('test-key');
    const filters = await client.getCompanySizeFilters();

    expect(fetchMock).toHaveBeenCalledWith('https://api.lusha.com/v3/companies/prospecting/filters/sizes', {
      method: 'GET',
      headers: {
        api_key: 'test-key',
        'Content-Type': 'application/json',
      },
    });
    expect(filters).toEqual([
      { id: 'range:1:10', label: '1-10', count: 5 },
      { id: 'range:1000:', label: 'Enterprise', count: undefined },
    ]);
  });
});
