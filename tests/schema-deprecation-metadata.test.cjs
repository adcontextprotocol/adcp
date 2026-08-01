#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SOURCE_DIR = path.join(__dirname, '../static/schemas/source');

function findJsonFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return findJsonFiles(fullPath);
    return entry.name.endsWith('.json') ? [fullPath] : [];
  });
}

function walk(value, pointer, visit) {
  if (value === null || typeof value !== 'object') return;
  visit(value, pointer);
  for (const [key, child] of Object.entries(value)) {
    const escaped = key.replaceAll('~', '~0').replaceAll('/', '~1');
    walk(child, `${pointer}/${escaped}`, visit);
  }
}

function explicitlyDeclaresDeprecation(description) {
  return (
    /^(?:\*\*)?deprecated\b/i.test(description) ||
    /^legacy named-format\b/i.test(description) ||
    /^legacy shorthand\b/i.test(description) ||
    /^legacy alias\b/i.test(description) ||
    /^legacy or provider-specific\b/i.test(description) ||
    /^legacy\b[\s\S]*\b(?:is|are|both are) deprecated\b/i.test(description) ||
    /\. Deprecated(?:\s+in|\s*;|\s*—|\s*:)/i.test(description)
  );
}

test('explicitly deprecated schema nodes carry deprecated: true', () => {
  const missing = [];

  for (const file of findJsonFiles(SOURCE_DIR)) {
    const schema = JSON.parse(fs.readFileSync(file, 'utf8'));
    walk(schema, '', (node, pointer) => {
      // Example payloads are instance data, not schema nodes.
      if (pointer.includes('/examples/')) return;
      if (
        typeof node.description === 'string' &&
        explicitlyDeclaresDeprecation(node.description.trim()) &&
        node.deprecated !== true
      ) {
        missing.push(`${path.relative(SOURCE_DIR, file)}#${pointer || '/'}`);
      }
    });
  }

  assert.deepEqual(missing, [], `Missing deprecated: true annotations:\n${missing.join('\n')}`);
});

test('codegen-facing format-variant titles remain stable', () => {
  const expectations = [
    ['core/product.json', ['anyOf', 0, 'title'], 'v1 Product (named-format reference)'],
    ['core/product.json', ['anyOf', 1, 'title'], 'v2 Product (inline format declarations)'],
    ['core/creative-asset.json', ['oneOf', 0, 'title'], 'v1 creative (named-format reference)'],
    ['core/creative-asset.json', ['oneOf', 1, 'title'], 'v2 creative (canonical format kind)'],
    ['core/creative-manifest.json', ['oneOf', 0, 'title'], 'v1 manifest (named-format reference)'],
    ['core/creative-manifest.json', ['oneOf', 1, 'title'], 'v2 manifest (canonical format kind)'],
    ['creative/list-creatives-response.json', ['properties', 'creatives', 'items', 'oneOf', 0, 'title'], 'Listed creative (named-format reference)'],
    ['creative/list-creatives-response.json', ['properties', 'creatives', 'items', 'oneOf', 1, 'title'], 'Listed creative (canonical format kind)'],
  ];

  for (const [relativePath, segments, expected] of expectations) {
    let value = JSON.parse(fs.readFileSync(path.join(SOURCE_DIR, relativePath), 'utf8'));
    for (const segment of segments) value = value[segment];
    assert.equal(value, expected, `${relativePath}#/${segments.join('/')}`);
  }
});

test('lifecycle status is metadata, not part of generated type names', () => {
  const offenders = [];

  for (const file of findJsonFiles(SOURCE_DIR)) {
    const schema = JSON.parse(fs.readFileSync(file, 'utf8'));
    walk(schema, '', (node, pointer) => {
      if (typeof node.title === 'string' && /(?:deprecated|legacy)/i.test(node.title)) {
        offenders.push(`${path.relative(SOURCE_DIR, file)}#${pointer || '/'}: ${node.title}`);
      }
    });
  }

  assert.deepEqual(offenders, [], `Lifecycle markers belong in metadata, not titles:\n${offenders.join('\n')}`);
});

test('format_ids is a deprecated 3.x-only field everywhere', () => {
  const offenders = [];

  for (const file of findJsonFiles(SOURCE_DIR)) {
    const schema = JSON.parse(fs.readFileSync(file, 'utf8'));
    walk(schema, '', (node, pointer) => {
      if (pointer.includes('/examples/')) return;
      const formatIds = node.properties?.format_ids;
      if (formatIds === null || typeof formatIds !== 'object') return;

      if (formatIds.deprecated !== true || !/removed in AdCP 4\.0/i.test(formatIds.description || '')) {
        offenders.push(`${path.relative(SOURCE_DIR, file)}#${pointer || '/'}/properties/format_ids`);
      }
    });
  }

  assert.deepEqual(
    offenders,
    [],
    `Every format_ids field must be deprecated and scheduled for 4.0 removal:\n${offenders.join('\n')}`,
  );
});
