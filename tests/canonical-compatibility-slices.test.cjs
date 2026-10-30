'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { parseStoryboard, runStoryboard } = require('@adcp/sdk/testing');

const directory = path.join(__dirname, '..', 'static', 'compliance', 'source', 'protocols', 'media-buy', 'scenarios');
const load = name => parseStoryboard(fs.readFileSync(path.join(directory, `${name}.yaml`), 'utf8'));
const featureSeed = name => load(name).phases[0].steps[0].sample_request.params.fixture;

async function runSlice(name, { shapes = ['image'], named = true, differentCustomSchema = false, discoveryFailure = false, seedFailure = false, paginate = false } = {}) {
  const storyboard = load(name);
  // Price/creative purchase construction has separate coverage. This exercises
  // the actual applicability, native catalog resolution, controller seeding,
  // and discovery assertions, including their response schemas.
  storyboard.phases = storyboard.phases.filter(phase => phase.id !== 'canonical_create_satisfaction');
  for (const phase of storyboard.phases) for (const step of phase.steps) {
    // Authentication is a separate transport concern for this in-process seller.
    // The source test below preserves the test-kit principal/provisioning flow.
    delete step.auth;
    if (step.task === 'sync_accounts') step.validations = step.validations.filter(check => check.check !== 'response_schema');
  }
  const native = { product_id: 'native-format-product', ...structuredClone(featureSeed('canonical_formats')) };
  native.format_options = [];
  if (shapes.includes('image')) native.format_options.push(...structuredClone(featureSeed('canonical_formats').format_options));
  if (shapes.includes('custom')) native.format_options.push(...structuredClone(featureSeed('canonical_custom_formats').format_options));
  if (shapes.includes('experimental')) native.format_options.push(...structuredClone(featureSeed('canonical_experimental_formats').format_options));
  if (differentCustomSchema) {
    const custom = native.format_options.find(option => option.format_kind === 'custom');
    custom.format_schema.digest = `sha256:${'a'.repeat(64)}`;
  }
  if (!named) delete native.format_ids;
  if (native.format_options.length === 0) delete native.format_options;
  const products = new Map([[native.product_id, native]]);
  const calls = [];
  const tools = ['get_adcp_capabilities', 'get_products', 'sync_accounts', 'comply_test_controller'];
  const client = {
    resetContext() {},
    async getProducts(request) {
      calls.push({ task: 'get_products', request: structuredClone(request) });
      if (request.filters === undefined && discoveryFailure) throw new Error('Native catalog is unavailable');
      const catalog = [...products.values()];
      const offset = Number(request.pagination?.cursor ?? 0);
      const page = paginate ? catalog.slice(offset, offset + 1) : catalog;
      const hasMore = paginate && offset + 1 < catalog.length;
      return { success: true, data: {
        status: 'completed', products: page, cache_scope: 'account', wholesale_feed_version: 'native-formats-v1',
        ...(paginate ? { pagination: { has_more: hasMore, ...(hasMore ? { cursor: String(offset + 1) } : {}) } } : {}),
        ...(page.some(product => product.product_id === 'canonical_formats_divergent_display') ? {
          errors: [{ code: 'FORMAT_DECLARATION_DIVERGENT', source: 'producer', message: 'The seeded format projections diverge' }],
        } : {}),
        context: request.context,
      } };
    },
    async syncAccounts(request) {
      calls.push({ task: 'sync_accounts', request: structuredClone(request) });
      return { success: true, data: { accounts: [{ account_id: storyboard.fixtures.accounts[0].account_id }], context: request.context } };
    },
    async executeTask(task, request) {
      if (task === 'get_products') return this.getProducts(request);
      if (task === 'sync_accounts') return this.syncAccounts(request);
      assert.equal(task, 'comply_test_controller');
      calls.push({ task, request: structuredClone(request) });
      if (request.scenario === 'seed_product') {
        assert.ok(calls.some(call => call.task === 'get_products'), 'native support precedes synthetic product seeding');
        assert.deepEqual(request.account, storyboard.context.account, 'each manual seed uses the full isolated account identity');
        if (seedFailure) return { success: true, data: { success: false, error: 'Supported fixture deliberately rejected' } };
        products.set(request.params.product_id, { product_id: request.params.product_id, ...structuredClone(request.params.fixture) });
      } else assert.equal(request.scenario, 'seed_account');
      return { success: true, data: { success: true, context: request.context } };
    },
  };
  const result = await runStoryboard('https://seller.example/mcp', storyboard, {
    protocol: 'mcp', agentTools: tools,
    _profile: { tools, raw_capabilities: {
      supported_protocols: ['media_buy'], media_buy: { buying_modes: ['brief', 'wholesale'] },
      compliance_testing: { scenarios: ['seed_account', 'seed_product'] },
    } },
    _controllerCapabilities: { detected: true, scenarios: ['seed_account', 'seed_product'] },
    _client: client,
  });
  return { result, calls };
}

