#!/usr/bin/env node

/**
 * Ship a stable release over a permanently withdrawn version number.
 *
 * On 2026-06-30 an accidental Version Packages cut committed 3.2.0 from
 * 3.1-era main. #5769 reverted it, but its signed artifacts were already on
 * the artifact CDN with year-long immutable caching, and exposed bytes are
 * never overwritten or retired. Exiting Changesets pre mode would compute
 * 3.2.0 again, and the release workflow would then collide with those bytes
 * after tagging.
 *
 * A reviewed `.changeset/withdrawn-release.json` marker binds the withdrawn
 * version to its exact accidental release commit, the revert, the exposed
 * protocol-tarball digest, and a reason. While Changesets is in ordinary pre
 * mode the marker is verified and left in place. On the pre-exit cut, the
 * Version Packages step lets Changesets consume the complete pool and compute
 * the withdrawn version, then retitles that changelog block and moves the
 * package to the reviewed next patch. Any mismatch fails closed.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import semver from 'semver';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
export const markerRelativePath = '.changeset/withdrawn-release.json';
const MARKER_KEYS = [
  'reason',
  'revert_commit',
  'target_version',
  'withdrawn_protocol_sha256',
  'withdrawn_release_commit',
  'withdrawn_version',
];
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const CHANGELOG_TITLE = '# Changelog\n\n';

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function readPreState(root) {
  const path = resolve(root, '.changeset/pre.json');
  return existsSync(path) ? readJson(path) : null;
}

function packageVersion(root) {
  return readJson(resolve(root, 'package.json')).version;
}

export function markerExists(root = repoRoot) {
  return existsSync(resolve(root, markerRelativePath));
}

export function readMarker(root = repoRoot) {
  const path = resolve(root, markerRelativePath);
  if (!existsSync(path)) {
    throw new Error(`Missing reviewed ${markerRelativePath} marker.`);
  }
  return validateMarkerShape(readJson(path));
}

export function validateMarkerShape(marker) {
  if (
    !marker
    || typeof marker !== 'object'
    || Array.isArray(marker)
    || JSON.stringify(Object.keys(marker).sort()) !== JSON.stringify(MARKER_KEYS)
  ) {
    throw new Error(`${markerRelativePath} has an unexpected shape; expected exactly ${MARKER_KEYS.join(', ')}.`);
  }
  const withdrawn = semver.valid(marker.withdrawn_version);
  if (!withdrawn || withdrawn !== marker.withdrawn_version || semver.prerelease(withdrawn)) {
    throw new Error('Withdrawn-release marker must name an exact stable withdrawn_version.');
  }
  if (marker.target_version !== semver.inc(withdrawn, 'patch')) {
    throw new Error(
      `Withdrawn-release target_version must be the next patch after ${withdrawn} (${semver.inc(withdrawn, 'patch')}).`,
    );
  }
  if (!SHA_PATTERN.test(marker.withdrawn_release_commit || '') || !SHA_PATTERN.test(marker.revert_commit || '')) {
    throw new Error('Withdrawn-release marker requires full withdrawn_release_commit and revert_commit SHAs.');
  }
  if (!DIGEST_PATTERN.test(marker.withdrawn_protocol_sha256 || '')) {
    throw new Error('Withdrawn-release marker requires the exposed protocol tarball SHA-256.');
  }
  if (typeof marker.reason !== 'string' || marker.reason.trim().length < 40) {
    throw new Error('Withdrawn-release marker requires a concrete reviewed reason.');
  }
  return marker;
}

function gitRunner(root) {
  return (...args) => execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  }).trim();
}

function releaseSurfaces(version) {
  return [
    `dist/schemas/${version}`,
    `dist/compliance/${version}`,
    ...['', '.sha256', '.sig', '.crt'].map((suffix) => `dist/protocol/${version}.tgz${suffix}`),
  ];
}

/**
 * Local, offline proof that the marker names the real accidental cut and its
 * revert, and that the withdrawn number was never re-committed.
 */
