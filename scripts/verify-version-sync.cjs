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

// Read schema registry version
const registryPath = path.join(__dirname, '../static/schemas/source/index.json');
const schemaRegistry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
const schemaVersion = schemaRegistry.published_version;

console.log('\n🔍 Verifying version synchronization...\n');
console.log(`  package.json version:               ${packageVersion}`);
console.log(`  schema registry published_version:  ${schemaVersion}`);

if (packageVersion !== schemaVersion) {
  console.error('\n❌ Version mismatch detected!\n');
  console.error('The schema registry version does not match package.json.');
  console.error('This likely means the update-schema-versions script failed to run.');
  console.error('\nTo fix this, run:');
  console.error('  npm run update-schema-versions\n');
  process.exit(1);
}

console.log('\n✅ Versions are synchronized!\n');
