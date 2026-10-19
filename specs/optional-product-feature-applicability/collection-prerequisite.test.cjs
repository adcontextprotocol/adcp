// Read-only evidence for #8254. Runs public SDK entry points with the public
// trustedFetchFn transport; no private module imports, client seams, or I/O.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  runStoryboard, runStoryboardStep, parseStoryboard, registerAssertion,
  extractContext, injectContext,
} = require('@adcp/sdk/testing');

const caps = {
  status: 'completed',
  adcp: { major_versions: [3], supported_versions: ['3.2'], idempotency: { supported: false } },
  supported_protocols: ['media_buy'],
  media_buy: { buying_modes: ['brief', 'wholesale'] },
};
const toolNames = ['get_adcp_capabilities', 'get_products', 'create_media_buy'];

function product(id, extra = {}) {
  return {
    product_id: id, name: 'Catalog offer', description: 'Seller-owned prerequisite probe offer.',
    publisher_properties: [{ publisher_domain: 'publisher.example', selection_type: 'all' }],
    channels: ['ctv'], delivery_type: 'non_guaranteed',
    format_options: [{ format_option_id: 'video', format_kind: 'video_hosted', params: { duration_ms_exact: 30000 } }],
    pricing_options: [{ pricing_option_id: 'seller-price', pricing_model: 'cpm', currency: 'USD', fixed_price: 10 }],
    collections: [{ publisher_domain: 'owner.example', collection_ids: ['news', 'music'] }],
    reporting_capabilities: {
      available_reporting_frequencies: ['daily'], expected_delay_minutes: 0,
      timezone: 'UTC', supports_webhooks: false,
      available_metrics: ['impressions', 'spend'], date_range_support: 'date_range',
    },
    ...extra,
  };
}

const present = path => ({ path, operator: 'present' });
const equals = (path, value) => ({ path, operator: 'equals', value });
const selectionMatch = [equals('/collection_targeting_allowed', true)];

function createStep() {
  return {
    id: 'create', title: 'Exercise the pinned offer', task: 'create_media_buy', stateful: true,
    sample_request: {
      brand: { domain: 'acmeoutdoor.example' }, start_time: 'asap', end_time: '2099-06-30T23:59:59Z',
      packages: [{ product_id: 'authored-product', pricing_option_id: 'seller-price', budget: 1000 }],
    },
    validations: [{ check: 'field_present', path: 'media_buy_id', description: 'The sentinel lifecycle succeeds' }],
  };
}

function readStep({ capture = false, validations = [] } = {}) {
  return {
    id: 'read', title: 'Read a normal catalog response', task: 'get_products', stateful: false,
    sample_request: { buying_mode: 'wholesale', ext: { adcp: { creative_wire: 'canonical' } } },
    ...(capture && { context_outputs: [
      { key: 'observed_product', path: 'products[0]' },
      { key: 'observed_domain', path: 'products[0].collections[0].publisher_domain' },
      { key: 'observed_id', path: 'products[0].collections[0].collection_ids[0]' },
    ] }),
    validations,
  };
}

function board({ match = selectionMatch, phases, fixture = true, context } = {}) {
  return {
    id: 'prerequisite_evidence/collections', version: '1.0.0', category: 'media_buy_seller',
    title: 'Collection foundation evidence', summary: 'Existing SDK contracts only.',
    narrative: 'These probes do not add a conformance rule or repair a published storyboard.',
    agent: { interaction_model: 'media_buy_seller', capabilities: ['sells_media'] },
    caller: { role: 'buyer_agent' },
    ...(context && { context }),
    ...(fixture && {
      fixtures: { products: [product('authored-product', { collection_targeting_allowed: true })] },
      fixture_resolution: { products: [{ handle: 'authored-product', strategies: ['discover'], match }] },
    }),
    phases: phases ?? [{ id: 'exercise', title: 'Exercise', steps: [createStep()] }],
  };
}

