'use strict';
// Read-only #8254 qualification. Public SDK exports and public MCP transport only.
// Counterexample tests PASS when a proposed YAML shortcut produces the documented
// false pass / false failure. They do not repair or approve held reporting source.
const test = require('node:test');
const assert = require('node:assert/strict');
const { runStoryboard, runStoryboardStep, parseStoryboard } = require('@adcp/sdk/testing');
const ENDPOINT = 'https://conditional-evidence.example/mcp';
const TOOLS = ['get_adcp_capabilities', 'get_products', 'create_media_buy', 'get_media_buy_delivery', 'comply_test_controller'];
const CAPS = { status: 'completed', adcp: { major_versions: [3], supported_versions: ['3.2'], idempotency: { supported: false } }, supported_protocols: ['media_buy'], media_buy: { buying_modes: ['brief', 'wholesale'] }, compliance_testing: { scenarios: ['seed_account', 'simulate_delivery'] } };
const START = '2026-10-19T00:00:00Z';
const END = '2026-10-20T00:00:00Z';
const PKG = 'media_buy_deliveries[0].by_package[0]';
const metric = (metric_id = 'time_based_views', committed_at = START) => ({ scope: 'standard', metric_id, committed_at });
function report({ carrier = false, disclosure = false, isFinal = true, window = 'final' } = {}) {
  const pkg = { package_id: 'seller-package', impressions: 1001, spend: 0, pricing_model: 'cpm', rate: 10, currency: 'USD', measurement_window: window, is_final: isFinal,
    ...(isFinal && { finalized_at: '2026-10-20T01:00:00Z' }),
    ...(carrier && { time_based_views: [] }),
    ...(disclosure && { missing_metrics: [{ scope: 'standard', metric_id: 'time_based_views' }] }) };
  return { status: 'completed', reporting_period: { start: START, end: END }, media_buy_deliveries: [{ media_buy_id: 'seller-buy', status: 'active', totals: { impressions: 1001, spend: 0 }, by_package: [pkg] }] };
}
const schema = { check: 'response_schema', description: 'Real tool response satisfies the pinned schema' };
const disclose = { check: 'field_contains', path: `${PKG}.missing_metrics[*].metric_id`, value: 'time_based_views', description: 'The selected missing committed metric is disclosed' };
function read(id, validations = [], capture = false) {
  return { id, title: id, task: 'get_media_buy_delivery', stateful: false,
    sample_request: { media_buy_ids: ['seller-buy'], requested_metrics: ['time_based_views'] },
    validations: [schema, ...validations], ...(capture && { context_outputs: [{ key: 'observed', path: 'media_buy_deliveries[0].by_package[0]' }, { key: 'period_end', path: 'reporting_period.end' }] }) };
}
function board({ skip = "context.accepted.committed_metrics.0.metric_id != 'time_based_views' || context.observed.time_based_views || !context.observed.is_final", check = disclose, context = {}, validationOnly = false } = {}) {
  return { id: 'prerequisite_evidence/conditional_reporting', version: '1.0.0', category: 'media_buy_seller', title: 'Existing conditional grammar evidence', summary: 'No new protocol or SDK rule.', narrative: 'Public API probes of downstream authorability.', agent: { interaction_model: 'media_buy_seller', capabilities: ['sells_media'] }, caller: { role: 'buyer_agent' }, context,
    phases: [
      { id: 'buy', title: 'Capture accepted contract', steps: [{ id: 'create', title: 'Create', task: 'create_media_buy', stateful: true, sample_request: { brand: { domain: 'acmeoutdoor.example' }, start_time: 'asap', end_time: '2099-06-30T23:59:59Z', packages: [{ product_id: 'seller-product', pricing_option_id: 'seller-cpm', budget: 1000 }] }, validations: [schema], context_outputs: [{ key: 'accepted', path: 'packages[0]' }] }] },
      { id: 'observe', title: 'Observe report', steps: [read('observe', [], true)] },
      { id: 'audit', title: 'Conditional audit', ...(skip !== null && { skip_if: skip }), steps: [validationOnly ? { id: 'audit', title: 'Audit captured report', validations: [check] } : read('audit', [check])] },
    ] };
}
function transport({ commits = [metric()], reports = [report()], confirmedAt, omitCommits = false, catalogMetrics = [['impressions', 'time_based_views']] } = {}) {
  const calls = [];
  let n = 0, catalogN = 0;
  const accepted = { package_id: 'seller-package', product_id: 'seller-product', pricing_option_id: 'seller-cpm', ...(!omitCommits && { committed_metrics: commits }) };
  const trustedFetchFn = async (_url, init = {}) => {
    const m = JSON.parse(init.body);
    let result;
    if (m.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'conditional-public-probe', version: '1' } };
    else if (m.method.startsWith('notifications/')) return new Response(null, { status: 202 });
    else if (m.method === 'tools/list') result = { tools: TOOLS.map(name => ({ name, description: name, inputSchema: { type: 'object', additionalProperties: true } })) };
    else if (m.method === 'tools/call') {
      const { name, arguments: request } = m.params;
      calls.push({ task: name, request: structuredClone(request) });
      const data = name === 'comply_test_controller' ? (request.scenario === 'list_scenarios' ? { success: true, scenarios: ['seed_account', 'simulate_delivery'] } : { success: true }) : name === 'get_adcp_capabilities' ? CAPS : name === 'get_products' ? { status: 'completed', products: [{ product_id: 'seller-product', name: 'Catalog offer', description: 'Live metadata evidence', publisher_properties: [{ publisher_domain: 'seller.example', selection_type: 'all' }], channels: ['olv'], delivery_type: 'non_guaranteed', format_options: [{ format_option_id: 'video', format_kind: 'video_hosted', params: { duration_ms_exact: 30000 } }], pricing_options: [{ pricing_option_id: 'seller-cpm', pricing_model: 'cpm', currency: 'USD', fixed_price: 10 }], reporting_capabilities: { available_reporting_frequencies: ['daily'], expected_delay_minutes: 0, timezone: 'UTC', supports_webhooks: false, available_metrics: catalogMetrics[Math.min(catalogN++, catalogMetrics.length - 1)], date_range_support: 'date_range', measurement_windows: [{ window_id: 'final', duration_days: 0, expected_availability_days: 0, is_guarantee_basis: true }] } }], cache_scope: 'account', wholesale_feed_version: String(catalogN) } : name === 'create_media_buy' ? { status: 'completed', media_buy_id: 'seller-buy', revision: 1, confirmed_at: confirmedAt ?? commits[0]?.committed_at ?? START, packages: [accepted] } : name === 'get_media_buy_delivery' ? reports[Math.min(n++, reports.length - 1)] : assert.fail(`Unexpected tool ${name}`);
      result = { content: [{ type: 'text', text: JSON.stringify(data) }] };
    } else return new Response(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Method not found' } }), { headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }), { headers: { 'content-type': 'application/json' } });
  };
  return { calls, accepted, options: { adcpVersion: '3.2.5', timeout_ms: 3000, brand: { domain: 'acmeoutdoor.example' }, profile: { tools: TOOLS, raw_capabilities: CAPS, supported_protocols: ['media_buy'] }, transport: { trustedFetchFn } } };
}
const steps = r => r.phases.flatMap(p => p.steps);
const audited = r => steps(r).find(s => s.step_id === 'audit');
async function execute(doc = board(), config) {
  const io = transport(config);
  const result = await runStoryboard(ENDPOINT, doc, io.options);
  return { result, io };
}
const refs = { check: 'refs_resolve', source: { from: 'context', path: 'accepted.committed_metrics[*]' }, target: { from: 'current_step', path: `${PKG}.missing_metrics[*]` }, match_keys: ['scope', 'metric_id'], scope: { key: 'metric_id', equals: 'time_based_views' }, on_out_of_scope: 'ignore', description: 'Scoped time commitment resolves to disclosure at any array index' };

