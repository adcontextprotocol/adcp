'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const ROOT = path.resolve(__dirname, '..');
const STORYBOARD_PATH = path.join(
  ROOT,
  'static/compliance/source/protocols/media-buy/scenarios/governance_conditions.yaml',
);

function loadStoryboard() {
  return yaml.load(fs.readFileSync(STORYBOARD_PATH, 'utf8'));
}

function stepsById(doc) {
  return new Map(
    (doc.phases || []).flatMap((phase) => phase.steps || []).map((step) => [step.id, step]),
  );
}

function validation(step, check, pathName) {
  return (step.validations || []).find(
    (candidate) => candidate.check === check && candidate.path === pathName,
  );
}

test('governance conditions require a later approved intent before mutation', () => {
  const doc = loadStoryboard();
  const orderedSteps = (doc.phases || []).flatMap((phase) => phase.steps || []);
  const ids = orderedSteps.map((step) => step.id);
  const steps = stepsById(doc);

  assert.deepEqual(doc.requires, ['multi_agent']);
  assert.equal(doc.default_agent, 'sales');
  assert.deepEqual(doc.requires_capability, {
    path: 'media_buy.governance_aware',
    equals: true,
  });
  for (const tool of ['check_governance', 'create_media_buy', 'get_media_buys', 'report_plan_outcome']) {
    assert.ok(doc.required_tools.includes(tool), `${tool} must be declared`);
  }

  const conditioned = steps.get('check_governance_conditions');
  const adjusted = steps.get('check_governance_adjusted');
  const create = steps.get('create_media_buy_after_approval');
  assert.ok(conditioned && adjusted && create);
  assert.ok(ids.indexOf(conditioned.id) < ids.indexOf(adjusted.id));
  assert.ok(ids.indexOf(adjusted.id) < ids.indexOf(create.id));

  assert.equal(conditioned.task, 'check_governance');
  assert.equal(conditioned.agent, 'governance');
  assert.equal(conditioned.sample_request.tool, 'create_media_buy');
  assert.equal(conditioned.sample_request.target_agent, '$context.seller_agent_url');
  assert.ok(conditioned.sample_request.payload);
  assert.equal(conditioned.sample_request.governance_context, undefined);
  assert.equal(
    conditioned.context_outputs.find((capture) => capture.name === 'consultation_context')?.path,
    'consultation_context',
  );
  assert.equal(validation(conditioned, 'field_value', 'verdict')?.value, 'conditions');
  assert.equal(validation(conditioned, 'field_value', 'check_type')?.value, 'intent');
  assert.equal(
    validation(conditioned, 'field_value', 'conditions[0].field')?.value,
    'payload.ext.governance_policy_acknowledgements',
  );
  assert.ok(validation(conditioned, 'field_present', 'consultation_context'));
  assert.ok(validation(conditioned, 'field_absent', 'governance_context'));
  assert.ok(validation(conditioned, 'field_absent', 'expires_at'));

  assert.equal(adjusted.sample_request.consultation_context, '$context.consultation_context');
  assert.deepEqual(
    adjusted.sample_request.payload.ext.governance_policy_acknowledgements,
    ['ctv_weekly_reporting'],
  );
  assert.equal(validation(adjusted, 'field_value', 'verdict')?.value, 'approved');
  assert.ok(validation(adjusted, 'field_present', 'governance_context'));
  assert.ok(validation(adjusted, 'field_absent', 'consultation_context'));

  const createPayload = structuredClone(create.sample_request);
  delete createPayload.governance_context;
  assert.deepEqual(createPayload, adjusted.sample_request.payload);
  assert.equal(create.sample_request.governance_context, '$context.governance_context');
  assert.equal(create.agent, 'sales');
  assert.equal(
    (create.validations || []).some(({ path: validationPath }) =>
      validationPath === 'governance_context' || validationPath?.startsWith('conditions')),
    false,
    'create response must not be graded on a governance echo',
  );
});

test('governance conditions flow proves committed state and closes the outcome loop', () => {
  const doc = loadStoryboard();
  const orderedSteps = (doc.phases || []).flatMap((phase) => phase.steps || []);
  const ids = orderedSteps.map((step) => step.id);
  const steps = stepsById(doc);
  const create = steps.get('create_media_buy_after_approval');
  const readback = steps.get('get_media_buys_readback');
  const outcome = steps.get('report_plan_outcome');

  assert.ok(create && readback && outcome);
  assert.ok(ids.indexOf(create.id) < ids.indexOf(readback.id));
  assert.ok(ids.indexOf(readback.id) < ids.indexOf(outcome.id));
  assert.equal(readback.task, 'get_media_buys');
  assert.deepEqual(readback.sample_request.media_buy_ids, ['$context.media_buy_id']);
  assert.equal(
    validation(readback, 'field_equals_context', 'media_buys[0].media_buy_id')?.context_key,
    'media_buy_id',
  );

  assert.equal(outcome.task, 'report_plan_outcome');
  assert.equal(outcome.agent, 'governance');
  assert.equal(outcome.sample_request.check_id, '$context.approved_check_id');
  assert.equal(outcome.sample_request.governance_context, '$context.governance_context');
  assert.equal(outcome.sample_request.seller_response.seller_reference, '$context.media_buy_id');
  assert.equal(validation(outcome, 'field_value', 'outcome_state')?.value, 'accepted');

  const executionText = `${doc.narrative}\n${
    doc.phases.find((phase) => phase.id === 'governed_execution')?.narrative || ''
  }\n${create.expected}`;
  assert.match(executionText, /only `approved` permits commit/i);
  assert.match(executionText, /`conditions`.*invalid/is);
});
