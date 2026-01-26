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
 *
 * Extension handling:
 * - Extensions are auto-discovered from static/schemas/source/extensions/
 * - Each extension has valid_from/valid_until to specify compatible AdCP versions
 * - The build generates extensions/index.json with extensions valid for the target version
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const SOURCE_DIR = path.join(__dirname, '../static/schemas/source');
const DIST_DIR = path.join(__dirname, '../dist/schemas');
const PACKAGE_JSON = path.join(__dirname, '../package.json');
const SKILLS_DIR = path.join(__dirname, '../skills');

// Parse command line arguments
const args = process.argv.slice(2);
const isRelease = args.includes('--release');

function getVersion() {
  const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8'));
  return pkg.version;
}

/**
 * Get all released version directories in dist/schemas/
 * Returns array sorted by semver (descending)
 */
function getAllReleasedVersions() {
  if (!fs.existsSync(DIST_DIR)) {
    return [];
  }

  const entries = fs.readdirSync(DIST_DIR, { withFileTypes: true });
  return entries
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
}

/**
 * Find the latest released version directory in dist/schemas/
 * Returns null if no released versions exist
 */
function findLatestReleasedVersion() {
  const versions = getAllReleasedVersions();
  return versions[0] || null;
}

/**
 * Get the latest patch version for each minor version series
 * e.g., for [2.6.0, 2.5.1, 2.5.0], returns { '2.6': '2.6.0', '2.5': '2.5.1' }
 */
function getLatestPatchPerMinor() {
  const versions = getAllReleasedVersions();
  const latestPerMinor = {};

  for (const version of versions) {
    const minor = getMinorVersion(version);
    // Since versions are sorted descending, first one wins
    if (!latestPerMinor[minor]) {
      latestPerMinor[minor] = version;
    }
  }

  return latestPerMinor;
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

/**
 * Compare two minor versions (e.g., "2.5" vs "2.6")
 * Returns: negative if a < b, 0 if equal, positive if a > b
 */
function compareMinorVersions(a, b) {
  const [aMajor, aMinor] = a.split('.').map(Number);
  const [bMajor, bMinor] = b.split('.').map(Number);
  if (aMajor !== bMajor) return aMajor - bMajor;
  return aMinor - bMinor;
}

/**
 * Reserved namespaces that cannot be used for typed extensions
 * These could cause confusion with core AdCP concepts
 */
const RESERVED_NAMESPACES = ['adcp', 'core', 'protocol', 'schema', 'meta', 'ext', 'context'];

/**
 * Validate that an extension namespace is not reserved
 * @param {string} namespace - Extension namespace to validate
 * @throws {Error} If namespace is reserved
 */
function validateExtensionNamespace(namespace) {
  if (RESERVED_NAMESPACES.includes(namespace.toLowerCase())) {
    throw new Error(`Namespace "${namespace}" is reserved and cannot be used for extensions`);
  }
}

/**
 * Discover extension files from the extensions directory
 * Returns array of { namespace, schema, path } objects
 */
function discoverExtensions(extensionsDir) {
  if (!fs.existsSync(extensionsDir)) {
    return [];
  }

  const extensions = [];
  const files = fs.readdirSync(extensionsDir);

  for (const file of files) {
    // Skip non-JSON files and special files
    if (!file.endsWith('.json')) continue;
    if (file === 'index.json' || file === 'extension-meta.json') continue;

    const filePath = path.join(extensionsDir, file);
    try {
      const content = JSON.parse(fs.readFileSync(filePath, 'utf8'));

      // Extract namespace from $id (e.g., /schemas/extensions/sustainability.json -> sustainability)
      const namespace = file.replace('.json', '');

      // Validate namespace is not reserved
      validateExtensionNamespace(namespace);

      extensions.push({
        namespace,
        schema: content,
        path: filePath
      });
    } catch (error) {
      console.warn(`   ⚠️  Failed to parse extension ${file}: ${error.message}`);
    }
  }

  return extensions;
}

/**
 * Filter extensions to those valid for a given AdCP version
 * @param {Array} extensions - Array of extension objects from discoverExtensions
 * @param {string} targetVersion - Target AdCP version (e.g., "2.5.0" or "2.5")
 * @returns {Array} Extensions valid for the target version
 */
function filterExtensionsForVersion(extensions, targetVersion) {
  // Normalize to minor version for comparison
  const targetMinor = getMinorVersion(targetVersion);

  return extensions.filter(ext => {
    const { valid_from, valid_until } = ext.schema;

    // Must have valid_from
    if (!valid_from) {
      console.warn(`   ⚠️  Extension ${ext.namespace} missing valid_from, skipping`);
      return false;
    }

    // Check valid_from <= targetVersion
    if (compareMinorVersions(valid_from, targetMinor) > 0) {
      return false; // Extension requires newer version
    }

    // Check valid_until >= targetVersion (if specified)
    if (valid_until && compareMinorVersions(valid_until, targetMinor) < 0) {
      return false; // Extension no longer valid for this version
    }

    return true;
  });
}

/**
 * Generate the extensions/index.json registry for a target version
 * @param {Array} extensions - Array of valid extension objects
 * @param {string} targetVersion - Target version string for $id paths
 * @returns {Object} The generated registry object
 */
function generateExtensionRegistry(extensions, targetVersion) {
  const registry = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: `/schemas/${targetVersion}/extensions/index.json`,
    title: 'AdCP Extension Registry',
    description: 'Auto-generated registry of formal AdCP extensions. Extensions provide typed schemas for vendor-specific or domain-specific data within the ext field. Agents declare which extensions they support in their agent card.',
    _generated: true,
    _generatedAt: new Date().toISOString(),
    extensions: {}
  };

  for (const ext of extensions) {
    registry.extensions[ext.namespace] = {
      $ref: `/schemas/${targetVersion}/extensions/${ext.namespace}.json`,
      title: ext.schema.title,
      description: ext.schema.description,
      valid_from: ext.schema.valid_from
    };

    // Include valid_until if specified
    if (ext.schema.valid_until) {
      registry.extensions[ext.namespace].valid_until = ext.schema.valid_until;
    }

    // Include docs_url if specified
    if (ext.schema.docs_url) {
      registry.extensions[ext.namespace].docs_url = ext.schema.docs_url;
    }
  }

  return registry;
}

