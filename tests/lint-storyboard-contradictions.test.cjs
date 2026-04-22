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
  fingerprintEnv,
  classifyOutcome,
  outcomesAgree,
  MUTATING_TASKS,
  loadMutatingTasksFromSchemas,
  normalizeFixturesForHashing,
  describeStepAuth,
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

test('MUTATING_TASKS is derived entirely from x-mutates-state schemas', () => {
  // Drift guard: the schema-derived set (via `x-mutates-state: true`)
  // must equal MUTATING_TASKS exactly. If this test breaks, a new
  // mutating task shipped without its request schema declaring
  // `x-mutates-state: true`, or vice versa.
  const derived = loadMutatingTasksFromSchemas(SCHEMAS_DIR);
  assert.deepEqual(
    [...MUTATING_TASKS].sort(),
    [...derived].sort(),
    'MUTATING_TASKS drifted from schemas — add or remove x-mutates-state: true',
  );
});

test('schema-derived set covers known mutating tasks', () => {
  // Sanity check: these are anchored task names that MUST be present
  // regardless of schema refactors. If the schema filename convention
  // changes or a file moves, this test localizes the break. Includes
  // the two tasks that were exceptions under the old idempotency-key
  // heuristic (comply_test_controller, si_terminate_session) — both
  // now declare x-mutates-state: true explicitly.
  const derived = loadMutatingTasksFromSchemas(SCHEMAS_DIR);
  for (const task of [
    'create_media_buy',
    'update_media_buy',
    'sync_creatives',
    'sync_audiences',
    'comply_test_controller',
    'si_terminate_session',
  ]) {
    assert.ok(derived.has(task), `expected ${task} in schema-derived mutating set`);
  }
});

