#!/usr/bin/env node

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { lint, vectorSetNames } = require('../scripts/lint-conformance-doc-freshness.cjs');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'conformance-doc-freshness-'));
  const vectorSource = path.join(root, 'static/compliance/source/test-vectors');
  const vectorIndex = path.join(root, 'docs/reference/test-vectors/index.mdx');
  const guidanceFile = path.join(root, 'docs/reference/known-limitations.mdx');
  fs.mkdirSync(path.join(vectorSource, 'request-signing'), { recursive: true });
  fs.writeFileSync(path.join(vectorSource, 'request-signing', 'vectors.json'), '{}');
  fs.writeFileSync(path.join(vectorSource, 'plan-hash.json'), '{}');
  fs.writeFileSync(path.join(vectorSource, 'plan-hash.schema.json'), '{}');
  fs.mkdirSync(path.dirname(vectorIndex), { recursive: true });
  fs.writeFileSync(vectorIndex, 'test-vectors/request-signing\ntest-vectors/plan-hash\n');
  fs.mkdirSync(path.dirname(guidanceFile), { recursive: true });
  fs.writeFileSync(guidanceFile, 'Current status comes from CI.\n');
  return { root, vectorSource, vectorIndex, guidance: ['docs/reference/known-limitations.mdx'] };
}

test('repository vector catalog and conformance guidance are current', () => {
  const result = lint();
  assert.deepEqual(result.errors, []);
  assert.ok(result.vectorSets.includes('request-signing'));
  assert.ok(result.vectorSets.includes('universal-macro-translation'));
});

test('versioned vector discovery treats singleton JSON and directories as sets', () => {
  const files = fixture();
  assert.deepEqual(vectorSetNames(files.vectorSource), ['plan-hash', 'request-signing']);
});

test('an uncatalogued versioned vector set fails', () => {
  const files = fixture();
  fs.mkdirSync(path.join(files.vectorSource, 'new-vectors'));
  const result = lint(files);
  assert.ok(result.errors.some(error => error.includes('missing published versioned vector set `new-vectors`')));
});

test('a catalog prefix collision does not count as an exact vector-set entry', () => {
  const files = fixture();
  fs.writeFileSync(
    files.vectorIndex,
    'test-vectors/request-signing/\ntest-vectors/plan-hash-old.json\n',
  );
  const result = lint(files);
  assert.ok(result.errors.some(error => error.includes('missing published versioned vector set `plan-hash`')));
});

test('historical scores and closed follow-ups fail in current guidance', () => {
  const files = fixture();
  const guidanceFile = path.join(files.root, files.guidance[0]);
  fs.writeFileSync(guidanceFile, [
    'The training agent passes 32 of 55 storyboards.',
    'More vectors are tracked in /issues/2383.',
    'The workaround remains in adcp-client#2244.',
    'The formal program launches with 3.1.',
  ].join('\n'));
  const result = lint(files);
  assert.equal(result.errors.length, 4);
});
