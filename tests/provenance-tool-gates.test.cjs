const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const YAML = require('yaml');

const SCENARIOS = [
  'provenance_enforcement',
  'provenance_truth_of_claim',
  'provenance_audit_observation',
];

test('provenance scenarios gate every optional-tool step by that tool', () => {
  let creativeSteps = 0;
  let controllerSteps = 0;

  for (const scenarioName of SCENARIOS) {
    const scenarioPath = path.join(
      process.cwd(),
      'static/compliance/source/protocols/media-buy/scenarios',
      `${scenarioName}.yaml`,
    );
    const scenario = YAML.parse(fs.readFileSync(scenarioPath, 'utf8'));
    for (const step of scenario.phases.flatMap((phase) => phase.steps)) {
      if (step.task === 'sync_creatives') {
        creativeSteps++;
        assert.equal(step.requires_tool, 'sync_creatives', `${scenario.id}/${step.id}`);
      }
      if (step.task === 'comply_test_controller') {
        controllerSteps++;
        assert.equal(step.requires_tool, 'comply_test_controller', `${scenario.id}/${step.id}`);
      }
    }
  }

  assert.equal(creativeSteps, 8);
  assert.equal(controllerSteps, 2);
});
