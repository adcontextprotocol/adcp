/**
 * AdCP Schema Tools
 *
 * Provides tools for Addie to:
 * 1. Fetch and display JSON schemas from adcontextprotocol.org
 * 2. Validate JSON payloads against schemas
 * 3. List available schemas and versions
 *
 * This enables Addie to give authoritative answers about schema structure
 * and validate user-provided JSON against the spec.
 */

import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { createLogger } from '../../logger.js';

const logger = createLogger('addie-schema-tools');
import type { AddieTool } from '../types.js';
import { ToolError } from '../tool-error.js';

const SCHEMA_HOST = 'https://adcontextprotocol.org';

// Keep schema selection aligned with the frozen releases exposed in docs.json.
// Legacy aliases remain available for callers that already use them.
export const DOCS_SCHEMA_RELEASES = Object.freeze({
  '3.1': '3.1.20',
  '3.2-rc': '3.2.0-rc.1',
  '3.2-beta': '3.2.0-beta.11',
  '3.0': '3.0.26',
  '2.5': '2.5.3',
});

const PREVIEW_RELEASE_LINE = '3.2';
export function buildPreviewSchemaRouting(
  releases: Readonly<Record<string, string>>,
  releaseLine: string,
): { selectors: string[]; current: string; aliases: Record<string, string> } {
  const selectors = Object.keys(releases).filter(
    (selector) => selector.startsWith(`${releaseLine}-`),
  );
  const current = selectors[0];
  if (!current) {
    throw new Error(`DOCS_SCHEMA_RELEASES must contain a ${releaseLine} prerelease`);
  }
  const aliases = Object.fromEntries(
    selectors.flatMap((selector) => {
      const channel = selector.slice(releaseLine.length + 1);
      const entries = [
        [selector, selector],
        [`${releaseLine} ${channel}`, selector],
      ];
      if (selector === current) entries.push([releaseLine, current]);
      entries.push([releases[selector], selector]);
      return entries;
    }),
  );
  return { selectors, current, aliases };
}

const previewSchemaRouting = buildPreviewSchemaRouting(
  DOCS_SCHEMA_RELEASES,
  PREVIEW_RELEASE_LINE,
);
const PREVIEW_SCHEMA_SELECTORS = previewSchemaRouting.selectors;
const CURRENT_PREVIEW_SELECTOR = previewSchemaRouting.current;

const SCHEMA_BASE_URLS: Record<string, string> = {
  ...Object.fromEntries(
    Object.entries(DOCS_SCHEMA_RELEASES).map(([selector, release]) => [
      selector,
      `${SCHEMA_HOST}/schemas/${release}`,
    ]),
  ),
  v2: `${SCHEMA_HOST}/schemas/v2`,
  '2.6': `${SCHEMA_HOST}/schemas/v2.6`,
  '2.6.0': `${SCHEMA_HOST}/schemas/2.6.0`,
};

const DEFAULT_VERSION = '3.1';

// Public documentation selectors resolve to frozen schema snapshots. Keep the
// legacy v2/2.6 selectors intact, but do not let v3 or "latest" drift away
// from the stable documentation release.
const SCHEMA_VERSION_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  '3.1': '3.1',
  stable: '3.1',
  current: '3.1',
  latest: '3.1',
  v3: '3.1',
  [DOCS_SCHEMA_RELEASES['3.1']]: '3.1',
  ...previewSchemaRouting.aliases,
  '3.0': '3.0',
  [DOCS_SCHEMA_RELEASES['3.0']]: '3.0',
  '2.5': '2.5',
  '2.5 (archived)': '2.5',
  [DOCS_SCHEMA_RELEASES['2.5']]: '2.5',
  v2: 'v2',
  '2.6': '2.6',
  '2.6.0': '2.6.0',
});

export const SCHEMA_VERSION_OPTIONS = Object.freeze(Object.keys(SCHEMA_VERSION_ALIASES));

function resolveSchemaVersion(requested?: unknown, fallback = DEFAULT_VERSION): string {
  const selector = requested === undefined
    ? fallback
    : typeof requested === 'string'
      ? requested.trim().toLowerCase()
      : '';
  const canonical = SCHEMA_VERSION_ALIASES[selector];
  if (!canonical) {
    throw new ToolError(
      `Unsupported schema version "${String(requested)}". Supported versions: ${SCHEMA_VERSION_OPTIONS.join(', ')}.`,
    );
  }
  return canonical;
}

