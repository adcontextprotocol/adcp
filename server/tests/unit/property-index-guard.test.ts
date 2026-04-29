import { describe, it, expect, beforeEach } from 'vitest';
import { getPropertyIndex } from '@adcp/client';
import {
  hardenPropertyIndex,
  sanitizeAdagentsProperty,
} from '../../src/discovery/property-index-guard.js';

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

describe('sanitizeAdagentsProperty', () => {
  const ctx = { publisherDomain: 'example.com', agentUrl: 'https://agent.example.com' };

  it('returns null when property_type is missing', () => {
    expect(sanitizeAdagentsProperty({ name: 'example.com' }, ctx)).toBeNull();
  });

  it('returns null when name is missing', () => {
    expect(sanitizeAdagentsProperty({ property_type: 'website' }, ctx)).toBeNull();
  });

  it('returns null for non-object input', () => {
    expect(sanitizeAdagentsProperty(null, ctx)).toBeNull();
    expect(sanitizeAdagentsProperty(undefined, ctx)).toBeNull();
    expect(sanitizeAdagentsProperty('string', ctx)).toBeNull();
  });

  it('coerces a missing identifiers array to empty', () => {
    const result = sanitizeAdagentsProperty(
      { property_type: 'website', name: 'example.com' },
      ctx,
    );
    expect(result).not.toBeNull();
    expect(result?.identifiers).toEqual([]);
  });

  it('coerces a non-array identifiers value to empty', () => {
    const result = sanitizeAdagentsProperty(
      { property_type: 'website', name: 'example.com', identifiers: 'not-an-array' },
      ctx,
    );
    expect(result?.identifiers).toEqual([]);
  });

  it('preserves valid identifiers and optional fields', () => {
    const result = sanitizeAdagentsProperty(
      {
        property_id: 'p-1',
        property_type: 'website',
        name: 'example.com',
        identifiers: [{ type: 'domain', value: 'example.com' }],
        tags: ['premium'],
        publisher_domain: 'overridden.com',
      },
      ctx,
    );
    expect(result).toEqual({
      property_id: 'p-1',
      property_type: 'website',
      name: 'example.com',
      identifiers: [{ type: 'domain', value: 'example.com' }],
      tags: ['premium'],
      publisher_domain: 'overridden.com',
    });
  });
});
