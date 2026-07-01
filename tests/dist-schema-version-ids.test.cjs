#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const DIST_SCHEMAS_DIR = path.join(__dirname, '../dist/schemas');

function walkJsonFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkJsonFiles(full, out);
    else if (entry.isFile() && entry.name.endsWith('.json')) out.push(full);
  }
  return out;
}

function collectVersionedSchemaIdRefFailures() {
  const pattern = String.raw`"\$(id|ref)"\s*:\s*"/schemas/[^/]+/[^"]*"`;
  try {
    const output = execFileSync('rg', ['--no-heading', '-n', pattern, DIST_SCHEMAS_DIR], {
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
    });
    return String(output)
      .trim()
      .split('\n')
      .filter(Boolean)
      .flatMap(line => {
        const pathMatch = line.match(/^(.*?dist[\\/]schemas[\\/]([^\\/]+)[\\/].*?):/);
        if (!pathMatch) return [];
        const [, file, version] = pathMatch;
        if (version === 'latest') return [];

        const valueMatch = line.match(/"\$(?:id|ref)"\s*:\s*"\/schemas\/([^/]+)\/[^"]*"/);
        if (!valueMatch) return [];
        const actualVersion = valueMatch[1];
        return actualVersion === version
          ? []
          : [`${path.relative(path.join(__dirname, '..'), file)}: ${valueMatch[0]}`];
      });
  } catch (error) {
    if (error.status === 1) return [];
    if (error.code !== 'ENOENT') throw error;
  }

  const failures = [];
  for (const version of fs.readdirSync(DIST_SCHEMAS_DIR)) {
    if (version === 'latest') continue;
    const versionDir = path.join(DIST_SCHEMAS_DIR, version);
    if (!fs.statSync(versionDir).isDirectory()) continue;
    for (const file of walkJsonFiles(versionDir)) {
      const content = fs.readFileSync(file, 'utf8');
      for (const match of content.matchAll(/"\$(?:id|ref)"\s*:\s*"\/schemas\/([^/]+)\/[^"]*"/g)) {
        const [, actualVersion] = match;
        if (actualVersion !== version) {
          failures.push(`${path.relative(path.join(__dirname, '..'), file)}: ${match[0]}`);
        }
      }
    }
  }
  return failures;
}

test('dist schema roots do not contain unversioned AdCP $id/$ref values', () => {
  assert.deepEqual(collectVersionedSchemaIdRefFailures(), []);
});

test('dist schema root discovery marks prereleases but points canonical aliases at stable releases', () => {
  const discovery = JSON.parse(fs.readFileSync(path.join(DIST_SCHEMAS_DIR, 'index.json'), 'utf8'));
  const latest = JSON.parse(fs.readFileSync(path.join(DIST_SCHEMAS_DIR, 'latest.json'), 'utf8'));
  const stableVersion = /^\d+\.\d+\.\d+$/;

  assert.match(discovery.latest_stable, stableVersion);
  assert.equal(discovery.latest, discovery.latest_stable);
  assert.equal(latest.latest_stable, discovery.latest_stable);
  assert.equal(latest.channel, 'stable');

  for (const [alias, version] of Object.entries(discovery.aliases)) {
    assert.match(alias, /^v\d+(?:\.\d+)?$/);
    assert.match(version, stableVersion, `${alias} must not point at a prerelease`);
  }

  assert.ok(discovery.versions.some((entry) => entry.prerelease === true), 'historical prerelease dirs should remain discoverable');
  const stableVersions = new Set(discovery.versions
    .filter((entry) => stableVersion.test(entry.version))
    .map((entry) => entry.version));
  for (const entry of discovery.versions) {
    if (stableVersion.test(entry.version)) {
      assert.equal(entry.stability, 'stable');
      assert.equal(entry.prerelease, false);
    } else {
      assert.match(entry.version, /^\d+\.\d+\.\d+-[0-9A-Za-z.-]+$/);
      assert.notEqual(entry.stability, 'stable');
      assert.equal(entry.prerelease, true);
      const finalVersion = entry.version.split('-')[0];
      if (stableVersions.has(finalVersion)) {
        assert.equal(entry.deprecated, true, `${entry.version} should be marked deprecated after ${finalVersion}`);
        assert.equal(entry.superseded_by, finalVersion, `${entry.version} should point at the stable superseding release`);
      }
    }
  }
});
