// Decision evidence for #8254, not a replacement for the published storyboards.
// These probes exercise the installed SDK's existing fixture-resolution contract.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runStoryboard } = require('@adcp/sdk/testing');

const equals = (path, value) => ({ path, operator: 'equals', value });
const contains = (path, value) => ({ path, operator: 'contains_all', value });
const features = {
  collection_selection: {
    declaration: {
      collections: [{ publisher_domain: 'channel-owner.example', collection_ids: ['news', 'music'] }],
      collection_targeting_allowed: true,
    },
    match: [equals('/collection_targeting_allowed', true)],
  },
  format_breakdown: {
    declaration: { reporting_capabilities: { supports_format_breakdown: true } },
    match: [equals('/reporting_capabilities/supports_format_breakdown', true)],
  },
  time_based_views: {
    declaration: { reporting_capabilities: { available_metrics: ['impressions', 'spend', 'time_based_views'] } },
    match: [contains('/reporting_capabilities/available_metrics', ['time_based_views'])],
  },
};

function product(id, declaration = {}) {
  return {
    product_id: id,
    name: 'Sandbox catalog offer',
    description: 'Seller-owned product used by applicability contract probes.',
    publisher_properties: [{ publisher_domain: 'publisher.example', selection_type: 'all' }],
    channels: ['ctv'],
    delivery_type: 'non_guaranteed',
    format_options: [{ format_option_id: 'video', format_kind: 'video_hosted', params: { duration_ms_exact: 30000 } }],
    pricing_options: [{ pricing_option_id: 'seller-cpm', pricing_model: 'cpm', currency: 'USD', fixed_price: 10 }],
    ...declaration,
    reporting_capabilities: {
      available_reporting_frequencies: ['daily'], expected_delay_minutes: 0, timezone: 'UTC',
      supports_webhooks: false, available_metrics: ['impressions', 'spend'], date_range_support: 'date_range',
      ...declaration.reporting_capabilities,
    },
  };
}

// Keep the feature predicates independent. A combined AND gate cannot exercise
// a seller offering just format breakdown or just time-based views.
function storyboard(feature, strategies = ['discover']) {
  return {
    id: `decision_evidence/${feature}`,
    version: '1.0.0', title: 'Optional product feature contract probe', category: 'media_buy_seller',
    summary: 'Exercise a selected product without treating fixture acceptance as feature discovery.',
    narrative: 'Proposal evidence only; no applicability policy is adopted by these probes.',
    agent: { interaction_model: 'media_buy_seller', capabilities: ['sells_media'] },
    caller: { role: 'buyer_agent' },
    fixtures: { products: [product('authored-handle', features[feature].declaration)] },
    fixture_resolution: { products: [{ handle: 'authored-handle', strategies, match: features[feature].match }] },
    phases: [{ id: 'exercise_selected_product', title: 'Exercise the bound seller product', steps: [{
      id: 'exercise', title: 'Grade the selected feature path', task: 'create_media_buy', stateful: true,
      sample_request: {
        brand: { domain: 'acmeoutdoor.example' }, start_time: 'asap', end_time: '2099-06-30T23:59:59Z',
        packages: [{ product_id: 'authored-handle', pricing_option_id: 'seller-cpm', budget: 1000 }],
      },
      // An intentionally small sentinel assertion isolates runner disposition;
      // it does not claim to cover the collection/reporting semantics themselves.
      validations: [{ check: 'field_present', path: 'media_buy_id', description: 'The selected lifecycle must succeed' }],
    }] }],
  };
}

async function probe(feature, { catalog = [], strategies, discoveryFailure, broken = false } = {}) {
  const calls = [];
  const tools = ['get_products', 'create_media_buy', 'comply_test_controller'];
  const result = await runStoryboard('https://seller.example/mcp', storyboard(feature, strategies), {
    agentTools: tools,
    _profile: { tools, raw_capabilities: { media_buy: { buying_modes: ['brief', 'wholesale'] } } },
    _controllerCapabilities: { detected: true, scenarios: ['seed_product'] },
    _client: {
      resetContext() {},
      async getProducts(request) {
        calls.push({ task: 'get_products', request });
        if (discoveryFailure === 'transport') throw new Error('Discovery transport failed');
        if (discoveryFailure === 'protocol') return { success: false, error: 'Rejected discovery' };
        if (discoveryFailure === 'schema') return { success: true, data: { products: [{ product_id: 'malformed' }] } };
        if (discoveryFailure === 'pagination') return { success: true, data: {
          products: [], cache_scope: 'account', wholesale_feed_version: 'v1', pagination: { has_more: true },
        } };
        return { success: true, data: { products: catalog, cache_scope: 'account', wholesale_feed_version: 'v1', context: request.context } };
      },
      async executeTask(task, request) {
        calls.push({ task, request });
        assert.equal(task, 'comply_test_controller');
        assert.equal(request.scenario, 'seed_product');
        return { success: true, data: { success: true } };
      },
      async createMediaBuy(request) {
        calls.push({ task: 'create_media_buy', request });
        return broken === 'protocol'
          ? { success: false, error: 'Advertised feature implementation is broken' }
          : { success: true, data: {
            ...(broken !== 'validation' && { media_buy_id: 'seller-buy' }), context: request.context,
          } };
      },
    },
  });
  return { result, calls, steps: result.phases.flatMap(phase => phase.steps) };
}

