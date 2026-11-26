#!/usr/bin/env node
/**
 * Single-fault tests for scripts/lint-schema-named-constraints.cjs. Each failing
 * case breaks exactly one rule and asserts that it produces exactly one error.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  checkTree,
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
const errorsFor = (documents) => checkTree(documents).errors;

function assertOneError(errors, pattern) {
  assert.equal(errors.length, 1, errors.join('\n'));
  assert.match(errors[0], pattern);
}

test('the source tree passes', () => {
  const documents = loadDocuments(path.join(REPO_ROOT, 'static', 'schemas', 'source'));
  assert.deepEqual(checkTree(documents).errors, []);
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

const sitesIn = (files, schema = { type: 'string', pattern: '^x-' }) => files.map((file) => ({
  file,
  schema: objectWith({ code: { ...schema } }),
}));
const pairInOneDocument = () => [{
  file: 'a.json',
  schema: objectWith({ first: { type: 'string', pattern: '^x-' }, second: { type: 'string', pattern: '^x-' } }),
}];

test('a constraint repeated across two documents fails and lists its sites', () => {
  const errors = errorsFor(sitesIn(['a.json', 'b.json']));
  assertOneError(errors, /Repeated unnamed constraint/);
  for (const file of ['a.json', 'b.json']) assert.ok(errors[0].includes(`${file}#/properties/code`));
  assert.match(errors[0], /titled document under core\/ or enums\//);
});

test('a constraint repeated inside one document fails and asks for a definition', () => {
  const errors = errorsFor(pairInOneDocument());
  assertOneError(errors, /Repeated unnamed constraint/);
  assert.match(errors[0], /a definitions entry in a\.json/);
});

test('a constraint at one site passes', () => {
  assert.deepEqual(errorsFor(sitesIn(['a.json'])), []);
});

test('a free-text length bound repeats only on one property name', () => {
  const documents = ['a', 'b'].map((name) => ({ file: `${name}.json`, schema: objectWith({ [name]: { type: 'string', maxLength: 500 } }) }));
  assert.deepEqual(errorsFor(documents), []);
});

test('an inline copy of a local definition fails with the local $ref', () => {
  const documents = [{
    file: 'a.json',
    schema: {
      type: 'object',
      definitions: { code: { title: 'Code', type: 'string', pattern: '^x-' } },
      properties: { first: { type: 'string', pattern: '^x-' } },
    },
  }];
  assertOneError(errorsFor(documents), /"\$ref": "#\/definitions\/code"/);
});

test('a local definition is not a target for another document', () => {
  const documents = [
    { file: 'a.json', schema: { type: 'object', definitions: { code: { title: 'Code', type: 'string', pattern: '^x-' } } } },
    { file: 'b.json', schema: objectWith({ code: { type: 'string', pattern: '^x-' } }) },
  ];
  const errors = errorsFor(documents);
  assertOneError(errors, /Repeated unnamed constraint/);
  assert.ok(!errors[0].includes('#/definitions/code"'), 'b.json cannot reference a.json\'s definition');
});

test('an untyped enum copy fails, because its values imply the type', () => {
  const documents = [
    { file: 'enums/mode.json', schema: { title: 'Mode', type: 'string', enum: ['on', 'off'] } },
    { file: 'a.json', schema: { type: 'object', if: {}, then: objectWith({ state: { enum: ['off', 'on'] } }) } },
  ];
  assertOneError(errorsFor(documents), /a\.json#\/then\/properties\/state/);
});

test('an untyped pattern under propertyNames copies a string schema', () => {
  const documents = [named, { file: 'a.json', schema: { type: 'object', propertyNames: { pattern: PATTERN } } }];
  assertOneError(errorsFor(documents), /a\.json#\/propertyNames/);
});

test('an equivalent pattern spelling is a copy', () => {
  const documents = [
    { file: 'core/hex.json', schema: { title: 'Hex', type: 'string', pattern: '^#[0-9A-Fa-f]{6}$' } },
    { file: 'a.json', schema: objectWith({ color: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' } }) },
  ];
  assertOneError(errorsFor(documents), /"\$ref": "\/schemas\/core\/hex\.json"/);
});

test('an untyped pattern elsewhere is not a string schema', () => {
  // Without a type, a pattern accepts non-strings, so it is not the named string schema.
  const documents = [named, { file: 'a.json', schema: { type: 'object', then: objectWith({ code: { pattern: PATTERN } }) } }];
  assert.deepEqual(errorsFor(documents), []);
});

const composedBase = {
  file: 'core/base.json',
  schema: {
    $id: '/schemas/core/base.json',
    type: 'object',
    properties: { code: { $ref: '#/definitions/code' } },
    definitions: { code: { title: 'Code', type: 'string', pattern: '^x-' } },
  },
};
const composedBy = (schema) => [composedBase, { file: 'a.json', schema }];
const baseRef = { $ref: '/schemas/core/base.json' };

test('a composed document that uses a local definition fails beside required', () => {
  const errors = errorsFor(composedBy({ allOf: [baseRef], required: ['code'] }));
  assertOneError(errors, /a\.json#\/allOf\/0: references core\/base\.json in allOf/);
  assert.match(errors[0], /#\/definitions\/code/);
});

test('a composed document that uses a local definition fails beside properties', () => {
  const errors = errorsFor(composedBy({ allOf: [baseRef], properties: { other: { type: 'string' } } }));
  assertOneError(errors, /a\.json#\/allOf\/0: references core\/base\.json in allOf/);
});

test('a composed document passes when the site states the property that uses the definition', () => {
  const documents = composedBy({ allOf: [baseRef], properties: { code: { type: 'string' } } });
  assert.deepEqual(errorsFor(documents), []);
});

test('a document alone in allOf keeps its local definitions', () => {
  assert.deepEqual(errorsFor(composedBy({ allOf: [baseRef] })), []);
});

test('a plain reference to a document with local definitions passes', () => {
  assert.deepEqual(errorsFor(composedBy(objectWith({ params: baseRef }))), []);
});

test('a composed document whose local definition is used only outside its properties passes', () => {
  const base = {
    file: 'core/base.json',
    schema: {
      $id: '/schemas/core/base.json',
      type: 'object',
      properties: { name: { type: 'string' } },
      oneOf: [{ properties: { code: { $ref: '#/definitions/code' } } }],
      definitions: { code: { title: 'Code', type: 'string', pattern: '^x-' } },
    },
  };
  assert.deepEqual(errorsFor([base, { file: 'a.json', schema: { allOf: [baseRef], required: ['name'] } }]), []);
});

test('a branch reference on a property the parent declares fails when the target uses a local definition', () => {
  const documents = composedBy({
    type: 'object',
    properties: { params: { type: 'object' } },
    anyOf: [{ oneOf: [{ properties: { params: baseRef } }] }],
  });
  const errors = errorsFor(documents);
  assertOneError(errors, /a\.json#\/anyOf\/0\/oneOf\/0\/properties\/params: references core\/base\.json on a property/);
});

test('a branch reference on a property only that branch declares passes', () => {
  const documents = composedBy({ type: 'object', oneOf: [{ properties: { params: baseRef } }] });
  assert.deepEqual(errorsFor(documents), []);
});

test('a reference with schema keywords beside it fails when the target uses a local definition', () => {
  const errors = errorsFor(composedBy(objectWith({ params: { ...baseRef, type: 'object' } })));
  assertOneError(errors, /a\.json#\/properties\/params: references core\/base\.json with schema keywords/);
});

test('a fragment reference fails when the subschema it names uses a local definition', () => {
  const base = {
    file: 'core/base.json',
    schema: { definitions: { wrapper: objectWith({ code: { $ref: '#/definitions/code' } }), code: composedBase.schema.definitions.code } },
  };
  const errors = errorsFor([base, { file: 'a.json', schema: { allOf: [{ $ref: '/schemas/core/base.json#/definitions/wrapper' }], required: ['code'] } }]);
  assertOneError(errors, /a\.json#\/allOf\/0: references core\/base\.json in allOf/);
});

test('a fragment reference passes when the subschema it names uses no local definition', () => {
  const base = {
    file: 'core/base.json',
    schema: { definitions: { wrapper: objectWith({ code: { type: 'string' } }), other: objectWith({ x: { $ref: '#/definitions/wrapper' } }) } },
  };
  assert.deepEqual(errorsFor([base, { file: 'a.json', schema: { allOf: [{ $ref: '/schemas/core/base.json#/definitions/wrapper' }], required: ['code'] } }]), []);
});

test('a reference with only annotations beside it passes', () => {
  assert.deepEqual(errorsFor(composedBy(objectWith({ params: { ...baseRef, description: 'Kept.' } }))), []);
});

test('a repeated constraint fails, and no list can opt a site out', () => {
  const list = { min_repeat_sites: 3, held_apart: [{ path: 'a.json#/properties/code', reason: 'A different code.' }] };
  const documents = sitesIn(['a.json', 'b.json']);
  assertOneError(checkTree(documents, list).errors, /Repeated unnamed constraint/);
  assert.equal(fs.existsSync(path.join(REPO_ROOT, 'scripts', 'schema-named-constraints.json')), false);
});

test('an inline copy fails, and no list can opt it out', () => {
  const list = { held_apart: [{ path: 'a.json#/properties/airport', reason: 'An IATA airport code.' }] };
  const documents = [named, { file: 'a.json', schema: objectWith({ airport: inlineCurrency }) }];
  assertOneError(checkTree(documents, list).errors, /inline copy of a named schema/);
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
