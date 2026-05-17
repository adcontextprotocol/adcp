#!/usr/bin/env node
/**
 * Unit tests for hoistMarkedSchemas in scripts/build-schemas.cjs.
 *
 * The function honors `x-hoist: true` on inlined schemas: each marked
 * schema moves to root $defs, every inline occurrence is replaced with a
 * $ref, and the directive itself is stripped from the bundled output.
 *
 * See issue #4557 — opt-in companion to the pure-enum auto-hoist.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { hoistMarkedSchemas } = require('../scripts/build-schemas.cjs');

function clone(o) { return JSON.parse(JSON.stringify(o)); }

test('hoists a marked schema and replaces all inline occurrences with $ref', () => {
  const schema = {
    type: 'object',
    properties: {
      a: {
        'x-hoist': true,
        title: 'PriceBlock',
        type: 'object',
        properties: { cpm: { type: 'number' }, currency: { type: 'string' } },
      },
      b: {
        'x-hoist': true,
        title: 'PriceBlock',
        type: 'object',
        properties: { cpm: { type: 'number' }, currency: { type: 'string' } },
      },
    },
  };
  const result = hoistMarkedSchemas(clone(schema));

  assert.deepEqual(result.properties.a, { $ref: '#/$defs/PriceBlock' });
  assert.deepEqual(result.properties.b, { $ref: '#/$defs/PriceBlock' });
  assert.deepEqual(result.$defs.PriceBlock, {
    title: 'PriceBlock',
    type: 'object',
    properties: { cpm: { type: 'number' }, currency: { type: 'string' } },
  });
  // Directive stripped from the bundled output.
  assert.equal(result.$defs.PriceBlock['x-hoist'], undefined);
});

test('hoists a single-occurrence marked schema (directive is intent, not count)', () => {
  // x-hoist declares "this is a canonical named type" — honor it even when
  // the schema appears once, so adding a second use later does not change
  // the codegen surface.
  const schema = {
    type: 'object',
    properties: {
      only: {
        'x-hoist': true,
        title: 'PriceBlock',
        type: 'object',
        properties: { cpm: { type: 'number' } },
      },
    },
  };
  const result = hoistMarkedSchemas(clone(schema));

  assert.deepEqual(result.properties.only, { $ref: '#/$defs/PriceBlock' });
  assert.ok(result.$defs.PriceBlock);
  assert.equal(result.$defs.PriceBlock['x-hoist'], undefined);
});

test('throws when x-hoist is set without a title', () => {
  const schema = {
    type: 'object',
    properties: {
      a: { 'x-hoist': true, type: 'object', properties: { x: { type: 'string' } } },
    },
  };
  assert.throws(() => hoistMarkedSchemas(clone(schema)), /requires a non-empty `title`/);
});

test('throws when title sanitizes to an empty name', () => {
  const schema = {
    type: 'object',
    properties: {
      a: { 'x-hoist': true, title: '   ', type: 'object' },
    },
  };
  assert.throws(() => hoistMarkedSchemas(clone(schema)), /sanitizes to an empty name/);
});

test('sanitizes title to PascalCase for the $defs key', () => {
  const schema = {
    type: 'object',
    properties: {
      a: { 'x-hoist': true, title: 'Brief Asset', type: 'object', properties: { kind: { type: 'string' } } },
    },
  };
  const result = hoistMarkedSchemas(clone(schema));

  assert.deepEqual(result.properties.a, { $ref: '#/$defs/BriefAsset' });
  assert.ok(result.$defs.BriefAsset);
});

test('suffixes the def name on collision with existing $defs key', () => {
  const schema = {
    $defs: {
      PriceBlock: { type: 'object', properties: { existing: { type: 'string' } } },
    },
    type: 'object',
    properties: {
      a: { 'x-hoist': true, title: 'PriceBlock', type: 'object', properties: { cpm: { type: 'number' } } },
    },
  };
  const result = hoistMarkedSchemas(clone(schema));

  assert.equal(result.$defs.PriceBlock.properties.existing.type, 'string'); // untouched
  assert.ok(result.$defs.PriceBlock2);
  assert.deepEqual(result.properties.a, { $ref: '#/$defs/PriceBlock2' });
});

test('keeps two marked schemas with different titles distinct even if structurally identical', () => {
  // The whole point of opt-in hoist is that structural identity != semantic
  // identity. Two marked schemas with different titles must produce two
  // distinct $defs entries.
  const fields = { type: 'object', properties: { cpm: { type: 'number' } } };
  const schema = {
    type: 'object',
    properties: {
      brief: { 'x-hoist': true, title: 'BriefAsset', ...fields },
      vast: { 'x-hoist': true, title: 'VASTAsset', ...fields },
    },
  };
  const result = hoistMarkedSchemas(clone(schema));

  assert.deepEqual(result.properties.brief, { $ref: '#/$defs/BriefAsset' });
  assert.deepEqual(result.properties.vast, { $ref: '#/$defs/VASTAsset' });
  assert.ok(result.$defs.BriefAsset);
  assert.ok(result.$defs.VASTAsset);
});

test('returns input unchanged when no x-hoist markers are present', () => {
  const schema = {
    type: 'object',
    properties: {
      a: { type: 'string' },
      b: { type: 'object', properties: { c: { type: 'integer' } } },
    },
  };
  const before = JSON.stringify(schema);
  const result = hoistMarkedSchemas(clone(schema));
  assert.equal(JSON.stringify(result), before);
});

test('hoists markers inside array items', () => {
  const schema = {
    type: 'object',
    properties: {
      list: {
        type: 'array',
        items: {
          oneOf: [
            { 'x-hoist': true, title: 'PriceBlock', type: 'object', properties: { cpm: { type: 'number' } } },
            { 'x-hoist': true, title: 'PriceBlock', type: 'object', properties: { cpm: { type: 'number' } } },
          ],
        },
      },
    },
  };
  const result = hoistMarkedSchemas(clone(schema));

  assert.deepEqual(result.properties.list.items.oneOf[0], { $ref: '#/$defs/PriceBlock' });
  assert.deepEqual(result.properties.list.items.oneOf[1], { $ref: '#/$defs/PriceBlock' });
});

test('hoists nested markers (a marked schema reached through another marked schema)', () => {
  // After the outer marker is hoisted, its definition still contains the
  // inner marker. Pass 2 walks $defs entries so the inner marker also
  // collapses to a $ref.
  const inner = {
    'x-hoist': true,
    title: 'PriceBlock',
    type: 'object',
    properties: { cpm: { type: 'number' } },
  };
  const outer = {
    'x-hoist': true,
    title: 'PricedOffer',
    type: 'object',
    properties: { price: clone(inner) },
  };
  const schema = {
    type: 'object',
    properties: {
      offer: clone(outer),
    },
  };
  const result = hoistMarkedSchemas(clone(schema));

  assert.deepEqual(result.properties.offer, { $ref: '#/$defs/PricedOffer' });
  assert.deepEqual(result.$defs.PricedOffer.properties.price, { $ref: '#/$defs/PriceBlock' });
  assert.ok(result.$defs.PriceBlock);
  // Both directives stripped from canonical entries.
  assert.equal(result.$defs.PricedOffer['x-hoist'], undefined);
  assert.equal(result.$defs.PriceBlock['x-hoist'], undefined);
});

test('does not re-hoist a schema already living in $defs', () => {
  // A pre-existing $defs entry carrying x-hoist (e.g. from a prior pass)
  // is canonical; we should not duplicate it. Inline copies still collapse
  // to refs against the existing entry's name when fingerprints match.
  const shape = { type: 'object', properties: { cpm: { type: 'number' } } };
  const schema = {
    $defs: {
      PriceBlock: { 'x-hoist': true, title: 'PriceBlock', ...shape },
    },
    type: 'object',
    properties: {
      a: { 'x-hoist': true, title: 'PriceBlock', ...shape },
    },
  };
  const result = hoistMarkedSchemas(clone(schema));

  // The existing $defs entry is left untouched by collect (we skip $defs
  // during the walk). The inline copy hoists under a suffixed name to
  // avoid overwriting the pre-existing entry.
  assert.ok(result.$defs.PriceBlock);
  assert.ok(result.$defs.PriceBlock2);
  assert.deepEqual(result.properties.a, { $ref: '#/$defs/PriceBlock2' });
});
