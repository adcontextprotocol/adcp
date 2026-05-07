import { describe, it, expect } from 'vitest';
import { coerceStringArray } from '../../../src/addie/mcp/input-coercion.js';

describe('coerceStringArray', () => {
  it('keeps a clean string array as-is', () => {
    expect(coerceStringArray(['bug', 'needs-triage'])).toEqual(['bug', 'needs-triage']);
  });

  it('splits a comma-separated string', () => {
    expect(coerceStringArray('bug,needs-triage')).toEqual(['bug', 'needs-triage']);
  });

  it('trims whitespace and drops empty entries', () => {
    expect(coerceStringArray(' bug , , needs-triage ')).toEqual(['bug', 'needs-triage']);
  });

  it('dedupes repeated entries', () => {
    expect(coerceStringArray('bug,bug,bug,feature')).toEqual(['bug', 'feature']);
  });

  it('caps at the default 20-item limit', () => {
    const input = Array.from({ length: 50 }, (_, i) => `tag${i}`).join(',');
    const result = coerceStringArray(input);
    expect(result).toHaveLength(20);
    expect(result[0]).toBe('tag0');
    expect(result[19]).toBe('tag19');
  });

  it('respects a custom max', () => {
    expect(coerceStringArray('a,b,c,d,e', 3)).toEqual(['a', 'b', 'c']);
  });

  it('returns an empty array for non-string, non-array input', () => {
    expect(coerceStringArray(42)).toEqual([]);
    expect(coerceStringArray(null)).toEqual([]);
    expect(coerceStringArray(undefined)).toEqual([]);
    expect(coerceStringArray({ foo: 'bar' })).toEqual([]);
  });

  it('drops non-string entries from arrays', () => {
    expect(coerceStringArray(['bug', 42, null, 'feature'] as unknown[])).toEqual(['bug', 'feature']);
  });
});
