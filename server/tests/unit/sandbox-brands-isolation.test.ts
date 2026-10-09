import { describe, it, expect, vi } from 'vitest';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readdirSync: vi.fn(() => {
      throw new Error('test-kits directory unavailable');
    }),
  };
});

import { getSandboxBrand } from '../../src/services/sandbox-brands.js';

describe('sandbox brand loading isolation', () => {
  it('does not read the test kits for a real domain', () => {
    expect(getSandboxBrand('acme.com')).toBeUndefined();
  });

  it('surfaces a test-kit load failure on a sandbox lookup', () => {
    expect(() => getSandboxBrand('acmeoutdoor.example')).toThrow('test-kits directory unavailable');
  });
});