export function verifyWithdrawnHistory(root, marker) {
  const git = gitRunner(root);
  const version = marker.withdrawn_version;
  for (const commit of [marker.withdrawn_release_commit, marker.revert_commit]) {
    try {
      git('merge-base', '--is-ancestor', commit, 'HEAD');
    } catch {
      throw new Error(`Withdrawn-release commit ${commit} is not an ancestor of HEAD.`);
    }
  }
  const releasedVersion = JSON.parse(git('show', `${marker.withdrawn_release_commit}:package.json`)).version;
  if (releasedVersion !== version) {
    throw new Error(`withdrawn_release_commit commits ${releasedVersion}, not ${version}.`);
  }
  const revertParent = git('rev-parse', `${marker.revert_commit}^1`);
  if (revertParent !== marker.withdrawn_release_commit) {
    throw new Error('revert_commit must directly revert withdrawn_release_commit (first parent mismatch).');
  }
  const revertedVersion = JSON.parse(git('show', `${marker.revert_commit}:package.json`)).version;
  if (revertedVersion === version) {
    throw new Error(`revert_commit still commits ${version}.`);
  }
  const tarball = execFileSync('git', ['show', `${marker.withdrawn_release_commit}:dist/protocol/${version}.tgz`], {
    cwd: root,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (createHash('sha256').update(tarball).digest('hex') !== marker.withdrawn_protocol_sha256) {
    throw new Error(`Withdrawn ${version} protocol tarball does not match the reviewed digest.`);
  }
  for (const surface of releaseSurfaces(version)) {
    if (existsSync(resolve(root, surface))) {
      throw new Error(`Withdrawn ${version} artifact ${surface} is present in the working tree.`);
    }
  }
  const target = marker.target_version;
  for (const surface of releaseSurfaces(target)) {
    if (existsSync(resolve(root, surface))) {
      throw new Error(`Target ${target} artifact ${surface} already exists.`);
    }
  }
}

/**
 * The withdrawn number must stay non-selectable in generated discovery and
 * the CDN worker so it can never win latest_stable or a v3 / v3.x alias.
 * (server/src/schemas-middleware.ts is covered by the drift test.)
 */
export async function verifyNonSelectable(root, marker) {
  const require = createRequire(import.meta.url);
  const buildSchemas = require(resolve(root, 'scripts/build-schemas.cjs'));
  const worker = await import(pathToFileURL(resolve(root, 'workers/artifact-cdn/src/index.js')).href);
  for (const [surface, isSelectable] of [
    ['scripts/build-schemas.cjs', buildSchemas.isSelectableRelease],
    ['workers/artifact-cdn/src/index.js', worker.isSelectableRelease],
  ]) {
    if (typeof isSelectable !== 'function') {
      throw new Error(`${surface} does not export isSelectableRelease.`);
    }
    if (isSelectable(marker.withdrawn_version)) {
      throw new Error(`${surface} would let withdrawn ${marker.withdrawn_version} win a stable alias.`);
    }
    if (!isSelectable(marker.target_version)) {
      throw new Error(`${surface} does not treat ${marker.target_version} as selectable.`);
    }
  }
}

/**
 * Remote proof that the withdrawn number was never released and the target
 * is still free: no tag and no GitHub Release for either. Remote failures are
 * errors, never evidence of absence.
 */
export function verifyNeverPublished(root, marker, options = {}) {
  const git = options.git ?? gitRunner(root);
  const repository = process.env.GITHUB_REPOSITORY;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository || '')) {
    throw new Error('Withdrawn-release verification requires GITHUB_REPOSITORY.');
  }
  for (const [version, role] of [
    [marker.withdrawn_version, 'withdrawn'],
    [marker.target_version, 'target'],
  ]) {
    const tag = `v${version}`;
    const remoteTag = git('ls-remote', 'origin', `refs/tags/${tag}`, `refs/tags/${tag}^{}`);
    if (remoteTag) {
      throw new Error(`Tag ${tag} already exists; refusing the ${role} version ${version}.`);
    }
    const result = spawnSync('gh', ['api', '-X', 'GET', `repos/${repository}/releases/tags/${tag}`], {
      cwd: root,
      encoding: 'utf8',
    });
    if (result.status === 0) {
      throw new Error(`GitHub Release ${tag} already exists; refusing the ${role} version ${version}.`);
    }
    if (result.status !== 1 || !String(result.stderr).includes('HTTP 404')) {
      throw new Error(
        `Could not prove that release ${tag} is absent: ${String(result.stderr).trim() || `gh exited ${result.status}`}`,
      );
    }
  }
}

