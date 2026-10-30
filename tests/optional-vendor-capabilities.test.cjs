'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { parseStoryboard, runStoryboard } = require('@adcp-protocol/fixture-test-sdk/testing');
const { SCENARIOS, TOOLS, nativeProduct, prepare, featureSeeds } = require('./helpers/optional-seller-capability-fixtures.cjs');

for (const scope of ['vendor_metric_accountability']) {
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

for (const absentContract of ['differentVendor', 'differentBrandId']) {
  test(`vendor accountability requires the actual vendor and measurement contract (${absentContract})`, async () => {
    const { result, calls } = await prepare('vendor_metric_accountability', { supported: true, [absentContract]: true });
    assert.equal(result.failed_count, 0, JSON.stringify(result.phases));
    assert.ok(result.coverage_gaps?.some(gap => gap.reason === 'fixture_unsatisfied'));
    assert.equal(featureSeeds(calls).length, 0);
  });
}

for (const scope of ['vendor_metric_accountability']) {
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
          media_buy: { buying_modes: ['brief', 'wholesale'], features: { committed_metrics_supported: true, canonical_creatives: true } },
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
