import { describe, it, expect } from 'vitest';
import {
  extractRegistryPaths,
  findClosestSchema,
  formatSchemaJson,
  SCHEMA_MAX_DISPLAY_CHARS,
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

describe('formatSchemaJson', () => {
  const smallSchema = JSON.stringify({ title: 'Test', properties: { foo: { type: 'string' } } }, null, 2);

  it('returns schema verbatim when under the character limit', () => {
    const { displayJson, truncationNote } = formatSchemaJson(smallSchema, ['foo']);
    expect(displayJson).toBe(smallSchema);
    expect(truncationNote).toBeNull();
  });

  it('truncates schemas that exceed SCHEMA_MAX_DISPLAY_CHARS', () => {
    const largeJson = 'x'.repeat(SCHEMA_MAX_DISPLAY_CHARS + 500);
    const { displayJson, truncationNote } = formatSchemaJson(largeJson, []);
    expect(displayJson).toHaveLength(SCHEMA_MAX_DISPLAY_CHARS);
    expect(truncationNote).not.toBeNull();
  });

  it('truncation note mentions property parameter when propNames are present', () => {
    const largeJson = 'x'.repeat(SCHEMA_MAX_DISPLAY_CHARS + 1);
    const { truncationNote } = formatSchemaJson(largeJson, ['assets', 'renders']);
    expect(truncationNote).toContain('property');
    expect(truncationNote).toContain('assets');
  });

  it('truncation note mentions union types when no propNames are present', () => {
    const largeJson = 'x'.repeat(SCHEMA_MAX_DISPLAY_CHARS + 1);
    const { truncationNote } = formatSchemaJson(largeJson, []);
    expect(truncationNote).toContain('oneOf');
    expect(truncationNote).not.toContain('All properties');
  });

  it('truncation note does not suggest property param for union-only schemas (regression guard for #4397)', () => {
    // Schemas like creative/preview-render.json use oneOf at root with no
    // top-level properties. The old note incorrectly suggested `property`
    // would help; it doesn't for union schemas.
    const largeJson = 'x'.repeat(SCHEMA_MAX_DISPLAY_CHARS + 1);
    const { truncationNote } = formatSchemaJson(largeJson, []);
    // Should NOT tell the agent to drill into schema.properties
    expect(truncationNote).not.toMatch(/Use the `property` parameter with one of the \*\*All properties\*\*/);
  });

  it('SCHEMA_MAX_DISPLAY_CHARS is at least 20_000', () => {
    // Regression guard: the old 6K limit silently hid oneOf branches.
    // creative/preview-creative-response.json is ~11K — must not be truncated.
    // core/format.json (~29K) and core/product.json (~25K) also require ≥25K.
    expect(SCHEMA_MAX_DISPLAY_CHARS).toBeGreaterThanOrEqual(20_000);
  });

  it('truncation note for union schemas does not suggest list_schemas (regression guard for #4397)', () => {
    // Schemas like brand.json use inline oneOf branches — list_schemas only returns
    // registry paths and cannot surface inline branches, so suggesting it is a dead end.
    const largeJson = 'x'.repeat(SCHEMA_MAX_DISPLAY_CHARS + 1);
    const { truncationNote } = formatSchemaJson(largeJson, []);
    expect(truncationNote).not.toContain('list_schemas');
    expect(truncationNote).toContain('validate_json');
  });

  it('truncation note for empty-properties schema (properties: {}) fires union hint', () => {
    // comply-test-controller-response.json has "properties": {} at root.
    // Object.keys({}) === [] so propNames is empty and the union hint fires.
    const largeJson = 'x'.repeat(SCHEMA_MAX_DISPLAY_CHARS + 1);
    const { truncationNote } = formatSchemaJson(largeJson, Object.keys({}));
    expect(truncationNote).toContain('oneOf');
    expect(truncationNote).not.toContain('All properties');
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
