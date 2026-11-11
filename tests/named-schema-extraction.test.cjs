#!/usr/bin/env node
/**
 * Extracting a repeated scalar subschema into a named schema must not change
 * what any schema accepts (#8525).
 *
 * The structural tests always run. Every `$ref` to a scalar document keeps only
 * annotations beside it, because draft-07 ignores `$ref` siblings, so a kept
 * `pattern` or `maxLength` would silently stop validating for some consumers.
 * Every scalar document under core/ and enums/ has a title, which is what names
 * the generated type.
 *
 * The proof runs when SCHEMA_EXTRACTION_BASE names a git ref, as
 * `npm run test:schema-extraction` does. For each schema document changed since
 * the merge base, it resolves every `$ref` the branch adds, to another document
 * or to a definition in the same document, overlays the siblings the site
 * keeps, and requires the whole document to equal the base's. A definition the
 * branch adds counts only as the target of an added `$ref`. The target's title
 * and description name the schema, so they don't count; every other target key
 * does, including annotations such as `x-entity`.
 *
 * Before comparing, both sides are put in a canonical form that changes nothing
 * a validator accepts: enum values compare as a set, a `type` that every enum
 * value already has is dropped, `type: "string"` under `propertyNames` is
 * dropped because a property name is always a string, and equivalent pattern
 * spellings compare equal (see normalizePattern in
 * scripts/lint-schema-named-constraints.cjs).
 *
 * Two exceptions are listed below by name, each with its reason, and both are
 * printed: annotations a site adopts from a named schema whose only difference
 * was annotations, and enum sites the branch widens on purpose. Any other
 * difference fails, so the proof only applies to extraction-only branches. It
 * also requires each added document to be registered in index.json.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { normalizePattern } = require('../scripts/lint-schema-named-constraints.cjs');

const ROOT = path.resolve(__dirname, '..');
const RELATIVE_SCHEMA_DIR = path.join('static', 'schemas', 'source');
const SCHEMA_DIR = path.join(ROOT, RELATIVE_SCHEMA_DIR);
const SCALAR_TYPES = new Set(['string', 'number', 'integer']);
const DOCUMENT_METADATA = new Set(['$schema', '$id', 'title', 'description']);
const ANNOTATIONS = new Set([
  'description', 'title', '$comment', 'examples', 'default', 'deprecated', 'readOnly', 'writeOnly',
  'enumDescriptions', 'enumMetadata',
]);
const isAnnotation = (key) => ANNOTATIONS.has(key) || key.startsWith('x-');

/**
 * Named schemas whose only difference from the sites that now reference them
 * was annotations. A site that references one gains its annotations.
 */
const ANNOTATION_ADOPTIONS = new Map([
  ['/schemas/core/brand-id.json', 'adds x-entity, examples, and x-max-length-4.0 to brand IDs that lacked them'],
  ['/schemas/enums/account-status.json', 'adds the enumDescriptions of each account status'],
  ['/schemas/enums/outcome-target-cost-strength.json', 'adds the enumDescriptions of cap and target'],
  ['/schemas/enums/pricing-model.json', 'adds the enumDescriptions of each pricing model'],
  ['/schemas/enums/delivery-recipient-cloud.json', 'adds x-status experimental to sites in documents that are already experimental'],
  ['/schemas/enums/offer-reason.json', 'adds x-status and x-added-in to a site in a document with the same status'],
  ['/schemas/core/placement-id.json', 'adds x-entity placement to placement ID lists that lacked it'],
]);

/** Enum sites the branch widens on purpose: narrower copies of one concept that had drifted. */
const EXPECTED_WIDENINGS = new Map([
  ['brand.json#/definitions/property/properties/store', 'adds fire_tv and vizio, which the other app store sites accept'],
  ['formats/canonical/native_in_feed.json#/properties/asset_source', 'adds publisher_host_recorded, which every other canonical format accepts'],
]);

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
const isObject = (value) => value && typeof value === 'object' && !Array.isArray(value);
const at = (root, pointer) => pointer.split('/').slice(1)
  .reduce((node, raw) => node?.[raw.replace(/~1/g, '/').replace(/~0/g, '~')], root);

const isScalarDocument = (doc) => SCALAR_TYPES.has(doc.type)
  || (doc.type === undefined && (typeof doc.pattern === 'string' || Array.isArray(doc.enum)));

