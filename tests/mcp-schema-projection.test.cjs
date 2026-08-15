#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const AjvDraft07 = require('ajv');
const Ajv2020 = require('ajv/dist/2020');
const addFormats = require('ajv-formats');
const yaml = require('js-yaml');
const {
  normalizeSubstitutions,
} = require('../scripts/lint-storyboard-sample-request-schema.cjs');
const {
  MCP_ROLE_PROFILE_TOOLS,
  MCP_ROLE_PROFILE_TASK_RESULT_OVERRIDES,
  buildTaskResultResolution,
  validateManifestToolRelationships,
} = require('../scripts/build-schemas.cjs');
const {
  JSON_SCHEMA_2020_12,
  MAX_SCHEMA_BYTES,
  MAX_SCHEMA_DEPTH,
  MAX_SCHEMA_OBJECTS,
  MCP_PROTOCOL_VERSION,
  assertLocalRefsResolve,
  buildRuntimeToolsList,
  collectExternalRefs,
  compactDraft07Schema,
  measureSchema,
  projectDraft07Node,
  selectRuntimeToolNames,
  stripPresentationAnnotations,
  stripModelContextAnnotations,
} = require('../scripts/mcp-schema-projection.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const SOURCE_DIR = path.join(REPO_ROOT, 'static', 'schemas', 'source');
const STORYBOARD_DIR = path.join(REPO_ROOT, 'static', 'compliance', 'source');
const LATEST_DIR = path.join(REPO_ROOT, 'dist', 'schemas', 'latest');
const PROJECTION_DIR = path.join(LATEST_DIR, 'mcp', MCP_PROTOCOL_VERSION);
const PRODUCTION_PROFILE_DIR = path.join(PROJECTION_DIR, 'profiles', 'production');
// Keep parity compilation materially tighter than the 4 MiB protocol schema
// bound while allowing example-bearing schemas to carry the complete Product
// targeting contract. The test below still compiles both dialects and executes
// every collected storyboard fixture.
const PARITY_COMPILE_LIMIT = 1_250_000;

function readJson(filename) {
  return JSON.parse(fs.readFileSync(filename, 'utf8'));
}

test('manifest tool relationships reject unknown, self-referential, and cyclic adapters', () => {
  const legacy = { name: 'legacy_tool', deprecated_in: '3.2.0' };
  const current = {
    name: 'current_tool',
    legacy_fallback: { tool: 'legacy_tool', mode: 'orchestrated' },
  };
  assert.doesNotThrow(() => validateManifestToolRelationships([legacy, current]));
  assert.throws(
    () => validateManifestToolRelationships([legacy, { ...current, legacy_fallback: { tool: 'missing_tool', mode: 'direct' } }]),
    /unknown tool/
  );
  assert.throws(
    () => validateManifestToolRelationships([{ ...legacy, legacy_fallback: { tool: 'legacy_tool', mode: 'direct' } }]),
    /itself/
  );
  assert.throws(
    () => validateManifestToolRelationships([
      { name: 'legacy_a', deprecated_in: '3.2.0', legacy_fallback: { tool: 'legacy_b', mode: 'direct' } },
      { name: 'legacy_b', deprecated_in: '3.2.0', legacy_fallback: { tool: 'legacy_a', mode: 'direct' } },
    ]),
    /cycle/
  );
});

test('task result overrides cannot replace a manifest tool response schema', () => {
  assert.throws(
    () => buildTaskResultResolution(SOURCE_DIR, { media_buy_delivery: { response_schema: 'wrong.json' } }),
    /also names a manifest tool/
  );
});

function createValidator(AjvClass) {
  const ajv = new AjvClass({
    addUsedSchema: false,
    allErrors: true,
    allowUnionTypes: true,
    discriminator: true,
    strict: false,
  });
  addFormats(ajv);
  return ajv;
}

function walkYamlFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walkYamlFiles(filename));
    if (entry.isFile() && /\.ya?ml$/.test(entry.name)) files.push(filename);
  }
  return files;
}

