'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  getAssertion,
  listAssertions,
  runStoryboard: runSdkStoryboard,
} = require('@adcp/sdk/testing');
const {
  runCatalogReportingStoryboard: runStoryboard,
  runCatalogReportingStoryboardStep: runStoryboardStep,
} = require('../server/src/compliance/catalog-reporting-runner.ts');
const {
  FIELD_EXCLUDES_ASSERTION_ID,
  FIELD_EXCLUDES_RUNNER_CONTRACT,
  gradeStandaloneExclusions,
  withExclusionSupport,
} = require('../server/src/compliance/storyboard-exclusion-check.ts');

const url = 'https://seller.example/mcp';
const validation = {
  check: 'field_excludes', path: 'products[*].product_id', value: 'negative',
  description: 'The display negative control is absent',
};

function storyboard(check = validation, dependent = false) {
  return {
    id: 'exclusion_compatibility', version: '1.0', title: 'Exclusion compatibility',
    requires: [FIELD_EXCLUDES_RUNNER_CONTRACT],
    context: { prior_source: 'authored' },
    phases: [{ id: 'discovery', title: 'Discovery', steps: [{
      id: 'filter', title: 'Filter products', task: 'get_products', stateful: true,
      contributes_to: 'discovered',
      sample_request: { buying_mode: 'brief', brief: 'Find OLV inventory' },
      context_outputs: [{ key: 'returned_id', path: 'products[0].product_id' }],
      validations: [check],
    }] }, ...(dependent ? [{ id: 'dependent', title: 'Dependent', depends_on: ['discovery'], steps: [{
      id: 'consume', title: 'Consume discovery', task: 'get_products', stateful: true,
      sample_request: { buying_mode: 'brief', brief: 'Use $context.returned_id' },
      validations: [{ check: 'field_present', path: 'products' }],
    }] }] : [])],
  };
}

function seller(products) {
  const calls = [];
  const data = { products, context: { seller_marker: 'unchanged' } };
  return {
    calls, data,
    options: {
      protocol: 'mcp', agentTools: ['get_products'], _profile: { tools: ['get_products'] },
      _client: { resetContext() {}, async getProducts(request) {
        calls.push(structuredClone(request));
        return { success: true, data: structuredClone(data) };
      } },
    },
  };
}

test('the installed SDK natively grades the authored exclusion requirement', async () => {
  const board = storyboard();
  const endpoint = seller([{ product_id: 'negative' }]);
  const result = await runSdkStoryboard(url, board, endpoint.options);
  assert.equal(result.overall_passed, false);
  assert.equal(result.failed_count, 1);
  const grade = result.phases[0].steps[0].validations.find(check => check.check === 'field_excludes');
  assert.equal(grade.passed, false);
  assert.equal(grade.not_applicable, undefined);
  assert.equal(endpoint.calls.length, 1);
});

test('unknown runner requirements still skip before any seller dispatch', async () => {
  const board = storyboard();
  board.requires.push('unavailable_exclusion_contract');
  const endpoint = seller([{ product_id: 'positive' }]);
  const result = await runSdkStoryboard(url, board, endpoint.options);
  assert.equal(result.phases[0].steps[0].skip_reason, 'requirement_unmet');
  assert.match(result.phases[0].steps[0].skip.detail, /unavailable_exclusion_contract/);
  assert.equal(endpoint.calls.length, 0);
});

test('the adapter preserves SDK rejection of an unrelated empty requirements declaration', async () => {
  const board = storyboard();
  board.requires = [];
  const endpoint = seller([{ product_id: 'positive' }]);
  await assert.rejects(() => runSdkStoryboard(url, board, endpoint.options), /requires: \[\]/);
  await assert.rejects(() => runStoryboard(url, board, endpoint.options), /requires: \[\]/);
  assert.deepEqual(board.requires, []);
  assert.equal(endpoint.calls.length, 0);
});

test('the adapter grades extra and multi-channel products without changing source or seller evidence', async () => {
  const board = storyboard();
  const authored = structuredClone(board);
  const endpoint = seller([
    { product_id: 'extra', channels: ['display', 'olv'] },
    { product_id: 'positive', channels: ['olv'] },
  ]);
  const result = await runStoryboard(url, board, endpoint.options);
  assert.equal(result.overall_passed, true, JSON.stringify(result));
  assert.equal(result.passed_count, 1);
  assert.equal(result.failed_count, 0);
  assert.equal(result.validations_not_applicable ?? 0, 0);
  const step = result.phases[0].steps[0];
  assert.deepEqual(step.response, endpoint.data);
  assert.deepEqual(board, authored, 'authored runtime requirements remain portable');
  assert.deepEqual(step.validations.filter(check => check.check === 'field_excludes').map(check => [check.passed, check.not_applicable]), [[true, undefined]]);
});

