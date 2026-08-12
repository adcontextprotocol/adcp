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
  collectExternalRefs,
  compactDraft07Schema,
  measureSchema,
  projectDraft07Node,
  stripPresentationAnnotations,
} = require('../scripts/mcp-schema-projection.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const SOURCE_DIR = path.join(REPO_ROOT, 'static', 'schemas', 'source');
const STORYBOARD_DIR = path.join(REPO_ROOT, 'static', 'compliance', 'source');
const LATEST_DIR = path.join(REPO_ROOT, 'dist', 'schemas', 'latest');
const PROJECTION_DIR = path.join(LATEST_DIR, 'mcp', MCP_PROTOCOL_VERSION);
const PRODUCTION_PROFILE_DIR = path.join(PROJECTION_DIR, 'profiles', 'production');
const PARITY_COMPILE_LIMIT = 1_000_000;

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
  assert.match(projectionManifest.delivery, /downloadable schema artifacts/);
  assert.deepEqual(canonicalManifest.task_result_resolution, {
    discriminator_field: 'task_type',
    terminal_schema_pointer_template: '/tools/{task_type}/response_schema',
    terminal_schema_overrides: {
      media_buy_delivery: 'media-buy/media-buy-delivery-webhook-result.json',
    },
  });
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
    if (toolName !== 'decline_proposals') {
      assert.match(output, /Canonical Product/,
        `${toolName} output must use the canonical-only Product view`);
    }
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
      rate: 10,
      currency: 'USD',
      is_fixed: true,
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
    products: [{
      ...projectedProductBase,
      format_options: [{ format_kind: 'image', params: { width: 300, height: 250 } }],
    }],
  }), true, JSON.stringify(validateProjectedListProducts.errors));
  assert.equal(validateProjectedListProducts({
    outcome: 'listed',
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
