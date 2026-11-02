'use strict';

/**
 * Self-test of the SDK interop harness (tests/interop). It needs neither SDK:
 * it checks the scenario generator, the comparison and the minimizer against
 * the reference model and a deliberately wrong stand-in implementation.
 *
 *   node --test tests/interop/harness.test.cjs
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const { generateScenario, FLAVORS } = require('./differential/generate.cjs');
const { validateInput } = require('./differential/validate.cjs');
const { referenceOne, difference, signature } = require('./differential/implementations.cjs');
const { minimize } = require('./differential/minimize.cjs');

test('the generator is deterministic per seed', () => {
  for (const seed of [1, 2, 99, 123_456]) {
    assert.deepEqual(generateScenario(seed), generateScenario(seed));
  }
  assert.notDeepEqual(generateScenario(1).input, generateScenario(2).input);
});

test('generated scenarios are valid buyer inputs, except deliberately invalid ones', () => {
  const seen = new Set();
  let withRows = 0;
  for (let seed = 1; seed <= 300; seed += 1) {
    const scenario = generateScenario(seed);
    scenario.flavors.forEach(flavor => seen.add(flavor));
    if (!scenario.flavors.includes('invalid')) {
      assert.deepEqual(validateInput(scenario.input), [], `seed ${seed}`);
    }
    const result = referenceOne(scenario.input);
    if (result.ok && result.rows.length) withRows += 1;
  }
  assert.deepEqual([...seen].sort(), FLAVORS.map(([name]) => name).sort(), 'every flavor is generated');
  assert.ok(withRows > 150, `only ${withRows}/300 scenarios owe anything`);
});

test('difference compares rows as data and errors by code and detail', () => {
  const row = { subscription_version: 1, media_buy_id: 'mb_1', offering_id: 'o', period_start: '2026-01-01T00:00:00Z', period_end: '2026-01-02T00:00:00Z' };
  const ok = { ok: true, rows: [row], obligations: [] };
  assert.equal(difference(ok, structuredClone(ok)), null);
  assert.equal(difference(ok, { ok: true, rows: [], obligations: [] }).kind, 'rows');
  const error = detail => ({ ok: false, error: { kind: 'coverage_input', code: 'COVERAGE_INPUT_INVALID', detail, message: String(Math.random()) } });
  assert.equal(difference(error('invalid_timezone'), error('invalid_timezone')), null);
  assert.equal(difference(error('invalid_timezone'), error('invalid_input')).kind, 'error_vs_error');
  assert.equal(difference(ok, error('invalid_timezone')).kind, 'ok_vs_error');
  assert.equal(signature({ reference: ok, ts: ok, py: ok }), null);
  assert.equal(signature({ reference: ok, ts: ok, py: error('invalid_timezone') }), 'reference+ts(ok) | py(COVERAGE_INPUT_INVALID/invalid_timezone)');
});

test('the minimizer shrinks a disagreement and keeps its signature', async () => {
  // A stand-in implementation that drops mb_2's rows: it disagrees whenever mb_2 owes something.
  const wrong = input => {
    const result = referenceOne(input);
    return result.ok ? { ...result, rows: result.rows.filter(row => row.media_buy_id !== 'mb_2') } : result;
  };
  const impls = {
    async run(inputs) {
      return { reference: inputs.map(referenceOne), ts: inputs.map(referenceOne), py: inputs.map(wrong) };
    },
  };
  let seed = 1;
  let scenario;
  for (; seed < 500; seed += 1) {
    scenario = generateScenario(seed);
    if (scenario.flavors.includes('invalid')) continue;
    const ref = referenceOne(scenario.input);
    if (ref.ok && ref.rows.some(row => row.media_buy_id === 'mb_2') && scenario.input.buys.length === 3) break;
  }
  const reduced = await minimize(impls, scenario.input);
  assert.equal(reduced.signature, 'reference+ts(ok) | py(ok)');
  assert.ok(reduced.steps.length > 0);
  assert.deepEqual(reduced.input.buys.map(buy => buy.media_buy_id), ['mb_2'], `seed ${seed}`);
  assert.deepEqual(validateInput(reduced.input), []);
  const rows = referenceOne(reduced.input).rows;
  assert.ok(rows.length >= 1 && rows.length <= 2, `minimized to ${rows.length} rows`);
});