test('a prohibited later product fails before dependent phases and does not credit discovery', async () => {
  const endpoint = seller([{ product_id: 'positive' }, { product_id: 'negative' }]);
  const result = await runStoryboard(url, storyboard(validation, true), endpoint.options);
  assert.equal(result.overall_passed, false);
  assert.equal(result.failed_count, 1);
  assert.equal(result.passed_count, 0);
  assert.equal(result.skipped_count, 1);
  assert.equal(endpoint.calls.length, 1);
  assert.equal(result.phases[1].steps[0].skip_reason, 'prerequisite_failed');
  assert.equal(result.contributions?.includes('discovered') ?? false, false);
  const grade = result.phases[0].steps[0].validations.find(check => check.check === 'field_excludes');
  assert.equal(grade.passed, false);
  assert.equal(grade.not_applicable, undefined);
  assert.deepEqual(grade.expected, { excludes: 'negative' });
  assert.ok(Array.isArray(grade.actual));
  assert.ok(grade.actual.includes('negative'));
  assert.ok(grade.actual.every(value => ['positive', 'negative'].includes(value)), 'diagnostic terminals come from the unchanged response');
  assert.deepEqual(result.phases[0].steps[0].response, endpoint.data);
});

test('empty arrays satisfy exclusions when the storyboard does not require a nonempty result', async () => {
  const board = storyboard();
  delete board.phases[0].steps[0].context_outputs;
  const result = await runStoryboard(url, board, seller([]).options);
  assert.equal(result.overall_passed, true, JSON.stringify(result));
  assert.equal(result.validations_not_applicable ?? 0, 0);
});

for (const malformed of [
  { path: undefined },
  { value: undefined },
  { value: undefined, allowed_values: [] },
  { allowed_values: 'negative' },
  { value: '$context.unavailable' },
]) {
  test(`malformed exclusion fails closed: ${JSON.stringify(malformed)}`, async () => {
    const board = storyboard({ ...validation, ...malformed });
    const result = await runStoryboard(url, board, seller([{ product_id: 'positive' }]).options);
    assert.equal(result.overall_passed, false, JSON.stringify(result));
    assert.equal(result.failed_count, 1);
    assert.equal(result.phases[0].steps[0].validations.find(check => check.check === 'field_excludes').passed, false);
  });
}

test('SDK subset matching, allowed_values and ordinary prior-step context are retained', async () => {
  const board = storyboard({ ...validation, path: 'products[*]', value: undefined, allowed_values: [{ product_id: '$context.negative_id', channels: ['display'] }] });
  const endpoint = seller([{ product_id: 'negative', channels: ['display', 'olv'], extra: true }]);
  const result = await runStoryboard(url, board, { ...endpoint.options, context: { negative_id: 'negative' } });
  assert.equal(result.overall_passed, false);
  assert.deepEqual(result.phases[0].steps[0].validations.find(check => check.check === 'field_excludes').expected, {
    excludes: [{ product_id: 'negative', channels: ['display'] }],
  });
});

test('advisory exclusion failures remain advisory and count in their own summary', async () => {
  const endpoint = seller([{ product_id: 'negative' }]);
  const result = await runStoryboard(url, storyboard({ ...validation, severity: 'advisory', permanent_advisory: { reason: 'Exercise advisory grading without making it a required contract' } }), endpoint.options);
  assert.equal(result.overall_passed, true, JSON.stringify(result));
  assert.equal(result.failed_count, 0);
  assert.equal(result.validations_advisory_failed, 1);
  assert.equal(result.validations_not_applicable ?? 0, 0);
});

