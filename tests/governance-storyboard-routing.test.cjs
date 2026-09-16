const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const YAML = require('yaml');

const SCENARIOS = ['governance_approved', 'governance_conditions'];

for (const scenarioName of SCENARIOS) {
  test(`${scenarioName} routes the governance setup and carries its plan ID`, () => {
    const scenarioPath = path.join(
      process.cwd(),
      'static/compliance/source/protocols/media-buy/scenarios',
      `${scenarioName}.yaml`,
    );
    const scenario = YAML.parse(fs.readFileSync(scenarioPath, 'utf8'));
    const steps = scenario.phases.flatMap((phase) => phase.steps);
    const syncPlans = steps.find((step) => step.id === 'sync_plans');
    const createMediaBuy = steps.find((step) => step.task === 'create_media_buy');

    assert.deepEqual(scenario.requires, ['multi_agent']);
    assert.equal(scenario.default_agent, 'sales');
    assert.equal(syncPlans.agent, 'governance');
    assert.ok(
      syncPlans.context_outputs.some(
        (output) => output.name === 'plan_id' && output.path === 'plans[0].plan_id',
      ),
    );
    assert.equal(createMediaBuy.agent, 'sales');
    assert.equal(createMediaBuy.sample_request.plan_id, '$context.plan_id');

    for (const step of steps.filter((candidate) => candidate !== syncPlans)) {
      assert.equal(step.agent, 'sales', `${step.id} must route to the sales agent`);
    }
  });
}
