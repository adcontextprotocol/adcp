// SCHEMA_TOOLS: the tool definitions of schema-tools.ts, moved here verbatim so that
// readers of the catalog (the router, tool sets, eval harnesses) do not load
// the handlers and their service, database and SDK dependencies.
import type { AddieTool } from '../types.js';

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
            'Schema version to use. Omission means stable 3.2; pass 3.1 or 3.0 for an earlier stable release. Explicit channel, exact snapshot, and legacy aliases are also accepted.',
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
          description: 'Schema version. Match search_docs; omission means stable 3.2. Explicit channel, exact snapshot, and legacy aliases are also accepted.',
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
          description: 'Optional schema version. Defaults to stable 3.2.',
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
          description: 'Target version to compare to (default: stable 3.2)',
        },
      },
      required: ['schema_path'],
    },
  },
];
