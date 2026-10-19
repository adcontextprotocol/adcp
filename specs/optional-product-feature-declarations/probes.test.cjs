// Proposal evidence only: model decisions, real schemas, and shipping SDK hazards.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Ajv = require('ajv');
const { runStoryboard } = require('@adcp/sdk/testing');
const { features, validators, qualifies, evaluate } = require('./model.cjs');
let validate;
test.before(async () => { validate = await validators(); });

function product(feature, extra = {}) {
  const value = {
    product_id: 'seller-offer', name: 'Pinnacle sandbox offer', description: 'Native execution fixture, proposal evidence only.',
    publisher_properties: [{ publisher_domain: 'host.example', selection_type: 'all' }],
    channels: ['ctv'], delivery_type: 'non_guaranteed',
    format_options: [{ format_option_id: 'native-video', format_kind: 'video_hosted', params: { duration_ms_exact: 30000 } }],
    pricing_options: [{ pricing_option_id: 'native-cpm', pricing_model: 'cpm', currency: 'USD', fixed_price: 10 }],
    reporting_capabilities: { available_reporting_frequencies: ['daily'], expected_delay_minutes: 0,
      timezone: 'UTC', supports_webhooks: false, available_metrics: ['impressions', 'spend'], date_range_support: 'date_range' },
  };
  if (['collection_selection', 'fixed_collection_bundles', 'owner_sold_channel_carriage'].includes(feature)) {
    value.collections = [{ publisher_domain: 'owner.example', collection_ids: ['news', 'music'] }];
    if (feature === 'collection_selection') value.collection_targeting_allowed = true;
  }
  if (feature === 'format_breakdown') value.reporting_capabilities.supports_format_breakdown = true;
  if (feature === 'time_based_views') value.reporting_capabilities.available_metrics.push('time_based_views');
  return { ...value, ...extra };
}
const ownerEvidence = { product_id: 'seller-offer', kind: 'channel', owner_domain: 'owner.example', host_domain: 'host.example', collection_id: 'news' };
const capability = (feature, value) => ({ media_buy: { features: { [`supports_${feature}`]: value } } });
function setup(feature, options = {}) {
  const calls = [];
  return { calls, args: {
    feature, capabilities: capability(feature, true), validate, ownerEvidence,
    prepare: async params => { calls.push(params); return { success: true, simulated: { ...params, product: product(feature) } }; },
    ...options,
  } };
}

for (const feature of features) {
  test(`${feature}: absent and false preserve supporting catalog evidence; true also selects it`, async () => {
    for (const capabilities of [{}, { media_buy: {} }, { media_buy: { features: {} } }, capability(feature, false), capability(feature, true)]) {
      const { args, calls } = setup(feature, { capabilities, catalog: [product(feature)] });
      let selected;
      args.exercise = async p => { selected = p; return true; };
      const result = await evaluate(args);
      assert.equal(result.state, 'applicable'); assert.equal(result.route, 'catalog');
      assert.equal(selected.product_id, 'seller-offer'); assert.equal(calls.length, 0);
    }
  });
  test(`${feature}: unsupported/undeclared no-match never seeds a feature into existence`, async () => {
    for (const catalog of [[], [product()], null]) for (const capabilities of [{}, capability(feature, false)]) {
      const { args, calls } = setup(feature, { catalog, capabilities });
      assert.equal((await evaluate(args)).state, 'coverage_gap'); assert.equal(calls.length, 0);
    }
  });
  test(`${feature}: declared empty, nonqualifying and brief-only catalogs prepare a real qualifying product`, async () => {
    for (const catalog of [[], [product()], null]) {
      const { args, calls } = setup(feature, { catalog });
      let executed = 0; args.exercise = async p => { assert.equal(validate.product(p), true); executed++; return true; };
      assert.deepEqual(await evaluate(args), { state: 'applicable', route: 'prepared', product_id: 'seller-offer' });
      assert.equal(calls.length, 1); assert.equal(executed, 1); assert.equal(validate.params(calls[0]), true);
    }
  });
  test(`${feature}: valid promised setup refusals/unknown scenario/transport remain violations`, async () => {
    for (const error of ['INVALID_PARAMS', 'UNKNOWN_SCENARIO', 'INTERNAL_ERROR']) {
      const { args } = setup(feature, { prepare: async () => ({ success: false, error }) });
      assert.equal((await evaluate(args)).state, 'commitment_violation');
    }
    const { args } = setup(feature, { prepare: async () => { throw new Error('transport'); } });
    assert.equal((await evaluate(args)).reason, 'setup_transport');
  });
  test(`${feature}: missing runner/access is a gap; confirmed missing promised operation is a violation`, async () => {
    for (const option of [{ harness: false }, { sandbox: false }]) {
      const { args, calls } = setup(feature, option);
      assert.equal((await evaluate(args)).state, 'harness_gap'); assert.equal(calls.length, 0);
    }
    const { args } = setup(feature, { operation: false });
    assert.equal((await evaluate(args)).reason, 'missing_promised_operation');
  });
  test(`${feature}: malformed, nonqualifying and mismatched setup cannot purchase or fall back`, async () => {
    for (const simulated of [{}, { feature, fixture_id: `proposal-${feature}`, product: product() },
      { feature, fixture_id: 'wrong-run', product: product(feature) },
      { feature, fixture_id: `proposal-${feature}`, product: { product_id: 'broken' } }]) {
      const { args } = setup(feature, { prepare: async () => ({ success: true, simulated }), exercise: async () => { assert.fail('invalid setup must not purchase'); } });
      assert.equal((await evaluate(args)).reason, 'invalid_qualified_setup');
    }
  });
  test(`${feature}: broken selected behavior stays a violation after catalog or setup selection`, async () => {
    for (const catalog of [[product(feature)], []]) for (const exercise of [async () => false, async () => { throw new Error('selected protocol failure'); }]) {
      const { args } = setup(feature, { catalog, exercise });
      assert.equal((await evaluate(args)).state, 'behavior_violation');
    }
  });
}

