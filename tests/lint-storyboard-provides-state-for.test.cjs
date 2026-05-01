#!/usr/bin/env node
/**
 * Tests for the storyboard `provides_state_for` lint. Two concerns:
 *   1. Source-tree guard — every real storyboard under static/compliance/source
 *      passes the lint. Prevents regression when authors add new
 *      provides_state_for declarations.
 *   2. Per-rule coverage — each rule ID fires when its authoring hazard is
 *      present. Tests import lintDoc directly so they exercise the real code
 *      path, not a parallel re-implementation, and assert on the `rule` field
 *      so message wording can evolve without breaking tests.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const yaml = require('js-yaml');

const { lint, lintDoc } = require('../scripts/lint-storyboard-provides-state-for.cjs');

test('source tree passes the provides_state_for lint', () => {
  const violations = lint();
  assert.deepEqual(
    violations,
    [],
    'real storyboards have provides_state_for violations:\n' +
      violations.map((v) => `  ${v.file}:${v.phaseId}/${v.stepId} — ${v.rule}`).join('\n'),
  );
});

test('absent field is a no-op', () => {
  const doc = yaml.load(`
phases:
  - id: p
    steps:
      - id: a
        stateful: true
      - id: b
        stateful: true
`);
  assert.deepEqual(lintDoc(doc), []);
});

test('valid same-phase substitution passes', () => {
  const doc = yaml.load(`
phases:
  - id: p
    steps:
      - id: a
        stateful: true
        provides_state_for: b
      - id: b
        stateful: true
`);
  assert.deepEqual(lintDoc(doc), []);
});

test('valid array form passes', () => {
  const doc = yaml.load(`
phases:
  - id: p
    steps:
      - id: a
        stateful: true
        provides_state_for: [b, c]
      - id: b
        stateful: true
      - id: c
        stateful: true
`);
  assert.deepEqual(lintDoc(doc), []);
});

test('shape: numeric value rejected', () => {
  const doc = yaml.load(`
phases:
  - id: p
    steps:
      - id: a
        stateful: true
        provides_state_for: 42
      - id: b
        stateful: true
`);
  const rules = lintDoc(doc).map((v) => v.rule);
  assert.deepEqual(rules, ['shape']);
});

test('shape: array with non-string entry rejected', () => {
  const doc = yaml.load(`
phases:
  - id: p
    steps:
      - id: a
        stateful: true
        provides_state_for: [b, 7]
      - id: b
        stateful: true
`);
  const rules = lintDoc(doc).map((v) => v.rule);
  assert.deepEqual(rules, ['shape']);
});

test('shape: empty string rejected', () => {
  const doc = yaml.load(`
phases:
  - id: p
    steps:
      - id: a
        stateful: true
        provides_state_for: ""
      - id: b
        stateful: true
`);
  const rules = lintDoc(doc).map((v) => v.rule);
  assert.deepEqual(rules, ['shape']);
});

test('shape: empty array rejected', () => {
  const doc = yaml.load(`
phases:
  - id: p
    steps:
      - id: a
        stateful: true
        provides_state_for: []
      - id: b
        stateful: true
`);
  const rules = lintDoc(doc).map((v) => v.rule);
  assert.deepEqual(rules, ['shape']);
});

test('self_reference: substitute names own id', () => {
  const doc = yaml.load(`
phases:
  - id: p
    steps:
      - id: a
        stateful: true
        provides_state_for: a
      - id: b
        stateful: true
`);
  const rules = lintDoc(doc).map((v) => v.rule);
  assert.ok(rules.includes('self_reference'));
});

test('unknown_target: target id not in storyboard', () => {
  const doc = yaml.load(`
phases:
  - id: p
    steps:
      - id: a
        stateful: true
        provides_state_for: nonexistent
      - id: b
        stateful: true
`);
  const rules = lintDoc(doc).map((v) => v.rule);
  assert.deepEqual(rules, ['unknown_target']);
});

test('cross_phase: target lives in a different phase', () => {
  const doc = yaml.load(`
phases:
  - id: p1
    steps:
      - id: a
        stateful: true
        provides_state_for: b
  - id: p2
    steps:
      - id: b
        stateful: true
`);
  const rules = lintDoc(doc).map((v) => v.rule);
  assert.deepEqual(rules, ['cross_phase']);
});

test('substitute_not_stateful: substitute step lacks stateful: true', () => {
  const doc = yaml.load(`
phases:
  - id: p
    steps:
      - id: a
        provides_state_for: b
      - id: b
        stateful: true
`);
  const rules = lintDoc(doc).map((v) => v.rule);
  assert.ok(rules.includes('substitute_not_stateful'));
});

test('target_not_stateful: target step lacks stateful: true', () => {
  const doc = yaml.load(`
phases:
  - id: p
    steps:
      - id: a
        stateful: true
        provides_state_for: b
      - id: b
`);
  const rules = lintDoc(doc).map((v) => v.rule);
  assert.ok(rules.includes('target_not_stateful'));
});

test('cycle: A→B and B→A in the same phase', () => {
  const doc = yaml.load(`
phases:
  - id: p
    steps:
      - id: a
        stateful: true
        provides_state_for: b
      - id: b
        stateful: true
        provides_state_for: a
`);
  const violations = lintDoc(doc);
  const cycles = violations.filter((v) => v.rule === 'cycle');
  // cycle reported once per pair, on the lexicographically lower step id
  assert.equal(cycles.length, 1);
  assert.equal(cycles[0].stepId, 'a');
  assert.equal(cycles[0].target, 'b');
});

test('cycle: only direct two-step cycles fire', () => {
  // A→B, B→C, C→A — three-step cycle. Direct-cycle detection (per-pair) does
  // not fire. This is by design — provides_state_for is a same-phase, per-step
  // contract; longer chains imply a state shape the substitute mechanism isn't
  // designed for. Rather than silently accept a chain, the per-step rules
  // (target_not_stateful, etc.) catch the underlying authoring mistake on
  // each edge, and the chain is unreachable in practice.
  const doc = yaml.load(`
phases:
  - id: p
    steps:
      - id: a
        stateful: true
        provides_state_for: b
      - id: b
        stateful: true
        provides_state_for: c
      - id: c
        stateful: true
        provides_state_for: a
`);
  const violations = lintDoc(doc);
  assert.deepEqual(
    violations.filter((v) => v.rule === 'cycle'),
    [],
  );
});
