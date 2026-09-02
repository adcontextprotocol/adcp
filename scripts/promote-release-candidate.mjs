#!/usr/bin/env node

/**
 * Promote the final 3.2 beta to rc.0 without publishing an intermediate
 * stable release. Changesets increments the numeric suffix across tag changes,
 * so its default beta -> rc path would turn beta.N into rc.(N+1).
 *
 * This script is deliberately narrow: it snapshots the exact beta changeset
 * pool and only computes the semver-forward beta.N -> rc.0 move. The reviewed
 * state PR prepares a marker; the ordinary GitHub Version Packages workflow
 * consumes those changesets and generates signed artifacts in its trusted
 * context.
 */

import { readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import semver from 'semver';

const { inc, parse } = semver;
const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const markerRelativePath = '.changeset/rc-promotion.json';

export function planRcPromotion({ packageVersion, preState, pendingChangesets }) {
  const parsed = parse(packageVersion);
  if (!parsed || parsed.prerelease[0] !== 'beta' || typeof parsed.prerelease[1] !== 'number') {
    throw new Error(`Expected the final beta version, received ${JSON.stringify(packageVersion)}.`);
  }
  if (parsed.major !== 3 || parsed.minor !== 2 || parsed.patch !== 0) {
    throw new Error(`RC promotion is restricted to the 3.2.0 release line, received ${JSON.stringify(packageVersion)}.`);
  }
  if (preState?.mode !== 'pre' || preState?.tag !== 'beta') {
    throw new Error('Expected .changeset/pre.json to remain in beta pre mode.');
  }
  const targetVersion = inc(packageVersion, 'prerelease', 'rc');
  if (targetVersion !== `${parsed.major}.${parsed.minor}.${parsed.patch}-rc.0`) {
    throw new Error(`Refusing unexpected RC target ${JSON.stringify(targetVersion)}.`);
  }

  return {
    currentVersion: packageVersion,
    targetVersion,
    nextPreState: { ...preState, tag: 'rc' },
    pendingChangesets: [...pendingChangesets].sort(),
  };
}

export function pendingChangesets(root = repoRoot) {
  return readdirSync(resolve(root, '.changeset'), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'README.md')
    .map((entry) => entry.name)
    .sort();
}

function fileSha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function changesetSnapshot(root = repoRoot) {
  return pendingChangesets(root).map((file) => ({
    file,
    sha256: fileSha256(resolve(root, '.changeset', file)),
  }));
}

export function readPromotionPlan(root = repoRoot) {
  const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  const preState = JSON.parse(readFileSync(resolve(root, '.changeset/pre.json'), 'utf8'));
  return planRcPromotion({
    packageVersion: packageJson.version,
    preState,
    pendingChangesets: pendingChangesets(root),
  });
}

export function prepareRcPromotion(root = repoRoot) {
  const plan = readPromotionPlan(root);
  const snapshot = changesetSnapshot(root);
  const markerPath = resolve(root, markerRelativePath);
  try {
    writeFileSync(markerPath, `${JSON.stringify({
      from: plan.currentVersion,
      to: plan.targetVersion,
      pendingChangesets: snapshot,
    }, null, 2)}\n`, { flag: 'wx' });
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') {
      throw new Error(`${markerRelativePath} already exists.`);
    }
    throw error;
  }
  return plan;
}

export function readPreparedRcPromotion(root = repoRoot) {
  const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  const preState = JSON.parse(readFileSync(resolve(root, '.changeset/pre.json'), 'utf8'));
  const marker = JSON.parse(readFileSync(resolve(root, markerRelativePath), 'utf8'));
  if (preState?.mode !== 'pre' || preState?.tag !== 'beta') {
    throw new Error('Prepared RC promotion requires beta pre mode until versioning.');
  }
  if (marker?.from !== packageJson.version || marker?.to !== '3.2.0-rc.0') {
    throw new Error('RC promotion marker does not match the current package version and rc.0 target.');
  }
  if (!Array.isArray(marker?.pendingChangesets)) {
    throw new Error('RC promotion marker must snapshot pending changesets.');
  }
  const actualSnapshot = changesetSnapshot(root);
  if (JSON.stringify(marker.pendingChangesets) !== JSON.stringify(actualSnapshot)) {
    throw new Error('Pending changesets do not match the reviewed RC promotion marker.');
  }
  return {
    currentVersion: marker.from,
    targetVersion: marker.to,
    nextPreState: { ...preState, tag: 'rc' },
    pendingChangesets: actualSnapshot.map(({ file }) => file),
    reviewedChangesets: actualSnapshot,
  };
}

