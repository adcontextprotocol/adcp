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
          type: 'sales',
          authorized_by: [
            {
              publisher_domain: 'voxmedia.com',
              authorized_for: 'sales',
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
          type: 'sales',
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
          authorized_for: 'sales',
          source: 'adagents_json' as const,
        },
      ],
    };

    const result = PublisherLookupResultSchema.safeParse(data);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.properties).toHaveLength(1);
      expect(result.data.authorized_agents).toHaveLength(1);
    }
  });

  it('validates an unfound publisher', () => {
    const data = {
      domain: 'unknown.com',
      member: null,
      adagents_valid: false,
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
      properties: [],
      authorized_agents: [],
    };

    const result = PublisherLookupResultSchema.safeParse(data);
    expect(result.success).toBe(true);
  });
});
