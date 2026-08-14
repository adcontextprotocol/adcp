import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv from 'ajv';
import { describe, expect, it } from 'vitest';
import { productDiscoveryAliasToolDefinitions } from '../../src/training-agent/task-handlers.js';
import { validateProductDiscoverySourceInput } from '../../src/training-agent/source-schema.js';

type JsonSchema = Record<string, any>;

function sourceSchema(name: string): JsonSchema {
  return JSON.parse(readFileSync(
    join(process.cwd(), `static/schemas/source/media-buy/${name}.json`),
    'utf8',
  )) as JsonSchema;
}

function resolveLocalRef(root: JsonSchema, value: JsonSchema): JsonSchema {
  const ref = value.$ref as string | undefined;
  if (!ref?.startsWith('#/')) return value;
  return ref.slice(2).split('/').reduce((current: JsonSchema, encoded: string) => (
    current[encoded.replaceAll('~1', '/').replaceAll('~0', '~')] as JsonSchema
  ), root);
}

describe('product discovery MCP schema parity', () => {
  it('keeps runtime discovery constraints aligned with source schemas', () => {
    const tools = new Map(productDiscoveryAliasToolDefinitions().map(tool => [tool.name, tool.inputSchema as JsonSchema]));
    for (const [toolName, fileName] of [
      ['list_products', 'list-products-request'],
      ['request_proposals', 'request-proposals-request'],
      ['refine_proposals', 'refine-proposals-request'],
      ['decline_proposals', 'decline-proposals-request'],
    ] as const) {
      const runtime = tools.get(toolName)!;
      const source = sourceSchema(fileName);
      expect(runtime.required ?? []).toEqual(source.required ?? []);
      expect(runtime.dependencies ?? {}).toEqual(source.dependencies ?? {});
      expect(runtime.additionalProperties).toBe(false);
      expect(Object.keys(runtime.properties).sort()).toEqual(Object.keys(source.properties).sort());
      if (source.properties.idempotency_key) {
        expect(runtime.properties.idempotency_key).toMatchObject({
          minLength: source.properties.idempotency_key.minLength,
          maxLength: source.properties.idempotency_key.maxLength,
          pattern: source.properties.idempotency_key.pattern,
        });
      }
    }

    const recommend = tools.get('request_proposals')!;
    expect(recommend.properties.brief.minLength)
      .toBe(sourceSchema('request-proposals-request').properties.brief.minLength);

    const list = tools.get('list_products')!;
    expect(list.dependencies).toEqual({ if_pricing_version: ['if_feed_version'] });
    const criteria = resolveLocalRef(list, list.properties.criteria);
    const offerFilters = resolveLocalRef(list, criteria.properties.offer_filters);
    expect(offerFilters.properties.pricing_structures).toBeDefined();
    expect(offerFilters.properties.required_performance_standards.type).toBe('array');
    expect(offerFilters.properties.required_vendor_metrics.type).toBe('array');

    const refineTool = tools.get('refine_proposals')!;
    const runtimeRefinement = resolveLocalRef(refineTool, refineTool.properties.refinements.items);
    const sourceRefinement = sourceSchema('proposal-refinement');
    expect(runtimeRefinement).toMatchObject({
      type: sourceRefinement.type,
      required: sourceRefinement.required,
      additionalProperties: false,
    });

    // Repository-local refs must be bundled because MCP consumers do not have
    // an AdCP schema registry attached to tools/list.
    for (const runtime of tools.values()) {
      expect(JSON.stringify(runtime)).not.toContain('"$ref":"/schemas/');
    }
    expect(resolveLocalRef(list, list.properties.brand)).toMatchObject({ required: ['domain'], additionalProperties: false });
    expect(resolveLocalRef(list, list.properties.fields)).toMatchObject({
      minItems: 1,
      uniqueItems: true,
      items: { enum: expect.arrayContaining(['product_id', 'format_options', 'pricing_options']) },
    });
    expect(resolveLocalRef(list, list.properties.criteria)).toMatchObject({ additionalProperties: false });
    expect(resolveLocalRef(refineTool, refineTool.properties.refinements.items))
      .toMatchObject({
        required: ['proposal_id'],
        additionalProperties: false,
        // Definition annotations are intentionally stripped from tools/list;
        // dispatch still applies the source-schema default semantics.
        properties: { action: { enum: ['revise', 'finalize'] } },
        oneOf: expect.any(Array),
      });
    const declineTool = tools.get('decline_proposals')!;
    expect(resolveLocalRef(declineTool, declineTool.properties.declines.items))
      .toMatchObject({ required: ['proposal_id', 'reason'], additionalProperties: false });
  });

  it('bundles each tools/list input schema as a valid standalone document', () => {
    const ajv = new Ajv({ strict: false, validateFormats: false });
    for (const tool of productDiscoveryAliasToolDefinitions()) {
      expect(() => ajv.compile(tool.inputSchema), tool.name).not.toThrow();
    }
  });

  it('keeps the compact lifecycle within its tools/list context budget', () => {
    const tools = productDiscoveryAliasToolDefinitions();
    for (const tool of tools) {
      expect(tool.inputSchema).not.toHaveProperty('$id');
      expect(tool.inputSchema).not.toHaveProperty('title');
      expect(tool.inputSchema).not.toHaveProperty('description');
    }
    const totalBytes = tools.reduce(
      (sum, tool) => sum + Buffer.byteLength(JSON.stringify(tool.inputSchema)),
      0,
    );
    expect(totalBytes).toBeLessThanOrEqual(40 * 1024);

    const list = tools.find(tool => tool.name === 'list_products')!.inputSchema as JsonSchema;
    const criteria = resolveLocalRef(list, list.properties.criteria);
    expect(criteria.properties.offer_filters).toBeDefined();
    expect(criteria.properties).not.toHaveProperty('targeting_overlay');
    expect(criteria.properties).not.toHaveProperty('required_overlay_support');
  });

  it('enforces URI formats from the normative source schema at dispatch', () => {
    expect(validateProductDiscoverySourceInput('request-proposals-request', {
      idempotency_key: 'format-check-key-1234',
      brand: { domain: 'format-check.example' },
      brief: 'Reach relevant buyers',
      push_notification_config: { url: 'not a uri' },
    })).toMatchObject({ field: 'push_notification_config.url' });
  });
});
