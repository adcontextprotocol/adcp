/**
 * Pins the Anthropic tool_use contract for brand-enrichment.expandHouse:
 *   - Ships the discover_sub_brands tool with input_schema (keller_type
 *     enum bounds returned brands to {sub_brand, endorsed})
 *   - Forces the tool via tool_choice
 *   - Reads tool_use.input directly (no JSON.parse, no fence stripping)
 *   - Defensive throw when the model returns no tool_use block
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  anthropicCreate: vi.fn(),
  getDiscoveredBrandByDomain: vi.fn(),
  upsertDiscoveredBrand: vi.fn(),
  query: vi.fn(),
  registryRequestsMarkResolved: vi.fn(),
  fetchBrandData: vi.fn(),
  classifyBrand: vi.fn(),
}));

vi.mock('@anthropic-ai/sdk', () => {
  class FakeAnthropic {
    messages = { create: mocks.anthropicCreate };
  }
  class APIError extends Error {}
  return { default: FakeAnthropic, APIError };
});

vi.mock('../../src/db/brand-db.js', () => ({
  brandDb: {
    getDiscoveredBrandByDomain: mocks.getDiscoveredBrandByDomain,
    upsertDiscoveredBrand: mocks.upsertDiscoveredBrand,
    deleteDiscoveredBrand: vi.fn(),
  },
}));

vi.mock('../../src/db/registry-requests-db.js', () => ({
  registryRequestsDb: {
    markResolved: mocks.registryRequestsMarkResolved,
    listUnresolved: vi.fn().mockResolvedValue([]),
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

function toolUseResponse(input: unknown) {
  return {
    content: [
      { type: 'tool_use', name: 'discover_sub_brands', id: 'toolu_test', input },
    ],
  };
}

describe('expandHouse: tool_use contract', () => {
  let expandHouse: typeof import('../../src/services/brand-enrichment.js').expandHouse;

  beforeEach(async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    mocks.anthropicCreate.mockReset();
    mocks.getDiscoveredBrandByDomain.mockReset();
    mocks.upsertDiscoveredBrand.mockReset();
    mocks.query.mockReset();
    mocks.registryRequestsMarkResolved.mockReset();
    mocks.fetchBrandData.mockReset();
    mocks.classifyBrand.mockReset();

    // Default house: a master brand
    mocks.getDiscoveredBrandByDomain.mockResolvedValue({
      domain: 'pg.com',
      brand_name: 'P&G',
      keller_type: 'master',
      brand_manifest: { company: { industries: ['cpg'] } },
    });
    mocks.query.mockResolvedValue({ rows: [] }); // no existing sub-brands
    mocks.upsertDiscoveredBrand.mockResolvedValue({});
    mocks.classifyBrand.mockResolvedValue(null);
    mocks.registryRequestsMarkResolved.mockResolvedValue(undefined);

    vi.resetModules();
    ({ expandHouse } = await import('../../src/services/brand-enrichment.js'));
  });

  it('ships discover_sub_brands with input_schema constraining keller_type', async () => {
    mocks.anthropicCreate.mockResolvedValueOnce(
      toolUseResponse({ brands: [] }),
    );

    await expandHouse('pg.com', { enrichAfterSeed: false });

    expect(mocks.anthropicCreate).toHaveBeenCalledOnce();
    const call = mocks.anthropicCreate.mock.calls[0][0];

    expect(call.tools).toHaveLength(1);
    expect(call.tools[0].name).toBe('discover_sub_brands');
    const schema = call.tools[0].input_schema;
    expect(schema.properties.brands.items.properties.keller_type.enum).toEqual([
      'sub_brand',
      'endorsed',
    ]);
    expect(call.tool_choice).toEqual({ type: 'tool', name: 'discover_sub_brands' });
  });

  it('reads tool_use.input directly and seeds each discovered brand', async () => {
    mocks.anthropicCreate.mockResolvedValueOnce(
      toolUseResponse({
        brands: [
          { brand_name: 'Tide', domain: 'tide.com', keller_type: 'endorsed' },
          { brand_name: 'Gillette', domain: 'gillette.com', keller_type: 'endorsed' },
        ],
      }),
    );

    const result = await expandHouse('pg.com', { enrichAfterSeed: false });

    expect(result.discovered).toBe(2);
    expect(result.seeded).toBe(2);
    expect(mocks.upsertDiscoveredBrand).toHaveBeenCalledTimes(2);
    expect(mocks.upsertDiscoveredBrand).toHaveBeenCalledWith(expect.objectContaining({
      house_domain: 'pg.com',
      house_domain_audit: {
        actor_user_id: 'system:house-expansion',
        source: 'house_expansion',
      },
    }));
  });

  it('throws when the model does not emit a tool_use block (defensive)', async () => {
    mocks.anthropicCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'I refuse' }],
    });

    await expect(expandHouse('pg.com', { enrichAfterSeed: false })).rejects.toThrow(
      /Failed to parse brand discovery response/,
    );
  });

  it('passes an explicit classifier null through as an audited clear', async () => {
    mocks.getDiscoveredBrandByDomain.mockResolvedValue(null);
    mocks.fetchBrandData.mockResolvedValue({
      success: true,
      domain: 'standalone.test',
      manifest: { name: 'Standalone', url: 'https://standalone.test' },
      highQuality: true,
    });
    mocks.classifyBrand.mockResolvedValue({
      keller_type: 'master',
      house_domain: null,
      parent_brand: null,
      canonical_domain: 'standalone.test',
      related_domains: [],
      confidence: 'high',
      reasoning: 'Top-level brand',
    });

    const { enrichBrand } = await import('../../src/services/brand-enrichment.js');
    const result = await enrichBrand('standalone.test');

    expect(result.status).toBe('enriched');
    expect(mocks.upsertDiscoveredBrand).toHaveBeenCalledWith(expect.objectContaining({
      house_domain: null,
      house_domain_audit: {
        actor_user_id: 'system:brand-classifier',
        source: 'classifier',
      },
    }));
  });
});