test('standalone execution fails without publishing response-derived context or contribution credit', async () => {
  const board = storyboard();
  const endpoint = seller([{ product_id: 'negative' }]);
  const prior = {
    context: { retained: 'before', returned_id: 'previous' },
    context_provenance: { returned_id: { source_step_id: 'prior', source_kind: 'context_outputs' } },
    response_derived_not_applicable_context_keys: { previous_cursor: 'not_applicable' },
    contributions: ['prior_contribution'],
  };
  const result = await runStoryboardStep(url, board, 'filter', { ...endpoint.options, ...prior });
  assert.equal(result.passed, false);
  assert.deepEqual(result.context, { prior_source: 'authored', ...prior.context });
  assert.deepEqual(result.context_provenance, prior.context_provenance);
  assert.deepEqual(result.response_derived_not_applicable_context_keys, prior.response_derived_not_applicable_context_keys);
  assert.deepEqual(result.contributions, prior.contributions);
  assert.deepEqual(result.response, endpoint.data);
  assert.equal(result.validations.find(check => check.check === 'field_excludes').passed, false);
  assert.equal(result.next, undefined);
});

test('standalone advisory exclusions preserve successful response captures and contribution credit', async () => {
  const board = storyboard({ ...validation, severity: 'advisory', permanent_advisory: { reason: 'Advisory checks do not invalidate successful continuation state' } });
  const endpoint = seller([{ product_id: 'negative' }]);
  const result = await runStoryboardStep(url, board, 'filter', endpoint.options);
  assert.equal(result.passed, true, JSON.stringify(result));
  assert.equal(result.context.returned_id, 'negative');
  assert.equal(result.contributions.includes('discovered'), true);
  assert.equal(result.validations.find(check => check.check === 'field_excludes').passed, false);
  assert.deepEqual(result.response, endpoint.data);
});

test('native support avoids compatibility registration and is never graded twice', () => {
  const board = storyboard();
  withExclusionSupport(board, {});
  const assertion = getAssertion(FIELD_EXCLUDES_ASSERTION_ID);
  withExclusionSupport(board, {});
  assert.equal(getAssertion(FIELD_EXCLUDES_ASSERTION_ID), assertion);
  assert.equal(listAssertions().filter(id => id === FIELD_EXCLUDES_ASSERTION_ID).length, 0);
  const native = {
    step_id: 'filter', phase_id: 'discovery', task: 'get_products', title: 'Native result',
    passed: false, duration_ms: 0, context: {}, extraction: { path: 'none' },
    response: { products: [{ product_id: 'negative' }] },
    validations: [{ check: 'field_excludes', passed: false, description: validation.description, error: 'Native rejection' }],
  };
  const result = gradeStandaloneExclusions(board, native, url, {});
  assert.equal(result, native);
  assert.equal(result.validations.length, 1);
  assert.equal(result.validations[0].error, 'Native rejection');
});

test('a prohibited value beyond the SDK wildcard limit still fails', async () => {
  const products = Array.from({ length: 10_001 }, (_, index) => ({ product_id: index === 10_000 ? 'negative' : `positive-${index}` }));
  const endpoint = seller(products);
  const result = await runStoryboard(url, storyboard(), endpoint.options);
  assert.equal(result.overall_passed, false);
  assert.equal(result.failed_count, 1);
  const check = result.phases[0].steps[0].validations.find(value => value.check === 'field_excludes');
  assert.equal(check.actual.at(-1), 'negative');
});

test('standalone grading reads modern response_record evidence when response is absent', () => {
  const board = storyboard();
  const step = {
    step_id: 'filter', phase_id: 'discovery', task: 'get_products', title: 'Modern response',
    passed: true, duration_ms: 0, context: {}, extraction: { path: 'none' },
    response_record: { payload: { products: [{ product_id: 'negative' }] } },
    validations: [{ check: 'field_excludes', passed: true, not_applicable: true, description: validation.description }],
  };
  const evidence = structuredClone(step.response_record);
  assert.equal(gradeStandaloneExclusions(board, step, url, {}).passed, false);
  assert.deepEqual(step.response_record, evidence);
});

for (const standalone of [false, true]) {
  test(`a response cannot replace its own exclusion comparand (${standalone ? 'standalone' : 'full run'})`, async () => {
    const board = storyboard({ ...validation, value: '$context.negative_id' });
    board.context.negative_id = 'negative';
    board.phases[0].steps[0].context_outputs.push({ key: 'negative_id', path: 'context.seller_marker' });
    const endpoint = seller([{ product_id: 'negative' }]);
    const result = standalone
      ? await runStoryboardStep(url, board, 'filter', endpoint.options)
      : await runStoryboard(url, board, endpoint.options);
    assert.equal(standalone ? result.passed : result.overall_passed, false, JSON.stringify(result));
  });
}
