'use strict';

// Read-only authoring experiments on the actual public SDK 15.9.5 APIs.
// The report step is cloned from the held source; no shipping source changes.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadStoryboardFile, parseStoryboard, runStoryboard, runStoryboardStep } = require('@adcp/sdk/testing');

const ROOT = path.resolve(__dirname, '../..');
const sourcePath = path.join(__dirname, 'reporting-snapshots/advanced_delivery_reporting.yaml');
assert.equal(require('node:crypto').createHash('sha256').update(require('node:fs').readFileSync(sourcePath)).digest('hex'), 'ad6d36bb67f6222331820e31b3732110c85bbc95c4a36acdffae15b0b494616e');
const SOURCE = loadStoryboardFile(sourcePath);
const ROWS = 'media_buy_deliveries[0].by_package[0].by_format';
const ENDPOINT = 'https://format-sort-evidence.example/mcp';
const TOOLS = ['get_adcp_capabilities', 'get_media_buy_delivery'];
const CAPS = { status: 'completed', adcp: { major_versions: [3], supported_versions: ['3.2'], idempotency: { supported: false } }, supported_protocols: ['media_buy'], media_buy: { buying_modes: ['brief', 'wholesale'] } };
const row = (format_kind, spend) => ({ format_kind, spend, impressions: 1 });
const pair = (a, b) => [row('image', a), row('video_hosted', b)];
const population = (a, b, c) => [...pair(a, b), row('audio_hosted', c)];
const v = (check, extra, description) => ({ check, ...extra, description });

function reportStep(id = 'report', limit = 2) {
  const original = SOURCE.phases.flatMap(phase => phase.steps).find(step => step.id === 'get_narrowed_format_delivery');
  const step = structuredClone(original);
  step.id = id;
  step.sample_request.reporting_dimensions.format.limit = limit;
  step.validations.find(validation => validation.check === 'array_length' && validation.path === ROWS).max = limit;
  return step;
}

function board(phases) {
  // Setup/applicability are deliberately isolated: this experiment begins with
  // one selected, already-created single-package buy. The real report schema,
  // join/narrowing/metadata/limit checks and public transport still execute.
  return parseStoryboard(JSON.stringify({
    ...SOURCE, id: 'sort_evidence/source_report_projection', requires: undefined,
    prerequisites: undefined, fixtures: undefined, fixture_resolution: undefined,
    context: { ...SOURCE.context, advanced_media_buy_id: 'buy', advanced_package_id: 'package' },
    phases,
  }));
}

function echoCapture() {
  return {
    id: 'capture_pair', title: 'Extract numeric values from one captured report snapshot', task: 'get_adcp_capabilities', stateful: false,
    schema_ref: 'protocol/get-adcp-capabilities-request.json', response_schema_ref: 'protocol/get-adcp-capabilities-response.json',
    sample_request: { context: { observed_rows: '$context.observed_rows' } },
    validations: [
      v('response_schema', {}, 'Capability echo response is schema valid'),
      v('field_equals_context', { path: 'context.observed_rows', context_key: 'observed_rows' }, 'Opaque echo preserves the exact snapshot'),
    ],
    context_outputs: [
      { key: 'first_spend', path: 'context.observed_rows[0].spend' },
      { key: 'second_spend', path: 'context.observed_rows[1].spend' },
    ],
  };
}

function echoCompare() {
  return {
    id: 'compare_pair', title: 'Compare the captured same-read values', task: 'get_adcp_capabilities', stateful: false,
    schema_ref: 'protocol/get-adcp-capabilities-request.json', response_schema_ref: 'protocol/get-adcp-capabilities-response.json',
    sample_request: { context: { first_spend: '$context.first_spend', second_spend: '$context.second_spend' } },
    validations: [
      v('response_schema', {}, 'Capability echo response is schema valid'),
      v('field_equals_context', { path: 'context.first_spend', context_key: 'first_spend' }, 'First value is preserved exactly'),
      v('field_equals_context', { path: 'context.second_spend', context_key: 'second_spend' }, 'Second value is preserved exactly'),
      v('field_at_most', { path: 'context.first_spend', context_key: 'second_spend' }, 'Ascending same-read rows permit equal spend'),
    ],
  };
}

