#!/usr/bin/env node

/**
 * Build script for AdCP schema versioning
 *
 * This script has two modes:
 *
 * 1. Development build (default): `npm run build:schemas`
 *    - Rebuilds only dist/schemas/latest/ with current source schemas
 *    - Preserves existing released version directories (e.g., 2.5.0/)
 *    - Updates symlinks to point to appropriate versions
 *
 * 2. Release build: `npm run build:schemas -- --release`
 *    - Creates a new versioned directory (e.g., dist/schemas/2.6.0/)
 *    - Updates major/minor symlinks to point to new release
 *    - Also updates latest/ to match the release
 *
 * Schema paths:
 * - /schemas/latest/     - Current development schemas (rebuilt on every build)
 * - /schemas/{version}/  - Released versions (only created with --release)
 * - /schemas/v{major}/   - Points to latest release of that major version
 * - /schemas/v{major}.{minor}/ - Points to latest release of that minor version
 * - /schemas/v1/         - Backward compatibility (always points to latest/)
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const SOURCE_DIR = path.join(__dirname, '../static/schemas/source');
const DIST_DIR = path.join(__dirname, '../dist/schemas');
const PACKAGE_JSON = path.join(__dirname, '../package.json');

// Parse command line arguments
const args = process.argv.slice(2);
const isRelease = args.includes('--release');

function getVersion() {
  const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8'));
  return pkg.version;
}

/**
 * Find the latest released version directory in dist/schemas/
 * Returns null if no released versions exist
 */
