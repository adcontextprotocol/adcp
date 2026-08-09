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
});
