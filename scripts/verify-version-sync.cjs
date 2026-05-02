#!/usr/bin/env node

/**
 * Verify AdCP version is synchronized between package.json and the schema
 * registry.
 *
 * Two modes:
 *   - Default (pre-push hook): allow registry to be at or ahead of
 *     package.json. The forward-merge release process (#3807) keeps
 *     `package.json --ours` on main, so during the window between cutting
 *     a version and bumping the dev package, registry is ahead of
 *     package.json by design. Strict equality made pre-push fail for every
 *     contributor during that window (May 2026: package.json=3.0.3,
 *     registry=3.0.4).
 *   - `--strict` (release-time): require exact equality. Run after
 *     `changeset version` + `build:schemas --release` have both bumped
 *     package.json and the registry — at that point they MUST match, and
 *     any drift is a release-step bug we want to surface before tagging.
 *
 * Always-fails (regardless of mode):
 *   - Either field missing entirely → release artifacts not published.
 *   - Registry behind package.json → bumped the dev version but forgot to
 *     run update-schema-versions / cut a release.
 *   - The two registry fields disagreeing with each other → hand-edit drift.
 *   - Pre-release tags (`-beta.0`) fall back to strict equality so beta
 *     windows lockstep, even in default mode.
 */

const fs = require('fs');
const path = require('path');

const strict = process.argv.includes('--strict');

const packageJson = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8')
);
const packageVersion = packageJson.version;

const registryPath = path.join(__dirname, '../static/schemas/source/index.json');
const schemaRegistry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
const publishedVersion = schemaRegistry.published_version;
const legacyAdcpVersion = schemaRegistry.adcp_version;

console.log('\n🔍 Verifying version synchronization...\n');
console.log(`  package.json version:               ${packageVersion}`);
console.log(`  schema registry published_version:  ${publishedVersion}`);
console.log(`  schema registry adcp_version (legacy alias): ${legacyAdcpVersion}`);

/**
 * Parse a stable X.Y.Z version into a comparable triple. Returns null for
 * pre-release tags (`3.1.0-beta.0`, `3.0.0+build1`) and anything we can't
 * parse cleanly — the caller falls back to strict equality so pre-release
 * windows require both sides to move together rather than letting `beta.1`
 * silently satisfy a `beta.0` baseline.
 */
function parseVersion(v) {
  if (typeof v !== 'string') return null;
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** `actual >= base` for X.Y.Z versions. Falls back to strict equality on parse failure. */
function gteVersion(actual, base) {
  const a = parseVersion(actual);
  const b = parseVersion(base);
  if (!a || !b) return actual === base;
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return true;
    if (a[i] < b[i]) return false;
  }
  return true;
}

const problems = [];

if (publishedVersion === undefined || publishedVersion === null) {
  problems.push('schema registry is missing `published_version`');
}
if (legacyAdcpVersion === undefined || legacyAdcpVersion === null) {
  problems.push('schema registry is missing `adcp_version`');
}

// In strict mode (release-time, after `changeset version` + `build:schemas
// --release` have both written), require exact equality. Otherwise allow
// registry to be ahead.
if (strict) {
  if (publishedVersion !== undefined && publishedVersion !== packageVersion) {
    problems.push(
      `[strict] published_version (${publishedVersion}) does not equal package.json (${packageVersion})`
    );
  }
  if (legacyAdcpVersion !== undefined && legacyAdcpVersion !== packageVersion) {
    problems.push(
      `[strict] adcp_version (${legacyAdcpVersion}) does not equal package.json (${packageVersion})`
    );
  }
} else {
  if (publishedVersion && !gteVersion(publishedVersion, packageVersion)) {
    problems.push(
      `published_version (${publishedVersion}) is behind package.json (${packageVersion}) — the registry was not updated when the package was bumped`
    );
  }
  if (legacyAdcpVersion && !gteVersion(legacyAdcpVersion, packageVersion)) {
    problems.push(
      `adcp_version (${legacyAdcpVersion}) is behind package.json (${packageVersion}) — the registry was not updated when the package was bumped`
    );
  }
}

if (publishedVersion && legacyAdcpVersion && publishedVersion !== legacyAdcpVersion) {
  problems.push(
    `published_version (${publishedVersion}) and adcp_version (${legacyAdcpVersion}) disagree — these two registry fields must match`
  );
}

if (problems.length > 0) {
  console.error('\n❌ Version sync problem detected!\n');
  for (const p of problems) console.error(`  - ${p}`);
  console.error('\nTo fix this, run:');
  console.error('  npm run update-schema-versions\n');
  process.exit(1);
}

console.log(
  strict
    ? '\n✅ Versions are in strict sync (registry === package.json)\n'
    : '\n✅ Versions are in sync (registry >= package.json)\n',
);
