#!/usr/bin/env node

/**
 * Build script for AdCP schema versioning
 *
 * This script copies schemas from static/schemas/source to dist/schemas/{version}
 * and updates all $id and $ref fields to include the version path.
 *
 * It also generates bundled (dereferenced) schemas at dist/schemas/{version}/bundled/
 * for tools that don't support $ref resolution.
 *
 * Version is read from package.json and follows these rules:
 * - Full semantic version: dist/schemas/2.5.0/
 * - Major version alias: dist/schemas/v2/ (symlink to latest 2.x)
 * - Latest alias: dist/schemas/latest/ (symlink to current version)
 * - Backward compat: dist/schemas/v1/ (symlink to current version)
 */

const fs = require('fs');
const path = require('path');

const SOURCE_DIR = path.join(__dirname, '../static/schemas/source');
const DIST_DIR = path.join(__dirname, '../dist/schemas');
const PACKAGE_JSON = path.join(__dirname, '../package.json');

function getVersion() {
  const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8'));
  return pkg.version;
}

function getMajorVersion(version) {
  return version.split('.')[0];
}

function getMinorVersion(version) {
  const parts = version.split('.');
  if (parts.length < 2) {
    throw new Error(`Invalid semantic version: ${version}. Expected format: major.minor.patch`);
  }
  return `${parts[0]}.${parts[1]}`;
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function copyAndTransformSchemas(sourceDir, targetDir, version) {
  const entries = fs.readdirSync(sourceDir, { withFileTypes: true });

  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);

    if (entry.isDirectory()) {
      ensureDir(targetPath);
      copyAndTransformSchemas(sourcePath, targetPath, version);
    } else if (entry.name.endsWith('.json')) {
      let content = fs.readFileSync(sourcePath, 'utf8');

      // Update $id, $ref, and $schema fields to include version
      content = content.replace(
        /"\$id":\s*"\/schemas\//g,
        `"$id": "/schemas/${version}/`
      );
      content = content.replace(
        /"\$ref":\s*"\/schemas\//g,
        `"$ref": "/schemas/${version}/`
      );
      content = content.replace(
        /"\$schema":\s*"\/schemas\//g,
        `"$schema": "/schemas/${version}/`
      );

      // Update baseUrl and metadata in registry
      if (entry.name === 'index.json') {
        const schema = JSON.parse(content);
        schema.adcp_version = version;
        schema.lastUpdated = new Date().toISOString().split('T')[0];
        schema.baseUrl = `/schemas/${version}`;
        if (!schema.versioning) {
          schema.versioning = {};
        }
        schema.versioning.note = `AdCP uses build-time versioning. This directory contains schemas for AdCP ${version}. Full semantic versions are available at /schemas/{version}/ (e.g., /schemas/2.5.0/). Major version aliases point to the latest release: /schemas/v${getMajorVersion(version)}/ → /schemas/${version}/.`;
        content = JSON.stringify(schema, null, 2);
      }

      fs.writeFileSync(targetPath, content);
    }
  }
}

function createSymlink(target, linkPath) {
  // Remove existing symlink if it exists
  if (fs.existsSync(linkPath)) {
    fs.unlinkSync(linkPath);
  }

  // Create relative symlink
  const relativePath = path.relative(path.dirname(linkPath), target);
  fs.symlinkSync(relativePath, linkPath, 'dir');
}

function updateSourceRegistry(version) {
  const registryPath = path.join(SOURCE_DIR, 'index.json');
  const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  registry.adcp_version = version;
  fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2) + '\n', 'utf8');
  console.log(`✏️  Updated source registry: ${registryPath}`);
}

/**
 * Find all JSON schema files in a directory (excluding index.json)
 */
function findSchemaFiles(dir, baseDir = dir) {
  const files = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...findSchemaFiles(fullPath, baseDir));
    } else if (entry.name.endsWith('.json') && entry.name !== 'index.json') {
      files.push(fullPath);
    }
  }

  return files;
}

/**
 * Recursively resolve all $ref in a schema object
 * This is a simple implementation that handles our /schemas/ convention.
 *
 * The `ancestorRefs` parameter tracks the current resolution chain to detect
 * true circular references (A → B → A). This is different from multiple
 * references to the same schema from different locations, which should
 * all be resolved.
 */
function resolveRefs(schema, sourceDir, ancestorRefs = new Set()) {
  if (!schema || typeof schema !== 'object') {
    return schema;
  }

  if (Array.isArray(schema)) {
    return schema.map(item => resolveRefs(item, sourceDir, ancestorRefs));
  }

  const result = {};

  for (const [key, value] of Object.entries(schema)) {
    if (key === '$ref' && typeof value === 'string' && value.startsWith('/schemas/')) {
      // Resolve the reference
      const refPath = path.join(sourceDir, value.replace('/schemas/', ''));

      // Prevent infinite recursion for true circular refs (A → B → A)
      // But allow the same schema to be referenced from different locations
      if (ancestorRefs.has(refPath)) {
        result[key] = value;  // Keep as-is for circular refs
        continue;
      }

      try {
        const refContent = JSON.parse(fs.readFileSync(refPath, 'utf8'));
        // Create a new set including this ref for the recursive call
        const newAncestors = new Set(ancestorRefs);
        newAncestors.add(refPath);
        // Recursively resolve refs in the referenced schema
        const resolvedRef = resolveRefs(refContent, sourceDir, newAncestors);
        // Merge the resolved content (remove $id, $schema from merged content)
        const { $id, $schema, ...rest } = resolvedRef;
        Object.assign(result, rest);
      } catch (error) {
        // If we can't resolve, keep the original $ref
        result[key] = value;
      }
    } else {
      result[key] = resolveRefs(value, sourceDir, ancestorRefs);
    }
  }

  return result;
}

