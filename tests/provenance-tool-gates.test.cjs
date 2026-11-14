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

test('provenance scenarios gate every optional-tool step by the tool it depends on', () => {
  let creativeSteps = 0;
  let controllerSteps = 0;

  for (const scenarioName of SCENARIOS) {
    const scenarioPath = path.join(
      process.cwd(),
      'static/compliance/source/protocols/media-buy/scenarios',
      `${scenarioName}.yaml`,
    );
    const scenario = YAML.parse(fs.readFileSync(scenarioPath, 'utf8'));
    for (const phase of scenario.phases) {
      for (const step of phase.steps) {
        if (step.task === 'sync_creatives') {
          creativeSteps++;
          assert.equal(step.requires_tool, 'sync_creatives', `${scenario.id}/${step.id}`);
        }
        if (step.task === 'comply_test_controller') {
          controllerSteps++;
          // Audit reads consume the state sync_creatives creates, so they name
          // that tool; the storyboard-level controller requirement covers the
          // controller itself. A separate phase keeps a skipped sync from
          // cascading onto them on runners that grade the cascade first.
          assert.equal(step.requires_tool, 'sync_creatives', `${scenario.id}/${step.id}`);
          assert.ok(scenario.requires.includes('controller'), scenario.id);
          assert.ok(
            !phase.steps.some(peer => peer.task === 'sync_creatives'),
            `${scenario.id}/${step.id} shares a phase with the sync it depends on`
          );
        }
      }
    }
  }

  assert.equal(creativeSteps, 8);
  assert.equal(controllerSteps, 2);
});
