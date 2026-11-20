#!/usr/bin/env node
/**
 * `npm run build:schemas` fails when a root schema fails to bundle.
 *
 * Each case runs scripts/build-schemas.cjs in a temporary copy of the build
 * inputs, so the real dist/ is never touched. In the broken copy, two roots
 * each mark two distinct schemas with one `x-adcp-hoist` title, the fault
 * that #9123 hit. The build must keep going, list both, exit 1, and leave no
 * build stamp, so scripts/built-schemas.cjs rebuilds the tree next time.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const BUILD_SCRIPTS = ['build-schemas.cjs', 'mcp-schema-projection.cjs', 'built-schemas.cjs'];
const COLLISION_ROOTS = {
  'media-buy/get-products-request.json': 'FixtureProductsCollision',
  'creative/list-creatives-request.json': 'FixtureCreativesCollision',
};

const tempDirs = [];
test.after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

/** Copies the build inputs into a temporary repository root. */
function copyBuildInputs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-build-exit-'));
  tempDirs.push(root);
  fs.mkdirSync(path.join(root, 'scripts'));
  for (const script of BUILD_SCRIPTS) {
    fs.copyFileSync(path.join(REPO_ROOT, 'scripts', script), path.join(root, 'scripts', script));
  }
  fs.copyFileSync(path.join(REPO_ROOT, 'package.json'), path.join(root, 'package.json'));
  for (const dir of ['static/schemas/source', 'static/compliance/source']) {
    fs.cpSync(path.join(REPO_ROOT, dir), path.join(root, dir), { recursive: true });
  }
  fs.symlinkSync(path.join(REPO_ROOT, 'node_modules'), path.join(root, 'node_modules'), 'dir');
  return root;
}

function editSourceSchema(root, relativePath, edit) {
  const file = path.join(root, 'static/schemas/source', relativePath);
  const schema = JSON.parse(fs.readFileSync(file, 'utf8'));
  edit(schema);
  fs.writeFileSync(file, JSON.stringify(schema, null, 2));
}

/** Runs the build in `root`; resolves with its exit status and output. */
function runBuild(root) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.ADCP_SCHEMA_BUILD_LOCK_HELD;
    const child = spawn(process.execPath, [path.join(root, 'scripts', 'build-schemas.cjs')], {
      cwd: root,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.on('error', reject);
    child.on('close', status => resolve({ status, output }));
  });
}

const stampPath = root => path.join(root, 'dist/schemas/latest/.build-inputs.sha256');

// Start both builds at once; each test awaits its own.
const cleanRoot = copyBuildInputs();
const cleanBuild = runBuild(cleanRoot);

const brokenRoot = copyBuildInputs();
for (const [root, title] of Object.entries(COLLISION_ROOTS)) {
  editSourceSchema(brokenRoot, root, schema => {
    schema.properties.fixture_collision = {
      oneOf: [
        { 'x-adcp-hoist': true, title, type: 'string' },
        { 'x-adcp-hoist': true, title, type: 'integer' },
      ],
    };
  });
}
const brokenBuild = runBuild(brokenRoot);

test('a build where every root bundles exits 0', async () => {
  const { status, output } = await cleanBuild;
  assert.equal(status, 0, output);
  assert.doesNotMatch(output, /Failed to bundle|failed to build/);
  assert.ok(fs.existsSync(stampPath(cleanRoot)), 'a successful build records its inputs');
});

test('a build where roots fail to bundle lists every failure and exits 1', async () => {
  const { status, output } = await brokenBuild;
  assert.equal(status, 1, output);
  const summary = output.slice(output.indexOf('❌ Build failed:'));
  assert.match(summary, /2 bundled schema\(s\) failed to build/);
  for (const [root, title] of Object.entries(COLLISION_ROOTS)) {
    assert.ok(
      summary.includes(`dist/schemas/latest/bundled/${root}: x-adcp-hoist: two distinct schemas marked with title '${title}'`),
      summary);
  }
  // The other roots still bundle, and the failed tree is not stamped as built.
  assert.match(output, /Bundled \d+ schemas \(2 failed\)/);
  assert.ok(!fs.existsSync(stampPath(brokenRoot)), 'a failed build must not record its inputs');
});
