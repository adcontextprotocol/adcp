'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { nativeProduct, prepare, featureSeeds } = require('./helpers/optional-seller-capability-fixtures.cjs');

for (const scope of ['canonical_formats']) {
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