function sameSnapshotBoard() {
  const read = reportStep();
  read.context_outputs = [{ key: 'observed_rows', path: ROWS }];
  return board([
    { id: 'read', title: 'Read the bounded report', steps: [read] },
    { id: 'same_snapshot_order', title: 'Check only a returned pair', skip_if: '!context.observed_rows.1', steps: [echoCapture(), echoCompare()] },
  ]);
}

function crossReadBoard(membership = false) {
  const full = reportStep('population_read', 100);
  full.context_outputs = membership
    ? [{ key: 'previous_population', path: ROWS }]
    : [{ key: 'previous_best_spend', path: `${ROWS}[0].spend` }, { key: 'previous_best_kind', path: `${ROWS}[0].format_kind` }];
  const limited = reportStep('limited_read', 1);
  if (membership) {
    limited.validations.push(v('refs_resolve', {
      source: { from: 'current_step', path: `${ROWS}[*]` }, target: { from: 'context', path: 'previous_population[*]' },
      match_keys: ['format_kind', 'spend'],
    }, 'Limited rows belong to the earlier population'));
  } else {
    limited.validations.push(
      v('field_equals_context', { path: `${ROWS}[0].spend`, context_key: 'previous_best_spend' }, 'Limited best spend equals earlier full-read best'),
      v('field_equals_context', { path: `${ROWS}[0].format_kind`, context_key: 'previous_best_kind' }, 'Limited best kind equals earlier full-read best'),
    );
  }
  return board([{ id: 'reads', title: 'Two independent report observations', steps: [full, limited] }]);
}

function transport(observations, { tamperEcho = false } = {}) {
  const calls = [];
  const rpc = [];
  let readIndex = 0;
  const trustedFetchFn = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    assert.equal(url.origin, new URL(ENDPOINT).origin, 'only in-memory MCP interception is used');
    const message = JSON.parse(init.body);
    rpc.push(message.method);
    let result;
    if (message.method === 'initialize') {
      result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'sort-evidence', version: '1' } };
    } else if (message.method.startsWith('notifications/')) {
      return new Response(null, { status: 202 });
    } else if (message.method === 'tools/list') {
      result = { tools: TOOLS.map(name => ({ name, description: name, inputSchema: { type: 'object', additionalProperties: true } })) };
    } else if (message.method === 'tools/call') {
      const { name, arguments: request } = message.params;
      calls.push({ task: name, request: structuredClone(request) });
      let data;
      if (name === 'get_adcp_capabilities') {
        const context = structuredClone(request.context);
        if (tamperEcho && context?.observed_rows) context.observed_rows.sort((a, b) => a.spend - b.spend);
        data = { ...CAPS, context };
      } else if (name === 'get_media_buy_delivery') {
        const observed = observations[readIndex++];
        assert.ok(observed, 'every report read has an independently supplied observation');
        const rows = structuredClone(observed.rows);
        const total = observed.total ?? rows.reduce((sum, item) => sum + item.spend, 0);
        data = {
          status: 'completed', reporting_period: { start: '2026-10-19T00:00:00Z', end: '2026-10-20T00:00:00Z' },
          media_buy_deliveries: [{ media_buy_id: 'buy', status: 'active', totals: { impressions: 1001, spend: total },
            by_package: [{ package_id: 'package', impressions: 1001, spend: total, pricing_model: 'cpm', rate: 10, currency: 'EUR',
              is_final: false, by_format: rows, by_format_truncated: observed.truncated ?? false,
              by_format_sorted_by: 'spend', by_format_sort_direction: 'asc' }] }],
          context: request.context,
        };
      } else assert.fail(`Unexpected task ${name}`);
      result = { content: [{ type: 'text', text: JSON.stringify(data) }] };
    } else assert.fail(`Unexpected method ${message.method}`);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }), { headers: { 'content-type': 'application/json' } });
  };
  return { calls, rpc, options: { adcpVersion: '3.2.5', timeout_ms: 3000,
    brand: { domain: 'acmeoutdoor.example' },
    profile: { tools: TOOLS, raw_capabilities: CAPS, supported_protocols: ['media_buy'] }, transport: { trustedFetchFn } } };
}

const steps = result => result.phases.flatMap(phase => phase.steps);
async function full(doc, observations, transportOptions) {
  const io = transport(observations, transportOptions);
  const result = await runStoryboard(ENDPOINT, doc, io.options);
  assert.ok(io.rpc.includes('initialize') && io.rpc.includes('tools/call'));
  return { result, ...io };
}

