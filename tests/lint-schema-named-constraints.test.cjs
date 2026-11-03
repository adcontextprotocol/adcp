#!/usr/bin/env node
/**
 * Single-fault tests for scripts/lint-schema-named-constraints.cjs. Each failing
 * case breaks exactly one rule and asserts that it produces exactly one error.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  checkTree,
  compareToBase,
  loadDocuments,
} = require('../scripts/lint-schema-named-constraints.cjs');
const { parseWithPositions, rewriteSite } = require('../scripts/normalize-named-schemas.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const PATTERN = '^[A-Z]{3}$';

const named = {
  file: 'core/currency-code.json',
  schema: { $id: '/schemas/core/currency-code.json', title: 'Currency Code', type: 'string', pattern: PATTERN },
};
const objectWith = (properties) => ({ type: 'object', properties });
const inlineCurrency = { type: 'string', pattern: PATTERN, description: 'A local description.' };
const emptyList = (extra = {}) => ({ min_repeat_sites: 3, held_apart: [], unnamed_repeats: [], ...extra });
const errorsFor = (documents, list = emptyList()) => checkTree(documents, list).errors;

function assertOneError(errors, pattern) {
  assert.equal(errors.length, 1, errors.join('\n'));
  assert.match(errors[0], pattern);
}

test('the source tree passes against the checked-in list', () => {
  const documents = loadDocuments(path.join(REPO_ROOT, 'static', 'schemas', 'source'));
  const list = require('../scripts/schema-named-constraints.json');
  assert.deepEqual(checkTree(documents, list).errors, []);
});

test('a $ref to the named schema passes', () => {
  const documents = [named, { file: 'a.json', schema: objectWith({ price: { $ref: '/schemas/core/currency-code.json' } }) }];
  assert.deepEqual(errorsFor(documents), []);
});

test('an inline copy fails with the file, the pointer, and the exact $ref', () => {
  const documents = [named, { file: 'a.json', schema: objectWith({ price: inlineCurrency }) }];
  const errors = errorsFor(documents);
  assertOneError(errors, /a\.json#\/properties\/price/);
  assert.match(errors[0], /"\$ref": "\/schemas\/core\/currency-code\.json"/);
});

test('an inline enum copy fails whatever the value order', () => {
  const documents = [
    { file: 'enums/mode.json', schema: { title: 'Mode', type: 'string', enum: ['on', 'off'] } },
    { file: 'a.json', schema: objectWith({ state: { type: 'string', enum: ['off', 'on'] } }) },
  ];
  assertOneError(errorsFor(documents), /"\$ref": "\/schemas\/enums\/mode\.json"/);
});

test('an inline numeric range copy fails', () => {
  const documents = [
    { file: 'core/latitude.json', schema: { title: 'Latitude', type: 'number', minimum: -90, maximum: 90 } },
    { file: 'a.json', schema: objectWith({ lat: { type: 'number', minimum: -90, maximum: 90 } }) },
  ];
  assertOneError(errorsFor(documents), /core\/latitude\.json/);
});

test('a weak constraint alone is not a copy', () => {
  const documents = [
    { file: 'core/thing-id.json', schema: { title: 'Thing ID', type: 'string', minLength: 1 } },
    { file: 'a.json', schema: objectWith({ note: { type: 'string', minLength: 1 } }) },
  ];
  assert.deepEqual(errorsFor(documents), []);
});

test('a weak constraint on a property that already references the schema is a copy', () => {
  const documents = [
    { file: 'core/thing-id.json', schema: { title: 'Thing ID', type: 'string', minLength: 1 } },
    { file: 'a.json', schema: objectWith({ thing_id: { $ref: '/schemas/core/thing-id.json' } }) },
    { file: 'b.json', schema: objectWith({ thing_id: { type: 'string', minLength: 1 } }) },
  ];
  assertOneError(errorsFor(documents), /b\.json#\/properties\/thing_id/);
});

test('a weak constraint with the schema\'s x-entity is a copy', () => {
  const documents = [
    { file: 'core/thing-id.json', schema: { title: 'Thing ID', type: 'string', minLength: 1, 'x-entity': 'thing' } },
    { file: 'a.json', schema: objectWith({ other: { type: 'string', minLength: 1, 'x-entity': 'thing' } }) },
  ];
  assertOneError(errorsFor(documents), /a\.json#\/properties\/other/);
});

test('a different x-entity is a different concept', () => {
  const documents = [
    { file: 'core/thing-id.json', schema: { title: 'Thing ID', type: 'string', pattern: '^t', 'x-entity': 'thing' } },
    { file: 'a.json', schema: objectWith({ other: { type: 'string', pattern: '^t', 'x-entity': 'other' } }) },
  ];
  assert.deepEqual(errorsFor(documents), []);
});

test('sites inside if and not are conditions, not declarations', () => {
  const documents = [named, {
    file: 'a.json',
    schema: { type: 'object', if: objectWith({ price: inlineCurrency }), not: objectWith({ price: inlineCurrency }) },
  }];
  assert.deepEqual(errorsFor(documents), []);
});

test('a held-apart site with a reason passes', () => {
  const documents = [named, { file: 'a.json', schema: objectWith({ airport: inlineCurrency }) }];
  const list = emptyList({ held_apart: [{ path: 'a.json#/properties/airport', reason: 'An IATA airport code.' }] });
  assert.deepEqual(errorsFor(documents, list), []);
});

test('a held-apart entry without a reason fails', () => {
  const documents = [named, { file: 'a.json', schema: objectWith({ airport: inlineCurrency }) }];
  const list = emptyList({ held_apart: [{ path: 'a.json#/properties/airport', reason: ' ' }] });
  assertOneError(errorsFor(documents, list), /has no reason/);
});

test('a held-apart entry that no longer occurs fails', () => {
  const list = emptyList({ held_apart: [{ path: 'a.json#/properties/gone', reason: 'Was an airport code.' }] });
  assertOneError(errorsFor([named], list), /stale held_apart/);
});

const threeSites = (documents = ['a.json', 'b.json', 'c.json']) => documents.map((file) => ({
  file,
  schema: objectWith({ code: { type: 'string', pattern: '^x-' } }),
}));
const repeatEntry = (extra = {}) => ({ constraint: { type: 'string', pattern: '^x-' }, sites: 3, reason: 'Not one concept.', ...extra });

test('a constraint repeated at the threshold fails and lists its sites', () => {
  const errors = errorsFor(threeSites());
  assertOneError(errors, /Repeated unnamed constraint/);
  for (const file of ['a.json', 'b.json', 'c.json']) assert.ok(errors[0].includes(`${file}#/properties/code`));
});

test('a constraint below the threshold passes', () => {
  assert.deepEqual(errorsFor(threeSites(['a.json', 'b.json'])), []);
});

test('repetition inside one document does not count', () => {
  const schema = objectWith({ a: { type: 'string', pattern: '^x-' }, b: { type: 'string', pattern: '^x-' }, c: { type: 'string', pattern: '^x-' } });
  assert.deepEqual(errorsFor([{ file: 'a.json', schema }]), []);
});

test('a free-text length bound repeats only on one property name', () => {
  const documents = ['a', 'b', 'c'].map((name) => ({ file: `${name}.json`, schema: objectWith({ [name]: { type: 'string', maxLength: 500 } }) }));
  assert.deepEqual(errorsFor(documents), []);
});

test('a repeat recorded with a reason and its count passes', () => {
  assert.deepEqual(errorsFor(threeSites(), emptyList({ unnamed_repeats: [repeatEntry()] })), []);
});

test('a recorded repeat without a reason fails', () => {
  assertOneError(errorsFor(threeSites(), emptyList({ unnamed_repeats: [repeatEntry({ reason: '' })] })), /has no reason/);
});

test('a site added to a recorded repeat fails until the count moves', () => {
  const documents = threeSites(['a.json', 'b.json', 'c.json', 'd.json']);
  assertOneError(errorsFor(documents, emptyList({ unnamed_repeats: [repeatEntry()] })), /grew from 3 to 4/);
});

test('a recorded repeat with fewer sites fails until the count moves', () => {
  const documents = threeSites(['a.json', 'b.json']);
  assertOneError(errorsFor(documents, emptyList({ unnamed_repeats: [repeatEntry()] })), /now has 2 sites, not 3/);
});

test('a recorded repeat that no longer occurs fails', () => {
  assertOneError(errorsFor([named], emptyList({ unnamed_repeats: [repeatEntry()] })), /no longer occurs/);
});

test('a grown baseline fails against the base copy', () => {
  const base = emptyList({ unnamed_repeats: [repeatEntry()] });
  const head = emptyList({ unnamed_repeats: [repeatEntry({ sites: 4 })] });
  assertOneError(compareToBase(base, head).errors, /may only shrink/);
});

test('a grown baseline with a growth_reason passes and is shown to the reviewer', () => {
  const base = emptyList({ unnamed_repeats: [repeatEntry()] });
  const head = emptyList({ unnamed_repeats: [repeatEntry({ sites: 4, growth_reason: 'A new branch of the same field.' })] });
  const { errors, additions } = compareToBase(base, head);
  assert.deepEqual(errors, []);
  assert.equal(additions.length, 1);
  assert.match(additions[0], /A new branch of the same field/);
});

test('a raised threshold fails against the base copy', () => {
  assertOneError(compareToBase(emptyList(), emptyList({ min_repeat_sites: 4 })).errors, /may only fall/);
});

test('a new held-apart entry is shown to the reviewer with its reason', () => {
  const head = emptyList({ held_apart: [{ path: 'a.json#/properties/x', reason: 'Means something else.' }] });
  const { errors, additions } = compareToBase(emptyList(), head);
  assert.deepEqual(errors, []);
  assert.match(additions[0], /a\.json#\/properties\/x: Means something else/);
});

test('a shrunken list passes against the base copy', () => {
  const base = emptyList({
    held_apart: [{ path: 'a.json#/properties/x', reason: 'Means something else.' }],
    unnamed_repeats: [repeatEntry({ sites: 5 })],
  });
  const head = emptyList({ unnamed_repeats: [repeatEntry({ sites: 4 })] });
  assert.deepEqual(compareToBase(base, head), { errors: [], additions: [] });
});

test('the normalizer edits a site in place and keeps its formatting', () => {
  const rewrite = (text) => {
    const tree = parseWithPositions(text);
    return rewriteSite(text, tree, ['type', 'pattern'], '/schemas/core/currency-code.json');
  };
  assert.equal(
    rewrite('{ "type": "string", "pattern": "^x", "description": "Kept." }'),
    '{ "$ref": "/schemas/core/currency-code.json", "description": "Kept." }',
  );
  assert.equal(
    rewrite('{\n  "description": "Kept.",\n  "type": "string",\n  "pattern": "^x",\n  "x-a": 1\n}'),
    '{\n  "description": "Kept.",\n  "$ref": "/schemas/core/currency-code.json",\n  "x-a": 1\n}',
  );
});
