#!/usr/bin/env node
/**
 * Composed Schema Validation Test Suite
 *
 * Tests that schemas using allOf composition can validate realistic data.
 * This catches the common JSON Schema gotcha where allOf + additionalProperties: false
 * causes each sub-schema to reject the other's properties.
 *
 * Related: https://github.com/adcontextprotocol/adcp/issues/275
 */

const fs = require('fs');
const path = require('path');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const SCHEMA_BASE_DIR = path.join(__dirname, '../static/schemas/source');

async function loadExternalSchema(uri) {
  if (uri.startsWith('/schemas/')) {
    const schemaPath = path.join(SCHEMA_BASE_DIR, uri.replace('/schemas/', ''));
    const content = fs.readFileSync(schemaPath, 'utf8');
    return JSON.parse(content);
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

async function testSchemaValidation(schemaId, testData, description) {
  totalTests++;
  try {
    const ajv = new Ajv({
      allErrors: true,
      verbose: true,
      strict: false,
      loadSchema: loadExternalSchema
    });
    addFormats(ajv);

    const schemaPath = path.join(SCHEMA_BASE_DIR, schemaId.replace('/schemas/', ''));
    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));

    const validate = await ajv.compileAsync(schema);
    const valid = validate(testData);

    if (valid) {
      log(`  \u2713 ${description}`, 'success');
      passedTests++;
      return true;
    } else {
      log(`  \u2717 ${description}`, 'error');
      log(`    Errors:`, 'error');
      for (const err of validate.errors) {
        log(`      ${err.instancePath || 'root'}: ${err.message} (${err.schemaPath})`, 'error');
      }
      failedTests++;
      return false;
    }
  } catch (error) {
    log(`  \u2717 ${description}: ${error.message}`, 'error');
    failedTests++;
    return false;
  }
}

async function testSchemaRejection(schemaId, testData, description) {
  totalTests++;
  try {
    const ajv = new Ajv({
      allErrors: true,
      verbose: true,
      strict: false,
      loadSchema: loadExternalSchema
    });
    addFormats(ajv);

    const schemaPath = path.join(SCHEMA_BASE_DIR, schemaId.replace('/schemas/', ''));
    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));

    const validate = await ajv.compileAsync(schema);
    const valid = validate(testData);

    if (!valid) {
      log(`  \u2713 ${description}`, 'success');
      passedTests++;
      return true;
    } else {
      log(`  \u2717 ${description} — expected rejection, got pass`, 'error');
      failedTests++;
      return false;
    }
  } catch (error) {
    log(`  \u2717 ${description}: ${error.message}`, 'error');
    failedTests++;
    return false;
  }
}

