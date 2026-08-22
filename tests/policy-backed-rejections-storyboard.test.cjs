#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const yaml = require('js-yaml');

const ROOT = path.resolve(__dirname, '..');
const STORYBOARD_PATH = path.join(
  ROOT,
  'static/compliance/source/protocols/creative/scenarios/policy_backed_rejections.yaml',
);

function loadStep() {
  const storyboard = yaml.load(fs.readFileSync(STORYBOARD_PATH, 'utf8'));
  return {
    storyboard,
    step: storyboard.phases[0].steps[0],
  };
}

test('fixture deterministically encodes two independent policy violations', () => {
  const { storyboard, step } = loadStep();
  const content = step.sample_request.creatives[0].assets.payload.content;

  assert.equal(storyboard.id, 'creative/policy_backed_rejections');
  assert.match(content, /location\.assign\(/);
  assert.match(content, /fetch\("http:\/\//);
});

test('conformance requires exactly two separate policy-backed rejection entries', () => {
  const { step } = loadStep();
  const validations = step.validations;
  const count = validations.find(v => v.check === 'array_length');
  const entries = validations
    .filter(v => v.check === 'field_contains' && v.path === 'creatives[0].errors[*]')
    .map(v => v.value);

  assert.deepEqual(count, {
    check: 'array_length',
    path: 'creatives[0].errors',
    value: 2,
    description: 'Exactly one error entry is emitted for each of the two violated policies',
  });
  assert.deepEqual(
    new Set(entries.map(entry => entry.details.policy_id)),
    new Set(['creative_security_auto_redirect', 'creative_security_https_only']),
  );
  assert.ok(entries.every(entry => entry.code === 'CREATIVE_REJECTED'));
});

test('current creative matrix makes the storyboard required-clean', () => {
  for (const relative of [
    'scripts/run-storyboards-matrix.sh',
    '.github/workflows/training-agent-storyboards.yml',
  ]) {
    const source = fs.readFileSync(path.join(ROOT, relative), 'utf8');
    assert.match(source, /creative\/policy_backed_rejections/);
  }
});
