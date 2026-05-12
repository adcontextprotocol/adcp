import { describe, it, expect } from 'vitest';
import { extractDeclaredProperties } from '../../server/src/services/network-consistency-reporter.js';

describe('extractDeclaredProperties', () => {
  it('returns [] when brand_json is null (brand row without a manifest)', () => {
    // Brand rows can exist without a manifest (registry sync,
    // manifest_orphaned trigger, partial onboarding). The worker
    // previously crashed with "Cannot read properties of null
    // (reading 'brands')" when this happened.
    expect(extractDeclaredProperties(null)).toEqual([]);
    expect(extractDeclaredProperties(undefined)).toEqual([]);
  });

  it('returns [] when brand_json is not an object', () => {
    // Defensive: the column is JSONB so this is unreachable in
    // practice, but the type signature allows `unknown` callers.
    expect(extractDeclaredProperties('not-an-object' as unknown as Record<string, unknown>)).toEqual([]);
  });

  it('returns [] when brands key is missing or not an array', () => {
    expect(extractDeclaredProperties({})).toEqual([]);
    expect(extractDeclaredProperties({ brands: 'oops' })).toEqual([]);
  });

  it('extracts identifier, type, and relationship from each property', () => {
    const out = extractDeclaredProperties({
      brands: [
        {
          properties: [
            { identifier: 'acme.com', type: 'website', relationship: 'owned' },
            { identifier: 'partner.com', type: 'website', relationship: 'delegated' },
          ],
        },
      ],
    });
    expect(out).toEqual([
      { identifier: 'acme.com', type: 'website', relationship: 'owned' },
      { identifier: 'partner.com', type: 'website', relationship: 'delegated' },
    ]);
  });

  it('defaults type to "website" and relationship to "owned"', () => {
    const out = extractDeclaredProperties({
      brands: [{ properties: [{ identifier: 'acme.com' }] }],
    });
    expect(out).toEqual([
      { identifier: 'acme.com', type: 'website', relationship: 'owned' },
    ]);
  });

  it('skips properties without an identifier', () => {
    const out = extractDeclaredProperties({
      brands: [
        {
          properties: [
            { type: 'website' },
            { identifier: '', type: 'website' },
            { identifier: 'ok.com' },
          ],
        },
      ],
    });
    expect(out.map((p) => p.identifier)).toEqual(['ok.com']);
  });
});
