import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getDiscoveredBrandByDomain: vi.fn(),
  upsertDiscoveredBrand: vi.fn(),
  fetchBrandData: vi.fn(),
  isBrandfetchConfigured: vi.fn(),
}));

vi.mock('../../src/db/brand-db.js', () => ({
  brandDb: {
    getDiscoveredBrandByDomain: mocks.getDiscoveredBrandByDomain,
    upsertDiscoveredBrand: mocks.upsertDiscoveredBrand,
  },
  BrandDatabase: class {},
}));

vi.mock('../../src/services/brandfetch.js', () => ({
  fetchBrandData: mocks.fetchBrandData,
  isBrandfetchConfigured: mocks.isBrandfetchConfigured,
  ENRICHMENT_CACHE_MAX_AGE_MS: 30 * 24 * 60 * 60 * 1000,
}));

vi.mock('../../src/db/member-db.js', () => ({
  MemberDatabase: class {},
}));

vi.mock('../../src/db/federated-index-db.js', () => ({
  FederatedIndexDatabase: class {},
}));

vi.mock('../../src/db/organization-db.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/db/organization-db.js')>(
    '../../src/db/organization-db.js'
  );
  return {
    ...actual,
    OrganizationDatabase: class {},
  };
});

vi.mock('../../src/agent-service.js', () => ({ AgentService: class {} }));
vi.mock('../../src/validator.js', () => ({ AgentValidator: class {} }));
vi.mock('../../src/federated-index.js', () => ({ FederatedIndexService: class {} }));
vi.mock('../../src/brand-manager.js', () => ({ BrandManager: class {} }));
vi.mock('../../src/adagents-manager.js', () => ({ AdAgentsManager: class {} }));

const { MCPToolHandler } = await import('../../src/mcp-tools.js');

function parseResource(result: Awaited<ReturnType<InstanceType<typeof MCPToolHandler>['handleToolCall']>>) {
  const first = result.content[0];
  if (first.type !== 'resource' || !first.resource) throw new Error('expected resource');
  return JSON.parse(first.resource.text);
}

describe('MCP enrich_brand Brand Context boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isBrandfetchConfigured.mockReturnValue(true);
    mocks.upsertDiscoveredBrand.mockResolvedValue({});
  });

  it('strips legacy brand_context from cached manifests', async () => {
    mocks.getDiscoveredBrandByDomain.mockResolvedValue({
      domain: 'acme.com',
      has_brand_manifest: true,
      last_validated: new Date(),
      source_type: 'enriched',
      brand_manifest: {
        name: 'Acme',
        url: 'https://acme.com',
        brand_context: { brand: { voice: { summary: 'legacy private context' } } },
      },
    });

    const handler = new MCPToolHandler();
    const result = await handler.handleToolCall('enrich_brand', { domain: 'https://acme.com/about' });
    const body = parseResource(result);

    expect(body).toMatchObject({
      success: true,
      domain: 'acme.com',
      cached: true,
      manifest: {
        name: 'Acme',
        url: 'https://acme.com',
      },
      source_type: 'enriched',
      enrichment_provider: 'brandfetch',
    });
    expect(body.manifest.brand_context).toBeUndefined();
    expect(body.context).toBeUndefined();
    expect(mocks.fetchBrandData).not.toHaveBeenCalled();
  });

  it('does not emit or persist Brand Context from fresh enrichment results', async () => {
    mocks.getDiscoveredBrandByDomain.mockResolvedValue(null);
    mocks.fetchBrandData.mockResolvedValue({
      success: true,
      domain: 'acme.com',
      raw: { id: 'bf_1', name: 'Acme', domain: 'acme.com' },
      manifest: {
        name: 'Acme',
        url: 'https://acme.com',
        description: 'Brand API description.',
      },
      context: {
        brand: { voice: { summary: 'private context' } },
      },
      highQuality: true,
    });

    const handler = new MCPToolHandler();
    const result = await handler.handleToolCall('enrich_brand', { domain: 'acme.com' });
    const body = parseResource(result);

    expect(mocks.fetchBrandData).toHaveBeenCalledWith('acme.com');
    expect(body.context).toBeUndefined();
    expect(body.manifest.brand_context).toBeUndefined();
    expect(body.manifest).toEqual({
      name: 'Acme',
      url: 'https://acme.com',
      description: 'Brand API description.',
    });
    expect(mocks.upsertDiscoveredBrand).toHaveBeenCalledWith(expect.objectContaining({
      domain: 'acme.com',
      brand_name: 'Acme',
      source_type: 'enriched',
      brand_manifest: {
        name: 'Acme',
        url: 'https://acme.com',
        description: 'Brand API description.',
      },
    }));
  });
});
