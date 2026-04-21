#!/usr/bin/env node
/**
 * Tests for the cross-storyboard contradiction lint. Two concerns:
 *   1. Source-tree guard — every real storyboard under static/compliance/source
 *      passes the lint. Regression protection when authors add steps.
 *   2. Per-behavior coverage — synthetic fixtures exercise fingerprinting,
 *      state-path discrimination, outcome classification, env scoping, and
 *      branch-set peer exemption.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const yaml = require('js-yaml');

const {
  lint,
  extractEvents,
  findContradictions,
  canonicalizeRequest,
  fingerprintRequest,
  classifyOutcome,
  outcomesAgree,
  MUTATING_TASKS,
  MUTATING_EXCEPTIONS,
  loadMutatingTasksFromSchemas,
} = require('../scripts/lint-storyboard-contradictions.cjs');

const path = require('node:path');
const SCHEMAS_DIR = path.resolve(__dirname, '..', 'static', 'schemas', 'source');

function contradictionsAcrossDocs(docs) {
  const events = [];
  for (const [name, doc] of Object.entries(docs)) {
    for (const ev of extractEvents(doc, name)) events.push(ev);
  }
  return findContradictions(events);
}

test('MUTATING_TASKS is derived from idempotency_key-required schemas + exceptions', () => {
  // Drift guard: the union of (schemas requiring idempotency_key) and
  // MUTATING_EXCEPTIONS must equal MUTATING_TASKS exactly. If this test
  // breaks, a new mutating task was added without either (a) adding
  // idempotency_key to its request schema, or (b) documenting it in
  // MUTATING_EXCEPTIONS with a schema-level rationale.
  const derived = loadMutatingTasksFromSchemas(SCHEMAS_DIR);
  const expected = new Set([...derived, ...MUTATING_EXCEPTIONS]);
  assert.deepEqual(
    [...MUTATING_TASKS].sort(),
    [...expected].sort(),
    'MUTATING_TASKS drifted from (schema-derived + MUTATING_EXCEPTIONS)',
  );
});

test('every MUTATING_EXCEPTION is absent from the schema-derived set', () => {
  // If a task exists in both, the exception is redundant and should be
  // removed. This keeps MUTATING_EXCEPTIONS as a disciplined list of
  // genuine gaps the schema heuristic doesn't cover.
  const derived = loadMutatingTasksFromSchemas(SCHEMAS_DIR);
  const redundant = [...MUTATING_EXCEPTIONS].filter((t) => derived.has(t));
  assert.deepEqual(redundant, [], 'MUTATING_EXCEPTIONS entries redundant with schema');
});

test('schema-derived set covers known mutating tasks', () => {
  // Sanity check: these are anchored task names that MUST be present
  // regardless of schema refactors. If the schema filename convention
  // changes or a file moves, this test localizes the break.
  const derived = loadMutatingTasksFromSchemas(SCHEMAS_DIR);
  for (const task of ['create_media_buy', 'update_media_buy', 'sync_creatives', 'sync_audiences']) {
    assert.ok(derived.has(task), `expected ${task} in schema-derived mutating set`);
  }
});

test('schema-derived set does not over-match read-only tasks', () => {
  // Negative anchor: if a read-only request schema ever starts listing
  // idempotency_key in required (spec drift, accidental copy-paste), the
  // contradiction lint would silently over-discriminate state paths. Lock
  // in a handful of anchor reads so the bug surfaces here, not in a
  // false-positive at build time.
  const derived = loadMutatingTasksFromSchemas(SCHEMAS_DIR);
  for (const task of [
    'get_products',
    'get_signals',
    'list_creative_formats',
    'get_adcp_capabilities',
  ]) {
    assert.ok(!derived.has(task), `read-only ${task} must not be in mutating set`);
  }
});

test('source tree has no contradictions', () => {
  const contradictions = lint();
  assert.deepEqual(
    contradictions,
    [],
    'real storyboards contradict:\n' +
      contradictions
        .map((c) => {
          const [a, b] = c.mismatch;
          return `  ${a.file}:${a.stepId} vs ${b.file}:${b.stepId}`;
        })
        .join('\n'),
  );
});

test('canonicalizeRequest drops idempotency_key at any depth', () => {
  const a = { brand: { domain: 'x' }, idempotency_key: 'uuid-a' };
  const b = { brand: { domain: 'x' }, idempotency_key: 'uuid-b' };
  assert.equal(canonicalizeRequest(a), canonicalizeRequest(b));
});

test('canonicalizeRequest preserves nested distinguishing fields', () => {
  // Regression: JSON.stringify(value, arrayOfKeys) filters keys at EVERY
  // depth. The original bug caused nested `measurement_terms` to vanish
  // from fingerprints because it wasn't in the top-level key list.
  const a = {
    brand: { domain: 'x' },
    packages: [{ measurement_terms: { variance: 0 } }],
  };
  const b = {
    brand: { domain: 'x' },
    packages: [{ measurement_terms: { variance: 10 } }],
  };
  assert.notEqual(canonicalizeRequest(a), canonicalizeRequest(b));
});

test('canonicalizeRequest normalizes per-run substitutions stably', () => {
  // Two runs with different generated UUIDs or resolved context values but
  // semantically equivalent requests hash to the same fingerprint.
  const a = { id: '$generate:uuid_v4#alias_a', ref: '$context.media_buy_id' };
  const b = { id: '$generate:uuid_v4#alias_b', ref: '$context.media_buy_id' };
  assert.equal(fingerprintRequest(a), fingerprintRequest(b));
});

test('canonicalizeRequest normalizes Date objects (yaml.load ISO timestamps)', () => {
  // YAML 1.1 parses unquoted ISO timestamps into JS Date. Without Date
  // handling, stableStringify emits `{}` for every Date — two steps with
  // different start_time values collide silently.
  const a = { start_time: new Date('2024-01-01T00:00:00Z') };
  const b = { start_time: new Date('2026-06-15T00:00:00Z') };
  assert.notEqual(canonicalizeRequest(a), canonicalizeRequest(b));
});

test('canonicalizeRequest distinguishes different $context sources', () => {
  // $context.media_buy_id vs $context.plan_id are NOT interchangeable —
  // the name matters even though both resolve at runtime.
  const a = { ref: '$context.media_buy_id' };
  const b = { ref: '$context.plan_id' };
  assert.notEqual(fingerprintRequest(a), fingerprintRequest(b));
});

test('classifyOutcome extracts error_code allowed_values as a Set', () => {
  const step = {
    expect_error: true,
    validations: [
      { check: 'error_code', allowed_values: ['A', 'B'] },
      { check: 'field_present', path: 'context' },
    ],
  };
  const outcome = classifyOutcome(step);
  assert.equal(outcome.kind, 'error');
  assert.deepEqual([...outcome.codes].sort(), ['A', 'B']);
});

test('outcomesAgree: error sets with overlap agree, disjoint disagree', () => {
  const a = { kind: 'error', codes: new Set(['X', 'Y']) };
  const b = { kind: 'error', codes: new Set(['Y', 'Z']) };
  const c = { kind: 'error', codes: new Set(['Q']) };
  assert.equal(outcomesAgree(a, b), true);
  assert.equal(outcomesAgree(a, c), false);
});

test('outcomesAgree: success vs error disagree; unspecified is permissive', () => {
  const succ = { kind: 'success', codes: new Set() };
  const err = { kind: 'error', codes: new Set(['E']) };
  const unspec = { kind: 'unspecified', codes: new Set() };
  assert.equal(outcomesAgree(succ, err), false);
  assert.equal(outcomesAgree(succ, unspec), true);
  assert.equal(outcomesAgree(err, unspec), true);
});

test('contradiction detected: same task+request+state+env, disagreeing outcomes', () => {
  const docs = {
    'a.yaml': yaml.load(`
id: sb_shared
phases:
  - id: p
    steps:
      - id: succeed
        task: create_media_buy
        sample_request: { brand: { domain: x }, canceled: true }
        validations:
          - check: field_present
            path: media_buy_id
`),
    'b.yaml': yaml.load(`
id: sb_shared
phases:
  - id: p
    steps:
      - id: fail
        task: create_media_buy
        sample_request: { brand: { domain: x }, canceled: true }
        expect_error: true
        validations:
          - check: error_code
            value: NOT_CANCELLABLE
`),
  };
  const contradictions = contradictionsAcrossDocs(docs);
  assert.equal(contradictions.length, 1);
  const outcomes = contradictions[0].mismatch.map((m) => m.outcome.kind).sort();
  assert.deepEqual(outcomes, ['error', 'success']);
});

test('no contradiction when storyboard IDs differ (independent test suites)', () => {
  // Same task, same request, same outcome-disagreement — but two distinct
  // storyboards. The env fingerprint includes doc.id so cross-suite
  // differences in controller-seeded state are not flagged as contradictions.
  const docs = {
    'a.yaml': yaml.load(`
id: sb_a
phases:
  - id: p
    steps:
      - id: succeed
        task: create_media_buy
        sample_request: { brand: { domain: x } }
        validations:
          - check: field_present
            path: media_buy_id
`),
    'b.yaml': yaml.load(`
id: sb_b
phases:
  - id: p
    steps:
      - id: fail
        task: create_media_buy
        sample_request: { brand: { domain: x } }
        expect_error: true
        validations:
          - check: error_code
            value: GOVERNANCE_DENIED
`),
  };
  assert.deepEqual(contradictionsAcrossDocs(docs), []);
});

test('state-path discrimination: prior mutating step changes the key', () => {
  // Intra-storyboard double-cancel pattern: first cancel → success, second
  // cancel → NOT_CANCELLABLE. Different state paths → different keys →
  // no contradiction.
  const doc = yaml.load(`
id: sb_double_cancel
phases:
  - id: setup
    steps:
      - id: create_buy
        task: create_media_buy
        sample_request: { brand: { domain: x } }
        validations:
          - check: field_present
            path: media_buy_id
  - id: cancel_flow
    steps:
      - id: first_cancel
        task: update_media_buy
        sample_request: { media_buy_id: "$context.media_buy_id", canceled: true }
        validations:
          - check: field_value
            path: status
            value: canceled
      - id: second_cancel
        task: update_media_buy
        sample_request: { media_buy_id: "$context.media_buy_id", canceled: true }
        expect_error: true
        validations:
          - check: error_code
            value: NOT_CANCELLABLE
`);
  assert.deepEqual(contradictionsAcrossDocs({ 'a.yaml': doc }), []);
});

test('branch-set peers are exempt from contradiction flagging', () => {
  // past_start reject/adjust pattern: two optional peers legitimately
  // assert mutually exclusive outcomes under any_of semantics.
  const doc = yaml.load(`
id: sb_past_start
phases:
  - id: reject_path
    optional: true
    branch_set: { id: past_start_handled, semantics: any_of }
    steps:
      - id: reject
        task: create_media_buy
        sample_request: { brand: { domain: x }, start_time: "2020-01-01T00:00:00Z" }
        contributes: true
        expect_error: true
        validations:
          - check: error_code
            value: INVALID_REQUEST
  - id: adjust_path
    optional: true
    branch_set: { id: past_start_handled, semantics: any_of }
    steps:
      - id: adjust
        task: create_media_buy
        sample_request: { brand: { domain: x }, start_time: "2020-01-01T00:00:00Z" }
        contributes: true
        validations:
          - check: field_present
            path: media_buy_id
  - id: assert_phase
    steps:
      - id: assert_handled
        task: assert_contribution
        validations:
          - check: any_of
            allowed_values: [past_start_handled]
`);
  assert.deepEqual(contradictionsAcrossDocs({ 'a.yaml': doc }), []);
});

test('comply_scenario discriminates env: same request, different scenarios', () => {
  const doc = yaml.load(`
id: sb_env
phases:
  - id: p
    steps:
      - id: happy
        task: create_media_buy
        comply_scenario: baseline
        sample_request: { brand: { domain: x } }
        validations:
          - check: field_present
            path: media_buy_id
      - id: sad
        task: create_media_buy
        comply_scenario: governance_denied
        sample_request: { brand: { domain: x } }
        expect_error: true
        validations:
          - check: error_code
            value: GOVERNANCE_DENIED
`);
  assert.deepEqual(contradictionsAcrossDocs({ 'a.yaml': doc }), []);
});

test('test_kit discriminates env: two storyboards sharing id+scenario but different kits', () => {
  // Authoring hazard: two parallel storyboards copied from one template,
  // running against different agent fixtures via different test_kit paths.
  // They legitimately produce different outcomes for the same request
  // shape. Env fingerprint must discriminate.
  const docs = {
    'acme.yaml': yaml.load(`
id: sb_parallel
prerequisites:
  test_kit: "test-kits/acme-outdoor.yaml"
phases:
  - id: p
    steps:
      - id: succeed
        task: create_media_buy
        sample_request: { brand: { domain: x } }
        validations:
          - check: field_present
            path: media_buy_id
`),
    'osei.yaml': yaml.load(`
id: sb_parallel
prerequisites:
  test_kit: "test-kits/osei-natural.yaml"
phases:
  - id: p
    steps:
      - id: fail
        task: create_media_buy
        sample_request: { brand: { domain: x } }
        expect_error: true
        validations:
          - check: error_code
            value: GOVERNANCE_DENIED
`),
  };
  assert.deepEqual(contradictionsAcrossDocs(docs), []);
});

test('top-level fixtures discriminates env: same id, different seeded state', () => {
  // Two runs of the same storyboard id against different seeded prerequisite
  // state (via top-level `fixtures:`) can legitimately assert different
  // outcomes. Fingerprint must treat them as separate envs.
  const docs = {
    'approved.yaml': yaml.load(`
id: sb_seeded
fixtures:
  plans:
    - plan_id: pre_approved
      status: approved
phases:
  - id: p
    steps:
      - id: go
        task: create_media_buy
        sample_request: { brand: { domain: x }, plan_id: pre_approved }
        validations:
          - check: field_present
            path: media_buy_id
`),
    'denied.yaml': yaml.load(`
id: sb_seeded
fixtures:
  plans:
    - plan_id: pre_approved
      status: denied
phases:
  - id: p
    steps:
      - id: nope
        task: create_media_buy
        sample_request: { brand: { domain: x }, plan_id: pre_approved }
        expect_error: true
        validations:
          - check: error_code
            value: GOVERNANCE_DENIED
`),
  };
  assert.deepEqual(contradictionsAcrossDocs(docs), []);
});

test('auth override discriminates env: valid key vs random-invalid key', () => {
  const doc = yaml.load(`
id: sb_auth
phases:
  - id: p
    steps:
      - id: valid_key
        task: list_creatives
        sample_request: {}
        auth: { type: api_key, from_test_kit: true }
        validations:
          - check: http_status
            value: 200
      - id: invalid_key
        task: list_creatives
        sample_request: {}
        auth: { type: api_key, value_strategy: random_invalid }
        expect_error: true
        validations:
          - check: http_status_in
            allowed_values: [401, 403]
`);
  assert.deepEqual(contradictionsAcrossDocs({ 'a.yaml': doc }), []);
});
