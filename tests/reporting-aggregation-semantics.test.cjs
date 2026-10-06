'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const ROOT = path.resolve(__dirname, '..');
const SCHEMA_ROOT = path.join(ROOT, 'static/schemas/source');
const FIXTURE_ROOT = path.join(ROOT, 'static/compliance/source/test-vectors/reporting-reconciliation');

function readSchema(uri) {
  return JSON.parse(fs.readFileSync(path.join(SCHEMA_ROOT, uri.slice('/schemas/'.length)), 'utf8'));
}

async function compileDefinitionSchema() {
  const ajv = new Ajv({ allErrors: true, strict: false, loadSchema: async ref => readSchema(ref) });
  addFormats(ajv);
  return ajv.compileAsync(readSchema('/schemas/core/reporting-report-definition.json'));
}

function sameJson(left, right) {
  return JSON.stringify(sortKeys(left)) === JSON.stringify(sortKeys(right));
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortKeys(value[key])]));
  }
  return value;
}

// Reference implementation of the normative rules in reporting-report-definition.json
// x-adcp-validation.aggregation_semantics. It exists to make the vectors executable.
const TOLERANCE = 1e-9;

function createEvaluator(definition, unionDefinitions) {
  const metrics = new Map(definition.metrics.map(metric => [metric.name, metric]));

  function metricOrThrow(name) {
    const metric = metrics.get(name);
    assert.ok(metric, `vector names an unknown metric: ${name}`);
    return metric;
  }

  function differingFields(left, right) {
    const differing = [];
    if (left.unit !== right.unit) differing.push('unit');
    const a = left.aggregation_semantics.comparability;
    const b = right.aggregation_semantics.comparability;
    for (const field of ['population', 'window_basis', 'window_duration']) {
      if (!sameJson(a[field] ?? null, b[field] ?? null)) differing.push(field);
    }
    if (!sameJson(a.qualifier ?? {}, b.qualifier ?? {})) differing.push('qualifier');
    return differing;
  }

  function refusal(metric) {
    const semantics = metric.aggregation_semantics;
    if (!semantics) return { result: 'refused', reason: 'unsafe_legacy_aggregation' };
    if (semantics.kind === 'opaque') return { result: 'refused', reason: 'opaque' };
    if (semantics.kind === 'non_additive_unique') return { result: 'refused', reason: 'non_additive_unique' };
    return undefined;
  }

  function byFinality(items, valueOf) {
    const partitions = new Map();
    for (const item of items) {
      partitions.set(item.finality, [...(partitions.get(item.finality) ?? []), item]);
    }
    return [...partitions].map(([finality, members]) => ({ finality, value: valueOf(members) }));
  }

  function combine({ contributions }) {
    if (new Set(contributions.map(item => item.report_definition_sha256 ?? null)).size > 1) {
      return { result: 'refused', reason: 'different_report_definition' };
    }
    const [first, ...rest] = contributions;
    const firstMetric = metricOrThrow(first.metric);
    const refused = refusal(firstMetric);
    if (refused) return refused;
    const differing = new Set();
    for (const contribution of rest) {
      const metric = metricOrThrow(contribution.metric);
      const metricRefusal = refusal(metric);
      if (metricRefusal) return metricRefusal;
      for (const field of differingFields(firstMetric, metric)) differing.add(field);
    }
    if (differing.size) {
      return { result: 'refused', reason: 'incompatible_comparability', differing: [...differing] };
    }
    const sum = members => members.reduce((total, item) => total + item.value, 0);
    const finalities = new Set(contributions.map(item => item.finality));
    if (finalities.size > 1) return { result: 'partitioned', partitions: byFinality(contributions, sum) };
    return { result: 'aggregated', value: sum(contributions) };
  }

  function recomputeRatio({ metric: name, rows }) {
    const ratio = metricOrThrow(name);
    const semantics = ratio.aggregation_semantics;
    assert.equal(semantics.kind, 'recomputable_ratio');
    const numerator = metricOrThrow(semantics.numerator_metric);
    const denominator = metricOrThrow(semantics.denominator_metric);
    assert.equal(numerator.aggregation_semantics.kind, 'additive');
    assert.equal(denominator.aggregation_semantics.kind, 'additive');
    const compute = members => {
      const operands = members.flatMap(row => [row.values[semantics.numerator_metric], row.values[semantics.denominator_metric]]);
      if (operands.some(value => value === null || value === undefined)) return { computable: false };
      const top = members.reduce((sum, row) => sum + row.values[semantics.numerator_metric], 0);
      const bottom = members.reduce((sum, row) => sum + row.values[semantics.denominator_metric], 0);
      if (bottom === 0) {
        if (semantics.zero_denominator === 'null') return { computable: true, value: null };
        if (semantics.zero_denominator === 'zero') return { computable: true, value: 0 };
        return { computable: false };
      }
      return { computable: true, value: (semantics.multiplier ?? 1) * top / bottom };
    };
    const finalities = new Set(rows.map(row => row.finality));
    if (finalities.size > 1) {
      const partitions = byFinality(rows, members => compute(members).value);
      return { result: 'partitioned', partitions };
    }
    const computed = compute(rows);
    return computed.computable ? { result: 'aggregated', value: computed.value } : { result: 'not_computable' };
  }

  function aggregateUnique({ metric: name, constituents, combined }) {
    const metric = metricOrThrow(name);
    assert.equal(metric.aggregation_semantics.kind, 'non_additive_unique');
    const bound = {
      result: 'bound',
      bound: 'sum_of_constituent_reach',
      value: constituents.reduce((sum, item) => sum + item.value, 0),
      may_feed_frequency: false,
    };
    if (!combined) return bound;
    const unionDefinition = unionDefinitions[combined.union_report_definition];
    assert.ok(unionDefinition, `unknown union definition ${combined.union_report_definition}`);
    const combinedMetric = unionDefinition.metrics.find(item => item.name === combined.metric);
    const wanted = metric.aggregation_semantics;
    const offered = combinedMetric.aggregation_semantics;
    const sameSemantics = sameJson(wanted, offered) && metric.unit === combinedMetric.unit;
    const coversUnion = constituents.every(item => item.media_buy_ids.every(id => combined.media_buy_ids.includes(id)));
    if (sameSemantics && coversUnion) return { result: 'unique', value: combined.value, may_feed_frequency: true };
    return bound;
  }

  return { combine, recompute_ratio: recomputeRatio, aggregate_unique: aggregateUnique };
}

