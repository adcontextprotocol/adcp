#!/usr/bin/env node

/**
 * Build script for the protocol tarball: a single gzipped bundle per AdCP
 * version containing schemas + compliance + openapi + changelog. Clients
 * (adcp-client, reference agents, etc.) pull one file per version instead of
 * thousands of individual requests.
 *
 * Published paths:
 * - /protocol/{version}.tgz         - Pinned version bundle
 * - /protocol/{version}.tgz.sha256  - Checksum sidecar
 * - /protocol/latest.tgz            - Current development snapshot
 *
 * Tarball layout (every entry is under a single root directory so
 * `tar xzf` creates a safe tarbomb-free extraction):
 *
 *   adcp-{version}/
 *     README.md
 *     CHANGELOG.md
 *     manifest.json
 *     schemas/...
 *     compliance/...
 *     openapi/registry.yaml
 *
 * Usage mirrors build-schemas.cjs:
 * - `npm run build:protocol-tarball`            → writes dist/protocol/latest.tgz
 * - `npm run build:protocol-tarball -- --release` → also writes dist/protocol/{version}.tgz
 *
 * Runs after build:schemas and build:compliance so their dist/ outputs are
 * current.
 */

const fs = require('fs');
const path = require('path');
const tar = require('tar');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DIST_SCHEMAS = path.join(ROOT, 'dist/schemas');
const DIST_COMPLIANCE = path.join(ROOT, 'dist/compliance');
const OPENAPI_FILE = path.join(ROOT, 'static/openapi/registry.yaml');
const CHANGELOG_FILE = path.join(ROOT, 'CHANGELOG.md');
const OUT_DIR = path.join(ROOT, 'dist/protocol');
const PACKAGE_JSON = path.join(ROOT, 'package.json');

const args = process.argv.slice(2);
const isRelease = args.includes('--release');

function getVersion() {
  return JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8')).version;
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function copyTree(srcDir, dstDir) {
  ensureDir(dstDir);
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const src = path.join(srcDir, entry.name);
    const dst = path.join(dstDir, entry.name);
    if (entry.isDirectory()) copyTree(src, dst);
    else fs.copyFileSync(src, dst);
  }
}

function sha256(filePath) {
  const hash = require('crypto').createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function walk(dir, base = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, base));
    else out.push(path.relative(base, full));
  }
  return out;
}

function writeBundleReadme(bundleDir, version) {
  const readme = `# AdCP Protocol Bundle

This tarball contains the complete AdCP protocol for version \`${version}\`:

- \`schemas/\` — JSON Schemas for every task (request + response)
- \`compliance/\` — Storyboard bundles (universal, domains/, specialisms/, test-kits/)
- \`openapi/registry.yaml\` — OpenAPI description of the registry endpoints
- \`manifest.json\` — Version + contents summary
- \`CHANGELOG.md\` — Release notes

## Quick start

\`\`\`bash
# Pull and verify this exact version
curl -OL https://adcontextprotocol.org/protocol/${version}.tgz
curl -OL https://adcontextprotocol.org/protocol/${version}.tgz.sha256
shasum -a 256 -c ${version}.tgz.sha256
tar xzf ${version}.tgz
cd adcp-${version}
\`\`\`

## Validate an agent

\`\`\`bash
npx @adcp/client storyboard run https://my-agent.example.com
\`\`\`

The CLI uses the same \`compliance/\` tree bundled here. For offline runs, point it at
the extracted directory (see @adcp/client docs).

## What's in the bundle

See \`manifest.json\` for the generated file count, and \`compliance/index.json\`
for the enumerated domains + specialisms that agents can claim in
\`get_adcp_capabilities\`.

## Layout stability

The directory structure inside \`adcp-{version}/\` (\`schemas/\`, \`compliance/\`,
\`openapi/\`, \`manifest.json\`) is a stable contract within a given major
version. Renames or moves inside this tree are breaking changes and only ship
with a major bump.

## Docs

- https://adcontextprotocol.org/docs/building/schemas-and-sdks
- https://adcontextprotocol.org/docs/building/validate-your-agent
`;
  fs.writeFileSync(path.join(bundleDir, 'README.md'), readme);
}

async function buildTarball(label, stagingRoot, rootDirName, outFile) {
  await tar.create(
    {
      gzip: { level: 9 },
      file: outFile,
      cwd: stagingRoot,
      portable: true
    },
    [rootDirName]
  );
  const size = fs.statSync(outFile).size;
  console.log(`   ✓ ${label}: ${outFile.replace(ROOT + '/', '')} (${(size / 1024).toFixed(1)} KB)`);
}

