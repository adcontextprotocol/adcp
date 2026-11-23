'use strict';

// The near-duplicate gate, through its command line: the source tree passes,
// and each rule accepts or rejects a small tree that exercises it alone.

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'lint-schema-near-duplicates.cjs');

function run(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
}

function withTree(files, check) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-near-duplicates-'));
  try {
    for (const [rel, schema] of Object.entries(files)) {
      const file = path.join(dir, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ $schema: 'http://json-schema.org/draft-07/schema#', $id: `/schemas/${rel}`, ...schema }));
    }
    check(run(['--schemas-dir', dir]));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const money = {
  title: 'Money',
  type: 'object',
  properties: { amount: { type: 'number', minimum: 0 }, currency: { $ref: '/schemas/core/currency-code.json' } },
  required: ['amount', 'currency'],
};
const currency = { title: 'Currency Code', type: 'string', pattern: '^[A-Z]{3}$' };

test('the source tree has one definition per object concept', () => {
  const result = run([]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /one definition per concept/);
});

test('an inline copy of a definition is an exact repeat', () => {
  withTree({
    'core/currency-code.json': currency,
    'core/money.json': money,
    'media-buy/order.json': { type: 'object', properties: { budget: { ...money, title: undefined, description: 'Budget.' } } },
  }, (result) => {
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Exact repeat: 2 object schemas/);
    assert.match(result.stderr, /media-buy\/order\.json#\/properties\/budget/);
  });
});

test('a same-concept copy with a drifted field fails, and a $ref to the definition passes', () => {
  const drifted = { type: 'object', properties: { amount: { type: 'number' }, currency: { type: 'string', minLength: 3 } }, required: ['amount', 'currency'] };
  withTree({
    'core/currency-code.json': currency,
    'core/money.json': money,
    'media-buy/order.json': { type: 'object', properties: { budget: drifted } },
  }, (result) => {
    assert.equal(result.status, 1);
    assert.match(result.stderr, /same concept \(properties amount, currency\), same properties, different contract/);
    assert.match(result.stderr, /amount minimum: none here, 0 there|amount minimum: 0 here, none there/);
  });
  withTree({
    'core/currency-code.json': currency,
    'core/money.json': money,
    'media-buy/order.json': { type: 'object', properties: { budget: { $ref: '/schemas/core/money.json', description: 'Budget.' } } },
  }, (result) => assert.equal(result.status, 0, result.stderr));
});

test('a declared refinement passes', () => {
  withTree({
    'core/currency-code.json': currency,
    'core/money.json': money,
    'core/positive-money.json': {
      title: 'Positive Money',
      allOf: [{ $ref: '/schemas/core/money.json' }, { properties: { amount: { exclusiveMinimum: 0 } } }],
    },
  }, (result) => assert.equal(result.status, 0, result.stderr));
});

test('parallel role variants may differ only in object-level keywords', () => {
  const request = { title: 'Range', type: 'object', properties: { min: { type: 'number' }, max: { type: 'number' } } };
  withTree({
    'core/closed-range.json': { ...request, title: 'Closed Range', required: ['min', 'max'] },
    'core/open-range.json': { ...request, title: 'Open Range', anyOf: [{ required: ['min'] }, { required: ['max'] }] },
  }, (result) => assert.equal(result.status, 0, result.stderr));
  withTree({
    'core/closed-range.json': { ...request, title: 'Closed Range', required: ['min', 'max'] },
    'core/open-range.json': { ...request, title: 'Open Range', properties: { min: { type: 'integer' }, max: { type: 'number' } } },
  }, (result) => {
    assert.equal(result.status, 1);
    assert.match(result.stderr, /min type/);
  });
});

test('a field that references a different named definition tells two concepts apart', () => {
  withTree({
    'enums/distance-unit.json': { title: 'Distance Unit', type: 'string', enum: ['km', 'mi'] },
    'enums/area-unit.json': { title: 'Area Unit', type: 'string', enum: ['sqm', 'sqft'] },
    'core/distance.json': { title: 'Distance', type: 'object', properties: { value: { type: 'number', exclusiveMinimum: 0 }, unit: { $ref: '/schemas/enums/distance-unit.json' } } },
    'core/area.json': { title: 'Area', type: 'object', properties: { value: { type: 'number', minimum: 0 }, unit: { $ref: '/schemas/enums/area-unit.json' } } },
  }, (result) => assert.equal(result.status, 0, result.stderr));
});