/**
 * Build extensions for a target directory
 * - Discovers all extensions from source
 * - Filters to those valid for target version
 * - Copies valid extension schemas
 * - Generates the index.json registry
 */
function buildExtensions(sourceDir, targetDir, version) {
  const sourceExtensionsDir = path.join(sourceDir, 'extensions');
  const targetExtensionsDir = path.join(targetDir, 'extensions');

  // Always ensure extensions directory exists
  ensureDir(targetExtensionsDir);

  // Discover all extensions
  const allExtensions = discoverExtensions(sourceExtensionsDir);

  if (allExtensions.length === 0) {
    // No extensions yet - just copy the meta schema and generate empty registry
    const metaSchemaPath = path.join(sourceExtensionsDir, 'extension-meta.json');
    if (fs.existsSync(metaSchemaPath)) {
      let content = fs.readFileSync(metaSchemaPath, 'utf8');
      // Update $id to include version
      content = content.replace(
        /"\$id":\s*"\/schemas\//g,
        `"$id": "/schemas/${version}/`
      );
      fs.writeFileSync(path.join(targetExtensionsDir, 'extension-meta.json'), content);
    }

    // Generate empty registry
    const registry = generateExtensionRegistry([], version);
    fs.writeFileSync(
      path.join(targetExtensionsDir, 'index.json'),
      JSON.stringify(registry, null, 2)
    );

    return { total: 0, included: 0 };
  }

  // Filter extensions valid for this version
  const validExtensions = filterExtensionsForVersion(allExtensions, version);

  // Copy extension-meta.json (with version transform)
  const metaSchemaPath = path.join(sourceExtensionsDir, 'extension-meta.json');
  if (fs.existsSync(metaSchemaPath)) {
    let content = fs.readFileSync(metaSchemaPath, 'utf8');
    content = content.replace(
      /"\$id":\s*"\/schemas\//g,
      `"$id": "/schemas/${version}/`
    );
    fs.writeFileSync(path.join(targetExtensionsDir, 'extension-meta.json'), content);
  }

  // Copy each valid extension schema (with version transform)
  for (const ext of validExtensions) {
    let content = JSON.stringify(ext.schema, null, 2);
    // Update $id to include version
    content = content.replace(
      /"\$id":\s*"\/schemas\//g,
      `"$id": "/schemas/${version}/`
    );
    fs.writeFileSync(
      path.join(targetExtensionsDir, `${ext.namespace}.json`),
      content
    );
  }

  // Generate the registry index
  const registry = generateExtensionRegistry(validExtensions, version);
  fs.writeFileSync(
    path.join(targetExtensionsDir, 'index.json'),
    JSON.stringify(registry, null, 2)
  );

  return {
    total: allExtensions.length,
    included: validExtensions.length,
    extensions: validExtensions.map(e => e.namespace)
  };
}