const seeds = calls => calls.filter(call => call.request.scenario === 'seed_product');
const failures = result => result.phases.flatMap(phase => phase.steps).filter(step => !step.passed && !step.skipped);

test('image and named-format compatibility runs without custom or experimental declarations', async () => {
  const { result, calls } = await runSlice('canonical_formats');
  assert.equal(result.overall_passed, true, JSON.stringify(failures(result)));
  assert.equal(result.failed_count, 0);
  assert.equal(result.skipped_count, 0);
  assert.equal(seeds(calls).length, 4);
  assert.ok(seeds(calls).every(call => call.request.params.fixture.format_options?.every(option => option.format_kind !== 'custom' && !option.experimental) ?? true));
});

test('canonical compatibility finds later-page products and their producer advisories', async () => {
  const { result, calls } = await runSlice('canonical_formats', { paginate: true });
  assert.equal(result.overall_passed, true, JSON.stringify(failures(result)));
  assert.equal(result.failed_count, 0);
  assert.equal(result.skipped_count, 0);
  assert.equal(seeds(calls).length, 4);
  const reads = result.phases.filter(phase => phase.phase_id === 'canonical_product_discovery')
    .flatMap(phase => phase.steps).filter(step => step.task === 'get_products');
  assert.equal(reads.length, 4, 'all four compatibility reads collect the full catalog');
  for (const read of reads) {
    assert.equal(read.product_page_collection.complete, true);
    assert.ok(read.product_page_collection.page_count > 1);
    assert.equal(read.response.products.length, 1, 'the observed response is one physical page');
    assert.equal(read.product_page_collection.logical_response.products.length, 5);
    assert.equal(read.response.errors, undefined, 'the first physical page has no divergent-format advisory');
  }
  const divergent = reads.find(step => step.step_id === 'get_seeded_divergent_product');
  assert.ok(divergent.validations.some(validation => validation.check === 'field_contains'
    && validation.path === 'errors[*]' && validation.passed));
});

for (const [name, shape] of [['canonical_custom_formats', 'custom'], ['canonical_experimental_formats', 'experimental']]) {
  test(`${name}: absence produces an independent coverage gap before feature seeding`, async () => {
    const { result, calls } = await runSlice(name);
    assert.equal(result.failed_count, 0, JSON.stringify(failures(result)));
    assert.ok(result.skipped_count > 0);
    assert.ok(result.coverage_gaps?.some(gap => gap.reason === 'fixture_unsatisfied'));
    assert.equal(seeds(calls).length, 0);
  });

  test(`${name}: matching support runs its declaration without named-format support`, async () => {
    const { result, calls } = await runSlice(name, { shapes: [shape], named: false });
    assert.equal(result.overall_passed, true, JSON.stringify(failures(result)));
    assert.equal(result.failed_count, 0);
    assert.equal(result.skipped_count, 0);
    assert.equal(seeds(calls).length, 1);
  });

  test(`${name}: discovery and accepted seed failures stay visible`, async t => {
    for (const failure of ['discoveryFailure', 'seedFailure']) await t.test(failure, async () => {
      const { result, calls } = await runSlice(name, { shapes: [shape], named: false, [failure]: true });
      assert.equal(result.overall_passed, false);
      assert.ok(result.failed_count > 0, JSON.stringify(result.phases));
      if (failure === 'discoveryFailure') assert.equal(seeds(calls).length, 0);
      else assert.equal(seeds(calls).length, 1);
    });
  });
}

test('a different custom schema does not imply support for the fixture custom contract', async () => {
  const { result, calls } = await runSlice('canonical_custom_formats', { shapes: ['custom'], named: false, differentCustomSchema: true });
  assert.equal(result.failed_count, 0);
  assert.ok(result.coverage_gaps?.some(gap => gap.reason === 'fixture_unsatisfied'));
  assert.equal(seeds(calls).length, 0);
});

test('base divergent compatibility keeps its test-kit authentication and account-provisioning flow', () => {
  const steps = load('canonical_formats').phases.flatMap(phase => phase.steps);
  const provision = steps.find(step => step.id === 'provision_test_kit_account');
  const divergence = steps.find(step => step.id === 'get_seeded_divergent_product');
  assert.deepEqual(provision.auth, { type: 'api_key', from_test_kit: true });
  assert.deepEqual(divergence.auth, provision.auth);
  assert.ok(steps.indexOf(provision) < steps.indexOf(divergence));
});


test('collected discovery reads omit idempotency keys on every continuation scope', () => {
  let collected = 0;
  for (const name of ['canonical_formats', 'canonical_custom_formats', 'canonical_experimental_formats', 'pricing_currency_filter']) {
    for (const phase of load(name).phases) for (const step of phase.steps) {
      if (!step.collect_product_pages) continue;
      collected++;
      assert.equal(step.sample_request.idempotency_key, undefined, `${name}/${step.id} must issue fresh page reads`);
    }
  }
  assert.equal(collected, 8);
});
