#!/usr/bin/env node
/**
 * `dist/schemas/latest/extensions/` publishes under `/schemas/latest/`.
 *
 * The build filters extensions by the release in package.json, and it used to
 * stamp that release into the `latest/` copies too. `extension-meta.json` then
 * referenced `/schemas/<release>/core/...`, a directory that exists only after
 * a release build, so the reference did not resolve.
 *
 * Each case runs scripts/build-schemas.cjs with `--root` against a small
 * fixture tree in a temporary directory, so the real dist/ is never touched.
 * The fixture has one extension valid for the release and one retired before
 * it, so the filter still has to use the release version.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const BUILD_SCRIPT = path.join(__dirname, '..', 'scripts', 'build-schemas.cjs');
const RELEASE = '3.3.0-rc.2';
const ORIGIN = 'https://adcontextprotocol.org/schemas/';

const tempDirs = [];
test.after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function extension(namespace, fields) {
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: `/schemas/extensions/${namespace}.json`,
    title: namespace,
    description: `The ${namespace} fixture extension.`,
    type: 'object',
    ...fields,
  };
}

/** Writes the smallest source the build accepts, plus an extensions tree. */
function writeFixtureTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-build-latest-ext-'));
  tempDirs.push(root);
  const source = path.join(root, 'static/schemas/source');
  writeJson(path.join(root, 'package.json'), { version: RELEASE });
  writeJson(path.join(source, 'index.json'), {});
  writeJson(path.join(source, 'manifest.schema.json'), {});
  writeJson(path.join(source, 'enums/task-type.json'), { enum: [] });
  writeJson(path.join(source, 'enums/error-code.json'), {
    enum: ['FIXTURE_ERROR'],
    enumMetadata: { FIXTURE_ERROR: { recovery: 'terminal', suggestion: 'Fix the fixture.' } },
    enumDescriptions: { FIXTURE_ERROR: 'A fixture error. Recovery: terminal.' },
  });
  writeJson(path.join(source, 'core/adcp-minor-version.json'), {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: '/schemas/core/adcp-minor-version.json',
    type: 'string',
    pattern: '^\\d+\\.\\d+$',
  });
  writeJson(path.join(source, 'core/fixture-color.json'), {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: '/schemas/core/fixture-color.json',
    type: 'string',
  });
  writeJson(path.join(source, 'extensions/extension-meta.json'), {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: '/schemas/extensions/extension-meta.json',
    type: 'object',
    properties: {
      valid_from: { $ref: '/schemas/core/adcp-minor-version.json' },
      valid_until: { $ref: '/schemas/core/adcp-minor-version.json' },
    },
  });
  writeJson(path.join(source, 'extensions/index.json'), {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: '/schemas/extensions/index.json',
  });
  writeJson(path.join(source, 'extensions/current_vendor.json'), extension('current_vendor', {
    valid_from: '3.3',
    properties: { color: { $ref: '/schemas/core/fixture-color.json' } },
  }));
  writeJson(path.join(source, 'extensions/retired_vendor.json'), extension('retired_vendor', {
    valid_from: '3.0',
    valid_until: '3.2',
    properties: {},
  }));
  return root;
}

/** Runs the build against `root`; resolves with its exit status and output. */
function runBuild(root, extraArgs = []) {
  return new Promise((resolve, reject) => {
    // A release build runs `git add` in the tree it builds; the ceiling keeps
    // git from finding a repository above the temporary fixture.
    const child = spawn(process.execPath, [BUILD_SCRIPT, '--root', root, ...extraArgs], {
      env: { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(root) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.on('error', reject);
    child.on('close', status => resolve({ status, output }));
  });
}

/** Every `$id` and `$ref` in the JSON files of `dir`, as `file: key=value`. */
function uris(dir) {
  const found = [];
  for (const name of fs.readdirSync(dir).filter(n => n.endsWith('.json')).sort()) {
    const visit = node => {
      if (!node || typeof node !== 'object') return;
      for (const [key, value] of Object.entries(node)) {
        if ((key === '$id' || key === '$ref') && typeof value === 'string') found.push({ name, key, value });
        else visit(value);
      }
    };
    visit(JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')));
  }
  return found;
}

/**
 * Asserts that every `$id` and `$ref` under `<dist>/<segment>/extensions/`
 * uses `/schemas/<segment>/` and that every `$ref` names a built file.
 */
function assertExtensionUris(root, segment) {
  const dist = path.join(root, 'dist/schemas');
  const dir = path.join(dist, segment, 'extensions');
  assert.deepEqual(
    fs.readdirSync(dir).sort(),
    ['current_vendor.json', 'extension-meta.json', 'index.json'],
    'the build filters extensions by the release version');
  const found = uris(dir);
  assert.ok(found.some(u => u.name === 'extension-meta.json' && u.key === '$ref'), 'the fixture exercises a meta-schema $ref');
  const wrongSegment = found.filter(u => !u.value.startsWith(`${ORIGIN}${segment}/`));
  assert.deepEqual(wrongSegment, [], `every URI under ${segment}/extensions/ uses /schemas/${segment}/`);
  const unresolved = found
    .filter(u => u.key === '$ref')
    .filter(u => !fs.existsSync(path.join(dist, u.value.slice(ORIGIN.length).split('#', 1)[0])));
  assert.deepEqual(unresolved, [], 'every $ref resolves to a built file');
}

test('a development build publishes latest/extensions/ under /schemas/latest/', async () => {
  const root = writeFixtureTree();
  const { status, output } = await runBuild(root);
  assert.equal(status, 0, output);
  assertExtensionUris(root, 'latest');
});

test('a release build publishes latest/extensions/ under /schemas/latest/ and the release under its version', async () => {
  const root = writeFixtureTree();
  const { status, output } = await runBuild(root, ['--release']);
  assert.equal(status, 0, output);
  assertExtensionUris(root, 'latest');
  assertExtensionUris(root, RELEASE);
});
