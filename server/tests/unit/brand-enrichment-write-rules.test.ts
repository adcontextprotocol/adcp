/**
 * enrichBrand() applies the shared enrichment write rules (#9024): it never
 * saves a reserved name or a subdomain, and never files a Brandfetch answer
 * under a domain the answered brand does not live on.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getDiscoveredBrandByDomain: vi.fn(),
  upsertDiscoveredBrand: vi.fn(),
  deleteDiscoveredBrand: vi.fn(),
  fetchBrandData: vi.fn(),
  classifyBrand: vi.fn(),
  query: vi.fn(),
  markResolved: vi.fn(),
  listUnresolved: vi.fn(),
}));

vi.mock('@anthropic-ai/sdk', () => {
  class FakeAnthropic {
    messages = { create: vi.fn() };
  }
  class APIError extends Error {}
  return { default: FakeAnthropic, APIError };
});

vi.mock('../../src/db/brand-db.js', () => ({
  brandDb: {
    getDiscoveredBrandByDomain: mocks.getDiscoveredBrandByDomain,
    upsertDiscoveredBrand: mocks.upsertDiscoveredBrand,
    deleteDiscoveredBrand: mocks.deleteDiscoveredBrand,
  },
}));

vi.mock('../../src/db/registry-requests-db.js', () => ({
  registryRequestsDb: {
    markResolved: mocks.markResolved,
    listUnresolved: mocks.listUnresolved,
  },
}));

vi.mock('../../src/db/client.js', () => ({
  getPool: () => ({ query: vi.fn().mockResolvedValue({ rows: [] }) }),
  query: mocks.query,
}));

vi.mock('../../src/services/brandfetch.js', () => ({
  fetchBrandData: mocks.fetchBrandData,
  isBrandfetchConfigured: () => true,
  ENRICHMENT_CACHE_MAX_AGE_MS: 86_400_000,
}));

vi.mock('../../src/services/logo-cdn.js', () => ({
  downloadAndCacheLogos: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../src/services/brand-classifier.js', () => ({
  classifyBrand: mocks.classifyBrand,
}));

vi.mock('../../src/services/enrichment.js', () => ({
  enrichOrganization: vi.fn(),
}));

vi.mock('../../src/services/lusha.js', () => ({
  isLushaConfigured: () => false,
}));

const { enrichBrand, getEnrichmentCandidates } = await import('../../src/services/brand-enrichment.js');

function brandfetchHit(domain: string, brandDomain = domain) {
  return {
    success: true,
    domain,
    raw: { id: 'bf_1', name: 'Nova Brands', domain: brandDomain },
    manifest: { name: 'Nova Brands', url: `https://${brandDomain}` },
    highQuality: true,
  };
}

describe('enrichBrand registry write rules (#9024)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getDiscoveredBrandByDomain.mockResolvedValue(null);
    mocks.upsertDiscoveredBrand.mockResolvedValue({});
    mocks.classifyBrand.mockResolvedValue(null);
    mocks.query.mockResolvedValue({ rows: [] });
    mocks.markResolved.mockResolvedValue(true);
    mocks.listUnresolved.mockResolvedValue([]);
  });

  it('skips a reserved name without calling Brandfetch', async () => {
    const result = await enrichBrand('novabrands-ai-9384.example.org');

    expect(result).toMatchObject({ status: 'skipped', error: 'Not saved to the registry: reserved_name' });
    expect(mocks.fetchBrandData).not.toHaveBeenCalled();
    expect(mocks.upsertDiscoveredBrand).not.toHaveBeenCalled();
  });

  it('skips a subdomain without calling Brandfetch', async () => {
    const result = await enrichBrand('sandbox.novabrands.com');

    expect(result).toMatchObject({ status: 'skipped', error: 'Not saved to the registry: not_registrable_domain' });
    expect(mocks.fetchBrandData).not.toHaveBeenCalled();
    expect(mocks.classifyBrand).not.toHaveBeenCalled();
    expect(mocks.upsertDiscoveredBrand).not.toHaveBeenCalled();
    // The registry request is closed, pointing at the parent, so bulk
    // enrichment does not pick it up again.
    expect(mocks.markResolved).toHaveBeenCalledWith('brand', 'sandbox.novabrands.com', 'novabrands.com');
  });

  it('does not save a result Brandfetch answered with another domain', async () => {
    mocks.fetchBrandData.mockResolvedValue(brandfetchHit('novabrands.net', 'novabrands.com'));

    const result = await enrichBrand('novabrands.net');

    expect(result).toMatchObject({ status: 'skipped', error: 'Not saved to the registry: brand_domain_mismatch' });
    expect(mocks.upsertDiscoveredBrand).not.toHaveBeenCalled();
    expect(mocks.markResolved).toHaveBeenCalledWith('brand', 'novabrands.net', 'novabrands.com');
  });

  it('still saves a registrable domain Brandfetch answered for itself', async () => {
    mocks.fetchBrandData.mockResolvedValue(brandfetchHit('novabrands.com'));

    const result = await enrichBrand('novabrands.com');

    expect(result).toMatchObject({ status: 'enriched', brand_name: 'Nova Brands' });
    expect(mocks.upsertDiscoveredBrand).toHaveBeenCalledWith(expect.objectContaining({
      domain: 'novabrands.com',
      source_type: 'enriched',
      enrichment_provider: 'brandfetch',
    }));
  });
});

describe('getEnrichmentCandidates skips names that can never be saved (#9024)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('pages past junk community rows and junk registry requests', async () => {
    const junkCommunity = Array.from({ length: 3 }, (_, i) => ({ domain: `e2e-${i}.novabrands.com`, brand_name: 'Nova Brands' }));
    mocks.query
      .mockResolvedValueOnce({ rows: junkCommunity })
      .mockResolvedValueOnce({ rows: [{ domain: 'pinnacle-media.com', brand_name: 'Pinnacle Media' }] });
    mocks.listUnresolved
      .mockResolvedValueOnce([
        { domain: 'novabrands-ai-1.example.org', request_count: 9 },
        { domain: 'sandbox.novabrands.com', request_count: 8 },
        { domain: 'acme-corp.com', request_count: 7 },
      ])
      .mockResolvedValueOnce([]);

    const candidates = await getEnrichmentCandidates({ source: 'all', limit: 3 });

    expect(candidates.map((c) => c.domain)).toEqual(['pinnacle-media.com', 'acme-corp.com']);
  });
});