function collectStoryboardRequestFixtures() {
  const fixtures = new Map();
  for (const filename of walkYamlFiles(STORYBOARD_DIR)) {
    const storyboard = yaml.load(fs.readFileSync(filename, 'utf8'));
    for (const phase of storyboard?.phases || []) {
      for (const step of phase?.steps || []) {
        if (
          !step?.schema_ref
          || step.schema_ref.startsWith('$')
          || !step.sample_request
          || typeof step.sample_request !== 'object'
        ) {
          continue;
        }
        const relativePath = step.schema_ref.replace(/^\/schemas\//, '');
        const sourcePath = path.join(SOURCE_DIR, relativePath);
        if (!fs.existsSync(sourcePath)) continue;
        const sourceSchema = readJson(sourcePath);
        const fixture = normalizeSubstitutions(step.sample_request, sourceSchema);
        if (!fixtures.has(relativePath)) fixtures.set(relativePath, []);
        fixtures.get(relativePath).push(fixture);
      }
    }
  }
  return fixtures;
}

test('schema bounds include the complete JSON document', () => {
  const schema = {
    type: 'object',
    examples: [{ payload: { nested: ['value'] } }],
  };

  assert.deepEqual(measureSchema(schema), {
    bytes: Buffer.byteLength(JSON.stringify(schema)),
    depth: 6,
    objectCount: 3,
  });
});

test('structural presentation mode removes only schema annotations', () => {
  const source = {
    title: 'Request title',
    description: 'Request description',
    enumDescriptions: { value: 'Display label' },
    type: 'object',
    properties: {
      payload: {
        description: 'Field description',
        const: { description: 'validated payload data' },
        default: { description: 'default payload data' },
      },
    },
    examples: [{ description: 'example payload data' }],
  };

  assert.deepEqual(stripPresentationAnnotations(source), {
    type: 'object',
    properties: {
      payload: {
        const: { description: 'validated payload data' },
        default: { description: 'default payload data' },
      },
    },
  });
});

test('model-context presentation keeps request shape and omits validation-only detail', () => {
  const projected = stripModelContextAnnotations({
    title: 'Prompt fixture',
    type: 'object',
    properties: {
      destination: {
        type: 'string',
        format: 'uri',
        pattern: '^https://',
        minLength: 1,
        description: 'A destination URI.',
        'x-adcp-validation': { verifier: 'uri' },
      },
      mode: { type: 'string', enum: ['direct', 'proposal'] },
    },
    required: ['destination'],
    oneOf: [
      { required: ['mode'] },
      { not: { required: ['mode'] } },
    ],
  });

  assert.equal(projected.title, undefined);
  assert.equal(projected.properties.destination.description, undefined);
  assert.equal(projected.properties.destination.format, undefined);
  assert.equal(projected.properties.destination.pattern, undefined);
  assert.equal(projected.properties.destination.minLength, undefined);
  assert.equal(projected.properties.destination['x-adcp-validation'], undefined);
  assert.deepEqual(projected.required, ['destination']);
  assert.deepEqual(projected.properties.mode.enum, ['direct', 'proposal']);
  assert.equal(projected.oneOf[1].not.required[0], 'mode');
});

test('draft-07 projection converts dialect-specific keywords without tightening', () => {
  const source = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    definitions: {
      Name: { type: 'string' },
    },
    properties: {
      name: { $ref: '#/definitions/Name' },
      nestedName: { $ref: '#/properties/nested/definitions/Name' },
      nested: {
        type: 'object',
        definitions: { Name: { type: 'string' } },
      },
      tuple: {
        type: 'array',
        items: [{ type: 'string' }, { type: 'integer' }],
        additionalItems: false,
      },
    },
    dependencies: {
      name: ['tuple'],
      tuple: { required: ['name'] },
    },
    additionalProperties: true,
  };

  const projected = projectDraft07Node(source);

  assert.equal(projected.$schema, JSON_SCHEMA_2020_12);
  assert.deepEqual(projected.$defs.Name, { type: 'string' });
  assert.equal(projected.properties.name.$ref, '#/$defs/Name');
  assert.equal(projected.properties.nestedName.$ref, '#/properties/nested/$defs/Name');
  assert.deepEqual(projected.properties.nested.$defs.Name, { type: 'string' });
  assert.deepEqual(projected.properties.tuple.prefixItems, [
    { type: 'string' },
    { type: 'integer' },
  ]);
  assert.equal(projected.properties.tuple.items, false);
  assert.deepEqual(projected.dependentRequired, { name: ['tuple'] });
  assert.deepEqual(projected.dependentSchemas, { tuple: { required: ['name'] } });
  assert.equal(projected.additionalProperties, true);
  assert.equal(projected.unevaluatedProperties, undefined);
  assert.equal(projected.definitions, undefined);
  assert.equal(projected.dependencies, undefined);
  assert.equal(projected.additionalItems, undefined);
});

test('draft-07 and 2020-12 validators preserve high-risk conversion boundaries', () => {
  const source = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    definitions: {
      Name: { type: 'string', minLength: 1 },
    },
    properties: {
      name: { $ref: '#/definitions/Name' },
      tuple: {
        type: 'array',
        items: [{ type: 'string' }, { type: 'integer' }],
        additionalItems: false,
      },
    },
    dependencies: {
      name: ['tuple'],
      tuple: { required: ['name'] },
    },
    additionalProperties: false,
  };
  const projected = projectDraft07Node(source);
  const validateSource = createValidator(AjvDraft07).compile(source);
  const validateProjected = createValidator(Ajv2020).compile(projected);
  const corpus = [
    {},
    { name: 'Ada', tuple: ['primary', 1] },
    { name: 'Ada' },
    { tuple: ['primary', 1] },
    { name: 'Ada', tuple: ['primary', 1, 'extra'] },
    { name: 'Ada', tuple: ['primary', 1], unexpected: true },
  ];

  const sourceOutcomes = corpus.map(instance => validateSource(instance));
  assert.ok(sourceOutcomes.includes(true), 'parity corpus must exercise an accepted instance');
  assert.ok(sourceOutcomes.includes(false), 'parity corpus must exercise rejected instances');
  for (const [index, instance] of corpus.entries()) {
    assert.equal(
      validateProjected(instance),
      sourceOutcomes[index],
      `high-risk conversion changed outcome for ${JSON.stringify(instance)}`
    );
  }
});

