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
      discriminator: true,
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
      discriminator: true,
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
      asset_type: 'video',
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
      asset_type: 'video',
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
      asset_type: 'video',
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
      asset_type: 'image',
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
      asset_type: 'image',
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
      asset_type: 'image',
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

  // Test 5: Envelope `replayed` field on mutating response roots (#2839)
  // The seller's idempotency layer injects `replayed` into the response envelope at
  // replay time. Every mutating response root must accept it — either by declaring
  // the property or by keeping `additionalProperties` open at the root.
  log('Envelope `replayed` acceptance on mutating response roots (#2839):', 'info');

  const propertyListBody = {
    list_id: 'pl_01HW7J8K9P0Q1R2S3T4U5V6W7X',
    name: 'Spring 2026 brand-safe inventory'
  };
  const collectionListBody = {
    list_id: 'cl_01HW7J8K9P0Q1R2S3T4U5V6W7X',
    name: 'Premium CTV series'
  };

  await testSchemaValidation(
    '/schemas/property/create-property-list-response.json',
    {
      list: propertyListBody,
      auth_token: 'secret_token_at_least_32_chars_long__________',
      replayed: true
    },
    'create_property_list accepts replayed on envelope'
  );

  await testSchemaValidation(
    '/schemas/property/update-property-list-response.json',
    { list: propertyListBody, replayed: false },
    'update_property_list accepts replayed on envelope'
  );

  await testSchemaValidation(
    '/schemas/property/delete-property-list-response.json',
    { deleted: true, list_id: 'pl_01HW7J8K9P0Q1R2S3T4U5V6W7X', replayed: true },
    'delete_property_list accepts replayed on envelope'
  );

  await testSchemaValidation(
    '/schemas/collection/create-collection-list-response.json',
    {
      list: collectionListBody,
      auth_token: 'secret_token_at_least_32_chars_long__________',
      replayed: true
    },
    'create_collection_list accepts replayed on envelope'
  );

  await testSchemaValidation(
    '/schemas/collection/update-collection-list-response.json',
    { list: collectionListBody, replayed: false },
    'update_collection_list accepts replayed on envelope'
  );

  await testSchemaValidation(
    '/schemas/collection/delete-collection-list-response.json',
    { deleted: true, list_id: 'cl_01HW7J8K9P0Q1R2S3T4U5V6W7X', replayed: true },
    'delete_collection_list accepts replayed on envelope'
  );

  await testSchemaValidation(
    '/schemas/governance/report-plan-outcome-response.json',
    { outcome_id: 'outcome_abc123', status: 'accepted', replayed: true },
    'report_plan_outcome accepts replayed on envelope'
  );

  await testSchemaValidation(
    '/schemas/governance/sync-plans-response.json',
    {
      plans: [{ plan_id: 'plan_abc123', status: 'active', version: 1 }],
      replayed: false
    },
    'sync_plans accepts replayed on envelope'
  );

  // Negative test: explicit `replayed` declaration must type-check. An AJV
  // schema with `additionalProperties: true` alone would accept `replayed:
  // "true"` as a string; the explicit property block is what enforces the
  // boolean contract.
  await testSchemaRejection(
    '/schemas/governance/sync-plans-response.json',
    {
      plans: [{ plan_id: 'plan_abc123', status: 'active', version: 1 }],
      replayed: 'true'
    },
    'sync_plans rejects replayed as string (type enforced)'
  );

  // Structural lint: no task-family response schema may seal the envelope with
  // `additionalProperties: false` anywhere on the root or in a composition
  // branch (oneOf/anyOf/allOf) unless `replayed` is declared on that seal. This
  // catches the #2839 class of bug at author time. Skips `core/` (field
  // sub-schemas that ship with `*-response.json` filenames but are not task
  // response envelopes).
  totalTests++;
  const offenders = [];
  const inspectEnvelope = (schema, where) => {
    const localOffenders = [];
    const sealed = schema.additionalProperties === false;
    const declaresReplayed = !!(schema.properties && schema.properties.replayed);
    if (sealed && !declaresReplayed) localOffenders.push(where);
    for (const key of ['oneOf', 'anyOf', 'allOf']) {
      if (Array.isArray(schema[key])) {
        schema[key].forEach((branch, i) => {
          if (branch && typeof branch === 'object') {
            localOffenders.push(...inspectEnvelope(branch, `${where}.${key}[${i}]`));
          }
        });
      }
    }
    return localOffenders;
  };
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith('-response.json')) {
        const rel = path.relative(SCHEMA_BASE_DIR, p);
        if (rel.startsWith('core/') || rel.startsWith('core' + path.sep)) continue;
        const schema = JSON.parse(fs.readFileSync(p, 'utf8'));
        const issues = inspectEnvelope(schema, 'root');
        for (const issue of issues) offenders.push(`${rel} (${issue})`);
      }
    }
  };
  walk(SCHEMA_BASE_DIR);
  if (offenders.length === 0) {
    log(`  \u2713 All *-response.json schemas accept envelope-level passthrough (#2839 lint)`, 'success');
    passedTests++;
  } else {
    log(`  \u2717 ${offenders.length} response schema(s) seal the envelope with additionalProperties: false:`, 'error');
    for (const f of offenders) log(`      ${f}`, 'error');
    log(`    Either flip additionalProperties to true, or declare envelope fields (replayed, context, ext).`, 'error');
    failedTests++;
  }

  // Drift guard: every inlined `replayed` description must match the canonical
  // definition in core/protocol-envelope.json so that a clarification there
  // propagates or is deliberately diverged. Catches silent drift across the 8
  // mutating response schemas.
  totalTests++;
  const envelopeSchemaPath = path.join(SCHEMA_BASE_DIR, 'core/protocol-envelope.json');
  const canonicalReplayed = JSON.parse(fs.readFileSync(envelopeSchemaPath, 'utf8'))
    .properties.replayed.description;
  const driftOffenders = [];
  const walkDrift = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walkDrift(p);
      else if (entry.name.endsWith('-response.json')) {
        const rel = path.relative(SCHEMA_BASE_DIR, p);
        if (rel.startsWith('core/') || rel.startsWith('core' + path.sep)) continue;
        const schema = JSON.parse(fs.readFileSync(p, 'utf8'));
        const r = schema.properties && schema.properties.replayed;
        if (r && r.description && r.description !== canonicalReplayed) {
          driftOffenders.push(rel);
        }
      }
    }
  };
  walkDrift(SCHEMA_BASE_DIR);
  if (driftOffenders.length === 0) {
    log(`  \u2713 Inlined replayed descriptions match core/protocol-envelope.json (drift guard)`, 'success');
    passedTests++;
  } else {
    log(`  \u2717 ${driftOffenders.length} inlined replayed description(s) diverge from core/protocol-envelope.json:`, 'error');
    for (const f of driftOffenders) log(`      ${f}`, 'error');
    failedTests++;
  }

  log('');

  // Test 6: Bundled schemas (no $ref resolution needed)
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
      strict: false,
      discriminator: true
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
    const ajv = new Ajv({ allErrors: true, strict: false, discriminator: true });
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
          const ajv = new Ajv({ allErrors: true, strict: false, discriminator: true });
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
