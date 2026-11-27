'use strict';

// #9002: how a value list is written. Each fixture case adds one list to an
// empty tree, so each fails for one reason.

const test = require('node:test');
const assert = require('node:assert/strict');
const { findingsOf, runLint, runOnFixture } = require('./helpers/schema-convention-lint-cli.cjs');

const SCRIPT = 'lint-value-lists.cjs';
const one = (schema) => ({ 'core/thing.json': { $id: '/schemas/core/thing.json', ...schema } });
const run = (schema) => runOnFixture(SCRIPT, one(schema));

test('the repo schemas have no finding outside the baseline and no stale entry', () => {
  const { status, output } = runLint(SCRIPT);
  assert.equal(status, 0, output);
});

test('a closed value list is reported, not blocking', () => {
  const { status, output } = run({ type: 'string', enum: ['a', 'b'] });
  assert.equal(status, 0, output);
  assert.deepEqual(findingsOf(output), []);
  assert.match(output, /1 closed value lists/);
});

test('a one-value enum is a finding; const is not', () => {
  assert.deepEqual(findingsOf(run({ type: 'string', enum: ['only'] }).output), ['one-value-enum core/thing.json#/enum']);
  assert.deepEqual(findingsOf(run({ type: 'string', const: 'only' }).output), []);
});

test('a pattern branch beside an enum is an extension branch', () => {
  const schema = { anyOf: [{ type: 'string', enum: ['a', 'b'] }, { type: 'string', pattern: '^custom:[a-z]+$' }] };
  const { status, output } = run(schema);
  assert.equal(status, 1);
  assert.deepEqual(findingsOf(output), ['extension-branch core/thing.json#/anyOf']);
});

test('a $ref to another value list beside an enum is not an extension branch', () => {
  const files = {
    ...one({ anyOf: [{ type: 'string', enum: ['a', 'b'] }, { $ref: '/schemas/core/more.json' }] }),
    'core/more.json': { $id: '/schemas/core/more.json', type: 'string', enum: ['c', 'd'] },
  };
  assert.deepEqual(findingsOf(runOnFixture(SCRIPT, files).output), []);
});

test('an enum that selects a union branch is a discriminator', () => {
  const branch = (values) => ({ type: 'object', required: ['kind'], properties: { kind: { type: 'string', enum: values } } });
  const { output } = run({ oneOf: [branch(['a', 'b']), branch(['c', 'd'])] });
  assert.deepEqual(findingsOf(output), []);
  assert.match(output, /2 discriminator enums; reported, not blocking: 0 closed value lists/);
});

test('an enum under not or if narrows a value and is skipped', () => {
  const { output } = run({ type: 'string', not: { enum: ['x'] }, if: { enum: ['y'] }, then: { minLength: 1 } });
  assert.deepEqual(findingsOf(output), []);
});
