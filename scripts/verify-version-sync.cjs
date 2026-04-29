#!/usr/bin/env node

/**
 * Verify AdCP version is synchronized between package.json and schema registry
 *
 * This script ensures that the schema registry version matches package.json
 * before a release is finalized. It's run as part of the release process.
 */

const fs = require('fs');
const path = require('path');

// Read package.json version
const packageJson = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8')
);
const packageVersion = packageJson.version;

// Read schema registry version. published_version is the source of truth;
// adcp_version is a legacy alias kept through 3.x for @adcp/client compat.
// Both MUST match package.json — we check both so a hand-edit on one without
// the other is caught.
const registryPath = path.join(__dirname, '../static/schemas/source/index.json');
const schemaRegistry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
const publishedVersion = schemaRegistry.published_version;
const legacyAdcpVersion = schemaRegistry.adcp_version;

console.log('\n🔍 Verifying version synchronization...\n');
console.log(`  package.json version:               ${packageVersion}`);
console.log(`  schema registry published_version:  ${publishedVersion}`);
console.log(`  schema registry adcp_version (legacy alias): ${legacyAdcpVersion}`);

const mismatches = [];
if (packageVersion !== publishedVersion) mismatches.push(`published_version (${publishedVersion})`);
if (packageVersion !== legacyAdcpVersion) mismatches.push(`adcp_version legacy alias (${legacyAdcpVersion})`);

if (mismatches.length > 0) {
  console.error('\n❌ Version mismatch detected!\n');
  console.error(`The schema registry's ${mismatches.join(' and ')} does not match package.json.`);
  console.error('This likely means the update-schema-versions script failed to run.');
  console.error('\nTo fix this, run:');
  console.error('  npm run update-schema-versions\n');
  process.exit(1);
}

console.log('\n✅ Versions are synchronized!\n');
