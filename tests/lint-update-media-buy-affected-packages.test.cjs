#!/usr/bin/env node
/**
 * Tests for update_media_buy affected_packages storyboard lint.
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const yaml = require('js-yaml');

const {
  RULE_MESSAGES,
  lint,
  lintDoc,
  modelsSubmittedEnvelope,
  packageMutationCount,
  packageUpdateIds,
  isAffectedPackageStateAssertion,
} = require('../scripts/lint-update-media-buy-affected-packages.cjs');

test('source tree passes the update_media_buy affected_packages lint', () => {
  const violations = lint();
  assert.deepEqual(
    violations,
    [],
    'real storyboards have update_media_buy affected_packages violations:\n' +
      violations.map((v) => `  ${v.file} ${v.phase}/${v.step} — ${v.rule}`).join('\n'),
  );
});

function docForStep(stepYaml) {
  return yaml.load(`
id: temp_storyboard
phases:
  - id: phase_a
    steps:
${stepYaml.split('\n').map((line) => `      ${line}`).join('\n')}
`);
}

test('campaign-level update without packages is not subject to package assertion rule', () => {
  const doc = docForStep(`- id: pause_buy
  task: update_media_buy
  sample_request:
    media_buy_id: mb_123
    paused: true
  validations:
    - check: response_schema
`);
  assert.deepEqual(lintDoc(doc), []);
});

test('error-path package update is not subject to success assertion rule', () => {
  const doc = docForStep(`- id: rejected_update
  task: update_media_buy
  expect_error: true
  sample_request:
    media_buy_id: mb_123
    packages:
      - package_id: pkg_1
        budget: 100
  validations:
    - check: response_schema
`);
  assert.deepEqual(lintDoc(doc), []);
});

test('submitted update_media_buy envelope is not subject to completed-result package assertion rule', () => {
  const doc = docForStep(`- id: submitted_update
  task: update_media_buy
  sample_request:
    media_buy_id: mb_123
    packages:
      - package_id: pkg_1
        budget: 100
  validations:
    - check: field_value
      path: status
      value: submitted
    - check: field_present
      path: task_id
`);
  assert.deepEqual(lintDoc(doc), []);
});

test('task_completion validations mark async completion storyboards as submitted-envelope flows', () => {
  assert.equal(modelsSubmittedEnvelope({
    validations: [
      { check: 'field_present', path: 'task_completion.media_buy_id' },
    ],
  }), true);
});

test('package update without affected_packages assertion is flagged', () => {
  const doc = docForStep(`- id: missing_affected
  task: update_media_buy
  sample_request:
    media_buy_id: mb_123
    packages:
      - package_id: pkg_1
        budget: 100
  validations:
    - check: response_schema
`);
  const violations = lintDoc(doc);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].rule, 'missing_affected_packages_assertion');
});

test('ID-only affected_packages assertions are flagged', () => {
  const doc = docForStep(`- id: id_only
  task: update_media_buy
  sample_request:
    media_buy_id: mb_123
    packages:
      - package_id: pkg_1
        budget: 100
  validations:
    - check: field_equals_context
      path: affected_packages[0].package_id
      context_key: package_id
    - check: field_contains
      path: affected_packages[*]
      value:
        package_id: "$context.package_id"
`);
  const violations = lintDoc(doc);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].rule, 'insufficient_full_package_state_assertions');
  assert.equal(violations[0].expected, 1);
  assert.equal(violations[0].actual, 0);
});

test('affected package assertions without package identity are flagged', () => {
  const doc = docForStep(`- id: missing_identity
  task: update_media_buy
  sample_request:
    media_buy_id: mb_123
    packages:
      - package_id: pkg_1
        budget: 100
  validations:
    - check: field_contains
      path: affected_packages[*]
      value:
        budget: 100
`);
  const violations = lintDoc(doc);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].rule, 'insufficient_full_package_state_assertions');
});

test('affected package assertions with package_id and state do not require product/pricing identity', () => {
  const doc = docForStep(`- id: legacy_package_identity
  task: update_media_buy
  sample_request:
    media_buy_id: mb_123
    packages:
      - package_id: pkg_1
        budget: 100
  validations:
    - check: field_contains
      path: affected_packages[*]
      value:
        package_id: pkg_1
        budget: 100
`);
  assert.deepEqual(lintDoc(doc), []);
});

test('field_contains with package_id and post-update state passes', () => {
  const doc = docForStep(`- id: full_state
  task: update_media_buy
  sample_request:
    media_buy_id: mb_123
    packages:
      - package_id: pkg_1
        budget: 100
  validations:
    - check: field_contains
      path: affected_packages[*]
      value:
        package_id: pkg_1
        product_id: "$context.product_id"
        pricing_option_id: "$context.pricing_option_id"
        budget: 100
`);
  assert.deepEqual(lintDoc(doc), []);
});

test('multi-package update requires one full-state assertion per package mutation', () => {
  const doc = docForStep(`- id: multi_package
  task: update_media_buy
  sample_request:
    media_buy_id: mb_123
    packages:
      - package_id: pkg_1
        budget: 100
      - package_id: pkg_2
        budget: 200
  validations:
    - check: field_contains
      path: affected_packages[*]
      value:
        package_id: pkg_1
        product_id: "$context.first_product_id"
        pricing_option_id: "$context.first_pricing_option_id"
        budget: 100
`);
  const violations = lintDoc(doc);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].rule, 'insufficient_full_package_state_assertions');
  assert.equal(violations[0].expected, 2);
  assert.equal(violations[0].actual, 1);
});

test('multi-package update requires assertions for each mutated package identity', () => {
  const doc = docForStep(`- id: duplicate_package_assertion
  task: update_media_buy
  sample_request:
    media_buy_id: mb_123
    packages:
      - package_id: "$context.first_package_id"
        budget: 100
      - package_id: "$context.second_package_id"
        budget: 200
  validations:
    - check: field_contains
      path: affected_packages[*]
      value:
        package_id: "$context.first_package_id"
        product_id: "$context.first_product_id"
        pricing_option_id: "$context.first_pricing_option_id"
        budget: 100
    - check: field_contains
      path: affected_packages[*]
      value:
        package_id: "$context.first_package_id"
        product_id: "$context.first_product_id"
        pricing_option_id: "$context.first_pricing_option_id"
        bid_price: 7.25
`);
  const violations = lintDoc(doc);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].rule, 'insufficient_full_package_state_assertions');
  assert.deepEqual(violations[0].missingPackageIds, ['$context.second_package_id']);
});

test('new_package-only update is outside this existing-package assertion lint', () => {
  const doc = docForStep(`- id: new_package
  task: update_media_buy
  sample_request:
    media_buy_id: mb_123
    new_packages:
      - product_id: "$context.new_product_id"
        pricing_option_id: "$context.new_pricing_option_id"
        budget: 200
`);
  assert.deepEqual(lintDoc(doc), []);
});

test('packageMutationCount scopes to existing package updates', () => {
  assert.equal(packageMutationCount({
    sample_request: {
      packages: [{ package_id: 'pkg_1' }],
      new_packages: [{ product_id: 'prod_1' }, { product_id: 'prod_2' }],
    },
  }), 1);
});

test('packageUpdateIds extracts only existing package update identities', () => {
  assert.deepEqual(packageUpdateIds({
    sample_request: {
      packages: [
        { package_id: '$context.first_package_id' },
        { package_id: '$context.second_package_id' },
      ],
      new_packages: [{ product_id: 'prod_1' }],
    },
  }), ['$context.first_package_id', '$context.second_package_id']);
});

test('state assertion helper rejects non-wildcard, package_id-only, or context-only checks', () => {
  assert.equal(isAffectedPackageStateAssertion({
    check: 'field_contains',
    path: 'affected_packages[*]',
    value: {
      package_id: 'pkg_1',
      product_id: 'prod_1',
      pricing_option_id: 'cpm_auction',
      budget: 100,
    },
  }), true);
  assert.equal(isAffectedPackageStateAssertion({
    check: 'field_contains',
    path: 'affected_packages[*]',
    value: { package_id: 'pkg_1', context: { buyer_ref: 'line-1' } },
  }), false);
  assert.equal(isAffectedPackageStateAssertion({
    check: 'field_contains',
    path: 'affected_packages[*]',
    value: { package_id: 'pkg_1' },
  }), false);
  assert.equal(isAffectedPackageStateAssertion({
    check: 'field_contains',
    path: 'affected_packages[0]',
    value: {
      package_id: 'pkg_1',
      product_id: 'prod_1',
      pricing_option_id: 'cpm_auction',
      budget: 100,
    },
  }), false);
  assert.equal(isAffectedPackageStateAssertion({
    check: 'field_contains',
    path: 'affected_packages[*]',
    value: {
      package_id: 'pkg_1',
      product_id: 'prod_1',
      pricing_option_id: 'cpm_auction',
    },
  }), false);
});

test('lint walks a synthetic storyboard directory', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'update-media-buy-affected-lint-'));
  try {
    fs.writeFileSync(path.join(tmp, 'story.yaml'), `
id: temp_storyboard
phases:
  - id: phase_a
    steps:
      - id: ok
        task: update_media_buy
        sample_request:
          media_buy_id: mb_123
          packages:
            - package_id: pkg_1
              budget: 100
        validations:
          - check: field_contains
            path: affected_packages[*]
            value:
              package_id: pkg_1
              product_id: prod_1
              pricing_option_id: cpm_auction
              budget: 100
`);
    assert.deepEqual(lint(tmp), []);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('build-compliance invokes the affected_packages lint', () => {
  const buildScript = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'build-compliance.cjs'), 'utf8');
  assert.match(buildScript, /lint-update-media-buy-affected-packages\.cjs/);
});

test('every rule ID has a message', () => {
  for (const id of [
    'missing_affected_packages_assertion',
    'insufficient_full_package_state_assertions',
  ]) {
    assert.equal(typeof RULE_MESSAGES[id], 'function', `missing message for rule ${id}`);
  }
});