function transport(catalog, overrides = {}) {
  const calls = [];
  const rpc = [];
  let reads = 0;
  const trustedFetchFn = async (_input, init = {}) => {
    const message = JSON.parse(init.body);
    rpc.push(message.method);
    let result;
    if (message.method === 'initialize') {
      result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'public-api-probe', version: '1' } };
    } else if (message.method === 'notifications/initialized') {
      return new Response(null, { status: 202 });
    } else if (message.method === 'tools/list') {
      result = { tools: toolNames.map(name => ({ name, description: name, inputSchema: { type: 'object', additionalProperties: true } })) };
    } else if (message.method === 'tools/call') {
      const { name, arguments: request } = message.params;
      calls.push({ task: name, request });
      let data;
      if (name === 'get_adcp_capabilities') data = caps;
      else if (name === 'get_products') {
        reads += 1;
        data = overrides.read?.(request, reads) ?? {
          status: 'completed', products: catalog, cache_scope: 'account', wholesale_feed_version: 'v1',
        };
      } else if (name === 'create_media_buy') {
        data = overrides.create?.(request) ?? {
          status: 'completed', media_buy_id: 'seller-buy', revision: 1,
          confirmed_at: '2026-10-19T00:00:00Z', packages: [],
        };
      } else throw new Error(`Unexpected tool ${name}`);
      result = { content: [{ type: 'text', text: JSON.stringify(data) }] };
    } else {
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } }), { headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }), { headers: { 'content-type': 'application/json' } });
  };
  return {
    calls, rpc,
    options: {
      adcpVersion: '3.2.5', timeout_ms: 3000,
      profile: { tools: toolNames, raw_capabilities: caps, supported_protocols: ['media_buy'] },
      transport: { trustedFetchFn },
    },
  };
}

const endpoint = 'https://prerequisite-probe.example/mcp';
const flatten = result => result.phases.flatMap(phase => phase.steps);

test('SDK pin is the current unchanged main dependency', () => {
  assert.equal(require('../../node_modules/@adcp/sdk/package.json').version, '15.9.5');
});

test('public full runner resolves explicit false but leaves omitted default unsatisfied', async () => {
  for (const extra of [{ collection_targeting_allowed: false }, {}]) {
    const io = transport([product('seller-fixed', extra)]);
    const result = await runStoryboard(endpoint, board({ match: [equals('/collection_targeting_allowed', false)] }), io.options);
    const explicit = Object.hasOwn(extra, 'collection_targeting_allowed');
    assert.equal(result.fixture_resolutions[0].status, explicit ? 'resolved' : 'unsatisfied');
    assert.equal(io.calls.some(call => call.task === 'create_media_buy'), explicit);
    assert.equal(result.coverage_gaps?.some(gap => gap.reason === 'fixture_unsatisfied') ?? false, !explicit);
  }
});

test('paginated public discovery finds a qualifying later product before identity selection', async () => {
  const pages = [[product('a-ordinary', { collection_targeting_allowed: false })],
    [product('z-selectable', { collection_targeting_allowed: true })]];
  const io = transport([], { read(request) {
    const page = Number(request.pagination?.cursor ?? 0);
    return { status: 'completed', products: pages[page], cache_scope: 'account', wholesale_feed_version: 'v1',
      pagination: { has_more: page === 0, ...(page === 0 && { cursor: '1' }) } };
  } });
  const result = await runStoryboard(endpoint, board(), io.options);
  assert.equal(result.overall_passed, true, JSON.stringify(result));
  assert.deepEqual(io.calls.filter(c => c.task === 'get_products').map(c => c.request.pagination.cursor), [undefined, '1']);
  assert.equal(result.fixture_resolutions[0].seller_ids.product_id, 'z-selectable');
  assert.equal(io.calls.find(c => c.task === 'create_media_buy').request.packages[0].product_id, 'z-selectable');
});

test('paginated public discovery still cannot qualify an omitted-false later fixed bundle', async () => {
  const pages = [[product('a-selectable', { collection_targeting_allowed: true })], [product('z-omitted-fixed')]];
  const io = transport([], { read(request) {
    const page = Number(request.pagination?.cursor ?? 0);
    return { status: 'completed', products: pages[page], cache_scope: 'account', wholesale_feed_version: 'v1',
      pagination: { has_more: page === 0, ...(page === 0 && { cursor: '1' }) } };
  } });
  const result = await runStoryboard(endpoint, board({ match: [equals('/collection_targeting_allowed', false)] }), io.options);
  assert.deepEqual(io.calls.filter(c => c.task === 'get_products').map(c => c.request.pagination.cursor), [undefined, '1']);
  assert.equal(result.fixture_resolutions[0].status, 'unsatisfied');
  assert.equal(result.coverage_gaps.some(g => g.reason === 'fixture_unsatisfied'), true);
  assert.equal(io.calls.some(c => c.task === 'create_media_buy'), false);
});

