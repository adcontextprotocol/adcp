#!/usr/bin/env node
/**
 * Tests for the storyboard raw-mode-required lint.
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { lint, RULE_MESSAGES } = require('../scripts/lint-storyboard-raw-mode-required.cjs');

test('source tree passes the raw-mode-required lint', () => {
  const violations = lint();
  assert.deepEqual(
    violations,
    [],
    'real storyboards have raw-mode-required violations:\n' +
      violations.map((v) => `  ${v.file} ${v.phase}/${v.step}[${v.index}] — ${v.rule}`).join('\n'),
  );
});

function withTempStoryboardDir(name, doc, fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'raw-required-lint-'));
  const file = path.join(tmp, name);
  fs.writeFileSync(file, doc);
  try {
    return fn(tmp);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test('raw_required_without_justification: raw flag set, no payload_must_contain — flagged', () => {
  // Only mode-agnostic assertions (min_count, identifier_paths) — the
  // raw requirement excludes digest-mode adopters for nothing.
  const doc = `
id: temp_storyboard
phases:
  - id: phase_a
    steps:
      - id: step_a
        task: get_products
        validations:
          - check: upstream_traffic
            description: bad — raw flag without justification
            attestation_mode_required: raw
            min_count: 1
            identifier_paths:
              - "audiences[*].add[*].hashed_email"
`;
  withTempStoryboardDir('unjustified.yaml', doc, (dir) => {
    const violations = lint(dir);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].rule, 'raw_required_without_justification');
    assert.equal(violations[0].step, 'step_a');
  });
});

test('raw flag with payload_must_contain present: no violation', () => {
  const doc = `
id: temp_storyboard
phases:
  - id: phase_a
    steps:
      - id: step_a
        task: get_products
        validations:
          - check: upstream_traffic
            description: justified — raw introspection of arbitrary path
            attestation_mode_required: raw
            min_count: 1
            payload_must_contain:
              - path: "users[*].first_name"
                match: present
`;
  withTempStoryboardDir('justified.yaml', doc, (dir) => {
    const violations = lint(dir);
    assert.deepEqual(violations, []);
  });
});

test('upstream_traffic without raw flag: no violation', () => {
  const doc = `
id: temp_storyboard
phases:
  - id: phase_a
    steps:
      - id: step_a
        task: get_products
        validations:
          - check: upstream_traffic
            description: digest-tolerant
            min_count: 1
            identifier_paths:
              - "audiences[*].add[*].hashed_email"
`;
  withTempStoryboardDir('mode-agnostic.yaml', doc, (dir) => {
    const violations = lint(dir);
    assert.deepEqual(violations, []);
  });
});

test('non-upstream_traffic checks ignored', () => {
  // attestation_mode_required is meaningless on non-upstream_traffic
  // checks (it's an upstream_traffic-only field). Schema validation
  // catches that elsewhere; this lint shouldn't fire.
  const doc = `
id: temp_storyboard
phases:
  - id: phase_a
    steps:
      - id: step_a
        task: get_products
        validations:
          - check: response_schema
            description: ordinary check
`;
  withTempStoryboardDir('other-check.yaml', doc, (dir) => {
    const violations = lint(dir);
    assert.deepEqual(violations, []);
  });
});

test('empty payload_must_contain array still flagged', () => {
  // Author wrote `payload_must_contain: []` — empty arrays don't justify
  // raw mode any more than a missing field does.
  const doc = `
id: temp_storyboard
phases:
  - id: phase_a
    steps:
      - id: step_a
        task: get_products
        validations:
          - check: upstream_traffic
            description: empty array
            attestation_mode_required: raw
            min_count: 1
            payload_must_contain: []
`;
  withTempStoryboardDir('empty.yaml', doc, (dir) => {
    const violations = lint(dir);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].rule, 'raw_required_without_justification');
  });
});

test('every rule ID has a message', () => {
  const ruleIds = ['raw_required_without_justification'];
  for (const id of ruleIds) {
    assert.ok(typeof RULE_MESSAGES[id] === 'function', `missing message for rule ${id}`);
  }
});
