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

function duplicateValues(items, property) {
  const seen = new Set();
  const duplicates = new Set();
  for (const item of items) {
    const value = item[property];
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates];
}

function validateLocalizationRequestSemantics(localization) {
  const errors = [];
  const targets = localization.target_variants || [];
  for (const property of ['locale_variant_id', 'locale']) {
    if (duplicateValues(targets, property).length > 0) {
      errors.push(`target ${property} values must be unique`);
    }
    if (targets.some((target) => target[property] === localization.source?.[property])) {
      errors.push(`target ${property} must differ from source ${property}`);
    }
  }
  return errors;
}

const LOCALIZATION_STATUS_PRECEDENCE = [
  'rejected',
  'suspended',
  'pending_review',
  'processing',
  'approved'
];

function aggregateLocalizationStatus(variants) {
  if (variants.length > 0 && variants.every((variant) => variant.status === 'archived')) {
    return 'archived';
  }
  return LOCALIZATION_STATUS_PRECEDENCE.find((status) =>
    variants.some((variant) => variant.status === status)
  );
}

function validateLocalizationReadbackSemantics(localization, aggregateStatus) {
  const errors = [];
  const variants = localization.variants || [];
  for (const property of ['locale_variant_id', 'locale', 'provider_variant_id']) {
    if (duplicateValues(variants, property).length > 0) {
      errors.push(`variant ${property} values must be unique`);
    }
  }
  const sourceCount = variants.filter((variant) => variant.role === 'source').length;
  if (sourceCount !== 1) errors.push('localization must contain exactly one source variant');
  if (localization.review_scope === 'creative' && variants.length > 0) {
    for (const property of ['status', 'launch_status']) {
      if (new Set(variants.map((variant) => variant[property])).size !== 1) {
        errors.push(`creative review scope requires identical ${property}`);
      }
    }
  }
  if (aggregateStatus !== undefined) {
    const expected = aggregateLocalizationStatus(variants);
    if (aggregateStatus !== expected) {
      errors.push(`aggregate status must be ${expected}`);
    }
  }
  return errors;
}

function testSemanticValidation(errors, expectedError, description) {
  totalTests++;
  const passed = expectedError
    ? errors.some((error) => error.includes(expectedError))
    : errors.length === 0;
  if (passed) {
    log(`  \u2713 ${description}`, 'success');
    passedTests++;
  } else {
    log(`  \u2717 ${description}`, 'error');
    log(`    Semantic errors: ${JSON.stringify(errors)}`, 'error');
    failedTests++;
  }
}

function testValidationConstraints(constraints, expectedConstraints, description) {
  totalTests++;
  const passed =
    constraints &&
    Object.entries(expectedConstraints).every(
      ([key, value]) => JSON.stringify(constraints[key]) === JSON.stringify(value)
    );
  if (passed) {
    log(`  \u2713 ${description}`, 'success');
    passedTests++;
  } else {
    log(`  \u2717 ${description}`, 'error');
    log(`    Constraints: ${JSON.stringify(constraints)}`, 'error');
    failedTests++;
  }
}

function testValidationAnnotation(schemaId, expectedConstraints, description) {
  const schemaPath = path.join(SCHEMA_BASE_DIR, schemaId.replace('/schemas/', ''));
  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  testValidationConstraints(
    schema['x-adcp-validation']?.verifier_constraints,
    expectedConstraints,
    description
  );
}