test('unchanged installed public SDK is 15.9.5', () => assert.equal(require('@adcp/sdk').LIBRARY_VERSION, '15.9.5'));

test('restricted full-run conditional detects a first, final, already-due time commitment losing both carriers', async () => {
  const { result } = await execute();
  assert.equal(result.overall_passed, false, JSON.stringify(result));
  assert.equal(audited(result).validations.find(v => v.check === 'field_contains').passed, false);
});
test('restricted conditional preserves disclosed unavailable, empty canonical array, and another-only commitment cases', async () => {
  for (const config of [{ reports: [report({ disclosure: true })] }, { reports: [report({ carrier: true })] }, { commits: [metric('impressions')] }]) {
    const { result } = await execute(board(), config);
    assert.equal(result.overall_passed, true, JSON.stringify(result));
  }
});
test('fixed-index skip conceals a due time commitment at arbitrary later index', async () => {
  const { result, io } = await execute(board(), { commits: [metric('impressions'), metric()] });
  assert.equal(result.overall_passed, true, JSON.stringify(result));
  assert.equal(audited(result), undefined);
  assert.equal(io.calls.filter(c => c.task === 'get_media_buy_delivery').length, 1);
});
test('refs_resolve DOES select time commitment at any index, preserving legal disclosures', async () => {
  for (const disclosure of [false, true]) {
    const { result } = await execute(board({ skip: null, check: refs }), { commits: [metric('impressions'), metric()], reports: [report({ disclosure })] });
    assert.equal(result.overall_passed, disclosure, JSON.stringify(result));
  }
});
test('unconditional refs resolution wrongly rejects valid actual time data with no missing disclosure', async () => {
  const { result } = await execute(board({ skip: null, check: refs }), { reports: [report({ carrier: true })] });
  assert.equal(result.overall_passed, false, JSON.stringify(result));
  assert.equal(audited(result).validations.find(v => v.check === 'refs_resolve').passed, false);
});
test('finality shortcut wrongly rejects commitment at or after report-end: exact strict-before matters', async () => {
  for (const committed_at of [END, '2026-10-21T00:00:00Z']) {
    const { result } = await execute(board(), { commits: [metric('time_based_views', committed_at)] });
    assert.equal(result.overall_passed, false, JSON.stringify(result));
  }
});
test('existing numeric comparison cannot compare legal ISO commitment timestamps', async () => {
  const check = { check: 'field_greater_than', path: 'reporting_period.end', context_key: 'commit_time', description: 'Attempt report-end after commitment date comparison' };
  const doc = board({ skip: null, check });
  doc.phases[0].steps[0].context_outputs.push({ key: 'commit_time', path: 'packages[0].committed_metrics[0].committed_at' });
  const { result } = await execute(doc);
  assert.equal(result.overall_passed, false, JSON.stringify(result));
  assert.match(audited(result).validations.find(v => v.check === 'field_greater_than').error, /requires a finite number/);
});
test('phase parser has equality and OR but rejects dates, numeric comparisons and array predicates', () => {
  for (const skip of ['context.accepted.committed_metrics.0.committed_at < context.period_end', 'context.observed.is_final && context.accepted', 'context.accepted.committed_metrics[*].metric_id', 'context.accepted.committed_metrics.some()']) {
    assert.throws(() => parseStoryboard(JSON.stringify(board({ skip }))), /invalid skip_if/);
  }
  assert.doesNotThrow(() => parseStoryboard(JSON.stringify(board({ skip: 'context.accepted.committed_metrics.1.metric_id == \'time_based_views\' || !context.observed.time_based_views' }))));
});
test('is_final false is not a universal not-yet-measurable predicate; mature metric can be lost in a provisional stage', async () => {
  const { result, io } = await execute(board(), { reports: [report({ isFinal: false, window: 'live' })] });
  assert.equal(result.overall_passed, true, JSON.stringify(result));
  assert.equal(audited(result), undefined);
  assert.equal(io.calls.filter(c => c.task === 'get_media_buy_delivery').length, 1);
});
test('forcing all time commitments to disclose rejects legal not-yet-measurable stages', async () => {
  const { result } = await execute(board({ skip: null, check: refs }), { reports: [report({ isFinal: false, window: 'live' })] });
  assert.equal(result.overall_passed, false, JSON.stringify(result));
});
test('a follow-up audit read can validly gain data, so prior-response absence cannot demand disclosure from the new response', async () => {
  const { result } = await execute(board(), { reports: [report({ disclosure: true }), report({ carrier: true })] });
  assert.equal(result.overall_passed, false, JSON.stringify(result));
  assert.deepEqual(audited(result).response.media_buy_deliveries[0].by_package[0].time_based_views, []);
});
test('taskless validation-only step does not audit captured report: it yields a coverage gap', async () => {
  const { result, io } = await execute(board({ skip: null, validationOnly: true }));
  assert.equal(audited(result).skipped, true, JSON.stringify(result));
  assert.equal(audited(result).skip_reason, 'fixture_unavailable');
  assert.deepEqual(audited(result).validations, []);
  assert.equal(io.calls.filter(c => c.task === 'get_media_buy_delivery').length, 1);
});
test('standalone runner does not honor runtime phase skip_if even with supplied complete prior context', async () => {
  const io = transport({ reports: [report({ carrier: true })] });
  const doc = board();
  const result = await runStoryboardStep(ENDPOINT, doc, 'audit', { ...io.options, context: { accepted: io.accepted, observed: report({ carrier: true }).media_buy_deliveries[0].by_package[0] } });
  assert.equal(result.skipped ?? false, false, JSON.stringify(result));
  assert.equal(result.passed, false, JSON.stringify(result));
  assert.equal(io.calls.filter(c => c.task === 'get_media_buy_delivery').length, 1);
});
test('absent committed_metrics requires live catalog fallback, while refs alone vacuously passes', async () => {
  const { result } = await execute(board({ skip: null, check: refs }), { omitCommits: true });
  assert.equal(result.overall_passed, true, JSON.stringify(result));
  assert.equal(audited(result).validations.find(v => v.check === 'refs_resolve').passed, true);
});