async function runTests() {
  log('Testing Composed Schema Validation (allOf patterns)', 'info');
  log('====================================================');
  log('');

  // Test 1: Video Asset (was: allOf with dimensions.json)
  log('Video Asset Schema:', 'info');
  await testSchemaValidation(
    '/schemas/core/assets/video-asset.json',
    {
      url: 'https://example.com/video.mp4',
      width: 1920,
      height: 1080,
      duration_ms: 30000
    },
    'Video with all common fields'
  );

  await testSchemaValidation(
    '/schemas/core/assets/video-asset.json',
    {
      url: 'https://example.com/video.mp4',
      width: 1920,
      height: 1080,
      duration_ms: 30000,
      format: 'mp4',
      bitrate_kbps: 5000
    },
    'Video with all optional fields'
  );

  await testSchemaValidation(
    '/schemas/core/assets/video-asset.json',
    {
      url: 'https://example.com/video.mp4',
      width: 1920,
      height: 1080
    },
    'Video with minimum required fields'
  );

  log('');

  // Test 2: Image Asset (was: allOf with dimensions.json)
  log('Image Asset Schema:', 'info');
  await testSchemaValidation(
    '/schemas/core/assets/image-asset.json',
    {
      url: 'https://example.com/image.png',
      width: 300,
      height: 250,
      format: 'png'
    },
    'Image with common fields'
  );

  await testSchemaValidation(
    '/schemas/core/assets/image-asset.json',
    {
      url: 'https://example.com/image.jpg',
      width: 728,
      height: 90,
      format: 'jpg',
      alt_text: 'Banner advertisement'
    },
    'Image with all optional fields'
  );

  await testSchemaValidation(
    '/schemas/core/assets/image-asset.json',
    {
      url: 'https://example.com/image.webp',
      width: 300,
      height: 250
    },
    'Image with minimum required fields'
  );

  log('');

  // Test 3: Create Media Buy Request with reporting_webhook (allOf with push-notification-config.json)
  log('Create Media Buy Request Schema (reporting_webhook field):', 'info');
  await testSchemaValidation(
    '/schemas/media-buy/create-media-buy-request.json',
    {
      idempotency_key: '550e8400-e29b-41d4-a716-446655440000',
      account: { account_id: 'acc_test_001' },
      packages: [
        {
          product_id: 'ctv_premium',
          budget: 50000,
          pricing_option_id: 'cpm_standard'
        }
      ],
      brand: {
        domain: 'acmecorp.com'
      },
      start_time: 'asap',
      end_time: '2024-12-31T23:59:59Z',
      reporting_webhook: {
        url: 'https://webhook.example.com/reporting',
        authentication: {
          schemes: ['Bearer'],
          credentials: 'a'.repeat(32)
        },
        reporting_frequency: 'daily',
        requested_metrics: ['impressions', 'spend', 'clicks']
      }
    },
    'Create media buy with reporting_webhook (allOf composition)'
  );

  await testSchemaValidation(
    '/schemas/media-buy/create-media-buy-request.json',
    {
      idempotency_key: '6ba7b810-9dad-41d1-80b4-00c04fd430c8',
      account: { account_id: 'acc_test_001' },
      packages: [
        {
          product_id: 'display_standard',
          budget: 10000,
          pricing_option_id: 'cpm_fixed'
        }
      ],
      brand: {
        domain: 'acmecorp.com'
      },
      start_time: 'asap',
      end_time: '2024-12-31T23:59:59Z'
    },
    'Create media buy without optional reporting_webhook'
  );

  await testSchemaValidation(
    '/schemas/media-buy/create-media-buy-request.json',
    {
      idempotency_key: '6ba7b811-9dad-41d1-80b4-00c04fd430c9',
      account: { brand: { domain: 'acmecorp.com' }, operator: 'acmecorp.com' },
      packages: [
        {
          product_id: 'display_standard',
          budget: 10000,
          pricing_option_id: 'cpm_fixed'
        }
      ],
      brand: {
        domain: 'acmecorp.com'
      },
      start_time: 'asap',
      end_time: '2024-12-31T23:59:59Z'
    },
    'Create media buy with natural key account'
  );

  log('');

  // Test 4: Get Media Buy Delivery Response (allOf with delivery-metrics.json)
  log('Get Media Buy Delivery Response Schema (allOf with delivery-metrics.json):', 'info');
  await testSchemaValidation(
    '/schemas/media-buy/get-media-buy-delivery-response.json',
    {
      reporting_period: {
        start: '2024-06-01T00:00:00Z',
        end: '2024-06-15T23:59:59Z'
      },
      currency: 'USD',
      media_buy_deliveries: [
        {
          media_buy_id: 'mb_123',
          status: 'active',
          totals: {
            spend: 25000,
            impressions: 1000000,
            effective_rate: 25.0
          },
          by_package: [
            {
              package_id: 'pkg_1',
              spend: 25000,
              impressions: 1000000,
              pacing_index: 1.05,
              pricing_model: 'cpm',
              rate: 25.0,
              currency: 'USD'
            }
          ]
        }
      ]
    },
    'Delivery response with aggregate metrics (allOf composition)'
  );

  log('');

  // Idempotency capability: discriminated oneOf on supported
  log('Get AdCP Capabilities Response (adcp.idempotency oneOf discriminator):', 'info');

  const capabilitiesBase = {
    adcp: { major_versions: [3] },
    supported_protocols: ['media_buy']
  };

  await testSchemaValidation(
    '/schemas/protocol/get-adcp-capabilities-response.json',
    { ...capabilitiesBase, adcp: { ...capabilitiesBase.adcp, idempotency: { supported: true, replay_ttl_seconds: 86400 } } },
    'IdempotencySupported: {supported: true, replay_ttl_seconds: 86400}'
  );

  await testSchemaValidation(
    '/schemas/protocol/get-adcp-capabilities-response.json',
    { ...capabilitiesBase, adcp: { ...capabilitiesBase.adcp, idempotency: { supported: false } } },
    'IdempotencyUnsupported: {supported: false}'
  );

  await testSchemaRejection(
    '/schemas/protocol/get-adcp-capabilities-response.json',
    { ...capabilitiesBase, adcp: { ...capabilitiesBase.adcp, idempotency: { supported: false, replay_ttl_seconds: 3600 } } },
    'Rejects TTL on unsupported branch: {supported: false, replay_ttl_seconds: 3600}'
  );

  await testSchemaRejection(
    '/schemas/protocol/get-adcp-capabilities-response.json',
    { ...capabilitiesBase, adcp: { ...capabilitiesBase.adcp, idempotency: { supported: true } } },
    'Rejects missing TTL on supported branch: {supported: true}'
  );

  await testSchemaRejection(
    '/schemas/protocol/get-adcp-capabilities-response.json',
    { ...capabilitiesBase, adcp: { ...capabilitiesBase.adcp, idempotency: {} } },
    'Rejects empty idempotency block (missing discriminator)'
  );

  log('');

  // Test 5: Bundled schemas (no $ref resolution needed)
  // Only test against latest/ — versioned dirs in dist/ may be from a prior release
  // and are not updated on every source change.
  const BUNDLED_DIR = path.join(__dirname, '../dist/schemas');
  const latestBundledPath = path.join(BUNDLED_DIR, 'latest', 'bundled');
  const bundledPath = fs.existsSync(latestBundledPath) ? latestBundledPath : null;

  if (bundledPath && fs.existsSync(bundledPath)) {
      log('Bundled Schemas (no $ref resolution needed):', 'info');

      // Test bundled schema validation WITHOUT custom loadSchema
      // This proves bundled schemas are truly self-contained
      await testBundledSchemaValidation(
        path.join(bundledPath, 'media-buy/create-media-buy-request.json'),
        {
          idempotency_key: '550e8400-e29b-41d4-a716-446655440042',
          account: { account_id: 'acc_test_001' },
          packages: [
            {
              product_id: 'ctv_premium',
              budget: 50000,
              pricing_option_id: 'cpm_standard'
            }
          ],
          brand: {
            domain: 'acmecorp.com'
          },
          start_time: 'asap',
          end_time: '2024-12-31T23:59:59Z'
        },
        'Bundled create-media-buy-request (no ref resolution)'
      );

      // Regression for #2648: bundled schemas that carry local `#/$defs/...`
      // pointers (format.json, policy-entry.json, artifact.json) must compile
      // with a vanilla Ajv — i.e. the bundler must hoist nested `$defs` to
      // the document root.
      await testBundledSchemaCompile(
        path.join(bundledPath, 'media-buy/list-creative-formats-response.json'),
        'Bundled list-creative-formats-response (media-buy) compiles — #2648'
      );
      await testBundledSchemaCompile(
        path.join(bundledPath, 'creative/list-creative-formats-response.json'),
        'Bundled list-creative-formats-response (creative) compiles — #2648'
      );
      await testBundledSchemaCompile(
        path.join(bundledPath, 'content-standards/list-content-standards-response.json'),
        'Bundled list-content-standards-response compiles — #2648'
      );

      // Every bundled schema must be self-contained and compile standalone.
      await testAllBundledSchemasCompile(bundledPath);

      // Test a response schema to verify nested refs are resolved
      await testBundledSchemaValidation(
        path.join(bundledPath, 'media-buy/get-products-response.json'),
        {
          products: [
            {
              product_id: 'test_product',
              name: 'Test Product',
              description: 'A test product',
              publisher_properties: [
                {
                  publisher_domain: 'example.com',
                  selection_type: 'all'
                }
              ],
              format_ids: [{ agent_url: 'https://creative.example.com', id: 'video_30s' }],
              delivery_type: 'guaranteed',
              delivery_measurement: {
                provider: 'Google Ad Manager'
              },
              pricing_options: [
                {
                  pricing_option_id: 'cpm_standard',
                  pricing_model: 'cpm',
                  rate: 25.0,
                  currency: 'USD',
                  is_fixed: true
                }
              ],
              reporting_capabilities: {
                available_reporting_frequencies: ['daily'],
                expected_delay_minutes: 240,
                timezone: 'UTC',
                supports_webhooks: false,
                available_metrics: ['impressions', 'spend', 'clicks'],
                date_range_support: 'date_range'
              }
            }
          ]
        },
        'Bundled get-products-response (no ref resolution)'
      );

      log('');
  } else {
    log('');
    log('Bundled Schemas:', 'warning');
    log('  (skipped - run npm run build:schemas first to generate bundled schemas)', 'warning');
    log('');
  }

  // Print results
  log('====================================================');
  log(`Tests completed: ${totalTests}`);
  log(`\u2713 Passed: ${passedTests}`, passedTests === totalTests ? 'success' : 'info');
  if (failedTests > 0) {
    log(`\u2717 Failed: ${failedTests}`, 'error');
  }

  if (failedTests > 0) {
    log('');
    log('FAILURE: Composed schema validation tests failed.', 'error');
    log('This likely indicates an allOf + additionalProperties: false conflict.', 'error');
    log('See: https://github.com/adcontextprotocol/adcp/issues/275', 'error');
    process.exit(1);
  } else {
    log('');
    log('All composed schema validation tests passed!', 'success');
  }
}

