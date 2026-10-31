'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const YAML = require('yaml');
const { runStoryboard } = require('@adcp/sdk/testing');

const source = path.join(__dirname, '..', 'static', 'compliance', 'source',
  'protocols', 'media-buy', 'scenarios', 'product_filter_behavior.yaml');

async function runFilters({ buyingModes, nativeGuaranteed = false, ignoreDeliveryIn, injectGuaranteedSeed = false } = {}) {
  const storyboard = YAML.parse(fs.readFileSync(source, 'utf8'));
  for (const phase of storyboard.phases) {
    for (const step of phase.steps) {
      // Keep real seeding, request building, gates, context capture and field
      // checks. These transport stubs omit unrelated required product fields;
      // response-schema validation is covered by the schema and matrix suites.
      step.validations = step.validations.filter(validation => validation.check !== 'response_schema');
    }
  }
  if (injectGuaranteedSeed) storyboard.fixtures.products.push({
    product_id: 'unsupported-guaranteed-seed', delivery_type: 'guaranteed', channels: ['olv'],
  });
  const catalog = new Map();
  if (nativeGuaranteed) catalog.set('native-guaranteed-olv', {
    product_id: 'native-guaranteed-olv', delivery_type: 'guaranteed', channels: ['olv'],
    pricing_options: [{ pricing_option_id: 'native-guaranteed-cpm', pricing_model: 'cpm', currency: 'USD', fixed_price: 15 }],
  });
  const seeds = [];
  const requests = [];
  const responses = [];
  const tools = ['get_adcp_capabilities', 'get_products', 'comply_test_controller'];
  const client = {
    resetContext() {},
    async executeTask(task, request) {
      if (task === 'get_products') return this.getProducts(request);
      assert.equal(task, 'comply_test_controller');
      if (request.scenario === 'list_scenarios') return { success: true, data: {
        success: true, scenarios: ['seed_account', 'seed_product', 'seed_pricing_option'], context: request.context,
      } };
      seeds.push(structuredClone(request));
      const { fixture, product_id } = request.params;
      if (request.scenario === 'seed_account') return { success: true, data: { success: true, context: request.context } };
      if (request.scenario === 'seed_product') {
        // Auction-only production support does not confer guaranteed seeding.
        // The negative-control test reinstates the old incompatible fixture.
        if (fixture.delivery_type === 'guaranteed') return { success: true, data: {
          success: false, error: 'INVALID_PARAMS', error_detail: 'Guaranteed product seeding is unsupported',
        } };
        catalog.set(product_id, { product_id, ...structuredClone(fixture), pricing_options: [] });
      } else {
        assert.equal(request.scenario, 'seed_pricing_option');
        assert.equal(fixture.fixed_price, undefined, 'generic filter checks must not seed fixed pricing');
        assert.ok(fixture.floor_price > 0, 'auction fixture has a real floor');
        catalog.get(product_id).pricing_options.push({ ...structuredClone(fixture), pricing_option_id: request.params.pricing_option_id });
      }
      return { success: true, data: { success: true, context: request.context } };
    },
    async getProducts(request) {
      requests.push(structuredClone(request));
      if (request.buying_mode !== 'brief') assert.ok(buyingModes?.includes(request.buying_mode));
      const products = [...catalog.values()].filter(product => {
        if (request.buying_mode === 'refine' && product.product_id !== request.refine[0].product_id) return false;
        if (request.filters.channels && !request.filters.channels.some(channel => product.channels.includes(channel))) return false;
        if (request.buying_mode !== ignoreDeliveryIn && request.filters.delivery_type !== product.delivery_type) return false;
        return true;
      });
      const data = { products, context: request.context };
      responses.push(structuredClone(data));
      return { success: true, data };
    },
  };
  const result = await runStoryboard('https://auction-seller.example/mcp', storyboard, {
    protocol: 'mcp',
    agentTools: tools,
    _profile: { tools, raw_capabilities: { media_buy: buyingModes ? { buying_modes: buyingModes } : {} } },
    _controllerCapabilities: { detected: true, scenarios: ['seed_account', 'seed_product', 'seed_pricing_option'] },
    _client: client,
  });
  return { result, seeds, requests, responses };
}