test('projection rewrites only definitions keyword segments in local refs', () => {
  const projected = projectDraft07Node({
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    definitions: {
      RootName: { type: 'string' },
    },
    properties: {
      definitions: {
        type: 'object',
        properties: {
          LiteralName: { type: 'string' },
        },
      },
      literalName: {
        $ref: '#/properties/definitions/properties/LiteralName',
      },
      rootName: {
        $ref: '#/definitions/RootName',
      },
      nested: {
        type: 'object',
        definitions: {
          NestedName: { type: 'string' },
        },
        properties: {
          name: { $ref: '#/properties/nested/definitions/NestedName' },
        },
      },
    },
  });

  assert.equal(
    projected.properties.literalName.$ref,
    '#/properties/definitions/properties/LiteralName'
  );
  assert.equal(projected.properties.rootName.$ref, '#/$defs/RootName');
  assert.equal(
    projected.properties.nested.properties.name.$ref,
    '#/properties/nested/$defs/NestedName'
  );
  assert.ok(assertLocalRefsResolve(projected) >= 3);
});

test('source guard rejects dialect drift without scanning annotation payloads', () => {
  const rootFile = path.join(SOURCE_DIR, 'synthetic-source.json');
  assert.throws(
    () => compactDraft07Schema({
      $schema: JSON_SCHEMA_2020_12,
      type: 'object',
    }, rootFile, SOURCE_DIR),
    /must declare exact source dialect/
  );
  assert.throws(
    () => compactDraft07Schema({
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      unevaluatedProperties: false,
    }, rootFile, SOURCE_DIR),
    /post-draft-07 keyword "unevaluatedProperties"/
  );
  assert.doesNotThrow(() => compactDraft07Schema({
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    examples: [{
      $schema: JSON_SCHEMA_2020_12,
      unevaluatedProperties: false,
    }],
  }, rootFile, SOURCE_DIR));
});

test('projection refuses draft-07 $ref validation siblings', () => {
  assert.throws(
    () => projectDraft07Node({ $ref: '#/definitions/Name', minLength: 1 }),
    /Cannot preserve draft-07 \$ref semantics/
  );
  assert.doesNotThrow(() => projectDraft07Node({
    $ref: '#/definitions/Name',
    description: 'Annotation siblings do not change validation outcomes.',
  }));
});

test('projection never rewrites or scans example payloads that resemble schemas', () => {
  const payload = {
    $schema: '/schemas/brand.json',
    $ref: 'https://payload.example/not-a-schema-ref.json',
    dependencies: { editorial: ['review'] },
    items: [{ type: 'not-a-schema-keyword-here' }],
  };
  const projected = projectDraft07Node({
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    examples: [payload],
    default: payload,
  });

  assert.deepEqual(projected.examples, [payload]);
  assert.deepEqual(projected.default, payload);
  assert.deepEqual(collectExternalRefs(projected), []);
});

test('compact bundling reuses external schemas and keeps local refs resolvable', () => {
  const rootPath = path.join(SOURCE_DIR, 'signals', 'get-signals-request.json');
  const compact = compactDraft07Schema(readJson(rootPath), rootPath, SOURCE_DIR);
  const accountRefs = Object.keys(compact.definitions || {})
    .filter(key => key === 'external:core/account-ref.json');

  assert.equal(accountRefs.length, 1);
  assert.deepEqual(collectExternalRefs(compact), []);
  assert.ok(assertLocalRefsResolve(projectDraft07Node(compact)) > 0);
});

test('compact lifecycle routes every operational control and declares cross-item invariants', () => {
  const routedActions = readJson(path.join(SOURCE_DIR, 'core', 'canonical-media-buy-action.json'));
  const controlActions = new Set(routedActions.oneOf
    .find(branch => branch.properties.task.const === 'control_media_buy')
    .properties.action.enum);
  const controlRequest = readJson(path.join(SOURCE_DIR, 'media-buy', 'control-media-buy-request.json'));
  const packageControl = readJson(path.join(SOURCE_DIR, 'media-buy', 'package-control.json'));
  const fieldRoutes = {
    paused: ['pause', 'resume'],
    canceled: ['cancel'],
    total_budget: ['increase_budget', 'decrease_budget'],
    budget_allocation: ['update_budget_allocation'],
    pacing: ['update_pacing'],
    bidding: ['update_bidding'],
    reporting_webhook: ['update_reporting_webhook'],
    budget: ['increase_budget', 'decrease_budget'],
    min_spend_target: ['update_spend_target'],
    impressions: ['update_impression_goal'],
    targeting_overlay: ['update_targeting'],
    catalog_ids: ['update_catalog_assignments'],
    keyword_targets_add: ['update_keywords'],
    keyword_targets_remove: ['update_keywords'],
    negative_keywords_add: ['update_keywords'],
    negative_keywords_remove: ['update_keywords'],
    optimization_goals: ['update_optimization_goals'],
  };
  for (const [field, actions] of Object.entries(fieldRoutes)) {
    assert.ok(controlRequest.properties[field] || packageControl.properties[field], `${field} is not a control field`);
    for (const action of actions) assert.ok(controlActions.has(action), `${field} lacks routed action ${action}`);
  }
  assert.equal(
    controlRequest.properties.packages['x-adcp-validation'].verifier_constraints.unique_package_ids.key,
    'package_id'
  );
  assert.equal(
    packageControl['x-adcp-validation'].verifier_constraints.keyword_identity_sets.positive_add_remove,
    'disjoint_by_normalized_keyword_and_match_type'
  );
  const commitment = readJson(path.join(SOURCE_DIR, 'media-buy', 'media-buy-commitment-response.json'));
  const bindingRule = commitment.oneOf[0].properties.purchase_bindings['x-adcp-validation']
    .verifier_constraints.complete_purchase_bijection;
  assert.equal(bindingRule.purchase_indexes, 'unique_contiguous_zero_based_range');
  assert.equal(bindingRule.product_id, 'equals_indexed_purchase.product_id');
  const productPurchase = readJson(path.join(SOURCE_DIR, 'media-buy', 'product-purchase.json'));
  assert.equal(
    productPurchase['x-adcp-validation'].verifier_constraints.pricing_identity.pricing_option_id,
    'equals_pricing.pricing_option_id_when_pricing_present'
  );
  const commercialTerms = readJson(path.join(SOURCE_DIR, 'media-buy', 'commercial-terms.json'));
  const pricingIntegrity = commercialTerms['x-adcp-validation'].verifier_constraints.pricing_integrity;
  assert.equal(pricingIntegrity.purchase_currencies, 'all_purchase.pricing.currency_equal');
  assert.equal(pricingIntegrity.total_budget_currency, 'when_total_budget_present_equals_purchase_pricing_currency');
  const asyncUnion = readJson(path.join(SOURCE_DIR, 'core', 'async-response-data.json'));
  const asyncRefs = new Set(asyncUnion.anyOf.map(branch => branch.$ref));
  for (const variant of ['submitted', 'working', 'input-required']) {
    assert.ok(asyncRefs.has(`/schemas/core/compact-task-${variant}.json`));
  }
});