function findLatestReleasedVersion() {
  if (!fs.existsSync(DIST_DIR)) {
    return null;
  }

  const entries = fs.readdirSync(DIST_DIR, { withFileTypes: true });
  const versionDirs = entries
    .filter(e => e.isDirectory() && /^\d+\.\d+\.\d+$/.test(e.name))
    .map(e => e.name)
    .sort((a, b) => {
      // Sort by semver (descending)
      const [aMajor, aMinor, aPatch] = a.split('.').map(Number);
      const [bMajor, bMinor, bPatch] = b.split('.').map(Number);
      if (aMajor !== bMajor) return bMajor - aMajor;
      if (aMinor !== bMinor) return bMinor - aMinor;
      return bPatch - aPatch;
    });

  return versionDirs[0] || null;
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
  const latestReleasedVersion = findLatestReleasedVersion();

  if (isRelease) {
    console.log(`🚀 RELEASE BUILD: Creating schemas for AdCP v${version}`);
  } else {
    console.log(`📦 Development build: Updating latest/ schemas`);
  }
  console.log(`   Source: ${SOURCE_DIR}`);
  console.log(`   Target: ${DIST_DIR}`);
  if (latestReleasedVersion) {
    console.log(`   Latest released version: ${latestReleasedVersion}`);
  }
  console.log('');

  // Update source registry version
  updateSourceRegistry(version);

  // Ensure dist directory exists
  ensureDir(DIST_DIR);

  if (isRelease) {
    // RELEASE MODE: Create a new versioned directory
    const versionDir = path.join(DIST_DIR, version);

    if (fs.existsSync(versionDir)) {
      console.log(`⚠️  Version ${version} already exists. Overwriting...`);
      fs.rmSync(versionDir, { recursive: true, force: true });
    }

    console.log(`📋 Creating release: dist/schemas/${version}/`);
    ensureDir(versionDir);
    copyAndTransformSchemas(SOURCE_DIR, versionDir, version);

    // Generate bundled schemas for release
    const bundledDir = path.join(versionDir, 'bundled');
    console.log(`📦 Generating bundled schemas to dist/schemas/${version}/bundled/`);
    const { successCount, errorCount } = await generateBundledSchemas(SOURCE_DIR, bundledDir, version);
    console.log(`   ✓ Bundled ${successCount} schemas${errorCount > 0 ? ` (${errorCount} failed)` : ''}`);

    // Update major version symlink (v2 -> 2.5.0)
    const majorLink = path.join(DIST_DIR, `v${majorVersion}`);
    console.log(`🔗 Updating symlink: v${majorVersion} → ${version}`);
    createSymlink(versionDir, majorLink);

    // Update minor version symlink (v2.5 -> 2.5.0)
    const minorLink = path.join(DIST_DIR, `v${minorVersion}`);
    console.log(`🔗 Updating symlink: v${minorVersion} → ${version}`);
    createSymlink(versionDir, minorLink);

    // Also update latest/ to match the release
    const latestDir = path.join(DIST_DIR, 'latest');
    if (fs.existsSync(latestDir)) {
      fs.rmSync(latestDir, { recursive: true, force: true });
    }
    console.log(`📋 Updating latest/ to match release`);
    ensureDir(latestDir);
    copyAndTransformSchemas(SOURCE_DIR, latestDir, 'latest');

    // Generate bundled schemas for latest
    const latestBundledDir = path.join(latestDir, 'bundled');
    await generateBundledSchemas(SOURCE_DIR, latestBundledDir, 'latest');

    // Create v1 symlink pointing to latest/ for backward compatibility
    const v1Link = path.join(DIST_DIR, 'v1');
    console.log(`🔗 Creating symlink: v1 → latest (backward compatibility)`);
    createSymlink(latestDir, v1Link);

    // Stage the new versioned directory for git commit
    // This is needed for the changesets workflow to include it in the version commit
    console.log(`📝 Staging dist/schemas/${version}/ for git commit`);
    try {
      execSync(`git add dist/schemas/${version}/`, { cwd: path.join(__dirname, '..'), stdio: 'inherit' });
    } catch (error) {
      // Not in a git repo or git add failed - that's okay for non-CI builds
      console.log(`   (git add skipped - not in git context or git not available)`);
    }

    console.log('');
    console.log('✅ Release build complete!');
    console.log('');
    console.log('Released paths:');
    console.log(`   /schemas/${version}/          - Exact version (pin for production)`);
    console.log(`   /schemas/${version}/bundled/  - Bundled schemas (no $ref)`);
    console.log(`   /schemas/v${minorVersion}/            - Minor alias → ${version}`);
    console.log(`   /schemas/v${majorVersion}/              - Major alias → ${version}`);
    console.log(`   /schemas/latest/           - Development (matches release)`);
    console.log(`   /schemas/v1/              - Backward compatibility → latest`);

  } else {
    // DEVELOPMENT MODE: Only rebuild latest/
    const latestDir = path.join(DIST_DIR, 'latest');

    // Clean and rebuild latest/ only
    if (fs.existsSync(latestDir)) {
      console.log('🧹 Cleaning existing latest/ directory...');
      fs.rmSync(latestDir, { recursive: true, force: true });
    }

    console.log(`📋 Building schemas to dist/schemas/latest/`);
    ensureDir(latestDir);
    copyAndTransformSchemas(SOURCE_DIR, latestDir, 'latest');

    // Generate bundled schemas for latest
    const bundledDir = path.join(latestDir, 'bundled');
    console.log(`📦 Generating bundled schemas to dist/schemas/latest/bundled/`);
    const { successCount, errorCount } = await generateBundledSchemas(SOURCE_DIR, bundledDir, 'latest');
    console.log(`   ✓ Bundled ${successCount} schemas${errorCount > 0 ? ` (${errorCount} failed)` : ''}`);

    // Symlinks for v2, v2.5, v1 should point to the latest RELEASED version
    // Only create/update these symlinks if we have a released version
    if (latestReleasedVersion) {
      const releasedVersionDir = path.join(DIST_DIR, latestReleasedVersion);
      const releasedMajor = getMajorVersion(latestReleasedVersion);
      const releasedMinor = getMinorVersion(latestReleasedVersion);

      const majorLink = path.join(DIST_DIR, `v${releasedMajor}`);
      if (!fs.existsSync(majorLink)) {
        console.log(`🔗 Creating symlink: v${releasedMajor} → ${latestReleasedVersion}`);
        createSymlink(releasedVersionDir, majorLink);
      }

      const minorLink = path.join(DIST_DIR, `v${releasedMinor}`);
      if (!fs.existsSync(minorLink)) {
        console.log(`🔗 Creating symlink: v${releasedMinor} → ${latestReleasedVersion}`);
        createSymlink(releasedVersionDir, minorLink);
      }

    }

    // v1 always points to latest/ (not a released version)
    const v1Link = path.join(DIST_DIR, 'v1');
    if (!fs.existsSync(v1Link)) {
      console.log(`🔗 Creating symlink: v1 → latest`);
      createSymlink(latestDir, v1Link);
    }

    console.log('');
    console.log('✅ Development build complete!');
    console.log('');
    console.log('Available paths:');
    console.log(`   /schemas/latest/           - Development schemas (just rebuilt)`);
    console.log(`   /schemas/v1/              - Backward compatibility → latest`);
    if (latestReleasedVersion) {
      const releasedMajor = getMajorVersion(latestReleasedVersion);
      const releasedMinor = getMinorVersion(latestReleasedVersion);
      console.log(`   /schemas/${latestReleasedVersion}/          - Latest release (unchanged)`);
      console.log(`   /schemas/v${releasedMinor}/            - Minor alias → ${latestReleasedVersion}`);
      console.log(`   /schemas/v${releasedMajor}/              - Major alias → ${latestReleasedVersion}`);
    } else {
      console.log('');
      console.log('⚠️  No released versions found. Run with --release to create one:');
      console.log('   npm run build:schemas -- --release');
    }
  }

  console.log('');
  console.log('📖 See docs/reference/schema-versioning.mdx for guidance on which to use.');
}

main().catch(err => {
  console.error('❌ Build failed:', err.message);
  process.exit(1);
});
