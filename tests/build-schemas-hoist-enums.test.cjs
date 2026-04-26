#!/usr/bin/env node
/**
 * Unit tests for hoistDuplicateInlineEnums in scripts/build-schemas.cjs.
 *
 * The function detects pure-enum schemas (type: string + enum) that appear
 * inlined at multiple paths in a bundled output, hoists titled multi-occurrence
 * enums into root $defs, and replaces duplicates with $ref pointers. The fix
 * eliminates the Foo/Foo1 codegen artifact that json-schema-to-typescript
 * emits when it sees structurally identical inline shapes.
 *
 * Tests cover the four branches the reviewer flagged on this PR:
 *   1. ≥2-occurrence titled enum is hoisted and references replaced
 *   2. Untitled enum is left inline (no Foo1 risk for unnamed types)
 *   3. Single-occurrence enum is left inline (no churn)
 *   4. Name collisions with existing $defs get suffixed
 *
 * Plus the two correctness fixes applied during review:
 *   5. isPureEnum no longer caps on key count — annotations like default,
 *      examples, deprecated, const are all preserved through hoisting
 *   6. Fingerprint includes title — two enums with identical values but
 *      different titles stay distinct (no silent rename)
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { hoistDuplicateInlineEnums } = require('../scripts/build-schemas.cjs');

function clone(o) { return JSON.parse(JSON.stringify(o)); }

test('hoists a titled enum that appears at 2+ inline locations', () => {
  const schema = {
    type: 'object',
    properties: {
      first: { type: 'string', enum: ['a', 'b', 'c'], title: 'Letter' },
      second: { type: 'string', enum: ['a', 'b', 'c'], title: 'Letter' },
    },
  };
  const result = hoistDuplicateInlineEnums(clone(schema));

  assert.deepEqual(result.properties.first, { $ref: '#/$defs/Letter' });
  assert.deepEqual(result.properties.second, { $ref: '#/$defs/Letter' });
  assert.deepEqual(result.$defs.Letter, { type: 'string', enum: ['a', 'b', 'c'], title: 'Letter' });
});

test('leaves untitled enums inline even when duplicated', () => {
  // Untitled enums don't get hoisted — there's no meaningful name to derive,
  // and a generic InlineEnumN would be worse than the status quo.
  const schema = {
    type: 'object',
    properties: {
      a: { type: 'string', enum: ['x', 'y'] },
      b: { type: 'string', enum: ['x', 'y'] },
    },
  };
  const result = hoistDuplicateInlineEnums(clone(schema));

  assert.deepEqual(result.properties.a, { type: 'string', enum: ['x', 'y'] });
  assert.deepEqual(result.properties.b, { type: 'string', enum: ['x', 'y'] });
  assert.equal(result.$defs, undefined);
});

test('leaves a single-occurrence enum inline (no churn)', () => {
  const schema = {
    type: 'object',
    properties: {
      only: { type: 'string', enum: ['solo'], title: 'OnlyOnce' },
    },
  };
  const result = hoistDuplicateInlineEnums(clone(schema));

  assert.deepEqual(result.properties.only, { type: 'string', enum: ['solo'], title: 'OnlyOnce' });
  assert.equal(result.$defs, undefined);
});

test('suffixes the def name when it collides with an existing $defs key', () => {
  const schema = {
    $defs: {
      Status: { type: 'object', properties: { code: { type: 'integer' } } },
    },
    type: 'object',
    properties: {
      a: { type: 'string', enum: ['ok', 'fail'], title: 'Status' },
      b: { type: 'string', enum: ['ok', 'fail'], title: 'Status' },
    },
  };
  const result = hoistDuplicateInlineEnums(clone(schema));

  assert.equal(result.$defs.Status.type, 'object'); // pre-existing object def untouched
  assert.deepEqual(result.$defs.Status2, { type: 'string', enum: ['ok', 'fail'], title: 'Status' });
  assert.deepEqual(result.properties.a, { $ref: '#/$defs/Status2' });
  assert.deepEqual(result.properties.b, { $ref: '#/$defs/Status2' });
});

test('preserves annotations beyond the legacy 4-key cap (default, examples, etc.)', () => {
  // The reviewer flagged that the original `keys.length <= 4` cap excluded
  // legitimate enums carrying default/examples/deprecated/const. Those should
  // hoist normally — the only filter is the composition keyword exclude list.
  const enumShape = {
    type: 'string',
    enum: ['low', 'mid', 'high'],
    title: 'Severity',
    description: 'Severity level',
    default: 'mid',
    examples: ['low'],
    deprecated: false,
  };
  const schema = {
    type: 'object',
    properties: {
      first: clone(enumShape),
      second: clone(enumShape),
    },
  };
  const result = hoistDuplicateInlineEnums(clone(schema));

  assert.deepEqual(result.properties.first, { $ref: '#/$defs/Severity' });
  assert.deepEqual(result.properties.second, { $ref: '#/$defs/Severity' });
  assert.equal(result.$defs.Severity.default, 'mid');
  assert.equal(result.$defs.Severity.deprecated, false);
});

test('keeps two enums with identical values but different titles distinct', () => {
  // Without title in the fingerprint, both call sites would collapse to the
  // first-seen title's def — silently renaming one of them. The fix is to
  // include title in the fingerprint, so distinct-titled enums stay distinct
  // even if they share enum values.
  const schema = {
    type: 'object',
    properties: {
      first: { type: 'string', enum: ['ok', 'fail'], title: 'CheckResult' },
      first_dup: { type: 'string', enum: ['ok', 'fail'], title: 'CheckResult' },
      second: { type: 'string', enum: ['ok', 'fail'], title: 'AuditOutcome' },
      second_dup: { type: 'string', enum: ['ok', 'fail'], title: 'AuditOutcome' },
    },
  };
  const result = hoistDuplicateInlineEnums(clone(schema));

  assert.deepEqual(result.properties.first, { $ref: '#/$defs/CheckResult' });
  assert.deepEqual(result.properties.first_dup, { $ref: '#/$defs/CheckResult' });
  assert.deepEqual(result.properties.second, { $ref: '#/$defs/AuditOutcome' });
  assert.deepEqual(result.properties.second_dup, { $ref: '#/$defs/AuditOutcome' });
  assert.ok(result.$defs.CheckResult);
  assert.ok(result.$defs.AuditOutcome);
});

test('preserves enum-value order across hoisted instances', () => {
  // Two enums with the same values in different orders are different schemas;
  // sorting would risk silently merging them. Verify that order-different
  // enums stay distinct AND that the hoisted def preserves the source order.
  const schema = {
    type: 'object',
    properties: {
      a: { type: 'string', enum: ['x', 'y'], title: 'XY' },
      a_dup: { type: 'string', enum: ['x', 'y'], title: 'XY' },
      b: { type: 'string', enum: ['y', 'x'], title: 'YX' },
      b_dup: { type: 'string', enum: ['y', 'x'], title: 'YX' },
    },
  };
  const result = hoistDuplicateInlineEnums(clone(schema));

  assert.deepEqual(result.$defs.XY.enum, ['x', 'y']);
  assert.deepEqual(result.$defs.YX.enum, ['y', 'x']);
});

test('skips enums nested inside an existing $defs block', () => {
  // The walk explicitly skips $defs/definitions to avoid hoisting a schema
  // that's already a def into a sibling def.
  const schema = {
    $defs: {
      Existing: { type: 'string', enum: ['a', 'b'], title: 'Existing' },
    },
    type: 'object',
    properties: {
      one: { type: 'string', enum: ['a', 'b'], title: 'Existing' },
      two: { type: 'string', enum: ['a', 'b'], title: 'Existing' },
    },
  };
  const result = hoistDuplicateInlineEnums(clone(schema));

  // Inline 'one' and 'two' are duplicates of each other → hoisted under a
  // suffixed name to avoid clobbering the pre-existing $defs.Existing.
  assert.equal(result.$defs.Existing.enum.length, 2);
  assert.ok(result.$defs.Existing2, 'duplicate inline pair should hoist into Existing2');
  assert.deepEqual(result.properties.one, { $ref: '#/$defs/Existing2' });
  assert.deepEqual(result.properties.two, { $ref: '#/$defs/Existing2' });
});

test('hoists duplicates inside array items', () => {
  // The walk symmetry between Pass 1 (collect) and Pass 2 (replace) needs to
  // cover array elements directly, not only object values.
  const schema = {
    type: 'object',
    properties: {
      list: {
        type: 'array',
        items: {
          oneOf: [
            { type: 'string', enum: ['p', 'q'], title: 'PQ' },
            { type: 'string', enum: ['p', 'q'], title: 'PQ' },
          ],
        },
      },
    },
  };
  const result = hoistDuplicateInlineEnums(clone(schema));

  assert.deepEqual(result.properties.list.items.oneOf[0], { $ref: '#/$defs/PQ' });
  assert.deepEqual(result.properties.list.items.oneOf[1], { $ref: '#/$defs/PQ' });
});

test('skips composition keywords (oneOf/anyOf/allOf) — they are not pure enums', () => {
  const schema = {
    type: 'object',
    properties: {
      a: {
        type: 'string',
        enum: ['x', 'y'],
        oneOf: [{ const: 'x' }, { const: 'y' }],
        title: 'NotPure',
      },
      b: {
        type: 'string',
        enum: ['x', 'y'],
        oneOf: [{ const: 'x' }, { const: 'y' }],
        title: 'NotPure',
      },
    },
  };
  const result = hoistDuplicateInlineEnums(clone(schema));

  // Both shapes have oneOf — not pure enums per the exclude list — so neither
  // is hoisted, and the original inline shape is preserved.
  assert.equal(result.properties.a.oneOf.length, 2);
  assert.equal(result.properties.b.oneOf.length, 2);
  assert.equal(result.$defs, undefined);
});

test('returns input unchanged when no duplicates exist', () => {
  const schema = {
    type: 'object',
    properties: {
      a: { type: 'string', enum: ['only_here'], title: 'Solo' },
      b: { type: 'integer' },
    },
  };
  const before = JSON.stringify(schema);
  const result = hoistDuplicateInlineEnums(clone(schema));
  assert.equal(JSON.stringify(result), before);
});
