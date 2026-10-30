'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const YAML = require('yaml');
const { loadStoryboardFile, runStoryboard } = require('@adcp/sdk/testing');

const SCENARIO = path.join(__dirname, '..', 'static', 'compliance', 'source', 'protocols', 'media-buy', 'scenarios', 'pricing_currency_filter.yaml');
const TOOLS = ['get_products', 'comply_test_controller'];
const SEED_SCENARIOS = ['seed_account', 'seed_product', 'seed_pricing_option'];

function scenario() {
  const storyboard = loadStoryboardFile(SCENARIO);
  // Baseline and scope checks isolate seller pricing and controller setup.
  // Collected final reads always validate every physical response schema.
  for (const phase of storyboard.phases) {
    for (const step of phase.steps) {
      step.validations = step.validations.filter(validation => validation.check !== 'response_schema');
    }
  }
  return storyboard;
}

function seller({ accountCurrency, convertMandatory = false, reorder = false, duplicatePrice = false, paginate = false, defect } = {}) {
  const calls = [];
  const products = new Map();
  const client = {
    resetContext() {},
    async executeTask(task, request) {
      calls.push({ task, request: structuredClone(request) });
      if (task === 'comply_test_controller') {
        if (request.scenario === 'seed_product') {
          products.set(request.params.product_id, {
            product_id: request.params.product_id,
            name: 'Currency filter display inventory',
            description: 'Account-scoped auction inventory for currency filtering.',
            publisher_properties: [{ publisher_domain: 'outdoormagazine.example', selection_type: 'all' }],
            reporting_capabilities: {
              available_reporting_frequencies: ['daily'], expected_delay_minutes: 60,
              timezone: 'UTC', supports_webhooks: false, available_metrics: ['impressions', 'spend'],
              date_range_support: 'date_range',
            },
            ...structuredClone(request.params.fixture),
            pricing_options: [],
          });
        }
        if (request.scenario === 'seed_pricing_option') {
          const price = { pricing_option_id: request.params.pricing_option_id, ...request.params.fixture };
          assert.equal(price.fixed_price, undefined, 'currency filtering does not require fixed-rate support');
          assert.ok(price.floor_price > 0, 'the controller receives auction CPM floors');
          products.get(request.params.product_id).pricing_options.push(price);
        }
        return { success: true, data: {
          success: true,
          scenario: request.scenario,
          ...(request.scenario === 'list_scenarios' ? { scenarios: SEED_SCENARIOS } : {}),
          context: request.context,
        } };
      }
      assert.equal(task, 'get_products');
      assert.equal(request.fields, undefined, 'currency checks request full products for physical schema validation');
      let catalog = structuredClone([...products.values()]);
      for (const product of catalog) {
        // Sellers may normalize fixture rates into the account's currency and
        // issue new IDs. Neither operation changes pricing-filter semantics.
        product.pricing_options = product.pricing_options.map(price => ({
          ...price,
          pricing_option_id: `effective-${price.pricing_option_id}`,
          ...(accountCurrency ? { currency: accountCurrency } : {}),
        }));
        if (duplicatePrice) product.pricing_options.push({
          ...product.pricing_options[0], pricing_option_id: `${product.product_id}-second-matching-rate`,
        });
        if (convertMandatory && product.signal_targeting_rules?.selection_mode === 'fixed') {
          for (const signal of product.signal_targeting_options) {
            for (const price of signal.pricing_options) price.currency = accountCurrency;
          }
        }
      }
      const requested = request.filters?.pricing_currencies;
      if (requested) {
        // The fixed EUR signal remains a genuine exclusion for a seller that
        // cannot convert it. An EUR account can transact both seeded products.
        catalog = catalog.filter(product => product.signal_targeting_rules?.selection_mode !== 'fixed'
          || product.signal_targeting_options.every(signal => signal.pricing_options.some(price => requested.includes(price.currency))));
        for (const product of catalog) {
          product.pricing_options = product.pricing_options.filter(price => requested.includes(price.currency));
        }
        catalog = catalog.filter(product => product.pricing_options.length > 0);
      }
      if (reorder) catalog.reverse();
      const filteredReads = calls.filter(call => call.task === 'get_products' && call.request.filters).length;
      if (defect === 'empty_baseline' && !requested) catalog = [];
      if (defect === 'empty_filtered' && requested) catalog = [];
      if (filteredReads >= 2) {
        if (defect === 'later_option') catalog[0].pricing_options.push({
          pricing_option_id: 'leaked-eur-option', pricing_model: 'cpm', floor_price: 5, currency: 'EUR',
        });
        if (defect === 'later_product') catalog.push({
          ...structuredClone(catalog[0]),
          product_id: 'leaked-eur-product',
          pricing_options: [{ pricing_option_id: 'eur-only', pricing_model: 'cpm', floor_price: 5, currency: 'EUR' }],
        });
        if (defect === 'missing_price') catalog.push({ product_id: 'no-selectable-price', pricing_options: [] });
      }
      const context = structuredClone(request.context);
      if (defect === 'widened_context' && context?.accepted_pricing_currencies) context.accepted_pricing_currencies.push('EUR');
      const offset = Number(request.pagination?.cursor ?? 0);
      const page = paginate && filteredReads >= 2 ? catalog.slice(offset, offset + 1) : catalog;
      const hasMore = paginate && filteredReads >= 2 && offset + 1 < catalog.length;
      return { success: true, data: {
        status: 'completed', products: page, context,
        cache_scope: 'account', wholesale_feed_version: 'currency-test-v1',
        ...(paginate && filteredReads >= 2 ? { pagination: { has_more: hasMore, ...(hasMore ? { cursor: String(offset + 1) } : {}) } } : {}),
      } };
    },
    async getProducts(request) {
      return this.executeTask('get_products', request);
    },
  };
  return { client, calls };
}

