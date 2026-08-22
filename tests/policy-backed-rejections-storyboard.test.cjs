#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const yaml = require('js-yaml');
const { runValidations } = require('@adcp/sdk/testing');

const STORYBOARD_PATH = path.join(
  __dirname,
  '..',
  'static/compliance/source/protocols/creative/scenarios/policy_backed_rejections.yaml',
);
const FIXTURE_PATH = path.join(
  __dirname,
  '..',
  'static/test-assets/acme-outdoor/policy-backed-auto-redirect-http.js',
);

function loadStoryboard() {
  return yaml.load(fs.readFileSync(STORYBOARD_PATH, 'utf8'));
}

function rejectionStep(storyboard = loadStoryboard()) {
  return storyboard.phases
    .find(phase => phase.id === 'reject_multiple_policies')
    .steps.find(step => step.id === 'sync_dual_violation_creative');
}

function policyError(policyId) {
  return {
    code: 'CREATIVE_REJECTED',
    message: `Rejected by ${policyId}`,
    details: { policy_id: policyId },
  };
}

function gradeRejection(errors) {
  const validations = rejectionStep().validations.filter(validation => validation.check !== 'response_schema');
  return runValidations(validations, {
    taskName: 'sync_creatives',
    agentUrl: 'https://seller.example',
    contributions: new Set(),
    taskResult: {
      success: true,
      data: { creatives: [{ creative_id: 'fixture', action: 'failed', errors }] },
    },
  });
}

test('fixture gates applicability on an isolated two-policy product and canonical display tag', () => {
  const storyboard = loadStoryboard();
  const product = storyboard.fixtures.products[0];
  const step = rejectionStep(storyboard);
  const tag = step.sample_request.creatives[0].assets.tag_url;

  assert.equal(storyboard.id, 'creative/policy_backed_rejections');
  assert.deepEqual(storyboard.requires, ['controller']);
  assert.equal(storyboard.prerequisites.controller_seeding, true);
  assert.deepEqual(product.enforced_policies, [
    'creative_security_auto_redirect',
    'creative_security_https_only',
  ]);
  assert.equal(tag.asset_type, 'url');
  assert.equal(tag.url_type, 'tracker_script');
  assert.equal(
    tag.url,
    'https://adcontextprotocol.org/test-assets/acme-outdoor/policy-backed-auto-redirect-http.js',
  );
  const fixtureSource = fs.readFileSync(FIXTURE_PATH, 'utf8');
  assert.match(fixtureSource, /window\.location\.assign\(/);
  assert.match(fixtureSource, /fetch\('http:\/\//);
});

test('conformance requires exactly two separate policy-backed rejection entries', () => {
  const step = rejectionStep();
  const validations = step.validations;
  const count = validations.find(validation => validation.check === 'array_length');
  const entries = validations
    .filter(validation => validation.check === 'field_contains' && validation.path === 'creatives[0].errors[*]')
    .map(validation => validation.value);

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

test('runtime validations reject combined, duplicate, ambiguous, and extra entries', () => {
  const autoRedirect = policyError('creative_security_auto_redirect');
  const httpsOnly = policyError('creative_security_https_only');
  assert.ok(gradeRejection([autoRedirect, httpsOnly]).every(result => result.passed));

  const invalidCases = [
    [{
      code: 'CREATIVE_REJECTED',
      message: 'Combined rejection',
      details: { policy_id: ['creative_security_auto_redirect', 'creative_security_https_only'] },
    }],
    [autoRedirect, autoRedirect],
    [
      { ...autoRedirect, details: { policy_id: 'creative_security_auto_redirect+creative_security_https_only' } },
      { ...httpsOnly, details: { policy_id: null } },
    ],
    [autoRedirect, httpsOnly, policyError('seller_specific_extra_policy')],
  ];

  for (const errors of invalidCases) {
    assert.ok(
      gradeRejection(errors).some(result => !result.passed),
      `expected rejection validations to fail for ${JSON.stringify(errors)}`,
    );
  }
});