test('all 32 independent declaration combinations select only the promised empty-catalog paths', async () => {
  for (let mask = 0; mask < 32; mask++) {
    const declarations = Object.fromEntries(features.map((feature, i) => [`supports_${feature}`, Boolean(mask & (1 << i))]));
    for (let i = 0; i < features.length; i++) {
      const { args, calls } = setup(features[i], { capabilities: { media_buy: { features: declarations } } });
      const expected = Boolean(mask & (1 << i));
      assert.equal((await evaluate(args)).state, expected ? 'applicable' : 'coverage_gap');
      assert.equal(calls.length, Number(expected));
    }
  }
});
test('missing new runner contract preserves catalog execution and reports separate unverified promise', async () => {
  const { args } = setup('format_breakdown', { harness: false, catalog: [product('format_breakdown')] });
  const result = await evaluate(args);
  assert.equal(result.state, 'applicable'); assert.equal(result.route, 'catalog');
  assert.equal(result.commitment, 'unverified_missing_runner_contract');
});
test('missing promised operation preserves catalog behavior with a separate commitment violation', async () => {
  const { args } = setup('format_breakdown', { operation: false, catalog: [product('format_breakdown')] });
  const result = await evaluate(args); assert.equal(result.state, 'applicable');
  assert.equal(result.commitment, 'violation_missing_promised_operation');
});
test('catalog behavior alone never certifies the true preparation promise', async () => {
  const { args } = setup('format_breakdown', { catalog: [product('format_breakdown')] });
  assert.equal((await evaluate(args)).commitment, 'untested_preparation');
  const empty = setup('format_breakdown', { prepare: undefined });
  assert.equal((await evaluate(empty.args)).state, 'harness_gap');
});
test('invalid parent blocks are declarations errors rather than absent support', async () => {
  for (const capabilities of [{ media_buy: null }, { media_buy: [] }, { media_buy: { features: null } }]) {
    const { args } = setup('format_breakdown', { capabilities });
    assert.equal((await evaluate(args)).reason, 'invalid_declaration');
  }
});
test('invalid known declarations fail; unknown future keys remain open without claiming support', async () => {
  for (const feature of features) for (const value of ['true', 1, null, [], {}]) {
    const { args } = setup(feature, { capabilities: capability(feature, value) });
    assert.equal((await evaluate(args)).reason, 'invalid_declaration');
  }
  assert.equal(validate.declaration({ future_feature: true }), true);
  assert.equal(validate.declaration({ future_feature: { version: 2 } }), false);
  const { args } = setup('format_breakdown', { capabilities: { media_buy: { features: { future_feature: true } } } });
  assert.equal((await evaluate(args)).state, 'coverage_gap');
});
test('fixed omitted/false flags qualify; owner carriage needs separate channel evidence and no selectable flag', () => {
  for (const flag of [undefined, false]) {
    const p = product('fixed_collection_bundles'); if (flag !== undefined) p.collection_targeting_allowed = flag;
    assert.equal(validate.product(p), true); assert.equal(qualifies('fixed_collection_bundles', p), true);
    assert.equal(qualifies('collection_selection', p), false);
  }
  const p = product('owner_sold_channel_carriage');
  assert.equal(qualifies('owner_sold_channel_carriage', p), false);
  assert.equal(qualifies('owner_sold_channel_carriage', p, ownerEvidence), true);
  assert.equal(qualifies('owner_sold_channel_carriage', p, { ...ownerEvidence, kind: 'show' }), false);
});
test('new fields pass old open schemas; old sellers and omitted parents validate the fragment', () => {
  const fresh = Object.fromEntries(features.map(f => [`supports_${f}`, true]));
  assert.equal(validate.oldFeatures(fresh), true); assert.equal(validate.declaration({}), true);
  assert.equal(validate.oldFeatures({ unknown_future: { version: 2 } }), false);
  for (const p of Object.values(require('./features.schema.json').properties)) assert.equal(Object.hasOwn(p, 'default'), false);
});
test('source time-view schema permits empty arrays and arbitrary positive thresholds; rejects invalid entries', () => {
  const schema = require('../../static/schemas/source/core/delivery-metrics.json').properties.time_based_views;
  const ajv = new Ajv({ strict: false });
  ajv.addSchema(require('../../static/schemas/source/enums/view-threshold-basis.json'));
  ajv.addSchema(require('../../static/schemas/source/enums/viewability-standard.json'));
  const valid = ajv.compile(schema);
  for (const entries of [[], [{ threshold_seconds: 3, basis: 'in_view', views: 4 }]]) assert.equal(valid(entries), true);
  for (const entries of [[{ threshold_seconds: 0, basis: 'in_view', views: 4 }], [{ threshold_seconds: 3, views: 4 }]]) assert.equal(valid(entries), false);
});
test('current controller cannot demand new observed format/time grains from a feature declaration', () => {
  const controller = require('../../static/schemas/source/compliance/comply-test-controller-request.json');
  const text = JSON.stringify(controller);
  assert.equal(text.includes('prepare_product_feature'), false);
  const delivery = require('../../static/schemas/source/media-buy/get-media-buy-delivery-request.json');
  assert.match(delivery.properties.reporting_dimensions.description, /possibly empty/);
  assert.match(delivery.properties.requested_metrics.description, /omitted from the response without error/);
});