async function run(options = {}, buyingModes = ['wholesale']) {
  const { client, calls } = seller(options);
  const result = await runStoryboard('https://seller.example/mcp', scenario(), {
    protocol: 'mcp',
    agentTools: TOOLS,
    _profile: { tools: TOOLS, raw_capabilities: { media_buy: buyingModes === null ? {} : { buying_modes: buyingModes } } },
    _controllerCapabilities: { detected: true, scenarios: SEED_SCENARIOS },
    _client: client,
  });
  return { result, calls, reads: calls.filter(call => call.task === 'get_products') };
}

function failedChecks(result) {
  return result.phases.flatMap(phase => phase.steps).flatMap(step => step.validations).filter(validation => !validation.passed);
}

for (const options of [
  {},
  { reorder: true, duplicatePrice: true },
  { accountCurrency: 'EUR', reorder: true, duplicatePrice: true },
  { accountCurrency: 'USD', convertMandatory: true, reorder: true, duplicatePrice: true },
]) {
  test(`currency filtering follows effective seller pricing ${JSON.stringify(options)}`, async () => {
    const { result, calls, reads } = await run(options);
    assert.equal(result.overall_passed, true, JSON.stringify(failedChecks(result)));
    assert.equal(result.failed_count, 0);
    assert.equal(result.skipped_count, 0);
    assert.equal(reads.length, 3, 'baseline, scope capture, and complete filtered read are all graded');
    assert.equal(calls.filter(call => call.task === 'comply_test_controller' && call.request.scenario.startsWith('seed_')).length, 6);
    const currency = options.accountCurrency ?? 'USD';
    for (const { request } of reads.slice(1)) assert.deepEqual(request.filters.pricing_currencies, [currency]);
    const completeRead = result.phases.flatMap(phase => phase.steps).find(step => step.step_id === 'get_products_usd_pricing');
    assert.ok(completeRead.validations.some(validation => validation.check === 'all_fields_in_context_array' && validation.passed));
    if (options.accountCurrency === 'EUR' || options.convertMandatory) {
      assert.equal(completeRead.response.products.length, 2, 'conversion permits both products despite the original mandatory EUR exclusion');
      assert.ok(completeRead.response.products.some(product => product.pricing_options.length > 1), 'multiple same-currency options remain legal');
    } else {
      assert.equal(completeRead.response.products.length, 1, 'an unconverted mandatory EUR charge excludes its product from USD discovery');
      assert.equal(completeRead.response.products[0].signal_targeting_options[0].pricing_options[0].currency, 'EUR', 'optional foreign-currency add-ons are retained');
    }
  });
}

