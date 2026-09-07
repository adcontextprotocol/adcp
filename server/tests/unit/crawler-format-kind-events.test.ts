import { describe, expect, it, vi } from 'vitest';

describe('CrawlerService canonical format-kind events', () => {
  it('emits DB-derived format kinds for newly discovered agents', async () => {
    const { CrawlerService } = await import('../../src/crawler.js');
    const ctx = Object.create((CrawlerService as any).prototype);
    const writeEvents = vi.fn().mockResolvedValue(undefined);

    Object.assign(ctx, {
      federatedIndex: {
        listAllAgents: vi.fn().mockResolvedValue([{ url: 'https://creative.example.com/mcp' }]),
        getDomainsForAgent: vi.fn().mockResolvedValue(['publisher.example.com']),
        getPropertiesForAgent: vi.fn().mockResolvedValue([]),
        getAllAgentDomainPairs: vi.fn().mockResolvedValue(new Map([
          ['https://creative.example.com/mcp', new Set(['publisher.example.com'])],
        ])),
      },
      profilesDb: {
        upsertProfiles: vi.fn().mockResolvedValue([{
          agent_url: 'https://creative.example.com/mcp',
          channels: [],
          property_types: [],
          markets: [],
          categories: [],
          tags: [],
          delivery_types: [],
          format_ids: [],
          format_kinds: ['image', 'video'],
          property_count: 0,
          publisher_count: 1,
          has_tmp: false,
          category_taxonomy: null,
          updated_at: new Date(),
        }]),
        deleteStaleProfiles: vi.fn().mockResolvedValue(0),
      },
      eventsDb: { writeEvents },
    });

    const profiles = await ctx.buildInventoryProfiles({ deleteStale: false });
    await ctx.produceEventsFromDiff(new Map(), profiles);

    expect(profiles.get('https://creative.example.com/mcp')?.format_kinds).toEqual(['image', 'video']);
    expect(writeEvents).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          event_type: 'agent.discovered',
          payload: expect.objectContaining({
            agent_url: 'https://creative.example.com/mcp',
            format_kinds: ['image', 'video'],
          }),
        }),
      ]),
    );
  });

  it('emits agent.profile_updated for an already-known agent whose profile changed', async () => {
    const { CrawlerService } = await import('../../src/crawler.js');
    const ctx = Object.create((CrawlerService as any).prototype);
    const writeEvents = vi.fn().mockResolvedValue(undefined);
    const agentUrl = 'https://creative.example.com/mcp';

    Object.assign(ctx, {
      // produceEventsFromDiff calls snapshotAgentState() internally to get
      // post-crawl state, which re-derives from this same source.
      federatedIndex: {
        getAllAgentDomainPairs: vi.fn().mockResolvedValue(
          new Map([[agentUrl, new Set(['publisher.example.com'])]]),
        ),
      },
      eventsDb: { writeEvents },
    });

    const preCrawlAgents = new Map([[agentUrl, { domains: new Set(['publisher.example.com']) }]]);
    const previousProfile = {
      agent_url: agentUrl,
      channels: ['display'],
      property_types: ['website'],
      markets: ['US'],
      categories: [],
      tags: [],
      delivery_types: [],
      format_ids: [],
      format_kinds: ['image'],
      property_count: 1,
      publisher_count: 1,
      has_tmp: false,
      category_taxonomy: null,
      updated_at: new Date('2026-01-01'),
    };
    const newProfile: any = {
      agent_url: agentUrl,
      channels: ['display', 'ctv'],
      property_types: ['website', 'ctv_app'],
      markets: ['US'],
      categories: [],
      tags: [],
      delivery_types: [],
      format_kinds: ['image'],
      property_count: 2,
      publisher_count: 1,
      has_tmp: false,
      category_taxonomy: null,
    };

    await ctx.produceEventsFromDiff(
      preCrawlAgents,
      new Map([[agentUrl, newProfile]]),
      new Map([[agentUrl, previousProfile]]),
    );

    expect(writeEvents).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          event_type: 'agent.profile_updated',
          entity_type: 'agent',
          entity_id: agentUrl,
          payload: expect.objectContaining({
            agent_url: agentUrl,
            channels: ['display', 'ctv'],
            property_types: ['website', 'ctv_app'],
            property_count: 2,
            changed_fields: expect.arrayContaining(['channels', 'property_types', 'property_count']),
          }),
        }),
      ]),
    );
    // Nothing else should have fired: the agent is neither newly discovered
    // nor removed, and its authorizations are unchanged.
    expect(writeEvents).toHaveBeenCalledWith([
      expect.objectContaining({ event_type: 'agent.profile_updated' }),
    ]);
  });

  it('does not emit agent.profile_updated when the built profile is unchanged', async () => {
    const { CrawlerService } = await import('../../src/crawler.js');
    const ctx = Object.create((CrawlerService as any).prototype);
    const writeEvents = vi.fn().mockResolvedValue(undefined);
    const agentUrl = 'https://stable.example.com/mcp';

    Object.assign(ctx, {
      federatedIndex: {
        getAllAgentDomainPairs: vi.fn().mockResolvedValue(
          new Map([[agentUrl, new Set(['publisher.example.com'])]]),
        ),
      },
      eventsDb: { writeEvents },
    });

    const preCrawlAgents = new Map([[agentUrl, { domains: new Set(['publisher.example.com']) }]]);
    const profile: any = {
      agent_url: agentUrl,
      channels: ['display'],
      property_types: ['website'],
      markets: ['US'],
      categories: [],
      tags: [],
      delivery_types: [],
      format_kinds: ['image'],
      property_count: 1,
      publisher_count: 1,
      has_tmp: false,
      category_taxonomy: null,
    };
    const previousProfile = { ...profile, format_ids: [], updated_at: new Date('2026-01-01') };

    await ctx.produceEventsFromDiff(
      preCrawlAgents,
      new Map([[agentUrl, profile]]),
      new Map([[agentUrl, previousProfile]]),
    );

    expect(writeEvents).not.toHaveBeenCalled();
  });

  it('preserves a high-fanout agent profile during full-crawl stale cleanup', async () => {
    const { CrawlerService } = await import('../../src/crawler.js');
    const ctx = Object.create((CrawlerService as any).prototype);
    const normalAgent = 'https://normal.example.com/mcp';
    const networkAgent = 'https://network.example.com/mcp';
    const deleteStaleProfiles = vi.fn().mockResolvedValue(0);
    const getPropertiesForAgent = vi.fn().mockResolvedValue([]);

    Object.assign(ctx, {
      federatedIndex: {
        listAllAgents: vi.fn().mockResolvedValue([
          { url: normalAgent },
          { url: networkAgent },
        ]),
        getDomainsForAgent: vi.fn(async (agentUrl: string) => (
          agentUrl === networkAgent
            ? Array.from({ length: 1_001 }, (_, index) => `publisher-${index}.example`)
            : ['publisher.example']
        )),
        getPropertiesForAgent,
      },
      profilesDb: {
        upsertProfiles: vi.fn().mockImplementation(async (profiles: unknown[]) => profiles),
        deleteStaleProfiles,
      },
    });

    await ctx.buildInventoryProfiles();

    expect(getPropertiesForAgent).toHaveBeenCalledTimes(1);
    expect(getPropertiesForAgent).toHaveBeenCalledWith(normalAgent);
    expect(deleteStaleProfiles).toHaveBeenCalledWith([normalAgent, networkAgent]);
  });
});
