import { describe, it, expect } from 'vitest';
import {
  OperatorLookupResultSchema,
  PublisherLookupResultSchema,
} from '../../src/schemas/registry.js';

describe('OperatorLookupResult schema', () => {
  it('validates a found operator with agents', () => {
    const data = {
      domain: 'pubmatic.com',
      member: { slug: 'pubmatic', display_name: 'PubMatic' },
      agents: [
        {
          url: 'https://sales.pubmatic.com/mcp',
          name: 'PubMatic Sales Agent',
          type: 'buying',
          authorized_by: [
            {
              publisher_domain: 'voxmedia.com',
              authorized_for: 'buying',
              source: 'adagents_json' as const,
            },
            {
              publisher_domain: 'theverge.com',
              source: 'agent_claim' as const,
            },
          ],
        },
      ],
    };

    const result = OperatorLookupResultSchema.safeParse(data);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.agents).toHaveLength(1);
      expect(result.data.agents[0].authorized_by).toHaveLength(2);
    }
  });

  it('validates an unfound operator', () => {
    const data = {
      domain: 'unknown.com',
      member: null,
      agents: [],
    };

    const result = OperatorLookupResultSchema.safeParse(data);
    expect(result.success).toBe(true);
  });

  it('rejects invalid agent type', () => {
    const data = {
      domain: 'test.com',
      member: null,
      agents: [
        {
          url: 'https://agent.test.com/mcp',
          name: 'Test Agent',
          type: 'invalid_type',
          authorized_by: [],
        },
      ],
    };

    const result = OperatorLookupResultSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it('rejects invalid authorization source', () => {
    const data = {
      domain: 'test.com',
      member: null,
      agents: [
        {
          url: 'https://agent.test.com/mcp',
          name: 'Test Agent',
          type: 'buying',
          authorized_by: [
            {
              publisher_domain: 'pub.com',
              source: 'invalid_source',
            },
          ],
        },
      ],
    };

    const result = OperatorLookupResultSchema.safeParse(data);
    expect(result.success).toBe(false);
  });
});

describe('PublisherLookupResult schema', () => {
  it('validates a found publisher with properties and agents', () => {
    const data = {
      domain: 'voxmedia.com',
      member: { slug: 'voxmedia', display_name: 'Vox Media' },
      adagents_valid: true,
      hosting: {
        mode: 'self' as const,
        expected_url: 'https://voxmedia.com/.well-known/adagents.json',
      },
      properties: [
        {
          id: 'theverge',
          type: 'website',
          name: 'The Verge',
          identifiers: [{ type: 'domain', value: 'theverge.com' }],
          tags: ['tech', 'news'],
        },
      ],
      authorized_agents: [
        {
          url: 'https://sales.pubmatic.com/mcp',
          authorized_for: 'buying',
          source: 'adagents_json' as const,
        },
      ],
    };

    const result = PublisherLookupResultSchema.safeParse(data);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.properties).toHaveLength(1);
      expect(result.data.authorized_agents).toHaveLength(1);
      expect(result.data.hosting.mode).toBe('self');
    }
  });

  it('validates an unfound publisher', () => {
    const data = {
      domain: 'unknown.com',
      member: null,
      adagents_valid: false,
      hosting: {
        mode: 'none' as const,
        expected_url: 'https://unknown.com/.well-known/adagents.json',
      },
      properties: [],
      authorized_agents: [],
    };

    const result = PublisherLookupResultSchema.safeParse(data);
    expect(result.success).toBe(true);
  });

  it('validates with null adagents_valid', () => {
    const data = {
      domain: 'test.com',
      member: null,
      adagents_valid: null,
      hosting: {
        mode: 'none' as const,
        expected_url: 'https://test.com/.well-known/adagents.json',
      },
      properties: [],
      authorized_agents: [],
    };

    const result = PublisherLookupResultSchema.safeParse(data);
    expect(result.success).toBe(true);
  });

  it('validates aao_hosted mode with hosted_url', () => {
    const data = {
      domain: 'sasha-media.com',
      member: null,
      adagents_valid: null,
      hosting: {
        mode: 'aao_hosted' as const,
        hosted_url: 'https://agenticadvertising.org/publisher/sasha-media.com/.well-known/adagents.json',
        expected_url: 'https://sasha-media.com/.well-known/adagents.json',
      },
      properties: [],
      authorized_agents: [],
    };

    const result = PublisherLookupResultSchema.safeParse(data);
    expect(result.success).toBe(true);
  });

  it('validates aao_hosted source on agent rows (origin-not-verified label)', () => {
    const data = {
      domain: 'sasha-media.com',
      member: null,
      adagents_valid: null,
      hosting: {
        mode: 'aao_hosted' as const,
        hosted_url: 'https://agenticadvertising.org/publisher/sasha-media.com/.well-known/adagents.json',
        expected_url: 'https://sasha-media.com/.well-known/adagents.json',
      },
      properties: [],
      authorized_agents: [
        {
          url: 'https://agent.example',
          source: 'aao_hosted' as const,
          properties_authorized: 0,
          properties_total: 0,
          publisher_wide: true,
        },
      ],
    };
    const result = PublisherLookupResultSchema.safeParse(data);
    expect(result.success).toBe(true);
  });

  it('validates self_invalid hosting mode', () => {
    const data = {
      domain: 'broken.example',
      member: null,
      adagents_valid: false,
      hosting: {
        mode: 'self_invalid' as const,
        expected_url: 'https://broken.example/.well-known/adagents.json',
      },
      properties: [],
      authorized_agents: [],
    };
    const result = PublisherLookupResultSchema.safeParse(data);
    expect(result.success).toBe(true);
  });

  it('validates per-agent publisher_wide flag', () => {
    const data = {
      domain: 'voxmedia.com',
      member: null,
      adagents_valid: true,
      hosting: {
        mode: 'self' as const,
        expected_url: 'https://voxmedia.com/.well-known/adagents.json',
      },
      properties: [{ id: 'theverge', type: 'website', name: 'The Verge' }],
      authorized_agents: [
        {
          url: 'https://agent-a.example',
          source: 'adagents_json' as const,
          properties_authorized: 1,
          properties_total: 1,
          publisher_wide: true,
        },
        {
          url: 'https://agent-b.example',
          source: 'adagents_json' as const,
          properties_authorized: 0,
          properties_total: 1,
          publisher_wide: false,
        },
      ],
    };
    const result = PublisherLookupResultSchema.safeParse(data);
    expect(result.success).toBe(true);
  });

  it('validates rollup_truncated as { cap, total_agents }', () => {
    const data = {
      domain: 'big.example',
      member: null,
      adagents_valid: true,
      hosting: {
        mode: 'self' as const,
        expected_url: 'https://big.example/.well-known/adagents.json',
      },
      properties: [],
      authorized_agents: [],
      rollup_truncated: { cap: 50, total_agents: 137 },
    };
    const result = PublisherLookupResultSchema.safeParse(data);
    expect(result.success).toBe(true);
  });
});
