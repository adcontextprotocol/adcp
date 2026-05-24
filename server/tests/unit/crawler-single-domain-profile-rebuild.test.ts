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
});
