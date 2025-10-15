#!/usr/bin/env node

/**
 * Update AdCP version in schema registry
 *
 * This script is automatically run after `changeset version` to update
 * the schema registry with the current package version.
 *
 * Version is maintained ONLY in the schema registry - not in individual
 * request/response schemas or documentation examples.
 */

const fs = require('fs');
const path = require('path');

// Read the current version from package.json
const packageJson = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8')
);
const version = packageJson.version;

console.log(`\n🔄 Updating AdCP version to ${version}...`);

let filesUpdated = 0;

/**
 * Update version in schema registry
 */
function updateSchemaRegistry() {
  const registryPath = path.join(__dirname, '../static/schemas/v1/index.json');

  try {
    const content = fs.readFileSync(registryPath, 'utf8');
    const data = JSON.parse(content);

    if (data.adcp_version !== version) {
      const oldVersion = data.adcp_version;
      data.adcp_version = version;
      data.lastUpdated = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

      fs.writeFileSync(registryPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
      console.log(`  ✓ Schema registry: ${oldVersion} → ${version}`);
      console.log(`  ✓ Updated lastUpdated date`);
      filesUpdated++;
    } else {
      console.log(`  ℹ Schema registry already at version ${version}`);
    }
  } catch (error) {
    console.error(`  ✗ Error updating schema registry:`, error.message);
    process.exit(1);
  }
}

// Update schema registry
console.log('\n📋 Updating schema registry...');
updateSchemaRegistry();

console.log(`\n✅ Version update complete!\n`);
console.log(`The AdCP version is now ${version} and is maintained solely in:`);
console.log(`  • static/schemas/v1/index.json (adcp_version field)`);
console.log(`  • Schema path prefix (/schemas/v1/)`);
console.log(`\nIndividual schemas and documentation do not contain version fields.\n`);
