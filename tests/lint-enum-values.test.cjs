'use strict';

// #8901: enum values usable as identifiers. Each fixture case starts from a
// tree with no findings and adds one value, so each fails for one reason.

const test = require('node:test');
const assert = require('node:assert/strict');
const { findingsOf, runLint, runOnFixture } = require('./helpers/schema-convention-lint-cli.cjs');

const SCRIPT = 'lint-enum-values.cjs';
const clean = (values) => ({ 'enums/kind.json': { $id: '/schemas/enums/kind.json', type: 'string', enum: values } });

test('the repo schemas have no finding outside the baseline and no stale entry', () => {
  const { status, output } = runLint(SCRIPT);
  assert.equal(status, 0, output);
});

test('a clean vocabulary has no findings', () => {
  const { status, output } = runOnFixture(SCRIPT, clean(['active', 'paused']));
  assert.equal(status, 0, output);
  assert.deepEqual(findingsOf(output), []);
});

test('values equal once case and separators are folded collide', () => {
  const { status, output } = runOnFixture(SCRIPT, clean(['media-buy', 'media_buy']));
  assert.equal(status, 1);
  assert.deepEqual(findingsOf(output), ['fold-collision enums/kind.json#/enum (media-buy|media_buy)']);
});

test('const discriminators across the branches of one oneOf collide', () => {
  const files = {
    'core/thing.json': {
      $id: '/schemas/core/thing.json',
      oneOf: [
        { type: 'object', properties: { kind: { const: 'clickTag' } } },
        { type: 'object', properties: { kind: { const: 'clickTAG' } } },
      ],
    },
  };
  assert.deepEqual(findingsOf(runOnFixture(SCRIPT, files).output), [
    'fold-collision core/thing.json#/oneOf/*/properties/kind/const (clickTAG|clickTag)',
  ]);
});

test('a reserved word matches exactly, case included', () => {
  assert.deepEqual(findingsOf(runOnFixture(SCRIPT, clean(['pass', 'fail'])).output), ['reserved-word enums/kind.json#/enum (pass)']);
  assert.deepEqual(findingsOf(runOnFixture(SCRIPT, clean(['none', 'some'])).output), []);
});

test('an enum-protocol name is a finding', () => {
  assert.deepEqual(findingsOf(runOnFixture(SCRIPT, clean(['ordinal', 'nominal'])).output), [
    'enum-protocol-name enums/kind.json#/enum (ordinal)',
  ]);
});

test('deprecated values and deprecated schemas are skipped', () => {
  const files = {
    'enums/kind.json': { $id: '/schemas/enums/kind.json', enum: ['pass', 'passed'], 'x-deprecated-enum-values': ['pass'] },
    'enums/old.json': { $id: '/schemas/enums/old.json', deprecated: true, enum: ['global'] },
  };
  assert.deepEqual(findingsOf(runOnFixture(SCRIPT, files).output), []);
});

test('values in examples, defaults and propertyNames are not value sites', () => {
  const files = {
    'core/thing.json': {
      $id: '/schemas/core/thing.json',
      type: 'object',
      propertyNames: { enum: ['class'] },
      properties: { kind: { type: 'string', default: 'class', examples: ['pass'] } },
    },
  };
  assert.deepEqual(findingsOf(runOnFixture(SCRIPT, files).output), []);
});

test('a recorded finding passes and a stale baseline entry fails', () => {
  const recorded = runOnFixture(SCRIPT, clean(['pass', 'fail']), [{ rule: 'reserved-word', site: 'enums/kind.json#/enum (pass)' }]);
  assert.equal(recorded.status, 0, recorded.output);
  const stale = runOnFixture(SCRIPT, clean(['passed', 'fail']), [{ rule: 'reserved-word', site: 'enums/kind.json#/enum (pass)' }]);
  assert.equal(stale.status, 1);
  assert.match(stale.output, /stale baseline entry, remove it: \[reserved-word\] enums\/kind\.json#\/enum \(pass\)/);
});
