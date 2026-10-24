#!/usr/bin/env node

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { lintAppliesWhen } = require('../scripts/lint-applies-when.cjs');

function writeJson(root, relativePath, value) {
  const file = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

const BASE_FILES = {
  'enums/delivery-type.json': {
    $id: '/schemas/enums/delivery-type.json',
    type: 'string',
    enum: ['guaranteed', 'non_guaranteed'],
  },
  'enums/pricing-model.json': {
    $id: '/schemas/enums/pricing-model.json',
    type: 'string',
    enum: ['cpm', 'cpp'],
  },
  'core/execution.json': {
    $id: '/schemas/core/execution.json',
    type: 'object',
    properties: { trusted_match: { type: 'object' } },
  },
  'protocol/get-adcp-capabilities-response.json': {
    $id: '/schemas/protocol/get-adcp-capabilities-response.json',
    type: 'object',
    properties: {
      media_buy: {
        type: 'object',
        properties: {
          conversion_tracking: { type: 'object' },
          execution: { $ref: '/schemas/core/execution.json' },
        },
      },
    },
  },
};

function product(properties, extra = {}) {
  return {
    'core/product.json': {
      $id: '/schemas/core/product.json',
      type: 'object',
      properties,
      ...extra,
    },
  };
}

function withFixture(files, callback) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'applies-when-'));
  try {
    for (const [relativePath, schema] of Object.entries({ ...BASE_FILES, ...files })) {
      writeJson(tmp, relativePath, schema);
    }
    callback(lintAppliesWhen({ schemasDir: tmp }));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function assertErrorMatching(result, pattern) {
  assert.equal(result.ok, false, 'expected the lint to fail');
  assert.ok(
    result.errors.some((error) => pattern.test(error)),
    `expected an error matching ${pattern}, got:\n${result.errors.join('\n')}`,
  );
}

test('the repository source tree passes', () => {
  const result = lintAppliesWhen();
  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.ok(result.annotations.length > 0, 'expected annotated properties');
});

test('accepts every key, including capability paths that cross a $ref', () => {
  withFixture(product({
    cancellation_policy: { type: 'object', 'x-adcp-applies-when': { delivery_types: ['guaranteed'] } },
    cpp_terms: { type: 'object', 'x-adcp-applies-when': { pricing_models: ['cpp'] } },
    trusted_match: {
      type: 'object',
      'x-adcp-applies-when': { capabilities: ['media_buy.execution.trusted_match'] },
    },
    tracking: {
      type: 'object',
      'x-adcp-applies-when': {
        delivery_types: ['non_guaranteed'],
        capabilities: ['media_buy.conversion_tracking'],
      },
    },
  }), (result) => {
    assert.equal(result.ok, true, result.errors.join('\n'));
    assert.equal(result.annotations.length, 4);
  });
});

test('rejects unknown keys', () => {
  withFixture(product({
    field: { type: 'string', 'x-adcp-applies-when': { channels: ['dooh'] } },
  }), (result) => assertErrorMatching(result, /unknown key "channels"/));
});

test('rejects empty annotations and empty arrays', () => {
  withFixture(product({
    a: { type: 'string', 'x-adcp-applies-when': {} },
    b: { type: 'string', 'x-adcp-applies-when': { delivery_types: [] } },
  }), (result) => {
    assertErrorMatching(result, /must name at least one key/);
    assertErrorMatching(result, /delivery_types must be a non-empty array/);
  });
});

test('rejects values outside their enums', () => {
  withFixture(product({
    a: { type: 'string', 'x-adcp-applies-when': { delivery_types: ['guarenteed'] } },
    b: { type: 'string', 'x-adcp-applies-when': { pricing_models: ['cpx'] } },
  }), (result) => {
    assertErrorMatching(result, /"guarenteed" is not in enums\/delivery-type\.json/);
    assertErrorMatching(result, /"cpx" is not in enums\/pricing-model\.json/);
  });
});

test('rejects capability paths that do not resolve', () => {
  withFixture(product({
    a: { type: 'string', 'x-adcp-applies-when': { capabilities: ['media_buy.execution.nope'] } },
  }), (result) => assertErrorMatching(result, /"media_buy\.execution\.nope" does not resolve/));
});

test('rejects annotated properties that the parent requires', () => {
  withFixture(product(
    { a: { type: 'string', 'x-adcp-applies-when': { delivery_types: ['guaranteed'] } } },
    { required: ['a'] },
  ), (result) => assertErrorMatching(result, /"a" is required by its parent/));
});

test('treats allOf, oneOf, and conditional requirements as required', () => {
  const annotated = { type: 'string', 'x-adcp-applies-when': { delivery_types: ['guaranteed'] } };
  withFixture(product({ a: annotated }, { allOf: [{ required: ['a'] }] }), (result) =>
    assertErrorMatching(result, /"a" is required by its parent/));
  withFixture(product({ a: annotated }, { oneOf: [{ required: ['a'] }, { required: ['b'] }] }), (result) =>
    assertErrorMatching(result, /"a" is required by its parent/));
  withFixture(product({ a: annotated }, {
    allOf: [{ if: { required: ['b'] }, then: { required: ['a'] } }],
  }), (result) => assertErrorMatching(result, /"a" is required by its parent/));
  withFixture(product({ a: annotated }, { if: { required: ['b'] }, else: { required: ['a'] } }), (result) =>
    assertErrorMatching(result, /"a" is required by its parent/));
});

test('counts draft-07 dependencies as requirements', () => {
  const annotated = { type: 'string', 'x-adcp-applies-when': { delivery_types: ['guaranteed'] } };
  withFixture(product({ a: annotated, b: { type: 'string' } }, { dependencies: { b: ['a'] } }), (result) =>
    assertErrorMatching(result, /"a" is required by its parent/));
  withFixture(product({ a: annotated, b: { type: 'string' } }, { dependencies: { b: { required: ['a'] } } }), (result) =>
    assertErrorMatching(result, /"a" is required by its parent/));
});

test('rejects annotated properties in closed objects', () => {
  withFixture(product(
    { a: { type: 'string', 'x-adcp-applies-when': { delivery_types: ['guaranteed'] } } },
    { additionalProperties: false },
  ), (result) => assertErrorMatching(result, /sits in a closed object/));
});

test('rejects the annotation outside a property declaration', () => {
  withFixture(product({
    list: {
      type: 'array',
      items: { type: 'string', 'x-adcp-applies-when': { delivery_types: ['guaranteed'] } },
    },
  }), (result) => assertErrorMatching(result, /must sit on a property declaration/));
});

test('ignores annotation-shaped values inside examples', () => {
  withFixture(product({
    a: { type: 'object', examples: [{ 'x-adcp-applies-when': { bogus: true } }] },
  }), (result) => assert.equal(result.ok, true, result.errors.join('\n')));
});
