#!/usr/bin/env node
/**
 * Tests scripts/lint-schema-cross-document-refs.cjs through its CLI. Each
 * failing tree holds exactly one `$ref` into another document and must
 * produce exactly one violation.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'lint-schema-cross-document-refs.cjs');

function runCli(args = []) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function treeWith(t, documents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xdoc-refs-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [file, schema] of Object.entries(documents)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), JSON.stringify(schema, null, 2));
  }
  return dir;
}

const target = {
  'core/target.json': {
    $id: '/schemas/core/target.json',
    type: 'object',
    definitions: { name: { type: 'string' } },
    properties: { name: { $ref: '#/definitions/name' } },
  },
};
const referrer = (ref) => ({
  'core/referrer.json': { $id: '/schemas/core/referrer.json', type: 'object', properties: { field: { $ref: ref } } },
});

function assertOneViolation(result, pattern) {
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const lines = result.stderr.split('\n').filter((line) => line.startsWith('  '));
  assert.equal(lines.length, 1, result.stderr);
  assert.match(lines[0], pattern);
}

test('the source tree passes', () => {
  const result = runCli();
  assert.equal(result.status, 0, result.stderr);
});

test('a $ref to a whole document passes', (t) => {
  const result = runCli(['--dir', treeWith(t, { ...target, ...referrer('/schemas/core/target.json') })]);
  assert.equal(result.status, 0, result.stderr);
});

test('a $ref to a fragment of its own document passes', (t) => {
  const result = runCli(['--dir', treeWith(t, target)]);
  assert.equal(result.status, 0, result.stderr);
});

test('a $ref with an empty fragment names the whole document and passes', (t) => {
  const result = runCli(['--dir', treeWith(t, { ...target, ...referrer('/schemas/core/target.json#') })]);
  assert.equal(result.status, 0, result.stderr);
});

test('a $ref into another document\'s definitions fails with the file, the pointer, and the $ref', (t) => {
  const result = runCli(['--dir', treeWith(t, { ...target, ...referrer('/schemas/core/target.json#/definitions/name') })]);
  assertOneViolation(result, /^ {2}core\/referrer\.json#\/properties\/field: \$ref "\/schemas\/core\/target\.json#\/definitions\/name" points into another document\./);
});

test('a $ref into another document\'s properties fails', (t) => {
  const result = runCli(['--dir', treeWith(t, { ...target, ...referrer('/schemas/core/target.json#/properties/name') })]);
  assertOneViolation(result, /#\/properties\/name" points into another document/);
});

test('a relative $ref into another document fails', (t) => {
  const result = runCli(['--dir', treeWith(t, { ...target, ...referrer('target.json#/definitions/name') })]);
  assertOneViolation(result, /"target\.json#\/definitions\/name"/);
});

test('a $ref to a plain-name anchor in another document fails', (t) => {
  const result = runCli(['--dir', treeWith(t, { ...target, ...referrer('/schemas/core/target.json#name') })]);
  assertOneViolation(result, /"\/schemas\/core\/target\.json#name"/);
});

test('a $ref nested in a combinator inside a definition fails at its own pointer', (t) => {
  const documents = {
    ...target,
    'core/referrer.json': {
      $id: '/schemas/core/referrer.json',
      definitions: { pick: { anyOf: [{ $ref: '/schemas/core/target.json#/definitions/name' }, { type: 'null' }] } },
    },
  };
  assertOneViolation(runCli(['--dir', treeWith(t, documents)]), /^ {2}core\/referrer\.json#\/definitions\/pick\/anyOf\/0: /);
});

test('instance data that holds a "$ref" key is not a reference', (t) => {
  const documents = {
    ...target,
    'core/referrer.json': {
      $id: '/schemas/core/referrer.json',
      type: 'object',
      examples: [{ $ref: '/schemas/core/target.json#/definitions/name' }],
      properties: { doc: { const: { $ref: '/schemas/core/target.json#/definitions/name' } } },
    },
  };
  const result = runCli(['--dir', treeWith(t, documents)]);
  assert.equal(result.status, 0, result.stderr);
});