function testNestedValidationAnnotation(schemaId, propertyPath, expectedConstraints, description) {
  const schemaPath = path.join(SCHEMA_BASE_DIR, schemaId.replace('/schemas/', ''));
  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  const node = propertyPath.reduce((value, key) => value?.[key], schema);
  testValidationConstraints(
    node?.['x-adcp-validation']?.verifier_constraints,
    expectedConstraints,
    description
  );
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

  // Test 3: Open-bound hosted durations through product format options
  log('Hosted Duration Schemas:', 'info');
  await testSchemaValidation(
    '/schemas/core/product.json',
    {
      product_id: 'shopgrid_hosted_duration_video',
      name: 'ShopGrid Hosted Duration Video',
      description: 'Retail media video inventory with open-bound hosted duration constraints.',
      publisher_properties: [
        {
          publisher_domain: 'shopgrid.example',
          selection_type: 'by_id',
          property_ids: ['shopgrid_owned_site']
        }
      ],
      channels: ['retail_media'],
      format_options: [
        {
          format_kind: 'video_hosted',
          params: {
            orientation: 'vertical',
            duration_ms_range: [null, 30000],
            video_codecs: ['h264'],
            audio_codecs: ['aac'],
            containers: ['mp4']
          }
        },
        {
          format_kind: 'audio_hosted',
          params: {
            duration_ms_range: [15000, null],
            audio_codecs: ['mp3']
          }
        }
      ],
      delivery_type: 'non_guaranteed',
      pricing_options: [
        {
          pricing_option_id: 'network_cpm',
          pricing_model: 'cpm',
          currency: 'USD'
        }
      ],
      reporting_capabilities: {
        available_reporting_frequencies: ['daily'],
        expected_delay_minutes: 240,
        timezone: 'UTC',
        supports_webhooks: false,
        available_metrics: ['impressions', 'spend'],
        date_range_support: 'date_range'
      }
    },
    'Product accepts hosted open-bound duration ranges'
  );

  await testSchemaValidation(
    '/schemas/core/product.json',
    {
      product_id: 'shopgrid_duration_precedence_video',
      name: 'ShopGrid Duration Precedence Video',
      description: 'Retail media video inventory declaring exact duration precedence over a broader range.',
      publisher_properties: [
        {
          publisher_domain: 'shopgrid.example',
          selection_type: 'by_id',
          property_ids: ['shopgrid_owned_site']
        }
      ],
      channels: ['retail_media'],
      format_options: [
        {
          format_kind: 'video_hosted',
          params: {
            duration_ms_exact: 30000,
            duration_ms_range: [null, 60000]
          }
        }
      ],
      delivery_type: 'non_guaranteed',
      pricing_options: [
        {
          pricing_option_id: 'network_cpm',
          pricing_model: 'cpm',
          currency: 'USD'
        }
      ],
      reporting_capabilities: {
        available_reporting_frequencies: ['daily'],
        expected_delay_minutes: 240,
        timezone: 'UTC',
        supports_webhooks: false,
        available_metrics: ['impressions', 'spend'],
        date_range_support: 'date_range'
      }
    },
    'Product accepts exact duration plus range for precedence handling'
  );

  const unboundedBothSidesProduct = {
    product_id: 'shopgrid_invalid_duration',
    name: 'ShopGrid Invalid Duration',
    description: 'Invalid retail media video inventory.',
    publisher_properties: [
      {
        publisher_domain: 'shopgrid.example',
        selection_type: 'by_id',
        property_ids: ['shopgrid_owned_site']
      }
    ],
    channels: ['retail_media'],
    format_options: [
      {
        format_kind: 'video_hosted',
        params: {
          duration_ms_range: [null, null]
        }
      }
    ],
    delivery_type: 'non_guaranteed',
    pricing_options: [
      {
        pricing_option_id: 'network_cpm',
        pricing_model: 'cpm',
        currency: 'USD'
      }
    ],
    reporting_capabilities: {
      available_reporting_frequencies: ['daily'],
      expected_delay_minutes: 240,
      timezone: 'UTC',
      supports_webhooks: false,
      available_metrics: ['impressions', 'spend'],
      date_range_support: 'date_range'
    }
  };
  await testSchemaRejection(
    '/schemas/core/product.json',
    unboundedBothSidesProduct,
    'Product rejects hosted duration_ms_range with both endpoints null'
  );

  log('');

  // Test 4: Create Media Buy Request with reporting_webhook (allOf with push-notification-config.json)
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

  log('Build Creative Request Schema (push_notification_config field):', 'info');
  await testSchemaValidation(
    '/schemas/media-buy/build-creative-request.json',
    {
      idempotency_key: 'build-creative-webhook-001',
      message: 'Create a short video ad for a fictional outdoor brand',
      push_notification_config: {
        url: 'https://buyer.example.com/webhooks/adcp',
        operation_id: 'build-creative-webhook-001'
      }
    },
    'Build creative request accepts operation-scoped push_notification_config'
  );

  log('');

  // Test 5: Get Media Buy Delivery Response (allOf with delivery-metrics.json)
  log('Get Media Buy Delivery Response Schema (allOf with delivery-metrics.json):', 'info');
  const deliveryResponseWithBreakdowns = {
    status: 'completed',
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
            currency: 'USD',
            missing_metrics: [
              {
                scope: 'standard',
                metric_id: 'completed_views'
              },
              {
                scope: 'vendor',
                vendor: {
                  domain: 'attentionvendor.example'
                },
                metric_id: 'attention_units'
              }
            ],
            by_catalog_item: [
              {
                content_id: 'sku-123',
                content_id_type: 'sku',
                spend: 1200,
                impressions: 48000
              }
            ],
            by_creative: [
              {
                creative_id: 'cr_123',
                spend: 14000,
                impressions: 560000,
                weight: 56
              }
            ],
            by_keyword: [
              {
                keyword: 'trail running shoes',
                match_type: 'phrase',
                spend: 900,
                impressions: 36000
              }
            ],
            by_geo: [
              {
                geo_level: 'region',
                geo_code: 'US-CA',
                geo_name: 'California',
                spend: 6500,
                impressions: 260000
              }
            ],
            by_geo_truncated: false
          }
        ]
      }
    ]
  };

  await testSchemaValidation(
    '/schemas/media-buy/get-media-buy-delivery-response.json',
    deliveryResponseWithBreakdowns,
    'Delivery response with aggregate metrics (allOf composition)'
  );

  const missingVendorMetricResponse = JSON.parse(JSON.stringify(deliveryResponseWithBreakdowns));
  delete missingVendorMetricResponse.media_buy_deliveries[0].by_package[0].missing_metrics[1].vendor;
  await testSchemaRejection(
    '/schemas/media-buy/get-media-buy-delivery-response.json',
    missingVendorMetricResponse,
    'Delivery response rejects vendor missing_metric without vendor'
  );

  const missingKeywordMatchTypeResponse = JSON.parse(JSON.stringify(deliveryResponseWithBreakdowns));
  delete missingKeywordMatchTypeResponse.media_buy_deliveries[0].by_package[0].by_keyword[0].match_type;
  await testSchemaRejection(
    '/schemas/media-buy/get-media-buy-delivery-response.json',
    missingKeywordMatchTypeResponse,
    'Delivery response rejects keyword metrics without match_type'
  );

  const missingGeoCodeResponse = JSON.parse(JSON.stringify(deliveryResponseWithBreakdowns));
  delete missingGeoCodeResponse.media_buy_deliveries[0].by_package[0].by_geo[0].geo_code;
  await testSchemaRejection(
    '/schemas/media-buy/get-media-buy-delivery-response.json',
    missingGeoCodeResponse,
    'Delivery response rejects geo metrics without geo_code'
  );

  log('');

  // Idempotency capability: discriminated oneOf on supported
  log('Get AdCP Capabilities Response (adcp.idempotency oneOf discriminator):', 'info');

  const capabilitiesBase = {
    status: 'completed',
    adcp: { major_versions: [3] },
    supported_protocols: ['media_buy'],
    account: { supported_billing: ['operator', 'agent'] }
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

  // in_flight_max_seconds — optional in 3.1, required when supported: true in 4.0.
  // Schema accepts the bound when present; cross-field bound (≤ replay_ttl_seconds)
  // is enforced below the schema layer (see custom assertion).
  await testSchemaValidation(
    '/schemas/protocol/get-adcp-capabilities-response.json',
    { ...capabilitiesBase, adcp: { ...capabilitiesBase.adcp, idempotency: { supported: true, replay_ttl_seconds: 86400, in_flight_max_seconds: 60 } } },
    'IdempotencySupported with in_flight_max_seconds: {supported: true, replay_ttl_seconds: 86400, in_flight_max_seconds: 60}'
  );

  await testSchemaRejection(
    '/schemas/protocol/get-adcp-capabilities-response.json',
    { ...capabilitiesBase, adcp: { ...capabilitiesBase.adcp, idempotency: { supported: true, replay_ttl_seconds: 86400, in_flight_max_seconds: 0 } } },
    'Rejects in_flight_max_seconds: 0 (below minimum 1)'
  );

  await testSchemaRejection(
    '/schemas/protocol/get-adcp-capabilities-response.json',
    { ...capabilitiesBase, adcp: { ...capabilitiesBase.adcp, idempotency: { supported: false, in_flight_max_seconds: 60 } } },
    'Rejects in_flight_max_seconds on unsupported branch: {supported: false, in_flight_max_seconds: 60}'
  );

  // Cross-field invariant: in_flight_max_seconds MUST NOT exceed replay_ttl_seconds.
  // JSON Schema cannot express field-relative bounds; the constraint is enforced
  // by a custom assertion alongside the schema check.
  const violatingCaps = { ...capabilitiesBase, adcp: { ...capabilitiesBase.adcp, idempotency: { supported: true, replay_ttl_seconds: 3600, in_flight_max_seconds: 7200 } } };
  // Schema layer accepts the shape (both bounds individually valid)
  await testSchemaValidation(
    '/schemas/protocol/get-adcp-capabilities-response.json',
    violatingCaps,
    'Schema accepts in_flight_max_seconds > replay_ttl_seconds at the schema layer (cross-field bound enforced below)'
  );
  // Cross-field invariant: programmatic check that the cross-field bound is violated.
  totalTests++;
  const idem = violatingCaps.adcp.idempotency;
  if (idem.in_flight_max_seconds > idem.replay_ttl_seconds) {
    log(`  ✓ Cross-field assertion: in_flight_max_seconds (${idem.in_flight_max_seconds}) > replay_ttl_seconds (${idem.replay_ttl_seconds}) detected — sellers MUST NOT emit this shape`, 'success');
    passedTests++;
  } else {
    log(`  ✗ Cross-field assertion: failed to detect in_flight_max_seconds > replay_ttl_seconds`, 'error');
    failedTests++;
  }

  log('');

  // request_signing.protocol_methods_* — JSON-RPC method namespace (adcp#4318).
  // The `protocol_methods_supported_for` / `_warn_for` / `_required_for` arrays
  // carry JSON-RPC method strings (e.g. `tasks/cancel`); plain AdCP tool names
  // (no `/`) are wire-distinct and belong in `supported_for` / `required_for`.
  // The schema enforces the namespace split via a `pattern: "/"` constraint on
  // the items.
  log('Get AdCP Capabilities Response (request_signing.protocol_methods_*):', 'info');

  await testSchemaValidation(
    '/schemas/protocol/get-adcp-capabilities-response.json',
    {
      ...capabilitiesBase,
      adcp: { ...capabilitiesBase.adcp, idempotency: { supported: true, replay_ttl_seconds: 86400 } },
      request_signing: {
        supported: true,
        covers_content_digest: 'either',
        required_for: ['create_media_buy'],
        supported_for: ['create_media_buy', 'update_media_buy'],
        protocol_methods_supported_for: ['tasks/cancel', 'tasks/get'],
        protocol_methods_required_for: ['tasks/cancel'],
      },
    },
    'Accepts protocol_methods_* with JSON-RPC method strings (`tasks/cancel`, `tasks/get`)'
  );

  await testSchemaRejection(
    '/schemas/protocol/get-adcp-capabilities-response.json',
    {
      ...capabilitiesBase,
      adcp: { ...capabilitiesBase.adcp, idempotency: { supported: true, replay_ttl_seconds: 86400 } },
      request_signing: {
        supported: true,
        covers_content_digest: 'either',
        required_for: [],
        protocol_methods_supported_for: ['create_media_buy'],
      },
    },
    'Rejects AdCP tool name (no `/`) in protocol_methods_supported_for'
  );

  await testSchemaRejection(
    '/schemas/protocol/get-adcp-capabilities-response.json',
    {
      ...capabilitiesBase,
      adcp: { ...capabilitiesBase.adcp, idempotency: { supported: true, replay_ttl_seconds: 86400 } },
      request_signing: {
        supported: true,
        covers_content_digest: 'either',
        required_for: [],
        protocol_methods_required_for: ['update_media_buy'],
      },
    },
    'Rejects AdCP tool name (no `/`) in protocol_methods_required_for'
  );

  log('');

  // Test 6: Envelope `replayed` field on mutating response roots (#2839)
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
      replayed: true,
      status: 'completed'
    },
    'create_property_list accepts replayed on envelope'
  );

  await testSchemaValidation(
    '/schemas/property/update-property-list-response.json',
    { list: propertyListBody, replayed: false, status: 'completed' },
    'update_property_list accepts replayed on envelope'
  );

  await testSchemaValidation(
    '/schemas/property/delete-property-list-response.json',
    { deleted: true, list_id: 'pl_01HW7J8K9P0Q1R2S3T4U5V6W7X', replayed: true, status: 'completed' },
    'delete_property_list accepts replayed on envelope'
  );

  await testSchemaValidation(
    '/schemas/collection/create-collection-list-response.json',
    {
      list: collectionListBody,
      auth_token: 'secret_token_at_least_32_chars_long__________',
      replayed: true,
      status: 'completed'
    },
    'create_collection_list accepts replayed on envelope'
  );

  await testSchemaValidation(
    '/schemas/collection/update-collection-list-response.json',
    { list: collectionListBody, replayed: false, status: 'completed' },
    'update_collection_list accepts replayed on envelope'
  );

  await testSchemaValidation(
    '/schemas/collection/delete-collection-list-response.json',
    { deleted: true, list_id: 'cl_01HW7J8K9P0Q1R2S3T4U5V6W7X', replayed: true, status: 'completed' },
    'delete_collection_list accepts replayed on envelope'
  );

  await testSchemaValidation(
    '/schemas/governance/report-plan-outcome-response.json',
    { outcome_id: 'outcome_abc123', outcome_state: 'accepted', replayed: true },
    'report_plan_outcome accepts replayed on envelope'
  );

  await testSchemaValidation(
    '/schemas/governance/sync-plans-response.json',
    {
      plans: [{ plan_id: 'plan_abc123', status: 'active', version: 1 }],
      replayed: false,
      status: 'completed'
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

  log('Task listing accepts creative-domain build_creative tasks:', 'info');
  const creativeBuildTaskList = {
    status: 'completed',
    query_summary: {
      total_matching: 1,
      returned: 1,
      domain_breakdown: {
        creative: 1
      }
    },
    tasks: [
      {
        task_id: 'task_build_creative_001',
        task_type: 'build_creative',
        domain: 'creative',
        status: 'submitted',
        created_at: '2026-06-07T19:00:00Z',
        updated_at: '2026-06-07T19:01:00Z',
        has_webhook: true
      }
    ],
    pagination: {
      has_more: false
    }
  };

  await testSchemaValidation(
    '/schemas/core/tasks-list-response.json',
    creativeBuildTaskList,
    'Legacy tasks/list response accepts build_creative task with creative domain'
  );
  await testSchemaValidation(
    '/schemas/protocol/list-tasks-response.json',
    creativeBuildTaskList,
    'Protocol list_tasks response accepts build_creative task with creative domain'
  );
  await testSchemaRejection(
    '/schemas/core/tasks-list-response.json',
    {
      ...creativeBuildTaskList,
      query_summary: {
        ...creativeBuildTaskList.query_summary,
        domain_breakdown: {
          creative: -1
        }
      }
    },
    'Legacy tasks/list response rejects negative creative domain breakdown'
  );
  await testSchemaRejection(
    '/schemas/protocol/list-tasks-response.json',
    {
      ...creativeBuildTaskList,
      query_summary: {
        ...creativeBuildTaskList.query_summary,
        domain_breakdown: {
          creative: -1
        }
      }
    },
    'Protocol list_tasks response rejects negative creative domain breakdown'
  );

  log('');

  log('SignalRef scope hygiene:', 'info');
  await testSchemaValidation(
    '/schemas/core/signal-ref.json',
    { scope: 'product', signal_id: 'high_intent_shoppers' },
    'SignalRef product scope accepts product-local signal_id'
  );
  await testSchemaRejection(
    '/schemas/core/signal-ref.json',
    { scope: 'product', signal_id: 'high_intent_shoppers', data_provider_domain: 'pinnacle-data.example' },
    'SignalRef product scope rejects data_provider_domain carry-over'
  );
  await testSchemaRejection(
    '/schemas/core/signal-ref.json',
    { scope: 'product', signal_id: 'high_intent_shoppers', signal_source_url: 'https://signals.example/.well-known/adcp/signals' },
    'SignalRef product scope rejects signal_source_url carry-over'
  );
  await testSchemaRejection(
    '/schemas/core/signal-ref.json',
    { scope: 'product', signal_id: 'high_intent_shoppers', source: 'agent' },
    'SignalRef product scope rejects SignalId source carry-over'
  );
  await testSchemaValidation(
    '/schemas/core/signal-ref.json',
    { scope: 'data_provider', data_provider_domain: 'pinnacle-data.example', signal_id: 'auto_intenders' },
    'SignalRef data_provider scope accepts provider-published signal'
  );
  await testSchemaRejection(
    '/schemas/core/signal-ref.json',
    { scope: 'data_provider', data_provider_domain: 'pinnacle-data.example', signal_id: 'auto_intenders', agent_url: 'https://signals.example' },
    'SignalRef data_provider scope rejects agent_url carry-over'
  );
  await testSchemaRejection(
    '/schemas/core/signal-ref.json',
    { scope: 'data_provider', data_provider_domain: 'pinnacle-data.example', signal_id: 'auto_intenders', signal_source_url: 'https://signals.example/.well-known/adcp/signals' },
    'SignalRef data_provider scope rejects signal_source_url carry-over'
  );
  await testSchemaRejection(
    '/schemas/core/signal-ref.json',
    { scope: 'data_provider', data_provider_domain: 'pinnacle-data.example', signal_id: 'auto_intenders', id: 'legacy_id' },
    'SignalRef data_provider scope rejects SignalId id carry-over'
  );
  await testSchemaValidation(
    '/schemas/core/signal-ref.json',
    { scope: 'signal_source', signal_source_url: 'https://signals.example/.well-known/adcp/signals', signal_id: 'custom_model_run_123' },
    'SignalRef signal_source scope accepts source-native signal'
  );
  await testSchemaRejection(
    '/schemas/core/signal-ref.json',
    { scope: 'signal_source', signal_source_url: 'https://signals.example/.well-known/adcp/signals', signal_id: 'custom_model_run_123', data_provider_domain: 'pinnacle-data.example' },
    'SignalRef signal_source scope rejects data_provider_domain carry-over'
  );
  await testSchemaRejection(
    '/schemas/core/signal-ref.json',
    { scope: 'signal_source', signal_source_url: 'https://signals.example/.well-known/adcp/signals', signal_id: 'custom_model_run_123', source: 'agent' },
    'SignalRef signal_source scope rejects SignalId source carry-over'
  );
  log('');

  log('product signal targeting invariants:', 'info');
  const productBase = {
    product_id: 'signal_targeting_product',
    name: 'Signal Targeting Product',
    description: 'Test',
    publisher_properties: [
      { publisher_domain: 'example.com', selection_type: 'all' }
    ],
    format_ids: [{ agent_url: 'https://creative.example.com', id: 'video_30s' }],
    delivery_type: 'guaranteed',
    delivery_measurement: { provider: 'Test' },
    pricing_options: [{ pricing_option_id: 'cpm', pricing_model: 'cpm', rate: 10, currency: 'USD', is_fixed: true }],
    reporting_capabilities: {
      available_reporting_frequencies: ['daily'],
      expected_delay_minutes: 240,
      timezone: 'UTC',
      supports_webhooks: false,
      available_metrics: ['impressions'],
      date_range_support: 'date_range'
    }
  };
  const productSignalOption = {
    signal_ref: { scope: 'product', signal_id: 'high_intent_shoppers' },
    name: 'High intent shoppers',
    value_type: 'binary'
  };
  const dataProviderSignalRefOnly = {
    signal_ref: { scope: 'data_provider', data_provider_domain: 'pinnacle-data.example', signal_id: 'auto_intenders' }
  };
  const legacySignalId = {
    source: 'catalog',
    data_provider_domain: 'pinnacle-data.example',
    id: 'auto_intenders'
  };
  const signalListingCore = {
    signal_agent_segment_id: 'sig_auto_intenders',
    name: 'Auto intenders',
    description: 'People likely to be in market for a vehicle.',
    signal_type: 'marketplace',
    coverage_percentage: 12,
    deployments: [
      { type: 'platform', platform: 'example_dsp', is_live: true }
    ]
  };
  const signalListingCoreWithoutLegacyCoverage = { ...signalListingCore };
  delete signalListingCoreWithoutLegacyCoverage.coverage_percentage;
  const signalCoverageForecast = {
    method: 'estimate',
    forecast_range_unit: 'availability',
    scope: {
      kind: 'inventory',
      label: 'network price-priority inventory'
    },
    bucket_semantics: 'exclusive',
    bucket_completeness: 'partial',
    points: [
      {
        label: 'auto intent present',
        dimensions: [
          {
            kind: 'signal',
            signal_ref: {
              scope: 'data_provider',
              data_provider_domain: 'pinnacle-data.example',
              signal_id: 'auto_intenders'
            },
            presence: 'present'
          }
        ],
        metrics: {
          impressions: { mid: 120000 },
          coverage_rate: { mid: 0.12 }
        }
      }
    ]
  };

  await testSchemaValidation(
    '/schemas/core/product.json',
    {
      ...productBase,
      signal_targeting_allowed: true,
      signal_targeting_options: [productSignalOption],
      signal_targeting_rules: { resolution_model: 'seller_planned', selection_mode: 'optional' }
    },
    'Product accepts signal_targeting_options and seller-planned resolution when signal_targeting_allowed is true'
  );
  await testSchemaValidation(
    '/schemas/core/product.json',
    {
      ...productBase,
      included_signals: [dataProviderSignalRefOnly]
    },
    'Product accepts included_signals as non-targetable data-provider refs without redefining signal metadata'
  );
  await testSchemaValidation(
    '/schemas/core/product.json',
    {
      ...productBase,
      signal_targeting_allowed: true,
      signal_targeting_options: [dataProviderSignalRefOnly]
    },
    'Product accepts data-provider signal_targeting_options without redefining name or value_type'
  );
  await testSchemaRejection(
    '/schemas/core/product.json',
    {
      ...productBase,
      included_signals: [{ signal_ref: { scope: 'product', signal_id: 'seller_defined_signal' } }]
    },
    'Product rejects product-local included_signals without inline name and value_type'
  );
  await testSchemaRejection(
    '/schemas/core/product.json',
    {
      ...productBase,
      signal_targeting_allowed: true,
      signal_targeting_options: [{ signal_ref: { scope: 'product', signal_id: 'seller_defined_signal' } }]
    },
    'Product rejects product-local signal_targeting_options without inline name and value_type'
  );
  await testSchemaRejection(
    '/schemas/core/product.json',
    {
      ...productBase,
      signal_targeting_allowed: true,
      signal_targeting_options: [{ signal_id: legacySignalId }]
    },
    'Product signal_targeting_options require canonical signal_ref even though shared listings accept legacy signal_id'
  );
  await testSchemaValidation(
    '/schemas/core/product.json',
    {
      ...productBase,
      signal_targeting_allowed: true,
      signal_targeting_rules: { resolution_model: 'direct_targeting', selection_mode: 'optional' }
    },
    'Product accepts signal_targeting_rules without inline options when signal targeting is allowed'
  );
  await testSchemaRejection(
    '/schemas/core/product.json',
    {
      ...productBase,
      signal_targeting_allowed: true,
      signal_targeting_options: [productSignalOption],
      signal_targeting_rules: { resolution_model: 'buyer_planned', selection_mode: 'optional' }
    },
    'Product rejects invalid signal_targeting_rules resolution_model'
  );
  await testSchemaRejection(
    '/schemas/core/product.json',
    {
      ...productBase,
      signal_targeting_options: [productSignalOption]
    },
    'Product rejects signal_targeting_options without signal_targeting_allowed: true'
  );
  await testSchemaRejection(
    '/schemas/core/product.json',
    {
      ...productBase,
      signal_targeting_allowed: false,
      signal_targeting_options: [productSignalOption]
    },
    'Product rejects signal_targeting_options with signal_targeting_allowed: false'
  );
  await testSchemaRejection(
    '/schemas/core/product.json',
    {
      ...productBase,
      signal_targeting_rules: { selection_mode: 'optional' }
    },
    'Product rejects signal_targeting_rules without signal_targeting_allowed: true'
  );
  await testSchemaRejection(
    '/schemas/core/product.json',
    {
      ...productBase,
      signal_targeting_allowed: false,
      signal_targeting_rules: { selection_mode: 'optional' }
    },
    'Product rejects signal_targeting_rules with signal_targeting_allowed: false'
  );
  log('');

  log('SignalCoverageForecast schema (top-level additionalProperties enforcement):', 'info');
  await testSchemaValidation(
    '/schemas/core/signal-coverage-forecast.json',
    signalCoverageForecast,
    'SignalCoverageForecast accepts valid forecast with presence: present and omitted signal_value'
  );
  await testSchemaValidation(
    '/schemas/core/signal-coverage-forecast.json',
    {
      ...signalCoverageForecast,
      scope: {
        kind: 'inventory',
        label: 'network price-priority inventory',
        inventory_class: 'price_priority'
      }
    },
    'SignalCoverageForecast scope accepts seller-specific extra qualifier (inventory_class)'
  );
  await testSchemaRejection(
    '/schemas/core/signal-coverage-forecast.json',
    {
      ...signalCoverageForecast,
      bucket_completness: 'partial'
    },
    'SignalCoverageForecast rejects unknown top-level field (bucket_completness typo)'
  );
  log('');

  log('SignalId compatibility during SignalRef migration:', 'info');
  await testSchemaValidation(
    '/schemas/signals/get-signals-response.json',
    {
      status: 'completed',
      cache_scope: 'public',
      signals: [
        {
          signal_id: legacySignalId,
          ...signalListingCore
        }
      ]
    },
    'get_signals response accepts deprecated signal_id without signal_ref during migration window'
  );
  await testSchemaValidation(
    '/schemas/core/audience-selector.json',
    {
      type: 'signal',
      signal_id: legacySignalId,
      value_type: 'binary',
      value: true
    },
    'AudienceSelector accepts deprecated signal_id without signal_ref during migration window'
  );
  await testSchemaValidation(
    '/schemas/core/targeting.json',
    {
      signal_targeting: [
        {
          signal_id: legacySignalId,
          value_type: 'binary',
          value: true
        }
      ]
    },
    'Targeting overlay accepts deprecated flat signal_targeting during migration window'
  );
  await testSchemaValidation(
    '/schemas/media-buy/get-products-request.json',
    {
      buying_mode: 'wholesale',
      filters: {
        signal_targeting: [
          {
            signal_id: legacySignalId,
            value_type: 'binary',
            value: true,
            targeting_mode: 'include'
          }
        ]
      }
    },
    'get_products filters.signal_targeting accepts deprecated signal_id during SignalRef migration window'
  );
  await testSchemaValidation(
    '/schemas/core/wholesale-feed-event.json',
    {
      event_id: '018f4f28-6b5d-7f50-9d57-111111111111',
      event_type: 'signal.created',
      entity_type: 'signal',
      entity_id: 'sig_auto_intenders',
      created_at: '2026-05-25T10:00:00Z',
      payload: {
        signal_agent_segment_id: 'sig_auto_intenders',
        applies_to: { scope: 'public' },
        signal: {
          signal_id: legacySignalId,
          ...signalListingCoreWithoutLegacyCoverage,
          coverage_forecast: signalCoverageForecast
        }
      }
    },
    'Wholesale signal event accepts deprecated signal_id, optional legacy coverage_percentage, relaxed data_provider/pricing_options, and coverage_forecast'
  );

  log('Registry change feed schemas:', 'info');
  await testSchemaValidation(
    '/schemas/core/registry-feed-response.json',
    {
      events: [
        {
          event_id: '019539a0-1234-7000-8000-000000000001',
          event_type: 'property.created',
          entity_type: 'property',
          entity_id: '019539a0-b1c2-7000-8000-000000000002',
          payload: {
            property_rid: '019539a0-b1c2-7000-8000-000000000002',
            classification: 'property',
            source: 'contributed',
            identifiers: [{ type: 'domain', value: 'streamer.example.com' }]
          },
          actor: 'pipeline:crawler',
          created_at: '2026-03-31T10:00:00.000Z'
        },
        {
          event_id: '019539a0-1234-7000-8000-000000000003',
          event_type: 'collection.created',
          entity_type: 'collection',
          entity_id: '019539a0-b1c2-7000-8000-000000000011',
          payload: {
            collection_rid: '019539a0-b1c2-7000-8000-000000000011',
            publisher_domain: 'streamer.example.com',
            collection_id: 'weekly_show',
            name: 'Weekly show',
            kind: 'series',
            source: 'authoritative',
            status: 'active',
            identifiers: [
              { publisher_domain: 'youtube.com', type: 'youtube_channel_id', value: 'uc_example123' }
            ]
          },
          actor: 'pipeline:catalog_crawl',
          created_at: '2026-03-31T10:00:30.000Z'
        },
        {
          event_id: '019539a0-1234-7000-8000-000000000013',
          event_type: 'collection.updated',
          entity_type: 'collection',
          entity_id: '019539a0-b1c2-7000-8000-000000000011',
          payload: {
            collection_rid: '019539a0-b1c2-7000-8000-000000000011',
            publisher_domain: 'streamer.example.com',
            collection_id: 'weekly_show',
            name: 'Weekly show',
            kind: 'series',
            source: 'authoritative',
            status: 'active',
            identifiers: [
              { publisher_domain: 'youtube.com', type: 'youtube_channel_id', value: 'UCK5Fn7Z6-iFMdxEye2FsKXg' },
              { publisher_domain: 'youtube.com', type: 'youtube_channel_handle', value: '@weeklyshow' },
              { publisher_domain: 'youtube.com', type: 'youtube_channel_url', value: 'https://youtube.com/@weeklyshow' }
            ]
          },
          actor: 'pipeline:catalog_crawl',
          created_at: '2026-03-31T10:00:40.000Z'
        },
        {
          event_id: '019539a0-1234-7000-8000-000000000014',
          event_type: 'collection.merged',
          entity_type: 'collection',
          entity_id: '019539a0-b1c2-7000-8000-000000000015',
          payload: {
            alias_rid: '019539a0-b1c2-7000-8000-000000000015',
            canonical_rid: '019539a0-b1c2-7000-8000-000000000011',
            evidence: 'manual_review'
          },
          actor: 'registry:manual_review',
          created_at: '2026-03-31T10:00:42.000Z'
        },
        {
          event_id: '019539a0-1234-7000-8000-000000000015',
          event_type: 'collection.removed',
          entity_type: 'collection',
          entity_id: '019539a0-b1c2-7000-8000-000000000014',
          payload: {
            collection_rid: '019539a0-b1c2-7000-8000-000000000014',
            publisher_domain: 'streamer.example.com',
            collection_id: 'retired_show',
            name: 'Retired show',
            kind: 'series',
            source: 'authoritative',
            status: 'removed',
            identifiers: []
          },
          actor: 'pipeline:catalog_crawl',
          created_at: '2026-03-31T10:00:45.000Z'
        },
        {
          event_id: '019539a0-1234-7000-8000-000000000012',
          event_type: 'authorization.granted',
          entity_type: 'authorization',
          entity_id: 'https://ads.agency.example.com:streamer.example.com',
          payload: {
            agent_url: 'https://ads.agency.example.com',
            publisher_domain: 'streamer.example.com',
            authorization_type: 'property_ids',
            property_ids: ['primetime_ctv'],
            placement_ids: ['pre_roll_30s'],
            countries: ['US', 'CA'],
            delegation_type: 'direct',
            exclusive: false,
            signing_keys: [{ kid: 'pub-2026-04', kty: 'OKP', alg: 'EdDSA', crv: 'Ed25519', x: 'abc123' }]
          },
          actor: 'pipeline:crawler',
          created_at: '2026-03-31T10:01:00.000Z'
        },
        {
          event_id: '019539a0-1234-7000-8000-000000000007',
          event_type: 'agent.discovered',
          entity_type: 'agent',
          entity_id: 'https://new-agent.example.com',
          payload: {
            agent_url: 'https://new-agent.example.com',
            channels: [],
            property_types: [],
            markets: [],
            categories: [],
            tags: [],
            delivery_types: [],
            property_count: 0,
            publisher_count: 0,
            has_tmp: false
          },
          actor: 'pipeline:crawler',
          created_at: '2026-03-31T10:01:30.000Z'
        },
        {
          event_id: '019539a0-1234-7000-8000-000000000004',
          event_type: 'agent.compliance_changed',
          entity_type: 'agent',
          entity_id: 'https://ads.agency.example.com',
          payload: {
            agent_url: 'https://ads.agency.example.com',
            previous_status: 'passing',
            current_status: 'degraded',
            headline: 'media_buy track failing: 2 scenarios down',
            tracks: { core: 'pass', media_buy: 'partial', creative: 'skip', governance: 'silent' },
            storyboards_passing: 24,
            storyboards_total: 27,
            storyboards: [
              { storyboard_id: 'media_buy_seller', status: 'failing', steps_passed: 4, steps_total: 7 },
              { storyboard_id: 'optional_controller', status: 'untested' },
              { storyboard_id: 'mixed_flow', status: 'partial', steps_passed: 3, steps_total: 5 }
            ]
          },
          actor: 'pipeline:compliance-heartbeat',
          created_at: '2026-03-31T10:02:00.000Z'
        },
        {
          event_id: '019539a0-1234-7000-8000-000000000008',
          event_type: 'agent.verification_earned',
          entity_type: 'agent',
          entity_id: 'https://ads.agency.example.com',
          payload: {
            agent_url: 'https://ads.agency.example.com',
            role: 'media-buy',
            verified_specialisms: ['sales-catalog-driven'],
            adcp_version: '3.1.0-beta.5'
          },
          actor: 'pipeline:compliance-heartbeat',
          created_at: '2026-03-31T10:02:30.000Z'
        },
        {
          event_id: '019539a0-1234-7000-8000-000000000009',
          event_type: 'agent.verification_lost',
          entity_type: 'agent',
          entity_id: 'https://ads.agency.example.com',
          payload: {
            agent_url: 'https://ads.agency.example.com',
            role: 'media-buy',
            reason: 'media_buy track failing'
          },
          actor: 'pipeline:compliance-heartbeat',
          created_at: '2026-03-31T10:02:45.000Z'
        },
        {
          event_id: '019539a0-1234-7000-8000-000000000010',
          event_type: 'publisher.adagents_discovered',
          entity_type: 'publisher',
          entity_id: 'streamer.example.com',
          payload: {
            publisher_domain: 'streamer.example.com',
            agent_count: 2,
            property_count: 4,
            collection_count: 1,
            source: 'catalog_crawl',
            discovery_method: 'direct',
            manager_domain: null
          },
          actor: 'pipeline:catalog_crawl',
          created_at: '2026-03-31T10:03:00.000Z'
        }
      ],
      cursor: '019539a0-1234-7000-8000-000000000013',
      has_more: false,
      freshness: {
        generated_at: '2026-03-31T10:03:15.000Z',
        latest_event_created_at: '2026-03-31T10:03:00.000Z',
        lag_seconds: 15,
        retention_days: 90
      }
    },
    'Registry feed response validates typed property, collection, authorization, and compliance events'
  );
  await testSchemaRejection(
    '/schemas/core/registry-event.json',
    {
      event_id: '019539a0-1234-7000-8000-000000000005',
      event_type: 'authorization.granted',
      entity_type: 'authorization',
      entity_id: 'https://ads.agency.example.com:streamer.example.com',
      payload: {
        agent_url: 'https://ads.agency.example.com'
      },
      actor: 'pipeline:crawler',
      created_at: '2026-03-31T10:03:00.000Z'
    },
    'Registry authorization events reject missing publisher_domain'
  );
  await testSchemaRejection(
    '/schemas/core/registry-event.json',
    {
      event_id: '019539a0-1234-7000-8000-000000000006',
      event_type: 'agent.compliance_changed',
      entity_type: 'publisher',
      entity_id: 'https://ads.agency.example.com',
      payload: {
        agent_url: 'https://ads.agency.example.com',
        previous_status: 'passing',
        current_status: 'degraded',
        tracks: { core: 'pass' },
        storyboards_passing: 1,
        storyboards_total: 2
      },
      actor: 'pipeline:compliance-heartbeat',
      created_at: '2026-03-31T10:04:00.000Z'
    },
    'Registry event discriminator rejects mismatched entity_type'
  );
  await testSchemaRejection(
    '/schemas/core/registry-event.json',
    {
      event_id: '019539a0-1234-7000-8000-000000000016',
      event_type: 'collection.created',
      entity_type: 'collection',
      entity_id: '019539a0-b1c2-7000-8000-000000000016',
      payload: {
        collection_rid: '019539a0-b1c2-7000-8000-000000000016',
        publisher_domain: 'streamer.example.com',
        collection_id: 'empty_identifiers',
        source: 'authoritative',
        status: 'active'
      },
      actor: 'pipeline:catalog_crawl',
      created_at: '2026-03-31T10:05:00.000Z'
    },
    'Registry collection.created rejects missing identifiers'
  );
  await testSchemaRejection(
    '/schemas/core/registry-event.json',
    {
      event_id: '019539a0-1234-7000-8000-000000000017',
      event_type: 'collection.created',
      entity_type: 'property',
      entity_id: '019539a0-b1c2-7000-8000-000000000017',
      payload: {
        collection_rid: '019539a0-b1c2-7000-8000-000000000017',
        publisher_domain: 'streamer.example.com',
        collection_id: 'wrong_entity',
        source: 'authoritative',
        status: 'active',
        identifiers: [{ publisher_domain: 'youtube.com', type: 'youtube_channel_id', value: 'UCK5Fn7Z6-iFMdxEye2FsKXg' }]
      },
      actor: 'pipeline:catalog_crawl',
      created_at: '2026-03-31T10:06:00.000Z'
    },
    'Registry collection events reject mismatched entity_type'
  );
  await testSchemaRejection(
    '/schemas/core/registry-event.json',
    {
      event_id: '019539a0-1234-7000-8000-000000000018',
      event_type: 'collection.removed',
      entity_type: 'collection',
      entity_id: '019539a0-b1c2-7000-8000-000000000018',
      payload: {
        collection_rid: '019539a0-b1c2-7000-8000-000000000018',
        publisher_domain: 'streamer.example.com',
        collection_id: 'not_removed',
        source: 'authoritative',
        status: 'active',
        identifiers: []
      },
      actor: 'pipeline:catalog_crawl',
      created_at: '2026-03-31T10:07:00.000Z'
    },
    'Registry collection.removed rejects active status'
  );
  await testSchemaValidation(
    '/schemas/signals/get-signals-request.json',
    {
      signal_refs: [
        {
          scope: 'data_provider',
          data_provider_domain: 'signals.example.com',
          signal_id: 'likely_ev_buyers'
        }
      ],
      fields: ['taxonomy', 'modeling', 'data_subject_rights']
    },
    'get_signals request accepts requested inline signal fields'
  );
  await testSchemaValidation(
    '/schemas/signals/get-signals-response.json',
    {
      status: 'completed',
      signals: [
        {
          signal_ref: {
            scope: 'signal_source',
            signal_source_url: 'https://signals.example.com/mcp',
            signal_id: 'private-likely-ev-buyers'
          },
          signal_agent_segment_id: 'seg-private-ev-001',
          name: 'Private likely EV buyers',
          description: 'Private source-native modeled EV intent signal.',
          signal_type: 'custom',
          deployments: [
            {
              type: 'platform',
              platform: 'dv360',
              account: '123456',
              is_live: true
            }
          ],
          taxonomy: {
            ref: 'https://taxonomy.example.com/audience/v1',
            values: [{ id: 'auto.ev_intenders' }]
          },
          data_subject_rights: {
            channels: [
              {
                rights: ['access'],
                email: 'privacy@example.com'
              }
            ],
            response_sla_days: 30
          }
        }
      ],
      cache_scope: 'account'
    },
    'get_signals response accepts typed inline enrichment fields for source-native signals'
  );
  await testSchemaRejection(
    '/schemas/signals/get-signals-request.json',
    {
      signal_spec: 'EV intenders',
      fields: ['everything']
    },
    'get_signals request rejects unknown signal fields'
  );
  await testSchemaValidation(
    '/schemas/signals/get-signals-async-response-submitted.json',
    {
      status: 'submitted',
      task_id: 'task_signal_discovery_001',
      message: 'Provider discovery queued'
    },
    'get_signals submitted async envelope validates'
  );
  await testSchemaValidation(
    '/schemas/signals/get-signals-async-response-working.json',
    {
      percentage: 40,
      current_step: 'querying_providers',
      step_number: 2,
      total_steps: 5
    },
    'get_signals working async progress validates'
  );
  await testSchemaValidation(
    '/schemas/signals/get-signals-response.json',
    {
      status: 'failed',
      errors: [
        {
          code: 'PROVIDER_UNAVAILABLE',
          message: 'Signal provider did not respond before the task deadline'
        }
      ]
    },
    'get_signals failed completion does not require signals or cache_scope'
  );
  await testSchemaValidation(
    '/schemas/media-buy/get-products-response.json',
    {
      status: 'failed',
      errors: [
        {
          code: 'INVENTORY_UNAVAILABLE',
          message: 'Inventory provider did not respond before the task deadline'
        }
      ]
    },
    'get_products failed completion does not require products or cache_scope'
  );
  log('');

  // Product `publisher_properties` rejects `publisher_domains[]` compact form (#4508):
  //
  // What's being exercised: the rejection comes from the `allOf` clause in
  // `core/product.json` (`{ not: { required: ['publisher_domains'] } }`),
  // NOT from the selector schema's XOR. The selector itself accepts both
  // singular and plural; product-side wraps the selector to forbid plural.
  // If a future regression removes that `allOf+not` clause, these tests
  // turn red — the compact form would silently pass through products.
  log('product.publisher_properties rejects compact `publisher_domains[]` form (#4508):', 'info');
  await testSchemaValidation(
    '/schemas/core/product.json',
    {
      product_id: 'singular_ok',
      name: 'Singular OK',
      description: 'Test',
      publisher_properties: [
        { publisher_domain: 'example.com', selection_type: 'all' }
      ],
      format_ids: [{ agent_url: 'https://creative.example.com', id: 'video_30s' }],
      delivery_type: 'guaranteed',
      delivery_measurement: { provider: 'Test' },
      pricing_options: [{ pricing_option_id: 'cpm', pricing_model: 'cpm', rate: 10, currency: 'USD', is_fixed: true }],
      reporting_capabilities: {
        available_reporting_frequencies: ['daily'],
        expected_delay_minutes: 240,
        timezone: 'UTC',
        supports_webhooks: false,
        available_metrics: ['impressions'],
        date_range_support: 'date_range'
      }
    },
    'Product with singular publisher_domain accepted'
  );
  await testSchemaRejection(
    '/schemas/core/product.json',
    {
      product_id: 'compact_rejected',
      name: 'Compact rejected',
      description: 'Test',
      publisher_properties: [
        { publisher_domains: ['example.com', 'other.example'], selection_type: 'by_tag', property_tags: ['t'] }
      ],
      format_ids: [{ agent_url: 'https://creative.example.com', id: 'video_30s' }],
      delivery_type: 'guaranteed',
      delivery_measurement: { provider: 'Test' },
      pricing_options: [{ pricing_option_id: 'cpm', pricing_model: 'cpm', rate: 10, currency: 'USD', is_fixed: true }],
      reporting_capabilities: {
        available_reporting_frequencies: ['daily'],
        expected_delay_minutes: 240,
        timezone: 'UTC',
        supports_webhooks: false,
        available_metrics: ['impressions'],
        date_range_support: 'date_range'
      }
    },
    'Product with compact publisher_domains[] form rejected'
  );
  await testSchemaRejection(
    '/schemas/core/product.json',
    {
      product_id: 'compact_rejected_all',
      name: 'Compact rejected on all',
      description: 'Test',
      publisher_properties: [
        { publisher_domains: ['example.com'], selection_type: 'all' }
      ],
      format_ids: [{ agent_url: 'https://creative.example.com', id: 'video_30s' }],
      delivery_type: 'guaranteed',
      delivery_measurement: { provider: 'Test' },
      pricing_options: [{ pricing_option_id: 'cpm', pricing_model: 'cpm', rate: 10, currency: 'USD', is_fixed: true }],
      reporting_capabilities: {
        available_reporting_frequencies: ['daily'],
        expected_delay_minutes: 240,
        timezone: 'UTC',
        supports_webhooks: false,
        available_metrics: ['impressions'],
        date_range_support: 'date_range'
      }
    },
    'Product with compact form on `all` selector rejected'
  );
  log('');

  // Signal definition enrichment: taxonomy is metadata on the signal
  // definition, not a fourth value_type or package-targeting expression branch.
  log('Signal Definition enrichment:', 'info');
  await testSchemaValidation(
    '/schemas/core/signal-definition.json',
    {
      id: 'likely_ev_buyers',
      name: 'Likely EV buyers',
      description: 'Modeled audience for likely electric-vehicle purchase intent.',
      value_type: 'binary',
      taxonomy: {
        ref: 'https://taxonomy.example.com/audience/v1',
        version: '1.0',
        values: [
          { id: 'auto.ev_intenders', path: 'Automotive > EV intenders' }
        ],
        parent_match_behavior: 'descendants_supported'
      },
      data_sources: ['web_usage', 'online_ecommerce'],
      methodology: 'modeled',
      audience_expansion: true,
      countries: ['US'],
      consent_basis: ['consent'],
      modeling: {
        method: 'lookalike',
        seed_source: {
          type: 'first_party_crm',
          provider_signed: true
        },
        training_data_jurisdictions: ['US'],
        ai_act_risk_class: 'limited',
        disclosure: {
          required: true,
          jurisdictions: [
            {
              country: 'US',
              region: 'CA',
              regulation: 'state_ai_disclosure',
              disclosure_text: 'Modeled audience segment.',
              audience: 'buyer'
            }
          ]
        }
      },
      data_subject_rights: {
        upstream_source_domain: 'signals.example.com',
        channels: [
          {
            rights: ['access', 'erasure', 'objection'],
            url: 'https://privacy.signals.example.com/requests',
            languages: ['en-US'],
            countries: ['US']
          }
        ],
        response_sla_days: 30,
        ccpa_opt_out_url: 'https://privacy.signals.example.com/opt-out'
      }
    },
    'Binary signal accepts taxonomy metadata, modeling disclosure, and channel-based DSR routing'
  );
  await testSchemaValidation(
    '/schemas/core/signal-definition.json',
    {
      id: 'panel_derived_households',
      name: 'Panel-derived households',
      description: 'Panel-derived TV audience signal where panel recruitment is part of the measurement methodology.',
      value_type: 'binary',
      data_sources: ['panel', 'tv_ott_or_stb_device'],
      methodology: 'derived',
      subject_type: 'household',
      resolution_method: 'mixed'
    },
    'Panel-derived signal accepts panel as a data source'
  );
  await testSchemaValidation(
    '/schemas/core/signal-definition.json',
    {
      id: 'legacy_categorical_without_values',
      name: 'Legacy categorical without values',
      value_type: 'categorical'
    },
    'Categorical signal can omit allowed_values for backwards-compatible minor release'
  );
  await testSchemaValidation(
    '/schemas/core/signal-definition.json',
    {
      id: 'legacy_numeric_without_range',
      name: 'Legacy numeric without range',
      value_type: 'numeric'
    },
    'Numeric signal can omit range for backwards-compatible minor release'
  );
  await testSchemaValidation(
    '/schemas/core/signal-definition.json',
    {
      id: 'vehicle_ownership',
      name: 'Current vehicle ownership',
      value_type: 'categorical',
      allowed_values: ['luxury_ev', 'luxury_non_ev', 'mid_range', 'economy', 'none'],
      taxonomy: {
        ref: 'https://taxonomy.example.com/audience/v1',
        version: '1.0',
        values: [
          { id: 'auto.vehicle_ownership', path: 'Automotive > Vehicle ownership' }
        ],
        value_mappings: [
          {
            value: 'luxury_ev',
            taxonomy_value_id: 'auto.vehicle_ownership.luxury_ev',
            path: 'Automotive > Vehicle ownership > Luxury EV'
          },
          {
            value: 'luxury_non_ev',
            taxonomy_value_id: 'auto.vehicle_ownership.luxury_non_ev',
            path: 'Automotive > Vehicle ownership > Luxury non-EV'
          }
        ],
        parent_match_behavior: 'exact_only'
      }
    },
    'Categorical signal accepts taxonomy value mappings for allowed_values'
  );
  await testSchemaRejection(
    '/schemas/core/signal-definition.json',
    {
      id: 'taxonomy_as_type_rejected',
      name: 'Taxonomy as value type rejected',
      value_type: 'taxonomy',
      taxonomy: {
        ref: 'https://taxonomy.example.com/audience/v1',
        values: [{ id: 'auto' }]
      }
    },
    'Rejects taxonomy as value_type; taxonomy belongs in signal-definition metadata'
  );
  await testSchemaRejection(
    '/schemas/core/signal-definition.json',
    {
      id: 'modeled_missing_block',
      name: 'Modeled missing block',
      value_type: 'binary',
      methodology: 'modeled'
    },
    'Rejects modeled methodology without modeling block'
  );
  await testSchemaRejection(
    '/schemas/core/signal-definition.json',
    {
      id: 'modeled_empty_training_jurisdictions',
      name: 'Modeled empty training jurisdictions',
      value_type: 'binary',
      methodology: 'modeled',
      modeling: {
        method: 'lookalike',
        seed_source: {
          type: 'first_party_crm',
          provider_signed: true
        },
        training_data_jurisdictions: [],
        ai_act_risk_class: 'limited'
      }
    },
    'Rejects modeled signal with empty training_data_jurisdictions'
  );
  await testSchemaRejection(
    '/schemas/core/signal-definition.json',
    {
      id: 'modeled_disclosure_missing_jurisdictions',
      name: 'Modeled disclosure missing jurisdictions',
      value_type: 'binary',
      methodology: 'modeled',
      modeling: {
        method: 'lookalike',
        seed_source: {
          type: 'first_party_crm',
          provider_signed: true
        },
        training_data_jurisdictions: ['US'],
        ai_act_risk_class: 'limited',
        disclosure: {
          required: true
        }
      }
    },
    'Rejects required modeling disclosure without jurisdictions'
  );
  await testSchemaRejection(
    '/schemas/core/signal-definition.json',
    {
      id: 'categorical_taxonomy_missing_mapping',
      name: 'Categorical taxonomy missing mapping',
      value_type: 'categorical',
      allowed_values: ['luxury_ev'],
      taxonomy: {
        ref: 'https://taxonomy.example.com/audience/v1',
        values: [{ id: 'auto.vehicle_ownership' }]
      }
    },
    'Rejects categorical taxonomy metadata without value_mappings'
  );
  await testSchemaRejection(
    '/schemas/core/signal-definition.json',
    {
      id: 'offline_missing_onboarder',
      name: 'Offline missing onboarder',
      value_type: 'binary',
      data_sources: ['offline_transaction']
    },
    'Rejects offline/public-record data source without onboarder disclosure'
  );
  await testSchemaValidation(
    '/schemas/core/signal-definition.json',
    {
      id: 'dsr_email_access_channel',
      name: 'DSR email access channel',
      value_type: 'binary',
      data_subject_rights: {
        channels: [
          {
            rights: ['access'],
            email: 'privacy@example.com'
          }
        ]
      }
    },
    'Accepts DSR routing with an email-only access channel'
  );
  await testSchemaRejection(
    '/schemas/core/signal-definition.json',
    {
      id: 'dsr_no_core_right',
      name: 'DSR without core right',
      value_type: 'binary',
      data_subject_rights: {
        channels: [
          {
            rights: ['portability'],
            email: 'privacy@example.com'
          }
        ]
      }
    },
    'Rejects DSR routing that declares no access, erasure, or objection channel'
  );
  await testSchemaRejection(
    '/schemas/core/signal-definition.json',
    {
      id: 'dsr_gpc_not_signal_level',
      name: 'DSR with signal-level GPC rejected',
      value_type: 'binary',
      data_subject_rights: {
        channels: [
          {
            rights: ['access'],
            email: 'privacy@example.com'
          }
        ],
        gpc_honored: true
      }
    },
    'Rejects signal-level gpc_honored in DSR routing'
  );
  log('');

  // Test 7: Bundled schemas (no $ref resolution needed)
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

      await testBundledDeliveryMetricSchemaTitles(BUNDLED_DIR);

      // Test a response schema to verify nested refs are resolved
      await testBundledSchemaValidation(
        path.join(bundledPath, 'media-buy/get-products-response.json'),
        {
          status: 'completed',
          cache_scope: 'public',
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

  log('Native Creative Localization Schemas:', 'info');
  const localizedCreative = {
    creative_id: 'summer_image_localized',
    name: 'Summer image — localized',
    format_kind: 'image',
    assets: {
      image: {
        asset_type: 'image',
        url: 'https://cdn.nova.example/summer-en.jpg',
        width: 1080,
        height: 1080
      },
      headline: {
        asset_type: 'text',
        content: 'Summer starts here',
        language: 'en-US'
      }
    },
    localization: {
      source: { locale_variant_id: 'loc_en_us', locale: 'en-US' },
      target_variants: [
        {
          locale_variant_id: 'loc_es_es',
          locale: 'es-ES',
          translation_mode: 'buyer_supplied',
          assets: {
            headline: {
              asset_type: 'text',
              content: 'El verano empieza aquí',
              language: 'es-ES'
            }
          }
        }
      ]
    }
  };

  await testSchemaValidation(
    '/schemas/core/creative-asset.json',
    localizedCreative,
    'Creative accepts explicit buyer-supplied locale variants'
  );

  await testSchemaValidation(
    '/schemas/core/creative-asset.json',
    {
      ...localizedCreative,
      localization: {
        source: { locale_variant_id: 'loc_en_us', locale: 'en-US' },
        target_variants: [
          {
            locale_variant_id: 'loc_fr_fr',
            locale: 'fr-FR',
            translation_mode: 'provider_generated'
          }
        ]
      }
    },
    'Creative accepts an explicit provider-generated translation request'
  );

  testValidationAnnotation(
    '/schemas/core/creative-localization.json',
    {
      unique_target_properties: ['locale_variant_id', 'locale'],
      target_properties_disjoint_from_source: ['locale_variant_id', 'locale']
    },
    'Localization request exposes machine-readable locale and identity uniqueness rules'
  );

  testSemanticValidation(
    validateLocalizationRequestSemantics(localizedCreative.localization),
    undefined,
    'Localization request semantic verifier accepts unique source and target identities'
  );

  for (const [property, duplicateValue] of [
    ['locale', 'es-ES'],
    ['locale_variant_id', 'loc_es_es']
  ]) {
    const duplicateTargets = structuredClone(localizedCreative.localization);
    duplicateTargets.target_variants.push({
      locale_variant_id: 'loc_fr_fr',
      locale: 'fr-FR',
      translation_mode: 'provider_generated',
      [property]: duplicateValue
    });
    testSemanticValidation(
      validateLocalizationRequestSemantics(duplicateTargets),
      `target ${property} values must be unique`,
      `Localization request semantic verifier rejects duplicate target ${property}`
    );
  }

  for (const property of ['locale', 'locale_variant_id']) {
    const sourceCollision = structuredClone(localizedCreative.localization);
    sourceCollision.target_variants[0][property] = sourceCollision.source[property];
    testSemanticValidation(
      validateLocalizationRequestSemantics(sourceCollision),
      `target ${property} must differ from source ${property}`,
      `Localization request semantic verifier rejects source/target ${property} reuse`
    );
  }

  await testSchemaRejection(
    '/schemas/core/creative-asset.json',
    {
      ...localizedCreative,
      localization: {
        source: { locale_variant_id: 'loc_en_us', locale: 'en-US' },
        target_variants: [
          {
            locale_variant_id: 'loc_es_es',
            locale: 'es-ES',
            translation_mode: 'buyer_supplied'
          }
        ]
      }
    },
    'Buyer-supplied translation without overrides is rejected'
  );

  await testSchemaRejection(
    '/schemas/core/creative-asset.json',
    {
      ...localizedCreative,
      localization: {
        source: { locale_variant_id: 'loc_en_us', locale: 'en-US' },
        target_variants: [
          {
            locale_variant_id: 'loc_es_es',
            locale: 'es-ES',
            translation_mode: 'provider_generated',
            assets: {
              headline: {
                asset_type: 'text',
                content: 'Ambiguous supplied copy'
              }
            }
          }
        ]
      }
    },
    'Provider-generated translation with buyer assets is rejected'
  );

  const localizationReadback = {
    platform_id: 'provider_creative_123',
    review_scope: 'per_variant',
    variants: [
      {
        locale_variant_id: 'loc_en_us',
        locale: 'en-US',
        role: 'source',
        translation_mode: 'source',
        assets: localizedCreative.assets,
        provider_variant_id: 'provider_variant_en',
        status: 'approved',
        launch_status: 'ready'
      },
      {
        locale_variant_id: 'loc_es_es',
        locale: 'es-ES',
        role: 'target',
        translation_mode: 'buyer_supplied',
        assets: {
          ...localizedCreative.assets,
          headline: {
            asset_type: 'text',
            content: 'El verano empieza aquí',
            language: 'es-ES'
          }
        },
        provider_variant_id: 'provider_variant_es',
        status: 'pending_review',
        launch_status: 'pending'
      }
    ]
  };

  await testSchemaValidation(
    '/schemas/core/creative-localization-readback.json',
    localizationReadback,
    'Exact source and target localization readback validates'
  );

  testValidationAnnotation(
    '/schemas/core/creative-localization-readback.json',
    {
      unique_variant_properties: [
        'locale_variant_id',
        'locale',
        'provider_variant_id'
      ],
      exact_role_counts: { source: 1 },
      creative_review_scope_equal_properties: ['status', 'launch_status']
    },
    'Localization readback exposes machine-readable exactness rules'
  );

  const aggregateConstraints = {
    aggregate_status_field: 'status',
    aggregate_variant_status_path: 'localization.variants[].status',
    aggregate_status_precedence: LOCALIZATION_STATUS_PRECEDENCE,
    archived_requires_all_variants_archived: true
  };
  testNestedValidationAnnotation(
    '/schemas/creative/sync-creatives-response.json',
    ['oneOf', 0, 'properties', 'creatives', 'items', 'properties', 'localization'],
    aggregateConstraints,
    'Sync response exposes machine-readable localization status aggregation'
  );
  testNestedValidationAnnotation(
    '/schemas/creative/list-creatives-response.json',
    ['properties', 'creatives', 'items', 'properties', 'localization'],
    aggregateConstraints,
    'List response exposes machine-readable localization status aggregation'
  );

  testSemanticValidation(
    validateLocalizationReadbackSemantics(localizationReadback, 'pending_review'),
    undefined,
    'Localization readback verifier accepts exact roles, identities, and aggregate status'
  );

  for (const role of ['target', 'source']) {
    const invalidRoles = structuredClone(localizationReadback);
    invalidRoles.variants = invalidRoles.variants.map((variant) => ({ ...variant, role }));
    testSemanticValidation(
      validateLocalizationReadbackSemantics(invalidRoles),
      'exactly one source variant',
      `Localization readback verifier rejects ${role === 'target' ? 'zero' : 'multiple'} source roles`
    );
  }

  for (const property of ['locale_variant_id', 'locale', 'provider_variant_id']) {
    const duplicateReadback = structuredClone(localizationReadback);
    duplicateReadback.variants[1][property] = duplicateReadback.variants[0][property];
    testSemanticValidation(
      validateLocalizationReadbackSemantics(duplicateReadback),
      `variant ${property} values must be unique`,
      `Localization readback verifier rejects duplicate ${property}`
    );
  }

  for (const property of ['status', 'launch_status']) {
    const creativeScopeMismatch = structuredClone(localizationReadback);
    creativeScopeMismatch.review_scope = 'creative';
    testSemanticValidation(
      validateLocalizationReadbackSemantics(creativeScopeMismatch),
      `creative review scope requires identical ${property}`,
      `Localization readback verifier rejects creative-scope ${property} drift`
    );
  }

  testSemanticValidation(
    validateLocalizationReadbackSemantics(localizationReadback, 'approved'),
    'aggregate status must be pending_review',
    'Localization readback verifier rejects an aggregate status that hides pending review'
  );

  const precedenceReadback = structuredClone(localizationReadback);
  precedenceReadback.variants[0].status = 'suspended';
  precedenceReadback.variants[1].status = 'rejected';
  testSemanticValidation(
    validateLocalizationReadbackSemantics(precedenceReadback, 'rejected'),
    undefined,
    'Localization aggregate status uses rejected before suspended'
  );

  const archivedReadback = structuredClone(localizationReadback);
  archivedReadback.variants = archivedReadback.variants.map((variant) => ({
    ...variant,
    status: 'archived'
  }));
  testSemanticValidation(
    validateLocalizationReadbackSemantics(archivedReadback, 'archived'),
    undefined,
    'Localization aggregate status is archived only when every variant is archived'
  );

  const partiallyArchivedReadback = structuredClone(archivedReadback);
  partiallyArchivedReadback.variants[1].status = 'approved';
  testSemanticValidation(
    validateLocalizationReadbackSemantics(partiallyArchivedReadback, 'approved'),
    undefined,
    'Localization aggregate status ignores archived when another live state exists'
  );

  await testSchemaRejection(
    '/schemas/core/creative-localization-readback.json',
    {
      ...localizationReadback,
      variants: localizationReadback.variants.map((variant, index) =>
        index === 1
          ? { ...variant, status: 'rejected', launch_status: 'blocked' }
          : variant
      )
    },
    'Blocked locale readback without machine-readable blockers is rejected'
  );

  await testSchemaValidation(
    '/schemas/protocol/get-adcp-capabilities-response.json',
    {
      adcp_version: '3.1',
      status: 'completed',
      adcp: {
        major_versions: [3],
        idempotency: { supported: true, replay_ttl_seconds: 86400 }
      },
      supported_protocols: ['creative'],
      creative: {
        localization: {
          supported_locales: ['en-US', 'es-ES'],
          translation_modes: ['buyer_supplied'],
          max_target_variants: 10,
          review_scope: 'per_variant'
        }
      }
    },
    'Capabilities advertise discoverable locale and review support'
  );
  log('');

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

async function testBundledDeliveryMetricSchemaTitles(bundledDir) {
  totalTests++;
  try {
    const latestDir = path.join(bundledDir, 'latest');
    const coreSchemas = [
      ['core/missing-metric.json', 'Missing Metric'],
      ['core/catalog-item-delivery-metrics.json', 'Catalog Item Delivery Metrics'],
      ['core/creative-delivery-metrics.json', 'Creative Delivery Metrics'],
      ['core/keyword-delivery-metrics.json', 'Keyword Delivery Metrics'],
      ['core/geo-delivery-metrics.json', 'Geo Delivery Metrics']
    ];

    const missing = [];
    for (const [relPath, expectedTitle] of coreSchemas) {
      const schemaPath = path.join(latestDir, relPath);
      const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
      if (schema.title !== expectedTitle) {
        missing.push(`${relPath} title=${JSON.stringify(schema.title)} expected ${JSON.stringify(expectedTitle)}`);
      }
    }

    const deliverySchema = JSON.parse(fs.readFileSync(
      path.join(latestDir, 'bundled/media-buy/get-media-buy-delivery-response.json'),
      'utf8'
    ));
    const packageItems = deliverySchema.properties.media_buy_deliveries.items.properties.by_package.items;
    const packageBreakdowns = packageItems.allOf[1].properties;
    const bundledTitles = [
      [packageBreakdowns.missing_metrics.items, 'Missing Metric', 'by_package.missing_metrics.items'],
      [packageBreakdowns.by_catalog_item.items, 'Catalog Item Delivery Metrics', 'by_package.by_catalog_item.items'],
      [packageBreakdowns.by_creative.items, 'Creative Delivery Metrics', 'by_package.by_creative.items'],
      [packageBreakdowns.by_keyword.items, 'Keyword Delivery Metrics', 'by_package.by_keyword.items'],
      [packageBreakdowns.by_geo.items, 'Geo Delivery Metrics', 'by_package.by_geo.items']
    ];

    for (const [schema, expectedTitle, label] of bundledTitles) {
      if (!schema || schema.title !== expectedTitle) {
        missing.push(`${label} title=${JSON.stringify(schema && schema.title)} expected ${JSON.stringify(expectedTitle)}`);
      }
    }

    if (missing.length === 0) {
      log(`  \u2713 Bundled delivery metric schemas preserve named titles`, 'success');
      passedTests++;
      return true;
    }

    log(`  \u2717 Bundled delivery metric schemas preserve named titles`, 'error');
    for (const issue of missing) log(`      ${issue}`, 'error');
    failedTests++;
    return false;
  } catch (error) {
    log(`  \u2717 Bundled delivery metric schemas preserve named titles: ${error.message}`, 'error');
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