function stageBundle(bundleParent, version, schemasSource, rootDirName) {
  if (fs.existsSync(bundleParent)) fs.rmSync(bundleParent, { recursive: true, force: true });
  ensureDir(bundleParent);
  const bundleDir = path.join(bundleParent, rootDirName);
  ensureDir(bundleDir);

  const schemasDst = path.join(bundleDir, 'schemas');
  copyTree(schemasSource, schemasDst);

  const complianceSource = path.join(DIST_COMPLIANCE, version);
  if (!fs.existsSync(complianceSource)) {
    throw new Error(`Compliance not built for version ${version}: ${complianceSource}`);
  }
  copyTree(complianceSource, path.join(bundleDir, 'compliance'));

  if (fs.existsSync(OPENAPI_FILE)) {
    const openapiDst = path.join(bundleDir, 'openapi');
    ensureDir(openapiDst);
    fs.copyFileSync(OPENAPI_FILE, path.join(openapiDst, 'registry.yaml'));
  }

  if (fs.existsSync(CHANGELOG_FILE)) {
    fs.copyFileSync(CHANGELOG_FILE, path.join(bundleDir, 'CHANGELOG.md'));
  }

  writeBundleReadme(bundleDir, version);

  const fileCount = walk(bundleDir).length;
  const manifest = {
    adcp_version: version,
    generated_at: new Date().toISOString(),
    root_dir: rootDirName,
    contents: {
      schemas: fs.existsSync(schemasDst),
      compliance: fs.existsSync(path.join(bundleDir, 'compliance')),
      openapi: fs.existsSync(path.join(bundleDir, 'openapi')),
      changelog: fs.existsSync(path.join(bundleDir, 'CHANGELOG.md')),
      readme: true
    },
    file_count: fileCount + 1
  };
  fs.writeFileSync(
    path.join(bundleDir, 'manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n'
  );
  return manifest;
}

async function main() {
  const version = getVersion();

  console.log(isRelease
    ? `🚀 RELEASE BUILD: Creating protocol tarball for AdCP v${version}`
    : `📦 Development build: Creating latest protocol tarball`);
  console.log('');

  ensureDir(OUT_DIR);

  const stagingRoot = path.join(OUT_DIR, '.staging');
  ensureDir(stagingRoot);

  const latestSchemas = path.join(DIST_SCHEMAS, 'latest');
  if (!fs.existsSync(latestSchemas)) {
    console.error(`❌ dist/schemas/latest not found. Run npm run build:schemas first.`);
    process.exit(1);
  }

  if (isRelease) {
    const versionSchemas = path.join(DIST_SCHEMAS, version);
    if (!fs.existsSync(versionSchemas)) {
      console.error(`❌ dist/schemas/${version} not found. Run npm run build:schemas -- --release first.`);
      process.exit(1);
    }

    console.log(`📋 Staging bundle for ${version}`);
    const versionStage = path.join(stagingRoot, version);
    const versionRoot = `adcp-${version}`;
    const manifest = stageBundle(versionStage, version, versionSchemas, versionRoot);
    console.log(`   ✓ manifest: ${manifest.file_count} files, root: ${manifest.root_dir}`);

    const versionTar = path.join(OUT_DIR, `${version}.tgz`);
    await buildTarball(`version tarball`, versionStage, versionRoot, versionTar);
    fs.writeFileSync(versionTar + '.sha256', `${sha256(versionTar)}  ${version}.tgz\n`);

    console.log(`📋 Staging latest bundle (mirrors release)`);
    const latestStage = path.join(stagingRoot, 'latest');
    stageBundle(latestStage, version, versionSchemas, versionRoot);
    const latestTar = path.join(OUT_DIR, `latest.tgz`);
    await buildTarball(`latest tarball`, latestStage, versionRoot, latestTar);
    fs.writeFileSync(latestTar + '.sha256', `${sha256(latestTar)}  latest.tgz\n`);

    console.log(`📝 Staging dist/protocol/${version}.tgz for git commit`);
    try {
      execSync(`git add dist/protocol/${version}.tgz dist/protocol/${version}.tgz.sha256`, {
        cwd: ROOT,
        stdio: 'inherit'
      });
    } catch {
      console.log(`   (git add skipped — not in git context)`);
    }
  } else {
    console.log(`📋 Staging latest bundle`);
    const latestStage = path.join(stagingRoot, 'latest');
    const latestRoot = `adcp-latest`;
    const manifest = stageBundle(latestStage, 'latest', latestSchemas, latestRoot);
    console.log(`   ✓ manifest: ${manifest.file_count} files, root: ${manifest.root_dir}`);
    const latestTar = path.join(OUT_DIR, `latest.tgz`);
    await buildTarball(`latest tarball`, latestStage, latestRoot, latestTar);
    fs.writeFileSync(latestTar + '.sha256', `${sha256(latestTar)}  latest.tgz\n`);
  }

  fs.rmSync(stagingRoot, { recursive: true, force: true });

  console.log('');
  console.log(isRelease ? '✅ Release tarball complete!' : '✅ Development tarball complete!');
  console.log('');
  console.log('Published paths:');
  if (isRelease) {
    console.log(`   /protocol/${version}.tgz         - Pinned version bundle`);
    console.log(`   /protocol/${version}.tgz.sha256  - Checksum sidecar`);
  }
  console.log(`   /protocol/latest.tgz         - Development bundle`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
