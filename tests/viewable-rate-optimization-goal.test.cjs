const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Ajv = require('ajv');

const SCHEMA_ROOT = path.join(__dirname, '..', 'static', 'schemas', 'source');

async function loadSchema(uri) {
  assert.match(uri, /^\/schemas\//);
  return JSON.parse(
    fs.readFileSync(path.join(SCHEMA_ROOT, uri.slice('/schemas/'.length)), 'utf8')
  );
}

async function compile(uri) {
  const ajv = new Ajv({ allErrors: true, strict: false, loadSchema });
  return ajv.compileAsync(await loadSchema(uri));
}

const GOAL_SCHEMAS = ['/schemas/core/optimization-goal.json', '/schemas/core/canonical-optimization-goal.json'];

const viewabilityGoal = {
  kind: 'metric',
  metric: 'viewable_rate',
  standard: 'mrc',
  vendor: { domain: 'acmeverify.example' },
  target: { kind: 'threshold_rate', value: 0.7 },
  priority: 2,
};

test('legacy goal rejects cost_per targets on viewable_rate', async () => {
  const validate = await compile('/schemas/core/optimization-goal.json');
  assert.equal(validate({ ...viewabilityGoal, target: { kind: 'cost_per', value: 0.5 } }), false);
  assert.equal(validate({ kind: 'metric', metric: 'clicks', target: { kind: 'cost_per', value: 2.5 } }), true);
});

for (const uri of GOAL_SCHEMAS) {
  test(`${uri} accepts a viewable_rate goal with standard and vendor`, async () => {
    const validate = await compile(uri);
    assert.equal(validate(viewabilityGoal), true, JSON.stringify(validate.errors));
    const { vendor, ...withoutVendor } = viewabilityGoal;
    assert.equal(validate(withoutVendor), true, JSON.stringify(validate.errors));
  });

  test(`${uri} requires standard on viewable_rate goals`, async () => {
    const validate = await compile(uri);
    const { standard, ...goal } = viewabilityGoal;
    assert.equal(validate(goal), false);
    assert.equal(validate({ ...viewabilityGoal, standard: 'custom' }), false);
  });

  test(`${uri} bounds viewable_rate threshold to a proportion`, async () => {
    const validate = await compile(uri);
    assert.equal(validate({ ...viewabilityGoal, target: { kind: 'threshold_rate', value: 1 } }), true);
    assert.equal(validate({ ...viewabilityGoal, target: { kind: 'threshold_rate', value: 70 } }), false);
  });

  test(`${uri} allows viewability standard and vendor on viewed_seconds only as options`, async () => {
    const validate = await compile(uri);
    const goal = { kind: 'metric', metric: 'viewed_seconds', target: { kind: 'threshold_rate', value: 3 } };
    assert.equal(validate(goal), true, JSON.stringify(validate.errors));
    assert.equal(
      validate({ ...goal, standard: 'groupm', vendor: { domain: 'acmeverify.example' } }),
      true,
      JSON.stringify(validate.errors)
    );
  });

  test(`${uri} rejects viewability standard and vendor on other metrics`, async () => {
    const validate = await compile(uri);
    assert.equal(validate({ kind: 'metric', metric: 'views', standard: 'mrc' }), false);
    assert.equal(validate({ kind: 'metric', metric: 'clicks', vendor: { domain: 'acmeverify.example' } }), false);
  });

  test(`${uri} leaves other metric thresholds unbounded`, async () => {
    const validate = await compile(uri);
    const goal = { kind: 'metric', metric: 'viewed_seconds', target: { kind: 'threshold_rate', value: 3 } };
    assert.equal(validate(goal), true, JSON.stringify(validate.errors));
  });
}

test('seller optimization capabilities can declare viewable_rate and supported standards', async () => {
  const product = await loadSchema('/schemas/core/product.json');
  const metricOptimization = product.properties.metric_optimization.properties;
  assert.ok(metricOptimization.supported_metrics.items.enum.includes('viewable_rate'));
  assert.equal(
    metricOptimization.supported_viewability_standards.items.$ref,
    '/schemas/enums/viewability-standard.json'
  );

  const capabilities = await loadSchema('/schemas/protocol/get-adcp-capabilities-response.json');
  const rollup = JSON.stringify(capabilities).match(/"supported_optimization_metrics":\{[^}]*"enum":\[([^\]]*)\]/);
  assert.ok(rollup, 'supported_optimization_metrics enum not found');
  assert.match(rollup[1], /"viewable_rate"/);
});
