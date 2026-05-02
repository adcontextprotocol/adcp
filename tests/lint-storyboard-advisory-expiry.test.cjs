#!/usr/bin/env node
/**
 * Tests for the storyboard advisory-expiry lint. Two concerns:
 *   1. Source-tree guard — every existing storyboard with severity:
 *      advisory should already declare expires_after_version OR carry an
 *      advisory-permanent marker. (Today there are no advisory uses in
 *      the source tree, so this is a future-proofing trip-wire.)
 *   2. Per-rule coverage — the rule fires on advisory-without-expiry and
 *      stays quiet for the legitimate cases (expires_after_version set,
 *      advisory-permanent marker present, severity required).
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  lint,
  findAdvisoryPermanentMarkers,
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

test('advisory_without_expiry: severity:advisory without expires_after_version warns', () => {
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
    assert.equal(warnings[0].rule, 'advisory_without_expiry');
    assert.equal(warnings[0].step, 'step_a');
    assert.equal(warnings[0].check, 'upstream_traffic');
  });
});

test('expires_after_version present: no warning', () => {
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

test('advisory-permanent marker: no warning', () => {
  // Marker appears as a YAML comment immediately above the step's `- id:`
  // declaration. Mimics the textual pattern the lint scans for.
  const doc = `
id: temp_storyboard
phases:
  - id: phase_a
    steps:
      # advisory-permanent: experimental signals; advisory grade is the contract here
      - id: step_a
        task: get_products
        validations:
          - check: upstream_traffic
            severity: advisory
            description: experimental
            min_count: 1
`;
  withTempStoryboardDir('permanent.yaml', doc, (dir) => {
    const warnings = lint(dir);
    assert.deepEqual(warnings, []);
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

test('findAdvisoryPermanentMarkers picks up case-insensitive markers', () => {
  const text = `
phases:
  - id: phase_a
    steps:
      # ADVISORY-PERMANENT: uppercase form should still match
      - id: step_a
      # advisory-permanent: lowercase form
      - id: step_b
`;
  const markers = findAdvisoryPermanentMarkers(text);
  assert.ok(markers.has('step_a'));
  assert.ok(markers.has('step_b'));
});

test('every rule ID has a message', () => {
  const ruleIds = ['advisory_without_expiry'];
  for (const id of ruleIds) {
    assert.ok(typeof RULE_MESSAGES[id] === 'function', `missing message for rule ${id}`);
  }
});
