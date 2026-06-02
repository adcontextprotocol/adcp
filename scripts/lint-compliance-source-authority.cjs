#!/usr/bin/env node
/**
 * Guard the compliance source-of-truth boundary introduced by #5016.
 *
 * `static/compliance/source/` is the canonical authored source. Generated
 * aliases and indexes (`domains/`, `index.json`) belong only in built
 * compliance bundles such as `dist/compliance/latest/` or an SDK cache.
 */

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const SOURCE_DIR = path.join(REPO_ROOT, 'static', 'compliance', 'source');

const CANONICAL_TOP_LEVEL_DIRS = [
  'protocols',
  'specialisms',
  'test-kits',
  'test-vectors',
  'universal',
];

const GENERATED_TOP_LEVEL = new Set(['domains', 'index.json']);
const ALLOWED_TOP_LEVEL = new Set(CANONICAL_TOP_LEVEL_DIRS);

const RULE_MESSAGES = {
  source_missing: ({ sourceDir }) => `canonical compliance source directory is missing: ${sourceDir}`,
  missing_source_dir: ({ entry }) => `canonical compliance source is missing required top-level directory: ${entry}`,
  generated_artifact_in_source: ({ entry }) =>
    `generated compliance artifact ${entry} is present in static/compliance/source; ` +
    'remove it from source and let scripts/build-compliance.cjs generate it in dist/compliance/',
  unknown_top_level: ({ entry }) =>
    `unexpected top-level entry in static/compliance/source: ${entry}. ` +
    `Expected only ${CANONICAL_TOP_LEVEL_DIRS.join(', ')}.`,
  source_empty: () => 'canonical compliance source contains no storyboard YAML files with phases[]',
  missing_in_mirror: ({ file }) => `built compliance mirror is missing source file: ${file}`,
  stale_in_mirror: ({ file }) => `built compliance mirror has stale file not present in source: ${file}`,
  mirror_content_drift: ({ file }) => `built compliance mirror content differs from source: ${file}`,
  missing_generated_index: ({ targetDir }) => `built compliance mirror is missing generated index.json: ${targetDir}`,
  index_json_invalid: ({ targetDir, error }) =>
    `built compliance mirror has invalid index.json in ${targetDir}: ${error}`,
  index_membership_drift: ({ field, expected, actual }) =>
    `built compliance mirror index.json ${field} membership differs from source. ` +
    `Expected [${expected.join(', ')}], got [${actual.join(', ')}]`,
  missing_domains_alias: ({ targetDir }) => `built compliance mirror is missing generated domains/ alias: ${targetDir}`,
  domains_alias_drift: ({ file }) => `generated domains/ alias differs from protocols/ mirror: ${file}`,
};

function relUnix(base, file) {
  return path.relative(base, file).split(path.sep).join('/');
}

function walkFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full));
    else if (entry.isFile()) out.push(full);
  }
  return out.sort((a, b) => a.localeCompare(b));
}

