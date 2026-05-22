import { describe, it, expect, vi } from 'vitest';

// auth.ts constructs `new WorkOS(process.env.WORKOS_API_KEY!)` at module
// load. Stub the module so CI runs against the repo-root vitest config
// (which has no setup file) don't trip on the missing env var. The
// pattern matches dev-session-signing.test.ts.
vi.mock('@workos-inc/node', () => ({
  WorkOS: class { userManagement = {}; organizations = {}; },
}));

import { constantTimeEqual } from '../../src/middleware/auth.js';

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
