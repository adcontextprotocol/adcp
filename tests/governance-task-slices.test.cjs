'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const ROOT = path.resolve(__dirname, '..');
const source = (...parts) => path.join(ROOT, 'static/compliance/source', ...parts);
const load = (...parts) => yaml.load(fs.readFileSync(source(...parts), 'utf8'));
const stepsById = (doc) => new Map(
  (doc.phases || []).flatMap((phase) => phase.steps || []).map((step) => [step.id, step]),
);

test('rights governance proof is task-gated and proves no grant persisted', () => {
  const doc = load('specialisms', 'brand-rights', 'scenarios', 'governance_denied.yaml');
  const steps = stepsById(doc);
  const denied = steps.get('acquire_rights_denied');
  const noGrant = steps.get('rejected_grant_not_persisted');

  assert.deepEqual(doc.requires_capability, {
    path: 'adcp.governance_enforcement.tasks',
    contains: { task: 'acquire_rights', modes: ['signed_context'] },
  });
  for (const tool of ['sync_accounts', 'sync_governance', 'get_rights', 'acquire_rights', 'update_rights']) {
    assert.ok(doc.required_tools.includes(tool), `${tool} must be declared`);
  }
  assert.equal(steps.has('sync_plans'), false, 'the service proof must not create provider policy');
  assert.equal(denied.sample_request.governance_context, undefined);
  assert.equal(denied.sample_request.campaign.estimated_impressions, 1000000);
  assert.equal(denied.validations.some((validation) => validation.path === 'context'), false);
  assert.equal(
    noGrant.validations.find((validation) => validation.check === 'error_code')?.value,
    'REFERENCE_NOT_FOUND',
  );
});

test('creative governance proof discovers paid work and proves no render dispatch', () => {
  const doc = load('specialisms', 'creative-transformers', 'scenarios', 'governance_denied.yaml');
  const steps = stepsById(doc);
  const discovery = steps.get('discover_paid_transformer');
  const denied = steps.get('build_creative_denied');

  assert.deepEqual(doc.requires_capability, {
    path: 'adcp.governance_enforcement.tasks',
    contains: { task: 'build_creative', modes: ['signed_context'] },
  });
  assert.equal(discovery.sample_request.include_pricing, true);
  assert.equal(
    discovery.context_outputs.find((capture) => capture.key === 'pricing_option_id')?.path,
    'transformers[0].pricing_options[0].pricing_option_id',
  );
  assert.equal(
    discovery.validations.find((validation) => validation.check === 'field_greater_than')?.value,
    0,
  );
  assert.equal(denied.sample_request.mode, 'execute');
  assert.equal(denied.sample_request.governance_context, undefined);
  assert.equal(
    denied.validations.find((validation) => validation.check === 'error_code')?.value,
    'PERMISSION_DENIED',
  );
  assert.deepEqual(
    denied.validations.find((validation) => validation.check === 'upstream_traffic'),
    {
      check: 'upstream_traffic',
      description: 'Rejected build causes no platform-primary outbound render call',
      min_count: 0,
      endpoint_pattern: 'POST *',
      purpose_filter: ['platform_primary'],
    },
  );
  assert.equal(denied.validations.some((validation) => validation.path === 'context'), false);
});

test('signal governance claim requires an accepted token and durable deployment proof', () => {
  const doc = load('specialisms', 'signal-marketplace', 'scenarios', 'governance_approved.yaml');
  const steps = stepsById(doc);
  const discovery = steps.get('discover_paid_signal');
  const intent = steps.get('check_governance_intent');
  const activation = steps.get('activate_signal_approved');
  const readback = steps.get('get_signal_deployment_readback');

  assert.deepEqual(doc.requires, ['multi_agent']);
  assert.deepEqual(doc.requires_capability, {
    path: 'adcp.governance_enforcement.tasks',
    contains: { task: 'activate_signal', modes: ['signed_context'] },
  });
  assert.equal(
    discovery.context_outputs.find((capture) => capture.name === 'pricing_currency')?.path,
    'signals[0].pricing_options[0].currency',
  );
  assert.equal(intent.sample_request.tool, 'activate_signal');
  assert.equal(intent.sample_request.proposed_commitment.currency, '$context.pricing_currency');
  assert.equal(activation.sample_request.governance_context, '$context.governance_context');
  assert.equal(
    activation.validations.find((validation) => validation.path === 'deployments[0].is_live')?.value,
    true,
  );
  assert.equal(
    readback.validations.find((validation) => validation.path === 'signals[0].deployments[0].is_live')?.value,
    true,
  );
});

