#!/usr/bin/env node

/**
 * Build script for AdCP schema versioning
 *
 * This script copies schemas from static/schemas/source to dist/schemas/{version}
 * and updates all $id and $ref fields to include the version path.
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

      // Update $id and $ref fields to include version
      content = content.replace(
        /"\$id":\s*"\/schemas\//g,
        `"$id": "/schemas/${version}/`
      );
      content = content.replace(
        /"\$ref":\s*"\/schemas\//g,
        `"$ref": "/schemas/${version}/`
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

function main() {
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
  console.log(`   /schemas/${version}/          - Exact version`);
  console.log(`   /schemas/v${majorVersion}/              - Latest v${majorVersion}.x release`);
  console.log(`   /schemas/v${minorVersion}/            - Latest v${minorVersion}.x patch`);
  console.log(`   /schemas/v1/              - Backward compatibility (same as v${majorVersion})`);
  console.log(`   /schemas/latest/           - Latest release`);
}

main();
