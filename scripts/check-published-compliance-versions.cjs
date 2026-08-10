#!/usr/bin/env node

const { execFileSync } = require('node:child_process');
const { existsSync, mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');

const COMPLIANCE_VERSION_RE = /^\d+\.\d+\.\d+(?:-(?:beta|rc)\.\d+)?$/;
const PACKAGED_INDEX_RE = /^package\/compliance\/cache\/([^/]+)\/index\.json$/;

function validateManifest(manifest) {
  if (manifest?.schema_version !== 1) {
    throw new Error('published-versions.json must use schema_version 1');
  }
  if (!Array.isArray(manifest.npm_tags) || manifest.npm_tags.length === 0) {
    throw new Error('published-versions.json must declare at least one npm_tags entry');
  }
  if (!Array.isArray(manifest.published_versions) || manifest.published_versions.length === 0) {
    throw new Error('published-versions.json must declare at least one published_versions entry');
  }

  for (const [field, values] of [
    ['npm_tags', manifest.npm_tags],
    ['published_versions', manifest.published_versions],
  ]) {
    if (values.some(value => typeof value !== 'string' || value.length === 0)) {
      throw new Error(`published-versions.json ${field} entries must be non-empty strings`);
    }
    if (new Set(values).size !== values.length) {
      throw new Error(`published-versions.json ${field} entries must be unique`);
    }
  }

  const invalidVersions = manifest.published_versions.filter(version => !COMPLIANCE_VERSION_RE.test(version));
  if (invalidVersions.length > 0) {
    throw new Error(`Invalid compliance versions in publication manifest: ${invalidVersions.join(', ')}`);
  }

  return manifest;
}

function packagedComplianceVersions(tarListing) {
  const versions = new Set();
  for (const line of String(tarListing).split(/\r?\n/)) {
    const match = PACKAGED_INDEX_RE.exec(line.trim());
    if (match && COMPLIANCE_VERSION_RE.test(match[1])) versions.add(match[1]);
  }
  return versions;
}

function missingPublishedVersions(manifestVersions, packageVersions) {
  const registered = new Set(manifestVersions);
  return [...packageVersions].filter(version => !registered.has(version)).sort();
}

function packSdkTag(tag, destination) {
  const output = execFileSync(
    'npm',
    ['pack', `@adcp/sdk@${tag}`, '--json', '--pack-destination', destination],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
  );
  const result = JSON.parse(output);
  const filename = result?.[0]?.filename;
  if (!filename) throw new Error(`npm pack did not return an archive for @adcp/sdk@${tag}`);

  const archivePath = join(destination, filename);
  const tarListing = execFileSync('tar', ['-tzf', archivePath], { encoding: 'utf8' });
  return packagedComplianceVersions(tarListing);
}

function run() {
  const repoRoot = resolve(__dirname, '..');
  const manifestPath = join(repoRoot, 'static', 'compliance', 'published-versions.json');
  const manifest = validateManifest(JSON.parse(readFileSync(manifestPath, 'utf8')));

  const missingLocalBundles = manifest.published_versions.filter(version => (
    !existsSync(join(repoRoot, 'dist', 'compliance', version, 'index.json'))
  ));
  if (missingLocalBundles.length > 0) {
    throw new Error(
      `Publication manifest references compliance bundles absent from dist/compliance: ${missingLocalBundles.join(', ')}`,
    );
  }

  const destination = mkdtempSync(join(tmpdir(), 'adcp-published-compliance-'));
  try {
    const packageVersions = new Set();
    for (const tag of manifest.npm_tags) {
      for (const version of packSdkTag(tag, destination)) packageVersions.add(version);
    }

    const missing = missingPublishedVersions(manifest.published_versions, packageVersions);
    if (missing.length > 0) {
      throw new Error(
        `Published @adcp/sdk bundles are missing from ${manifestPath}: ${missing.join(', ')}. ` +
        'Update the manifest in the same release integration change.',
      );
    }
  } finally {
    rmSync(destination, { recursive: true, force: true });
  }

  console.log(
    `Published compliance manifest is current for npm tags: ${manifest.npm_tags.join(', ')}.`,
  );
}

if (require.main === module) {
  try {
    run();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

module.exports = {
  missingPublishedVersions,
  packagedComplianceVersions,
  validateManifest,
};
