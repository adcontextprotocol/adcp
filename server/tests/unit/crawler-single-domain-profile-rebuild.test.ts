import { describe, expect, it, vi } from 'vitest';

describe('CrawlerService single-domain profile rebuild', () => {
  async function makeCrawlerContext(params: {
    existingAuthorizations: Array<{ agent_url: string; source: string }>;
    authorizedAgents: Array<{ url: string }>;
  }) {
    const { CrawlerService } = await import('../../src/crawler.js');
    const proto = (CrawlerService as any).prototype;
    const ctx = Object.create(proto);

    Object.assign(ctx, {
      crawling: false,
      adAgentsManager: {
        validateDomain: vi.fn().mockResolvedValue({
          valid: true,
          raw_data: {
            authorized_agents: params.authorizedAgents,
            properties: [],
          },
          status_code: 200,
          response_bytes: 128,
          resolved_url: 'https://publisher.example/.well-known/adagents.json',
          discovery_method: 'direct',
          manager_domain: null,
        }),
      },
      federatedIndex: {
        getAuthorizationsForDomain: vi.fn().mockResolvedValue(params.existingAuthorizations),
        recordAgentFromAdagentsJson: vi.fn().mockResolvedValue(undefined),
        reconcileAdagentsAuthorizations: vi.fn().mockResolvedValue(undefined),
      },
      cacheAdagentsManifest: vi.fn().mockResolvedValue(undefined),
      scanBrandForDomain: vi.fn().mockResolvedValue(undefined),
      buildInventoryProfiles: vi.fn().mockResolvedValue(new Map()),
    });

    return ctx;
  }

  it('rebuilds profiles for agents removed from the prior manifest', async () => {
    const ctx = await makeCrawlerContext({
      existingAuthorizations: [
        { agent_url: 'https://old-agent.example/mcp/', source: 'adagents_json' },
        { agent_url: 'https://claimed-agent.example/mcp', source: 'agent_claim' },
      ],
      authorizedAgents: [{ url: 'https://new-agent.example/mcp/' }],
    });

    await ctx.crawlSingleDomain('publisher.example');

    expect(ctx.buildInventoryProfiles).toHaveBeenCalledWith({
      agentUrls: ['https://old-agent.example/mcp', 'https://new-agent.example/mcp'],
      deleteStale: false,
    });
  });

  it('rebuilds prior agents when a manifest becomes empty', async () => {
    const ctx = await makeCrawlerContext({
      existingAuthorizations: [
        { agent_url: 'https://old-agent.example/mcp/', source: 'adagents_json' },
      ],
      authorizedAgents: [],
    });

    await ctx.crawlSingleDomain('publisher.example');

    expect(ctx.buildInventoryProfiles).toHaveBeenCalledWith({
      agentUrls: ['https://old-agent.example/mcp'],
      deleteStale: false,
    });
  });

  it('manual adagents revalidation persists a successful verdict and refreshed authorizations', async () => {
    const { CrawlerService } = await import('../../src/crawler.js');
    const proto = (CrawlerService as any).prototype;
    const ctx = Object.create(proto);

    Object.assign(ctx, {
      adAgentsManager: {
        validateDomain: vi.fn().mockResolvedValue({
          valid: true,
          errors: [],
          warnings: [],
          domain: 'publisher.example',
          url: 'https://publisher.example/.well-known/adagents.json',
          raw_data: {
            authorized_agents: [{ url: 'https://new-agent.example/mcp/', authorized_for: 'display' }],
            properties: [{ property_id: 'site', property_type: 'website', name: 'Site' }],
          },
          status_code: 200,
          response_bytes: 256,
          resolved_url: 'https://publisher.example/.well-known/adagents.json',
          discovery_method: 'direct',
        }),
      },
      federatedIndex: {
        getAuthorizationsForDomain: vi.fn().mockResolvedValue([
          { agent_url: 'https://old-agent.example/mcp/', source: 'adagents_json' },
        ]),
        markPublisherHasValidAdagents: vi.fn().mockResolvedValue(undefined),
        recordAgentFromAdagentsJson: vi.fn().mockResolvedValue(undefined),
        reconcileAdagentsAuthorizations: vi.fn().mockResolvedValue(undefined),
      },
      publisherDb: {
        recordAdagentsValidationFailure: vi.fn().mockResolvedValue(undefined),
      },
      cacheAdagentsManifest: vi.fn().mockResolvedValue(undefined),
      recordPropertiesForAgent: vi.fn().mockResolvedValue(undefined),
      fanOutPublisherPropertiesAuthorizations: vi.fn().mockResolvedValue(undefined),
      reconcileLegacyAdagentsAgents: vi.fn().mockResolvedValue(undefined),
      scanBrandForDomain: vi.fn().mockResolvedValue(undefined),
      buildInventoryProfiles: vi.fn().mockResolvedValue(new Map()),
    });

    const result = await ctx.revalidatePublisherAdagents('publisher.example', { force: true });

    expect(result).toMatchObject({
      domain: 'publisher.example',
      adagents_valid: true,
      properties_count: 1,
      authorized_agents_count: 1,
      status_code: 200,
    });
    expect(ctx.cacheAdagentsManifest).toHaveBeenCalledWith(
      'publisher.example',
      expect.objectContaining({ authorized_agents: expect.any(Array) }),
      expect.objectContaining({ statusCode: 200, discoveryMethod: 'direct' }),
    );
    expect(ctx.federatedIndex.markPublisherHasValidAdagents).toHaveBeenCalledWith('publisher.example');
    expect(ctx.federatedIndex.recordAgentFromAdagentsJson).toHaveBeenCalledWith(
      'https://new-agent.example/mcp/',
      'publisher.example',
      'display',
      undefined,
    );
    expect(ctx.buildInventoryProfiles).toHaveBeenCalledWith({
      agentUrls: ['https://old-agent.example/mcp', 'https://new-agent.example/mcp'],
      deleteStale: false,
    });
  });

  it('manual adagents revalidation returns warnings for a valid manifest', async () => {
    const { CrawlerService } = await import('../../src/crawler.js');
    const proto = (CrawlerService as any).prototype;
    const ctx = Object.create(proto);

    Object.assign(ctx, {
      adAgentsManager: {
        validateDomain: vi.fn().mockResolvedValue({
          valid: true,
          errors: [],
          warnings: [{ field: '$schema', message: 'Missing schema declaration' }],
          domain: 'publisher.example',
          url: 'https://publisher.example/.well-known/adagents.json',
          raw_data: {
            authorized_agents: [{ url: 'https://new-agent.example/mcp/' }],
            properties: [],
          },
          status_code: 200,
          response_bytes: 128,
          resolved_url: 'https://publisher.example/.well-known/adagents.json',
          discovery_method: 'direct',
        }),
      },
      federatedIndex: {
        getAuthorizationsForDomain: vi.fn().mockResolvedValue([]),
        markPublisherHasValidAdagents: vi.fn().mockResolvedValue(undefined),
        recordAgentFromAdagentsJson: vi.fn().mockResolvedValue(undefined),
        reconcileAdagentsAuthorizations: vi.fn().mockResolvedValue(undefined),
      },
      publisherDb: {},
      cacheAdagentsManifest: vi.fn().mockResolvedValue(undefined),
      recordPropertiesForAgent: vi.fn().mockResolvedValue(undefined),
      fanOutPublisherPropertiesAuthorizations: vi.fn().mockResolvedValue(undefined),
      reconcileLegacyAdagentsAgents: vi.fn().mockResolvedValue(undefined),
      scanBrandForDomain: vi.fn().mockResolvedValue(undefined),
      buildInventoryProfiles: vi.fn().mockResolvedValue(new Map()),
    });

    const result = await ctx.revalidatePublisherAdagents('publisher.example');

    expect(result).toMatchObject({
      domain: 'publisher.example',
      adagents_valid: true,
      issues: {
        errors: [],
        warnings: [{ field: '$schema', message: 'Missing schema declaration' }],
      },
    });
  });

  it('manual adagents revalidation persists an invalid verdict and retires stale authorizations', async () => {
    const { CrawlerService } = await import('../../src/crawler.js');
    const proto = (CrawlerService as any).prototype;
    const ctx = Object.create(proto);

    Object.assign(ctx, {
      adAgentsManager: {
        validateDomain: vi.fn().mockResolvedValue({
          valid: false,
          errors: [{ field: 'http_status', message: 'File not found', severity: 'error' }],
          warnings: [],
          domain: 'publisher.example',
          url: 'https://publisher.example/.well-known/adagents.json',
          status_code: 404,
          response_bytes: 32,
          resolved_url: 'https://publisher.example/.well-known/adagents.json',
          discovery_method: 'direct',
        }),
      },
      federatedIndex: {
        getAuthorizationsForDomain: vi.fn().mockResolvedValue([
          { agent_url: 'https://old-agent.example/mcp/', source: 'adagents_json' },
          { agent_url: 'https://claimed-agent.example/mcp', source: 'agent_claim' },
        ]),
        markPublisherHasInvalidAdagents: vi.fn().mockResolvedValue(undefined),
        reconcileAdagentsAuthorizations: vi.fn().mockResolvedValue(undefined),
      },
      publisherDb: {
        recordAdagentsValidationFailure: vi.fn().mockResolvedValue(undefined),
      },
      scanBrandForDomain: vi.fn().mockResolvedValue(undefined),
      buildInventoryProfiles: vi.fn().mockResolvedValue(new Map()),
    });

    const result = await ctx.revalidatePublisherAdagents('publisher.example');

    expect(result).toMatchObject({
      domain: 'publisher.example',
      adagents_valid: false,
      error: 'File not found',
      properties_count: 0,
      authorized_agents_count: 0,
      status_code: 404,
    });
    expect(ctx.publisherDb.recordAdagentsValidationFailure).toHaveBeenCalledWith(expect.objectContaining({
      domain: 'publisher.example',
      statusCode: 404,
      error: 'File not found',
      issues: {
        errors: [{ field: 'http_status', message: 'File not found', severity: 'error' }],
        warnings: [],
      },
    }));
    expect(ctx.federatedIndex.markPublisherHasInvalidAdagents).toHaveBeenCalledWith('publisher.example');
    expect(ctx.federatedIndex.reconcileAdagentsAuthorizations).toHaveBeenCalledWith('publisher.example', []);
    expect(ctx.buildInventoryProfiles).toHaveBeenCalledWith({
      agentUrls: ['https://old-agent.example/mcp'],
      deleteStale: false,
    });
  });

  it('manual adagents revalidation persists schema-invalid 200 responses as invalid', async () => {
    const { CrawlerService } = await import('../../src/crawler.js');
    const proto = (CrawlerService as any).prototype;
    const ctx = Object.create(proto);

    Object.assign(ctx, {
      adAgentsManager: {
        validateDomain: vi.fn().mockResolvedValue({
          valid: false,
          errors: [{ field: 'authorized_agents', message: 'authorized_agents must be an array', severity: 'error' }],
          warnings: [],
          domain: 'publisher.example',
          url: 'https://publisher.example/.well-known/adagents.json',
          raw_data: { authorized_agents: 'not-an-array' },
          status_code: 200,
          response_bytes: 96,
          resolved_url: 'https://publisher.example/.well-known/adagents.json',
          discovery_method: 'direct',
        }),
      },
      federatedIndex: {
        getAuthorizationsForDomain: vi.fn().mockResolvedValue([]),
        markPublisherHasInvalidAdagents: vi.fn().mockResolvedValue(undefined),
        reconcileAdagentsAuthorizations: vi.fn().mockResolvedValue(undefined),
      },
      publisherDb: {
        recordAdagentsValidationFailure: vi.fn().mockResolvedValue(undefined),
      },
      scanBrandForDomain: vi.fn().mockResolvedValue(undefined),
      buildInventoryProfiles: vi.fn().mockResolvedValue(new Map()),
    });

    const result = await ctx.revalidatePublisherAdagents('publisher.example');

    expect(result).toMatchObject({
      domain: 'publisher.example',
      adagents_valid: false,
      error: 'authorized_agents must be an array',
      status_code: 200,
      issues: {
        errors: [{ field: 'authorized_agents', message: 'authorized_agents must be an array', severity: 'error' }],
        warnings: [],
      },
    });
    expect(ctx.publisherDb.recordAdagentsValidationFailure).toHaveBeenCalledWith(expect.objectContaining({
      domain: 'publisher.example',
      statusCode: 200,
      error: 'authorized_agents must be an array',
    }));
  });
});