test('generated MCP projection covers every tool within AdCP safety bounds', () => {
  assert.ok(
    fs.existsSync(PROJECTION_DIR),
    'MCP schema projection is missing; run npm run build:schemas before this test'
  );

  const canonicalManifest = readJson(path.join(LATEST_DIR, 'manifest.json'));
  const projectionManifest = readJson(path.join(PROJECTION_DIR, 'manifest.json'));
  const storyboardFixtures = collectStoryboardRequestFixtures();
  const validateCanonicalManifest = createValidator(AjvDraft07).compile(
    readJson(path.join(SOURCE_DIR, 'manifest.schema.json'))
  );
  assert.equal(
    validateCanonicalManifest(canonicalManifest),
    true,
    JSON.stringify(validateCanonicalManifest.errors)
  );
  assert.equal(projectionManifest.mcp_protocol_version, MCP_PROTOCOL_VERSION);
  assert.equal(projectionManifest.schema_dialect, JSON_SCHEMA_2020_12);
  assert.equal(projectionManifest.annotation_mode, 'full');
  assert.deepEqual(projectionManifest.schema_fields, ['inputSchema', 'outputSchema']);
  assert.match(projectionManifest.delivery, /downloadable schema artifacts/);
  assert.deepEqual(canonicalManifest.task_result_resolution, {
    discriminator_field: 'task_type',
    terminal_schema_pointer_template: '/tools/{task_type}/response_schema',
    terminal_schema_overrides: {
      media_buy_delivery: 'media-buy/media-buy-delivery-webhook-result.json',
    },
  });
  assert.deepEqual(projectionManifest.task_result_resolution, {
    discriminator_field: 'task_type',
    terminal_schema_pointer_template: '/tools/{task_type}/outputSchema',
    terminal_schema_overrides: {
      media_buy_delivery: 'media-buy/media-buy-delivery-webhook-result.json',
    },
  });
  assert.ok(fs.existsSync(path.join(
    PROJECTION_DIR,
    projectionManifest.task_result_resolution.terminal_schema_overrides.media_buy_delivery
  )));
  const taskTypes = readJson(path.join(SOURCE_DIR, 'enums', 'task-type.json')).enum;
  for (const taskType of taskTypes) {
    const selectedSchema = canonicalManifest.task_result_resolution.terminal_schema_overrides[taskType]
      || canonicalManifest.tools[taskType]?.response_schema;
    assert.equal(typeof selectedSchema, 'string', `${taskType} must resolve to a terminal schema`);
    assert.ok(fs.existsSync(path.join(LATEST_DIR, selectedSchema)), `${taskType} result schema must exist`);
  }
  assert.deepEqual(canonicalManifest.tools.get_products.superseded_by, [
    'list_products',
    'request_proposals',
    'refine_proposals',
    'decline_proposals',
  ]);
  assert.deepEqual(canonicalManifest.tools.list_products.legacy_fallback, {
    tool: 'get_products',
    mode: 'orchestrated',
  });
  assert.equal(canonicalManifest.tools.request_proposals.legacy_fallback.mode, 'orchestrated');
  assert.equal(canonicalManifest.tools.refine_proposals.legacy_fallback.mode, 'orchestrated');
  assert.deepEqual(canonicalManifest.tools.decline_proposals.legacy_fallback, { mode: 'none' });
  assert.deepEqual(canonicalManifest.tools.buy_products.legacy_fallback, {
    tool: 'create_media_buy',
    mode: 'orchestrated',
  });
  assert.equal(canonicalManifest.tools.accept_proposal.legacy_fallback.tool, 'create_media_buy');
  assert.equal(canonicalManifest.tools.control_media_buy.legacy_fallback.tool, 'update_media_buy');
  assert.deepEqual(canonicalManifest.tools.create_media_buy.superseded_by, [
    'buy_products',
    'accept_proposal',
  ]);
  assert.deepEqual(canonicalManifest.tools.update_media_buy.superseded_by, [
    'control_media_buy',
    'refine_proposals',
  ]);
  for (const toolName of [
    'request_proposals',
    'refine_proposals',
    'decline_proposals',
    'buy_products',
    'accept_proposal',
    'control_media_buy',
  ]) {
    assert.deepEqual(canonicalManifest.tools[toolName].async_response_schemas, [
      `media-buy/${toolName.replaceAll('_', '-')}-async-response-input-required.json`,
      `media-buy/${toolName.replaceAll('_', '-')}-async-response-submitted.json`,
      `media-buy/${toolName.replaceAll('_', '-')}-async-response-working.json`,
    ]);
  }
  assert.deepEqual(
    Object.keys(projectionManifest.tools).sort(),
    Object.keys(canonicalManifest.tools).sort()
  );
  const projectedTaskStatus = readJson(
    path.join(PROJECTION_DIR, projectionManifest.tools.get_task_status.outputSchema)
  );
  assert.ok(
    measureSchema(projectedTaskStatus).bytes < 100_000,
    'generic get_task_status output should not embed the global task-result union'
  );

  for (const toolName of [
    'list_products',
    'request_proposals',
    'refine_proposals',
    'decline_proposals',
    'buy_products',
    'accept_proposal',
    'control_media_buy',
  ]) {
    const tool = projectionManifest.tools[toolName];
    const input = JSON.stringify(readJson(path.join(PROJECTION_DIR, tool.inputSchema)));
    const output = JSON.stringify(readJson(path.join(PROJECTION_DIR, tool.outputSchema)));
    assert.doesNotMatch(input, /(?:Provenance|provenance\.json|AssetVariant|asset-variant\.json)/,
      `${toolName} input must not depend on the creative provenance graph`);
    assert.doesNotMatch(input, /format_ids|format-id\.json|v1_format_ref/,
      `${toolName} input must not expose legacy named-format creatives`);
    assert.doesNotMatch(output, /(?:AssetVariant|asset-variant\.json)/,
      `${toolName} output must not depend on creative asset variants`);
    if (['list_products', 'request_proposals', 'refine_proposals'].includes(toolName)) {
      assert.match(output, /Canonical Product/,
        `${toolName} output must use the canonical-only Product view`);
      assert.doesNotMatch(output, /format_ids|format-id\.json|v1_format_ref|update_packages|update_media_buy/,
        `${toolName} output must not expose the legacy Product graph`);
    }
  }

  const productionManifest = readJson(path.join(PRODUCTION_PROFILE_DIR, 'manifest.json'));
  for (const compatibilityTool of ['get_products', 'create_media_buy', 'update_media_buy']) {
    assert.equal(
      productionManifest.tools[compatibilityTool],
      undefined,
      `${compatibilityTool} must be absent from the clean 3.2 production profile`
    );
  }

  const projectedListProductsOutput = readJson(path.join(
    PROJECTION_DIR,
    projectionManifest.tools.list_products.outputSchema
  ));
  const validateProjectedListProducts = createValidator(Ajv2020).compile(projectedListProductsOutput);
  const projectedProductBase = {
    product_id: 'canonical-product-1',
    name: 'Canonical product',
    description: 'Projection boundary fixture',
    publisher_properties: [{ publisher_domain: 'publisher.example', selection_type: 'all' }],
    delivery_type: 'guaranteed',
    pricing_options: [{
      pricing_option_id: 'cpm',
      pricing_model: 'cpm',
      fixed_price: 10,
      currency: 'USD',
    }],
    reporting_capabilities: {
      available_reporting_frequencies: ['daily'],
      expected_delay_minutes: 240,
      timezone: 'UTC',
      supports_webhooks: false,
      available_metrics: ['impressions'],
      date_range_support: 'date_range',
    },
  };
  assert.equal(validateProjectedListProducts({
    outcome: 'listed',
    feed_version: 'feed-1',
    cache_scope: 'public',
    products: [{
      ...projectedProductBase,
      format_options: [{ format_kind: 'image', params: { width: 300, height: 250 } }],
    }],
  }), true, JSON.stringify(validateProjectedListProducts.errors));
  assert.equal(validateProjectedListProducts({
    outcome: 'listed',
    feed_version: 'feed-1',
    cache_scope: 'public',
    products: [{
      ...projectedProductBase,
      format_ids: [{ agent_url: 'https://legacy-creative.example', id: 'display_300x250' }],
    }],
  }), false, 'projected list_products output accepted a legacy-only creative declaration');

  const seen = new Set();
  const paritySchemas = new Map();
  let totalBytes = 0;
  let localRefCount = 0;

  for (const [toolName, tool] of Object.entries(projectionManifest.tools)) {
    for (const field of ['inputSchema', 'outputSchema']) {
      const relativePath = tool[field];
      const projectedPath = path.join(PROJECTION_DIR, relativePath);
      const sourcePath = path.join(SOURCE_DIR, relativePath);
      assert.ok(fs.existsSync(projectedPath), `${toolName}.${field} projection is missing`);
      assert.ok(fs.existsSync(sourcePath), `${toolName}.${field} source schema is missing`);
      if (seen.has(relativePath)) continue;
      seen.add(relativePath);

      const projectedSchema = readJson(projectedPath);
      const metrics = measureSchema(projectedSchema);
      assert.equal(projectedSchema.$schema, JSON_SCHEMA_2020_12);
      assert.equal(
        projectedSchema.$id,
        `https://adcontextprotocol.org/schemas/latest/mcp/${MCP_PROTOCOL_VERSION}/${relativePath}`
      );
      assert.deepEqual(collectExternalRefs(projectedSchema), []);
      localRefCount += assertLocalRefsResolve(projectedSchema);
      assert.ok(metrics.depth <= MAX_SCHEMA_DEPTH, `${relativePath} depth ${metrics.depth}`);
      assert.ok(metrics.objectCount <= MAX_SCHEMA_OBJECTS, `${relativePath} objects ${metrics.objectCount}`);
      assert.ok(metrics.bytes <= MAX_SCHEMA_BYTES, `${relativePath} bytes ${metrics.bytes}`);
      totalBytes += metrics.bytes;

      if (field === 'inputSchema') {
        assert.equal(projectedSchema.type, 'object', `${toolName} inputSchema must have an object root`);
      }

      const fixtures = storyboardFixtures.get(relativePath);
      if (fixtures?.length) {
        paritySchemas.set(relativePath, {
          bytes: metrics.bytes,
          fixtures,
          sourceSchema: readJson(sourcePath),
        });
      }
    }
  }

  assert.ok(localRefCount > 1_000, `expected broad local-ref coverage, saw ${localRefCount}`);
  assert.ok(totalBytes < 20 * 1024 * 1024, `projection is unexpectedly large: ${totalBytes} bytes`);

  const draft07 = createValidator(AjvDraft07);
  const draft2020 = createValidator(Ajv2020);
  let validParityCaseCount = 0;
  let invalidParityCaseCount = 0;
  for (const [relativePath, { bytes, fixtures, sourceSchema }] of paritySchemas) {
    assert.ok(
      bytes <= PARITY_COMPILE_LIMIT,
      `${relativePath} example-bearing schema exceeds parity compile limit`
    );
    const sourcePath = path.join(SOURCE_DIR, relativePath);
    const compactSource = compactDraft07Schema(sourceSchema, sourcePath, SOURCE_DIR);
    const projectedSchema = readJson(path.join(PROJECTION_DIR, relativePath));
    const validateSource = draft07.compile(compactSource);
    const validateProjected = draft2020.compile(projectedSchema);

    let firstValidFixture;
    for (const [index, fixture] of fixtures.entries()) {
      const sourceValid = validateSource(fixture);
      assert.equal(
        validateProjected(fixture),
        sourceValid,
        `${relativePath} changed storyboard fixture ${index} validation outcome`
      );
      if (sourceValid) {
        firstValidFixture ||= fixture;
        validParityCaseCount++;
      } else {
        invalidParityCaseCount++;
      }
    }

    assert.ok(firstValidFixture, `${relativePath} needs at least one valid storyboard fixture`);
    assert.equal(sourceSchema.type, 'object', `${relativePath} parity mutation assumes an object root`);
    const invalidRootMutation = [structuredClone(firstValidFixture)];
    assert.equal(validateSource(invalidRootMutation), false, `${relativePath} root mutation must be invalid`);
    assert.equal(
      validateProjected(invalidRootMutation),
      false,
      `${relativePath} projected schema accepted an invalid root mutation`
    );
    invalidParityCaseCount++;

    const requiredKey = sourceSchema.required?.find(key => Object.hasOwn(firstValidFixture, key));
    if (requiredKey) {
      const missingRequired = structuredClone(firstValidFixture);
      delete missingRequired[requiredKey];
      assert.equal(
        validateSource(missingRequired),
        false,
        `${relativePath} missing-required mutation must be invalid`
      );
      assert.equal(
        validateProjected(missingRequired),
        false,
        `${relativePath} projected schema accepted missing required property ${requiredKey}`
      );
      invalidParityCaseCount++;
    }
  }

  assert.ok(paritySchemas.size >= 55, `expected fixtures from at least 55 schemas, saw ${paritySchemas.size}`);
  assert.ok(validParityCaseCount >= 650, `expected at least 650 valid parity cases, saw ${validParityCaseCount}`);
  assert.ok(
    invalidParityCaseCount >= paritySchemas.size,
    `expected an invalid mutation for every parity schema, saw ${invalidParityCaseCount}`
  );
});

