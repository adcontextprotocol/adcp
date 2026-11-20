'use strict';

// #8902: one naming convention for properties. Each fixture case adds one
// property to a tree with no findings, so each fails for one reason.

const test = require('node:test');
const assert = require('node:assert/strict');
const { findingsOf, runLint, runOnFixture } = require('./helpers/schema-convention-lint-cli.cjs');

const SCRIPT = 'lint-property-names.cjs';
const withProperties = (properties, file = 'core/thing.json') => ({
  [file]: { $id: `/schemas/${file}`, type: 'object', properties },
});
const run = (properties) => findingsOf(runOnFixture(SCRIPT, withProperties(properties)).output);
const dateTime = { type: 'string', format: 'date-time' };

test('the repo schemas have no finding outside the baseline and no stale entry', () => {
  const { status, output } = runLint(SCRIPT);
  assert.equal(status, 0, output);
});

test('names that follow the convention have no findings', () => {
  const { status, output } = runOnFixture(SCRIPT, withProperties({
    created_at: dateTime,
    start_date: { type: 'string', format: 'date' },
    valid_from: dateTime,
    timeout_ms: { type: 'integer' },
    item_count: { type: 'integer' },
    tags: { type: 'array', items: { type: 'string' } },
  }));
  assert.equal(status, 0, output);
  assert.deepEqual(findingsOf(output), []);
});

test('a name that is not lower_snake_case', () => {
  assert.deepEqual(run({ schemaPath: { type: 'string' } }), ['casing core/thing.json#/properties/schemaPath']);
});

test('a suffix that promises another type', () => {
  assert.deepEqual(run({ expires_at: { type: 'integer' } }), ['suffix-type core/thing.json#/properties/expires_at']);
});

test('a date-time whose name does not say so', () => {
  assert.deepEqual(run({ cutoff: dateTime }), ['type-suffix core/thing.json#/properties/cutoff']);
});

test('a registry variant of a canonical name', () => {
  assert.deepEqual(run({ last_modified: { type: 'string' } }), ['synonym core/thing.json#/properties/last_modified']);
});

test('a plural name holding one string, and a singular name holding an array', () => {
  assert.deepEqual(run({ countries: { type: 'string' } }), ['plural-scalar core/thing.json#/properties/countries']);
  assert.deepEqual(run({ country: { type: 'array', items: { type: 'string' } } }), [
    'singular-array core/thing.json#/properties/country',
  ]);
});

test('one name with two JSON types across the tree', () => {
  const files = {
    ...withProperties({ travel_time: { type: 'boolean' } }, 'core/a.json'),
    ...withProperties({ travel_time: { type: 'object', properties: { value: { type: 'number' } } } }, 'core/b.json'),
  };
  const findings = findingsOf(runOnFixture(SCRIPT, files).output).filter((finding) => finding.startsWith('one-type'));
  assert.deepEqual(findings, ['one-type name:travel_time (boolean,object)']);
});

test('the registry exempts the A2UI mirror schemas', () => {
  assert.deepEqual(findingsOf(runOnFixture(SCRIPT, withProperties({ dataBinding: { type: 'string' } }, 'a2ui/component.json')).output), []);
});

test('property-like objects in examples, defaults, const and enum are not declarations', () => {
  const object = { notSnake: 1, last_modified: 'x' };
  assert.deepEqual(run({ payload: { type: 'object', examples: [object], default: object, const: object, enum: [object] } }), []);
});

// A $ref reaches another schema only on the schema origin itself, so a host
// that merely starts with it does not resolve into the tree.
const objectSchema = { type: 'object', properties: { value: { type: 'number' } } };
const travelTimeTypes = (ref) => findingsOf(runOnFixture(SCRIPT, {
  ...withProperties({ travel_time: { $ref: ref } }, 'core/a.json'),
  ...withProperties({ travel_time: objectSchema }, 'core/b.json'),
  'core/c.json': { $id: '/schemas/core/c.json', type: 'boolean' },
  'core/.evil.example/core/c.json': { $id: '/schemas/core/c.json', type: 'boolean' },
}).output).filter((finding) => finding.startsWith('one-type'));

test('an absolute $ref on the schema origin resolves', () => {
  assert.deepEqual(travelTimeTypes('https://adcontextprotocol.org/schemas/core/c.json'), [
    'one-type name:travel_time (boolean,object)',
  ]);
});

test('an absolute $ref on a host that only starts with the schema origin does not resolve', () => {
  assert.deepEqual(travelTimeTypes('https://adcontextprotocol.org.evil.example/core/c.json'), []);
});
