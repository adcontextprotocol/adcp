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

// Initialize AJV with formats and custom loader
const ajv = new Ajv({
  allErrors: true,
  verbose: true,
  strict: false,
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
      }]
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
      buyer_ref: 'buyer_ref_123',
      account: { account_id: 'acc_test_001' },
      packages: [{ buyer_ref: 'pkg_1', product_id: 'prod_1', budget: 1000, pricing_option_id: 'cpm_fixed' }],
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
  // Note: Response schemas use oneOf for success/error discriminated unions.
  // For better TypeScript/Zod codegen, ext is inside each oneOf variant (not at root level).
  // This produces clean discriminated union types instead of intersection types.
  await test('Response schema has ext field in oneOf variants', async () => {
    const schemaPath = path.join(SCHEMA_BASE_DIR, 'media-buy/create-media-buy-response.json');
    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));

    // Check that ext is NOT at root level
    if (schema.properties && schema.properties.ext) {
      throw new Error('ext should not be at root level for discriminated union schemas');
    }

    // Check that ext exists in each oneOf variant
    if (!schema.oneOf || schema.oneOf.length === 0) {
      throw new Error('Schema should have oneOf variants');
    }

    for (let i = 0; i < schema.oneOf.length; i++) {
      const variant = schema.oneOf[i];
      if (!variant.properties || !variant.properties.ext) {
        throw new Error(`oneOf variant ${i} missing ext field`);
      }
      validateExtField(variant.properties.ext, '/schemas/core/ext.json');
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

  await test('Response schema has context field', async () => {
    const schemaPath = path.join(SCHEMA_BASE_DIR, 'media-buy/create-media-buy-response.json');
    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));

    // Context is in oneOf branches, not at top level
    const successBranch = schema.oneOf[0];
    const errorBranch = schema.oneOf[1];

    validateExtField(successBranch.properties.context, '/schemas/core/context.json');
    validateExtField(errorBranch.properties.context, '/schemas/core/context.json');
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
      buyer_ref: 'buyer_ref_123',
      account: { account_id: 'acc_test_001' },
      packages: [{ buyer_ref: 'pkg_1', product_id: 'prod_1', budget: 1000, pricing_option_id: 'cpm_fixed' }],
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
      buyer_ref: 'buyer_ref_123',
      account: { account_id: 'acc_test_001' },
      packages: [{ buyer_ref: 'pkg_1', product_id: 'prod_1', budget: 1000, pricing_option_id: 'cpm_fixed' }],
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
      buyer_ref: 'buyer_ref_123',
      account: { account_id: 'acc_test_001' },
      packages: [{ buyer_ref: 'pkg_1', product_id: 'prod_1', budget: 1000, pricing_option_id: 'cpm_fixed' }],
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
