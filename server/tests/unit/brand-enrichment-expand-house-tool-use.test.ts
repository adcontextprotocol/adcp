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
  fetchBrandData: vi.fn(),
  isBrandfetchConfigured: () => false,
  ENRICHMENT_CACHE_MAX_AGE_MS: 86_400_000,
}));

vi.mock('../../src/services/logo-cdn.js', () => ({
  downloadAndCacheLogos: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../src/services/brand-classifier.js', () => ({
  classifyBrand: vi.fn().mockResolvedValue(null),
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

    // Default house: a master brand
    mocks.getDiscoveredBrandByDomain.mockResolvedValue({
      domain: 'pg.com',
      brand_name: 'P&G',
      keller_type: 'master',
      brand_manifest: { company: { industries: ['cpg'] } },
    });
    mocks.query.mockResolvedValue({ rows: [] }); // no existing sub-brands
    mocks.upsertDiscoveredBrand.mockResolvedValue({});

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
  });

  it('throws when the model does not emit a tool_use block (defensive)', async () => {
    mocks.anthropicCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'I refuse' }],
    });

    await expect(expandHouse('pg.com', { enrichAfterSeed: false })).rejects.toThrow(
      /Failed to parse brand discovery response/,
    );
  });
});
