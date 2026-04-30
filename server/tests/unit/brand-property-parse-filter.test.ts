/**
 * Unit tests for the load-bearing output filter inside the brand-property
 * parse service. The HTTP route + Addie tool both lean on this filter to
 * bound whatever the LLM (or a hostile URL body) returns:
 *
 *   - DNS 253-char identifier cap
 *   - Type allowlist (VALID_PROPERTY_TYPES)
 *   - Lowercase + trim
 *   - MAX_PROPERTIES (500) cap on the returned slice
 *
 * The integration suite at server/tests/integration/brand-properties-parse.test.ts
 * covers the route end-to-end. This file pins the pure function so the
 * defense survives refactors.
 */
import { describe, it, expect } from 'vitest';
import {
  filterPropertyCandidates,
  MAX_PROPERTIES,
} from '../../src/services/brand-property-parse.js';

describe('filterPropertyCandidates', () => {
  it('keeps valid candidates and stamps the supplied relationship', () => {
    const out = filterPropertyCandidates(
      [
        { identifier: 'cnn.com', type: 'website' },
        { identifier: 'com.example.app', type: 'mobile_app' },
      ],
      'delegated',
    );
    expect(out).toEqual([
      { identifier: 'cnn.com', type: 'website', relationship: 'delegated' },
      { identifier: 'com.example.app', type: 'mobile_app', relationship: 'delegated' },
    ]);
  });

  it('drops identifiers exceeding the DNS 253-char cap', () => {
    const tooLong = 'a'.repeat(254) + '.example';
    const out = filterPropertyCandidates(
      [
        { identifier: tooLong, type: 'website' },
        { identifier: 'ok.example', type: 'website' },
      ],
      'delegated',
    );
    expect(out).toHaveLength(1);
    expect(out[0].identifier).toBe('ok.example');
  });

  it('drops types not in the allowlist (defensive — schema enum should already catch)', () => {
    const out = filterPropertyCandidates(
      [
        { identifier: 'a.example', type: 'website' },
        { identifier: 'b.example', type: 'crystal_ball' },
        { identifier: 'c.example', type: 'podcast' },
      ],
      'delegated',
    );
    expect(out.map((p) => p.type)).toEqual(['website', 'podcast']);
  });

  it('lowercases identifiers', () => {
    const out = filterPropertyCandidates(
      [{ identifier: 'EXAMPLE.COM', type: 'website' }],
      'delegated',
    );
    expect(out[0].identifier).toBe('example.com');
  });

  it('trims whitespace around identifiers', () => {
    const out = filterPropertyCandidates(
      [{ identifier: '  example.com  ', type: 'website' }],
      'delegated',
    );
    expect(out[0].identifier).toBe('example.com');
  });

  it('drops empty / non-string identifiers', () => {
    const out = filterPropertyCandidates(
      [
        { identifier: '', type: 'website' },
        { identifier: '   ', type: 'website' },
        { identifier: 123 as unknown, type: 'website' },
        { identifier: 'real.example', type: 'website' },
      ],
      'delegated',
    );
    expect(out).toEqual([
      { identifier: 'real.example', type: 'website', relationship: 'delegated' },
    ]);
  });

  it('caps the slice at MAX_PROPERTIES (500)', () => {
    const candidates = Array.from({ length: 600 }, (_, i) => ({
      identifier: `host${i}.example`,
      type: 'website' as const,
    }));
    const out = filterPropertyCandidates(candidates, 'delegated');
    expect(out).toHaveLength(MAX_PROPERTIES);
    expect(MAX_PROPERTIES).toBe(500);
  });
});
