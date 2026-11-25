'use strict';

/**
 * Runs scripts/build-schemas.cjs with `--root` against a small fixture tree
 * in a temporary directory, so the real dist/ is never touched.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const BUILD_SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'build-schemas.cjs');

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

/**
 * Writes a repository tree with the smallest source the build accepts (a
 * registry, the extension registry placeholder, one error code, no task
 * types, a permissive manifest schema) plus `schemas`, a map from
 * source-relative path to schema. Returns the tree's root;
 * `removeFixtureTrees` deletes every tree written.
 */
const fixtureTrees = [];
function writeFixtureTree(schemas) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-build-fixture-'));
  fixtureTrees.push(root);
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
  for (const [relativePath, schema] of Object.entries(schemas)) {
    writeJson(path.join(source, relativePath), schema);
  }
  return root;
}

function removeFixtureTrees() {
  for (const dir of fixtureTrees.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
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

/** Reads a bundled root the build wrote under `root`. */
function readBundled(root, relativePath) {
  return JSON.parse(fs.readFileSync(
    path.join(root, 'dist/schemas/latest/bundled', relativePath), 'utf8'));
}

module.exports = { writeFixtureTree, removeFixtureTrees, runBuild, readBundled };