test('a title-only alias names the definition it references, not a different one', () => {
  const cloud = { title: 'Cloud', type: 'string', enum: ['aws', 'gcp'] };
  const share = (cloudRef, region) => ({ type: 'object', properties: { cloud: { $ref: cloudRef }, region } });
  withTree({
    'enums/cloud.json': cloud,
    'core/share.json': { title: 'Share', ...share('/schemas/enums/cloud.json', { type: 'string' }) },
    'core/copy.json': {
      title: 'Share',
      definitions: { Cloud: { title: 'Copy Cloud', $ref: '/schemas/enums/cloud.json' } },
      ...share('#/definitions/Cloud', { type: 'string', maxLength: 64 }),
    },
  }, (result) => {
    assert.equal(result.status, 1, 'an alias of the same enum does not tell the two copies apart');
    assert.match(result.stderr, /region maxLength/);
  });
});

test('a distinct title separates only objects whose properties differ', () => {
  const props = { start: { type: 'string', format: 'date' }, end: { type: 'string', format: 'date' } };
  withTree({
    'core/period.json': { title: 'Period', type: 'object', properties: props },
    'core/window.json': { title: 'Window', type: 'object', properties: { ...props, end: { type: 'string', format: 'date', minLength: 10 } } },
  }, (result) => {
    assert.equal(result.status, 1);
    assert.match(result.stderr, /end minLength/);
  });
  withTree({
    'core/period.json': { title: 'Period', type: 'object', properties: props },
    'core/window.json': { title: 'Window', type: 'object', properties: { ...props, label: { type: 'string' } } },
  }, (result) => assert.equal(result.status, 0, result.stderr));
});

test('conditions are not declarations', () => {
  withTree({
    'core/currency-code.json': currency,
    'core/money.json': money,
    'media-buy/order.json': {
      type: 'object',
      properties: { budget: { $ref: '/schemas/core/money.json' } },
      if: { properties: { budget: { type: 'object', properties: { amount: { const: 0 }, currency: { const: 'USD' } } } } },
      then: { required: ['budget'] },
    },
  }, (result) => assert.equal(result.status, 0, result.stderr));
});

test('a document that restates another inside an envelope fails, and composing it passes', () => {
  const envelope = { title: 'Envelope', type: 'object', properties: { context: { type: 'object' }, status: { type: 'string' } } };
  const ack = { title: 'Ack', type: 'object', properties: { status: { const: 'submitted' }, task_id: { type: 'string' } }, required: ['status'] };
  const body = {
    title: 'Submitted Body',
    type: 'object',
    allOf: [{ $ref: '/schemas/core/ack.json' }],
    properties: { context: { type: 'object' }, errors: { type: 'array' } },
  };
  withTree({
    'core/envelope.json': envelope,
    'core/ack.json': ack,
    'core/submitted-body.json': body,
    'core/submitted.json': {
      title: 'Submitted',
      type: 'object',
      allOf: [{ $ref: '/schemas/core/envelope.json' }, { $ref: '/schemas/core/ack.json' }],
      properties: { context: { type: 'object' }, errors: { type: 'array' } },
    },
  }, (result) => {
    assert.equal(result.status, 1);
    assert.match(result.stderr, /restates core\/submitted-body\.json# inside core\/envelope\.json#/);
  });
  withTree({
    'core/envelope.json': envelope,
    'core/ack.json': ack,
    'core/submitted-body.json': body,
    'core/submitted.json': {
      title: 'Submitted',
      allOf: [{ $ref: '/schemas/core/envelope.json' }, { $ref: '/schemas/core/submitted-body.json' }],
    },
  }, (result) => assert.equal(result.status, 0, result.stderr));
});

test('two refinements of one definition that add the same fields with drift fail', () => {
  const base = { title: 'Paused', type: 'object', properties: { status: { const: 'input-required' } }, required: ['status'] };
  const paused = (reason) => ({
    type: 'object',
    allOf: [{ $ref: '/schemas/core/paused.json' }],
    properties: { reason, errors: { type: 'array' } },
  });
  withTree({
    'core/paused.json': base,
    'core/compact-paused.json': { ...paused({ type: 'string', maxLength: 200 }), title: 'Compact Paused' },
    'media-buy/buy-paused.json': { ...paused({ type: 'string', enum: ['APPROVAL_REQUIRED'] }), title: 'Buy Paused' },
  }, (result) => {
    assert.equal(result.status, 1);
    assert.match(result.stderr, /reason/);
  });
});

test('bodies with different union tags are different concepts', () => {
  const envelope = { title: 'Envelope', type: 'object', properties: { context: { type: 'object' } } };
  withTree({
    'core/envelope.json': envelope,
    'core/submitted.json': {
      title: 'Submitted', type: 'object',
      properties: { status: { const: 'submitted' }, errors: { type: 'array' } }, required: ['status'],
    },
    'core/failed.json': {
      title: 'Failed', type: 'object',
      allOf: [{ $ref: '/schemas/core/envelope.json' }],
      properties: { status: { const: 'failed' }, errors: { type: 'array', minItems: 1 } }, required: ['status'],
    },
  }, (result) => assert.equal(result.status, 0, result.stderr));
});