function copyAndTransformSchemas(sourceDir, targetDir, version) {
  const entries = fs.readdirSync(sourceDir, { withFileTypes: true });

  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);

    if (entry.isDirectory()) {
      // Skip extensions directory - handled separately by buildExtensions()
      if (entry.name === 'extensions') {
        continue;
      }
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
    /creative\/.*-request\.json$/,
    /creative\/.*-response\.json$/,
    /property\/.*-request\.json$/,
    /property\/.*-response\.json$/,
    /content-standards\/.*-request\.json$/,
    /content-standards\/.*-response\.json$/,
    /sponsored-intelligence\/.*-request\.json$/,
    /sponsored-intelligence\/.*-response\.json$/,
    /protocol\/.*-request\.json$/,
    /protocol\/.*-response\.json$/,
    /core\/tasks-.*-request\.json$/,
    /core\/tasks-.*-response\.json$/,
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

/**
 * Copy schemas from a source directory to a skill schemas directory
 * Returns the count of files copied
 */
function copySchemaDir(sourceDir, targetDir) {
  if (!fs.existsSync(sourceDir)) {
    return 0;
  }

  ensureDir(targetDir);
  const entries = fs.readdirSync(sourceDir, { withFileTypes: true });
  let count = 0;

  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.json')) {
      const sourcePath = path.join(sourceDir, entry.name);
      const targetPath = path.join(targetDir, entry.name);
      fs.copyFileSync(sourcePath, targetPath);
      count++;
    }
  }

  return count;
}

/**
 * Generate schemas for a single skill
 * Returns the count of files copied, or 0 if source doesn't exist
 */
function generateSkillSchema(versionDir, version, protocol, skillName) {
  const sourceDir = path.join(versionDir, protocol);
  const skillDir = path.join(SKILLS_DIR, skillName, 'schemas');

  if (!fs.existsSync(sourceDir)) {
    return 0;
  }

  if (fs.existsSync(skillDir)) {
    fs.rmSync(skillDir, { recursive: true, force: true });
  }
  ensureDir(skillDir);

  let count = copySchemaDir(sourceDir, skillDir);
  count += copySchemaDir(path.join(versionDir, 'core'), path.join(skillDir, 'core'));
  count += copySchemaDir(path.join(versionDir, 'enums'), path.join(skillDir, 'enums'));

  console.log(`📚 Generated skill schemas: skills/${skillName}/schemas/ (${count} files from ${version})`);
  return count;
}

/**
 * Generate skill schemas from versioned dist schemas
 * Copies protocol schemas to skills/{protocol}/schemas/
 */