const HISTORICAL_PRERELEASE_RANGES: Readonly<
  Record<string, Partial<Record<'beta' | 'rc', readonly [number, number]>>>
> = Object.freeze({
  '3.0': Object.freeze({ beta: [1, 3] as const, rc: [1, 3] as const }),
  '3.1': Object.freeze({ beta: [0, 7] as const, rc: [1, 15] as const }),
});

/**
 * Resolve a version inferred from a document's `$schema` URL.
 *
 * Published documents may remain pinned to an older patch snapshot after the
 * docs move to a newer frozen snapshot. Preserve their release-line meaning
 * while keeping explicit tool `version` inputs fail-closed.
 */
function resolveInferredSchemaVersion(requested: string): string {
  const selector = requested.trim().toLowerCase();
  const direct = SCHEMA_VERSION_ALIASES[selector];
  if (direct) return direct;

  const prereleaseMatch = selector.match(/^(\d+\.\d+)\.0-(beta|rc)\.(\d+)$/);
  if (prereleaseMatch) {
    const [, releaseLine, prereleaseKind, prereleaseNumberText] = prereleaseMatch;
    const channelSelector = `${releaseLine}-${prereleaseKind}`;
    const canonical = channelSelector in DOCS_SCHEMA_RELEASES
      ? channelSelector
      : releaseLine;
    const historicalRange = HISTORICAL_PRERELEASE_RANGES[canonical]?.[
      prereleaseKind as 'beta' | 'rc'
    ];
    const frozenVersion = DOCS_SCHEMA_RELEASES[
      canonical as keyof typeof DOCS_SCHEMA_RELEASES
    ];
    const frozenPrerelease = frozenVersion?.match(
      new RegExp(`^${releaseLine.replace('.', '\\.')}\\.0-${prereleaseKind}\\.(\\d+)$`)
    );
    const prereleaseNumber = Number(prereleaseNumberText);
    const inHistoricalRange = historicalRange
      && prereleaseNumber >= historicalRange[0]
      && prereleaseNumber <= historicalRange[1];
    const inCurrentPreviewRange = frozenPrerelease
      && prereleaseNumber >= 0
      && prereleaseNumber <= Number(frozenPrerelease[1]);
    if (inHistoricalRange || inCurrentPreviewRange) {
      return canonical;
    }
  }

  const patchMatch = selector.match(/^(\d+\.\d+)\.(\d+)$/);
  if (patchMatch) {
    const [, releaseLine, patchNumberText] = patchMatch;
    const frozenVersion = DOCS_SCHEMA_RELEASES[
      releaseLine as keyof typeof DOCS_SCHEMA_RELEASES
    ];
    const frozenMatch = frozenVersion?.match(/^(\d+\.\d+)\.(\d+)$/);
    if (
      frozenMatch
      && frozenMatch[1] === releaseLine
      && Number(patchNumberText) <= Number(frozenMatch[2])
    ) {
      return releaseLine;
    }
  }

  return resolveSchemaVersion(requested);
}

