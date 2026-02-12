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
      buyer_ref: 'campaign-2024-q4',
      account_id: 'acc_test_001',
      packages: [
        {
          buyer_ref: 'pkg-001',
          product_id: 'ctv_premium',
          budget: 50000,
          pricing_option_id: 'cpm_standard'
        }
      ],
      brand_manifest: {
        name: 'Test Brand',
        url: 'https://brand.example.com/manifest.json'
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
      buyer_ref: 'campaign-simple',
      account_id: 'acc_test_001',
      packages: [
        {
          buyer_ref: 'pkg-001',
          product_id: 'display_standard',
          budget: 10000,
          pricing_option_id: 'cpm_fixed'
        }
      ],
      brand_manifest: {
        name: 'Simple Brand',
        url: 'https://brand.example.com/manifest.json'
      },
      start_time: 'asap',
      end_time: '2024-12-31T23:59:59Z'
    },
    'Create media buy without optional reporting_webhook'
  );

  await testSchemaValidation(
    '/schemas/media-buy/create-media-buy-request.json',
    {
      buyer_ref: 'single-account-campaign',
      packages: [
        {
          buyer_ref: 'pkg-001',
          product_id: 'display_standard',
          budget: 10000,
          pricing_option_id: 'cpm_fixed'
        }
      ],
      brand_manifest: {
        name: 'Single Account Brand',
        url: 'https://brand.example.com/manifest.json'
      },
      start_time: 'asap',
      end_time: '2024-12-31T23:59:59Z'
    },
    'Create media buy without account_id (single-account agent)'
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

  // Test 5: Bundled schemas (no $ref resolution needed)
  const BUNDLED_DIR = path.join(__dirname, '../dist/schemas');
  const bundledVersionDirs = fs.existsSync(BUNDLED_DIR)
    ? fs.readdirSync(BUNDLED_DIR).filter(d => /^\d+\.\d+\.\d+$/.test(d))
    : [];

  if (bundledVersionDirs.length > 0) {
    const latestVersion = bundledVersionDirs.sort().pop();
    const bundledPath = path.join(BUNDLED_DIR, latestVersion, 'bundled');

    if (fs.existsSync(bundledPath)) {
      log('Bundled Schemas (no $ref resolution needed):', 'info');

      // Test bundled schema validation WITHOUT custom loadSchema
      // This proves bundled schemas are truly self-contained
      await testBundledSchemaValidation(
        path.join(bundledPath, 'media-buy/create-media-buy-request.json'),
        {
          buyer_ref: 'campaign-bundled-test',
          account_id: 'acc_test_001',
          packages: [
            {
              buyer_ref: 'pkg-001',
              product_id: 'ctv_premium',
              budget: 50000,
              pricing_option_id: 'cpm_standard'
            }
          ],
          brand_manifest: {
            name: 'Test Brand',
            url: 'https://brand.example.com/manifest.json'
          },
          start_time: 'asap',
          end_time: '2024-12-31T23:59:59Z'
        },
        'Bundled create-media-buy-request (no ref resolution)'
      );

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
              ]
            }
          ]
        },
        'Bundled get-products-response (no ref resolution)'
      );

      log('');
    }
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

runTests().catch(error => {
  log(`Test execution failed: ${error.message}`, 'error');
  process.exit(1);
});