function sdkStoryboard(gated = false) {
  return { id: 'proposal/commitment_hazard', version: '1.0', title: 'Shipping SDK hazard evidence', category: 'media_buy_seller',
    summary: 'Evidence only', narrative: 'No implementation claim', agent: { interaction_model: 'media_buy_seller', capabilities: [] }, caller: { role: 'buyer_agent' },
    ...(gated && { requires_capability: { path: 'media_buy.features.supports_format_breakdown', equals: true } }),
    phases: [{ id: 'exercise', title: 'Exercise', steps: [{ id: 'selected', title: 'Selected path', task: 'create_media_buy',
      sample_request: {}, validations: [{ check: 'field_present', path: 'media_buy_id', description: 'Sentinel, not full lifecycle coverage' }] }] }] };
}
test('SDK 15.9.5: equals-true gating would hide undeclared catalogs, including absent parent objects', async () => {
  assert.equal(require('@adcp/sdk/package.json').version, '15.9.5');
  for (const capabilities of [{}, { media_buy: {} }, { media_buy: { features: {} } }]) {
    let calls = 0;
    const result = await runStoryboard('https://seller.example/mcp', sdkStoryboard(true), {
      agentTools: ['create_media_buy'], _profile: { tools: ['create_media_buy'], raw_capabilities: capabilities },
      _client: { resetContext() {}, async createMediaBuy() { calls++; return { success: true, data: { media_buy_id: 'native-buy' } }; } },
    });
    assert.equal(calls, 0); assert.ok(result.phases.flatMap(p => p.steps).some(s => s.skip_reason === 'capability_unsupported'));
  }
});
test('SDK 15.9.5: old catalog path remains runnable with unknown declaration keys; selected failures stay failed', async () => {
  for (const broken of [false, true]) {
    let calls = 0;
    const result = await runStoryboard('https://seller.example/mcp', sdkStoryboard(), {
      agentTools: ['create_media_buy'], _profile: { tools: ['create_media_buy'], raw_capabilities: capability('format_breakdown', true) },
      _client: { resetContext() {}, async createMediaBuy() { calls++; return { success: true, data: broken ? {} : { media_buy_id: 'native-buy' } }; } },
    });
    assert.equal(calls, 1); assert.equal(result.phases[0].steps[0].passed, !broken);
  }
});