test('existing public catalog read can refresh live metrics; a selected initial snapshot is not the absent-commitment fallback', async () => {
  for (const catalogMetrics of [[['impressions', 'time_based_views'], ['impressions']], [['impressions'], ['impressions', 'time_based_views']]]) {
    const doc = board({ skip: null, check: refs });
    const catalogRead = id => ({ id, title: id, task: 'get_products', stateful: false, sample_request: { buying_mode: 'wholesale' }, validations: [schema], context_outputs: [{ key: id, path: 'products[0].reporting_capabilities.available_metrics' }] });
    doc.phases.unshift({ id: 'initial_catalog', title: 'Initial selected catalog', steps: [catalogRead('initial_metrics')] });
    doc.phases.push({ id: 'live_catalog', title: 'Current catalog', steps: [catalogRead('current_metrics')] });
    const { result } = await execute(doc, { omitCommits: true, catalogMetrics });
    assert.equal(result.overall_passed, true, JSON.stringify(result));
    const last = steps(result).find(s => s.step_id === 'current_metrics');
    assert.deepEqual(last.context.initial_metrics, catalogMetrics[0]);
    assert.deepEqual(last.context.current_metrics, catalogMetrics[1]);
    assert.notDeepEqual(last.context.initial_metrics, last.context.current_metrics);
  }
});