/**
 * Test bundled schema validation WITHOUT custom loadSchema
 * This proves bundled schemas are truly self-contained with no $ref dependencies
 */
async function testBundledSchemaValidation(schemaPath, testData, description) {
  totalTests++;
  try {
    // Create AJV WITHOUT loadSchema - bundled schemas should work standalone
    const ajv = new Ajv({
      allErrors: true,
      verbose: true,
      strict: false
      // Note: NO loadSchema - bundled schemas must be self-contained
    });
    addFormats(ajv);

    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
    const validate = ajv.compile(schema);
    const valid = validate(testData);

    if (valid) {
      log(`  \u2713 ${description}`, 'success');
      passedTests++;
      return true;
    } else {
      log(`  \u2717 ${description}`, 'error');
      log(`    Errors:`, 'error');
      for (const err of validate.errors) {
        log(`      ${err.instancePath || 'root'}: ${err.message} (${err.schemaPath})`, 'error');
      }
      failedTests++;
      return false;
    }
  } catch (error) {
    log(`  \u2717 ${description}: ${error.message}`, 'error');
    failedTests++;
    return false;
  }
}

/**
 * Compile a bundled schema with a vanilla Ajv (no loadSchema). Does not
 * validate data — just asserts the schema itself is resolvable.
 */
