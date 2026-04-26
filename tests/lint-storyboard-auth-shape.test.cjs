#!/usr/bin/env node
/**
 * Tests for the storyboard auth-shape lint. Two concerns:
 *   1. Source-tree guard — every real storyboard under static/compliance/source
 *      passes the lint. Prevents regression when authors add step-level auth:
 *      declarations.
 *   2. Per-rule coverage — each rule ID fires when its authoring hazard is
 *      present. Tests import checkStep directly so they exercise the real
 *      code path and assert on the `rule` field so message wording can evolve
 *      without breaking tests.
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const yaml = require('js-yaml');

const { lint, checkStep, RULE_MESSAGES } = require('../scripts/lint-storyboard-auth-shape.cjs');

test('source tree passes the auth-shape lint', () => {
  const violations = lint();
  assert.deepEqual(
    violations,
    [],
    'real storyboards have auth-shape violations:\n' +
      violations.map((v) => `  ${v.file}:${v.phaseId}/${v.stepId} — ${v.rule}`).join('\n'),
  );
});

test('literal_value: object auth with string value: is flagged', () => {
  // The canonical antipattern. A storyboard hardcoding an api key binds to a
  // specific credential, can't rotate without rewriting, and leaks identity
  // into source.
  const step = yaml.load(`
task: list_creatives
auth:
  type: api_key
  value: "demo-acme-outdoor-v1"
`);
  const v = checkStep(step);
  assert.ok(v, 'expected violation for literal string value');
  assert.equal(v.rule, 'literal_value');
});

test('literal_value does NOT fire for legitimate shapes', () => {
  // The conventional shapes — each must pass. "value-absent" is the
  // `{ type: api_key }` case: object auth with no `value` field at all —
  // distinct from complete absence of `auth:`, and the shape the lint's
  // `typeof auth.value !== 'string'` early-return is written to handle.
  const cases = {
    absent: { task: 'list_creatives' },
    value_absent: yaml.load(`
task: list_creatives
auth: { type: api_key }
`),
    from_test_kit_true: yaml.load(`
task: list_creatives
auth: { type: api_key, from_test_kit: true }
`),
    from_test_kit_path: yaml.load(`
task: list_creatives
auth: { type: api_key, from_test_kit: "auth.principals.low_spend.api_key" }
`),
    value_strategy_random_invalid: yaml.load(`
task: list_creatives
auth: { type: api_key, value_strategy: random_invalid }
`),
    none: yaml.load(`
task: list_creatives
auth: none
`),
  };
  for (const [name, step] of Object.entries(cases)) {
    assert.equal(checkStep(step), null, `${name} should not be flagged`);
  }
});

test('literal_value: non-string value: is NOT flagged (schema type error, not a credential leak)', () => {
  // Defensive: the lint's concern is specifically plaintext credentials in
  // source. A numeric or object `value:` is schema-malformed but it isn't
  // the authoring antipattern this rule catches — a future schema validator
  // should reject it, not this lint.
  const numeric = yaml.load(`
task: list_creatives
auth: { type: api_key, value: 42 }
`);
  const nested = yaml.load(`
task: list_creatives
auth: { type: api_key, value: { nested: true } }
`);
  assert.equal(checkStep(numeric), null);
  assert.equal(checkStep(nested), null);
});

test('lint() aggregates violations across a synthetic tree with full {file, phaseId, stepId, rule} shape', () => {
  // End-to-end walker coverage: drop two YAML files across phases/steps into
  // a temp dir, run lint() against it, assert every violation carries the
  // expected keys and that the output ordering is deterministic
  // (file-walk order, then per-step document order). This exercises:
  //   - walkYaml + iterSteps + checkStep + aggregation all in one path
  //   - path.relative against a non-default SOURCE_DIR (the lint() dir param)
  //   - `<unnamed>` fallbacks for missing phase.id / step.id
  //   - multiple phases + multiple steps per file
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-shape-lint-'));
  try {
    fs.writeFileSync(
      path.join(tmp, 'violating.yaml'),
      `
id: sb_violating
phases:
  - id: p1
    steps:
      - id: leaks_api_key
        task: list_creatives
        auth: { type: api_key, value: "demo-literal" }
      - id: clean_step
        task: list_creatives
        auth: { type: api_key, from_test_kit: true }
  - steps:
      - task: list_creatives
        auth: { type: oauth_bearer, value: "bearer-literal" }
`,
    );
    fs.writeFileSync(
      path.join(tmp, 'clean.yaml'),
      `
id: sb_clean
phases:
  - id: p1
    steps:
      - id: ok
        task: list_creatives
        auth: { type: api_key, from_test_kit: true }
`,
    );

    const violations = lint(tmp);
    assert.equal(violations.length, 2, `expected 2 violations, got: ${JSON.stringify(violations)}`);
    for (const v of violations) {
      assert.ok(['file', 'phaseId', 'stepId', 'rule'].every((k) => k in v), `missing key in ${JSON.stringify(v)}`);
      assert.equal(v.rule, 'literal_value');
      assert.equal(v.file, 'violating.yaml');
    }
    // First violation: named phase + named step.
    assert.equal(violations[0].phaseId, 'p1');
    assert.equal(violations[0].stepId, 'leaks_api_key');
    // Second violation: unnamed phase + unnamed step → both fall back to '<unnamed>'.
    assert.equal(violations[1].phaseId, '<unnamed>');
    assert.equal(violations[1].stepId, '<unnamed>');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('RULE_MESSAGES.literal_value suggests every legitimate replacement', () => {
  // Authoring-UX anchor: the error the author sees when they hit this must
  // point at the three conventional replacements (from_test_kit true,
  // from_test_kit path, value_strategy). If the wording drifts and drops
  // one of those, the error becomes less helpful; this test localizes the
  // regression.
  const msg = RULE_MESSAGES.literal_value();
  assert.match(msg, /from_test_kit: true/);
  assert.match(msg, /from_test_kit: "<path>"/);
  assert.match(msg, /value_strategy/);
});
