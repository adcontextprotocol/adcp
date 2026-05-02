#!/usr/bin/env node
/**
 * Unit tests for scripts/verify-version-sync.cjs — the pre-push hook that
 * reconciles package.json against the schema registry.
 *
 * The bug these tests prevent is the May 2026 deadlock: the original strict-
 * equality check broke push for every contributor whenever main was in the
 * forward-merge window (registry advanced to a just-cut version, package.json
 * still on the next dev). The hook now allows registry to be at or ahead of
 * package.json but still fails the genuine bug-modes (registry behind, fields
 * missing, the two registry fields disagreeing).
 *
 * The script reads package.json + static/schemas/source/index.json directly,
 * so we drive it by writing a temp tree and running it as a subprocess.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'verify-version-sync.cjs');

function makeFixture({ packageVersion, publishedVersion, adcpVersion }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-version-'));
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'fixture', version: packageVersion }),
  );
  const registryDir = path.join(dir, 'static', 'schemas', 'source');
  fs.mkdirSync(registryDir, { recursive: true });
  const registry = {};
  if (publishedVersion !== undefined) registry.published_version = publishedVersion;
  if (adcpVersion !== undefined) registry.adcp_version = adcpVersion;
  fs.writeFileSync(path.join(registryDir, 'index.json'), JSON.stringify(registry));
  return dir;
}

function run(fixtureDir) {
  // The script reads files relative to its own location via __dirname/'..'.
  // Copy it into the fixture so the temp tree is its working root.
  const scriptInFixture = path.join(fixtureDir, 'verify-version-sync.cjs');
  fs.mkdirSync(path.dirname(scriptInFixture), { recursive: true });
  fs.copyFileSync(SCRIPT, scriptInFixture);
  const fixtureScriptDir = path.join(fixtureDir, 'scripts');
  fs.mkdirSync(fixtureScriptDir, { recursive: true });
  fs.copyFileSync(SCRIPT, path.join(fixtureScriptDir, 'verify-version-sync.cjs'));
  const result = spawnSync('node', [path.join(fixtureScriptDir, 'verify-version-sync.cjs')], {
    encoding: 'utf8',
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

test('passes when registry equals package.json (release-time steady state)', () => {
  const dir = makeFixture({ packageVersion: '3.0.4', publishedVersion: '3.0.4', adcpVersion: '3.0.4' });
  const { code } = run(dir);
  assert.equal(code, 0);
});

test('passes when registry is ahead of package.json (forward-merge window — was a false-fail before)', () => {
  // The exact May 2026 state that broke pre-push for everyone: package.json
  // stays at the dev version while registry was bumped to the cut version.
  const dir = makeFixture({ packageVersion: '3.0.3', publishedVersion: '3.0.4', adcpVersion: '3.0.4' });
  const { code } = run(dir);
  assert.equal(code, 0);
});

test('fails when registry is behind package.json (the genuine bug)', () => {
  // package.json was bumped for a release but the registry never caught up.
  const dir = makeFixture({ packageVersion: '3.1.0', publishedVersion: '3.0.4', adcpVersion: '3.0.4' });
  const { code, stderr } = run(dir);
  assert.equal(code, 1);
  assert.match(stderr, /behind package\.json/);
});

test('fails when published_version is missing entirely', () => {
  const dir = makeFixture({ packageVersion: '3.0.4', adcpVersion: '3.0.4' });
  const { code, stderr } = run(dir);
  assert.equal(code, 1);
  assert.match(stderr, /missing `published_version`/);
});

test('fails when adcp_version is missing entirely', () => {
  const dir = makeFixture({ packageVersion: '3.0.4', publishedVersion: '3.0.4' });
  const { code, stderr } = run(dir);
  assert.equal(code, 1);
  assert.match(stderr, /missing `adcp_version`/);
});

test('fails when published_version and adcp_version disagree (hand-edit drift)', () => {
  const dir = makeFixture({ packageVersion: '3.0.3', publishedVersion: '3.0.5', adcpVersion: '3.0.4' });
  const { code, stderr } = run(dir);
  assert.equal(code, 1);
  assert.match(stderr, /disagree/);
});

test('passes for pre-release tags that match exactly', () => {
  // Pre-release suffixes don't parse cleanly as X.Y.Z so the script falls back
  // to strict equality. As long as both sides have the same tag, we accept.
  const dir = makeFixture({
    packageVersion: '3.1.0-beta.0',
    publishedVersion: '3.1.0-beta.0',
    adcpVersion: '3.1.0-beta.0',
  });
  const { code } = run(dir);
  assert.equal(code, 0);
});

test('fails for pre-release tags that do not match (conservative fallback)', () => {
  const dir = makeFixture({
    packageVersion: '3.1.0-beta.0',
    publishedVersion: '3.1.0-beta.1',
    adcpVersion: '3.1.0-beta.1',
  });
  const { code } = run(dir);
  assert.equal(code, 1);
});