function scalarDocuments() {
  const documents = new Map();
  for (const dir of ['core', 'enums']) {
    for (const file of listSchemaFiles(path.join(SCHEMA_DIR, dir))) {
      const doc = readJson(file);
      if (isScalarDocument(doc)) documents.set(`/schemas/${path.relative(SCHEMA_DIR, file)}`, doc);
    }
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

const VALUE_TYPE = (value) => {
  if (typeof value === 'string') return 'string';
  if (Number.isInteger(value)) return 'integer';
  return typeof value === 'number' ? 'number' : null;
};

/** The canonical form described above. It never changes what a node accepts. */
function canonical(node, isKey) {
  if (!isObject(node)) return node;
  const out = { ...node };
  if (Array.isArray(out.enum)) {
    out.enum = [...out.enum].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    const types = new Set(out.enum.map(VALUE_TYPE));
    if (typeof out.type === 'string' && types.size === 1 && (out.type === [...types][0] || (out.type === 'number' && types.has('integer')))) {
      delete out.type;
    }
  }
  if (isKey && out.type === 'string') delete out.type;
  if (typeof out.pattern === 'string') out.pattern = normalizePattern(out.pattern);
  return out;
}

const KEY_CONTEXT = new Set(['propertyNames']);

/** Differences between two JSON values, ignoring object key order. */
function differences(base, head, pointer, ctx) {
  if (isObject(head) && typeof head.$ref === 'string' && (!isObject(base) || base.$ref !== head.$ref)) {
    let target;
    if (head.$ref.startsWith('#')) {
      target = at(ctx.headRoot, head.$ref.slice(1));
      ctx.localTargets.add(head.$ref.slice(1));
    } else {
      target = readJson(refToFile(head.$ref));
    }
    const resolved = {};
    for (const [key, value] of Object.entries(target)) if (!DOCUMENT_METADATA.has(key)) resolved[key] = value;
    for (const [key, value] of Object.entries(head)) if (key !== '$ref') resolved[key] = value;
    ctx.onRefAdded(head.$ref);
    const adopting = ANNOTATION_ADOPTIONS.has(head.$ref);
    return differences(base, resolved, pointer, { ...ctx, adopting: adopting || ctx.adopting });
  }
  if (Array.isArray(base) && Array.isArray(head)) {
    if (base.length !== head.length) return [{ pointer, text: `array length ${base.length} became ${head.length}` }];
    return base.flatMap((item, index) => differences(item, head[index], `${pointer}/${index}`, ctx));
  }
  if (isObject(base) && isObject(head)) {
    const b = canonical(base, ctx.isKey);
    const h = canonical(head, ctx.isKey);
    const widening = EXPECTED_WIDENINGS.get(`${ctx.file}#${pointer}`);
    if (widening && Array.isArray(b.enum) && Array.isArray(h.enum)
      && b.enum.every((value) => h.enum.includes(value)) && h.enum.length > b.enum.length) {
      ctx.widened.push(`${ctx.file}#${pointer}: ${widening}`);
      b.enum = h.enum;
    }
    const keys = new Set([...Object.keys(b), ...Object.keys(h)]);
    return [...keys].flatMap((key) => {
      const child = `${pointer}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`;
      if (!(key in b)) {
        if (ctx.adopting && isAnnotation(key)) {
          ctx.adopted.push(`${ctx.file}#${child}`);
          return [];
        }
        return [{ pointer: child, added: true, text: 'added' }];
      }
      if (!(key in h)) return [{ pointer: child, text: 'removed' }];
      return differences(b[key], h[key], child, { ...ctx, isKey: KEY_CONTEXT.has(key) || (ctx.isKey && /^(anyOf|oneOf|allOf)$/.test(key)) });
    });
  }
  return Object.is(base, head) ? [] : [{ pointer, text: `${JSON.stringify(base)} became ${JSON.stringify(head)}` }];
}

/** True when an added member is a definition that only added $refs point to. */
function isAddedDefinition(found, headDoc, localTargets) {
  if (!found.added) return false;
  if (localTargets.has(found.pointer)) return true;
  if (!/\/(definitions|\$defs)$/.test(found.pointer)) return false;
  const block = at(headDoc, found.pointer);
  return isObject(block) && Object.keys(block).every((name) => localTargets.has(`${found.pointer}/${name.replace(/~/g, '~0').replace(/\//g, '~1')}`));
}

function git(...args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

test('every $ref to a scalar core or enums document keeps only annotations beside it', () => {
  const documents = scalarDocuments();
  const violations = [];
  for (const file of listSchemaFiles()) {
    const doc = readJson(file);
    walk(doc, '', (node, pointer) => {
      if (typeof node.$ref !== 'string') return;
      const local = node.$ref.startsWith('#') ? at(doc, node.$ref.slice(1)) : null;
      if (!documents.has(node.$ref) && !(local && isScalarDocument(local))) return;
      const kept = Object.keys(node).filter((key) => key !== '$ref' && !isAnnotation(key));
      if (kept.length > 0) violations.push(`${path.relative(SCHEMA_DIR, file)}#${pointer}: ${kept.join(', ')}`);
    });
  }
  assert.deepEqual(violations, [], 'draft-07 ignores these $ref siblings; compose with allOf to narrow');
});

test('every scalar core and enums document has a title', () => {
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
  const adopted = [];
  const widened = [];
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
    const ctx = {
      file: path.relative(RELATIVE_SCHEMA_DIR, file).split(path.sep).join('/'),
      headRoot: headDoc,
      localTargets: new Set(),
      onRefAdded: () => { refs++; },
      adopted,
      widened,
      adopting: false,
      isKey: false,
    };
    const found = differences(baseDoc, headDoc, '', ctx)
      .filter((item) => !isAddedDefinition(item, headDoc, ctx.localTargets));
    if (found.length > 0) differing.push(`${file}\n  ${found.map((item) => `${item.pointer}: ${item.text}`).join('\n  ')}`);
  }
  console.log(`${documents} touched documents, ${refs} added $refs, ${differing.length} differing from ${mergeBase.slice(0, 10)}`);
  console.log(`${adopted.length} annotations adopted from named schemas that differed only in annotations; ${widened.length} enum sites widened on purpose:`);
  for (const line of widened) console.log(`  ${line}`);
  assert.deepEqual(differing, []);
});
