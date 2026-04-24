import { describe, it, expect } from 'vitest';
import { isUuid } from '../../server/src/utils/uuid.js';

describe('isUuid', () => {
  it('accepts canonical lowercase UUIDs', () => {
    expect(isUuid('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
  });

  it('accepts uppercase UUIDs (case-insensitive)', () => {
    expect(isUuid('550E8400-E29B-41D4-A716-446655440000')).toBe(true);
  });

  it('accepts mixed-case UUIDs', () => {
    expect(isUuid('550e8400-E29B-41d4-A716-446655440000')).toBe(true);
  });

  it('rejects malformed strings', () => {
    expect(isUuid('abc123')).toBe(false);
    expect(isUuid('')).toBe(false);
    expect(isUuid('not-a-uuid-at-all-definitely')).toBe(false);
    expect(isUuid('550e8400e29b41d4a716446655440000')).toBe(false); // missing dashes
    expect(isUuid('550e8400-e29b-41d4-a716-44665544000')).toBe(false); // too short
    expect(isUuid('550e8400-e29b-41d4-a716-4466554400000')).toBe(false); // too long
    expect(isUuid(' 550e8400-e29b-41d4-a716-446655440000')).toBe(false); // leading space
  });

  it('rejects non-string input', () => {
    expect(isUuid(undefined)).toBe(false);
    expect(isUuid(null)).toBe(false);
    expect(isUuid(42)).toBe(false);
    expect(isUuid({})).toBe(false);
  });
});