// Cache for fetched schemas (5 minute TTL, max 50 entries)
const schemaCache = new Map<string, { schema: unknown; fetchedAt: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_SIZE = 50;

// Cache for the per-version schema registry (index.json). Separate from
// schemaCache so expiration semantics match — registries are cheap and
// refetched every 5 minutes.
export type SchemaRegistry = {
  paths: string[]; // flat list: ["core/product.json", "protocol/get-adcp-capabilities-response.json", ...]
  byCategory: Map<string, string[]>; // "core" -> ["core/product.json", ...]
};
const registryCache = new Map<string, { registry: SchemaRegistry; fetchedAt: number }>();

/**
 * Fetch a schema from the AdCP schema server
 */
async function fetchSchema(schemaUrl: string): Promise<unknown> {
  // Check cache
  const cached = schemaCache.get(schemaUrl);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.schema;
  }

  try {
    const response = await fetch(schemaUrl, {
      headers: { Accept: 'application/json' },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const schema = await response.json();
    // Evict oldest entry if cache is full
    if (schemaCache.size >= MAX_CACHE_SIZE) {
      const oldest = [...schemaCache.entries()].sort((a, b) => a[1].fetchedAt - b[1].fetchedAt)[0];
      if (oldest) {
        schemaCache.delete(oldest[0]);
      }
    }
    schemaCache.set(schemaUrl, { schema, fetchedAt: Date.now() });
    return schema;
  } catch (error) {
    logger.warn({ error, schemaUrl }, 'Failed to fetch schema');
    throw error;
  }
}

/**
 * Walk the index.json tree and collect every `$ref` that points at a schema.
 * Returns paths relative to the version root (e.g. "core/product.json",
 * "protocol/get-adcp-capabilities-response.json").
 *
 * Uses a WeakSet to guard against cycles in case a future registry format
 * ever includes self-referential nodes.
 *
 * Exported for testing.
 */
export function extractRegistryPaths(index: unknown): string[] {
  const found = new Set<string>();
  const seen = new WeakSet<object>();
  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    if (seen.has(node as object)) return;
    seen.add(node as object);
    const obj = node as Record<string, unknown>;
    const ref = obj.$ref;
    if (typeof ref === 'string') {
      // $ref formats: "/schemas/3.0.0/core/product.json" or "/schemas/v3/core/product.json"
      const match = ref.match(/^\/schemas\/[^/]+\/(.+\.json)$/);
      if (match) found.add(match[1]);
    }
    for (const value of Object.values(obj)) visit(value);
  };
  visit(index);
  return [...found].sort();
}

/**
 * Fetch and cache the schema registry (index.json) for a given version alias.
 */
async function fetchRegistry(version: string): Promise<SchemaRegistry> {
  const cached = registryCache.get(version);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.registry;
  }

  const baseUrl = SCHEMA_BASE_URLS[version];
  if (!baseUrl) {
    throw new ToolError(`Unsupported canonical schema version "${version}".`);
  }
  const indexUrl = `${baseUrl}/index.json`;
  const index = await fetchSchema(indexUrl);
  const paths = extractRegistryPaths(index);

  const byCategory = new Map<string, string[]>();
  for (const p of paths) {
    const category = p.split('/')[0];
    if (!byCategory.has(category)) byCategory.set(category, []);
    byCategory.get(category)!.push(p);
  }

  const registry: SchemaRegistry = { paths, byCategory };
  // Don't cache an empty registry — upstream likely returned malformed JSON
  // or an index shape we don't recognize. Next call will retry instead of
  // silently returning "no schemas" for the full TTL.
  if (paths.length > 0) {
    registryCache.set(version, { registry, fetchedAt: Date.now() });
  } else {
    logger.warn({ indexUrl }, 'Schema registry index returned zero paths; not caching');
  }
  return registry;
}

/**
 * Tokenize a schema path for fuzzy matching. Splits on `/`, `-`, `_`, `.`
 * and lowercases. "protocol/get-adcp-capabilities-response.json" →
 * ["protocol", "get", "adcp", "capabilities", "response"].
 */
function tokenize(schemaPath: string): string[] {
  return schemaPath
    .replace(/\.json$/, '')
    .toLowerCase()
    .split(/[/\-_.]+/)
    .filter(Boolean);
}

/**
 * Find the closest matching schema path in the registry.
 * Strategy: exact match → same-filename match → best-overlap scoring.
 * Only returns a match if the winner is meaningfully ahead of the runner-up,
 * to avoid silently picking the wrong schema when the query is ambiguous.
 *
 * Exported for testing.
 */
