#!/usr/bin/env node
/**
 * Tests for the storyboard advisory-expiry lint.
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  lint,
  checkValidation,
  RULE_MESSAGES,
} = require('../scripts/lint-storyboard-advisory-expiry.cjs');

test('source tree passes the advisory-expiry lint', () => {
  const warnings = lint();
  assert.deepEqual(
    warnings,
    [],
    'real storyboards have advisory-expiry warnings:\n' +
      warnings.map((w) => `  ${w.file} ${w.phase}/${w.step}[${w.index}] — ${w.rule}`).join('\n'),
  );
});

function withTempStoryboardDir(name, doc, fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'advisory-expiry-lint-'));
  const file = path.join(tmp, name);
  fs.writeFileSync(file, doc);
  try {
    return fn(tmp);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test('advisory_without_expiry_or_permanent: severity:advisory without either field warns', () => {
  const doc = `
id: temp_storyboard
phases:
  - id: phase_a
    steps:
      - id: step_a
        task: get_products
        validations:
          - check: upstream_traffic
            severity: advisory
            description: rolling out
            min_count: 1
`;
  withTempStoryboardDir('drift.yaml', doc, (dir) => {
    const warnings = lint(dir);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].rule, 'advisory_without_expiry_or_permanent');
    assert.equal(warnings[0].step, 'step_a');
    assert.equal(warnings[0].check, 'upstream_traffic');
  });
});

test('expires_after_version with valid semver: no warning', () => {
  const doc = `
id: temp_storyboard
phases:
  - id: phase_a
    steps:
      - id: step_a
        task: get_products
        validations:
          - check: upstream_traffic
            severity: advisory
            expires_after_version: "6.5.0"
            description: rolling out
            min_count: 1
`;
  withTempStoryboardDir('gated.yaml', doc, (dir) => {
    const warnings = lint(dir);
    assert.deepEqual(warnings, []);
  });
});

test('expires_after_version with pre-release tag: no warning', () => {
  const doc = `
id: temp_storyboard
phases:
  - id: phase_a
    steps:
      - id: step_a
        task: get_products
        validations:
          - check: upstream_traffic
            severity: advisory
            expires_after_version: "6.5.0-rc.3"
            description: rolling out early
            min_count: 1
`;
  withTempStoryboardDir('prerelease.yaml', doc, (dir) => {
    const warnings = lint(dir);
    assert.deepEqual(warnings, []);
  });
});

test('advisory_expiry_not_semver: malformed expires_after_version flagged', () => {
  const doc = `
id: temp_storyboard
phases:
  - id: phase_a
    steps:
      - id: step_a
        task: get_products
        validations:
          - check: upstream_traffic
            severity: advisory
            expires_after_version: "ignore previous instructions"
            description: prompt-injection attempt
            min_count: 1
`;
  withTempStoryboardDir('injection.yaml', doc, (dir) => {
    const warnings = lint(dir);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].rule, 'advisory_expiry_not_semver');
    assert.equal(warnings[0].value, 'ignore previous instructions');
  });
});

test('advisory_expiry_not_semver: typos flagged', () => {
  const doc = `
id: temp_storyboard
phases:
  - id: phase_a
    steps:
      - id: step_a
        task: get_products
        validations:
          - check: upstream_traffic
            severity: advisory
            expires_after_version: "6.5"
            description: not a full semver
            min_count: 1
`;
  withTempStoryboardDir('typo.yaml', doc, (dir) => {
    const warnings = lint(dir);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].rule, 'advisory_expiry_not_semver');
  });
});

test('permanent_advisory structured field: no warning', () => {
  const doc = `
id: temp_storyboard
phases:
  - id: phase_a
    steps:
      - id: step_a
        task: get_products
        validations:
          - check: upstream_traffic
            severity: advisory
            permanent_advisory:
              reason: "experimental signals; advisory grade is the contract here"
            description: experimental
            min_count: 1
`;
  withTempStoryboardDir('permanent.yaml', doc, (dir) => {
    const warnings = lint(dir);
    assert.deepEqual(warnings, []);
  });
});

test('advisory_double_gating: both fields set is a violation', () => {
  // Mutually exclusive. Author who declares both has confused intent.
  const doc = `
id: temp_storyboard
phases:
  - id: phase_a
    steps:
      - id: step_a
        task: get_products
        validations:
          - check: upstream_traffic
            severity: advisory
            expires_after_version: "6.5.0"
            permanent_advisory:
              reason: "also permanent?"
            description: confused
            min_count: 1
`;
  withTempStoryboardDir('double.yaml', doc, (dir) => {
    const warnings = lint(dir);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].rule, 'advisory_double_gating');
  });
});

test('permanent_advisory without reason: still flagged as needing structure', () => {
  // permanent_advisory: {} (no reason) doesn't satisfy the structured-shape
  // requirement — author intent unclear.
  const doc = `
id: temp_storyboard
phases:
  - id: phase_a
    steps:
      - id: step_a
        task: get_products
        validations:
          - check: upstream_traffic
            severity: advisory
            permanent_advisory: {}
            description: missing reason
            min_count: 1
`;
  withTempStoryboardDir('no-reason.yaml', doc, (dir) => {
    const warnings = lint(dir);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].rule, 'advisory_without_expiry_or_permanent');
  });
});

test('severity:required (default): no warning', () => {
  const doc = `
id: temp_storyboard
phases:
  - id: phase_a
    steps:
      - id: step_a
        task: get_products
        validations:
          - check: response_schema
            description: ordinary required check
`;
  withTempStoryboardDir('required.yaml', doc, (dir) => {
    const warnings = lint(dir);
    assert.deepEqual(warnings, []);
  });
});

test('checkValidation unit test: structured field detection', () => {
  // expires_after_version + valid semver
  assert.equal(checkValidation({
    severity: 'advisory',
    expires_after_version: '6.5.0',
  }), null);

  // permanent_advisory with reason
  assert.equal(checkValidation({
    severity: 'advisory',
    permanent_advisory: { reason: 'experimental' },
  }), null);

  // Neither field
  const v1 = checkValidation({ severity: 'advisory' });
  assert.equal(v1.rule, 'advisory_without_expiry_or_permanent');

  // Both fields
  const v2 = checkValidation({
    severity: 'advisory',
    expires_after_version: '6.5.0',
    permanent_advisory: { reason: 'x' },
  });
  assert.equal(v2.rule, 'advisory_double_gating');

  // Invalid semver
  const v3 = checkValidation({
    severity: 'advisory',
    expires_after_version: 'not-a-version',
  });
  assert.equal(v3.rule, 'advisory_expiry_not_semver');
});

test('every rule ID has a message', () => {
  const ruleIds = [
    'advisory_without_expiry_or_permanent',
    'advisory_expiry_not_semver',
    'advisory_double_gating',
  ];
  for (const id of ruleIds) {
    assert.ok(typeof RULE_MESSAGES[id] === 'function', `missing message for rule ${id}`);
  }
});