test('generated production profile exposes the active 3.2 surface without compliance annotations', () => {
  assert.ok(fs.existsSync(PRODUCTION_PROFILE_DIR), 'production profile is missing');
  const canonicalManifest = readJson(path.join(LATEST_DIR, 'manifest.json'));
  const profile = readJson(path.join(PRODUCTION_PROFILE_DIR, 'manifest.json'));

  assert.equal(profile.profile, 'production');
  assert.equal(profile.surface_version, '3.2.0');
  assert.equal(profile.annotation_mode, 'structural');
  assert.deepEqual(profile.filters, {
    exclude_protocols: ['compliance'],
    exclude_deprecated: true,
  });

  const expectedTools = Object.entries(canonicalManifest.tools)
    .filter(([, tool]) => tool.protocol !== 'compliance')
    .filter(([, tool]) => !tool.added_in || tool.added_in <= profile.surface_version)
    .filter(([, tool]) => !tool.deprecated_in || tool.deprecated_in > profile.surface_version)
    .map(([toolName]) => toolName)
    .sort();
  assert.deepEqual(Object.keys(profile.tools).sort(), expectedTools);
  assert.ok(!profile.tools.comply_test_controller);
  assert.ok(!profile.tools.get_products);
  assert.ok(!profile.tools.list_creative_formats);
  for (const [toolName, tool] of Object.entries(profile.tools)) {
    assert.equal(tool.protocol, canonicalManifest.tools[toolName].protocol);
    assert.notEqual(tool.protocol, 'compliance');
  }

  let profileBytes = 0;
  let canonicalBytes = 0;
  const seen = new Set();
  for (const tool of Object.values(profile.tools)) {
    for (const field of ['inputSchema', 'outputSchema']) {
      if (seen.has(tool[field])) continue;
      seen.add(tool[field]);
      profileBytes += fs.statSync(path.join(PRODUCTION_PROFILE_DIR, tool[field])).size;
      canonicalBytes += fs.statSync(path.join(PROJECTION_DIR, tool[field])).size;
    }
  }
  assert.ok(profileBytes < canonicalBytes * 0.65, `${profileBytes} should be materially smaller than ${canonicalBytes}`);
});

