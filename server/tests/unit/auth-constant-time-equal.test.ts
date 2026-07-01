import { describe, it, expect } from 'vitest';

import { constantTimeEqual } from '../../src/utils/constant-time-equal.js';

describe('constantTimeEqual', () => {
  it('returns true for identical strings', () => {
    expect(constantTimeEqual('abc123', 'abc123')).toBe(true);
  });

  it('returns false for equal-length mismatch', () => {
    expect(constantTimeEqual('abc123', 'xyz789')).toBe(false);
  });

  it('returns false for length mismatch', () => {
    expect(constantTimeEqual('short', 'longer-string')).toBe(false);
    expect(constantTimeEqual('longer-string', 'short')).toBe(false);
  });

  it('returns true for empty-string match', () => {
    expect(constantTimeEqual('', '')).toBe(true);
  });

  it('returns false when one side is empty', () => {
    expect(constantTimeEqual('', 'something')).toBe(false);
    expect(constantTimeEqual('something', '')).toBe(false);
  });
});
