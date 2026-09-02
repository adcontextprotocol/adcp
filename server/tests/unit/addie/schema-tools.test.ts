import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  createSchemaToolHandlers,
  DOCS_SCHEMA_RELEASES,
  extractRegistryPaths,
  findClosestSchema,
  formatSchemaJson,
  SCHEMA_TOOLS,
  SCHEMA_MAX_DISPLAY_CHARS,
  SCHEMA_VERSION_OPTIONS,
  type SchemaRegistry,
} from '../../../src/addie/mcp/schema-tools.js';

describe('schema version selection', () => {
  it('accepts every public docs release and defaults its guidance to stable', () => {
    expect(Object.keys(DOCS_SCHEMA_RELEASES)).toEqual(['3.1', '3.2-beta', '3.0', '2.5']);
    expect(SCHEMA_VERSION_OPTIONS).toEqual(expect.arrayContaining([
      '3.1',
      'stable',
      'current',
      'latest',
      'v3',
      DOCS_SCHEMA_RELEASES['3.1'],
      '3.2-beta',
      '3.2 beta',
      '3.2',
      DOCS_SCHEMA_RELEASES['3.2-beta'],
      '3.0',
      DOCS_SCHEMA_RELEASES['3.0'],
      '2.5',
      '2.5 (archived)',
      DOCS_SCHEMA_RELEASES['2.5'],
      'v2',
      '2.6',
      '2.6.0',
    ]));

    for (const toolName of ['validate_json', 'get_schema', 'list_schemas']) {
      const tool = SCHEMA_TOOLS.find((candidate) => candidate.name === toolName);
      expect(tool?.input_schema.properties.version.enum).toEqual(SCHEMA_VERSION_OPTIONS);
    }

    const getSchema = SCHEMA_TOOLS.find((tool) => tool.name === 'get_schema');
    expect(getSchema?.input_schema.properties.version.description).toContain('3.1 (stable default)');
  });
});

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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('schema handler version resolution', () => {
  const publicSelectors: Array<{
    selector?: string;
    canonical: string;
    artifact: string;
  }> = [
    { canonical: '3.1', artifact: DOCS_SCHEMA_RELEASES['3.1'] },
    { selector: '3.1', canonical: '3.1', artifact: DOCS_SCHEMA_RELEASES['3.1'] },
    { selector: 'stable', canonical: '3.1', artifact: DOCS_SCHEMA_RELEASES['3.1'] },
    { selector: 'current', canonical: '3.1', artifact: DOCS_SCHEMA_RELEASES['3.1'] },
    { selector: 'latest', canonical: '3.1', artifact: DOCS_SCHEMA_RELEASES['3.1'] },
    { selector: 'v3', canonical: '3.1', artifact: DOCS_SCHEMA_RELEASES['3.1'] },
    { selector: DOCS_SCHEMA_RELEASES['3.1'], canonical: '3.1', artifact: DOCS_SCHEMA_RELEASES['3.1'] },
    { selector: '3.2-beta', canonical: '3.2-beta', artifact: DOCS_SCHEMA_RELEASES['3.2-beta'] },
    { selector: '3.2 beta', canonical: '3.2-beta', artifact: DOCS_SCHEMA_RELEASES['3.2-beta'] },
    { selector: '3.2', canonical: '3.2-beta', artifact: DOCS_SCHEMA_RELEASES['3.2-beta'] },
    { selector: DOCS_SCHEMA_RELEASES['3.2-beta'], canonical: '3.2-beta', artifact: DOCS_SCHEMA_RELEASES['3.2-beta'] },
    { selector: '3.0', canonical: '3.0', artifact: DOCS_SCHEMA_RELEASES['3.0'] },
    { selector: DOCS_SCHEMA_RELEASES['3.0'], canonical: '3.0', artifact: DOCS_SCHEMA_RELEASES['3.0'] },
    { selector: '2.5', canonical: '2.5', artifact: DOCS_SCHEMA_RELEASES['2.5'] },
    { selector: '2.5 (archived)', canonical: '2.5', artifact: DOCS_SCHEMA_RELEASES['2.5'] },
    { selector: DOCS_SCHEMA_RELEASES['2.5'], canonical: '2.5', artifact: DOCS_SCHEMA_RELEASES['2.5'] },
  ];

  it('fetches the exact frozen snapshot for the default and every public docs selector', async () => {
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input);
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => url.endsWith('/index.json')
          ? indexFixture
          : { title: 'Mock schema', type: 'object', properties: {} },
      } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    const getSchema = createSchemaToolHandlers().get('get_schema');
    expect(getSchema).toBeDefined();

    for (const [index, { selector, canonical, artifact }] of publicSelectors.entries()) {
      const schemaPath = `core/version-selector-${index}.json`;
      const result = await getSchema!({ schema_path: schemaPath, version: selector });
      const expectedUrl = `https://adcontextprotocol.org/schemas/${artifact}/${schemaPath}`;

      expect(fetchMock.mock.calls.map(([url]) => String(url))).toContain(expectedUrl);
      expect(result).toContain(`**Schema URL:** ${expectedUrl}`);
      expect(result).toContain(`**Version:** ${canonical}`);
    }
  });

  it('preserves the legacy v2 and 2.6 selectors', async () => {
    const fetchMock = vi.fn(async (input: unknown) => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => String(input).endsWith('/index.json')
        ? indexFixture
        : { title: 'Mock schema', type: 'object', properties: {} },
    }) as Response);
    vi.stubGlobal('fetch', fetchMock);

    const getSchema = createSchemaToolHandlers().get('get_schema');
    expect(getSchema).toBeDefined();
    const selectors = [
      ['v2', 'https://adcontextprotocol.org/schemas/v2'],
      ['2.6', 'https://adcontextprotocol.org/schemas/v2.6'],
      ['2.6.0', 'https://adcontextprotocol.org/schemas/2.6.0'],
    ] as const;

    for (const [index, [selector, baseUrl]] of selectors.entries()) {
      const schemaPath = `core/legacy-version-selector-${index}.json`;
      await getSchema!({ schema_path: schemaPath, version: selector });
      expect(fetchMock.mock.calls.map(([url]) => String(url))).toContain(`${baseUrl}/${schemaPath}`);
    }
  });

  it('canonicalizes a docs alias extracted from a $schema URL', async () => {
    const fetchMock = vi.fn(async (input: unknown) => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => String(input).endsWith('/index.json')
        ? indexFixture
        : { type: 'object' },
    }) as Response);
    vi.stubGlobal('fetch', fetchMock);

    const validateJson = createSchemaToolHandlers().get('validate_json');
    const schemaPath = 'core/schema-url-alias.json';
    const result = await validateJson!({
      json: { $schema: `https://adcontextprotocol.org/schemas/latest/${schemaPath}` },
    });
    const expectedUrl = `https://adcontextprotocol.org/schemas/${DOCS_SCHEMA_RELEASES['3.1']}/${schemaPath}`;

    expect(fetchMock.mock.calls.map(([url]) => String(url))).toContain(expectedUrl);
    expect(result).toContain(`AdCP 3.1 ${schemaPath} schema`);
  });

  it('maps older pinned $schema snapshots to their frozen release line', async () => {
    const fetchMock = vi.fn(async (input: unknown) => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => String(input).endsWith('/index.json')
        ? indexFixture
        : { type: 'object' },
    }) as Response);
    vi.stubGlobal('fetch', fetchMock);

    const validateJson = createSchemaToolHandlers().get('validate_json');
    const cases = [
      ['3.1.4', DOCS_SCHEMA_RELEASES['3.1']],
      ['3.1.0-rc.15', DOCS_SCHEMA_RELEASES['3.1']],
      ['3.2.0-beta.1', DOCS_SCHEMA_RELEASES['3.2-beta']],
      ['3.0.18', DOCS_SCHEMA_RELEASES['3.0']],
      ['3.0.0-rc.2', DOCS_SCHEMA_RELEASES['3.0']],
      ['2.5.1', DOCS_SCHEMA_RELEASES['2.5']],
    ] as const;

    for (const [index, [pinnedVersion, frozenVersion]] of cases.entries()) {
      const schemaPath = `core/older-pinned-snapshot-${index}.json`;
      await validateJson!({
        json: {
          $schema: `https://adcontextprotocol.org/schemas/${pinnedVersion}/${schemaPath}`,
        },
      });

      expect(fetchMock.mock.calls.map(([url]) => String(url))).toContain(
        `https://adcontextprotocol.org/schemas/${frozenVersion}/${schemaPath}`,
      );
    }
  });

  it('still rejects unknown and future versions inferred from a $schema URL', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const validateJson = createSchemaToolHandlers().get('validate_json');

    for (const version of [
      '4.0.1',
      '3.1.999',
      '3.2.0-beta.999',
      '3.2.1-beta.1',
    ]) {
      await expect(validateJson!({
        json: {
          $schema: `https://adcontextprotocol.org/schemas/${version}/core/product.json`,
        },
      })).rejects.toThrow(`Unsupported schema version "${version}"`);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects unknown versions in every handler instead of falling back to stable', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const handlers = createSchemaToolHandlers();
    const calls: Array<[string, Record<string, unknown>]> = [
      ['validate_json', { json: {}, schema_path: 'core/product.json', version: '4.0' }],
      ['get_schema', { schema_path: 'core/product.json', version: '4.0' }],
      ['list_schemas', { version: '4.0' }],
      ['compare_schema_versions', { schema_path: 'core/product.json', from_version: '4.0' }],
      ['compare_schema_versions', { schema_path: 'core/product.json', to_version: '4.0' }],
    ];

    for (const [name, input] of calls) {
      await expect(handlers.get(name)!(input)).rejects.toThrow('Unsupported schema version "4.0"');
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

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
