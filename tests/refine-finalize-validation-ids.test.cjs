#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const YAML = require('yaml');

const STORYBOARD_PATH = path.join(
  __dirname,
  '..',
  'static',
  'compliance',
  'source',
  'protocols',
  'media-buy',
  'scenarios',
  'refine_finalize_exclusivity.yaml',
);

function loadStoryboard() {
  return YAML.parse(fs.readFileSync(STORYBOARD_PATH, 'utf8'));
}

function allValidations(doc) {
  return (doc.phases ?? []).flatMap((phase) =>
    (phase.steps ?? []).flatMap((step) =>
      (step.validations ?? []).map((validation) => ({
        phase_id: phase.id,
        step_id: step.id,
        ...validation,
      })),
    ),
  );
}

test('refine finalize exclusivity exposes stable validation ids for multi-finalize failures', () => {
  const doc = loadStoryboard();
  const validations = allValidations(doc);
  const ids = new Set(validations.map((validation) => validation.id).filter(Boolean));

  assert.equal(ids.size, validations.filter((validation) => validation.id).length, 'validation ids must be unique');
  assert.ok(ids.has('multi_finalize_unsupported.error_code'));
  assert.ok(ids.has('multi_finalize_gate.any_path_contributed'));
  assert.ok(ids.has('multi_finalize_atomic.proposal_1_committed'));
  assert.ok(ids.has('multi_finalize_atomic.proposal_2_committed'));
  assert.ok(ids.has('multi_finalize_atomic.refinement_1_proposal_id'));
  assert.ok(ids.has('multi_finalize_atomic.refinement_1_applied'));
  assert.ok(ids.has('multi_finalize_atomic.refinement_2_proposal_id'));
  assert.ok(ids.has('multi_finalize_atomic.refinement_2_applied'));

  const unsupported = validations.find((validation) => validation.id === 'multi_finalize_unsupported.error_code');
  assert.equal(unsupported?.phase_id, 'multi_finalize_unsupported_path');
  assert.equal(unsupported?.step_id, 'get_products_multi_finalize_unsupported');
  assert.equal(unsupported?.check, 'error_code');

  const gate = validations.find((validation) => validation.id === 'multi_finalize_gate.any_path_contributed');
  assert.equal(gate?.phase_id, 'multi_finalize_gate');
  assert.equal(gate?.step_id, 'assert_multi_finalize');
  assert.equal(gate?.check, 'any_of');

  const atomic = validations.filter((validation) => String(validation.id ?? '').startsWith('multi_finalize_atomic.'));
  assert.equal(
    atomic.every((validation) => validation.phase_id === 'multi_finalize_atomic_path'),
    true,
    'atomic success assertions must stay on the atomic branch',
  );

  const multiFinalizePhases = ['multi_finalize_atomic_path', 'multi_finalize_unsupported_path', 'multi_finalize_gate'];
  for (const phaseId of multiFinalizePhases) {
    const phase = doc.phases.find((candidate) => candidate.id === phaseId);
    assert.match(
      phase?.skip_if ?? '',
      /context\.proposal_id_2 == context\.proposal_id_1/,
      `${phaseId} must skip if setup captured duplicate proposal ids`,
    );
  }
});