const examples = require('./examples.json');
const identities = selectors => selectors.flatMap(s => s.collection_ids.map(id => `${s.publisher_domain}\0${id}`)).sort();
// An isolated assertion oracle over concrete vectors, not a seller implementation.
function selectionEvidence(vector) {
  if (!validate.collectionSelection(vector.request)) return 'INVALID_REQUEST';
  const full = ['owner.example\0music', 'owner.example\0news'];
  const selected = vector.request.mode === 'default' ? full : identities(vector.request.collections);
  if (selected.some(id => !full.includes(id))) return 'REFERENCE_NOT_FOUND';
  if (!vector.selectable && JSON.stringify(selected) !== JSON.stringify(full)) return 'UNSUPPORTED_FEATURE';
  if (!validate.collectionSelection(vector.readback) || vector.readback.mode !== 'selected') return 'broken_readback';
  return JSON.stringify(identities(vector.readback.collections)) === JSON.stringify(selected) ? 'valid' : 'broken_readback';
}
test('concrete source-schema vectors exercise selection, materialized defaults, fixed restatement and rejections', () => {
  assert.equal(validate.declaration(examples.declarations), true); assert.equal(validate.params(examples.prepare_params), true);
  for (const vector of examples.collection_vectors) assert.equal(selectionEvidence(vector), vector.error ?? 'valid', vector.name);
  const selected = examples.collection_vectors[0];
  assert.equal(selectionEvidence({ ...selected, readback: { mode: 'default' } }), 'broken_readback');
  assert.equal(selectionEvidence({ ...selected, readback: examples.collection_vectors[1].readback }), 'broken_readback');
});
test('concrete source-schema reporting vectors permit empty observed arrays with companions and three-second views', () => {
  assert.equal(validate.formatPackage(examples.empty_format_package), true);
  assert.equal(validate.deliveryRequest(examples.format_request), true);
  for (const metrics of [examples.empty_contracted_time_metric, examples.three_second_metric, examples.narrowed_metrics]) {
    assert.equal(validate.deliveryMetrics(metrics), true, JSON.stringify(validate.deliveryMetrics.errors));
  }
  const requiredCompanions = ['by_format', 'by_format_truncated', 'by_format_sorted_by', 'by_format_sort_direction'];
  const observedContract = value => requiredCompanions.every(key => Object.hasOwn(value, key)) && validate.formatPackage(value);
  assert.equal(observedContract(examples.empty_format_package), true);
  for (const field of requiredCompanions) {
    const broken = { ...examples.empty_format_package }; delete broken[field];
    assert.equal(observedContract(broken), false, `Missing requested-dimension companion ${field}`);
  }
  const narrowed = value => Object.keys(value).every(key => ['impressions', 'spend'].includes(key));
  assert.equal(narrowed(examples.narrowed_metrics), true);
  assert.equal(narrowed({ ...examples.narrowed_metrics, clicks: 1 }), false);
});

test('failed catalog behavior preserves its independent missing-commitment evidence', async () => {
  for (const option of [{ harness: false }, { operation: false }]) for (const exercise of [async () => false, async () => { throw new Error('broken'); }]) {
    const { args } = setup('format_breakdown', { catalog: [product('format_breakdown')], ...option, exercise });
    const result = await evaluate(args); assert.equal(result.state, 'behavior_violation');
    assert.equal(result.commitment, option.harness === false ? 'unverified_missing_runner_contract' : 'violation_missing_promised_operation');
  }
});
test('a seller rollup neither qualifies its plain products nor mutates a mixed catalog', async () => {
  const plain = product(undefined, { product_id: 'a-plain-offer' });
  const supporting = product('format_breakdown', { product_id: 'z-format-offer' });
  const catalog = [plain, supporting]; const before = JSON.stringify(catalog);
  const { args, calls } = setup('format_breakdown', { catalog });
  const result = await evaluate(args); assert.equal(result.product_id, 'z-format-offer');
  assert.equal(qualifies('format_breakdown', plain), false); assert.equal(JSON.stringify(catalog), before); assert.equal(calls.length, 0);
});

test('full source format-package schema rejects malformed inherited metrics', () => {
  assert.equal(validate.formatPackage({ ...examples.empty_format_package, impressions: 'bad', spend: -1 }), false);
});
test('proposed controller params reject malformed or unknown scopes without coercion', () => {
  for (const params of [{}, { feature: 'format_breakdown', fixture_id: '' }, { feature: 'unknown_future_feature', fixture_id: 'run' }, { feature: true, fixture_id: 'run' }]) {
    assert.equal(validate.params(params), false);
  }
});
test('SDK 15.9.5: an old controller returns UNKNOWN_SCENARIO for the proposed operation without mutation', async () => {
  const { handleTestControllerRequest } = require('@adcp/sdk');
  const store = {};
  const response = await handleTestControllerRequest(store, { scenario: 'prepare_product_feature', params: examples.prepare_params });
  assert.equal(response.success, false); assert.equal(response.error, 'UNKNOWN_SCENARIO');
  assert.deepEqual(store, {});
});