// Byte-identical held source snapshot at 8ccc1d62194b9b8e2a9b8d3b2543b20d145f67f6.
// This is evidence, not operative source adoption or a repaired storyboard.
const heldTimePath = require('node:path').join(__dirname, 'reporting-snapshots/time_based_delivery_reporting.yaml');
const heldTimeBytes = require('node:fs').readFileSync(heldTimePath);
assert.equal(require('node:crypto').createHash('sha256').update(heldTimeBytes).digest('hex'), '7967d0c2cc5b38eb6713f74ae1d8dd81315ba3c07bf76cffb7ae810eca8358eb');
const HELD_TIME_SOURCE = require('@adcp/sdk/testing').loadStoryboardFile(heldTimePath);

test('actual held time storyboard snapshot still false-passes matured commitment losing both canonical data and disclosure through public transport', async () => {
  const doc = structuredClone(HELD_TIME_SOURCE);
  const io = transport();
  const result = await runStoryboard(ENDPOINT, doc, { ...io.options, brand: structuredClone(doc.context.sandbox_brand) });
  assert.equal(result.overall_passed, true, JSON.stringify(result));
  assert.equal(result.fixture_resolutions.every(r => r.status === 'resolved'), true);
  const create = steps(result).find(s => s.step_id === 'create_buy');
  assert.deepEqual(create.response.packages[0].committed_metrics, [metric()]);
  const read = steps(result).find(s => s.step_id === 'get_narrowed_time_delivery');
  const pkg = read.response.media_buy_deliveries[0].by_package[0];
  assert.equal(pkg.is_final, true);
  assert.equal(pkg.measurement_window, 'final');
  assert.equal(Object.hasOwn(pkg, 'time_based_views'), false);
  assert.equal(Object.hasOwn(pkg, 'missing_metrics'), false);
});