test('public loader rejects proposed absence, OR, relational and fixture-capture syntax today', () => {
  for (const clause of [
    { path: '/collection_targeting_allowed', operator: 'present', value: false },
    { path: '/collection_targeting_allowed', operator: 'absent' },
    { path: '', operator: 'any_of', where: [equals('/collection_targeting_allowed', false)] },
    { path: '/publisher_properties/0/publisher_domain', operator: 'not_equals_path', value_path: '/collections/0/publisher_domain' },
  ]) {
    assert.throws(() => parseStoryboard(JSON.stringify(board({ match: [clause] }))));
  }
  const sb = board();
  sb.fixture_resolution.products[0].context_outputs = [{ key: 'selected_collections', path: 'collections' }];
  assert.throws(() => parseStoryboard(JSON.stringify(sb)), /unknown key/);
});

test('full runner binds identity but does not capture the selected product metadata', async () => {
  const io = transport([product('seller-selected', { collection_targeting_allowed: true })]);
  const step = createStep();
  step.sample_request.packages[0].targeting_overlay = { collection_selection: {
    mode: 'selected', collections: [{ publisher_domain: '$context.selected_domain', collection_ids: ['$context.selected_id'] }],
  } };
  const result = await runStoryboard(endpoint, board({ phases: [{ id: 'exercise', title: 'Exercise', steps: [step] }] }), io.options);
  assert.equal(result.fixture_resolutions[0].seller_ids.product_id, 'seller-selected');
  assert.equal(io.calls.some(call => call.task === 'create_media_buy'), false);
  const exercise = flatten(result).find(item => item.step_id === 'create');
  assert.equal(exercise.skip_reason, 'prerequisite_failed');
  assert.ok(exercise.validations.some(item => item.check === 'unresolved_substitution'));
});

test('a normal products[0] read is not the deterministic fixture selection', async () => {
  const plain = product('z-ordinary', { pricing_options: [{ pricing_option_id: 'ordinary-price', pricing_model: 'cpm', currency: 'GBP', fixed_price: 77, min_spend_per_package: 9000 }], collections: [{ publisher_domain: 'ordinary.example', collection_ids: ['ordinary'] }] });
  const selected = product('a-selected', { collection_targeting_allowed: true });
  const io = transport([plain, selected]);
  const result = await runStoryboard(endpoint, board({ phases: [{ id: 'read', title: 'Read', steps: [readStep({ capture: true })] }] }), io.options);
  assert.equal(result.fixture_resolutions[0].seller_ids.product_id, 'a-selected');
  const observed = flatten(result).find(step => step.step_id === 'read').context.observed_product;
  assert.equal(observed.product_id, 'z-ordinary');
  assert.equal(observed.pricing_options[0].currency, 'GBP');
  assert.equal(observed.pricing_options[0].min_spend_per_package, 9000);
  assert.notDeepEqual(observed.collections, selected.collections);
  assert.notDeepEqual(observed.pricing_options, selected.pricing_options);
});

test('public standalone step does not resolve ordinary fixture handles', async () => {
  const catalog = [product('seller-selected', { collection_targeting_allowed: true })];
  const fullIo = transport(catalog);
  const full = await runStoryboard(endpoint, board(), fullIo.options);
  assert.equal(full.overall_passed, true, JSON.stringify(full));
  assert.equal(fullIo.calls.find(call => call.task === 'create_media_buy').request.packages[0].product_id, 'seller-selected');
  const standaloneIo = transport(catalog);
  const step = await runStoryboardStep(endpoint, board(), 'create', standaloneIo.options);
  assert.equal(step.passed, true, JSON.stringify(step));
  assert.equal(standaloneIo.calls.some(call => call.task === 'get_products'), false);
  assert.equal(standaloneIo.calls.find(call => call.task === 'create_media_buy').request.packages[0].product_id, 'authored-product');
});

test('broad first match plus runtime skip conceals a later applicable fixed product', async () => {
  const io = transport([
    product('a-selectable', { collection_targeting_allowed: true }),
    product('z-fixed'),
  ]);
  const result = await runStoryboard(endpoint, board({
    match: [present('/collections/0/collection_ids/0')],
    phases: [
      { id: 'read', title: 'Read', steps: [readStep({ capture: true })] },
      { id: 'fixed', title: 'Fixed', skip_if: 'context.observed_product.collection_targeting_allowed', steps: [createStep()] },
    ],
  }), io.options);
  assert.equal(result.fixture_resolutions[0].seller_ids.product_id, 'a-selectable');
  assert.equal(io.calls.some(call => call.task === 'create_media_buy'), false);
  assert.equal(result.failed_count, 0);
});

