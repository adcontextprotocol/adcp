'use strict';

// #8903: one rule for a schema's path, name and $id. Each fixture case starts
// from a tree with no findings and makes one change, so each fails for one
// reason.

const test = require('node:test');
const assert = require('node:assert/strict');
const { findingsOf, runLint, runOnFixture } = require('./helpers/schema-convention-lint-cli.cjs');

const SCRIPT = 'lint-schema-paths.cjs';
const CLEAN = {
  'a/new-thing.json': { $id: '/schemas/a/new-thing.json', title: 'New Thing', type: 'object' },
};
const run = (extra = {}) => findingsOf(runOnFixture(SCRIPT, { ...CLEAN, ...extra }).output);

// An alias left at the old path of a file that moved to a/new-thing.json. The
// old name is snake_case, so without the alias form it is a path-not-kebab
// finding.
const ALIAS = {
  $id: '/schemas/a/old_thing.json',
  allOf: [{ $ref: '/schemas/a/new-thing.json' }],
  deprecated: true,
  'x-deprecated-in': '4.1.0',
  'x-removed-in': '5.0.0',
};

test('the repo schemas have no finding outside the baseline and no stale entry', () => {
  const { status, output } = runLint(SCRIPT);
  assert.equal(status, 0, output);
});

test('the clean fixture has no findings', () => {
  const { status, output } = runOnFixture(SCRIPT, CLEAN);
  assert.equal(status, 0, output);
  assert.deepEqual(findingsOf(output), []);
});

test('a root $id that is not /schemas/<path>', () => {
  assert.deepEqual(run({ 'a/other-thing.json': { $id: '/schemas/b/other-thing.json', title: 'Other Thing' } }), [
    'id-not-path a/other-thing.json#/$id',
  ]);
});

test('a title that does not say the file name', () => {
  assert.deepEqual(run({ 'a/other-thing.json': { $id: '/schemas/a/other-thing.json', title: 'Something Else' } }), [
    'title-not-name a/other-thing.json#/title',
  ]);
});

test('a $ref into another file and a definitions block', () => {
  assert.deepEqual(run({
    'a/user.json': {
      $id: '/schemas/a/user.json',
      title: 'User',
      definitions: { part: { type: 'string' } },
      properties: { thing: { $ref: '/schemas/a/new-thing.json#/properties/x' } },
    },
  }), [
    'definitions-keyword a/user.json#/definitions',
    'ref-into-other-file a/user.json#/properties/thing/$ref',
  ]);
});

test("an alias at a moved file's old path passes", () => {
  assert.deepEqual(run({ 'a/old_thing.json': ALIAS }), []);
});

test('the same file without deprecated: true is not an alias and is checked', () => {
  const { deprecated, ...notAlias } = ALIAS;
  assert.equal(deprecated, true);
  assert.deepEqual(run({ 'a/old_thing.json': notAlias }), ['path-not-kebab a/old_thing.json#']);
});
