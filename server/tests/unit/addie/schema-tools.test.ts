import { describe, it, expect } from 'vitest';
import {
  extractRegistryPaths,
  findClosestSchema,
  type SchemaRegistry,
} from '../../../src/addie/mcp/schema-tools.js';

// Minimal index.json fixture mirroring the shape served at
// /schemas/v3/index.json. Covers every ref format we care about.
const indexFixture = {
  schemas: {
    core: {
      schemas: {
        product: { $ref: '/schemas/3.0.0/core/product.json' },
        'media-buy': { $ref: '/schemas/3.0.0/core/media-buy.json' },
        format: { $ref: '/schemas/v3/core/format.json' },
      },
    },
    protocol: {
      tasks: {
        'get-adcp-capabilities': {
          request: { $ref: '/schemas/3.0.0/protocol/get-adcp-capabilities-request.json' },
          response: { $ref: '/schemas/3.0.0/protocol/get-adcp-capabilities-response.json' },
        },
      },
    },
    'media-buy': {
      tasks: {
        'create-media-buy': {
          request: { $ref: '/schemas/3.0.0/media-buy/create-media-buy-request.json' },
          response: { $ref: '/schemas/3.0.0/media-buy/create-media-buy-response.json' },
        },
      },
    },
  },
};

function registryFrom(index: unknown): SchemaRegistry {
  const paths = extractRegistryPaths(index);
  const byCategory = new Map<string, string[]>();
  for (const p of paths) {
    const cat = p.split('/')[0];
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat)!.push(p);
  }
  return { paths, byCategory };
}

describe('extractRegistryPaths', () => {
  it('walks nested $ref structures and normalizes to version-relative paths', () => {
    const paths = extractRegistryPaths(indexFixture);
    expect(paths).toContain('core/product.json');
    expect(paths).toContain('protocol/get-adcp-capabilities-response.json');
    expect(paths).toContain('media-buy/create-media-buy-request.json');
  });

  it('handles both pinned-semver and alias $ref prefixes', () => {
    const paths = extractRegistryPaths(indexFixture);
    // /schemas/3.0.0/core/format.json and /schemas/v3/core/format.json
    // both normalize to "core/format.json" — deduped.
    expect(paths.filter(p => p === 'core/format.json')).toHaveLength(1);
  });

  it('returns empty list for empty or malformed input', () => {
    expect(extractRegistryPaths(null)).toEqual([]);
    expect(extractRegistryPaths({})).toEqual([]);
    expect(extractRegistryPaths({ schemas: { core: {} } })).toEqual([]);
  });

  it('handles cycles without stack overflow', () => {
    type Cyclic = { self?: Cyclic; $ref?: string };
    const cyclic: Cyclic = { $ref: '/schemas/v3/core/product.json' };
    cyclic.self = cyclic;
    expect(extractRegistryPaths(cyclic)).toEqual(['core/product.json']);
  });
});

describe('findClosestSchema', () => {
  const registry = registryFrom(indexFixture);

  it('returns exact match when path is valid', () => {
    expect(findClosestSchema('core/product.json', registry)).toBe('core/product.json');
  });

  it('corrects the category when filename is unique', () => {
    // User guessed "core/" but capabilities lives in "protocol/"
    expect(
      findClosestSchema('core/get-adcp-capabilities-response.json', registry),
    ).toBe('protocol/get-adcp-capabilities-response.json');
  });

  it('auto-corrects the exact bug from the Addie 404 report', () => {
    // This is the failure mode that triggered the fix: Addie tried
    // "core/get-capabilities-response.json" (wrong category, missing "adcp"
    // in the name). Token overlap should still surface the right schema.
    const resolved = findClosestSchema('core/get-capabilities-response.json', registry);
    expect(resolved).toBe('protocol/get-adcp-capabilities-response.json');
  });

  it('returns null when the query has no meaningful overlap', () => {
    expect(findClosestSchema('completely/unrelated-thing.json', registry)).toBeNull();
  });

  it('returns null when multiple candidates tie too closely', () => {
    // "create-media-buy" is ambiguous between request and response variants.
    // Both score identically, so we should bail rather than silently pick one.
    const resolved = findClosestSchema('media-buy/create-media-buy.json', registry);
    expect(resolved).toBeNull();
  });
});
