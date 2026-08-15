'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const ROOT = path.resolve(__dirname, '..');
const STORYBOARD_PATH = path.join(
  ROOT,
  'static/compliance/source/specialisms/signal-marketplace/scenarios/governance_denied.yaml',
);

function loadStoryboard() {
  return yaml.load(fs.readFileSync(STORYBOARD_PATH, 'utf8'));
}

function stepsById(doc) {
  return new Map(
    (doc.phases || []).flatMap((phase) => phase.steps || []).map((step) => [step.id, step]),
  );
}

test('signal governance denial is task-gated and proves no deployment side effect', () => {
  const doc = loadStoryboard();
  const steps = stepsById(doc);
  const discovery = steps.get('get_signals_list');
  const denied = steps.get('activate_signal_denied');

  assert.deepEqual(doc.requires_capability, {
    path: 'adcp.governance_enforcement.tasks',
    contains: {
      task: 'activate_signal',
      modes: ['signed_context'],
    },
  });
  for (const tool of ['sync_accounts', 'sync_governance', 'get_signals', 'activate_signal']) {
    assert.ok(doc.required_tools.includes(tool), `${tool} must be declared`);
  }

  assert.equal(
    discovery.context_outputs.find((capture) => capture.key === 'pricing_option_id')?.path,
    'signals[0].pricing_options[0].pricing_option_id',
  );
  assert.equal(denied.sample_request.action, 'activate');
  assert.equal(denied.sample_request.pricing_option_id, '$context.pricing_option_id');
  assert.equal(denied.sample_request.governance_context, undefined);
  assert.equal(
    denied.validations.find((validation) => validation.check === 'error_code')?.value,
    'PERMISSION_DENIED',
  );

  const noDeployment = denied.validations.find(
    (validation) => validation.check === 'upstream_traffic',
  );
  assert.deepEqual(noDeployment, {
    check: 'upstream_traffic',
    description: 'Rejected activation causes no platform-primary outbound deployment call',
    min_count: 0,
    endpoint_pattern: 'POST *',
    purpose_filter: ['platform_primary'],
  });
  assert.equal(
    denied.validations.some(
      (validation) => validation.check === 'field_present' && validation.path === 'context',
    ),
    false,
    'response context echo must not be graded as governance evidence',
  );
});
