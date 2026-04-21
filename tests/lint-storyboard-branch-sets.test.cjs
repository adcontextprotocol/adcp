#!/usr/bin/env node
/**
 * Tests for the storyboard branch-set lint. Two concerns:
 *   1. Source-tree guard — every real storyboard under static/compliance/source
 *      passes the lint. Prevents regression when authors add branch_set
 *      declarations.
 *   2. Per-rule coverage — each rule ID fires when its authoring hazard is
 *      present. Tests import lintDoc directly so they exercise the real code
 *      path, not a parallel re-implementation, and assert on the `rule` field
 *      so message wording can evolve without breaking tests.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const yaml = require('js-yaml');

const {
  lint,
  lintDoc,
  collectAssertedFlags,
  buildScenarioFlagIndex,
} = require('../scripts/lint-storyboard-branch-sets.cjs');

test('source tree passes the branch-set lint', () => {
  const violations = lint();
  assert.deepEqual(
    violations,
    [],
    'real storyboards have branch-set violations:\n' +
      violations.map((v) => `  ${v.file}:${v.phaseId} ${v.stepId || ''} — ${v.rule}`).join('\n'),
  );
});

test('not_optional: branch_set phase must be optional: true', () => {
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
  const rules = lintDoc(doc).map((v) => v.rule);
  assert.ok(rules.includes('not_optional'), `expected not_optional in ${JSON.stringify(rules)}`);
});

test('bad_semantics: semantics must be supported', () => {
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
  assert.deepEqual(
    lintDoc(doc).map((v) => v.rule),
    ['bad_semantics'],
  );
});

test('semantics_conflict: peer phases must share semantics (injected supported set)', () => {
  // Only any_of is supported today, so we can't exercise this rule with a
  // second real value. Injecting supportedSemantics lets the test cover the
  // rule without mutating module state — the real code path is unchanged.
  const doc = yaml.load(`
phases:
  - id: peer_a
    optional: true
    branch_set: { id: shared, semantics: any_of }
    steps: []
  - id: peer_b
    optional: true
    branch_set: { id: shared, semantics: future_semantics }
    steps: []
  - id: assert_it
    steps:
      - task: assert_contribution
        validations:
          - check: any_of
            allowed_values: [shared]
`);
  const violations = lintDoc(doc, {
    supportedSemantics: new Set(['any_of', 'future_semantics']),
  });
  assert.ok(
    violations.some((v) => v.rule === 'semantics_conflict' && v.phaseId === 'peer_b'),
    `expected semantics_conflict on peer_b, got: ${JSON.stringify(violations)}`,
  );
});

test('no_assertion: branch_set.id must be consumed by an assert_contribution any_of', () => {
  const doc = yaml.load(`
phases:
  - id: lonely
    optional: true
    branch_set: { id: unreferenced, semantics: any_of }
    steps: []
`);
  const violations = lintDoc(doc);
  assert.deepEqual(
    violations.map((v) => ({ rule: v.rule, phaseId: v.phaseId })),
    [{ rule: 'no_assertion', phaseId: 'lonely' }],
  );
});

test('contributes_to_mismatch: step contributes_to must equal branch_set.id', () => {
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
  const mismatches = lintDoc(doc).filter((v) => v.rule === 'contributes_to_mismatch');
  assert.deepEqual(
    mismatches.map((v) => ({ phaseId: v.phaseId, stepId: v.stepId })),
    [{ phaseId: 'p', stepId: 's_bad' }],
  );
});

test('peer_not_declared: mixed-mode peer with contributes_to to a declared id', () => {
  // Authoring hazard this rule exists for: one peer migrates to the explicit
  // branch_set form, a sibling optional peer still relies on implicit
  // contributes_to. A runner preferring the explicit declaration would see a
  // single-member set and grade the sibling as `failed` instead of
  // `peer_branch_taken`.
  const doc = yaml.load(`
phases:
  - id: explicit_peer
    optional: true
    branch_set: { id: shared_flag, semantics: any_of }
    steps:
      - id: contributes_step
        contributes_to: shared_flag
  - id: implicit_peer
    optional: true
    steps:
      - id: legacy_step
        contributes_to: shared_flag
  - id: assert_it
    steps:
      - task: assert_contribution
        validations:
          - check: any_of
            allowed_values: [shared_flag]
`);
  const violations = lintDoc(doc);
  const peerViolations = violations.filter((v) => v.rule === 'peer_not_declared');
  assert.deepEqual(
    peerViolations.map((v) => ({ phaseId: v.phaseId, stepId: v.stepId, id: v.id })),
    [{ phaseId: 'implicit_peer', stepId: 'legacy_step', id: 'shared_flag' }],
  );
});

test('pure-implicit storyboards do not trip peer_not_declared', () => {
  // A storyboard with no branch_set: declarations at all stays in implicit
  // mode and must not fire peer_not_declared — rule 6 only activates when at
  // least one phase in the storyboard has adopted the explicit form.
  const doc = yaml.load(`
phases:
  - id: peer_a
    optional: true
    steps:
      - id: a
        contributes_to: shared
  - id: peer_b
    optional: true
    steps:
      - id: b
        contributes_to: shared
  - id: assert_it
    steps:
      - task: assert_contribution
        validations:
          - check: any_of
            allowed_values: [shared]
`);
  assert.deepEqual(lintDoc(doc), []);
});

test('contributes_both: step cannot declare both `contributes` and `contributes_to`', () => {
  const doc = yaml.load(`
phases:
  - id: p
    optional: true
    branch_set: { id: flag, semantics: any_of }
    steps:
      - id: ambiguous
        contributes: true
        contributes_to: flag
  - id: assert_it
    steps:
      - task: assert_contribution
        validations:
          - check: any_of
            allowed_values: [flag]
`);
  const rules = lintDoc(doc).map((v) => v.rule);
  assert.ok(rules.includes('contributes_both'), `expected contributes_both in ${JSON.stringify(rules)}`);
});

test('contributes_outside_branch_set: `contributes: true` only legal inside a branch_set phase', () => {
  const doc = yaml.load(`
phases:
  - id: plain_phase
    steps:
      - id: nope
        contributes: true
`);
  const rules = lintDoc(doc).map((v) => v.rule);
  assert.ok(rules.includes('contributes_outside_branch_set'), `got ${JSON.stringify(rules)}`);
});

test('contributes_bad_type: `contributes` must be boolean', () => {
  const doc = yaml.load(`
phases:
  - id: p
    steps:
      - id: stringy
        contributes: "true"
`);
  const rules = lintDoc(doc).map((v) => v.rule);
  assert.ok(rules.includes('contributes_bad_type'));
});

test('orphan_contribution: contributes_to with no assert_contribution is dead', () => {
  const doc = yaml.load(`
phases:
  - id: p
    steps:
      - id: orphan_step
        contributes_to: unused_flag
`);
  const orphans = lintDoc(doc).filter((v) => v.rule === 'orphan_contribution');
  assert.deepEqual(
    orphans.map((v) => ({ stepId: v.stepId, flag: v.flag })),
    [{ stepId: 'orphan_step', flag: 'unused_flag' }],
  );
});

test('orphan_contribution fires on `contributes: true` that resolves to an unasserted branch_set.id', () => {
  // Edge case: a branch_set phase exists but no assert_contribution consumes
  // its id. The existing `no_assertion` rule fires on the phase; the
  // `contributes: true` step should also flag as orphan.
  const doc = yaml.load(`
phases:
  - id: p
    optional: true
    branch_set: { id: unasserted, semantics: any_of }
    steps:
      - id: contributing
        contributes: true
`);
  const violations = lintDoc(doc);
  const orphans = violations.filter((v) => v.rule === 'orphan_contribution');
  assert.equal(orphans.length, 1);
  assert.equal(orphans[0].flag, 'unasserted');
});

test('orphan_contribution: requires_scenarios resolves linked assertions', () => {
  // A parent storyboard delegates grading to a linked scenario via
  // `requires_scenarios`. Contributions in the parent that the scenario
  // asserts must not fire orphan_contribution.
  const parent = yaml.load(`
id: parent_sb
requires_scenarios: [linked_suite/governance_denied]
phases:
  - id: emit
    steps:
      - id: contribute
        contributes_to: governance_denied_flag
`);
  const scenarioFlagIndex = new Map([
    ['linked_suite/governance_denied', new Set(['governance_denied_flag'])],
  ]);
  const orphans = lintDoc(parent, { scenarioFlagIndex }).filter(
    (v) => v.rule === 'orphan_contribution',
  );
  assert.deepEqual(orphans, []);
});

test('orphan_contribution: unresolved requires_scenarios still flags orphan', () => {
  // Missing scenarios don't pretend the flag is asserted. Orphan violation
  // fires independently of the new unresolved_scenario_reference rule.
  const parent = yaml.load(`
id: parent_sb
requires_scenarios: [nonexistent/foo]
phases:
  - id: emit
    steps:
      - id: contribute
        contributes_to: dangling
`);
  const orphans = lintDoc(parent, { scenarioFlagIndex: new Map() }).filter(
    (v) => v.rule === 'orphan_contribution',
  );
  assert.deepEqual(
    orphans.map((v) => ({ stepId: v.stepId, flag: v.flag })),
    [{ stepId: 'contribute', flag: 'dangling' }],
  );
});

test('unresolved_scenario_reference: fires on requires_scenarios id absent from index', () => {
  // Symmetric with the duplicate-doc.id throw in buildScenarioFlagIndex:
  // if collisions are a build-time error, missing references must be too.
  // The runner will grade this storyboard not_applicable at execution
  // time; surface it at lint time so authors catch the typo/rename.
  const parent = yaml.load(`
id: parent_unresolved
requires_scenarios: [typo/misnamed_scenario, present/scenario]
phases:
  - id: p
    steps: []
`);
  const scenarioFlagIndex = new Map([['present/scenario', new Set()]]);
  const unresolved = lintDoc(parent, { scenarioFlagIndex }).filter(
    (v) => v.rule === 'unresolved_scenario_reference',
  );
  assert.deepEqual(
    unresolved.map((v) => v.scenarioId),
    ['typo/misnamed_scenario'],
  );
});

test('unresolved_scenario_reference: absent when scenarioFlagIndex is not provided', () => {
  // Back-compat: callers that don't pass the index (pre-#2671 code paths,
  // unit tests) don't trigger the new rule. Only kicks in when the lint
  // has the source-tree context to verify resolution.
  const parent = yaml.load(`
id: parent_no_index
requires_scenarios: [any/id]
phases:
  - id: p
    steps: []
`);
  const unresolved = lintDoc(parent).filter(
    (v) => v.rule === 'unresolved_scenario_reference',
  );
  assert.deepEqual(unresolved, []);
});

test('unresolved_scenario_reference: fires once per occurrence on duplicate unresolved ids', () => {
  // Duplicate entries in the array produce one violation per occurrence.
  // If a future refactor de-duplicates, this test forces the decision to
  // be explicit rather than silent.
  const parent = yaml.load(`
id: parent_dup_unresolved
requires_scenarios: [typo/x, typo/x]
phases:
  - id: p
    steps: []
`);
  const unresolved = lintDoc(parent, { scenarioFlagIndex: new Map() }).filter(
    (v) => v.rule === 'unresolved_scenario_reference',
  );
  assert.equal(unresolved.length, 2);
  assert.ok(unresolved.every((v) => v.scenarioId === 'typo/x'));
});

test('unresolved_scenario_reference: no violation for resolved references', () => {
  const parent = yaml.load(`
id: parent_all_resolve
requires_scenarios: [a/one, b/two]
phases:
  - id: p
    steps: []
`);
  const scenarioFlagIndex = new Map([
    ['a/one', new Set()],
    ['b/two', new Set()],
  ]);
  const unresolved = lintDoc(parent, { scenarioFlagIndex }).filter(
    (v) => v.rule === 'unresolved_scenario_reference',
  );
  assert.deepEqual(unresolved, []);
});

test('buildScenarioFlagIndex indexes source tree by doc.id', () => {
  // Real source tree is indexed and non-empty. No current scenario file
  // uses assert_contribution, so the in-memory round-trip below exercises
  // the flag-collection path directly.
  const index = buildScenarioFlagIndex(
    require('node:path').resolve(__dirname, '..', 'static', 'compliance', 'source'),
  );
  assert.ok(index.size > 0, 'expected scenario flag index to be non-empty');
  // Known anchor: a real scenario file that requires_scenarios points at.
  assert.ok(
    index.has('media_buy_seller/governance_denied'),
    'expected media_buy_seller/governance_denied in index',
  );
});

test('buildScenarioFlagIndex throws on duplicate doc.id across files', () => {
  // Load-bearing for orphan resolution: a duplicate id would make "which
  // file's asserted flags win" order-dependent on filesystem iteration,
  // potentially masking a real orphan elsewhere. Surface the collision.
  const fs = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'branch-set-lint-'));
  try {
    fs.writeFileSync(path.join(tmp, 'a.yaml'), 'id: collide\nphases: []\n');
    fs.writeFileSync(path.join(tmp, 'b.yaml'), 'id: collide\nphases: []\n');
    assert.throws(() => buildScenarioFlagIndex(tmp), /duplicate storyboard id "collide"/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('requires_scenarios: non-string entries are skipped, not thrown', () => {
  // Defensive: authoring error (e.g., accidental map entry) shouldn't crash
  // the lint. Strings resolve; non-strings are ignored.
  const parent = yaml.load(`
id: parent_mixed
requires_scenarios:
  - valid_scenario
  - 42
  - { not: a string }
phases:
  - id: emit
    steps:
      - id: contribute
        contributes_to: a_flag
`);
  const scenarioFlagIndex = new Map([
    ['valid_scenario', new Set(['a_flag'])],
  ]);
  const orphans = lintDoc(parent, { scenarioFlagIndex }).filter(
    (v) => v.rule === 'orphan_contribution',
  );
  assert.deepEqual(orphans, []);
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
