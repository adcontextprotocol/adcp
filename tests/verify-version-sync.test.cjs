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

const fixtureDirs = [];

function makeFixture({ packageVersion, publishedVersion, adcpVersion }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-version-'));
  fixtureDirs.push(dir);
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

function run(fixtureDir, args = []) {
  // The script reads files via `path.join(__dirname, '../package.json')`, so
  // it has to live at `<fixture>/scripts/verify-version-sync.cjs` for the
  // fixture to be its root.
  const fixtureScriptDir = path.join(fixtureDir, 'scripts');
  fs.mkdirSync(fixtureScriptDir, { recursive: true });
  const scriptPath = path.join(fixtureScriptDir, 'verify-version-sync.cjs');
  fs.copyFileSync(SCRIPT, scriptPath);
  const result = spawnSync('node', [scriptPath, ...args], { encoding: 'utf8' });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

test.after(() => {
  for (const d of fixtureDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

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

test('compares numerically, not lexicographically (3.10.0 is ahead of 3.2.0)', () => {
  // String compare would order "3.10.0" < "3.2.0" because "1" < "2". A
  // future regression that swaps to localeCompare would silently flag this
  // as registry-behind. Pin the X.Y.Z numeric semantics.
  const dir = makeFixture({ packageVersion: '3.2.0', publishedVersion: '3.10.0', adcpVersion: '3.10.0' });
  const { code } = run(dir);
  assert.equal(code, 0);
});

test('handles 0.x versions correctly (0.9.0 ahead of 0.8.0)', () => {
  const dir = makeFixture({ packageVersion: '0.8.0', publishedVersion: '0.9.0', adcpVersion: '0.9.0' });
  const { code } = run(dir);
  assert.equal(code, 0);
});

test('flags asymmetric drift: published_version ahead but adcp_version behind', () => {
  // Half-bumped registry — should fail on the behind field, not silently
  // accept just because the disagreement check is below the behind check.
  const dir = makeFixture({ packageVersion: '3.0.4', publishedVersion: '3.0.4', adcpVersion: '3.0.3' });
  const { code, stderr } = run(dir);
  assert.equal(code, 1);
  assert.match(stderr, /adcp_version.*behind/);
});

test('strict mode: passes when registry exactly equals package.json (post-changeset-version state)', () => {
  const dir = makeFixture({ packageVersion: '3.0.4', publishedVersion: '3.0.4', adcpVersion: '3.0.4' });
  const { code, stdout } = run(dir, ['--strict']);
  assert.equal(code, 0);
  assert.match(stdout, /strict sync/);
});

test('strict mode: fails when registry is ahead of package.json (release-step bug)', () => {
  // The exact forward-merge state that the relaxed default mode permits.
  // After `changeset version` runs, the two MUST match — if they don't,
  // the release scripts ran out of order or one of them no-op'd.
  const dir = makeFixture({ packageVersion: '3.0.3', publishedVersion: '3.0.4', adcpVersion: '3.0.4' });
  const { code, stderr } = run(dir, ['--strict']);
  assert.equal(code, 1);
  assert.match(stderr, /\[strict\].*does not equal/);
});