function digest(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function compareDirectories(sourceDir, mirrorDir, { sourceLabel = 'source', mirrorLabel = 'mirror' } = {}) {
  const violations = [];
  const sourceFiles = new Set(walkFiles(sourceDir).map((file) => relUnix(sourceDir, file)));
  const mirrorFiles = new Set(walkFiles(mirrorDir).map((file) => relUnix(mirrorDir, file)));

  for (const file of [...sourceFiles].sort()) {
    const sourceFile = path.join(sourceDir, file);
    const mirrorFile = path.join(mirrorDir, file);
    if (!mirrorFiles.has(file)) {
      violations.push({ rule: 'missing_in_mirror', file, sourceLabel, mirrorLabel });
    } else if (digest(sourceFile) !== digest(mirrorFile)) {
      violations.push({ rule: 'mirror_content_drift', file, sourceLabel, mirrorLabel });
    }
  }

  for (const file of [...mirrorFiles].sort()) {
    if (!sourceFiles.has(file)) {
      violations.push({ rule: 'stale_in_mirror', file, sourceLabel, mirrorLabel });
    }
  }

  return violations;
}

function yamlHasPhases(file) {
  const text = fs.readFileSync(file, 'utf8');
  return /^phases:\s*$/m.test(text);
}

function listDirs(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

function listYamlBasenames(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && (entry.name.endsWith('.yaml') || entry.name.endsWith('.yml')))
    .map((entry) => entry.name.replace(/\.ya?ml$/, ''))
    .sort((a, b) => a.localeCompare(b));
}

function arraysEqual(a, b) {
  if (a.length !== b.length) return false;
  return a.every((item, index) => item === b[index]);
}

function lintIndexMembership(sourceDir, targetDir) {
  const indexPath = path.join(targetDir, 'index.json');
  if (!fs.existsSync(indexPath)) {
    return [{ rule: 'missing_generated_index', targetDir }];
  }

  let index;
  try {
    index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  } catch (err) {
    return [{ rule: 'index_json_invalid', targetDir, error: err.message || String(err) }];
  }

  const expected = {
    universal: listYamlBasenames(path.join(sourceDir, 'universal')),
    protocols: listDirs(path.join(sourceDir, 'protocols')),
    specialisms: listDirs(path.join(sourceDir, 'specialisms')),
  };
  const actual = {
    universal: Array.isArray(index.universal) ? [...index.universal].sort((a, b) => a.localeCompare(b)) : [],
    protocols: Array.isArray(index.protocols)
      ? index.protocols.map((entry) => entry?.id).filter(Boolean).sort((a, b) => a.localeCompare(b))
      : [],
    specialisms: Array.isArray(index.specialisms)
      ? index.specialisms.map((entry) => entry?.id).filter(Boolean).sort((a, b) => a.localeCompare(b))
      : [],
  };

  const violations = [];
  for (const field of Object.keys(expected)) {
    if (!arraysEqual(expected[field], actual[field])) {
      violations.push({
        rule: 'index_membership_drift',
        field,
        expected: expected[field],
        actual: actual[field],
      });
    }
  }
  return violations;
}

function lintSourceAuthority({
  sourceDir = SOURCE_DIR,
  requiredDirs = CANONICAL_TOP_LEVEL_DIRS,
  requireStoryboards = true,
} = {}) {
  const violations = [];

  if (!fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory()) {
    return [{ rule: 'source_missing', sourceDir }];
  }

  const entries = fs.readdirSync(sourceDir, { withFileTypes: true });
  const entryNames = new Set(entries.map((entry) => entry.name));

  for (const entry of requiredDirs) {
    if (!entryNames.has(entry) || !fs.statSync(path.join(sourceDir, entry)).isDirectory()) {
      violations.push({ rule: 'missing_source_dir', entry });
    }
  }

  for (const entry of entries) {
    if (GENERATED_TOP_LEVEL.has(entry.name)) {
      violations.push({ rule: 'generated_artifact_in_source', entry: entry.name });
    } else if (!ALLOWED_TOP_LEVEL.has(entry.name)) {
      violations.push({ rule: 'unknown_top_level', entry: entry.name });
    }
  }

  if (requireStoryboards) {
    const storyboards = walkFiles(sourceDir).filter((file) => {
      const rel = relUnix(sourceDir, file);
      if (!rel.endsWith('.yaml') && !rel.endsWith('.yml')) return false;
      if (rel.startsWith('test-kits/') || rel.startsWith('test-vectors/')) return false;
      if (rel === 'universal/storyboard-schema.yaml') return false;
      return yamlHasPhases(file);
    });
    if (storyboards.length === 0) {
      violations.push({ rule: 'source_empty' });
    }
  }

  return violations;
}

function lintBuiltMirror({ sourceDir = SOURCE_DIR, targetDir }) {
  const violations = [];
  if (!targetDir) throw new Error('lintBuiltMirror requires targetDir');

  for (const entry of CANONICAL_TOP_LEVEL_DIRS) {
    const sourceEntry = path.join(sourceDir, entry);
    const targetEntry = path.join(targetDir, entry);
    if (!fs.existsSync(sourceEntry)) continue;
    violations.push(
      ...compareDirectories(sourceEntry, targetEntry, {
        sourceLabel: `static/compliance/source/${entry}`,
        mirrorLabel: `${targetDir}/${entry}`,
      }).map((violation) => ({ ...violation, file: `${entry}/${violation.file}` })),
    );
  }

  violations.push(...lintIndexMembership(sourceDir, targetDir));

  const protocolsDir = path.join(targetDir, 'protocols');
  const domainsDir = path.join(targetDir, 'domains');
  if (fs.existsSync(protocolsDir)) {
    if (!fs.existsSync(domainsDir)) {
      violations.push({ rule: 'missing_domains_alias', targetDir });
    } else {
      violations.push(
        ...compareDirectories(protocolsDir, domainsDir, {
          sourceLabel: `${targetDir}/protocols`,
          mirrorLabel: `${targetDir}/domains`,
        }).map((violation) => ({ rule: 'domains_alias_drift', file: violation.file })),
      );
    }
  }

  return violations;
}

function formatViolation(violation) {
  const format = RULE_MESSAGES[violation.rule];
  return format ? format(violation) : violation.rule;
}

function main() {
  const args = process.argv.slice(2);
  let sourceDir = SOURCE_DIR;
  let targetDir = null;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--source') {
      sourceDir = path.resolve(args[++i]);
    } else if (arg === '--target') {
      targetDir = path.resolve(args[++i]);
    } else if (arg === '--dist-latest') {
      targetDir = path.join(REPO_ROOT, 'dist', 'compliance', 'latest');
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  const violations = [
    ...lintSourceAuthority({ sourceDir }),
    ...(targetDir ? lintBuiltMirror({ sourceDir, targetDir }) : []),
  ];

  if (violations.length === 0) {
    const suffix = targetDir ? ` and ${targetDir} mirrors it` : '';
    console.log(`✓ compliance source authority lint: static/compliance/source is canonical${suffix}`);
    return;
  }

  console.error(`✗ compliance source authority lint: ${violations.length} violation(s)\n`);
  for (const violation of violations) {
    console.error(`  ${violation.rule}: ${formatViolation(violation)}`);
  }
  process.exit(1);
}

if (require.main === module) main();

module.exports = {
  CANONICAL_TOP_LEVEL_DIRS,
  RULE_MESSAGES,
  compareDirectories,
  formatViolation,
  lintIndexMembership,
  lintBuiltMirror,
  lintSourceAuthority,
};
