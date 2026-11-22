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
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const BUILD_SCRIPT = path.join(__dirname, '..', 'scripts', 'build-schemas.cjs');
const ROOTS = ['core/tasks-get-alpha-request.json', 'core/tasks-get-beta-request.json'];

const tempDirs = [];
test.after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

/**
 * Writes a repository tree with the smallest source the build accepts: a
 * registry, the extension registry placeholder, one error code, no task types,
 * a permissive manifest schema, and the bundled roots. `marked(title)` gives the two schemas each root marks
 * with `x-adcp-hoist`.
 */
function writeFixtureTree(marked) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-build-exit-'));
  tempDirs.push(root);
  const source = path.join(root, 'static/schemas/source');
  writeJson(path.join(root, 'package.json'), { version: '0.0.0' });
  writeJson(path.join(source, 'index.json'), {});
  writeJson(path.join(source, 'manifest.schema.json'), {});
  writeJson(path.join(source, 'extensions/index.json'), {});
  writeJson(path.join(source, 'enums/task-type.json'), { enum: [] });
  writeJson(path.join(source, 'enums/error-code.json'), {
    enum: ['FIXTURE_ERROR'],
    enumMetadata: { FIXTURE_ERROR: { recovery: 'terminal', suggestion: 'Fix the fixture.' } },
    enumDescriptions: { FIXTURE_ERROR: 'A fixture error. Recovery: terminal.' },
  });
  for (const relativePath of ROOTS) {
    const title = `Fixture${path.basename(relativePath, '.json').replace(/\W/g, '')}`;
    const [first, second] = marked(title);
    writeJson(path.join(source, relativePath), {
      $schema: 'http://json-schema.org/draft-07/schema#',
      $id: `/schemas/${relativePath}`,
      type: 'object',
      properties: { first, second },
    });
  }
  return root;
}

/** Runs the build against `root`; resolves with its exit status and output. */
function runBuild(root) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BUILD_SCRIPT, '--root', root], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.on('error', reject);
    child.on('close', status => resolve({ status, output }));
  });
}

const marker = (title, type) => ({ 'x-adcp-hoist': true, title, type });

test('a build where every root bundles exits 0', async () => {
  // The same marked schema twice is one named type: it hoists cleanly.
  const root = writeFixtureTree(title => [marker(title, 'string'), marker(title, 'string')]);
  const { status, output } = await runBuild(root);
  assert.equal(status, 0, output);
  for (const relativePath of ROOTS) {
    const bundled = JSON.parse(
      fs.readFileSync(path.join(root, 'dist/schemas/latest/bundled', relativePath), 'utf8'));
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