export function rcChangelogContent(changelog, plan, intermediateVersion = null) {
  const title = '# Changelog\n\n';
  if (!changelog.startsWith(title)) {
    throw new Error('CHANGELOG.md must start with the canonical changelog heading.');
  }
  if (!changelog.includes(`## ${plan.currentVersion}\n`)) {
    throw new Error(`CHANGELOG.md does not contain the final beta ${plan.currentVersion}.`);
  }
  if (changelog.includes(`## ${plan.targetVersion}\n`)) {
    throw new Error(`CHANGELOG.md already contains ${plan.targetVersion}.`);
  }

  if (intermediateVersion) {
    const generatedHeading = `${title}## ${intermediateVersion}\n`;
    if (!changelog.startsWith(generatedHeading)) {
      throw new Error(`CHANGELOG.md does not start with generated version ${intermediateVersion}.`);
    }
    return `${title}## ${plan.targetVersion}\n${changelog.slice(generatedHeading.length)}`;
  }

  const entry = [
    `## ${plan.targetVersion}`,
    '',
    `Promoted from \`${plan.currentVersion}\` after final-beta acceptance. This phase transition adds no protocol changes.`,
    '',
  ].join('\n');
  return `${title}${entry}${changelog.slice(title.length)}`;
}

function runChangesetVersion(root) {
  const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const result = spawnSync(npx, ['--no-install', 'changeset', 'version'], {
    cwd: root,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    throw new Error(`changeset version failed with status ${result.status ?? 'unknown'}.`);
  }
}

export function validateChangesetConsumption(root, plan, intermediateVersion) {
  const generatedVersion = JSON.parse(
    readFileSync(resolve(root, 'package.json'), 'utf8'),
  ).version;
  if (generatedVersion !== intermediateVersion) {
    throw new Error(
      `Changesets generated ${JSON.stringify(generatedVersion)} instead of ${JSON.stringify(intermediateVersion)}.`,
    );
  }
  if (pendingChangesets(root).length > 0) {
    throw new Error('Changesets did not consume the reviewed RC changeset pool.');
  }
  for (const changeset of plan.reviewedChangesets) {
    const consumedPath = resolve(root, '.changeset', 'pre', changeset.file);
    if (fileSha256(consumedPath) !== changeset.sha256) {
      throw new Error(`Changesets did not preserve reviewed content for ${changeset.file}.`);
    }
  }
}

export function versionPreparedRc(root = repoRoot, options = {}) {
  const plan = readPreparedRcPromotion(root);
  const changelogPath = resolve(root, 'CHANGELOG.md');
  let intermediateVersion = null;
  if (plan.pendingChangesets.length > 0) {
    intermediateVersion = inc(plan.currentVersion, 'prerelease', 'beta');
    if (!intermediateVersion?.startsWith('3.2.0-beta.')) {
      throw new Error(`Refusing unexpected intermediate version ${JSON.stringify(intermediateVersion)}.`);
    }
    (options.runChangesetVersion ?? runChangesetVersion)(root);
    validateChangesetConsumption(root, plan, intermediateVersion);
  }
  const nextChangelog = rcChangelogContent(
    readFileSync(changelogPath, 'utf8'),
    plan,
    intermediateVersion,
  );
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(
    npm,
    ['version', plan.targetVersion, '--no-git-tag-version', '--ignore-scripts'],
    { cwd: root, stdio: 'inherit' },
  );
  if (result.status !== 0) {
    throw new Error(`npm version failed with status ${result.status ?? 'unknown'}.`);
  }

  writeFileSync(changelogPath, nextChangelog);
  writeFileSync(
    resolve(root, '.changeset/pre.json'),
    `${JSON.stringify(plan.nextPreState, null, 2)}\n`,
  );
  unlinkSync(resolve(root, markerRelativePath));
  return plan;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const checkOnly = process.argv.includes('--check');
    const prepare = process.argv.includes('--prepare');
    const version = process.argv.includes('--version');
    if ([checkOnly, prepare, version].filter(Boolean).length !== 1) {
      throw new Error('Choose exactly one of --check, --prepare, or --version.');
    }
    const plan = checkOnly
      ? readPromotionPlan()
      : prepare
        ? prepareRcPromotion()
        : versionPreparedRc();
    console.log(
      `${checkOnly ? 'Ready to prepare' : prepare ? 'Prepared' : 'Versioned'} ${plan.currentVersion} -> ${plan.targetVersion}.`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
