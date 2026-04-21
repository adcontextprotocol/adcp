#!/usr/bin/env node
/**
 * Tests for the storyboard branch-set lint.
 *
 * Two concerns:
 *   1. Source tree guard — every real storyboard under static/compliance/source
 *      passes the lint. Prevents regression when authors add branch_set
 *      declarations.
 *   2. Synthetic fixtures — each rule produces the expected violation when
 *      broken. Uses the exported `collectAssertedFlags` helper and an in-test
 *      harness over the internal per-doc logic by re-implementing the walker
 *      against a single in-memory doc. Keeps the lint script's own code path
 *      unchanged.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const yaml = require('js-yaml');

const lintModule = require('../scripts/lint-storyboard-branch-sets.cjs');
const { lint, collectAssertedFlags, SUPPORTED_SEMANTICS } = lintModule;

/**
 * Run the lint logic against a single in-memory storyboard doc. Mirrors the
 * per-file logic inside the lint script, which is the reason the per-file
 * function isn't exported — keeping the exported surface small while still
 * letting tests target individual rules.
 */
function lintDoc(doc) {
  const violations = [];
  const phases = Array.isArray(doc?.phases) ? doc.phases : [];
  const semanticsById = new Map();
  const asserted = collectAssertedFlags(doc);

  for (const phase of phases) {
    const bs = phase?.branch_set;
    if (bs === undefined || bs === null) continue;

    const phaseId = phase.id || '<unnamed>';

    if (typeof bs !== 'object' || Array.isArray(bs)) {
      violations.push({ phaseId, rule: 'shape' });
      continue;
    }
    const { id, semantics } = bs;
    if (typeof id !== 'string' || id.length === 0) {
      violations.push({ phaseId, rule: 'missing_id' });
      continue;
    }
    if (typeof semantics !== 'string' || !SUPPORTED_SEMANTICS.has(semantics)) {
      violations.push({ phaseId, rule: 'bad_semantics' });
      continue;
    }
    if (phase.optional !== true) {
      violations.push({ phaseId, rule: 'not_optional' });
    }
    const prior = semanticsById.get(id);
    if (prior !== undefined && prior !== semantics) {
      violations.push({ phaseId, rule: 'semantics_conflict' });
    } else {
      semanticsById.set(id, semantics);
    }
    if (!asserted.has(id)) {
      violations.push({ phaseId, rule: 'no_assertion' });
    }
    const steps = Array.isArray(phase.steps) ? phase.steps : [];
    for (const step of steps) {
      const c = step?.contributes_to;
      if (c === undefined || c === null) continue;
      if (typeof c !== 'string' || c !== id) {
        violations.push({ phaseId, rule: 'contributes_to_mismatch', stepId: step?.id });
      }
    }
  }

  return violations;
}

test('source tree passes the branch-set lint', () => {
  const violations = lint();
  assert.deepEqual(
    violations,
    [],
    'real storyboards have branch-set violations:\n' +
      violations.map((v) => `  ${v.file}:${v.phaseId} ${v.stepId || ''} — ${v.message}`).join('\n'),
  );
});

test('rule 1: branch_set phase must be optional: true', () => {
  const doc = yaml.load(`
phases:
  - id: required_branch
    branch_set: { id: flag, semantics: any_of }
    steps: []
  - id: assert_it
    steps:
      - task: assert_contribution
        validations:
          - check: any_of
            allowed_values: [flag]
`);
  const v = lintDoc(doc);
  assert.ok(
    v.some((x) => x.phaseId === 'required_branch' && x.rule === 'not_optional'),
    `expected not_optional violation, got: ${JSON.stringify(v)}`,
  );
});

test('rule 2: semantics must be a supported value', () => {
  const doc = yaml.load(`
phases:
  - id: p
    optional: true
    branch_set: { id: flag, semantics: all_of }
    steps: []
  - id: assert_it
    steps:
      - task: assert_contribution
        validations:
          - check: any_of
            allowed_values: [flag]
`);
  const v = lintDoc(doc);
  assert.deepEqual(
    v.map((x) => x.rule),
    ['bad_semantics'],
  );
});

test('rule 3: peer phases must share semantics', () => {
  // Construct a doc where two phases share branch_set.id. The second peer's
  // semantics differs and has already been accepted (SUPPORTED_SEMANTICS only
  // includes any_of today, so this test locks in the check as we add more).
  // We temporarily expand SUPPORTED_SEMANTICS by monkey-patching — otherwise
  // the second phase would fail rule 2 first.
  const SEM_ANY = 'any_of';
  const SEM_NEW = 'future_semantics';
  SUPPORTED_SEMANTICS.add(SEM_NEW);
  try {
    const doc = yaml.load(`
phases:
  - id: peer_a
    optional: true
    branch_set: { id: shared, semantics: ${SEM_ANY} }
    steps: []
  - id: peer_b
    optional: true
    branch_set: { id: shared, semantics: ${SEM_NEW} }
    steps: []
  - id: assert_it
    steps:
      - task: assert_contribution
        validations:
          - check: any_of
            allowed_values: [shared]
`);
    const v = lintDoc(doc);
    assert.ok(
      v.some((x) => x.phaseId === 'peer_b' && x.rule === 'semantics_conflict'),
      `expected semantics_conflict on peer_b, got: ${JSON.stringify(v)}`,
    );
  } finally {
    SUPPORTED_SEMANTICS.delete(SEM_NEW);
  }
});

test('rule 4: branch_set.id must have a matching assert_contribution any_of', () => {
  const doc = yaml.load(`
phases:
  - id: lonely
    optional: true
    branch_set: { id: unreferenced, semantics: any_of }
    steps: []
`);
  const v = lintDoc(doc);
  assert.deepEqual(
    v.map((x) => ({ phaseId: x.phaseId, rule: x.rule })),
    [{ phaseId: 'lonely', rule: 'no_assertion' }],
  );
});

test('rule 5: contributes_to inside a branch_set phase must equal branch_set.id', () => {
  const doc = yaml.load(`
phases:
  - id: p
    optional: true
    branch_set: { id: flag, semantics: any_of }
    steps:
      - id: s_ok
        contributes_to: flag
      - id: s_bad
        contributes_to: typo_flag
  - id: assert_it
    steps:
      - task: assert_contribution
        validations:
          - check: any_of
            allowed_values: [flag]
`);
  const v = lintDoc(doc);
  const mismatches = v.filter((x) => x.rule === 'contributes_to_mismatch');
  assert.deepEqual(mismatches, [
    { phaseId: 'p', rule: 'contributes_to_mismatch', stepId: 's_bad' },
  ]);
});

test('collectAssertedFlags pulls every any_of flag from every assert_contribution step', () => {
  const doc = yaml.load(`
phases:
  - id: a
    steps:
      - task: assert_contribution
        validations:
          - check: any_of
            allowed_values: [flag_a, flag_b]
          - check: field_present
            path: x
  - id: b
    steps:
      - task: create_media_buy
        validations:
          - check: any_of
            allowed_values: [should_be_ignored]
      - task: assert_contribution
        validations:
          - check: any_of
            allowed_values: [flag_c]
`);
  const flags = collectAssertedFlags(doc);
  assert.deepEqual([...flags].sort(), ['flag_a', 'flag_b', 'flag_c']);
});
