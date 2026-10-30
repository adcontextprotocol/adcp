'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseStoryboard, runStoryboard } = require('@adcp-protocol/fixture-test-sdk/testing');

const SCENARIOS = path.join(__dirname, '../../static/compliance/source/protocols/media-buy/scenarios');
const TOOLS = ['get_adcp_capabilities', 'get_products', 'comply_test_controller', 'create_media_buy', 'get_media_buy_delivery'];

function nativeProduct(scope, supported) {
  const product = {
    product_id: 'seller-native-product',
    name: 'Native reporting inventory',
    description: 'Seller-owned sandbox inventory for capability discovery.',
    delivery_type: 'non_guaranteed',
    channels: scope === 'measurement_accountability' && supported ? ['ctv'] : ['display'],
    publisher_properties: [{ publisher_domain: 'publisher.example', selection_type: 'all' }],
    format_options: [{ format_option_id: 'native-image', format_kind: 'image', params: { width: 300, height: 250 } }],
    ...(scope === 'canonical_formats' && supported ? {
      format_ids: [{ agent_url: 'https://creative.example', id: 'native-image' }],
    } : {}),
    pricing_options: [{ pricing_option_id: 'native-auction', pricing_model: 'cpm', currency: 'USD', floor_price: 8 }],
    reporting_capabilities: {
      available_reporting_frequencies: ['daily'],
      expected_delay_minutes: 60,
      timezone: 'UTC',
      supports_webhooks: false,
      date_range_support: 'date_range',
      available_metrics: scope === 'measurement_accountability' && supported
        ? ['impressions', 'spend', 'completed_views'] : ['impressions', 'spend'],
      ...(scope === 'vendor_metric_accountability' && supported ? {
        vendor_metrics: [
          { vendor: { domain: 'attentionvendor.example' }, metric_id: 'attention_units' },
          { vendor: { domain: 'attentionvendor.example' }, metric_id: 'post_flight_brand_lift' },
        ],
        measurement_windows: [
          { window_id: 'live', duration_days: 0, expected_availability_days: 0 },
          { window_id: 'post_flight', duration_days: 0, expected_availability_days: 14, is_guarantee_basis: true },
        ],
      } : {}),
    },
  };
  return product;
}

async function prepare(scope, { supported = false, modes = ['brief', 'wholesale'], committedMetricsSupported = true, seedScenarios = ['seed_account', 'seed_product', 'seed_pricing_option'], emptyVendorMetrics = false, differentVendor = false, differentBrandId = false, missingFutureWindow = false, legacyOnly = false, structuredAccountReference = false, malformed = false, paginate = false, seedFailure = false } = {}) {
  const storyboard = parseStoryboard(fs.readFileSync(path.join(SCENARIOS, `${scope}.yaml`), 'utf8'));
  // Keep source applicability, full pre-flight fixture resolution, and real
  // controller steps. Reporting and creative lifecycle checks run separately.
  const seedPhase = scope === 'canonical_formats' ? 'seed_supported_canonical_fixtures' : 'seed_supported_reporting_fixture';
  storyboard.phases = storyboard.phases.filter(phase => phase.id === seedPhase);
  assert.equal(storyboard.phases.length, 1, 'the supported fixture has an explicit guarded seed phase');
  if (structuredAccountReference) storyboard.phases[0].steps[0].sample_request.account = '$context.account';
  const product = nativeProduct(scope, supported);
  if (legacyOnly) {
    delete product.format_options;
    product.format_ids = [{ agent_url: 'https://creative.example', id: 'native-image' }];
  }
  if (emptyVendorMetrics) product.reporting_capabilities.vendor_metrics = [];
  if (differentVendor) product.reporting_capabilities.vendor_metrics.forEach(metric => { metric.vendor.domain = 'another-vendor.example'; });
  if (differentBrandId) product.reporting_capabilities.vendor_metrics.forEach(metric => { metric.vendor.brand_id = 'another_brand'; });
  if (missingFutureWindow) product.reporting_capabilities.measurement_windows = product.reporting_capabilities.measurement_windows.filter(window => window.window_id !== 'post_flight');
  if (malformed) product.reporting_capabilities = null;
  const calls = [];
  const result = await runStoryboard('https://seller.example/mcp', storyboard, {
    protocol: 'mcp',
    agentTools: TOOLS,
    _profile: {
      tools: TOOLS,
      raw_capabilities: {
        supported_protocols: ['media_buy'],
        media_buy: { buying_modes: modes, features: { committed_metrics_supported: committedMetricsSupported, canonical_creatives: true } },
        compliance_testing: { scenarios: seedScenarios },
      },
    },
    _client: {
      resetContext() {},
      async executeTask(task, request) {
        calls.push({ task, request: structuredClone(request) });
        if (task === 'get_products') {
          assert.equal(request.buying_mode, 'wholesale');
          assert.equal(request.filters, undefined, 'support is discovered before requiring a metric filter');
          assert.deepEqual(request.account, storyboard.context.account, 'the native catalog uses the isolated seeded account');
          return { success: true, data: {
            status: 'completed',
            products: paginate && !request.pagination?.cursor ? [] : [product],
            cache_scope: 'account',
            wholesale_feed_version: 'native-catalog-v1',
            ...(paginate && !request.pagination?.cursor ? { pagination: { has_more: true, cursor: 'native-page-2' } } : {}),
            context: request.context,
          } };
        }
        assert.equal(task, 'comply_test_controller');
        if (request.scenario === 'list_scenarios') {
          return { success: true, data: { scenarios: seedScenarios } };
        }
        if (['seed_product', 'seed_pricing_option'].includes(request.scenario)) {
          assert.deepEqual(request.account, storyboard.context.account, 'feature seeding retains the complete isolated caller account');
        }
        if (request.scenario === 'seed_product') {
          assert.ok(calls.some(call => call.task === 'get_products'), 'native support is checked before optional feature seeding');
          if (seedFailure) return { success: true, data: { success: false, error: 'Deliberate supported seed failure' } };
        }
        return { success: true, data: { success: true, context: request.context } };
      },
    },
  });
  return { result, calls };
}

function featureSeeds(calls) {
  return calls.filter(call => call.task === 'comply_test_controller' && ['seed_product', 'seed_pricing_option'].includes(call.request.scenario));
}

module.exports = { SCENARIOS, TOOLS, nativeProduct, prepare, featureSeeds };
