#!/usr/bin/env node
/**
 * Tests for the storyboard check-enum lint. Two concerns:
 *   1. Source-tree guard — every real storyboard's authored validation
 *      check values are in the runner-output-contract authored_check_kinds
 *      enum.
 *   2. Per-rule coverage — each rule ID fires when its hazard is present,
 *      tested by writing temp storyboards into a sandbox dir and running
 *      `lint(dir)` against it. Tests assert on the `rule` field so message
 *      wording can evolve without breaking tests.
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  lint,
  loadAuthoredCheckKinds,
  SYNTHESIZED_CHECK_KINDS,
  RULE_MESSAGES,
} = require('../scripts/lint-storyboard-check-enum.cjs');

test('source tree passes the check-enum lint', () => {
  const violations = lint();
  assert.deepEqual(
    violations,
    [],
    'real storyboards have check-enum violations:\n' +
      violations.map((v) => `  ${v.file} ${v.phase}/${v.step}[${v.index}] — ${v.rule} (${v.check})`).join('\n'),
  );
});

test('authored_check_kinds enum loads from runner-output-contract.yaml', () => {
  const kinds = loadAuthoredCheckKinds();
  // Spot-check a few load-bearing entries — keep this tight so the test
  // doesn't have to track every authored kind. Full enum is the contract.
  for (const expected of ['response_schema', 'field_present', 'upstream_traffic']) {
    assert.ok(kinds.has(expected), `expected "${expected}" in authored_check_kinds`);
  }
  // Synthesized codes MUST NOT be in the authored enum.
  for (const synth of SYNTHESIZED_CHECK_KINDS) {
    assert.ok(
      !kinds.has(synth),
      `synthesized code "${synth}" must not appear in authored_check_kinds`,
    );
  }
});

function withTempStoryboardDir(name, doc, fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'check-enum-lint-'));
  const file = path.join(tmp, name);
  fs.writeFileSync(file, doc);
  try {
    return fn(tmp);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test('unknown_check_kind: typo in check value is flagged', () => {
  const doc = `
id: temp_storyboard
phases:
  - id: phase_a
    steps:
      - id: step_a
        task: get_products
        validations:
          - check: upsteam_traffic
            description: typo
`;
  withTempStoryboardDir('typo.yaml', doc, (dir) => {
    const violations = lint(dir);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].rule, 'unknown_check_kind');
    assert.equal(violations[0].check, 'upsteam_traffic');
    assert.equal(violations[0].step, 'step_a');
  });
});

test('synthesized_check_kind_authored: capture_path_not_resolvable in storyboard is flagged', () => {
  // Storyboards must not author synthesized codes — those are runner output,
  // not assertion targets.
  const doc = `
id: temp_storyboard
phases:
  - id: phase_a
    steps:
      - id: step_a
        task: get_products
        validations:
          - check: capture_path_not_resolvable
            description: cannot author this
`;
  withTempStoryboardDir('synth.yaml', doc, (dir) => {
    const violations = lint(dir);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].rule, 'synthesized_check_kind_authored');
    assert.equal(violations[0].check, 'capture_path_not_resolvable');
  });
});

test('valid authored check passes', () => {
  const doc = `
id: temp_storyboard
phases:
  - id: phase_a
    steps:
      - id: step_a
        task: get_products
        validations:
          - check: response_schema
            description: ok
          - check: field_present
            path: "products[0]"
            description: also ok
          - check: upstream_traffic
            description: from authored enum
`;
  withTempStoryboardDir('valid.yaml', doc, (dir) => {
    const violations = lint(dir);
    assert.deepEqual(violations, []);
  });
});

test('every rule ID has a message', () => {
  // Trip-wire — adding a new rule without a message would surface as a
  // missing key when the rule ID appears in violations output.
  const ruleIds = ['unknown_check_kind', 'synthesized_check_kind_authored'];
  for (const id of ruleIds) {
    assert.ok(typeof RULE_MESSAGES[id] === 'function', `missing message for rule ${id}`);
  }
});
