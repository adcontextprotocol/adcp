/**
 * AdCP Tool Schema Drift Detection
 *
 * Ensures that Addie's MCP tool input_schemas stay in sync with the
 * AdCP protocol JSON schemas. Checks both directions:
 * - Protocol → Tool: every protocol property exists in the tool
 * - Tool → Protocol: every tool property exists in the protocol (or is in ADDIE_ONLY)
 *
 * Run with: npx jest tests/addie/adcp-tool-schema-drift.test.ts
 */

import { describe, expect, test } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import {
  ADCP_MEDIA_BUY_TOOLS,
  ADCP_CREATIVE_TOOLS,
} from '../../server/src/addie/mcp/adcp-tools.js';

const SCHEMA_DIR = path.join(__dirname, '../../static/schemas/source');

/**
 * Maps tool names to their protocol request schema file (relative to SCHEMA_DIR).
 * Tools without a protocol schema (preview_creative, signals, governance, SI)
 * are not covered and should be added here when schemas are created.
 */
const TOOL_SCHEMA_MAP: Record<string, string> = {
  get_products: 'media-buy/get-products-request.json',
  create_media_buy: 'media-buy/create-media-buy-request.json',
  sync_catalogs: 'media-buy/sync-catalogs-request.json',
  list_creative_formats: 'media-buy/list-creative-formats-request.json',
  get_media_buy_delivery: 'media-buy/get-media-buy-delivery-request.json',
  update_media_buy: 'media-buy/update-media-buy-request.json',
  provide_performance_feedback: 'media-buy/provide-performance-feedback-request.json',
  build_creative: 'media-buy/build-creative-request.json',
};

/** Protocol metadata fields — not useful for LLM tool schemas */
const PROTOCOL_ONLY = new Set(['ext', 'context']);

/** Addie-specific routing fields — not in protocol schemas */
const ADDIE_ONLY = new Set(['agent_url', 'debug']);

const ALL_TOOLS = [...ADCP_MEDIA_BUY_TOOLS, ...ADCP_CREATIVE_TOOLS];

function getToolProps(tool: (typeof ALL_TOOLS)[number]): string[] {
  return Object.keys(
    (tool.input_schema as Record<string, unknown> & { properties: Record<string, unknown> })
      .properties || {},
  );
}

describe('AdCP tool schemas match protocol schemas', () => {
  for (const [toolName, schemaFile] of Object.entries(TOOL_SCHEMA_MAP)) {
    test(`${toolName} covers all protocol properties`, () => {
      const schemaPath = path.join(SCHEMA_DIR, schemaFile);
      const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf-8'));
      const tool = ALL_TOOLS.find((t) => t.name === toolName);

      expect(tool).toBeDefined();

      const protocolProps = Object.keys(schema.properties || {}).filter(
        (p) => !PROTOCOL_ONLY.has(p),
      );
      const toolProps = getToolProps(tool!).filter((p) => !ADDIE_ONLY.has(p));

      const missing = protocolProps.filter((p) => !toolProps.includes(p));

      expect(missing).toEqual([]);
    });

    test(`${toolName} has no properties absent from protocol`, () => {
      const schemaPath = path.join(SCHEMA_DIR, schemaFile);
      const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf-8'));
      const tool = ALL_TOOLS.find((t) => t.name === toolName);

      expect(tool).toBeDefined();

      const protocolProps = new Set(Object.keys(schema.properties || {}));
      const toolProps = getToolProps(tool!).filter((p) => !ADDIE_ONLY.has(p));

      const extra = toolProps.filter((p) => !protocolProps.has(p));

      expect(extra).toEqual([]);
    });
  }
});