test('schema-derived set does not over-match read-only tasks', () => {
  // Negative anchor: if a read-only request schema ever declares
  // `x-mutates-state: true` (spec drift, accidental copy-paste), the
  // contradiction lint would silently over-discriminate state paths.
  // Lock in a handful of anchor reads so the bug surfaces here, not
  // in a false-positive at build time.
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

test('cross-storyboard contradictions surface when ids differ but env matches', () => {
  // #2670 part 2: the env fingerprint no longer includes `sb=<doc.id>`, so
  // two storyboards declaring disagreeing outcomes for the same
  // (task, request, state, env) triple land in the same group and fire
  // as a contradiction — which is the exact bug class (#2627, #2628,
  // #2629) this lint exists to catch. Prior to this change the sb=
  // component suppressed the cross-storyboard case entirely.
  const docs = {
    'a.yaml': yaml.load(`
id: sb_a
caller:
  role: buyer_agent
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
    'b.yaml': yaml.load(`
id: sb_b
caller:
  role: buyer_agent
prerequisites:
  test_kit: "test-kits/acme-outdoor.yaml"
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
  const contradictions = contradictionsAcrossDocs(docs);
  assert.equal(contradictions.length, 1, 'expected one cross-storyboard contradiction');
  const [c] = contradictions;
  // Assert files via `members` (full group) not `mismatch` (one picked pair) —
  // `findContradictions` only records the first disagreeing pair per group,
  // so `mismatch` is brittle under group-size changes. `members` is stable.
  const memberFiles = new Set(c.members.map((m) => m.file));
  assert.deepEqual([...memberFiles].sort(), ['a.yaml', 'b.yaml']);
  // Pin the kind of disagreement, not just its existence: one success, one
  // error. Guards against a future regression where grouping still fires but
  // the outcome classification flipped for an unrelated reason.
  const outcomes = c.members.map((m) => m.outcome.kind).sort();
  assert.deepEqual(outcomes, ['error', 'success']);
});

test('cross-storyboard env differences still protect: different test_kit + different ids → no contradiction', () => {
  // Complementary to the cross-storyboard-surface test above. After dropping
  // `sb=` from the env fingerprint, the burden of separating legitimately-
  // different test vectors falls entirely on the remaining env components
  // (test_kit / role / fixtures / scenario / auth / seed). This test pins
  // that two storyboards running against *different* test kits can still
  // assert disagreeing outcomes for the same request without being flagged
  // — i.e., `test_kit=` still discriminates correctly across storyboard
  // files, not just within-file.
  const docs = {
    'acme.yaml': yaml.load(`
id: sb_acme
caller:
  role: buyer_agent
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
    'nova.yaml': yaml.load(`
id: sb_nova
caller:
  role: buyer_agent
prerequisites:
  test_kit: "test-kits/nova-motors.yaml"
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
  //
  // With `sb=<doc.id>` removed from the env fingerprint (#2670 part 2),
  // `test_kit=` is the sole discriminator here — both docs deliberately
  // share `id:` so no implicit fallback separates them.
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

test('caller.role discriminates env: shared test_kit, distinct principal roles', () => {
  // Forward guard (#2684): once #2670 part 2 removes `sb=` from the env
  // fingerprint, two storyboards sharing a test_kit but exercising
  // different principal roles (buyer_agent vs. orchestrator) would
  // collapse into one fingerprint and false-positive as a contradiction.
  // Note: both docs deliberately share id + test_kit; `role=<doc.caller.role>`
  // is the sole discriminator under test.
  const docs = {
    'as_buyer.yaml': yaml.load(`
id: sb_role_split
caller:
  role: buyer_agent
prerequisites:
  test_kit: "test-kits/shared.yaml"
phases:
  - id: p
    steps:
      - id: approved
        task: create_media_buy
        sample_request: { brand: { domain: x } }
        validations:
          - check: field_present
            path: media_buy_id
`),
    'as_orchestrator.yaml': yaml.load(`
id: sb_role_split
caller:
  role: orchestrator
prerequisites:
  test_kit: "test-kits/shared.yaml"
phases:
  - id: p
    steps:
      - id: denied
        task: create_media_buy
        sample_request: { brand: { domain: x } }
        expect_error: true
        validations:
          - check: error_code
            value: POLICY_VIOLATION
`),
  };
  assert.deepEqual(contradictionsAcrossDocs(docs), []);

  // Direct fingerprint-level assertion: pin the discrimination to the
  // role component specifically, not just "no contradiction fired for
  // some reason." A future refactor that stops classifying outcomes
  // across docs would leave the deepEqual check green.
  const step = { comply_scenario: 'create' };
  assert.notEqual(
    fingerprintEnv(step, {}, docs['as_buyer.yaml']),
    fingerprintEnv(step, {}, docs['as_orchestrator.yaml']),
  );
});

test('env fingerprint tolerates missing caller block', () => {
  // Guard: storyboards without a `caller:` block (or with non-string
  // `caller.role`) must not crash the fingerprint and must not emit a
  // spurious `role=` component. Matches the `typeof === 'string'`
  // guards on sb/test_kit.
  const docNoCaller = { id: 'sb_x', prerequisites: { test_kit: 'tk' } };
  const docShapeyRole = { id: 'sb_x', caller: { role: { name: 'buyer' } }, prerequisites: { test_kit: 'tk' } };
  const step = { comply_scenario: 'create' };
  const fpNone = fingerprintEnv(step, {}, docNoCaller);
  const fpShapey = fingerprintEnv(step, {}, docShapeyRole);
  assert.equal(fpNone, fpShapey, 'non-string caller.role should be ignored like a missing caller block');
  assert.ok(!fpNone.includes('role='), 'missing caller block must not produce a role= component');
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

test('fixtures hash is stable across array-order permutations within a category', () => {
  // Regression guard: `products: [A, B]` and `products: [B, A]` seed the
  // same runner state (the seeding DAG keys on foreign-key dependencies,
  // not intra-array order). Their env fingerprints must match.
  const docA = {
    id: 'sb_fx',
    fixtures: {
      products: [
        { product_id: 'p1', delivery_type: 'guaranteed' },
        { product_id: 'p2', delivery_type: 'non_guaranteed' },
      ],
      creatives: [
        { creative_id: 'c1', status: 'approved' },
        { creative_id: 'c2', status: 'pending' },
      ],
    },
  };
  const docB = {
    id: 'sb_fx',
    fixtures: {
      products: [
        { product_id: 'p2', delivery_type: 'non_guaranteed' },
        { product_id: 'p1', delivery_type: 'guaranteed' },
      ],
      creatives: [
        { creative_id: 'c2', status: 'pending' },
        { creative_id: 'c1', status: 'approved' },
      ],
    },
  };
  const step = { comply_scenario: 'test' };
  assert.equal(fingerprintEnv(step, {}, docA), fingerprintEnv(step, {}, docB));
});

test('fixtures hash still discriminates genuinely different entries', () => {
  // Complement to the stability guard: different fixture CONTENTS must
  // still produce different env fingerprints, even if the array order
  // looks similar.
  const docA = {
    id: 'sb_fx',
    fixtures: {
      plans: [{ plan_id: 'pre_approved', status: 'approved' }],
    },
  };
  const docB = {
    id: 'sb_fx',
    fixtures: {
      plans: [{ plan_id: 'pre_approved', status: 'denied' }],
    },
  };
  const step = { comply_scenario: 'test' };
  assert.notEqual(fingerprintEnv(step, {}, docA), fingerprintEnv(step, {}, docB));
});

test('normalizeFixturesForHashing throws on unknown fixture category', () => {
  // Schema-lint coupling: a new category added to storyboard-schema.yaml
  // without updating FIXTURE_CATEGORY_PRIMARY_ID would silently create a
  // false-negative bucket in the env fingerprint. Force the schema doc
  // update and the lint update to land together.
  const input = {
    custom_entities: [{ some_field: 'z' }, { some_field: 'a' }],
  };
  assert.throws(
    () => normalizeFixturesForHashing(input),
    /unknown fixture category "custom_entities"/,
  );
});

test('normalizeFixturesForHashing accepts every documented category', () => {
  // Complement to the throw: the five categories the schema documents
  // today must round-trip cleanly. Guards against a rename or typo in
  // FIXTURE_CATEGORY_PRIMARY_ID that would break all storyboards
  // declaring fixtures.
  const input = {
    products: [{ product_id: 'p1' }],
    pricing_options: [{ pricing_option_id: 'po1' }],
    creatives: [{ creative_id: 'c1' }],
    plans: [{ plan_id: 'pl1' }],
    media_buys: [{ media_buy_id: 'mb1' }],
  };
  assert.doesNotThrow(() => normalizeFixturesForHashing(input));
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

test('describeStepAuth covers the declared shape matrix (#2708, #2711)', () => {
  // Unit-level coverage of the effective-credential reduction so each
  // branch of the fingerprint shape matrix is pinned independently of
  // the cross-storyboard contradiction path.

  // #2711: absent step.auth must emit a distinct, stable token rather
  // than vanishing from the fingerprint. `kit_default` is the sentinel.
  assert.equal(describeStepAuth(undefined), 'kit_default');

  // `auth: none` strips credentials entirely.
  assert.equal(describeStepAuth('none'), 'none');

  // Declared `from_test_kit: true` resolves to the kit's default principal
  // but carries type info the default case can't express.
  assert.equal(describeStepAuth({ type: 'api_key', from_test_kit: true }), 'api_key:from_test_kit');
  assert.equal(describeStepAuth({ type: 'oauth_bearer', from_test_kit: true }), 'oauth_bearer:from_test_kit');

  // #2708: `from_test_kit: "<path>"` selects a named principal within a
  // multi-principal kit. The path must be in the fingerprint so two
  // steps against the same kit but different principals discriminate.
  assert.equal(
    describeStepAuth({ type: 'api_key', from_test_kit: 'auth.principals.low_spend.api_key' }),
    'api_key:from_test_kit:auth.principals.low_spend.api_key',
  );
  assert.notEqual(
    describeStepAuth({ type: 'api_key', from_test_kit: 'auth.principals.low_spend.api_key' }),
    describeStepAuth({ type: 'api_key', from_test_kit: 'auth.principals.full_auth.api_key' }),
  );

  // `value_strategy` — per-run random values; the strategy name IS the
  // identity (no stable value to hash).
  assert.equal(
    describeStepAuth({ type: 'api_key', value_strategy: 'random_invalid' }),
    'api_key:random_invalid',
  );

  // #2708: literal values hash to 8 hex chars. Two different literals do
  // not collide. Hashes are pinned to precomputed sha1(literal).slice(0,8)
  // values so an accidental switch to a non-deterministic hash or a
  // truncation-width change surfaces here rather than silently shifting
  // fingerprint buckets.
  assert.equal(
    describeStepAuth({ type: 'api_key', value: 'key-a' }),
    'api_key:literal:70efd783',
  );
  assert.equal(
    describeStepAuth({ type: 'api_key', value: 'key-b' }),
    'api_key:literal:77daed1d',
  );

  // Defensive fallbacks — unknown shapes must not crash.
  assert.equal(describeStepAuth(null), 'unknown');
  assert.equal(describeStepAuth(42), 'unknown');
  assert.equal(describeStepAuth({ type: 'api_key' }), 'api_key:?');
  assert.equal(describeStepAuth({}), '?:?');
});

test('env fingerprint emits auth= for inherited-default steps (#2711)', () => {
  // Two storyboards sharing every env component AND both inheriting the
  // transport default (no step.auth). After this change, both still land
  // in the same group (they semantically share credentials), so any
  // outcome disagreement MUST surface as a contradiction rather than
  // getting silently masked by asymmetric fingerprint emission.
  const docs = {
    'a.yaml': yaml.load(`
id: sb_a
caller:
  role: buyer_agent
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
    'b.yaml': yaml.load(`
id: sb_b
caller:
  role: buyer_agent
prerequisites:
  test_kit: "test-kits/acme-outdoor.yaml"
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
  const contradictions = contradictionsAcrossDocs(docs);
  assert.equal(contradictions.length, 1, 'inherited-default steps must participate in the group');

  // Direct fingerprint assertion: an inheriting step emits `auth=kit_default`
  // — the fix's defining property. Without this token the auth= component
  // would be absent and two inheriting storyboards with divergent transport
  // defaults could collide silently.
  const fpInherit = fingerprintEnv({}, {}, { id: 'x', caller: { role: 'buyer_agent' } });
  assert.ok(fpInherit.includes('auth=kit_default'), `expected auth=kit_default in ${fpInherit}`);
});

test('env fingerprint discriminates named principals within a kit (#2708)', () => {
  // Forward guard: when a multi-principal kit declares
  // `auth: { type: api_key, from_test_kit: "<path>" }` to select among
  // principals, two steps selecting different principals MUST land in
  // different fingerprint buckets even though all other env components
  // (test_kit, role, fixtures, scenario) match. Today no kit exposes
  // multiple principals — this test pins the shape so the first kit that
  // does is handled without further lint changes.
  const docs = {
    'low_spend.yaml': yaml.load(`
id: sb_principals
caller:
  role: buyer_agent
prerequisites:
  test_kit: "test-kits/multi-principal.yaml"
phases:
  - id: p
    steps:
      - id: denied
        task: create_media_buy
        sample_request: { brand: { domain: x } }
        auth: { type: api_key, from_test_kit: "auth.principals.low_spend.api_key" }
        expect_error: true
        validations:
          - check: error_code
            value: GOVERNANCE_DENIED
`),
    'full_auth.yaml': yaml.load(`
id: sb_principals
caller:
  role: buyer_agent
prerequisites:
  test_kit: "test-kits/multi-principal.yaml"
phases:
  - id: p
    steps:
      - id: approved
        task: create_media_buy
        sample_request: { brand: { domain: x } }
        auth: { type: api_key, from_test_kit: "auth.principals.full_auth.api_key" }
        validations:
          - check: field_present
            path: media_buy_id
`),
  };
  assert.deepEqual(contradictionsAcrossDocs(docs), []);

  // Direct fingerprint-level assertion: pin the discrimination to the
  // `from_test_kit:<path>` token specifically, not to whatever other
  // coincidental env difference might fire. Mirrors the pattern used by
  // the `caller.role discriminates env` test upstream — deepEqual([], [])
  // can go green for unrelated classification failures.
  const lowStep = docs['low_spend.yaml'].phases[0].steps[0];
  const fullStep = docs['full_auth.yaml'].phases[0].steps[0];
  const fpLow = fingerprintEnv(lowStep, {}, docs['low_spend.yaml']);
  const fpFull = fingerprintEnv(fullStep, {}, docs['full_auth.yaml']);
  assert.notEqual(fpLow, fpFull);
  assert.ok(
    fpLow.includes('auth=api_key:from_test_kit:auth.principals.low_spend.api_key'),
    `expected low-spend path token in ${fpLow}`,
  );
  assert.ok(
    fpFull.includes('auth=api_key:from_test_kit:auth.principals.full_auth.api_key'),
    `expected full-auth path token in ${fpFull}`,
  );
});
