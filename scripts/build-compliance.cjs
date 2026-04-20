#!/usr/bin/env node

/**
 * Build script for AdCP compliance artifacts (specialisms, protocol baselines,
 * universal compliance, test-kits).
 *
 * Mirrors scripts/build-schemas.cjs pattern:
 *
 * 1. Development build (default): `npm run build:compliance`
 *    - Rebuilds only dist/compliance/latest/ with current source YAMLs
 *    - Preserves existing released version directories
 *
 * 2. Release build: `npm run build:compliance -- --release`
 *    - Creates a new versioned directory (e.g., dist/compliance/3.1.0/)
 *    - Also updates latest/ to match the release
 *
 * Source of truth for specialism → protocol mapping is the `protocol:` field in
 * each specialisms/{id}/index.yaml. This build fails loudly if any specialism
 * is missing `protocol:` or if the filesystem layout drifts from
 * static/schemas/source/enums/specialism.json.
 *
 * Published paths:
 * - /compliance/latest/                           - Current development snapshot
 * - /compliance/{version}/                        - Released version (pin for production)
 * - /compliance/{version}/universal/              - Mandatory for every agent
 * - /compliance/{version}/protocols/{protocol}/   - Required to claim protocols
 * - /compliance/{version}/specialisms/{id}/       - Optional specialization claims
 * - /compliance/{version}/test-kits/              - Brand fixtures for runs
 * - /compliance/{version}/index.json              - Enumerates protocols + specialism IDs
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { execSync } = require('child_process');
const { lintScoping, formatReport } = require('./lint-storyboard-scoping.cjs');

const SOURCE_DIR = path.join(__dirname, '../static/compliance/source');
const DIST_DIR = path.join(__dirname, '../dist/compliance');
const PACKAGE_JSON = path.join(__dirname, '../package.json');
const SPECIALISM_ENUM = path.join(__dirname, '../static/schemas/source/enums/specialism.json');
const PROTOCOL_ENUM = path.join(__dirname, '../static/schemas/source/enums/adcp-protocol.json');

const args = process.argv.slice(2);
const isRelease = args.includes('--release');

function getVersion() {
  const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8'));
  return pkg.version;
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function copyTree(srcDir, dstDir) {
  ensureDir(dstDir);
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const src = path.join(srcDir, entry.name);
    const dst = path.join(dstDir, entry.name);
    if (entry.isDirectory()) {
      copyTree(src, dst);
    } else {
      fs.copyFileSync(src, dst);
    }
  }
}

function readYamlFrontmatter(filePath) {
  const doc = yaml.load(fs.readFileSync(filePath, 'utf8'));
  if (doc == null || typeof doc !== 'object') return {};
  const out = {};
  for (const key of ['id', 'protocol', 'title', 'role', 'track', 'status']) {
    if (doc[key] != null) out[key] = String(doc[key]).trim();
  }
  if (doc.required_tools != null) {
    if (!Array.isArray(doc.required_tools)) {
      throw new Error(
        `required_tools in ${filePath} must be a YAML list, got ${typeof doc.required_tools}`
      );
    }
    out.required_tools = doc.required_tools.map(t => String(t).trim()).filter(Boolean);
  }
  return out;
}

const VALID_STATUSES = new Set(['stable', 'preview', 'deprecated']);

function discoverSpecialisms(sourceDir) {
  const specialismsDir = path.join(sourceDir, 'specialisms');
  if (!fs.existsSync(specialismsDir)) return [];

  const items = [];
  for (const entry of fs.readdirSync(specialismsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const indexPath = path.join(specialismsDir, entry.name, 'index.yaml');
    if (!fs.existsSync(indexPath)) {
      throw new Error(`Specialism "${entry.name}" is missing index.yaml at ${indexPath}`);
    }
    const fm = readYamlFrontmatter(indexPath);
    if (!fm.protocol) {
      throw new Error(
        `Specialism "${entry.name}" has no 'protocol:' field in index.yaml. ` +
        `Every specialism must declare its parent protocol (media-buy, creative, signals, governance, brand, sponsored-intelligence).`
      );
    }
    const status = fm.status || 'stable';
    if (!VALID_STATUSES.has(status)) {
      throw new Error(
        `Specialism "${entry.name}" has invalid status "${status}". Valid values: ${[...VALID_STATUSES].join(', ')}.`
      );
    }
    const required_tools = fm.required_tools || [];
    if (status === 'stable' && required_tools.length === 0) {
      throw new Error(
        `Specialism "${entry.name}" has status: stable but no required_tools declared. ` +
        `Stable specialisms must list the tool families they exercise so /compliance/{version}/index.json ` +
        `surfaces discoverability. Add a required_tools list to ${indexPath} or mark the specialism as preview.`
      );
    }
    items.push({
      id: entry.name,
      protocol: fm.protocol,
      title: fm.title || null,
      status,
      required_tools,
      path: `specialisms/${entry.name}/`
    });
  }
  return items.sort((a, b) => a.id.localeCompare(b.id));
}

function discoverProtocols(sourceDir, specialisms) {
  const protocolsDir = path.join(sourceDir, 'protocols');
  const ids = new Set();

  if (fs.existsSync(protocolsDir)) {
    for (const entry of fs.readdirSync(protocolsDir, { withFileTypes: true })) {
      if (entry.isDirectory()) ids.add(entry.name);
    }
  }
  for (const s of specialisms) {
    if (s.protocol) ids.add(s.protocol);
  }

  const items = [];
  for (const id of ids) {
    const indexPath = path.join(protocolsDir, id, 'index.yaml');
    const fm = fs.existsSync(indexPath) ? readYamlFrontmatter(indexPath) : {};
    items.push({
      id,
      title: fm.title || null,
      has_baseline: fs.existsSync(indexPath),
      path: `protocols/${id}/`
    });
  }
  return items.sort((a, b) => a.id.localeCompare(b.id));
}

function verifyEnumParity(specialisms, protocols) {
  const fsSpecialisms = new Set(specialisms.map(s => s.id));
  const fsProtocols = new Set(protocols.map(d => d.id));

  const specialismEnum = JSON.parse(fs.readFileSync(SPECIALISM_ENUM, 'utf8'));
  const protocolEnum = JSON.parse(fs.readFileSync(PROTOCOL_ENUM, 'utf8'));

  const enumSpecialisms = new Set(specialismEnum.enum);
  const enumProtocols = new Set(protocolEnum.enum);

  const missingFromEnum = [...fsSpecialisms].filter(x => !enumSpecialisms.has(x));
  const missingFromFs = [...enumSpecialisms].filter(x => !fsSpecialisms.has(x));
  if (missingFromEnum.length || missingFromFs.length) {
    const msg = [
      `Specialism enum drift between filesystem and specialism.json:`,
      missingFromEnum.length ? `  In filesystem but missing from enum: ${missingFromEnum.join(', ')}` : '',
      missingFromFs.length ? `  In enum but missing from filesystem: ${missingFromFs.join(', ')}` : ''
    ].filter(Boolean).join('\n');
    throw new Error(msg);
  }

  const protocolDrift = [...fsProtocols].filter(x => !enumProtocols.has(x));
  if (protocolDrift.length) {
    throw new Error(
      `Protocol drift: compliance filesystem declares protocols not listed in adcp-protocol.json: ${protocolDrift.join(', ')}`
    );
  }

  const unknownProtocolRefs = specialisms
    .filter(s => !enumProtocols.has(s.protocol))
    .map(s => `${s.id} → ${s.protocol}`);
  if (unknownProtocolRefs.length) {
    throw new Error(
      `Specialisms reference protocols not in adcp-protocol.json enum: ${unknownProtocolRefs.join(', ')}`
    );
  }
}

function generateIndex(version, sourceDir) {
  const specialisms = discoverSpecialisms(sourceDir);
  const protocols = discoverProtocols(sourceDir, specialisms);
  verifyEnumParity(specialisms, protocols);
  const universalDir = path.join(sourceDir, 'universal');
  const universal = fs.existsSync(universalDir)
    ? fs.readdirSync(universalDir)
        .filter(f => f.endsWith('.yaml'))
        .map(f => f.replace(/\.yaml$/, ''))
        .sort()
    : [];

  const protocolEntries = protocols.map(d => ({
    id: d.id,
    title: d.title,
    has_baseline: d.has_baseline,
    path: d.path,
  }));
  // Transitional alias for @adcp/client@5.x consumers that read `domains` and expect
  // `domains/{id}/` on-disk paths. Drop after v6 ships and all consumers upgrade.
  const domainAliasEntries = protocols.map(d => ({
    id: d.id,
    title: d.title,
    has_baseline: d.has_baseline,
    path: d.path.replace(/^protocols\//, 'domains/'),
  }));

  return {
    adcp_version: version,
    generated_at: new Date().toISOString(),
    universal,
    protocols: protocolEntries,
    domains: domainAliasEntries,
    specialisms: specialisms.map(s => ({
      id: s.id,
      protocol: s.protocol,
      domain: s.protocol,
      title: s.title,
      status: s.status,
      required_tools: s.required_tools,
      path: s.path
    }))
  };
}

function mirrorProtocolsToDomains(targetDir) {
  const protocolsDir = path.join(targetDir, 'protocols');
  const domainsDir = path.join(targetDir, 'domains');
  if (!fs.existsSync(protocolsDir)) return;
  copyTree(protocolsDir, domainsDir);
}

function buildTo(targetDir, version, sourceDir) {
  if (fs.existsSync(targetDir)) {
    fs.rmSync(targetDir, { recursive: true, force: true });
  }
  ensureDir(targetDir);
  copyTree(sourceDir, targetDir);
  mirrorProtocolsToDomains(targetDir);
  const index = generateIndex(version, sourceDir);
  fs.writeFileSync(
    path.join(targetDir, 'index.json'),
    JSON.stringify(index, null, 2) + '\n'
  );
  return index;
}

function main() {
  const version = getVersion();

  if (!fs.existsSync(SOURCE_DIR)) {
    console.error(`❌ Source directory not found: ${SOURCE_DIR}`);
    process.exit(1);
  }

  console.log(isRelease
    ? `🚀 RELEASE BUILD: Creating compliance artifacts for AdCP v${version}`
    : `📦 Development build: Updating latest/ compliance`);
  console.log(`   Source: ${SOURCE_DIR}`);
  console.log(`   Target: ${DIST_DIR}`);
  console.log('');

  // Lint storyboard scoping (fail fast before copying anything to dist).
  const violations = lintScoping(SOURCE_DIR);
  if (violations.length > 0) {
    process.stderr.write(formatReport(violations));
    process.exit(1);
  }

  ensureDir(DIST_DIR);

  if (isRelease) {
    const versionDir = path.join(DIST_DIR, version);
    console.log(`📋 Creating release: dist/compliance/${version}/`);
    const index = buildTo(versionDir, version, SOURCE_DIR);
    console.log(`   ✓ ${index.universal.length} universal, ${index.protocols.length} protocols, ${index.specialisms.length} specialisms`);

    console.log(`📋 Updating latest/ to match release`);
    buildTo(path.join(DIST_DIR, 'latest'), 'latest', SOURCE_DIR);

    console.log(`📝 Staging dist/compliance/${version}/ for git commit`);
    try {
      execSync(`git add dist/compliance/${version}/`, {
        cwd: path.join(__dirname, '..'),
        stdio: 'inherit'
      });
    } catch {
      console.log(`   (git add skipped — not in git context)`);
    }

    console.log('');
    console.log('✅ Release build complete!');
  } else {
    const latestDir = path.join(DIST_DIR, 'latest');
    console.log(`📋 Building compliance to dist/compliance/latest/`);
    const index = buildTo(latestDir, 'latest', SOURCE_DIR);
    console.log(`   ✓ ${index.universal.length} universal, ${index.protocols.length} protocols, ${index.specialisms.length} specialisms`);

    console.log('');
    console.log('✅ Development build complete!');
  }
}

main();