async function testBundledSchemaCompile(schemaPath, description) {
  totalTests++;
  try {
    const ajv = new Ajv({ allErrors: true, strict: false });
    addFormats(ajv);
    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
    ajv.compile(schema);
    log(`  \u2713 ${description}`, 'success');
    passedTests++;
    return true;
  } catch (error) {
    log(`  \u2717 ${description}: ${error.message}`, 'error');
    failedTests++;
    return false;
  }
}

/**
 * Walk the entire bundled/ tree and assert every schema compiles standalone.
 * This is the real guarantee bundled/ is supposed to provide: a consumer can
 * `new Ajv().compile(require('bundled/.../foo.json'))` without any loader.
 */
async function testAllBundledSchemasCompile(bundledPath) {
  totalTests++;
  const failures = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith('.json')) {
        try {
          const ajv = new Ajv({ allErrors: true, strict: false });
          addFormats(ajv);
          ajv.compile(JSON.parse(fs.readFileSync(p, 'utf8')));
        } catch (error) {
          failures.push(`${path.relative(bundledPath, p)}: ${error.message}`);
        }
      }
    }
  };
  walk(bundledPath);

  if (failures.length === 0) {
    log(`  \u2713 All bundled schemas compile standalone (no loadSchema)`, 'success');
    passedTests++;
    return true;
  }
  log(`  \u2717 ${failures.length} bundled schema(s) failed to compile:`, 'error');
  for (const f of failures) log(`      ${f}`, 'error');
  failedTests++;
  return false;
}

runTests().catch(error => {
  log(`Test execution failed: ${error.message}`, 'error');
  process.exit(1);
});
