#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { lint, lintSchemas, loadSchemas, ALLOWED, SCHEMA_DIR } = require('../scripts/lint-schema-required-declared.cjs');

function lintTree(t, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-required-declared-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [rel, doc] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, JSON.stringify(doc));
  }
  return lint(dir).violations;
}

test('source tree requires only declared properties', () => {
  const { violations } = lint();
  assert.deepEqual(
    violations,
    [],
    'required names are not declared under properties:\n' +
      violations.map((v) => `  ${v.file}${v.path} — ${v.missing.join(', ')}`).join('\n'),
  );
});

test('validate_input warnings declare `field`, matching violations (#8194)', () => {
  const doc = JSON.parse(
    fs.readFileSync(
      path.resolve(__dirname, '..', 'static', 'schemas', 'source', 'creative', 'validate-input-result.json'),
      'utf8',
    ),
  );
  const warning = doc.properties.warnings.items;
  assert.ok(warning.required.includes('field'), 'warnings.items still requires field');
  assert.equal(warning.properties.field.type, 'string');
});

test('reports a required name with no declaration', (t) => {
  const violations = lintTree(t, {
    'a.json': {
      type: 'object',
      properties: {
        warnings: {
          type: 'array',
          items: { type: 'object', required: ['rule', 'field'], properties: { rule: { type: 'string' } } },
        },
      },
    },
  });
  assert.deepEqual(violations, [{ file: 'a.json', path: '/properties/warnings/items', missing: ['field'] }]);
});

test('accepts names declared by own properties, allOf branches, or $ref', (t) => {
  const violations = lintTree(t, {
    'base.json': { type: 'object', properties: { id: { type: 'string' } } },
    'own.json': { type: 'object', required: ['a'], properties: { a: {} } },
    'all-of.json': {
      type: 'object',
      required: ['id', 'b'],
      allOf: [{ $ref: '/schemas/base.json' }, { properties: { b: {} } }],
    },
    'ref.json': { $ref: '/schemas/base.json', required: ['id'] },
    'local-ref.json': {
      $defs: { base: { properties: { c: {} } } },
      type: 'object',
      required: ['c'],
      allOf: [{ $ref: '#/$defs/base' }],
    },
    'pattern.json': { type: 'object', required: ['x_a'], patternProperties: { '^x_': {} } },
  });
  assert.deepEqual(violations, []);
});

test('conditional branches may require properties declared one level up', (t) => {
  const violations = lintTree(t, {
    'cond.json': {
      type: 'object',
      properties: { kind: { type: 'string' }, params: { type: 'object', properties: { id: {} } } },
      allOf: [
        { if: { properties: { kind: { const: 'a' } } }, then: { required: ['params'] } },
        { if: { required: ['kind'] }, then: { properties: { params: { required: ['id'] } } } },
      ],
      oneOf: [{ required: ['kind'] }, { required: ['params'] }],
    },
  });
  assert.deepEqual(violations, []);
});

test('a conditional branch still fails when no enclosing schema declares the name', (t) => {
  const violations = lintTree(t, {
    'cond.json': {
      type: 'object',
      properties: { kind: { type: 'string' } },
      allOf: [{ if: { properties: { kind: { const: 'a' } } }, then: { required: ['missing'] } }],
    },
  });
  assert.deepEqual(violations, [{ file: 'cond.json', path: '/allOf/0/then', missing: ['missing'] }]);
});

test('declarations under a sibling property do not leak across levels', (t) => {
  const violations = lintTree(t, {
    'nest.json': {
      type: 'object',
      properties: { outer: { type: 'object', required: ['inner'], properties: { other: {} } }, inner: {} },
    },
  });
  assert.deepEqual(violations, [{ file: 'nest.json', path: '/properties/outer', missing: ['inner'] }]);
});

test('`not` branches may name properties that must be absent', (t) => {
  const violations = lintTree(t, {
    'not.json': { type: 'object', properties: { a: {} }, not: { anyOf: [{ required: ['forbidden'] }] } },
  });
  assert.deepEqual(violations, []);
});

test('an unresolvable $ref is skipped, not reported', (t) => {
  const violations = lintTree(t, {
    'ext.json': { type: 'object', required: ['x'], allOf: [{ $ref: '/schemas/missing.json' }] },
  });
  assert.deepEqual(violations, []);
});

test('dependentSchemas inherit the enclosing declarations', (t) => {
  const violations = lintTree(t, {
    'dep.json': { type: 'object', properties: { a: {}, b: {} }, dependentSchemas: { a: { required: ['b'] } } },
  });
  assert.deepEqual(violations, []);
});

test('every ALLOWED entry still matches an undeclared name', () => {
  const { violations } = lintSchemas(loadSchemas(SCHEMA_DIR), new Set());
  const found = new Set(violations.flatMap((v) => v.missing.map((name) => `${v.file}|${v.path || '/'}|${name}`)));
  const stale = [...ALLOWED].filter((entry) => !found.has(entry));
  assert.deepEqual(stale, [], `stale ALLOWED entries (the gap was fixed; remove them):\n  ${stale.join('\n  ')}`);
});

test('an allowlist entry covers only its named property', (t) => {
  const files = {
    'a.json': { type: 'object', properties: { row: { type: 'object', required: ['known', 'fresh'] } } },
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-required-declared-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify(files['a.json']));
  const { violations } = lint(dir, new Set(['a.json|/properties/row|known']));
  assert.deepEqual(violations, [{ file: 'a.json', path: '/properties/row', missing: ['fresh'] }]);
});

test('`if` conditions are not checked', (t) => {
  const violations = lintTree(t, {
    'if.json': { type: 'object', properties: { a: {} }, if: { required: ['a', 'undeclared'] }, then: {} },
  });
  assert.deepEqual(violations, []);
});

test('draft-07 array-form `dependencies` names must be declared', (t) => {
  const violations = lintTree(t, {
    'dep.json': {
      type: 'object',
      properties: { width: {}, height: {}, params: { type: 'object', properties: { w: {} } } },
      dependencies: { width: ['height'], height: ['depth'] },
      allOf: [{ then: { properties: { params: { dependencies: { w: ['h'] } } } } }],
    },
  });
  assert.deepEqual(violations, [
    { file: 'dep.json', path: '/allOf/0/then/properties/params/dependencies/w', missing: ['h'] },
    { file: 'dep.json', path: '/dependencies/height', missing: ['depth'] },
  ]);
});

test('reports how many name lists were skipped for an unresolvable $ref', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-required-declared-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(dir, 'ext.json'),
    JSON.stringify({ type: 'object', required: ['x'], allOf: [{ $ref: 'https://example.com/other.json' }] }),
  );
  assert.deepEqual(lint(dir), { violations: [], skipped: 1 });
});
