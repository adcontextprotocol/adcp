const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const YAML = require('yaml');

const SCENARIOS = ['governance_approved', 'governance_conditions'];

const GOVERNANCE_TASKS = new Set([
  'sync_plans',
  'check_governance',
  'get_plan_audit_logs',
  'report_plan_outcome',
]);

for (const scenarioName of SCENARIOS) {
  test(`${scenarioName} routes each role and carries its plan ID through governance`, () => {
    const scenarioPath = path.join(
      process.cwd(),
      'static/compliance/source/protocols/media-buy/scenarios',
      `${scenarioName}.yaml`,
    );
    const scenario = YAML.parse(fs.readFileSync(scenarioPath, 'utf8'));
    const steps = scenario.phases.flatMap((phase) => phase.steps);
    const syncPlans = steps.find((step) => step.id === 'sync_plans');
    const planBoundGovernanceSteps = steps.filter(
      (step) => ['check_governance', 'report_plan_outcome'].includes(step.task),
    );

    assert.deepEqual(scenario.requires, ['multi_agent']);
    assert.equal(scenario.default_agent, 'sales');
    assert.equal(syncPlans.agent, 'governance');
    assert.ok(
      syncPlans.context_outputs.some(
        (output) => output.name === 'plan_id' && output.path === 'plans[0].plan_id',
      ),
    );
    assert.ok(planBoundGovernanceSteps.length > 0);
    for (const step of planBoundGovernanceSteps) {
      assert.equal(step.sample_request.plan_id, '$context.plan_id');
    }

    for (const step of steps) {
      const expectedAgent = GOVERNANCE_TASKS.has(step.task) ? 'governance' : 'sales';
      assert.equal(step.agent, expectedAgent, `${step.id} must route to the ${expectedAgent} agent`);
    }
  });
}