export function findClosestSchema(schemaPath: string, registry: SchemaRegistry): string | null {
  if (registry.paths.includes(schemaPath)) return schemaPath;

  const clean = schemaPath.replace(/^\//, '');
  const filename = clean.split('/').pop() || clean;

  // Filename-only match (e.g., user omitted or guessed wrong category)
  const filenameMatches = registry.paths.filter(p => p.endsWith('/' + filename));
  if (filenameMatches.length === 1) return filenameMatches[0];

  // Token-overlap scoring
  const queryTokens = new Set(tokenize(clean));
  if (queryTokens.size === 0) return null;

  const scored = registry.paths.map(p => {
    const pTokens = new Set(tokenize(p));
    let overlap = 0;
    for (const t of queryTokens) if (pTokens.has(t)) overlap++;
    // Jaccard-like, but weighted toward query coverage to favor paths that
    // contain all query tokens (e.g., "get capabilities response" fully
    // covered by "protocol/get-adcp-capabilities-response").
    const coverage = overlap / queryTokens.size;
    const union = queryTokens.size + pTokens.size - overlap;
    const jaccard = overlap / union;
    return { path: p, score: coverage * 0.7 + jaccard * 0.3 };
  });

  scored.sort((a, b) => b.score - a.score);
  const [best, runnerUp] = scored;
  if (!best || best.score < 0.5) return null;
  if (runnerUp && best.score - runnerUp.score < 0.1) return null;
  return best.path;
}

/**
 * Format a "did you mean?" list for error messages when a schema path is wrong
 * or unresolvable. Shows the top token-overlap candidates from the registry,
 * or a category breakdown if we have no query signal.
 */
function formatCandidates(schemaPath: string, registry: SchemaRegistry | null): string {
  if (!registry || registry.paths.length === 0) {
    return 'Use `list_schemas` to see available schemas.';
  }

  const queryTokens = new Set(tokenize(schemaPath));
  if (queryTokens.size === 0) {
    return 'Use `list_schemas` to see available schemas.';
  }

  const ranked = registry.paths
    .map(p => {
      const pTokens = new Set(tokenize(p));
      let overlap = 0;
      for (const t of queryTokens) if (pTokens.has(t)) overlap++;
      return { path: p, overlap };
    })
    .filter(x => x.overlap > 0)
    .sort((a, b) => b.overlap - a.overlap)
    .slice(0, 8);

  if (ranked.length === 0) {
    return 'Use `list_schemas` to see available schemas.';
  }

  return `Closest matches:\n${ranked.map(r => `- \`${r.path}\``).join('\n')}\n\nUse \`list_schemas\` to see the full registry.`;
}

/**
 * Resolve a schema path, applying fuzzy correction via the registry if needed.
 */
async function resolveSchemaPath(
  schemaPath: string,
  version: string,
): Promise<{ resolved: string; corrected: boolean; registry: SchemaRegistry | null }> {
  let registry: SchemaRegistry | null = null;
  try {
    registry = await fetchRegistry(version);
  } catch (error) {
    // Registry fetch failed — still try the path as-is and let the schema
    // fetch return a useful error.
    logger.warn({ error, version }, 'Failed to fetch schema registry');
    return { resolved: schemaPath, corrected: false, registry: null };
  }

  if (registry.paths.includes(schemaPath)) {
    return { resolved: schemaPath, corrected: false, registry };
  }
  const closest = findClosestSchema(schemaPath, registry);
  if (closest) {
    logger.info({ requested: schemaPath, resolved: closest, version }, 'Auto-corrected schema path');
    return { resolved: closest, corrected: true, registry };
  }
  return { resolved: schemaPath, corrected: false, registry };
}

/**
 * Build full schema URL from version and path
 */
function buildSchemaUrl(version: string, schemaPath: string): string {
  const baseUrl = SCHEMA_BASE_URLS[version];
  if (!baseUrl) {
    throw new ToolError(`Unsupported canonical schema version "${version}".`);
  }
  // Remove leading slash and sanitize path
  let cleanPath = schemaPath.startsWith('/') ? schemaPath.slice(1) : schemaPath;
  // Prevent path traversal
  cleanPath = cleanPath.replace(/\.\./g, '');
  // Validate path format (alphanumeric, hyphens, underscores, slashes, ending in .json)
  if (!/^[a-zA-Z0-9\-_/]+\.json$/.test(cleanPath)) {
    throw new Error(`Invalid schema path: ${schemaPath}`);
  }
  return `${baseUrl}/${cleanPath}`;
}

/**
 * Validate JSON against a schema
 */
async function validateAgainstSchema(
  json: unknown,
  schemaUrl: string
): Promise<{ valid: boolean; errors: string[] }> {
  try {
    const schema = await fetchSchema(schemaUrl);

    const ajv = new Ajv({
      allErrors: true,
      verbose: true,
      strict: false,
      loadSchema: async (uri: string) => {
        // Resolve relative $refs
        const resolvedUrl = new URL(uri, schemaUrl).toString();
        const schema = await fetchSchema(resolvedUrl);
        return schema as object;
      },
    });
    addFormats(ajv);

    // Compile the schema (handles $refs)
    const validate = await ajv.compileAsync(schema as object);
    const valid = validate(json);

    if (valid) {
      return { valid: true, errors: [] };
    }

    // Format errors for readability
    const errors = (validate.errors || []).map((err) => {
      const path = err.instancePath || '(root)';
      const message = err.message || 'Unknown error';
      const params = err.params ? ` (${JSON.stringify(err.params)})` : '';
      return `${path}: ${message}${params}`;
    });

    return { valid: false, errors };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return { valid: false, errors: [`Schema validation failed: ${message}`] };
  }
}