test('broad owner/host shape plus runtime relation skip conceals a later carriage-shaped product', async () => {
  const io = transport([
    product('a-ordinary', { publisher_properties: [{ publisher_domain: 'owner.example', selection_type: 'all' }] }),
    product('z-carriage'),
  ]);
  const result = await runStoryboard(endpoint, board({
    match: [present('/collections/0/publisher_domain'), present('/publisher_properties/0/publisher_domain')],
    phases: [
      { id: 'read', title: 'Read', steps: [readStep({ capture: true })] },
      { id: 'carriage', title: 'Carriage', skip_if: 'context.observed_product.collections.0.publisher_domain == context.observed_product.publisher_properties.0.publisher_domain', steps: [createStep()] },
    ],
  }), io.options);
  assert.equal(result.fixture_resolutions[0].seller_ids.product_id, 'a-ordinary');
  assert.equal(io.calls.some(call => call.task === 'create_media_buy'), false);
  assert.equal(result.failed_count, 0);
});

test('public extraction captures collections but supplies no subset transform or nested token', async () => {
  const selected = product('seller-selected', { collection_targeting_allowed: true });
  const io = transport([selected]);
  const read = readStep();
  read.context_outputs = [
    { key: 'all_selectors', path: 'products[0].collections' },
    { key: 'first_domain', path: 'products[0].collections[0].publisher_domain' },
    { key: 'first_id', path: 'products[0].collections[0].collection_ids[0]' },
  ];
  const result = await runStoryboardStep(endpoint, board({ fixture: false, phases: [{ id: 'read', title: 'Read', steps: [read] }] }), 'read', io.options);
  assert.equal(result.passed, true, JSON.stringify(result));
  assert.deepEqual(result.context.all_selectors, selected.collections);
  assert.equal(result.context.first_id, 'news');
  assert.deepEqual(injectContext({ selectors: '$context.all_selectors' }, result.context), { selectors: selected.collections });
  assert.deepEqual(injectContext({ selectors: '$context.all_selectors.0' }, result.context), { selectors: '$context.all_selectors.0' });
  assert.equal(extractContext('get_products', { products: [selected] }).product_id, 'seller-selected');
});

test('current equality overgrades harmless collection grouping and ID reordering', async () => {
  const expected = [
    { publisher_domain: 'owner.example', collection_ids: ['news', 'music'] },
    { publisher_domain: 'second.example', collection_ids: ['sports'] },
  ];
  const reordered = [
    { publisher_domain: 'second.example', collection_ids: ['sports'] },
    { publisher_domain: 'owner.example', collection_ids: ['music', 'news'] },
  ];
  const io = transport([product('same-set', { collections: reordered })]);
  const read = readStep({ validations: [{ check: 'field_equals_context', path: 'products[0].collections', context_key: 'expected', description: 'Compare current collection equality' }] });
  const result = await runStoryboardStep(endpoint, board({ fixture: false, context: { expected }, phases: [{ id: 'read', title: 'Read', steps: [read] }] }), 'read', io.options);
  assert.equal(result.passed, false);
  assert.equal(result.validations.find(item => item.check === 'field_equals_context').passed, false);
});

test('refs_resolve cannot compare collection_ids arrays from separate responses', async () => {
  const expected = [{ publisher_domain: 'owner.example', collection_ids: ['news', 'music'] }];
  const io = transport([product('same-structure', { collections: structuredClone(expected) })]);
  const read = readStep({ validations: [{
    check: 'refs_resolve', source: { from: 'current_step', path: 'products[0].collections[*]' },
    target: { from: 'context', path: 'expected[*]' }, match_keys: ['publisher_domain', 'collection_ids'],
    description: 'Try namespace and array key comparison',
  }] });
  const result = await runStoryboardStep(endpoint, board({ fixture: false, context: { expected }, phases: [{ id: 'read', title: 'Read', steps: [read] }] }), 'read', io.options);
  assert.equal(result.passed, false);
  assert.equal(result.validations.find(item => item.check === 'refs_resolve').passed, false);
});