const frozenRefs = { ...refs, target: { from: 'context', path: 'observed.missing_metrics[*]' } };
test('existing scoped refs with BOTH roots in context audits the same report: arbitrary commitment indexes and no invented time observations', async () => {
  for (const config of [
    { reports: [report({ disclosure: true })] },
    { reports: [report({ carrier: true })] },
    { commits: [metric('impressions')] },
    { commits: [metric('impressions'), metric()], reports: [report({ disclosure: true })] },
  ]) {
    const { result } = await execute(board({ skip: 'context.observed.time_based_views', check: frozenRefs }), config);
    assert.equal(result.overall_passed, true, JSON.stringify(result));
  }
  const { result } = await execute(board({ skip: 'context.observed.time_based_views', check: frozenRefs }), { commits: [metric('impressions'), metric()] });
  assert.equal(result.overall_passed, false, JSON.stringify(result));
  assert.equal(audited(result).validations.find(v => v.check === 'refs_resolve').passed, false);
});
test('context-target refs eliminate the follow-up-response maturation false failure using existing grammar', async () => {
  const { result } = await execute(board({ skip: 'context.observed.time_based_views', check: frozenRefs }), { reports: [report({ disclosure: true }), report({ carrier: true })] });
  assert.equal(result.overall_passed, true, JSON.stringify(result));
  assert.equal(audited(result).validations.find(v => v.check === 'refs_resolve').passed, true);
});
test('frozen refs still cannot filter commitment timestamps or infer measurement-stage eligibility', async () => {
  for (const config of [
    { commits: [metric('time_based_views', END)] },
    { reports: [report({ isFinal: false, window: 'live' })] },
  ]) {
    const { result } = await execute(board({ skip: 'context.observed.time_based_views', check: frozenRefs }), config);
    assert.equal(result.overall_passed, false, JSON.stringify(result));
    assert.equal(audited(result).validations.find(v => v.check === 'refs_resolve').passed, false);
  }
});
test('standalone frozen refs enforce the bounded no-carrier case when the caller supplies accepted and report snapshots', async () => {
  for (const disclosure of [false, true]) {
    const io = transport();
    const result = await runStoryboardStep(ENDPOINT, board({ skip: 'context.observed.time_based_views', check: frozenRefs }), 'audit', {
      ...io.options, context: { accepted: io.accepted, observed: report({ disclosure }).media_buy_deliveries[0].by_package[0] },
    });
    assert.equal(result.passed, disclosure, JSON.stringify(result));
    assert.equal(result.validations.find(v => v.check === 'refs_resolve').passed, disclosure);
  }
});