for (const feature of Object.keys(features)) {
  test(`${feature}: a non-supporting catalog is a coverage gap without seed or buy calls`, async () => {
    for (const catalog of [[], [product('plain-product')]]) {
      const { result, calls } = await probe(feature, { catalog });
      assert.ok(result.coverage_gaps?.some(gap => gap.reason === 'fixture_unsatisfied'), JSON.stringify(result));
      assert.equal(result.fixture_resolutions[0].status, 'unsatisfied');
      assert.equal(result.failed_count, 0);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].task, 'get_products');
      assert.equal(calls[0].request.buying_mode, 'wholesale');
      assert.equal(calls[0].request.account.sandbox, true);
      assert.equal(calls[0].request.filters, undefined);
    }
  });

  test(`${feature}: a selected supporting product is bound and remains graded`, async () => {
    const catalog = [product('seller-owned-identity', features[feature].declaration)];
    for (const broken of [false, 'protocol', 'validation']) {
      const { result, calls, steps } = await probe(feature, { catalog, broken });
      const buy = calls.find(call => call.task === 'create_media_buy');
      assert.equal(buy?.request.packages[0].product_id, 'seller-owned-identity');
      assert.equal(result.fixture_resolutions[0].status, 'resolved');
      assert.deepEqual(result.fixture_resolutions[0].seller_ids, { product_id: 'seller-owned-identity' });
      assert.equal(calls.some(call => call.task === 'comply_test_controller'), false);
      const exercised = steps.find(step => step.step_id === 'exercise');
      assert.ok(exercised, JSON.stringify(result));
      assert.equal(exercised.skipped, undefined);
      assert.equal(exercised.passed, !broken, JSON.stringify(exercised));
      if (broken === 'validation') {
        assert.ok(exercised.validations.some(validation => validation.check === 'field_present' && !validation.passed), JSON.stringify(exercised));
      }
      assert.equal(result.overall_passed, !broken);
      assert.equal(result.coverage_gaps?.some(gap => gap.reason === 'fixture_unsatisfied') ?? false, false);
    }
  });
}

for (const discoveryFailure of ['transport', 'protocol', 'schema', 'pagination']) {
  test(`supported discovery ${discoveryFailure} failure stays failed without seed fallback`, async () => {
    const { result, calls, steps } = await probe('collection_selection', { discoveryFailure });
    assert.equal(result.overall_passed, false);
    assert.ok(steps.some(step => !step.passed && !step.skipped), JSON.stringify(result));
    assert.equal(result.coverage_gaps?.some(gap => gap.reason === 'fixture_unsatisfied') ?? false, false);
    assert.deepEqual(calls.map(call => call.task), ['get_products']);
  });
}

test('seed-first success bypasses discovery and cannot establish real feature support', async () => {
  const { result, calls } = await probe('collection_selection', {
    catalog: [product('plain-product')], strategies: ['seed', 'discover'],
  });
  assert.equal(result.overall_passed, true, JSON.stringify(result));
  assert.equal(calls.some(call => call.task === 'get_products'), false);
  assert.equal(calls.find(call => call.task === 'create_media_buy')?.request.packages[0].product_id, 'authored-handle');
  assert.equal(calls.find(call => call.task === 'comply_test_controller')?.request.params.fixture.collection_targeting_allowed, true);
});

test('all-or-nothing fixture graphs can hide a selected path when a companion is missing', async () => {
  const sb = storyboard('collection_selection');
  sb.fixtures.products.push(product('fixed-handle', {
    collections: features.collection_selection.declaration.collections, collection_targeting_allowed: false,
  }));
  sb.fixture_resolution.products.push({ handle: 'fixed-handle', strategies: ['discover'], match: [equals('/collection_targeting_allowed', false)] });
  const catalog = [product('selectable', features.collection_selection.declaration)];
  const result = await runStoryboard('https://seller.example/mcp', sb, {
    agentTools: ['get_products', 'create_media_buy'],
    _profile: { tools: ['get_products', 'create_media_buy'], raw_capabilities: {} },
    _client: {
      resetContext() {},
      async getProducts() { return { success: true, data: { products: catalog, cache_scope: 'account', wholesale_feed_version: 'v1' } }; },
      async createMediaBuy() { assert.fail('An unsatisfied companion fixture suppresses this otherwise applicable path'); },
    },
  });
  assert.ok(result.coverage_gaps?.some(gap => gap.reason === 'fixture_unsatisfied'), JSON.stringify(result));
});