test('flattened ID membership alone cannot detect namespace substitution', async () => {
  const io = transport([product('wrong-namespace', { collections: [{ publisher_domain: 'other.example', collection_ids: ['news'] }] })]);
  const read = readStep({ validations: [{
    check: 'all_fields_in_context_array', path: 'products[0].collections[*].collection_ids[*]',
    context_key: 'ids', description: 'ID-only comparison loses publisher qualification',
  }] });
  const result = await runStoryboardStep(endpoint, board({ fixture: false, context: { ids: ['news'] }, phases: [{ id: 'read', title: 'Read', steps: [read] }] }), 'read', io.options);
  assert.equal(result.passed, true, JSON.stringify(result));
});

test('scalar captures can assemble a seller-derived singleton selection without a transform', async () => {
  const selected = product('seller-selected', { collection_targeting_allowed: true });
  const io = transport([selected]);
  const create = createStep();
  create.sample_request.packages[0].product_id = '$context.actual_product_id';
  create.sample_request.packages[0].targeting_overlay = { collection_selection: {
    mode: 'selected', collections: [{ publisher_domain: '$context.observed_domain', collection_ids: ['$context.observed_id'] }],
  } };
  const read = readStep({ capture: true });
  read.context_outputs.push({ key: 'actual_product_id', path: 'products[0].product_id' });
  const result = await runStoryboard(endpoint, board({ fixture: false, phases: [{ id: 'exercise', title: 'Exercise', steps: [read, create] }] }), io.options);
  assert.equal(result.overall_passed, true, JSON.stringify(result));
  const request = io.calls.find(call => call.task === 'create_media_buy').request;
  assert.deepEqual(request.packages[0].targeting_overlay.collection_selection, {
    mode: 'selected', collections: [{ publisher_domain: 'owner.example', collection_ids: ['news'] }],
  });
});

test('a new check name is skipped by old runners rather than enforcing set equality', async () => {
  const io = transport([product('wrong-set')]);
  const read = readStep({ validations: [{
    check: 'collection_set_equals_context', path: 'products[0].collections', context_key: 'expected',
    description: 'Proposed name only; deliberately unimplemented on this pin',
  }] });
  const result = await runStoryboardStep(endpoint, board({ fixture: false, context: { expected: [] }, phases: [{ id: 'read', title: 'Read', steps: [read] }] }), 'read', io.options);
  const validation = result.validations.find(item => item.check === 'collection_set_equals_context');
  assert.equal(validation.passed, true);
  assert.equal(validation.not_applicable, true);
  assert.equal(result.passed, true, JSON.stringify(result));
});

test('branch-safe equality does not fail a missing expected context key', async () => {
  const io = transport([product('offer')]);
  const read = readStep({ validations: [{
    check: 'field_equals_context', path: 'products[0].collections', context_key: 'missing_expected',
    description: 'Missing comparison state must not silently authorize a new set check',
  }] });
  const result = await runStoryboardStep(endpoint, board({ fixture: false, phases: [{ id: 'read', title: 'Read', steps: [read] }] }), 'read', io.options);
  assert.equal(result.passed, true, JSON.stringify(result));
  assert.ok(result.validations.find(item => item.check === 'field_equals_context').observations.some(item => item.startsWith('context_key_absent:')));
});

test('public discovery schema failure remains terminal rather than a no-match', async () => {
  const io = transport([{ product_id: 'broken-product' }]);
  const result = await runStoryboard(endpoint, board(), io.options);
  assert.equal(result.fixture_resolutions[0].status, 'failed');
  assert.equal(result.overall_passed, false);
  assert.equal(result.coverage_gaps?.some(item => item.reason === 'fixture_unsatisfied') ?? false, false);
  assert.equal(io.calls.some(call => call.task === 'create_media_buy'), false);
});

test('local registered invariants gate full runs but do not run on standalone steps', async () => {
  let observed = 0;
  const invariantId = 'probe.collection_set_always_fails';
  registerAssertion({ id: invariantId, description: 'Public extension parity probe', onStep() {
    observed += 1;
    return [{ passed: false, description: 'Sentinel rejection proving full-run execution' }];
  } });
  const sb = board({ fixture: false });
  sb.invariants = [invariantId];
  const fullIo = transport([]);
  const full = await runStoryboard(endpoint, sb, fullIo.options);
  assert.equal(full.overall_passed, false);
  assert.equal(observed, 1);
  const standaloneIo = transport([]);
  const standalone = await runStoryboardStep(endpoint, sb, 'create', standaloneIo.options);
  assert.equal(standalone.passed, true, JSON.stringify(standalone));
  assert.equal(observed, 1);
});