test('runtime selection fails closed on unknown, unimplemented, and production-only capability claims', () => {
  const manifest = readJson(path.join(LATEST_DIR, 'manifest.json'));
  const implementedTools = ['get_adcp_capabilities', 'list_products'];

  assert.deepEqual(selectRuntimeToolNames(manifest, { implementedTools }), implementedTools);
  assert.deepEqual(selectRuntimeToolNames(manifest, {
    implementedTools,
    capabilityProtocols: [],
    capabilityTools: [],
  }), []);
  assert.throws(
    () => selectRuntimeToolNames(manifest, {
      implementedTools,
      capabilityTools: ['request_proposals'],
    }),
    /advertises unimplemented tool request_proposals/
  );
  assert.throws(
    () => selectRuntimeToolNames(manifest, {
      implementedTools: [...implementedTools, 'not_an_adcp_tool'],
    }),
    /unknown tool not_an_adcp_tool/
  );
  assert.throws(
    () => selectRuntimeToolNames(manifest, {
      implementedTools: ['comply_test_controller'],
      capabilityTools: ['comply_test_controller'],
    }),
    /cannot select compliance tool/
  );
});

test('representative capability-selected media-buy runtime exposes only selected input schemas', () => {
  const canonicalManifest = readJson(path.join(LATEST_DIR, 'manifest.json'));
  const productionManifest = readJson(path.join(PRODUCTION_PROFILE_DIR, 'manifest.json'));
  const selectedToolNames = selectRuntimeToolNames(canonicalManifest, {
    implementedTools: MCP_ROLE_PROFILE_TOOLS['media-buy'],
    capabilityProtocols: ['media_buy'],
    capabilityTools: ['get_adcp_capabilities', 'get_task_status'],
  });

  assert.ok(selectedToolNames.includes('list_products'));
  assert.ok(selectedToolNames.includes('request_proposals'));
  assert.ok(selectedToolNames.includes('get_adcp_capabilities'));
  assert.ok(selectedToolNames.includes('get_task_status'));
  assert.ok(!selectedToolNames.includes('sync_creatives'));
  assert.ok(!selectedToolNames.includes('sync_accounts'));
  assert.ok(
    selectedToolNames.length < Object.keys(productionManifest.tools).length / 3,
    `${selectedToolNames.length} selected tools should be materially fewer than `
      + `${Object.keys(productionManifest.tools).length} production tools`
  );

  const runtimeTools = buildRuntimeToolsList(
    productionManifest,
    selectedToolNames,
    relativePath => readJson(path.join(PRODUCTION_PROFILE_DIR, relativePath))
  );
  assert.deepEqual(runtimeTools.map(tool => tool.name), selectedToolNames);
  for (const tool of runtimeTools) {
    assert.equal(tool.description, canonicalManifest.tools[tool.name].summary);
    assert.ok(tool.description.length > 0);
    assert.equal(tool.inputSchema['x-tool-summary'], undefined);
    assert.equal(tool.outputSchema, undefined);
    assert.equal(tool.inputSchema.$schema, JSON_SCHEMA_2020_12);
    assert.deepEqual(collectExternalRefs(tool.inputSchema), []);
  }

  const storyboardFixtures = collectStoryboardRequestFixtures();
  const draft07 = createValidator(AjvDraft07);
  const draft2020 = createValidator(Ajv2020);
  let parityCases = 0;
  for (const toolName of selectedToolNames) {
    const sourceRelativePath = canonicalManifest.tools[toolName].request_schema;
    const fixtures = storyboardFixtures.get(sourceRelativePath) || [];
    if (fixtures.length === 0) continue;
    const sourcePath = path.join(SOURCE_DIR, sourceRelativePath);
    const sourceSchema = readJson(sourcePath);
    const compactSource = compactDraft07Schema(sourceSchema, sourcePath, SOURCE_DIR);
    const projectedSchema = runtimeTools.find(tool => tool.name === toolName).inputSchema;
    const validateSource = draft07.compile(compactSource);
    const validateProjected = draft2020.compile(projectedSchema);
    for (const [index, fixture] of fixtures.entries()) {
      assert.equal(
        validateProjected(fixture),
        validateSource(fixture),
        `${toolName} runtime projection changed storyboard fixture ${index}`
      );
      parityCases++;
    }
  }
  assert.ok(parityCases >= 25, `expected at least 25 selected-schema parity cases, saw ${parityCases}`);
});