function generateSkillSchemas(versionDir, version) {
  const skills = [
    { protocol: 'media-buy', skillName: 'adcp-media-buy' },
    { protocol: 'creative', skillName: 'adcp-creative' },
    { protocol: 'signals', skillName: 'adcp-signals' },
  ];

  let totalCount = 0;
  for (const { protocol, skillName } of skills) {
    const count = generateSkillSchema(versionDir, version, protocol, skillName);
    if (count === 0 && protocol === 'media-buy') {
      console.log(`   ⚠️  No media-buy schemas found in ${versionDir}`);
    }
    totalCount += count;
  }

  return totalCount;
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

    // Build extensions (auto-discovered, filtered by version)
    console.log(`🔌 Building extensions for ${version}`);
    const extResult = buildExtensions(SOURCE_DIR, versionDir, version);
    if (extResult.total === 0) {
      console.log(`   ✓ No extensions defined yet (empty registry created)`);
    } else {
      console.log(`   ✓ Included ${extResult.included}/${extResult.total} extensions: ${extResult.extensions.join(', ') || 'none'}`);
    }

    // Generate bundled schemas for release
    const bundledDir = path.join(versionDir, 'bundled');
    console.log(`📦 Generating bundled schemas to dist/schemas/${version}/bundled/`);
    const { successCount, errorCount } = await generateBundledSchemas(SOURCE_DIR, bundledDir, version);
    console.log(`   ✓ Bundled ${successCount} schemas${errorCount > 0 ? ` (${errorCount} failed)` : ''}`);

    // Note: Version aliases (v2, v2.5, v1, latest) are handled by HTTP middleware
    // No symlinks needed - the server rewrites /schemas/v2.5/* to /schemas/2.5.1/*

    // Also update latest/ to match the release
    const latestDir = path.join(DIST_DIR, 'latest');
    if (fs.existsSync(latestDir)) {
      fs.rmSync(latestDir, { recursive: true, force: true });
    }
    console.log(`📋 Updating latest/ to match release`);
    ensureDir(latestDir);
    copyAndTransformSchemas(SOURCE_DIR, latestDir, 'latest');

    // Build extensions for latest (using full version for filtering)
    buildExtensions(SOURCE_DIR, latestDir, version);

    // Generate bundled schemas for latest
    const latestBundledDir = path.join(latestDir, 'bundled');
    await generateBundledSchemas(SOURCE_DIR, latestBundledDir, 'latest');

    // Generate skill schemas from the release version
    generateSkillSchemas(versionDir, version);

    // Stage the new versioned directory for git commit
    // This is needed for the changesets workflow to include it in the version commit
    console.log(`📝 Staging dist/schemas/${version}/ for git commit`);
    try {
      execSync(`git add dist/schemas/${version}/`, { cwd: path.join(__dirname, '..'), stdio: 'inherit' });
    } catch (error) {
      // Not in a git repo or git add failed - that's okay for non-CI builds
      console.log(`   (git add skipped - not in git context or git not available)`);
    }

    // Show available paths (aliases are handled by HTTP middleware)
    const latestPerMinor = getLatestPatchPerMinor();
    console.log('');
    console.log('✅ Release build complete!');
    console.log('');
    console.log('Released paths:');
    console.log(`   /schemas/${version}/          - Exact version (pin for production)`);
    console.log(`   /schemas/${version}/bundled/  - Bundled schemas (no $ref)`);
    console.log(`   /schemas/latest/           - Development (matches release)`);
    console.log('');
    console.log('Version aliases (handled by HTTP middleware):');
    console.log(`   /schemas/v${majorVersion}/              - Major alias → latest ${majorVersion}.x.x`);
    for (const [minor, patchVersion] of Object.entries(latestPerMinor)) {
      console.log(`   /schemas/v${minor}/            - Minor alias → ${patchVersion}`);
    }
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

    // Build extensions (auto-discovered, filtered by current version)
    console.log(`🔌 Building extensions for ${version}`);
    const extResult = buildExtensions(SOURCE_DIR, latestDir, version);
    if (extResult.total === 0) {
      console.log(`   ✓ No extensions defined yet (empty registry created)`);
    } else {
      console.log(`   ✓ Included ${extResult.included}/${extResult.total} extensions: ${extResult.extensions.join(', ') || 'none'}`);
    }

    // Generate bundled schemas for latest
    const bundledDir = path.join(latestDir, 'bundled');
    console.log(`📦 Generating bundled schemas to dist/schemas/latest/bundled/`);
    const { successCount, errorCount } = await generateBundledSchemas(SOURCE_DIR, bundledDir, 'latest');
    console.log(`   ✓ Bundled ${successCount} schemas${errorCount > 0 ? ` (${errorCount} failed)` : ''}`);

    // Generate skill schemas from latest
    generateSkillSchemas(latestDir, 'latest');

    // Note: Version aliases (v2, v2.5, v1) are handled by HTTP middleware
    // No symlinks needed - the server rewrites URLs dynamically

    // Show available paths
    const latestPerMinor = getLatestPatchPerMinor();
    console.log('');
    console.log('✅ Development build complete!');
    console.log('');
    console.log('Available paths:');
    console.log(`   /schemas/latest/           - Development schemas (just rebuilt)`);
    if (latestReleasedVersion) {
      const releasedMajor = getMajorVersion(latestReleasedVersion);
      console.log(`   /schemas/${latestReleasedVersion}/          - Latest release (unchanged)`);
      console.log('');
      console.log('Version aliases (handled by HTTP middleware):');
      console.log(`   /schemas/v${releasedMajor}/              - Major alias → latest ${releasedMajor}.x.x`);
      for (const [minor, patchVersion] of Object.entries(latestPerMinor)) {
        console.log(`   /schemas/v${minor}/            - Minor alias → ${patchVersion}`);
      }
      console.log(`   /schemas/v1/              - Backward compatibility → latest`);
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
