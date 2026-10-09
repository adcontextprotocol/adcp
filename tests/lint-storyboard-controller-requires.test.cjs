#!/usr/bin/env node
/**
 * Tests for the storyboard controller-requires lint.
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { lint } = require('../scripts/lint-storyboard-controller-requires.cjs');

test('source tree passes the controller-requires lint', () => {
  const violations = lint();
  assert.deepEqual(
    violations,
    [],
    'storyboards set controller_seeding: true without requires: [controller]:\n' +
      violations.map((v) => `  ${v.file}`).join('\n'),
  );
});

function lintDoc(doc) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'controller-requires-lint-'));
  fs.writeFileSync(path.join(tmp, 'temp.yaml'), doc);
  try {
    return lint(tmp);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test('controller_seeding without requires — flagged', () => {
  const violations = lintDoc(`
id: temp_storyboard
prerequisites:
  controller_seeding: true
phases: []
`);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].rule, 'controller_seeding_without_requires_controller');
});

test('controller_seeding with requires lacking controller — flagged', () => {
  const violations = lintDoc(`
id: temp_storyboard
requires: [multi_agent]
prerequisites:
  controller_seeding: true
phases: []
`);
  assert.equal(violations.length, 1);
});

test('controller_seeding with requires: [controller] — clean', () => {
  assert.deepEqual(
    lintDoc(`
id: temp_storyboard
requires:
  - multi_agent
  - controller
prerequisites:
  controller_seeding: true
phases: []
`),
    [],
  );
});

test('controller_seeding: false or absent — clean', () => {
  assert.deepEqual(
    lintDoc(`
id: temp_storyboard
prerequisites:
  controller_seeding: false
phases: []
`),
    [],
  );
  assert.deepEqual(lintDoc('id: temp_storyboard\nphases: []\n'), []);
});

test('requires given as a scalar string — flagged (schema requires a list)', () => {
  const violations = lintDoc(`
id: temp_storyboard
requires: controller
prerequisites:
  controller_seeding: true
phases: []
`);
  assert.equal(violations.length, 1);
});