test('generated role profiles are active validation catalogs with bounded model-context views', () => {
  const canonicalManifest = readJson(path.join(LATEST_DIR, 'manifest.json'));

  for (const [profileName, expectedTools] of Object.entries(MCP_ROLE_PROFILE_TOOLS)) {
    const profileDir = path.join(PROJECTION_DIR, 'profiles', profileName);
    const modelContextDir = path.join(profileDir, 'model-context');
    const profile = readJson(path.join(profileDir, 'manifest.json'));
    const modelContext = readJson(path.join(modelContextDir, 'manifest.json'));

    assert.equal(profile.profile, profileName);
    assert.equal(profile.profile_kind, 'active-role-catalog');
    assert.equal(profile.surface_version, '3.2.0');
    assert.equal(profile.compatibility_scope, 'active-3.2-only');
    assert.equal(profile.annotation_mode, 'structural');
    assert.deepEqual(profile.schema_fields, ['inputSchema', 'outputSchema']);
    assert.deepEqual(profile.filters, {
      include_tools: expectedTools,
      exclude_deprecated: true,
    });
    assert.deepEqual(Object.keys(profile.tools).sort(), [...expectedTools].sort());

    assert.equal(modelContext.profile, profileName);
    assert.equal(modelContext.view, 'client-prompt-inputs');
    assert.equal(modelContext.annotation_mode, 'model-context');
    assert.equal(modelContext.validation_profile, '../manifest.json');
    assert.equal(
      path.resolve(modelContextDir, modelContext.validation_profile),
      path.join(profileDir, 'manifest.json')
    );
    assert.deepEqual(modelContext.schema_fields, ['inputSchema']);
    assert.deepEqual(Object.keys(modelContext.tools).sort(), [...expectedTools].sort());

    const expectedOverrides = Object.fromEntries(
      MCP_ROLE_PROFILE_TASK_RESULT_OVERRIDES[profileName].map(taskType => [
        taskType,
        canonicalManifest.task_result_resolution.terminal_schema_overrides[taskType],
      ])
    );
    assert.deepEqual(profile.task_result_resolution, {
      discriminator_field: 'task_type',
      terminal_schema_pointer_template: '/tools/{task_type}/outputSchema',
      terminal_schema_overrides: expectedOverrides,
    });
    for (const relativePath of Object.values(expectedOverrides)) {
      assert.ok(fs.existsSync(path.join(profileDir, relativePath)));
    }
    assert.equal(modelContext.task_result_resolution, undefined);

    let modelContextBytes = 0;
    for (const toolName of expectedTools) {
      const fullTool = profile.tools[toolName];
      const modelTool = modelContext.tools[toolName];
      assert.ok(canonicalManifest.tools[toolName].summary, `${toolName} must provide a runtime summary`);
      assert.ok(
        canonicalManifest.tools[toolName].summary.length <= 160,
        `${toolName} runtime summary must stay concise`
      );
      assert.equal(fullTool.summary, canonicalManifest.tools[toolName].summary);
      assert.equal(modelTool.summary, fullTool.summary);
      assert.equal(fullTool.protocol, canonicalManifest.tools[toolName].protocol);
      assert.equal(modelTool.protocol, fullTool.protocol);
      assert.equal(modelTool.inputSchema, fullTool.inputSchema);
      assert.equal(modelTool.outputSchema, undefined);
      assert.ok(fs.existsSync(path.join(profileDir, fullTool.inputSchema)));
      assert.ok(fs.existsSync(path.join(profileDir, fullTool.outputSchema)));
      const modelInputPath = path.join(modelContextDir, modelTool.inputSchema);
      assert.ok(fs.existsSync(modelInputPath));
      modelContextBytes += Buffer.byteLength(JSON.stringify(readJson(modelInputPath)));
    }
    assert.ok(
      modelContextBytes < 388 * 1024,
      `${profileName} model-context inputs exceed 388 KiB: ${modelContextBytes}`
    );
  }

  const mediaBuyTools = new Set(MCP_ROLE_PROFILE_TOOLS['media-buy']);
  const activeMediaBuyTools = Object.entries(canonicalManifest.tools)
    .filter(([, tool]) => tool.protocol === 'media-buy')
    .filter(([, tool]) => !tool.deprecated_in || tool.deprecated_in > '3.2.0')
    .map(([toolName]) => toolName)
    .filter(toolName => toolName !== 'build_creative');
  for (const toolName of activeMediaBuyTools) assert.ok(mediaBuyTools.has(toolName), toolName);
  assert.ok(mediaBuyTools.has('sync_creatives'));
  assert.ok(mediaBuyTools.has('sync_governance'));
  assert.ok(mediaBuyTools.has('provide_performance_feedback'));
  assert.ok(!mediaBuyTools.has('build_creative'));
  for (const compatibilityFacade of ['get_products', 'create_media_buy', 'update_media_buy']) {
    assert.ok(!mediaBuyTools.has(compatibilityFacade));
    assert.ok(canonicalManifest.tools[compatibilityFacade].deprecated_in);
  }

  const creativeTools = new Set(MCP_ROLE_PROFILE_TOOLS.creative);
  const activeCreativeTools = Object.entries(canonicalManifest.tools)
    .filter(([, tool]) => tool.protocol === 'creative')
    .filter(([, tool]) => !tool.deprecated_in || tool.deprecated_in > '3.2.0')
    .map(([toolName]) => toolName);
  for (const toolName of activeCreativeTools) assert.ok(creativeTools.has(toolName), toolName);
  assert.ok(creativeTools.has('build_creative'));
  assert.ok(creativeTools.has('sync_catalogs'));
  assert.ok(creativeTools.has('sync_creatives'));
  assert.ok(!creativeTools.has('list_products'));
});
