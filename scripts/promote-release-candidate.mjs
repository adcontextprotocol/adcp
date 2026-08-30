#!/usr/bin/env node

/**
 * Promote the final 3.2 beta to rc.0 without publishing an intermediate
 * stable release. Changesets increments the numeric suffix across tag changes,
 * so its default beta -> rc path would turn beta.N into rc.(N+1).
 *
 * This script is deliberately narrow: it only accepts a cleanly consumed beta
 * changeset pool and only computes the semver-forward beta.N -> rc.0 move. The
 * reviewed state PR prepares a marker; the ordinary GitHub Version Packages
 * workflow consumes it and generates signed artifacts in its trusted context.
 */

import { readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
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
  if (preState?.mode !== 'pre' || preState?.tag !== 'beta') {
    throw new Error('Expected .changeset/pre.json to remain in beta pre mode.');
  }
  if (pendingChangesets.length > 0) {
    throw new Error(
      `Cut the final beta before RC promotion; pending changesets: ${pendingChangesets.join(', ')}.`,
    );
  }

  const targetVersion = inc(packageVersion, 'prerelease', 'rc');
  if (targetVersion !== `${parsed.major}.${parsed.minor}.${parsed.patch}-rc.0`) {
    throw new Error(`Refusing unexpected RC target ${JSON.stringify(targetVersion)}.`);
  }

  return {
    currentVersion: packageVersion,
    targetVersion,
    nextPreState: { ...preState, tag: 'rc' },
  };
}

export function pendingChangesets(root = repoRoot) {
  return readdirSync(resolve(root, '.changeset'), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'README.md')
    .map((entry) => entry.name)
    .sort();
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
  const markerPath = resolve(root, markerRelativePath);
  try {
    writeFileSync(markerPath, `${JSON.stringify({
      from: plan.currentVersion,
      to: plan.targetVersion,
    }, null, 2)}\n`, { flag: 'wx' });
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') {
      throw new Error(`${markerRelativePath} already exists.`);
    }
    throw error;
  }
  writeFileSync(
    resolve(root, '.changeset/pre.json'),
    `${JSON.stringify(plan.nextPreState, null, 2)}\n`,
  );
  return plan;
}

export function readPreparedRcPromotion(root = repoRoot) {
  const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  const preState = JSON.parse(readFileSync(resolve(root, '.changeset/pre.json'), 'utf8'));
  const marker = JSON.parse(readFileSync(resolve(root, markerRelativePath), 'utf8'));
  if (preState?.mode !== 'pre' || preState?.tag !== 'rc') {
    throw new Error('Prepared RC promotion requires rc pre mode.');
  }
  if (marker?.from !== packageJson.version || marker?.to !== '3.2.0-rc.0') {
    throw new Error('RC promotion marker does not match the current package version and rc.0 target.');
  }
  if (pendingChangesets(root).length > 0) {
    throw new Error('RC promotion cannot consume pending root changesets.');
  }
  return { currentVersion: marker.from, targetVersion: marker.to };
}

export function rcChangelogContent(changelog, plan) {
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

  const entry = [
    `## ${plan.targetVersion}`,
    '',
    `Promoted from \`${plan.currentVersion}\` after final-beta acceptance. This phase transition adds no protocol changes.`,
    '',
  ].join('\n');
  return `${title}${entry}${changelog.slice(title.length)}`;
}

export function versionPreparedRc(root = repoRoot) {
  const plan = readPreparedRcPromotion(root);
  const changelogPath = resolve(root, 'CHANGELOG.md');
  const nextChangelog = rcChangelogContent(
    readFileSync(changelogPath, 'utf8'),
    plan,
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