test('the installed public SDK is 15.9.5', () => assert.equal(require(path.join(ROOT, 'node_modules/@adcp/sdk/package.json')).version, '15.9.5'));

test('same-step captures become available after numeric validation, so a descending pair falsely passes', async () => {
  const step = reportStep();
  step.context_outputs = [{ key: 'second_spend', path: `${ROWS}[1].spend` }];
  step.validations.push(v('field_at_most', { path: `${ROWS}[0].spend`, context_key: 'second_spend' }, 'Attempt current-response comparison'));
  const { result } = await full(board([{ id: 'read', title: 'Read', steps: [step] }]), [{ rows: pair(20, 10) }]);
  assert.equal(result.overall_passed, true, JSON.stringify(result));
  const validation = steps(result)[0].validations.find(item => item.check === 'field_at_most');
  assert.ok(validation.observations.some(item => item.startsWith('context_key_absent:')));
  assert.equal(result.context.second_spend, 10);
});

test('validation-only followup cannot evaluate a captured report locally', async () => {
  const read = reportStep();
  read.context_outputs = [{ key: 'second_spend', path: `${ROWS}[1].spend` }];
  const doc = board([{ id: 'read', title: 'Read', steps: [read, { id: 'local_compare', title: 'Local check', validations: [
    v('field_at_most', { path: `${ROWS}[0].spend`, context_key: 'second_spend' }, 'Attempt a local comparison'),
  ] }] }]);
  const { result } = await full(doc, [{ rows: pair(20, 10) }]);
  assert.equal(steps(result).find(step => step.step_id === 'local_compare').skip_reason, 'fixture_unavailable');
  assert.equal(result.overall_passed, true, JSON.stringify(result));
});

test('phase conditions reject numeric order and any_of is contribution membership, not arithmetic', async () => {
  const doc = sameSnapshotBoard();
  doc.phases[1].skip_if = 'context.first_spend <= context.second_spend';
  assert.throws(() => parseStoryboard(JSON.stringify(doc)), /skip_if/);
  const read = reportStep();
  read.validations.push(v('any_of', { allowed_values: ['first_spend <= second_spend'] }, 'Attempt arithmetic as a branch flag'));
  const { result } = await full(board([{ id: 'read', title: 'Read', steps: [read] }]), [{ rows: pair(10, 20) }]);
  assert.equal(result.overall_passed, false);
  assert.equal(steps(result)[0].validations.find(item => item.check === 'any_of').passed, false);
});

test('full same-snapshot echo checks allow sorted pairs, ties, empty rows and one row', async () => {
  for (const rows of [pair(10, 20), pair(10, 10), pair(0, 0), pair(0.1, 0.2), [], [row('image', 10)]]) {
    const { result, calls } = await full(sameSnapshotBoard(), [{ rows }]);
    assert.equal(result.overall_passed, true, JSON.stringify(result));
    assert.equal(calls.filter(call => call.task === 'get_media_buy_delivery').length, 1);
    const compared = steps(result).find(step => step.step_id === 'compare_pair');
    if (rows.length === 2) {
      assert.equal(compared.passed, true);
      assert.ok(compared.validations.some(item => item.check === 'field_at_most' && item.passed && !item.observations));
    } else {
      assert.equal(calls.some(call => call.task === 'get_adcp_capabilities' && Object.hasOwn(call.request.context ?? {}, 'observed_rows')), false);
      assert.equal(compared, undefined, 'the full runner omits steps in the skipped phase');
    }
  }
});

test('full same-snapshot echo checks reject a descending pair without another delivery read', async () => {
  const { result, calls } = await full(sameSnapshotBoard(), [{ rows: pair(20, 10) }]);
  assert.equal(result.overall_passed, false, JSON.stringify(result));
  assert.equal(calls.filter(call => call.task === 'get_media_buy_delivery').length, 1);
  assert.ok(steps(result).find(step => step.step_id === 'compare_pair').validations.some(item => item.check === 'field_at_most' && !item.passed));
});

test('snapshot echo tampering cannot turn an unsorted report into a pass', async () => {
  const { result } = await full(sameSnapshotBoard(), [{ rows: pair(20, 10) }], { tamperEcho: true });
  assert.equal(result.overall_passed, false, JSON.stringify(result));
  assert.ok(steps(result).find(step => step.step_id === 'capture_pair').validations.some(item => item.check === 'field_equals_context' && !item.passed));
});