/**
 * Key differences between schema versions
 * This helps Addie explain version changes to users
 */
const VERSION_CHANGES: Record<string, string[]> = {
  'v2-to-v3': [
    '**Format schema:** v3 adds full `assets` array with discriminated union (item_type: "individual" | "repeatable_group"), v2 only has `assets_required` boolean',
    '**Asset definitions:** v3 uses `item_type` as the discriminator field for individual vs repeatable_group assets',
    '**Renders:** Both versions support `renders` array for visual format dimensions',
    '**Pricing:** v3 introduces more flexible pricing_option structures',
  ],
};

function schemaVersionTable(): string {
  const rows = Object.entries(DOCS_SCHEMA_RELEASES).map(([selector, release]) => {
    const note = selector === DEFAULT_VERSION
      ? 'Current stable schema snapshot'
      : selector.startsWith(`${PREVIEW_RELEASE_LINE}-`)
        ? `${selector.endsWith('-rc') ? 'RC' : 'Beta'} docs snapshot`
        : selector === '3.0'
          ? 'Previous 3.x snapshot'
          : 'Archived snapshot';
    return `| ${selector} | ${SCHEMA_BASE_URLS[selector]} | ${note} (${release}) |`;
  });
  rows.push(`| v2 | ${SCHEMA_BASE_URLS.v2} | Legacy (2.x) |`);
  return rows.join('\n');
}

/**
 * Schema tools for Addie
 */
export const SCHEMA_TOOLS: AddieTool[] = [
  {
    name: 'validate_json',
    description:
      'Validate a JSON object against an AdCP schema. Use this to verify if user-provided JSON is valid according to the specification. Returns validation errors if invalid.',
    usage_hints:
      'use when user asks "is this JSON correct?", "validate my format", "check this against the schema"',
    input_schema: {
      type: 'object',
      properties: {
        json: {
          type: 'object',
          description: 'The JSON object to validate',
        },
        schema_path: {
          type: 'string',
          description:
            'Path to the schema (e.g., "core/format.json", "core/product.json"). Required unless json contains $schema field.',
        },
        version: {
          type: 'string',
          description:
            'Schema version to use. Omission means stable 3.1; use 3.2 for the current preview. Explicit channel, exact snapshot, and legacy aliases are also accepted.',
        },
      },
      required: ['json'],
    },
  },
  {
    name: 'get_schema',
    description:
      'Fetch and display an AdCP JSON schema. Use this to show the exact schema definition, including all properties, required fields, and constraints. This is the authoritative source for what fields are valid.',
    usage_hints:
      'use when user asks "what fields are valid?", "show me the format schema", "what is the structure of X?"',
    input_schema: {
      type: 'object',
      properties: {
        schema_path: {
          type: 'string',
          description:
            'Path to the schema (e.g., "core/format.json", "core/product.json", "enums/asset-content-type.json")',
        },
        version: {
          type: 'string',
          description: 'Schema version. Match search_docs; omission means stable 3.1 and 3.2 selects the current preview. Explicit channel, exact snapshot, and legacy aliases are also accepted.',
        },
        property: {
          type: 'string',
          description:
            'Optional: specific property to focus on (e.g., "assets" to show only the assets definition)',
        },
      },
      required: ['schema_path'],
    },
  },
  {
    name: 'list_schemas',
    description:
      'List available AdCP schemas and versions. Use this to help users discover what schemas exist and what versions are available.',
    usage_hints: 'use when user asks "what schemas exist?", "what versions are available?"',
    input_schema: {
      type: 'object',
      properties: {
        version: {
          type: 'string',
          description: 'Optional schema version. Defaults to stable 3.1.',
        },
      },
    },
  },
  {
    name: 'compare_schema_versions',
    description:
      'Compare two schema versions to show what changed. Use this when users ask about differences between AdCP versions or are confused about which version to use.',
    usage_hints:
      'use when user asks "what changed between v2 and v3?", "should I use v2 or v3?", "what is different in the new version?"',
    input_schema: {
      type: 'object',
      properties: {
        schema_path: {
          type: 'string',
          description: 'Path to the schema to compare (e.g., "core/format.json")',
        },
        from_version: {
          type: 'string',
          description: 'Source version to compare from (default: "v2")',
        },
        to_version: {
          type: 'string',
          description: 'Target version to compare to (default: stable 3.1)',
        },
      },
      required: ['schema_path'],
    },
  },
];

