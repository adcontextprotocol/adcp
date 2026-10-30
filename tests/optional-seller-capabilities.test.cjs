'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { parseStoryboard, runStoryboard } = require('@adcp/sdk/testing');

const SCENARIOS = path.join(__dirname, '../static/compliance/source/protocols/media-buy/scenarios');
const TOOLS = ['get_adcp_capabilities', 'get_products', 'comply_test_controller', 'create_media_buy', 'get_media_buy_delivery'];
const SCOPES = ['measurement_accountability', 'vendor_metric_accountability', 'canonical_formats'];

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
        media_buy: { buying_modes: modes, features: { committed_metrics_supported: committedMetricsSupported } },
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

for (const scope of SCOPES) {
  test(`${scope}: an optional feature absent from the native catalog never gets seeded`, async () => {
    const { result, calls } = await prepare(scope);
    assert.equal(result.failed_count, 0, JSON.stringify(result.phases));
    assert.equal(featureSeeds(calls).length, 0);
    assert.ok(result.skipped_count > 0, 'no match is visible missing coverage');
    assert.ok(result.coverage_gaps?.some(gap => gap.reason === 'fixture_unsatisfied'), 'missing coverage is explicit even though CI stays non-failing');
    assert.ok(result.phases.filter(phase => phase.phase_id !== '__controller_seeding__').flatMap(phase => phase.steps).every(step => step.skipped));
    assert.equal(calls.filter(call => call.task === 'get_products').length, 1);
  });

  test(`${scope}: supported native inventory permits synthetic auction fixtures`, async () => {
    const { result, calls } = await prepare(scope, { supported: true, paginate: true });
    assert.equal(result.overall_passed, true, JSON.stringify(result.phases));
    assert.equal(result.failed_count, 0);
    assert.equal(result.skipped_count, 0);
    const seeds = featureSeeds(calls);
    if (scope === 'canonical_formats') {
      assert.equal(seeds.length, 4);
      assert.ok(seeds.every(call => call.request.scenario === 'seed_product'));
      assert.ok(seeds.every(call => call.request.params.fixture.pricing_options.every(price => price.floor_price > 0 && price.fixed_price === undefined)));
    } else {
      assert.deepEqual(seeds.map(call => call.request.scenario), ['seed_product', 'seed_pricing_option']);
      assert.ok(seeds[1].request.params.fixture.floor_price > 0);
      assert.equal(seeds[1].request.params.fixture.fixed_price, undefined);
    }
    assert.equal(calls.filter(call => call.task === 'get_products').length, 2, 'native support may be on a later page');
  });

  test(`${scope}: brief-only sellers are gated before any controller mutation`, async () => {
    const { result, calls } = await prepare(scope, { supported: true, modes: ['brief'] });
    assert.equal(result.failed_count, 0);
    assert.ok(result.skipped_count > 0);
    assert.equal(calls.length, 0);
  });

  test(`${scope}: malformed native discovery remains a failure`, async () => {
    const { result, calls } = await prepare(scope, { supported: true, malformed: true });
    assert.ok(result.failed_count > 0, JSON.stringify(result.phases));
    assert.equal(featureSeeds(calls).length, 0);
  });

  test(`${scope}: advertised fixture failures remain failures after native support`, async () => {
    const { result } = await prepare(scope, { supported: true, seedFailure: true });
    assert.ok(result.failed_count > 0, JSON.stringify(result.phases));
  });

  test(`${scope}: missing product seed advertisement is gated before any mutation`, async () => {
    const { result, calls } = await prepare(scope, { supported: true, seedScenarios: ['seed_account'] });
    assert.equal(result.failed_count, 0);
    assert.ok(result.skipped_count > 0);
    assert.equal(calls.length, 0);
  });
}

test('an empty vendor_metrics array does not opt into vendor accountability', async () => {
  const { result, calls } = await prepare('vendor_metric_accountability', { emptyVendorMetrics: true });
  assert.equal(result.failed_count, 0, JSON.stringify(result.phases));
  assert.equal(featureSeeds(calls).length, 0);
  assert.ok(result.skipped_count > 0);
});

test('vendor metric publication does not imply committed-metric snapshot support', async () => {
  const { result, calls } = await prepare('vendor_metric_accountability', { supported: true, committedMetricsSupported: false });
  assert.equal(result.failed_count, 0);
  assert.ok(result.skipped_count > 0);
  assert.equal(calls.length, 0);
});

