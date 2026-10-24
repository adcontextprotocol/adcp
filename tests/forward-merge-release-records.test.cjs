#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { mergeChangelog, mergePublishedVersions } = require('../scripts/forward-merge-release-records.cjs');

const repoRoot = path.resolve(__dirname, '..');

function changelog(...versions) {
  return ['# adcontextprotocol', '', ...versions.flatMap((v) => [`## ${v}`, '', `- notes for ${v}`, ''])].join('\n');
}

test('inserts the maintenance release below main prerelease sections, not above them', () => {
  const ours = changelog('3.3.0-beta.0', '3.2.5', '3.2.4');
  const theirs = changelog('3.2.6', '3.2.5', '3.2.4');
  assert.equal(mergeChangelog(ours, theirs), changelog('3.3.0-beta.0', '3.2.6', '3.2.5', '3.2.4'));
});

test('inserts several missing releases in semver order and keeps main text for shared ones', () => {
  const ours = changelog('3.3.0-beta.1', '3.3.0-beta.0', '3.2.5');
  const theirs = changelog('3.2.7', '3.2.6', '3.2.5').replace('- notes for 3.2.5', '- edited on 3.2.x');
  const merged = mergeChangelog(ours, theirs);
  assert.equal(merged, changelog('3.3.0-beta.1', '3.3.0-beta.0', '3.2.7', '3.2.6', '3.2.5'));
});

test('is a no-op when main already has every maintenance release', () => {
  const ours = changelog('3.3.0-beta.0', '3.2.6', '3.2.5');
  assert.equal(mergeChangelog(ours, changelog('3.2.6', '3.2.5')), ours);
});

test('places an older line correctly between two newer lines', () => {
  const ours = changelog('3.3.0-beta.0', '3.2.6', '3.1.29');
  assert.equal(
    mergeChangelog(ours, changelog('3.1.30', '3.1.29')),
    changelog('3.3.0-beta.0', '3.2.6', '3.1.30', '3.1.29'),
  );
});

test('fails loudly on a non-semver release heading', () => {
  assert.throws(() => mergeChangelog(changelog('3.2.5'), changelog('3.2.6').replace('## 3.2.6', '## Unreleased')), /not a semver release/);
});

function manifest(published, packageOnly = []) {
  return {
    schema_version: 1,
    npm_tags: ['latest'],
    published_versions: published,
    package_only_versions: packageOnly,
  };
}

test('unions published versions and requires each new bundle in the merged tree', () => {
  const merged = mergePublishedVersions(
    manifest(['3.0.28', '3.2.5', '3.3.0-beta.0']),
    manifest(['3.2.5', '3.2.6']),
    (version) => version === '3.2.6',
  );
  assert.deepEqual(merged.published_versions, ['3.0.28', '3.2.5', '3.2.6', '3.3.0-beta.0']);
});

test('promotes a package-only version the maintenance line registered', () => {
  const merged = mergePublishedVersions(manifest(['3.2.5'], ['3.2.6']), manifest(['3.2.6']), () => true);
  assert.deepEqual(merged.published_versions, ['3.2.5', '3.2.6']);
  assert.deepEqual(merged.package_only_versions, []);
});

test('carries over package-only versions the maintenance line added', () => {
  const merged = mergePublishedVersions(
    manifest(['3.2.5'], ['3.0.24']),
    manifest(['3.2.5'], ['3.2.0', '3.2.7']),
    () => true,
  );
  assert.deepEqual(merged.published_versions, ['3.2.5']);
  assert.deepEqual(merged.package_only_versions, ['3.0.24', '3.2.0', '3.2.7']);
});

test('a version main already publishes stays published even if the maintenance line lists it as package-only', () => {
  const merged = mergePublishedVersions(manifest(['3.2.6']), manifest(['3.2.5'], ['3.2.6']), () => true);
  assert.deepEqual(merged.package_only_versions, []);
  assert.ok(merged.published_versions.includes('3.2.6'));
});

test('refuses a package-only version whose compliance bundle is missing', () => {
  assert.throws(
    () => mergePublishedVersions(manifest(['3.2.5']), manifest(['3.2.5'], ['3.2.7']), () => false),
    /dist\/compliance\/3\.2\.7\/index\.json/,
  );
});

test('refuses to register a version whose compliance bundle is missing', () => {
  assert.throws(
    () => mergePublishedVersions(manifest(['3.2.5']), manifest(['3.2.6']), () => false),
    /dist\/compliance\/3\.2\.6\/index\.json/,
  );
});

for (const line of ['3.0', '3.1', '3.2']) {
  test(`forward-merge-${line}.yml resolves release records with the shared script`, () => {
    const source = fs.readFileSync(path.join(repoRoot, `.github/workflows/forward-merge-${line}.yml`), 'utf8');
    const changelogCase = source.slice(source.indexOf('CHANGELOG.md)'), source.indexOf(';;', source.indexOf('CHANGELOG.md)')));
    assert.doesNotMatch(changelogCase, /checkout --theirs/, 'CHANGELOG.md must not take the maintenance copy wholesale');
    assert.match(changelogCase, /DEFERRED="\$DEFERRED changelog:\$f"/);
    assert.match(source, /static\/compliance\/published-versions\.json\)\n\s+DEFERRED="\$DEFERRED published-versions:\$f"/);
    // The resolver loads repository modules, so it must run after the loop has
    // resolved a conflicted package.json; inside the loop CHANGELOG.md sorts first.
    const loopEnd = source.indexOf('done <<< "$CONFLICTS"');
    const deferredRun = source.indexOf('node scripts/forward-merge-release-records.cjs "${entry%%:*}"');
    assert.ok(loopEnd !== -1 && deferredRun > loopEnd, 'deferred resolvers must run after the conflict loop');
    assert.match(source, /forward-merge-release-records\.cjs schema-discovery/, 'schema discovery pointers must be regenerated after every merge');
    assert.match(source, /npm ci --ignore-scripts/, 'the resolver needs the repository dependencies');
  });
}
