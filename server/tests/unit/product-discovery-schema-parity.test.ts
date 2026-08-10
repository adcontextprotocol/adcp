import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv from 'ajv';
import { describe, expect, it } from 'vitest';
import { productDiscoveryAliasToolDefinitions } from '../../src/training-agent/task-handlers.js';

type JsonSchema = Record<string, any>;

function sourceSchema(name: string): JsonSchema {
  return JSON.parse(readFileSync(
    join(process.cwd(), `static/schemas/source/media-buy/${name}.json`),
    'utf8',
  )) as JsonSchema;
}

function forbiddenFields(schema: JsonSchema): string[] {
  return (schema.allOf ?? []).flatMap((entry: JsonSchema) => (
    entry.not?.anyOf ?? []
  ).flatMap((clause: JsonSchema) => clause.required ?? [])).sort();
}

function refinementBranches(schema: JsonSchema): unknown {
  return schema.items.oneOf.map((branch: JsonSchema) => ({
    scope: branch.properties.scope.const,
    required: branch.required,
    additionalProperties: branch.additionalProperties,
    action: branch.properties.action?.enum,
    fieldMinimums: Object.fromEntries(Object.entries(branch.properties)
      .flatMap(([name, value]) => (value as JsonSchema).minLength === undefined
        ? []
        : [[name, (value as JsonSchema).minLength]])),
  }));
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
      ['recommend_products', 'recommend-products-request'],
      ['refine_proposal', 'refine-proposal-request'],
      ['finalize_proposals', 'finalize-proposals-request'],
    ] as const) {
      const runtime = tools.get(toolName)!;
      const source = sourceSchema(fileName);
      expect(runtime.required ?? []).toEqual(source.required ?? []);
      expect(runtime.dependencies ?? {}).toEqual(source.dependencies ?? {});
      expect(forbiddenFields(runtime)).toEqual(forbiddenFields(source));
      expect(runtime.properties.idempotency_key).toMatchObject({
        minLength: source.properties.idempotency_key.minLength,
        maxLength: source.properties.idempotency_key.maxLength,
        pattern: source.properties.idempotency_key.pattern,
      });
    }

    const recommend = tools.get('recommend_products')!;
    expect(recommend.properties.brief.minLength)
      .toBe(sourceSchema('recommend-products-request').properties.brief.minLength);

    const list = tools.get('list_products')!;
    expect(list.allOf).toEqual(expect.arrayContaining([
      expect.objectContaining({
        if: { required: ['if_pricing_version'] },
        then: { required: ['if_wholesale_feed_version'] },
      }),
    ]));

    const refineTool = tools.get('refine_proposal')!;
    const runtimeRefinement = resolveLocalRef(refineTool, refineTool.properties.refine.allOf[0]);
    const sourceRefinement = sourceSchema('product-refinement');
    expect(runtimeRefinement).toMatchObject({ type: sourceRefinement.type, minItems: sourceRefinement.minItems });
    expect(refinementBranches(runtimeRefinement)).toEqual(refinementBranches(sourceRefinement));

    // Repository-local refs must be bundled because MCP consumers do not have
    // an AdCP schema registry attached to tools/list.
    for (const runtime of tools.values()) {
      expect(JSON.stringify(runtime)).not.toContain('"$ref":"/schemas/');
    }
    expect(resolveLocalRef(list, list.properties.brand)).toMatchObject({ required: ['domain'], additionalProperties: false });
    expect(resolveLocalRef(list, list.properties.catalog)).toMatchObject({ required: ['type'] });
    expect(resolveLocalRef(list, list.properties.fields)).toMatchObject({
      minItems: 1,
      uniqueItems: true,
      items: { enum: expect.arrayContaining(['product_id', 'format_options', 'pricing_options']) },
    });
    expect(resolveLocalRef(list, list.properties.property_list)).toMatchObject({
      required: ['agent_url', 'list_id'],
      additionalProperties: false,
    });
    expect(resolveLocalRef(list, list.properties.pagination)).toMatchObject({ additionalProperties: false });
  });

  it('bundles each tools/list input schema as a valid standalone document', () => {
    const ajv = new Ajv({ strict: false, validateFormats: false });
    for (const tool of productDiscoveryAliasToolDefinitions()) {
      expect(() => ajv.compile(tool.inputSchema), tool.name).not.toThrow();
    }
  });
});
