#!/usr/bin/env node
/**
 * `npm run build:schemas` fails when a root schema fails to bundle.
 *
 * Each case runs scripts/build-schemas.cjs with `--root` against a small
 * fixture tree in a temporary directory, so the real dist/ is never touched.
 * The fixture has two bundled roots and no tools. In the broken tree, each
 * root marks two distinct schemas with one `x-adcp-hoist` title, the fault
 * that #9123 hit. The build must keep going, list both roots, and exit 1.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  writeFixtureTree: writeTree, removeFixtureTrees, runBuild, readBundled,
} = require('./helpers/build-schemas-fixture.cjs');

const ROOTS = ['core/tasks-get-alpha-request.json', 'core/tasks-get-beta-request.json'];

test.after(removeFixtureTrees);

/**
 * Writes a fixture tree with the bundled roots. `marked(title)` gives the
 * two schemas each root marks with `x-adcp-hoist`.
 */
function writeFixtureTree(marked) {
  const schemas = {};
  for (const relativePath of ROOTS) {
    const title = `Fixture${path.basename(relativePath, '.json').replace(/\W/g, '')}`;
    const [first, second] = marked(title);
    schemas[relativePath] = {
      $schema: 'http://json-schema.org/draft-07/schema#',
      $id: `/schemas/${relativePath}`,
      type: 'object',
      properties: { first, second },
    };
  }
  return writeTree(schemas);
}

const marker = (title, type) => ({ 'x-adcp-hoist': true, title, type });

test('a build where every root bundles exits 0', async () => {
  // The same marked schema twice is one named type: it hoists cleanly.
  const root = writeFixtureTree(title => [marker(title, 'string'), marker(title, 'string')]);
  const { status, output } = await runBuild(root);
  assert.equal(status, 0, output);
  for (const relativePath of ROOTS) {
    const bundled = readBundled(root, relativePath);
    assert.deepEqual(bundled.properties.first, bundled.properties.second);
  }
});

test('a build where roots fail to bundle lists every failure and exits 1', async () => {
  // Two different schemas under one title cannot share a $defs name.
  const root = writeFixtureTree(title => [marker(title, 'string'), marker(title, 'integer')]);
  const { status, output } = await runBuild(root);
  assert.equal(status, 1, output);
  const summary = output.slice(output.indexOf('❌ Build failed:'));
  assert.match(summary, /2 bundled schema\(s\) failed to build/);
  for (const relativePath of ROOTS) {
    assert.ok(
      summary.includes(`dist/schemas/latest/bundled/${relativePath}: x-adcp-hoist: two distinct schemas marked with title`),
      summary);
  }
});