function approximately(actual, expected, label) {
  if (typeof expected === 'number' && typeof actual === 'number') {
    assert.ok(Math.abs(actual - expected) <= TOLERANCE, `${label}: ${actual} != ${expected}`);
    return;
  }
  if (Array.isArray(expected)) {
    assert.equal(actual.length, expected.length, label);
    expected.forEach((item, index) => approximately(actual[index], item, `${label}[${index}]`));
    return;
  }
  if (expected && typeof expected === 'object') {
    assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), label);
    for (const key of Object.keys(expected)) approximately(actual[key], expected[key], `${label}.${key}`);
    return;
  }
  assert.equal(actual, expected, label);
}

function assertMatches(actual, expected, label) {
  const { not_value: notValues = [], ...rest } = expected;
  approximately(actual, rest, label);
  for (const forbidden of notValues) {
    assert.ok(Math.abs(actual.value - forbidden) > TOLERANCE, `${label}: must not equal ${forbidden}`);
  }
}

test('aggregation-semantics vectors execute against the report definition schema', async () => {
  const validate = await compileDefinitionSchema();
  const fixture = JSON.parse(fs.readFileSync(path.join(FIXTURE_ROOT, 'aggregation-semantics.json'), 'utf8'));

  assert.equal(validate(fixture.report_definition), true, JSON.stringify(validate.errors));
  for (const [name, union] of Object.entries(fixture.union_report_definitions)) {
    assert.equal(validate(union), true, `${name}: ${JSON.stringify(validate.errors)}`);
  }

  // Cross-metric rules that JSON Schema cannot express (x-adcp-validation.aggregation_semantics).
  const byName = new Map(fixture.report_definition.metrics.map(metric => [metric.name, metric]));
  assert.equal(byName.size, fixture.report_definition.metrics.length, 'metric names must be unique');
  for (const metric of fixture.report_definition.metrics) {
    const semantics = metric.aggregation_semantics;
    if (semantics?.kind !== 'recomputable_ratio') continue;
    for (const operand of [semantics.numerator_metric, semantics.denominator_metric]) {
      assert.notEqual(operand, metric.name, `${metric.name}: operand must be a different metric`);
      assert.equal(byName.get(operand)?.aggregation_semantics?.kind, 'additive', `${metric.name}: operand ${operand} must be additive`);
    }
  }

  const evaluator = createEvaluator(fixture.report_definition, fixture.union_report_definitions);
  const issueExamples = fixture.vectors.map(vector => vector.issue_example);
  assert.deepEqual(issueExamples, [1, 2, 3, 4, 5, 6], 'one vector per acceptance example in the issue');
  assert.equal(new Set(fixture.vectors.map(vector => vector.id)).size, fixture.vectors.length);

  let executed = 0;
  for (const vector of fixture.vectors) {
    for (const vectorCase of vector.cases) {
      const label = `${vector.id}/${vectorCase.id}`;
      if (vectorCase.operation === 'validate_definition') {
        const candidate = { ...structuredClone(fixture.report_definition), ...structuredClone(vectorCase.override) };
        assert.equal(validate(candidate), vectorCase.expected.valid, `${label}: ${JSON.stringify(validate.errors)}`);
      } else {
        assert.ok(evaluator[vectorCase.operation], `${label}: unknown operation ${vectorCase.operation}`);
        assertMatches(evaluator[vectorCase.operation](vectorCase), vectorCase.expected, label);
      }
      executed += 1;
    }
  }
  assert.ok(executed >= 30);
});
