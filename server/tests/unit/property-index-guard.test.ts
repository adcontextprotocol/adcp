import { describe, it, expect } from 'vitest';
import { sanitizeAdagentsProperty } from '../../src/discovery/property-index-guard.js';

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