test('the actual source limit assertion rejects three rows under limit two', async () => {
  const { result } = await full(sameSnapshotBoard(), [{ rows: population(5, 10, 20), truncated: false }]);
  assert.equal(result.overall_passed, false, JSON.stringify(result));
  assert.ok(steps(result)[0].validations.some(item => item.check === 'array_length' && item.path === ROWS && !item.passed));
});

test('same-read order and limit cannot reveal an omitted better hidden row', async () => {
  // Actual population is [5,10,20], but the seller returns the ordered wrong
  // limited subset [10,20]. A comparator sees no independent hidden-population oracle.
  const { result } = await full(sameSnapshotBoard(), [{ rows: pair(10, 20), total: 35, truncated: true }]);
  assert.equal(result.overall_passed, true, JSON.stringify(result));
});

test('public standalone steps can carry the same-read snapshot and reject descending pairs', async () => {
  for (const [a, b, expected] of [[10, 20, true], [20, 10, false]]) {
    const doc = sameSnapshotBoard();
    const io = transport([{ rows: pair(a, b) }]);
    const read = await runStoryboardStep(ENDPOINT, doc, 'report', io.options);
    assert.equal(read.passed, true, JSON.stringify(read));
    const capture = await runStoryboardStep(ENDPOINT, doc, 'capture_pair', { ...io.options, context: read.context, context_provenance: read.context_provenance });
    assert.equal(capture.passed, true, JSON.stringify(capture));
    const compared = await runStoryboardStep(ENDPOINT, doc, 'compare_pair', { ...io.options, context: capture.context, context_provenance: capture.context_provenance });
    assert.equal(compared.passed, expected, JSON.stringify(compared));
    assert.equal(io.calls.filter(call => call.task === 'get_media_buy_delivery').length, 1);
  }
});

test('standalone ignores enclosing cardinality skip_if and fails legal empty/one-row snapshots', async () => {
  for (const rows of [[], [row('image', 10)]]) {
    const doc = sameSnapshotBoard();
    const io = transport([{ rows }]);
    const read = await runStoryboardStep(ENDPOINT, doc, 'report', io.options);
    assert.equal(read.passed, true, JSON.stringify(read));
    const capture = await runStoryboardStep(ENDPOINT, doc, 'capture_pair', { ...io.options, context: read.context });
    assert.equal(capture.passed, false, JSON.stringify(capture));
    assert.ok(capture.validations.some(item => item.check === 'capture_path_not_resolvable' && !item.passed), JSON.stringify(capture));
  }
});

test('cross-read best comparison passes stable data and detects one omitted-best counterexample', async () => {
  for (const [limitedSpend, expected] of [[5, true], [10, false]]) {
    const limited = row(limitedSpend === 5 ? 'image' : 'video_hosted', limitedSpend);
    const { result } = await full(crossReadBoard(), [
      { rows: population(5, 10, 20), total: 35 }, { rows: [limited], total: 35, truncated: true },
    ]);
    assert.equal(result.overall_passed, expected, JSON.stringify(result));
  }
});

test('cross-read best comparison falsely fails legal changed observations with the same report period', async () => {
  // Both reads are internally sorted and truthful; the second nonfinal
  // population has become [8,9,21]. The ordinary GET contract freezes neither read.
  const { result } = await full(crossReadBoard(), [
    { rows: population(5, 10, 20), total: 35 },
    { rows: [row('image', 8)], total: 38, truncated: true },
  ]);
  assert.equal(result.overall_passed, false, JSON.stringify(result));
  assert.ok(steps(result).find(step => step.step_id === 'limited_read').validations.some(item => item.check === 'field_equals_context' && !item.passed));
});

test('cross-read reference membership misses a stable omitted-best row', async () => {
  const { result } = await full(crossReadBoard(true), [
    { rows: population(5, 10, 20), total: 35 }, { rows: [row('video_hosted', 10)], total: 35, truncated: true },
  ]);
  assert.equal(result.overall_passed, true, JSON.stringify(result));
});

test('cross-read reference membership also falsely fails legal changed values', async () => {
  const { result } = await full(crossReadBoard(true), [
    { rows: population(5, 10, 20), total: 35 }, { rows: [row('image', 8)], total: 38, truncated: true },
  ]);
  assert.equal(result.overall_passed, false, JSON.stringify(result));
  assert.ok(steps(result).find(step => step.step_id === 'limited_read').validations.some(item => item.check === 'refs_resolve' && !item.passed));
});
