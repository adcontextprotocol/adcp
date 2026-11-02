#!/usr/bin/env node
'use strict';

/**
 * Release-record resolution for the forward-merge workflows
 * (.github/workflows/forward-merge-{3.0,3.1,3.2}.yml).
 *
 * A maintenance line's release records must land on main without losing
 * main's own records. Taking either side wholesale is wrong once main carries
 * its own (pre)release history:
 *
 *   changelog           CHANGELOG.md. Keep main's file and insert each
 *                       `## <version>` block main lacks, in semver order.
 *                       Taking the maintenance copy would delete main's
 *                       prerelease sections (it did for 3.3.0-beta.0 at
 *                       3.2.6, #8429).
 *   published-versions  static/compliance/published-versions.json. Union of
 *                       both manifests' published versions; each newly
 *                       registered version must have its compliance bundle
 *                       in the merged tree.
 *   schema-discovery    dist/schemas/index.json and latest.json. Regenerated
 *                       from the merged dist/schemas/<version>/ directories.
 *                       Taking the maintenance copy would drop main's
 *                       prerelease entries and roll other lines' aliases back.
 *
 * `changelog` and `published-versions` read the conflict stages (:2: ours =
 * main, :3: theirs = the maintenance line) and write the resolved file; the
 * caller stages it. `schema-discovery` rewrites the two pointer files in
 * place. Every command fails loudly rather than guessing.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const semver = require('semver');
const { registerPublishedVersion } = require('./register-published-compliance-version.cjs');
const { validateManifest } = require('./check-published-compliance-versions.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const HEADING_RE = /^## (\S+)[ \t]*$/;

function splitChangelog(text) {
  const lines = text.split('\n');
  const preamble = [];
  const blocks = [];
  for (const line of lines) {
    const match = line.match(HEADING_RE);
    if (match) {
      if (!semver.valid(match[1])) {
        throw new Error(`CHANGELOG heading is not a semver release: ${line}`);
      }
      blocks.push({ version: match[1], lines: [line] });
    } else if (blocks.length === 0) {
      preamble.push(line);
    } else {
      blocks[blocks.length - 1].lines.push(line);
    }
  }
  return { preamble, blocks };
}

/**
 * Main's changelog plus every release block only the maintenance line has,
 * each inserted above the first main block with a lower version. Blocks both
 * sides have keep main's text.
 */
function mergeChangelog(oursText, theirsText) {
  const ours = splitChangelog(oursText);
  const theirs = splitChangelog(theirsText);
  const known = new Set(ours.blocks.map((block) => block.version));
  const blocks = [...ours.blocks];

  for (const block of theirs.blocks) {
    if (known.has(block.version)) continue;
    const index = blocks.findIndex((candidate) => semver.lt(candidate.version, block.version));
    blocks.splice(index === -1 ? blocks.length : index, 0, block);
    known.add(block.version);
  }

  return [...ours.preamble, ...blocks.flatMap((block) => block.lines)].join('\n');
}

/**
 * Main's manifest with every version the maintenance line registered, either
 * for hosted grading (published_versions) or as an SDK opt-in surface
 * (package_only_versions). `bundleExists(version)` must confirm a newly
 * published version's compliance bundle is in the merged tree. Package-only
 * versions are not hosted and need no bundle, matching
 * check-published-compliance-versions.cjs. A version either side publishes is
 * published, never package-only.
 */
function mergePublishedVersions(ours, theirs, bundleExists) {
  let merged = validateManifest(ours);
  validateManifest(theirs);
  for (const version of theirs.published_versions) {
    if (merged.published_versions.includes(version)) continue;
    if (!bundleExists(version)) {
      throw new Error(`Refusing to register ${version}: dist/compliance/${version}/index.json is not in the merged tree`);
    }
    merged = registerPublishedVersion(merged, version);
  }
  const packageOnly = merged.package_only_versions ?? [];
  const added = (theirs.package_only_versions ?? []).filter(
    (version) => !merged.published_versions.includes(version) && !packageOnly.includes(version),
  );
  if (added.length > 0) {
    merged = validateManifest({ ...merged, package_only_versions: [...packageOnly, ...added].sort(semver.compare) });
  }
  return merged;
}

function conflictStage(stage, file) {
  // CHANGELOG.md (~1.4 MB and growing) exceeds execFileSync's 1 MB default buffer.
  return execFileSync('git', ['show', `:${stage}:${file}`], { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

function resolveChangelog(file = 'CHANGELOG.md') {
  const merged = mergeChangelog(conflictStage(2, file), conflictStage(3, file));
  fs.writeFileSync(path.join(REPO_ROOT, file), merged);
}

function resolvePublishedVersions(file = 'static/compliance/published-versions.json') {
  const merged = mergePublishedVersions(
    JSON.parse(conflictStage(2, file)),
    JSON.parse(conflictStage(3, file)),
    (version) => fs.existsSync(path.join(REPO_ROOT, 'dist', 'compliance', version, 'index.json')),
  );
  fs.writeFileSync(path.join(REPO_ROOT, file), JSON.stringify(merged, null, 2) + '\n');
}

function regenerateSchemaDiscovery() {
  require('./build-schemas.cjs').writeRootSchemaDiscovery();
}

const COMMANDS = {
  changelog: resolveChangelog,
  'published-versions': resolvePublishedVersions,
  'schema-discovery': regenerateSchemaDiscovery,
};

if (require.main === module) {
  const [command, ...args] = process.argv.slice(2);
  const run = COMMANDS[command];
  if (!run) {
    console.error(`Usage: forward-merge-release-records.cjs <${Object.keys(COMMANDS).join('|')}> [file]`);
    process.exit(2);
  }
  try {
    run(...args);
  } catch (error) {
    console.error(`::error::forward-merge ${command}: ${error.message}`);
    process.exit(1);
  }
}

module.exports = { mergeChangelog, mergePublishedVersions, splitChangelog };