// Max chars for the JSON block returned by get_schema. Matched to the
// PRESERVE_TOOL_RESULTS ceiling in token-limiter.ts so the two layers stay
// coherent — keep them in sync if either value changes.
// 50K covers all schemas in the v3 registry except the largest union enumerations
// (get-adcp-capabilities-response at ~75K, brand.json/adagents.json at ~74K/50K).
export const SCHEMA_MAX_DISPLAY_CHARS = 50_000;

/**
 * Format the JSON block for get_schema output, applying a size ceiling.
 * Exported for unit testing without requiring HTTP mocks.
 *
 * @param schemaJson - Already-serialized schema JSON string
 * @param propNames  - Top-level property names from schema.properties (used to
 *                     craft a helpful truncation hint; pass [] for union schemas)
 */
export function formatSchemaJson(
  schemaJson: string,
  propNames: string[] = [],
): { displayJson: string; truncationNote: string | null } {
  if (schemaJson.length <= SCHEMA_MAX_DISPLAY_CHARS) {
    return { displayJson: schemaJson, truncationNote: null };
  }

  const shown = SCHEMA_MAX_DISPLAY_CHARS.toLocaleString('en-US');
  const total = schemaJson.length.toLocaleString('en-US');
  const hint =
    propNames.length > 0
      ? `Use the \`property\` parameter with one of the **All properties** names above (e.g., \`property: "${propNames[0]}"\`) to retrieve a specific section.`
      : `This schema uses inline union branches (\`oneOf\`/\`allOf\`/\`anyOf\`) that exceed the display limit. Use \`validate_json\` with a candidate payload to check validity and identify the matching branch.`;

  return {
    displayJson: schemaJson.substring(0, SCHEMA_MAX_DISPLAY_CHARS),
    truncationNote: `Schema truncated (showing ${shown} of ${total} chars). ${hint}`,
  };
}

/**
 * Create handlers for schema tools
 */
export function createSchemaToolHandlers(): Map<
  string,
  (input: Record<string, unknown>) => Promise<string>
