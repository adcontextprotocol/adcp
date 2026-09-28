#!/usr/bin/env node
/**
 * Tests for the storyboard `$generate` phase-scope lint. Concerns:
 *   1. Source-tree guard: no real storyboard reuses a `$generate` alias
 *      across phases.
 *   2. The rule fires when one alias appears in two phases, including in
 *      validation values and nested request fields.
 *   3. Same-phase reuse, distinct per-phase aliases, unaliased tokens,
 *      `$context` reads, and prose mentions stay clean.
 *   4. The premise still holds: the packaged runner scopes aliases to the
 *      context object it resolves against, which it copies per phase.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const yaml = require('js-yaml');
const { injectContext } = require('@adcp/sdk/testing');

const {
  collectAliasPhases,
  lintDoc,
  lint,
  formatViolation,
} = require('../scripts/lint-storyboard-generate-phase-scope.cjs');

function doc(text) {
  return yaml.load(text);
}

test('source tree has no $generate alias crossing a phase boundary', () => {
  const violations = lint();
  assert.deepEqual(
    violations,
    [],
    'storyboards reuse $generate aliases across phases:\n' + violations.map(formatViolation).join('\n\n'),
  );
});

test('flags an alias created in one phase and reused in a later phase', () => {
  const storyboard = doc(`
id: fixture
phases:
  - id: authorize
    steps:
      - id: check
        task: check_governance
        sample_request:
          payload:
            idempotency_key: "$generate:uuid_v4#buy_key"
  - id: execute
    steps:
      - id: create
        task: create_media_buy
        sample_request:
          idempotency_key: "$generate:uuid_v4#buy_key"
        validations:
          - check: field_value
            path: "idempotency_key"
            value: "$generate:uuid_v4#buy_key"
`);
  const violations = lintDoc(storyboard, 'fixture.yaml');
  assert.equal(violations.length, 1);
  assert.equal(violations[0].rule, 'generate_alias_crosses_phases');
  assert.equal(violations[0].alias, 'buy_key');
  assert.equal(violations[0].storyboardId, 'fixture');
  assert.deepEqual(violations[0].phases, [
    { phaseId: 'authorize', locations: ['check.sample_request.payload.idempotency_key'] },
    {
      phaseId: 'execute',
      locations: ['create.sample_request.idempotency_key', 'create.validations[0].value'],
    },
  ]);
  assert.match(formatViolation(violations[0]), /context_outputs generator/);
});

test('flags opaque_id aliases and unknown kinds too', () => {
  const storyboard = doc(`
phases:
  - id: a
    steps:
      - { id: s1, task: t, sample_request: { id: "$generate:opaque_id#thing", other: "$generate:future_kind#x" } }
  - id: b
    steps:
      - { id: s2, task: t, sample_request: { id: "$generate:opaque_id#thing", other: "$generate:future_kind#x" } }
`);
  assert.deepEqual(
    lintDoc(storyboard, 'fixture.yaml').map(v => v.alias).sort(),
    ['thing', 'x'],
  );
});

test('accepts same-phase reuse, per-phase aliases, unaliased tokens, context reads, and prose', () => {
  const storyboard = doc(`
narrative: |
  Mentions "$generate:uuid_v4#shared" in prose only.
phases:
  - id: replay
    narrative: "$generate:uuid_v4#shared"
    steps:
      - id: first
        task: create_media_buy
        sample_request:
          idempotency_key: "$generate:uuid_v4#shared"
          nonce: "$generate:uuid_v4"
        context_outputs:
          - name: carried
            generate: uuid_v4
      - id: replay
        task: create_media_buy
        sample_request:
          idempotency_key: "$generate:uuid_v4#shared"
  - id: fresh
    steps:
      - id: fresh_key
        task: create_media_buy
        expected: 'Uses "$generate:uuid_v4#shared" semantics'
        sample_request:
          idempotency_key: "$generate:uuid_v4#fresh"
          nonce: "$generate:uuid_v4"
          carried: "$context.carried"
`);
  assert.deepEqual(lintDoc(storyboard, 'fixture.yaml'), []);
  const phases = collectAliasPhases(storyboard);
  assert.deepEqual([...phases.get('shared').keys()], ['replay']);
  assert.deepEqual([...phases.get('fresh').keys()], ['fresh']);
});

test('ignores documents without phases', () => {
  assert.deepEqual(lintDoc(doc('id: kit\nauth: { token: "$generate:uuid_v4#k" }'), 'kit.yaml'), []);
  assert.deepEqual(lintDoc(null, 'empty.yaml'), []);
});

test('runner premise: an alias is stable within one context object but not across a per-phase copy', () => {
  const request = { idempotency_key: '$generate:uuid_v4#buy_key' };
  const phaseOne = {};
  const first = injectContext(request, phaseOne).idempotency_key;
  assert.equal(injectContext(request, phaseOne).idempotency_key, first);
  // The runner starts each phase with `context = { ...context }` and does not
  // carry the alias cache over, so the same token mints a new value.
  const phaseTwo = { ...phaseOne };
  assert.notEqual(injectContext(request, phaseTwo).idempotency_key, first);
  // Context values do survive the copy, which is why cross-phase IDs belong
  // in context_outputs.
  phaseOne.buy_key_ctx = first;
  assert.equal(injectContext({ k: '$context.buy_key_ctx' }, { ...phaseOne }).k, first);
});
