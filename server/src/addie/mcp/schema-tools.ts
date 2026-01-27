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
import { logger } from '../../logger.js';
import type { AddieTool } from '../types.js';

// Schema base URLs for different versions
const SCHEMA_BASE_URLS: Record<string, string> = {
  v2: 'https://adcontextprotocol.org/schemas/v2',
  v3: 'https://adcontextprotocol.org/schemas/v3',
  // Specific versions
  '2.5': 'https://adcontextprotocol.org/schemas/v2.5',
  '2.6': 'https://adcontextprotocol.org/schemas/v2.6',
  '2.6.0': 'https://adcontextprotocol.org/schemas/2.6.0',
};

// Common schemas available
const COMMON_SCHEMAS = [
  'core/format.json',
  'core/product.json',
  'core/media-buy.json',
  'core/creative-manifest.json',
  'core/brand-manifest.json',
  'core/property.json',
  'core/targeting.json',
  'core/pricing-option.json',
  'enums/format-category.json',
  'enums/asset-content-type.json',
  'enums/channels.json',
];

// Cache for fetched schemas (5 minute TTL, max 50 entries)
const schemaCache = new Map<string, { schema: unknown; fetchedAt: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_SIZE = 50;

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
 * Build full schema URL from version and path
 */
function buildSchemaUrl(version: string, schemaPath: string): string {
  const baseUrl = SCHEMA_BASE_URLS[version] || SCHEMA_BASE_URLS['v2'];
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
            'Schema version to use: "v2" (current stable), "v3" (upcoming), or specific like "2.6.0". Defaults to version in $schema or "v2".',
          enum: ['v2', 'v3', '2.5', '2.6', '2.6.0'],
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
          description: 'Schema version: "v2" (current stable), "v3" (upcoming), or specific like "2.6.0"',
          enum: ['v2', 'v3', '2.5', '2.6', '2.6.0'],
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
          description: 'Optional version to list schemas for',
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
          enum: ['v2', 'v3', '2.5', '2.6', '2.6.0'],
        },
        to_version: {
          type: 'string',
          description: 'Target version to compare to (default: "v3")',
          enum: ['v2', 'v3', '2.5', '2.6', '2.6.0'],
        },
      },
      required: ['schema_path'],
    },
  },
];

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
      return 'Error: json must be a non-null object, not an array or primitive value.';
    }
    const jsonObj = json as Record<string, unknown>;
    let schemaPath = input.schema_path as string | undefined;
    let version = input.version as string | undefined;

    // Try to extract version and schema from $schema field
    if (jsonObj.$schema && typeof jsonObj.$schema === 'string') {
      const schemaUrl = jsonObj.$schema;
      // Parse URL like https://adcontextprotocol.org/schemas/v2/core/format.json
      // or https://schemas.adcontextprotocol.org/v3/format.json
      const urlMatch = schemaUrl.match(/schemas(?:\.adcontextprotocol\.org)?\/(?:v?(\d+(?:\.\d+)?(?:\.\d+)?))\/(.+)$/);
      if (urlMatch) {
        version = version || urlMatch[1];
        schemaPath = schemaPath || urlMatch[2];
      }
    }

    if (!schemaPath) {
      return `Cannot determine schema. Please provide schema_path (e.g., "core/format.json") or include a $schema field in the JSON.`;
    }

    version = version || 'v2';
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
      return `Failed to validate: ${message}

Make sure the schema path is correct. Available schemas include:
${COMMON_SCHEMAS.map((s) => `- ${s}`).join('\n')}`;
    }
  });

  handlers.set('get_schema', async (input) => {
    const schemaPath = input.schema_path as string;
    const version = (input.version as string) || 'v2';
    const property = input.property as string | undefined;

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

      // Extract key info for summary
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

      // Truncate very long schemas
      const maxLength = 6000;
      const truncated = schemaJson.length > maxLength;
      const displayJson = truncated ? schemaJson.substring(0, maxLength) + '\n... [truncated]' : schemaJson;

      return `${summary}
\`\`\`json
${displayJson}
\`\`\`
${truncated ? '\n**Note:** Schema truncated. Use the `property` parameter to focus on specific sections.' : ''}`;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return `Failed to fetch schema: ${message}

**Schema URL attempted:** ${schemaUrl}

Available schemas include:
${COMMON_SCHEMAS.map((s) => `- ${s}`).join('\n')}`;
    }
  });

  handlers.set('list_schemas', async (input) => {
    const version = (input.version as string) || 'v2';
    const baseUrl = SCHEMA_BASE_URLS[version] || SCHEMA_BASE_URLS['v2'];

    return `## Available AdCP Schemas

**Current Version:** v2 (2.6.x stable)
**Upcoming Version:** v3 (in development)

### Schema Versions
| Version | URL | Status |
|---------|-----|--------|
| v2 | ${SCHEMA_BASE_URLS.v2} | Current stable |
| v3 | ${SCHEMA_BASE_URLS.v3} | Development |
| 2.6.0 | ${SCHEMA_BASE_URLS['2.6.0']} | Latest patch |

### Key Differences: v2 vs v3
${VERSION_CHANGES['v2-to-v3'].map((change) => `- ${change}`).join('\n')}

### Common Schemas (${version})
${COMMON_SCHEMAS.map((s) => `- \`${s}\` → ${baseUrl}/${s}`).join('\n')}

### Schema Categories
- **core/** - Core data types (format, product, media-buy, creative-manifest, etc.)
- **enums/** - Enumeration types (format-category, asset-content-type, channels, etc.)
- **media-buy/** - Media buying task schemas (get-products, create-media-buy, etc.)
- **creative/** - Creative agent task schemas
- **signals/** - Signals agent task schemas

**Tip:** Use \`get_schema\` with a schema path to see the full definition, or \`compare_schema_versions\` to see detailed differences between versions.`;
  });

  handlers.set('compare_schema_versions', async (input) => {
    const schemaPath = input.schema_path as string;
    const fromVersion = (input.from_version as string) || 'v2';
    const toVersion = (input.to_version as string) || 'v3';

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

Available schemas include:
${COMMON_SCHEMAS.map((s) => `- ${s}`).join('\n')}`;
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
      const changeKey = `${fromVersion}-to-${toVersion}`;
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
      return `Failed to compare schemas: ${message}`;
    }
  });

  return handlers;
}
