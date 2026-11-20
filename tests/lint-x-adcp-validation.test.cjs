'use strict';

// #8472: x-adcp-validation keys come from the documented vocabulary. Each
// fixture case starts from a valid annotation and changes one key, so each
// fails for one reason.

const test = require('node:test');
const assert = require('node:assert/strict');
const { findingsOf, runLint, runOnFixture } = require('./helpers/schema-convention-lint-cli.cjs');

const SCRIPT = 'lint-x-adcp-validation.cjs';
const SITE = 'core/thing.json#/properties/items/x-adcp-validation';
const VALID = {
  spec: 'docs/reference/thing.mdx#items',
  unique_items: [{ key: ['agent_url', 'list_id'] }],
  required_when: { any_of: [{ field: 'mode', equals: 'list' }] },
  verifier_constraints: { anything_goes: 'free-form one-off rule' },
  'example.com:max_per_buyer': 3,
};
const run = (annotation) => runOnFixture(SCRIPT, {
  'core/thing.json': {
    $id: '/schemas/core/thing.json',
    type: 'object',
    properties: { items: { type: 'array', 'x-adcp-validation': annotation } },
  },
});

test('the repo schemas have no finding outside the baseline and no stale entry', () => {
  const { status, output } = runLint(SCRIPT);
  assert.equal(status, 0, output);
});

test('core sub-keys, an extension term and free-form verifier_constraints pass', () => {
  const { status, output } = run(VALID);
  assert.equal(status, 0, output);
  assert.deepEqual(findingsOf(output), []);
});

test('a key that is neither core nor an extension term', () => {
  const { status, output } = run({ ...VALID, unique_by: ['agent_url'] });
  assert.equal(status, 1);
  assert.deepEqual(findingsOf(output), [`unknown-key ${SITE} (unique_by)`]);
});

test('an extension term needs a domain with two labels', () => {
  assert.deepEqual(findingsOf(run({ ...VALID, 'acme:max_per_buyer': 3 }).output), [`unknown-key ${SITE} (acme:max_per_buyer)`]);
});

test('a core sub-key with the wrong shape', () => {
  assert.deepEqual(findingsOf(run({ ...VALID, unique_items: [{ key: 'agent_url' }] }).output), [`invalid-core-key ${SITE} (unique_items)`]);
  assert.deepEqual(findingsOf(run({ ...VALID, required_when: [{ field: 'mode', non_empty: true }] }).output), [
    `invalid-core-key ${SITE} (required_when)`,
  ]);
});

test('rules without a spec pointer', () => {
  const { spec, ...withoutSpec } = VALID;
  assert.ok(spec);
  assert.deepEqual(findingsOf(run(withoutSpec).output), [`missing-spec ${SITE}`]);
});