> {
  const handlers = new Map<string, (input: Record<string, unknown>) => Promise<string>>();

  handlers.set('validate_json', async (input) => {
    const json = input.json;
    // Validate input is a non-null object
    if (!json || typeof json !== 'object' || Array.isArray(json)) {
      throw new ToolError('json must be a non-null object, not an array or primitive value.');
    }
    const jsonObj = json as Record<string, unknown>;
    let schemaPath = input.schema_path as string | undefined;
    let requestedVersion = input.version;

    // Try to extract version and schema from $schema field. Accepts both
    // major-alias form (`/schemas/v3/...`) and pinned-semver form
    // (`/schemas/3.0.0/...`). All selectors are canonicalized below so a
    // schema URL cannot bypass the frozen release mapping.
    if (jsonObj.$schema && typeof jsonObj.$schema === 'string') {
      const schemaUrl = jsonObj.$schema;
      const urlMatch = schemaUrl.match(/(?:\/schemas\/|schemas\.adcontextprotocol\.org\/)([^/]+)\/(.+)$/);
      if (urlMatch) {
        if (requestedVersion === undefined) {
          requestedVersion = resolveInferredSchemaVersion(urlMatch[1]);
        }
        schemaPath = schemaPath || urlMatch[2];
      }
    }

    const version = resolveSchemaVersion(requestedVersion);

    if (!schemaPath) {
      return `Cannot determine schema. Please provide schema_path (e.g., "core/format.json") or include a $schema field in the JSON.`;
    }

    const { resolved: resolvedPath, registry } = await resolveSchemaPath(schemaPath, version);
    schemaPath = resolvedPath;
    const schemaUrl = buildSchemaUrl(version, schemaPath);

    try {
      const result = await validateAgainstSchema(jsonObj, schemaUrl);

      if (result.valid) {
        return `✅ **Valid!** The JSON validates successfully against ${schemaUrl}

The provided JSON conforms to the AdCP ${version} ${schemaPath} schema.`;
      }

      const errorList = result.errors.map((e) => `- ${e}`).join('\n');
      return `❌ **Invalid.** Validation errors against ${schemaUrl}:

${errorList}

**Tip:** Use \`get_schema\` to see the exact schema definition and understand what fields are expected.`;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw new ToolError(`Failed to validate: ${message}

${formatCandidates(schemaPath, registry)}`);
    }
  });

  handlers.set('get_schema', async (input) => {
    const version = resolveSchemaVersion(input.version);
    const property = input.property as string | undefined;

    const requestedPath = input.schema_path as string;
    const { resolved: schemaPath, registry } = await resolveSchemaPath(requestedPath, version);
    const schemaUrl = buildSchemaUrl(version, schemaPath);

    try {
      const schema = (await fetchSchema(schemaUrl)) as Record<string, unknown>;

      // If specific property requested, extract it
      let displaySchema = schema;
      let displayTitle = schema.title || schemaPath;

      if (property && schema.properties) {
        const props = schema.properties as Record<string, unknown>;
        if (props[property]) {
          displaySchema = props[property] as Record<string, unknown>;
          displayTitle = `${displayTitle}.${property}`;
        } else {
          return `Property "${property}" not found in schema. Available properties: ${Object.keys(props).join(', ')}`;
        }
      }

      // Format schema for readability
      const schemaJson = JSON.stringify(displaySchema, null, 2);

      // Extract key info for summary (always from root schema for navigation context)
      const required = schema.required as string[] | undefined;
      const properties = schema.properties as Record<string, unknown> | undefined;
      const propNames = properties ? Object.keys(properties) : [];

      let summary = `## ${displayTitle}

**Schema URL:** ${schemaUrl}
**Version:** ${version}
`;

      if (required?.length) {
        summary += `**Required fields:** ${required.join(', ')}\n`;
      }
      if (propNames.length) {
        summary += `**All properties:** ${propNames.join(', ')}\n`;
      }

      // When drilling into a sub-property, use its own children for the truncation
      // hint so the note points to paths the agent can actually drill into next.
      const displayProperties = displaySchema.properties as Record<string, unknown> | undefined;
      const truncationPropNames = property
        ? (displayProperties ? Object.keys(displayProperties) : [])
        : propNames;

      const { displayJson, truncationNote } = formatSchemaJson(schemaJson, truncationPropNames);

      return `${summary}
\`\`\`json
${displayJson}
\`\`\`
${truncationNote ? `\n**Note:** ${truncationNote}` : ''}`;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw new ToolError(`Failed to fetch schema: ${message}

**Schema URL attempted:** ${schemaUrl}

${formatCandidates(requestedPath, registry)}`);
    }
  });

  handlers.set('list_schemas', async (input) => {
    const version = resolveSchemaVersion(input.version);
    const baseUrl = SCHEMA_BASE_URLS[version];

    let registry: SchemaRegistry | null = null;
    try {
      registry = await fetchRegistry(version);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw new ToolError(`Failed to fetch schema registry from ${baseUrl}/index.json: ${message}`);
    }

    const categoryList = [...registry.byCategory.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([category, paths]) => {
        const items = paths.map(p => `  - \`${p}\` → ${baseUrl}/${p}`).join('\n');
        return `#### ${category}/ (${paths.length})\n${items}`;
      })
      .join('\n\n');

    return `## Available AdCP Schemas

**Version:** ${version} (${baseUrl})
**Total schemas:** ${registry.paths.length}

### Schema Versions
| Version | URL | Notes |
|---------|-----|-------|
${schemaVersionTable()}

### Key Differences: v2 vs v3
${VERSION_CHANGES['v2-to-v3'].map((change) => `- ${change}`).join('\n')}

### Schemas by Category
${categoryList}

**Tip:** Use \`get_schema\` with any path above to see the full definition, or \`compare_schema_versions\` to see detailed differences between versions.`;
  });

  handlers.set('compare_schema_versions', async (input) => {
    const fromVersion = resolveSchemaVersion(input.from_version, 'v2');
    const toVersion = resolveSchemaVersion(input.to_version);
    const requestedPath = input.schema_path as string;
    // Resolve against the "to" version's registry — that's where we most
    // want the path to exist, and the registry also contains legacy schemas.
    const { resolved: schemaPath, registry } = await resolveSchemaPath(requestedPath, toVersion);

    const fromUrl = buildSchemaUrl(fromVersion, schemaPath);
    const toUrl = buildSchemaUrl(toVersion, schemaPath);

    try {
      // Fetch both schemas
      const [fromSchema, toSchema] = await Promise.all([
        fetchSchema(fromUrl).catch(() => null),
        fetchSchema(toUrl).catch(() => null),
      ]) as [Record<string, unknown> | null, Record<string, unknown> | null];

      if (!fromSchema && !toSchema) {
        return `Could not fetch schema "${schemaPath}" from either version.

Attempted URLs:
- ${fromUrl}
- ${toUrl}

${formatCandidates(requestedPath, registry)}`;
      }

      // Build comparison report
      let report = `## Schema Comparison: ${schemaPath}

**From:** ${fromVersion} (${fromUrl})
**To:** ${toVersion} (${toUrl})

`;

      if (!fromSchema) {
        report += `**Note:** Schema not found in ${fromVersion} - this is a new schema in ${toVersion}.\n\n`;
        report += `### Properties in ${toVersion}\n`;
        const props = (toSchema?.properties as Record<string, unknown>) || {};
        report += Object.keys(props).map((p) => `- ${p}`).join('\n');
        return report;
      }

      if (!toSchema) {
        report += `**Note:** Schema not found in ${toVersion} - this schema may have been removed or renamed.\n\n`;
        report += `### Properties in ${fromVersion}\n`;
        const props = (fromSchema.properties as Record<string, unknown>) || {};
        report += Object.keys(props).map((p) => `- ${p}`).join('\n');
        return report;
      }

      // Compare properties
      const fromProps = (fromSchema.properties as Record<string, unknown>) || {};
      const toProps = (toSchema.properties as Record<string, unknown>) || {};
      const fromKeys = new Set(Object.keys(fromProps));
      const toKeys = new Set(Object.keys(toProps));

      const added = [...toKeys].filter((k) => !fromKeys.has(k));
      const removed = [...fromKeys].filter((k) => !toKeys.has(k));
      const common = [...fromKeys].filter((k) => toKeys.has(k));

      if (added.length > 0) {
        report += `### Added in ${toVersion}\n`;
        report += added.map((p) => `- \`${p}\``).join('\n') + '\n\n';
      }

      if (removed.length > 0) {
        report += `### Removed in ${toVersion}\n`;
        report += removed.map((p) => `- \`${p}\``).join('\n') + '\n\n';
      }

      // Compare required fields
      const fromRequired = new Set(fromSchema.required as string[] || []);
      const toRequired = new Set(toSchema.required as string[] || []);
      const newRequired = [...toRequired].filter((r) => !fromRequired.has(r));
      const noLongerRequired = [...fromRequired].filter((r) => !toRequired.has(r));

      if (newRequired.length > 0 || noLongerRequired.length > 0) {
        report += `### Required Fields Changes\n`;
        if (newRequired.length > 0) {
          report += `Now required in ${toVersion}: ${newRequired.map((r) => `\`${r}\``).join(', ')}\n`;
        }
        if (noLongerRequired.length > 0) {
          report += `No longer required in ${toVersion}: ${noLongerRequired.map((r) => `\`${r}\``).join(', ')}\n`;
        }
        report += '\n';
      }

      // Add general version changes if available
      const changeKey = fromVersion === 'v2' && toVersion.startsWith('3')
        ? 'v2-to-v3'
        : `${fromVersion}-to-${toVersion}`;
      if (VERSION_CHANGES[changeKey]) {
        report += `### General ${fromVersion} to ${toVersion} Changes\n`;
        report += VERSION_CHANGES[changeKey].map((change) => `- ${change}`).join('\n') + '\n';
      }

      if (added.length === 0 && removed.length === 0 && newRequired.length === 0 && noLongerRequired.length === 0) {
        report += `### No structural differences found\n`;
        report += `The top-level properties are the same in both versions. There may be differences in nested schemas or validation rules.\n`;
      }

      report += `\n**Tip:** Use \`get_schema\` with a specific property to see detailed differences in nested structures.`;

      return report;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw new ToolError(`Failed to compare schemas: ${message}`);
    }
  });

  return handlers;
}
