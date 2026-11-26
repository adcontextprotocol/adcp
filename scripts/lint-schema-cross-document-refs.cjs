#!/usr/bin/env node
/**
 * Keeps every `$ref` pointed at a whole document or at its own document.
 *
 * A shared definition is its own document. A `$ref` such as
 * `/schemas/core/x.json#/definitions/y` or `/schemas/core/x.json#/properties/z`
 * reaches into another document's internals, so that document can't
 * restructure its definitions or properties without breaking the referrer.
 * The lint fails on any `$ref` that names a document and a fragment. These
 * pass:
 *
 *   - a `$ref` to a whole document: `/schemas/core/x.json`;
 *   - a `$ref` to a fragment of its own document: `#/definitions/y`.
 *
 * Move the target into its own document and reference that document instead.
 * Values under `const`, `default`, `enum`, `example`, and `examples` are
 * instance data, so the lint doesn't read them. There is no allowlist.
 *
 *   node scripts/lint-schema-cross-document-refs.cjs [--dir <schemas source dir>]
 *
 * Exits 0 when no `$ref` points into another document and 1 otherwise.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_SCHEMAS_DIR = path.join(__dirname, '..', 'static', 'schemas', 'source');
const INSTANCE_KEYS = new Set(['const', 'default', 'enum', 'example', 'examples']);
const escapePointer = (segment) => String(segment).replace(/~/g, '~0').replace(/\//g, '~1');

function listJsonFiles(dir) {
  const files = [];
  (function walk(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.json')) files.push(full);
    }
  })(dir);
  return files.sort();
}

/** The `$ref`s in one schema whose fragment points into another document. */
function crossDocumentRefs(schema) {
  const found = [];
  (function walk(node, pointer) {
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${pointer}/${index}`));
      return;
    }
    if (!node || typeof node !== 'object') return;
    if (typeof node.$ref === 'string') {
      const hash = node.$ref.indexOf('#');
      if (hash > 0 && hash < node.$ref.length - 1) found.push({ pointer: pointer || '/', ref: node.$ref });
    }
    for (const [key, value] of Object.entries(node)) {
      if (!INSTANCE_KEYS.has(key)) walk(value, `${pointer}/${escapePointer(key)}`);
    }
  })(schema, '');
  return found;
}

function lint(schemasDir = DEFAULT_SCHEMAS_DIR) {
  const violations = [];
  for (const file of listJsonFiles(schemasDir)) {
    const relative = path.relative(schemasDir, file).split(path.sep).join('/');
    for (const { pointer, ref } of crossDocumentRefs(JSON.parse(fs.readFileSync(file, 'utf8')))) {
      violations.push(`${relative}#${pointer}: $ref "${ref}" points into another document. `
        + 'Move the target into its own document and reference the whole document.');
    }
  }
  return violations;
}

function main(argv) {
  const dirIndex = argv.indexOf('--dir');
  const schemasDir = dirIndex === -1 ? DEFAULT_SCHEMAS_DIR : path.resolve(argv[dirIndex + 1]);
  const violations = lint(schemasDir);
  if (violations.length === 0) {
    console.log('No $ref points into another document.');
    return 0;
  }
  console.error(`${violations.length} $ref(s) point into another document:`);
  for (const violation of violations) console.error(`  ${violation}`);
  return 1;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { crossDocumentRefs, lint };
