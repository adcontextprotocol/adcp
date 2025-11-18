#!/usr/bin/env node
/**
 * Extension fields validation test suite
 * Tests that ext fields work correctly on core schemas
 */

const fs = require('fs');
const path = require('path');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const SCHEMA_BASE_DIR = path.join(__dirname, '../static/schemas/v1');

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
  if (uri.startsWith('/schemas/v1/')) {
    const schemaPath = path.join(SCHEMA_BASE_DIR, uri.replace('/schemas/v1/', ''));
    try {
      const content = fs.readFileSync(schemaPath, 'utf8');
      return JSON.parse(content);
    } catch (error) {
      throw new Error(`Failed to load referenced schema ${uri}: ${error.message}`);
    }
  }
  throw new Error(`Cannot load external schema: ${uri}`);
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

async function runTests() {
  log('🧪 Starting Extension Fields Validation Tests');
  log('==============================================');

  // Test 1: Verify ext field exists in schema definitions
  await test('Extension field exists in Product schema', async () => {
    const schemaPath = path.join(SCHEMA_BASE_DIR, 'core/product.json');
    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));

    if (!schema.properties.ext) {
      throw new Error('ext property not found in schema');
    }
    if (schema.properties.ext.type !== 'object') {
      throw new Error('ext property must be type object');
    }
    if (schema.properties.ext.additionalProperties !== true) {
      throw new Error('ext property must allow additionalProperties');
    }
    return true;
  });

  await test('Extension field exists in MediaBuy schema', async () => {
    const schemaPath = path.join(SCHEMA_BASE_DIR, 'core/media-buy.json');
    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));

    if (!schema.properties.ext) {
      throw new Error('ext property not found in schema');
    }
    if (schema.properties.ext.type !== 'object') {
      throw new Error('ext property must be type object');
    }
    if (schema.properties.ext.additionalProperties !== true) {
      throw new Error('ext property must allow additionalProperties');
    }
    return true;
  });

  await test('Extension field exists in CreativeManifest schema', async () => {
    const schemaPath = path.join(SCHEMA_BASE_DIR, 'core/creative-manifest.json');
    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));

    if (!schema.properties.ext) {
      throw new Error('ext property not found in schema');
    }
    if (schema.properties.ext.type !== 'object') {
      throw new Error('ext property must be type object');
    }
    if (schema.properties.ext.additionalProperties !== true) {
      throw new Error('ext property must allow additionalProperties');
    }
    return true;
  });

  await test('Extension field exists in Package schema', async () => {
    const schemaPath = path.join(SCHEMA_BASE_DIR, 'core/package.json');
    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));

    if (!schema.properties.ext) {
      throw new Error('ext property not found in schema');
    }
    if (schema.properties.ext.type !== 'object') {
      throw new Error('ext property must be type object');
    }
    if (schema.properties.ext.additionalProperties !== true) {
      throw new Error('ext property must allow additionalProperties');
    }
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
      promoted_offering: 'Test Product',
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

    if (!schema.properties.ext) {
      throw new Error('ext property not found in request schema');
    }
    if (schema.properties.ext.type !== 'object') {
      throw new Error('ext property must be type object');
    }
    if (schema.properties.ext.additionalProperties !== true) {
      throw new Error('ext property must allow additionalProperties');
    }
    return true;
  });

  await test('Request validates with extension field', async () => {
    const validate = await loadAndCompileSchema(path.join(SCHEMA_BASE_DIR, 'media-buy/create-media-buy-request.json'));

    const request = {
      buyer_ref: 'buyer_ref_123',
      packages: [],
      brand_manifest: {
        name: 'Test Brand'
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
  // Note: Response schemas use oneOf for success/error, so ext is at top level (schema.properties.ext)
  // not inside oneOf branches. This is correct - ext applies to ALL responses regardless of success/error.
  await test('Response schema has ext field at top level', async () => {
    const schemaPath = path.join(SCHEMA_BASE_DIR, 'media-buy/create-media-buy-response.json');
    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));

    if (!schema.properties.ext) {
      throw new Error('ext property not found at response schema top level');
    }
    if (schema.properties.ext.type !== 'object') {
      throw new Error('ext property must be type object');
    }
    if (schema.properties.ext.additionalProperties !== true) {
      throw new Error('ext property must allow additionalProperties');
    }
    return true;
  });

  // Skip actual validation test for responses with oneOf - too complex for this test suite
  // The schema structure test above confirms ext exists correctly

  // Test 4: Verify unknown fields at top level still rejected
  await test('Product rejects unknown top-level fields', async () => {
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
      unknown_top_level_field: 'should be rejected'  // This should fail validation
    };

    const valid = validate(product);
    if (valid) {
      throw new Error('Should have rejected unknown top-level field');
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