/**
 * Decide what the Version Packages step does with a present marker.
 * - `passthrough`: ordinary prerelease cut; marker stays for the GA cut.
 * - `skip`: the pre-exit cut; Changesets computes the withdrawn number and it
 *   is replaced by target_version.
 */
export function planWithdrawnSkip({ packageVersion: current, preState, marker }) {
  const parsed = semver.parse(current);
  if (!parsed || parsed.prerelease.length === 0) {
    throw new Error(
      `${markerRelativePath} is stale: ${current} is not a prerelease. Remove the consumed marker through a reviewed PR.`,
    );
  }
  const base = `${parsed.major}.${parsed.minor}.${parsed.patch}`;
  if (base !== marker.withdrawn_version) {
    throw new Error(
      `${markerRelativePath} names ${marker.withdrawn_version}, but the prerelease line is ${base}.`,
    );
  }
  if (preState?.mode === 'pre') {
    return { mode: 'passthrough', currentVersion: current };
  }
  if (preState?.mode === 'exit') {
    return {
      mode: 'skip',
      currentVersion: current,
      withdrawnVersion: marker.withdrawn_version,
      targetVersion: marker.target_version,
    };
  }
  throw new Error(`${markerRelativePath} requires Changesets pre mode ("pre" or "exit").`);
}

export function skipChangelogContent(changelog, marker) {
  const withdrawnHeading = `${CHANGELOG_TITLE}## ${marker.withdrawn_version}\n`;
  if (!changelog.startsWith(withdrawnHeading)) {
    throw new Error(`CHANGELOG.md does not start with the generated ${marker.withdrawn_version} block.`);
  }
  const rest = changelog.slice(withdrawnHeading.length);
  if (rest.includes(`\n## ${marker.withdrawn_version}\n`)) {
    throw new Error(`CHANGELOG.md contains a duplicate ${marker.withdrawn_version} block.`);
  }
  if (rest.includes(`\n## ${marker.target_version}\n`)) {
    throw new Error(`CHANGELOG.md already contains ${marker.target_version}.`);
  }
  const note = [
    `This is the first stable ${semver.major(marker.target_version)}.${semver.minor(marker.target_version)} release.`,
    `\`${marker.withdrawn_version}\` is a permanently withdrawn version number and was never released.`,
    marker.reason.trim(),
  ].join(' ');
  return `${CHANGELOG_TITLE}## ${marker.target_version}\n\n${note}\n${rest}`;
}

function pendingChangesets(root) {
  return readdirSync(resolve(root, '.changeset'), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'README.md')
    .map((entry) => entry.name);
}

function archivedChangesets(root) {
  const dir = resolve(root, '.changeset/pre');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith('.md'));
}

