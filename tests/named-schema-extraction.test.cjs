#!/usr/bin/env node
/**
 * Extracting a repeated scalar subschema into a named document must not change
 * what any schema accepts (#8525).
 *
 * The structural tests always run. Every `$ref` to a scalar document keeps only
 * annotations beside it, because draft-07 ignores `$ref` siblings, so a kept
 * `pattern` or `maxLength` would silently stop validating for some consumers.
 * Every scalar document under core/ has a title, which is what names the
 * generated type.
 *
 * The proof runs when SCHEMA_EXTRACTION_BASE names a git ref, as
 * `npm run test:schema-extraction` does. For each schema document changed since
 * the merge base, it resolves every `$ref` the branch adds, overlays the
 * siblings the site keeps, and requires the whole document to equal the base's.
 * The target's title and description name the document, so they do not count;
 * every other target key does, including annotations such as `x-entity`. A
 * pull request that also changes a schema on purpose fails the proof by design,
 * so it only applies to extraction-only branches. It also requires each added
 * document to be registered in index.json.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const RELATIVE_SCHEMA_DIR = path.join('static', 'schemas', 'source');
const SCHEMA_DIR = path.join(ROOT, RELATIVE_SCHEMA_DIR);
const SCALAR_TYPES = new Set(['string', 'number', 'integer']);
const DOCUMENT_METADATA = new Set(['$schema', '$id', 'title', 'description']);
const ANNOTATIONS = new Set([
  'description', 'title', '$comment', 'examples', 'default', 'deprecated', 'readOnly', 'writeOnly',
]);
const isAnnotation = (key) => ANNOTATIONS.has(key) || key.startsWith('x-');

function listSchemaFiles(dir = SCHEMA_DIR) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'bundled' && entry.name !== 'mcp') files.push(...listSchemaFiles(full));
    } else if (entry.name.endsWith('.json')) {
      files.push(full);
    }
  }
  return files;
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const refToFile = (ref) => path.join(SCHEMA_DIR, ref.replace(/^\/schemas\//, ''));

function scalarDocuments() {
  const documents = new Map();
  for (const file of listSchemaFiles(path.join(SCHEMA_DIR, 'core'))) {
    const doc = readJson(file);
    if (SCALAR_TYPES.has(doc.type)) documents.set(`/schemas/${path.relative(SCHEMA_DIR, file)}`, doc);
  }
  return documents;
}

function walk(node, pointer, visit) {
  if (Array.isArray(node)) {
    node.forEach((item, index) => walk(item, `${pointer}/${index}`, visit));
  } else if (node && typeof node === 'object') {
    visit(node, pointer);
    for (const [key, value] of Object.entries(node)) walk(value, `${pointer}/${key}`, visit);
  }
}

/** Differences between two JSON values, ignoring object key order. */
function differences(base, head, pointer, onRefAdded) {
  const isObject = (value) => value && typeof value === 'object' && !Array.isArray(value);
  if (isObject(head) && typeof head.$ref === 'string' && (!isObject(base) || base.$ref !== head.$ref)) {
    const target = readJson(refToFile(head.$ref));
    const resolved = {};
    for (const [key, value] of Object.entries(target)) if (!DOCUMENT_METADATA.has(key)) resolved[key] = value;
    for (const [key, value] of Object.entries(head)) if (key !== '$ref') resolved[key] = value;
    onRefAdded(head.$ref);
    return differences(base, resolved, pointer, onRefAdded);
  }
  if (Array.isArray(base) && Array.isArray(head)) {
    if (base.length !== head.length) return [`${pointer}: array length ${base.length} became ${head.length}`];
    return base.flatMap((item, index) => differences(item, head[index], `${pointer}/${index}`, onRefAdded));
  }
  if (isObject(base) && isObject(head)) {
    const keys = new Set([...Object.keys(base), ...Object.keys(head)]);
    return [...keys].flatMap((key) => {
      if (!(key in base)) return [`${pointer}/${key}: added`];
      if (!(key in head)) return [`${pointer}/${key}: removed`];
      return differences(base[key], head[key], `${pointer}/${key}`, onRefAdded);
    });
  }
  return Object.is(base, head) ? [] : [`${pointer}: ${JSON.stringify(base)} became ${JSON.stringify(head)}`];
}

function git(...args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

test('every $ref to a scalar core document keeps only annotations beside it', () => {
  const documents = scalarDocuments();
  const violations = [];
  for (const file of listSchemaFiles()) {
    walk(readJson(file), '', (node, pointer) => {
      if (typeof node.$ref !== 'string' || !documents.has(node.$ref)) return;
      const kept = Object.keys(node).filter((key) => key !== '$ref' && !isAnnotation(key));
      if (kept.length > 0) violations.push(`${path.relative(SCHEMA_DIR, file)}#${pointer}: ${kept.join(', ')}`);
    });
  }
  assert.deepEqual(violations, [], 'draft-07 ignores these $ref siblings; compose with allOf to narrow');
});

test('every scalar core document has a title', () => {
  for (const [ref, doc] of scalarDocuments()) {
    assert.ok(doc.title, `${ref} has no title`);
    assert.equal(doc.$id, ref, `${ref} has the wrong $id`);
  }
});

const base = process.env.SCHEMA_EXTRACTION_BASE;

test('resolving every added $ref gives back the base document', { skip: base ? false : 'SCHEMA_EXTRACTION_BASE is not set' }, () => {
  const mergeBase = git('merge-base', base, 'HEAD').trim();
  const changed = git('diff', '--name-status', mergeBase, '--', RELATIVE_SCHEMA_DIR)
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split('\t'));
  let documents = 0;
  let refs = 0;
  const differing = [];
  const index = readJson(path.join(SCHEMA_DIR, 'index.json')).schemas;
  const registered = new Set(
    Object.values(index).flatMap((domain) => Object.values(domain.schemas || {})).map((entry) => entry.$ref),
  );
  for (const [status, file] of changed) {
    if (status === 'A') {
      const ref = `/schemas/${path.relative(RELATIVE_SCHEMA_DIR, file)}`;
      assert.ok(registered.has(ref), `${ref} is not registered in index.json`);
      continue;
    }
    // index.json is the registry of documents, so a new document changes it.
    if (file === path.join(RELATIVE_SCHEMA_DIR, 'index.json')) continue;
    assert.equal(status, 'M', `${file}: an extraction only modifies or adds documents`);
    const baseDoc = JSON.parse(git('show', `${mergeBase}:${file}`));
    const headDoc = readJson(path.join(ROOT, file));
    documents++;
    const found = differences(baseDoc, headDoc, '', () => { refs++; });
    if (found.length > 0) differing.push(`${file}\n  ${found.join('\n  ')}`);
  }
  console.log(`${documents} touched documents, ${refs} added $refs, ${differing.length} differing from ${mergeBase.slice(0, 10)}`);
  assert.deepEqual(differing, []);
});