test('canonical compatibility does not require publishing vendor metrics', async () => {
  assert.equal(nativeProduct('canonical_formats', true).reporting_capabilities.vendor_metrics, undefined);
  const { result, calls } = await prepare('canonical_formats', { supported: true });
  assert.equal(result.overall_passed, true, JSON.stringify(result.phases));
  assert.equal(featureSeeds(calls).length, 4);
});

test('legacy-only products do not opt into canonical compatibility fixtures', async () => {
  const { result, calls } = await prepare('canonical_formats', { supported: true, legacyOnly: true });
  assert.equal(result.failed_count, 0, JSON.stringify(result.phases));
  assert.ok(result.coverage_gaps?.some(gap => gap.reason === 'fixture_unsatisfied'));
  assert.equal(featureSeeds(calls).length, 0);
});

for (const absentContract of ['differentVendor', 'differentBrandId', 'missingFutureWindow']) {
  test(`vendor accountability requires the actual vendor and measurement contract (${absentContract})`, async () => {
    const { result, calls } = await prepare('vendor_metric_accountability', { supported: true, [absentContract]: true });
    assert.equal(result.failed_count, 0, JSON.stringify(result.phases));
    assert.ok(result.coverage_gaps?.some(gap => gap.reason === 'fixture_unsatisfied'));
    assert.equal(featureSeeds(calls).length, 0);
  });
}

test('structured root account defaults retain their JSON object type in request substitution', async () => {
  const { result, calls } = await prepare('measurement_accountability', { supported: true, structuredAccountReference: true });
  assert.equal(result.overall_passed, true, JSON.stringify(result.phases));
  assert.equal(typeof featureSeeds(calls)[0].request.account, 'object');
});

for (const scope of ['measurement_accountability', 'vendor_metric_accountability']) {
  test(`${scope}: missing pricing seed advertisement is gated before any mutation`, async () => {
    const { result, calls } = await prepare(scope, { supported: true, seedScenarios: ['seed_account', 'seed_product'] });
    assert.equal(result.failed_count, 0);
    assert.ok(result.skipped_count > 0);
    assert.equal(calls.length, 0);
  });

  for (const satisfiesFilter of [false, true]) {
    test(`${scope}: discovery ${satisfiesFilter ? 'accepts' : 'rejects'} a selected product ${satisfiesFilter ? 'meeting' : 'missing'} its required metric filter`, async () => {
      const storyboard = parseStoryboard(fs.readFileSync(path.join(SCENARIOS, `${scope}.yaml`), 'utf8'));
      const step = storyboard.phases.flatMap(phase => phase.steps).find(step => step.task === 'get_products');
      const product = nativeProduct(scope, true);
      if (scope === 'measurement_accountability' && !satisfiesFilter) product.reporting_capabilities.available_metrics = ['impressions', 'spend'];
      if (scope === 'vendor_metric_accountability' && !satisfiesFilter) product.reporting_capabilities.vendor_metrics.forEach(metric => { metric.vendor.domain = 'another-vendor.example'; });
      const result = await runStoryboard('https://seller.example/mcp', {
        ...storyboard,
        prerequisites: undefined,
        fixtures: undefined,
        fixture_resolution: undefined,
        phases: [{ id: 'required_metric_filter', title: 'Required metric discovery', steps: [step] }],
      }, {
        protocol: 'mcp',
        agentTools: TOOLS,
        _profile: { tools: TOOLS, raw_capabilities: {
          media_buy: { buying_modes: ['brief', 'wholesale'], features: { committed_metrics_supported: true } },
          compliance_testing: { scenarios: ['seed_account', 'seed_product', 'seed_pricing_option'] },
        } },
        _client: {
          resetContext() {},
          async getProducts(request) {
            return { success: true, data: { status: 'completed', products: [product], cache_scope: 'account', context: request.context } };
          },
        },
      });
      if (satisfiesFilter) {
        assert.equal(result.overall_passed, true, JSON.stringify(result.phases));
        assert.equal(result.failed_count, 0);
        assert.equal(result.skipped_count, 0);
      } else {
        assert.ok(result.failed_count > 0, JSON.stringify(result.phases));
        assert.ok(result.phases.flatMap(phase => phase.steps).flatMap(step => step.validations).some(validation => validation.check === 'field_contains' && !validation.passed));
      }
    });
  }
}