function defaultRunChangesetVersion(root) {
  const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const result = spawnSync(npx, ['--no-install', 'changeset', 'version'], { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error(`changeset version failed with status ${result.status ?? 'unknown'}.`);
  }
}

function defaultSetPackageVersion(root, version) {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(npm, ['version', version, '--no-git-tag-version', '--ignore-scripts'], {
    cwd: root,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    throw new Error(`npm version failed with status ${result.status ?? 'unknown'}.`);
  }
}

export async function verifyMarker(root = repoRoot, options = {}) {
  const marker = readMarker(root);
  const plan = planWithdrawnSkip({
    packageVersion: packageVersion(root),
    preState: readPreState(root),
    marker,
  });
  verifyWithdrawnHistory(root, marker);
  await (options.verifyNonSelectable ?? verifyNonSelectable)(root, marker);
  // The pre-exit cut always proves the number was never published. Ordinary
  // prerelease cuts stay offline unless explicitly asked.
  if (options.remote === true || plan.mode === 'skip') {
    (options.verifyNeverPublished ?? verifyNeverPublished)(root, marker);
  }
  return { marker, plan };
}

/**
 * Version Packages entry point used by scripts/version-packages.mjs when the
 * marker is present. It always runs Changesets itself.
 */
export async function versionWithWithdrawnMarker(root = repoRoot, options = {}) {
  const runChangesetVersion = options.runChangesetVersion ?? defaultRunChangesetVersion;
  const setPackageVersion = options.setPackageVersion ?? defaultSetPackageVersion;
  const { marker, plan } = await verifyMarker(root, options);

  runChangesetVersion(root);
  const generated = packageVersion(root);

  if (plan.mode === 'passthrough') {
    const parsed = semver.parse(generated);
    if (
      !parsed
      || parsed.prerelease.length === 0
      || `${parsed.major}.${parsed.minor}.${parsed.patch}` !== marker.withdrawn_version
    ) {
      throw new Error(
        `Prerelease cut generated ${JSON.stringify(generated)}, outside the ${marker.withdrawn_version} prerelease line the marker covers.`,
      );
    }
    return { mode: plan.mode, version: generated };
  }

  if (generated !== marker.withdrawn_version) {
    throw new Error(
      `Changesets generated ${JSON.stringify(generated)} instead of the withdrawn ${marker.withdrawn_version}; refusing to skip.`,
    );
  }
  if (readPreState(root) !== null) {
    throw new Error('Changesets did not leave pre mode on the pre-exit cut.');
  }
  if (pendingChangesets(root).length > 0 || archivedChangesets(root).length > 0) {
    throw new Error('Changesets did not consume the complete pending and archived changeset pool.');
  }

  const changelogPath = resolve(root, 'CHANGELOG.md');
  const nextChangelog = skipChangelogContent(readFileSync(changelogPath, 'utf8'), marker);
  setPackageVersion(root, marker.target_version);
  if (packageVersion(root) !== marker.target_version) {
    throw new Error(`Package version did not move to ${marker.target_version}.`);
  }
  writeFileSync(changelogPath, nextChangelog);
  unlinkSync(resolve(root, markerRelativePath));
  return { mode: plan.mode, version: marker.target_version, skipped: marker.withdrawn_version };
}

/**
 * Read-only preview of the effective next version: Changesets' own release
 * plan with the reviewed withdrawn-number skip applied.
 */
export async function previewNextVersion(root = repoRoot, options = {}) {
  const { marker, plan } = await verifyMarker(root, options);
  const dir = mkdtempSync(join(tmpdir(), 'adcp-withdrawn-release-'));
  try {
    const output = join(dir, 'status.json');
    const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    const result = spawnSync(npx, ['--no-install', 'changeset', 'status', '--output', output], {
      cwd: root,
      encoding: 'utf8',
    });
    if (result.status !== 0) {
      throw new Error(`changeset status failed: ${result.stderr || result.stdout}`);
    }
    const release = readJson(output).releases.find(({ name }) => name === 'adcontextprotocol');
    if (!release) throw new Error('Changesets plans no adcontextprotocol release.');
    const effective = plan.mode === 'skip' && release.newVersion === marker.withdrawn_version
      ? marker.target_version
      : release.newVersion;
    if (plan.mode === 'skip' && effective !== marker.target_version) {
      throw new Error(`Changesets plans ${release.newVersion}, not the withdrawn ${marker.withdrawn_version}.`);
    }
    return { mode: plan.mode, changesetsVersion: release.newVersion, effectiveVersion: effective };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [mode] = process.argv.slice(2);
    if (mode === 'check') {
      const { marker, plan } = await verifyMarker(repoRoot, { remote: process.argv.includes('--remote') });
      console.log(
        `Verified withdrawn ${marker.withdrawn_version} -> ${marker.target_version} (${plan.mode} at ${plan.currentVersion}).`,
      );
    } else if (mode === 'preview') {
      const preview = await previewNextVersion(repoRoot);
      console.log(
        `Changesets computes adcontextprotocol@${preview.changesetsVersion}; Version Packages will produce adcontextprotocol@${preview.effectiveVersion} (${preview.mode}).`,
      );
    } else {
      throw new Error('Expected: skip-withdrawn-release.mjs check [--remote] | preview');
    }
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}