/**
 * Generate bundled (dereferenced) schemas
 * These have all $ref resolved inline for tools that can't handle references
 */
async function generateBundledSchemas(sourceDir, bundledDir, version) {
  ensureDir(bundledDir);

  const schemaFiles = findSchemaFiles(sourceDir);
  let successCount = 0;
  let errorCount = 0;

  // Only bundle request/response schemas - these are the "root" schemas
  // that tools actually validate against. Core objects like product.json
  // are already embedded inside response schemas when bundled.
  const bundlePatterns = [
    /media-buy\/.*-request\.json$/,
    /media-buy\/.*-response\.json$/,
    /signals\/.*-request\.json$/,
    /signals\/.*-response\.json$/,
  ];

  for (const schemaPath of schemaFiles) {
    const relativePath = path.relative(sourceDir, schemaPath);

    // Only bundle schemas matching our patterns
    const shouldBundle = bundlePatterns.some(pattern => pattern.test(relativePath));
    if (!shouldBundle) continue;

    try {
      // Read the schema
      const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));

      // Resolve all $refs
      const dereferenced = resolveRefs(schema, sourceDir, new Set([schemaPath]));

      // Update $id to indicate this is a bundled schema
      if (dereferenced.$id) {
        dereferenced.$id = dereferenced.$id.replace('/schemas/', `/schemas/${version}/bundled/`);
      }

      // Add metadata indicating this is bundled
      dereferenced._bundled = {
        generatedAt: new Date().toISOString(),
        note: 'This is a bundled schema with all $ref resolved inline. For the modular version with references, use the parent directory.'
      };

      // Write bundled schema
      const outputPath = path.join(bundledDir, relativePath);
      ensureDir(path.dirname(outputPath));
      fs.writeFileSync(outputPath, JSON.stringify(dereferenced, null, 2));
      successCount++;
    } catch (error) {
      console.warn(`   ⚠️  Failed to bundle ${relativePath}: ${error.message}`);
      errorCount++;
    }
  }

  return { successCount, errorCount };
}

async function main() {
  const version = getVersion();
  const majorVersion = getMajorVersion(version);
  const minorVersion = getMinorVersion(version);

  console.log(`📦 Building schemas for AdCP v${version}`);
  console.log(`   Source: ${SOURCE_DIR}`);
  console.log(`   Target: ${DIST_DIR}`);
  console.log('');

  // Update source registry version
  updateSourceRegistry(version);

  // Clean and create dist directory
  if (fs.existsSync(DIST_DIR)) {
    console.log('🧹 Cleaning existing dist directory...');
    fs.rmSync(DIST_DIR, { recursive: true, force: true });
  }
  ensureDir(DIST_DIR);

  // Copy schemas with version in paths
  const versionDir = path.join(DIST_DIR, version);
  console.log(`📋 Copying schemas to dist/schemas/${version}/`);
  ensureDir(versionDir);
  copyAndTransformSchemas(SOURCE_DIR, versionDir, version);

  // Generate bundled (dereferenced) schemas
  const bundledDir = path.join(versionDir, 'bundled');
  console.log(`📦 Generating bundled schemas to dist/schemas/${version}/bundled/`);
  const { successCount, errorCount } = await generateBundledSchemas(SOURCE_DIR, bundledDir, version);
  console.log(`   ✓ Bundled ${successCount} schemas${errorCount > 0 ? ` (${errorCount} failed)` : ''}`);

  // Create major version symlink (v2 -> 2.5.0)
  const majorLink = path.join(DIST_DIR, `v${majorVersion}`);
  console.log(`🔗 Creating symlink: v${majorVersion} → ${version}`);
  createSymlink(versionDir, majorLink);

  // Create minor version symlink (v2.5 -> 2.5.0)
  const minorLink = path.join(DIST_DIR, `v${minorVersion}`);
  console.log(`🔗 Creating symlink: v${minorVersion} → ${version}`);
  createSymlink(versionDir, minorLink);

  // Create v1 symlink for backward compatibility (v1 -> 2.x.x)
  // Clients expecting /schemas/v1/ will still work
  const v1Link = path.join(DIST_DIR, 'v1');
  console.log(`🔗 Creating symlink: v1 → ${version} (backward compatibility)`);
  createSymlink(versionDir, v1Link);

  // Create latest symlink
  const latestLink = path.join(DIST_DIR, 'latest');
  console.log(`🔗 Creating symlink: latest → ${version}`);
  createSymlink(versionDir, latestLink);

  console.log('');
  console.log('✅ Schema build complete!');
  console.log('');
  console.log('Available paths:');
  console.log(`   /schemas/${version}/          - Exact version (pin for production)`);
  console.log(`   /schemas/${version}/bundled/  - Bundled schemas (no $ref, for tools that need it)`);
  console.log(`   /schemas/v${minorVersion}/            - Minor alias (patch updates only)`);
  console.log(`   /schemas/v${majorVersion}/              - Major alias (minor + patch updates)`);
  console.log(`   /schemas/v1/              - Backward compatibility (same as v${majorVersion})`);
  console.log(`   /schemas/latest/           - Latest release (all updates)`);
  console.log('');
  console.log('📖 See docs/reference/schema-versioning.mdx for guidance on which to use.');
}

main().catch(err => {
  console.error('❌ Build failed:', err.message);
  process.exit(1);
});
