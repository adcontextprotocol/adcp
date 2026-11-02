#!/usr/bin/env node
/**
 * Extension and context fields validation test suite
 * Tests that ext and context fields work correctly across request, response, and core object schemas
 */

const fs = require('fs');
const path = require('path');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const SCHEMA_BASE_DIR = path.join(__dirname, '../static/schemas/source');
const { discoverTools } = require('../scripts/build-schemas.cjs');
const { readSourceSchemaDocument } = require('../scripts/wire-responses.cjs');

/** A source document by its `/schemas/...` reference, or the generated one at that path. */
function readSchemaRef(ref) {
  const rel = ref.replace(/^\/schemas\/(latest\/)?/, '');
  return readSourceSchemaDocument(path.join(SCHEMA_BASE_DIR, rel), SCHEMA_BASE_DIR);
}

function resolvePointer(root, pointer) {
  return pointer.replace(/^\//, '').split('/').filter(Boolean)
    .map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'))
    .reduce((node, part) => (node && typeof node === 'object' ? node[part] : undefined), root);
}

/**
 * The declaration a response node reaches for a top-level field: its own
 * `properties`, a member of its `allOf` (the protocol envelope among them), a
 * whole-document or fragment `$ref`, or, for `oneOf`/`anyOf`, every member.
 * Returns the declaration, or null when some path through the node lacks it.
 */
function reachedDeclaration(node, name, root, seen = new Set()) {
  if (!node || typeof node !== 'object') return null;
  if (node.$ref) {
    const [documentRef, fragment] = node.$ref.split('#');
    const document = documentRef ? readSchemaRef(documentRef) : root;
    const key = `${documentRef || root.$id}#${fragment || ''}`;
    if (seen.has(key)) return null;
    const target = fragment ? resolvePointer(document, fragment) : document;
    return reachedDeclaration(target, name, document, new Set([...seen, key]));
  }
  if (node.properties && node.properties[name]) return node.properties[name];
  for (const member of node.allOf || []) {
    const found = reachedDeclaration(member, name, root, seen);
    if (found) return found;
  }
  for (const keyword of ['oneOf', 'anyOf']) {
    const members = node[keyword];
    if (!Array.isArray(members) || members.length === 0) continue;
    const found = members.map((member) => reachedDeclaration(member, name, root, seen));
    if (found.every(Boolean)) return found[0];
  }
  return null;
}

/** Wire-response branches of every tool that do not reach `name`. */
function branchesMissing(name) {
  const missing = [];
  for (const tool of discoverTools(SCHEMA_BASE_DIR)) {
    const wire = readSchemaRef(`/schemas/${tool.response_schema}`);
    for (const branch of wire.oneOf) {
      if (!reachedDeclaration(branch, name, wire)) missing.push(`${tool.name} ${branch.properties.status.const}`);
    }
  }
  return missing;
}

// Initialize AJV with formats and custom loader
const ajv = new Ajv({
  allErrors: true,
  verbose: true,
  strict: false,
  discriminator: true,
  loadSchema: loadExternalSchema
});
addFormats(ajv);

// Schema loader for resolving $ref
async function loadExternalSchema(uri) {
  // Handle both /schemas/latest/ and /schemas/ patterns
  let relativePath;
  if (uri.startsWith('/schemas/latest/')) {
    relativePath = uri.replace('/schemas/latest/', '');
  } else if (uri.startsWith('/schemas/')) {
    relativePath = uri.replace('/schemas/', '');
  } else {
    throw new Error(`Cannot load external schema: ${uri}`);
  }

  const schemaPath = path.join(SCHEMA_BASE_DIR, relativePath);
  try {
    const content = fs.readFileSync(schemaPath, 'utf8');
    return JSON.parse(content);
  } catch (error) {
    throw new Error(`Failed to load referenced schema ${uri}: ${error.message}`);
  }
}

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

function log(message, type = 'info') {
  const colors = {
    info: '\x1b[0m',
    success: '\x1b[32m',
    error: '\x1b[31m',
    warning: '\x1b[33m'
  };
  console.log(`${colors[type]}${message}\x1b[0m`);
}

async function test(description, testFn) {
  totalTests++;
  try {
    const result = await testFn();
    if (result === true || result === undefined) {
      log(`✅ ${description}`, 'success');
      passedTests++;
    } else {
      log(`❌ ${description}: ${result}`, 'error');
      failedTests++;
    }
  } catch (error) {
    log(`❌ ${description}: ${error.message}`, 'error');
    if (error.errors) {
      console.error('Validation errors:', JSON.stringify(error.errors, null, 2));
    }
    failedTests++;
  }
}

// Cache for compiled schemas
const schemaCache = new Map();

async function loadAndCompileSchema(schemaPath) {
  // Use cache to avoid "already exists" error
  if (schemaCache.has(schemaPath)) {
    return schemaCache.get(schemaPath);
  }

  const schemaContent = fs.readFileSync(schemaPath, 'utf8');
  const schema = JSON.parse(schemaContent);
  const validate = await ajv.compileAsync(schema);

  schemaCache.set(schemaPath, validate);
  return validate;
}

// Schemas that should have ext field
const EXTENSIBLE_SCHEMAS = [
  'core/product.json',
  'core/media-buy.json',
  'core/creative-manifest.json',
  'core/package.json'
];

// Helper to check if ext field is valid (either inline or $ref)
function validateExtField(extProperty, expectedRef) {
  if (!extProperty) {
    throw new Error('ext property not found in schema');
  }

  // Check if using $ref (preferred)
  if (extProperty.$ref) {
    if (expectedRef && extProperty.$ref !== expectedRef) {
      throw new Error(`ext $ref should be ${expectedRef}, got ${extProperty.$ref}`);
    }
    return 'ref';
  }

  // Check if inline (legacy)
  if (extProperty.type === 'object' && extProperty.additionalProperties === true) {
    return 'inline';
  }

  throw new Error('ext property must either be $ref or inline object with additionalProperties');
}

async function runTests() {
  log('🧪 Starting Extension Fields Validation Tests');
  log('==============================================');

  // Test 1: Verify ext field exists in schema definitions
  await test('Extension field exists in Product schema', async () => {
    const schemaPath = path.join(SCHEMA_BASE_DIR, 'core/product.json');
    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));

    validateExtField(schema.properties.ext, '/schemas/core/ext.json');
    return true;
  });

  await test('Extension field exists in MediaBuy schema', async () => {
    const schemaPath = path.join(SCHEMA_BASE_DIR, 'core/media-buy.json');
    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));

    validateExtField(schema.properties.ext, '/schemas/core/ext.json');
    return true;
  });

  await test('Extension field exists in CreativeManifest schema', async () => {
    const schemaPath = path.join(SCHEMA_BASE_DIR, 'core/creative-manifest.json');
    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));

    validateExtField(schema.properties.ext, '/schemas/core/ext.json');
    return true;
  });

  await test('Extension field exists in Package schema', async () => {
    const schemaPath = path.join(SCHEMA_BASE_DIR, 'core/package.json');
    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));

    validateExtField(schema.properties.ext, '/schemas/core/ext.json');
    return true;
  });

  // Test 2: Verify ext field is optional (not required)
  await test('Extension field is optional on Product', async () => {
    const schemaPath = path.join(SCHEMA_BASE_DIR, 'core/product.json');
    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));

    if (schema.required && schema.required.includes('ext')) {
      throw new Error('ext should be optional, not required');
    }
    return true;
  });

  // Test 3: Validate objects with extension fields
  await test('Product validates with string extension field', async () => {
    const validate = await loadAndCompileSchema(path.join(SCHEMA_BASE_DIR, 'core/product.json'));

    const product = {
      product_id: 'test_product',
      name: 'Test Product',
      description: 'Test description',
      publisher_properties: [{
        publisher_domain: 'example.com',
        selection_type: 'all'
      }],
      format_ids: [{
        agent_url: 'https://creative.adcontextprotocol.org',
        id: 'display_300x250'
      }],
      delivery_type: 'guaranteed',
      delivery_measurement: {
        provider: 'Test Provider'
      },
      pricing_options: [{
        is_fixed: true,
        pricing_option_id: 'fixed_cpm',
        pricing_model: 'cpm',
        rate: 10.00,
        currency: 'USD'
      }],
      reporting_capabilities: {
        available_reporting_frequencies: ['daily'],
        expected_delay_minutes: 240,
        timezone: 'UTC',
        supports_webhooks: false,
        available_metrics: ['impressions', 'spend', 'clicks'],
        date_range_support: 'date_range'
      },
      ext: {
        roku_app_ids: ['123456', '789012']
      }
    };

    const valid = validate(product);
    if (!valid) {
      throw new Error(`Validation failed: ${JSON.stringify(validate.errors)}`);
    }
    return true;
  });

  await test('Product validates with nested extension object', async () => {
    const validate = await loadAndCompileSchema(path.join(SCHEMA_BASE_DIR, 'core/product.json'));

    const product = {
      product_id: 'test_product',
      name: 'Test Product',
      description: 'Test description',
      publisher_properties: [{
        publisher_domain: 'example.com',
        selection_type: 'all'
      }],
      format_ids: [{
        agent_url: 'https://creative.adcontextprotocol.org',
        id: 'display_300x250'
      }],
      delivery_type: 'guaranteed',
      delivery_measurement: {
        provider: 'Test Provider'
      },
      pricing_options: [{
        is_fixed: true,
        pricing_option_id: 'fixed_cpm',
        pricing_model: 'cpm',
        rate: 10.00,
        currency: 'USD'
      }],
      reporting_capabilities: {
        available_reporting_frequencies: ['daily'],
        expected_delay_minutes: 240,
        timezone: 'UTC',
        supports_webhooks: false,
        available_metrics: ['impressions', 'spend', 'clicks'],
        date_range_support: 'date_range'
      },
      ext: {
        schain: {
          ver: '1.0',
          complete: 1,
          nodes: [{
            asi: 'publisher.com',
            sid: '12345',
            hp: 1
          }]
        }
      }
    };

    const valid = validate(product);
    if (!valid) {
      throw new Error(`Validation failed: ${JSON.stringify(validate.errors)}`);
    }
    return true;
  });

  await test('Product validates with mixed extension types', async () => {
    const validate = await loadAndCompileSchema(path.join(SCHEMA_BASE_DIR, 'core/product.json'));

    const product = {
      product_id: 'test_product',
      name: 'Test Product',
      description: 'Test description',
      publisher_properties: [{
        publisher_domain: 'example.com',
        selection_type: 'all'
      }],
      format_ids: [{
        agent_url: 'https://creative.adcontextprotocol.org',
        id: 'display_300x250'
      }],
      delivery_type: 'guaranteed',
      delivery_measurement: {
        provider: 'Test Provider'
      },
      pricing_options: [{
        is_fixed: true,
        pricing_option_id: 'fixed_cpm',
        pricing_model: 'cpm',
        rate: 10.00,
        currency: 'USD'
      }],
      reporting_capabilities: {
        available_reporting_frequencies: ['daily'],
        expected_delay_minutes: 240,
        timezone: 'UTC',
        supports_webhooks: false,
        available_metrics: ['impressions', 'spend', 'clicks'],
        date_range_support: 'date_range'
      },
      ext: {
        roku_app_ids: ['123456'],
        ttd_uid2_enabled: true,
        nielsen_dar_enabled: false,
        custom_targeting: {
          category: 'premium',
          genre: 'sports'
        },
        x_carbon_kg: 0.05
      }
    };

    const valid = validate(product);
    if (!valid) {
      throw new Error(`Validation failed: ${JSON.stringify(validate.errors)}`);
    }
    return true;
  });

  await test('Product validates without extension field', async () => {
    const validate = await loadAndCompileSchema(path.join(SCHEMA_BASE_DIR, 'core/product.json'));

    const product = {
      product_id: 'test_product',
      name: 'Test Product',
      description: 'Test description',
      publisher_properties: [{
        publisher_domain: 'example.com',
        selection_type: 'all'
      }],
      format_ids: [{
        agent_url: 'https://creative.adcontextprotocol.org',
        id: 'display_300x250'
      }],
      delivery_type: 'guaranteed',
      delivery_measurement: {
        provider: 'Test Provider'
      },
      pricing_options: [{
        is_fixed: true,
        pricing_option_id: 'fixed_cpm',
        pricing_model: 'cpm',
        rate: 10.00,
        currency: 'USD'
      }],
      reporting_capabilities: {
        available_reporting_frequencies: ['daily'],
        expected_delay_minutes: 240,
        timezone: 'UTC',
        supports_webhooks: false,
        available_metrics: ['impressions', 'spend', 'clicks'],
        date_range_support: 'date_range'
      }
      // No ext field
    };

    const valid = validate(product);
    if (!valid) {
      throw new Error(`Validation failed: ${JSON.stringify(validate.errors)}`);
    }
    return true;
  });

  await test('MediaBuy validates with extension field', async () => {
    const validate = await loadAndCompileSchema(path.join(SCHEMA_BASE_DIR, 'core/media-buy.json'));

    const mediaBuy = {
      media_buy_id: 'mb_123',
      status: 'active',
      confirmed_at: '2026-05-27T09:00:00Z',
      revision: 1,
      total_budget: 10000,
      packages: [],
      ext: {
        buyer_campaign_id: 'campaign_xyz',
        attribution_window_days: 30,
        multi_touch_model: 'linear'
      }
    };

    const valid = validate(mediaBuy);
    if (!valid) {
      throw new Error(`Validation failed: ${JSON.stringify(validate.errors)}`);
    }
    return true;
  });

  // Note: CreativeManifest and Package extension tests are covered by schema structure tests above
  // Full validation tests would require complex asset structures that are beyond the scope of this test

  // Test 3B: Request extensions
  await test('Request schema has ext field', async () => {
    const schemaPath = path.join(SCHEMA_BASE_DIR, 'media-buy/create-media-buy-request.json');
    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));

    validateExtField(schema.properties.ext, '/schemas/core/ext.json');
    return true;
  });

  await test('Request validates with extension field', async () => {
    const validate = await loadAndCompileSchema(path.join(SCHEMA_BASE_DIR, 'media-buy/create-media-buy-request.json'));

    const request = {
      idempotency_key: '550e8400-e29b-41d4-a716-446655440000',
      account: { account_id: 'acc_test_001' },
      packages: [{ product_id: 'prod_1', budget: 1000, pricing_option_id: 'cpm_fixed' }],
      brand: {
        domain: 'acmecorp.com'
      },
      start_time: 'asap',
      end_time: '2024-12-31T23:59:59Z',
      ext: {
        test_mode: true,
        trace_id: 'trace_123',
        buyer_internal_campaign_id: 'camp_abc'
      }
    };

    const valid = validate(request);
    if (!valid) {
      throw new Error(`Validation failed: ${JSON.stringify(validate.errors)}`);
    }
    return true;
  });

  // Test 3C: Response extensions
  // A tool response is its generated wire response: a oneOf discriminated by
  // status, one branch per status body. Every branch, through its body and
  // the protocol envelope the body composes, reaches the ext extension point.
  // validate_input's completed body has never declared ext; adding one is a
  // schema change outside this check. The entry must stay accurate: it fails
  // once the body declares ext.
  const BRANCHES_WITHOUT_EXT = ['validate_input completed'];
  await test('Every wire-response branch reaches ext through its body', async () => {
    const missing = branchesMissing('ext');
    const unexpected = missing.filter((branch) => !BRANCHES_WITHOUT_EXT.includes(branch));
    if (unexpected.length) throw new Error(`branches without ext: ${unexpected.join(', ')}`);
    const stale = BRANCHES_WITHOUT_EXT.filter((branch) => !missing.includes(branch));
    if (stale.length) throw new Error(`listed as lacking ext, but reach it: ${stale.join(', ')}`);
    const wire = readSchemaRef('/schemas/media-buy/create-media-buy-wire-response.json');
    for (const branch of wire.oneOf) {
      validateExtField(reachedDeclaration(branch, 'ext', wire), '/schemas/core/ext.json');
    }
    return true;
  });

  await test('A branch whose body lacks ext is reported', async () => {
    const body = { allOf: [{ $ref: '/schemas/core/protocol-envelope.json' }], properties: { results: { type: 'array' } } };
    const withExt = { ...body, properties: { ...body.properties, ext: { $ref: '/schemas/core/ext.json' } } };
    if (reachedDeclaration(body, 'ext', body) !== null) throw new Error('a body without ext was accepted');
    if (!reachedDeclaration(withExt, 'ext', withExt)) throw new Error('a body with ext was rejected');
    if (reachedDeclaration({ oneOf: [withExt, body] }, 'ext', body) !== null) {
      throw new Error('a oneOf with one member lacking ext was accepted');
    }
    return true;
  });

  // Skip actual validation test for responses with oneOf - too complex for this test suite
  // The schema structure test above confirms ext exists correctly

  // Test 4: Context field validation
  await test('Request schema has context field', async () => {
    const schemaPath = path.join(SCHEMA_BASE_DIR, 'media-buy/create-media-buy-request.json');
    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));

    validateExtField(schema.properties.context, '/schemas/core/context.json');
    return true;
  });

  await test('Every wire-response branch reaches context through the envelope', async () => {
    // context is an envelope field: bodies do not declare it, and every
    // branch reaches the envelope's declaration through its body.
    const missing = branchesMissing('context');
    if (missing.length) throw new Error(`branches without context: ${missing.join(', ')}`);
    const wire = readSchemaRef('/schemas/media-buy/create-media-buy-wire-response.json');
    for (const branch of wire.oneOf) {
      validateExtField(reachedDeclaration(branch, 'context', wire), '/schemas/core/context.json');
    }
    return true;
  });

  await test('Context field is optional on requests', async () => {
    const schemaPath = path.join(SCHEMA_BASE_DIR, 'media-buy/create-media-buy-request.json');
    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));

    if (schema.required && schema.required.includes('context')) {
      throw new Error('context should be optional, not required');
    }
    return true;
  });

  await test('Request validates with context field', async () => {
    const validate = await loadAndCompileSchema(path.join(SCHEMA_BASE_DIR, 'media-buy/create-media-buy-request.json'));

    const request = {
      idempotency_key: '550e8400-e29b-41d4-a716-446655440000',
      account: { account_id: 'acc_test_001' },
      packages: [{ product_id: 'prod_1', budget: 1000, pricing_option_id: 'cpm_fixed' }],
      brand: {
        domain: 'acmecorp.com'
      },
      start_time: 'asap',
      end_time: '2024-12-31T23:59:59Z',
      context: {
        ui_session_id: 'sess_123',
        trace_id: 'trace_456',
        internal_campaign_id: 'camp_xyz',
        nested_data: {
          foo: 'bar',
          numbers: [1, 2, 3]
        }
      }
    };

    const valid = validate(request);
    if (!valid) {
      throw new Error(`Validation failed: ${JSON.stringify(validate.errors)}`);
    }
    return true;
  });

  await test('Context accepts various JSON types', async () => {
    const validate = await loadAndCompileSchema(path.join(SCHEMA_BASE_DIR, 'media-buy/create-media-buy-request.json'));

    const request = {
      idempotency_key: '550e8400-e29b-41d4-a716-446655440000',
      account: { account_id: 'acc_test_001' },
      packages: [{ product_id: 'prod_1', budget: 1000, pricing_option_id: 'cpm_fixed' }],
      brand: {
        domain: 'acmecorp.com'
      },
      start_time: 'asap',
      end_time: '2024-12-31T23:59:59Z',
      context: {
        string_field: 'value',
        number_field: 42,
        boolean_field: true,
        array_field: [1, 2, 3],
        object_field: { nested: 'data' },
        null_field: null
      }
    };

    const valid = validate(request);
    if (!valid) {
      throw new Error(`Validation failed: ${JSON.stringify(validate.errors)}`);
    }
    return true;
  });

  await test('Request validates without context field', async () => {
    const validate = await loadAndCompileSchema(path.join(SCHEMA_BASE_DIR, 'media-buy/create-media-buy-request.json'));

    const request = {
      idempotency_key: '550e8400-e29b-41d4-a716-446655440000',
      account: { account_id: 'acc_test_001' },
      packages: [{ product_id: 'prod_1', budget: 1000, pricing_option_id: 'cpm_fixed' }],
      brand: {
        domain: 'acmecorp.com'
      },
      start_time: 'asap',
      end_time: '2024-12-31T23:59:59Z'
      // No context field
    };

    const valid = validate(request);
    if (!valid) {
      throw new Error(`Validation failed: ${JSON.stringify(validate.errors)}`);
    }
    return true;
  });

  // Test 5: Verify unknown fields at top level are ALLOWED for forward compatibility
  // This enables clients to receive new fields from upgraded servers without breaking
  await test('Product accepts unknown top-level fields (forward compatibility)', async () => {
    const validate = await loadAndCompileSchema(path.join(SCHEMA_BASE_DIR, 'core/product.json'));

    const product = {
      product_id: 'test_product',
      name: 'Test Product',
      description: 'Test description',
      publisher_properties: [{
        publisher_domain: 'example.com',
        selection_type: 'all'
      }],
      format_ids: [{
        agent_url: 'https://creative.adcontextprotocol.org',
        id: 'display_300x250'
      }],
      delivery_type: 'guaranteed',
      delivery_measurement: {
        provider: 'Test Provider'
      },
      pricing_options: [{
        is_fixed: true,
        pricing_option_id: 'fixed_cpm',
        pricing_model: 'cpm',
        rate: 10.00,
        currency: 'USD'
      }],
      reporting_capabilities: {
        available_reporting_frequencies: ['daily'],
        expected_delay_minutes: 240,
        timezone: 'UTC',
        supports_webhooks: false,
        available_metrics: ['impressions', 'spend', 'clicks'],
        date_range_support: 'date_range'
      },
      future_field_from_v26: 'should be allowed'  // Forward compatibility: accept unknown fields
    };

    const valid = validate(product);
    if (!valid) {
      throw new Error(`Validation failed: ${JSON.stringify(validate.errors)}`);
    }
    return true;
  });

  // Summary
  log('');
  log('==============================================');
  log(`Tests completed: ${totalTests}`);
  log(`✅ Passed: ${passedTests}`, 'success');
  if (failedTests > 0) {
    log(`❌ Failed: ${failedTests}`, 'error');
    log('');
    process.exit(1);
  } else {
    log('');
    log('🎉 All extension field tests passed!', 'success');
    process.exit(0);
  }
}

// Run tests
runTests().catch(error => {
  log(`Fatal error: ${error.message}`, 'error');
  console.error(error);
  process.exit(1);
});
