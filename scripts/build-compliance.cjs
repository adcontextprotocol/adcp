#!/usr/bin/env node

/**
 * Build script for AdCP compliance artifacts (specialisms, domain baselines,
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
 * Source of truth for specialism → domain mapping is the `domain:` field in
 * each specialisms/{id}/index.yaml. This build fails loudly if any specialism
 * is missing `domain:` or if the filesystem layout drifts from
 * static/schemas/source/enums/specialism.json.
 *
 * Published paths:
 * - /compliance/latest/                       - Current development snapshot
 * - /compliance/{version}/                    - Released version (pin for production)
 * - /compliance/{version}/universal/          - Mandatory for every agent
 * - /compliance/{version}/domains/{domain}/   - Required to claim domains
 * - /compliance/{version}/specialisms/{id}/   - Optional specialization claims
 * - /compliance/{version}/test-kits/          - Brand fixtures for runs
 * - /compliance/{version}/index.json          - Enumerates domains + specialism IDs
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const SOURCE_DIR = path.join(__dirname, '../static/compliance/source');
const DIST_DIR = path.join(__dirname, '../dist/compliance');
const PACKAGE_JSON = path.join(__dirname, '../package.json');
const SPECIALISM_ENUM = path.join(__dirname, '../static/schemas/source/enums/specialism.json');
const DOMAIN_ENUM = path.join(__dirname, '../static/schemas/source/enums/adcp-domain.json');

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
  const content = fs.readFileSync(filePath, 'utf8');
  const out = {};
  for (const line of content.split('\n')) {
    const m = line.match(/^([a-z_]+):\s*(.*)$/);
    if (!m) continue;
    const [, key, rawValue] = m;
    if (['id', 'domain', 'title', 'role', 'track'].includes(key)) {
      out[key] = rawValue.replace(/^["']|["']$/g, '').trim();
    }
    if (Object.keys(out).length >= 5) break;
  }
  return out;
}

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
    if (!fm.domain) {
      throw new Error(
        `Specialism "${entry.name}" has no 'domain:' field in index.yaml. ` +
        `Every specialism must declare its parent domain (media-buy, creative, signals, governance, brand, sponsored-intelligence).`
      );
    }
    items.push({
      id: entry.name,
      domain: fm.domain,
      title: fm.title || null,
      path: `specialisms/${entry.name}/`
    });
  }
  return items.sort((a, b) => a.id.localeCompare(b.id));
}

function discoverDomains(sourceDir, specialisms) {
  const domainsDir = path.join(sourceDir, 'domains');
  const ids = new Set();

  if (fs.existsSync(domainsDir)) {
    for (const entry of fs.readdirSync(domainsDir, { withFileTypes: true })) {
      if (entry.isDirectory()) ids.add(entry.name);
    }
  }
  for (const s of specialisms) {
    if (s.domain) ids.add(s.domain);
  }

  const items = [];
  for (const id of ids) {
    const indexPath = path.join(domainsDir, id, 'index.yaml');
    const fm = fs.existsSync(indexPath) ? readYamlFrontmatter(indexPath) : {};
    items.push({
      id,
      title: fm.title || null,
      has_baseline: fs.existsSync(indexPath),
      path: `domains/${id}/`
    });
  }
  return items.sort((a, b) => a.id.localeCompare(b.id));
}

function verifyEnumParity(specialisms, domains) {
  const fsSpecialisms = new Set(specialisms.map(s => s.id));
  const fsDomains = new Set(domains.map(d => d.id));

  const specialismEnum = JSON.parse(fs.readFileSync(SPECIALISM_ENUM, 'utf8'));
  const domainEnum = JSON.parse(fs.readFileSync(DOMAIN_ENUM, 'utf8'));

  const enumSpecialisms = new Set(specialismEnum.enum);
  const enumDomains = new Set(domainEnum.enum);

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

  const domainDrift = [...fsDomains].filter(x => !enumDomains.has(x));
  if (domainDrift.length) {
    throw new Error(
      `Domain drift: compliance filesystem declares domains not listed in adcp-domain.json: ${domainDrift.join(', ')}`
    );
  }

  const unknownDomainRefs = specialisms
    .filter(s => !enumDomains.has(s.domain))
    .map(s => `${s.id} → ${s.domain}`);
  if (unknownDomainRefs.length) {
    throw new Error(
      `Specialisms reference domains not in adcp-domain.json enum: ${unknownDomainRefs.join(', ')}`
    );
  }
}

function generateIndex(version, sourceDir) {
  const specialisms = discoverSpecialisms(sourceDir);
  const domains = discoverDomains(sourceDir, specialisms);
  verifyEnumParity(specialisms, domains);
  const universalDir = path.join(sourceDir, 'universal');
  const universal = fs.existsSync(universalDir)
    ? fs.readdirSync(universalDir)
        .filter(f => f.endsWith('.yaml'))
        .map(f => f.replace(/\.yaml$/, ''))
        .sort()
    : [];

  return {
    adcp_version: version,
    generated_at: new Date().toISOString(),
    universal,
    domains: domains.map(d => ({ id: d.id, title: d.title, has_baseline: d.has_baseline, path: d.path })),
    specialisms: specialisms.map(s => ({
      id: s.id,
      domain: s.domain,
      title: s.title,
      path: s.path
    }))
  };
}

function buildTo(targetDir, version, sourceDir) {
  if (fs.existsSync(targetDir)) {
    fs.rmSync(targetDir, { recursive: true, force: true });
  }
  ensureDir(targetDir);
  copyTree(sourceDir, targetDir);
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

  ensureDir(DIST_DIR);

  if (isRelease) {
    const versionDir = path.join(DIST_DIR, version);
    console.log(`📋 Creating release: dist/compliance/${version}/`);
    const index = buildTo(versionDir, version, SOURCE_DIR);
    console.log(`   ✓ ${index.universal.length} universal, ${index.domains.length} domains, ${index.specialisms.length} specialisms`);

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
    console.log(`   ✓ ${index.universal.length} universal, ${index.domains.length} domains, ${index.specialisms.length} specialisms`);

    console.log('');
    console.log('✅ Development build complete!');
  }
}

main();