function failures(result) {
  return result.phases.flatMap(phase => phase.steps).filter(step => !step.passed && !step.skipped);
}

test('auction-only sellers seed no guaranteed products and pass every advertised buying mode', async t => {
  for (const buyingModes of [undefined, ['brief'], ['brief', 'wholesale'], ['brief', 'refine'], ['brief', 'wholesale', 'refine']]) {
    await t.test(buyingModes?.join(', ') ?? 'default brief', async () => {
      const { result, seeds, requests, responses } = await runFilters({ buyingModes });
      assert.equal(result.overall_passed, true, JSON.stringify(failures(result)));
      assert.equal(result.failed_count, 0);
      const productSeeds = seeds.filter(seed => seed.scenario === 'seed_product');
      assert.equal(productSeeds.length, 2);
      assert.ok(productSeeds.every(seed => seed.params.fixture.delivery_type === 'non_guaranteed'));
      assert.equal(seeds.filter(seed => seed.scenario === 'seed_pricing_option').length, 2);
      const negativeIndices = requests.flatMap((request, i) => request.buying_mode !== 'refine' && request.filters.delivery_type === 'guaranteed' ? [i] : []);
      assert.equal(negativeIndices.length, buyingModes?.includes('wholesale') ? 2 : 1);
      for (const i of negativeIndices) assert.deepEqual(responses[i].products, []);
      const refine = requests.find(request => request.buying_mode === 'refine');
      if (refine) assert.equal(refine.refine[0].product_id, 'filter_behavior_matching_olv');
    });
  }
});

test('native guaranteed products satisfy negative-delivery probes without being seeded', async () => {
  const { result, seeds, requests, responses } = await runFilters({
    buyingModes: ['brief', 'wholesale', 'refine'], nativeGuaranteed: true,
  });
  assert.equal(result.overall_passed, true, JSON.stringify(failures(result)));
  assert.ok(seeds.every(seed => seed.params.product_id !== 'native-guaranteed-olv'));
  for (let i = 0; i < requests.length; i++) {
    if (requests[i].buying_mode !== 'refine' && requests[i].filters.delivery_type === 'guaranteed') {
      assert.equal(responses[i].products[0].product_id, 'native-guaranteed-olv');
    }
  }
});

test('ignoring delivery in brief or wholesale leaks an actual auction fixture and fails', async t => {
  for (const ignoreDeliveryIn of ['brief', 'wholesale']) {
    await t.test(ignoreDeliveryIn, async () => {
      const { result, requests, responses } = await runFilters({ buyingModes: ['brief', 'wholesale', 'refine'], ignoreDeliveryIn });
      assert.equal(result.overall_passed, false);
      const failed = failures(result);
      assert.ok(failed.some(step => step.validations.some(validation => validation.check === 'all_fields_in_context_array' && !validation.passed)));
      const i = requests.findIndex(request => request.buying_mode === ignoreDeliveryIn && request.filters.delivery_type === 'guaranteed');
      assert.ok(i >= 0, 'negative-delivery request executed');
      assert.ok(responses[i].products.some(product => product.product_id === 'filter_behavior_matching_olv'));
    });
  }
});

test('a rejected guaranteed seed remains a setup failure rather than a false capability skip', async () => {
  const { result, seeds, requests } = await runFilters({ injectGuaranteedSeed: true });
  assert.equal(result.overall_passed, false);
  assert.ok(seeds.some(seed => seed.params.fixture?.delivery_type === 'guaranteed'));
  assert.ok(failures(result).some(step => step.phase_id === '__controller_seeding__'));
  assert.equal(requests.length, 0, 'dependent reads do not run after the rejected seed');
});
