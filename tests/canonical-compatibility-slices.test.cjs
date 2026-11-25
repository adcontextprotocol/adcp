'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { parseStoryboard, runStoryboard } = require('@adcp/sdk/testing');

const directory = path.join(__dirname, '..', 'static', 'compliance', 'source', 'protocols', 'media-buy', 'scenarios');
const load = name => parseStoryboard(fs.readFileSync(path.join(directory, `${name}.yaml`), 'utf8'));
const featureSeed = name => load(name).phases[0].steps[0].sample_request.params.fixture;
const MANIFEST_ROUTING_PHASE = 'canonical_manifest_routing';
const PURCHASE_PHASES = new Set(['canonical_create_satisfaction', MANIFEST_ROUTING_PHASE]);
const MANIFEST_ROUTING_REJECT_STEP = 'reject_repeated_kind_manifest_without_ref';

async function runSlice(name, { shapes = ['image'], named = true, differentCustomSchema = false, discoveryFailure = false, seedFailure = false, paginate = false } = {}) {
  const storyboard = load(name);
  // Price/creative purchase construction has separate coverage. This exercises
  // the actual applicability, native catalog resolution, controller seeding,
  // and discovery assertions, including their response schemas.
  storyboard.phases = storyboard.phases.filter(phase => !PURCHASE_PHASES.has(phase.id));
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
  assert.equal(collected, 10);
});

async function runManifestRouting({ inlineCreatives = true, infersFromAssetFit = false, rejectsInlineCreatives = false } = {}) {
  const storyboard = load('canonical_formats');
  // Native catalog resolution is covered by runSlice; this isolates the
  // repeated-kind manifest routing phase against a seller that seeds for real.
  storyboard.fixture_resolution = undefined;
  storyboard.fixtures = { accounts: storyboard.fixtures.accounts };
  storyboard.phases = storyboard.phases.filter(phase => phase.id === MANIFEST_ROUTING_PHASE);
  for (const step of storyboard.phases[0].steps) {
    if (step.task === 'create_media_buy') step.validations = step.validations.filter(check => check.check !== 'response_schema');
  }
  const products = new Map();
  const calls = [];
  const tools = ['get_adcp_capabilities', 'get_products', 'create_media_buy', 'comply_test_controller'];
  const reject = (code, message, context) => ({ success: false, data: { errors: [{ code, message }], context } });
  const client = {
    resetContext() {},
    async executeTask(task, request) {
      calls.push({ task, request: structuredClone(request) });
      if (task === 'get_products') {
        return { success: true, data: {
          status: 'completed', products: [...products.values()], cache_scope: 'account',
          wholesale_feed_version: 'manifest-routing-v1', context: request.context,
        } };
      }
      if (task === 'comply_test_controller') {
        if (request.scenario === 'seed_product') products.set(request.params.product_id, { product_id: request.params.product_id, ...structuredClone(request.params.fixture) });
        return { success: true, data: { success: true, context: request.context } };
      }
      assert.equal(task, 'create_media_buy');
      const pkg = request.packages[0];
      const product = products.get(pkg.product_id);
      const floor = product.pricing_options.find(price => price.pricing_option_id === pkg.pricing_option_id).floor_price;
      if (!(pkg.bid_price >= floor)) return reject('INVALID_REQUEST', 'bid_price is required for auction pricing', request.context);
      if (rejectsInlineCreatives) return reject('VALIDATION_ERROR', 'inline creatives are not accepted', request.context);
      const creative = pkg.creatives[0];
      const sameKind = product.format_options.filter(option => option.format_kind === creative.format_kind);
      if (!creative.format_option_ref && sameKind.length > 1 && !infersFromAssetFit) {
        return reject('VALIDATION_ERROR', 'format_option_ref is required when declarations share the manifest format_kind', request.context);
      }
      return { success: true, data: {
        media_buy_id: `buy-${calls.length}`, confirmed_at: '2099-05-01T00:00:00Z',
        packages: request.packages.map((item, index) => ({ ...item, package_id: `pkg-${index}` })), context: request.context,
      } };
    },
  };
  const result = await runStoryboard('https://seller.example/mcp', storyboard, {
    protocol: 'mcp', agentTools: tools,
    _profile: { tools, raw_capabilities: {
      supported_protocols: ['media_buy'],
      media_buy: { buying_modes: ['wholesale'], features: { inline_creative_management: inlineCreatives } },
      compliance_testing: { scenarios: ['seed_account', 'seed_product'] },
    } },
    _controllerCapabilities: { detected: true, scenarios: ['seed_account', 'seed_product'] },
    _client: client,
  });
  const routingSteps = result.phases.filter(phase => phase.phase_id === MANIFEST_ROUTING_PHASE).flatMap(phase => phase.steps);
  return {
    result,
    routingSteps,
    seeds: calls.filter(call => call.request.scenario === 'seed_product'),
    creates: calls.filter(call => call.task === 'create_media_buy'),
  };
}

test('manifest routing rejects a missing format_option_ref on a repeated format_kind and accepts the named option', async () => {
  const { result, creates } = await runManifestRouting();
  assert.equal(result.overall_passed, true, JSON.stringify(failures(result)));
  assert.equal(result.failed_count, 0);
  assert.equal(result.skipped_count, 0);
  assert.equal(creates.length, 2);
  const [accepted, rejected] = creates.map(call => call.request.packages[0]);
  assert.deepEqual(accepted.creatives[0].format_option_ref, { scope: 'product', format_option_id: 'canonical_formats_repeated_image_mrec' });
  assert.equal(rejected.creatives[0].format_option_ref, undefined);
  assert.deepEqual(rejected.creatives[0].assets, accepted.creatives[0].assets, 'only the option reference differs');
  for (const pkg of [accepted, rejected]) {
    assert.ok(pkg.bid_price > 0, 'auction pricing is enriched so only the option reference is under test');
    assert.equal(pkg.format_option_refs ?? pkg.format_kind ?? pkg.format_ids, undefined, 'no package selector narrows the product');
  }
});

test('manifest routing fails a seller that infers the option from asset fit', async () => {
  const { result } = await runManifestRouting({ infersFromAssetFit: true });
  assert.equal(result.overall_passed, false);
  assert.deepEqual(failures(result).map(step => step.step_id), [MANIFEST_ROUTING_REJECT_STEP]);
});

test('manifest routing cannot pass a seller that rejects every inline creative', async () => {
  const { result, routingSteps } = await runManifestRouting({ rejectsInlineCreatives: true });
  assert.deepEqual(failures(result).map(step => step.step_id), ['create_media_buy_with_repeated_kind_manifest_ref']);
  const rejectStep = routingSteps.find(step => step.step_id === MANIFEST_ROUTING_REJECT_STEP);
  assert.equal(rejectStep.passed, false);
  assert.equal(rejectStep.skip_reason, 'prerequisite_failed', 'the accepted control gates the rejection probe');
});

test('manifest routing does not grade sellers without inline creative management', async () => {
  const { result, routingSteps, seeds, creates } = await runManifestRouting({ inlineCreatives: false });
  assert.equal(result.failed_count, 0, JSON.stringify(failures(result)));
  assert.ok(routingSteps.length > 0);
  assert.ok(routingSteps.every(step => step.skipped && step.skip_reason === 'not_applicable'), JSON.stringify(routingSteps));
  assert.equal(seeds.length, 0);
  assert.equal(creates.length, 0);
});