for (const defect of ['later_option', 'later_product', 'missing_price', 'empty_baseline', 'widened_context']) {
  test(`currency filtering rejects ${defect}`, async () => {
    const { result } = await run({ defect });
    assert.equal(result.overall_passed, false, `the ${defect} defect must not grade as a pass`);
    assert.ok(result.failed_count > 0);
    if (defect === 'later_option' || defect === 'later_product') {
      assert.ok(failedChecks(result).some(validation => validation.check === 'all_fields_in_context_array'), JSON.stringify(failedChecks(result)));
    }
  });
}

for (const buyingModes of [null, [], ['brief']]) {
  test(`unsupported wholesale discovery skips before seeding (${JSON.stringify(buyingModes)})`, async () => {
    const { result, calls } = await run({}, buyingModes);
    assert.equal(result.failed_count, 0);
    assert.ok(result.skipped_count > 0);
    assert.deepEqual(calls, [], 'inapplicable buying modes do not seed fixtures or call discovery');
  });
}

test('currency filter fixture retains distinct media and signal currency controls', () => {
  const doc = YAML.parse(fs.readFileSync(SCENARIO, 'utf8'));
  assert.deepEqual([...new Set(doc.fixtures.pricing_options.map(price => price.currency))].sort(), ['EUR', 'USD']);
  assert.deepEqual(doc.fixtures.products.map(product => product.signal_targeting_rules.selection_mode).sort(), ['fixed', 'optional']);
});

// A media rate alone is not a witness that all compulsory charges are buyable.
test('valid empty currency results do not invent positive-price coverage', async () => {
  const { result } = await run({ defect: 'empty_filtered' });
  assert.equal(result.overall_passed, true, JSON.stringify(failedChecks(result)));
  assert.equal(result.failed_count, 0);
  const final = result.phases.flatMap(phase => phase.steps).find(step => step.step_id === 'get_products_usd_pricing');
  assert.deepEqual(final.response.products, []);
  assert.ok(final.validations.some(validation => validation.check === 'all_fields_present' && validation.not_applicable === true));
});

test('currency filtering validates matching prices across all catalog pages', async () => {
  const { result } = await run({ accountCurrency: 'EUR', paginate: true });
  assert.equal(result.overall_passed, true, JSON.stringify(failedChecks(result)));
  const final = result.phases.flatMap(phase => phase.steps).find(step => step.step_id === 'get_products_usd_pricing');
  assert.equal(final.product_page_collection.complete, true);
  assert.equal(final.product_page_collection.page_count, 2);
  assert.equal(final.response.products.length, 1);
  assert.equal(final.product_page_collection.logical_response.products.length, 2);
});

test('currency filtering rejects an incompatible price on a later catalog page', async () => {
  const { result } = await run({ paginate: true, defect: 'later_product' });
  assert.equal(result.overall_passed, false);
  const final = result.phases.flatMap(phase => phase.steps).find(step => step.step_id === 'get_products_usd_pricing');
  assert.equal(final.product_page_collection.complete, true);
  assert.equal(final.product_page_collection.page_count, 2);
  assert.ok(final.response.products.every(product => product.pricing_options.every(price => price.currency === 'USD')),
    'the actual first page alone would hide the filter violation');
  assert.ok(failedChecks(result).some(validation => validation.check === 'all_fields_in_context_array'
    && validation.json_pointer.startsWith('/product_page_collection/logical_response/')),
  JSON.stringify(failedChecks(result)));
});
