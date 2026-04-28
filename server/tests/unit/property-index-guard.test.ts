import { describe, it, expect, beforeEach } from 'vitest';
import { getPropertyIndex } from '@adcp/client';
import { hardenPropertyIndex } from '../../src/discovery/property-index-guard.js';

describe('hardenPropertyIndex', () => {
  beforeEach(() => {
    getPropertyIndex().clear();
  });

  it('addProperty no longer throws when identifiers is missing', () => {
    hardenPropertyIndex();
    const index = getPropertyIndex();
    const property = {
      property_type: 'website',
      name: 'example.com',
    } as unknown as Parameters<typeof index.addProperty>[0];

    expect(() =>
      index.addProperty(property, 'https://agent.example.com', 'example.com'),
    ).not.toThrow();

    const auth = index.getAgentAuthorizations('https://agent.example.com');
    expect(auth?.properties).toHaveLength(1);
    expect(auth?.publisher_domains).toContain('example.com');
  });

  it('addProperty still indexes identifiers when present', () => {
    hardenPropertyIndex();
    const index = getPropertyIndex();
    index.addProperty(
      {
        property_type: 'website',
        name: 'example.com',
        identifiers: [{ type: 'domain', value: 'example.com' }],
      },
      'https://agent.example.com',
      'example.com',
    );

    const matches = index.findAgentsForProperty('domain', 'example.com');
    expect(matches).toHaveLength(1);
    expect(matches[0].agent_url).toBe('https://agent.example.com');
  });
});