test('rights and creative governance claims require successful signed-token workflows', () => {
  const rights = load('specialisms', 'brand-rights', 'scenarios', 'governance_approved.yaml');
  const rightsSteps = stepsById(rights);
  assert.deepEqual(rights.requires, ['multi_agent']);
  assert.equal(rightsSteps.get('check_governance_intent').sample_request.tool, 'acquire_rights');
  assert.equal(
    rightsSteps.get('check_governance_intent').sample_request.proposed_commitment.currency,
    '$context.pricing_currency',
  );
  assert.equal(
    rightsSteps.get('acquire_rights_approved').validations
      .find((validation) => validation.path === 'rights_status')?.value,
    'acquired',
  );
  assert.equal(
    rightsSteps.get('update_acquired_grant').validations
      .find((validation) => validation.path === 'paused')?.value,
    true,
  );

  const creative = load('specialisms', 'creative-transformers', 'scenarios', 'governance_approved.yaml');
  const creativeSteps = stepsById(creative);
  assert.deepEqual(creative.requires, ['multi_agent']);
  assert.equal(creativeSteps.get('check_governance_intent').sample_request.tool, 'build_creative');
  assert.equal(
    creativeSteps.get('check_governance_intent').sample_request.proposed_commitment.currency,
    '$context.pricing_currency',
  );
  assert.equal(
    creativeSteps.get('discover_paid_transformer').validations
      .find((validation) => validation.check === 'field_greater_than')?.value,
    0,
  );
  assert.ok(
    creativeSteps.get('build_creative_approved').validations
      .some((validation) => validation.path === 'creative_manifest'),
  );
});

test('cross-role governance support artifact indexes every task slice without becoming universal execution', () => {
  const doc = load('universal', 'governance.yaml');
  assert.equal(doc.phases, undefined);
  assert.match(doc.narrative, /discoverability index, not a storyboard/);
  assert.deepEqual(
    Object.fromEntries(doc.task_slices.map((slice) => [slice.role, slice.tasks])),
    {
      media_buy_service: ['create_media_buy'],
      signal_service: ['activate_signal'],
      rights_service: ['acquire_rights'],
      creative_service: ['build_creative'],
    },
  );

  const indexed = [
    ...doc.task_slices.flatMap((slice) => slice.storyboards),
    ...doc.online_execution_proofs.flatMap((slice) => slice.storyboards),
  ];
  for (const expected of [
    'protocols/media-buy/scenarios/governance_approved.yaml',
    'protocols/media-buy/scenarios/governance_conditions.yaml',
    'protocols/media-buy/scenarios/governance_denied.yaml',
    'specialisms/signal-marketplace/scenarios/governance_denied.yaml',
    'specialisms/signal-marketplace/scenarios/governance_approved.yaml',
    'specialisms/brand-rights/scenarios/governance_denied.yaml',
    'specialisms/brand-rights/scenarios/governance_approved.yaml',
    'specialisms/creative-transformers/scenarios/governance_denied.yaml',
    'specialisms/creative-transformers/scenarios/governance_approved.yaml',
  ]) {
    assert.ok(indexed.includes(expected), `${expected} must be indexed`);
    assert.ok(fs.existsSync(source(...expected.split('/'))), `${expected} must resolve`);
  }
  assert.match(doc.normative_requirements.evidence, /response echoing is not evidence/i);
});
