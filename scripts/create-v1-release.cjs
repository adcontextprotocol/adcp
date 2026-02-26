#!/usr/bin/env node

/**
 * One-time script to create the 1.0.0 schema release.
 * 
 * This script creates dist/schemas/1.0.0/ containing schemas that exist in
 * latest but NOT in v2 (2.5.3) or v3 (3.0.0-beta.3).
 * 
 * These are schemas that were added after the v2/v3 release lines and are
 * currently only accessible via v1 -> latest. By creating a proper 1.0.0
 * release, v1 becomes a stable target instead of a moving one.
 * 
 * Usage: node scripts/create-v1-release.cjs
 */

const fs = require('fs');
const path = require('path');

const DIST_DIR = path.join(__dirname, '../dist/schemas');
const SOURCE_DIR = path.join(__dirname, '../static/schemas/source');
const LATEST_DIR = path.join(DIST_DIR, 'latest');
const V2_DIR = path.join(DIST_DIR, '2.5.3');
const V3_DIR = path.join(DIST_DIR, '3.0.0-beta.3');
const TARGET_DIR = path.join(DIST_DIR, '1.0.0');
const TARGET_VERSION = '1.0.0';

/**
 * Recursively get all JSON files in a directory
 * Returns paths relative to the base directory
 */
function getJsonFiles(dir, baseDir = dir) {
  const files = [];
  
  if (!fs.existsSync(dir)) {
    return files;
  }
  
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...getJsonFiles(fullPath, baseDir));
    } else if (entry.name.endsWith('.json')) {
      files.push(path.relative(baseDir, fullPath));
    }
  }
  
  return files;
}

/**
 * Ensure directory exists
 */
function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Copy a schema file, updating version references
 */
function copySchema(relativePath, sourceDir, targetDir, targetVersion) {
  const sourcePath = path.join(sourceDir, relativePath);
  const targetPath = path.join(targetDir, relativePath);
  
  ensureDir(path.dirname(targetPath));
  
  let content = fs.readFileSync(sourcePath, 'utf8');
  
  // Source files use /schemas/ without version, update to /schemas/1.0.0/
  content = content.replace(
    /("(?:\$id|\$ref|\$schema)":\s*")\/schemas\//g,
    `$1/schemas/${targetVersion}/`
  );
  
  // Also handle any references that might use the full URL without version
  content = content.replace(
    /(https:\/\/adcontextprotocol\.org\/schemas\/)/g,
    `$1${targetVersion}/`
  );
  
  fs.writeFileSync(targetPath, content);
}

/**
 * Create the index.json for 1.0.0
 */
function createIndexJson(targetDir, targetVersion, schemaFiles) {
  const index = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: `/schemas/${targetVersion}/index.json`,
    title: 'AdCP Schema Registry',
    description: `Schema registry for AdCP ${targetVersion}. This version contains schemas that were added after the v2.x and v3.x release lines.`,
    adcp_version: targetVersion,
    lastUpdated: new Date().toISOString().split('T')[0],
    baseUrl: `/schemas/${targetVersion}`,
    versioning: {
      note: `AdCP ${targetVersion} is a frozen release containing schemas not available in v2.x or v3.x. Use /schemas/v1/ to access these schemas.`
    },
    schemas: {}
  };
  
  // Group schemas by category
  const categories = {};
  for (const file of schemaFiles) {
    if (file === 'index.json') continue;
    
    const parts = file.split('/');
    const category = parts.length > 1 ? parts[0] : 'root';
    
    if (!categories[category]) {
      categories[category] = [];
    }
    categories[category].push(file);
  }
  
  // Add to index
  for (const [category, files] of Object.entries(categories)) {
    index.schemas[category] = files.map(f => ({
      path: f,
      $ref: `/schemas/${targetVersion}/${f}`
    }));
  }
  
  fs.writeFileSync(
    path.join(targetDir, 'index.json'),
    JSON.stringify(index, null, 2)
  );
}

async function main() {
  console.log('🚀 Creating v1.0.0 schema release...\n');
  
  // Get all JSON files from each version
  console.log('📋 Scanning schema directories...');
  const sourceFiles = new Set(getJsonFiles(SOURCE_DIR));
  const latestFiles = new Set(getJsonFiles(LATEST_DIR));
  const v2Files = new Set(getJsonFiles(V2_DIR));
  const v3Files = new Set(getJsonFiles(V3_DIR));
  
  console.log(`   source: ${sourceFiles.size} files`);
  console.log(`   latest: ${latestFiles.size} files`);
  console.log(`   2.5.3:  ${v2Files.size} files`);
  console.log(`   3.0.0-beta.3: ${v3Files.size} files`);
  
  // Find files in source that are not in v2 AND not in v3
  // These need to go in v1.0.0
  const uniqueToV1 = [];
  for (const file of sourceFiles) {
    // Skip bundled directory (we'll generate those separately)
    if (file.startsWith('bundled/')) continue;
    // Skip extensions (handled separately by build)
    if (file.startsWith('extensions/')) continue;
    
    if (!v2Files.has(file) && !v3Files.has(file)) {
      uniqueToV1.push(file);
    }
  }
  
  console.log(`\n📦 Found ${uniqueToV1.length} schemas unique to v1 (not in v2 or v3)\n`);
  
  // Create target directory
  if (fs.existsSync(TARGET_DIR)) {
    console.log(`⚠️  ${TARGET_VERSION} already exists. Removing...`);
    fs.rmSync(TARGET_DIR, { recursive: true, force: true });
  }
  
  ensureDir(TARGET_DIR);
  
  // Copy unique schemas from SOURCE (not latest, since latest may be missing some)
  console.log(`📋 Copying schemas to dist/schemas/${TARGET_VERSION}/`);
  for (const file of uniqueToV1) {
    copySchema(file, SOURCE_DIR, TARGET_DIR, TARGET_VERSION);
  }
  
  // Create index.json
  console.log('📝 Creating index.json');
  createIndexJson(TARGET_DIR, TARGET_VERSION, uniqueToV1);
  
  // Summary
  console.log('\n✅ v1.0.0 release created!\n');
  console.log('Schemas by category:');
  
  const categories = {};
  for (const file of uniqueToV1) {
    const parts = file.split('/');
    const category = parts.length > 1 ? parts[0] : 'root';
    categories[category] = (categories[category] || 0) + 1;
  }
  
  for (const [category, count] of Object.entries(categories).sort()) {
    console.log(`   ${category}: ${count} files`);
  }
  
  console.log(`\nTotal: ${uniqueToV1.length} schemas`);
  console.log(`\nLocation: dist/schemas/${TARGET_VERSION}/`);
}

main().catch(err => {
  console.error('❌ Failed:', err.message);
  process.exit(1);
});
