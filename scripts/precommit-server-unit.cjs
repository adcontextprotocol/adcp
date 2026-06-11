#!/usr/bin/env node
'use strict';

const { execFileSync, spawnSync } = require('node:child_process');
const { existsSync } = require('node:fs');

const SERVER_UNIT_TEST_RE = /^server\/tests\/unit\/.*\.(?:test|spec)\.[cm]?[jt]sx?$/;

const FULL_SERVER_UNIT_PATTERNS = [
  /^server\/src\//,
  /^server\/scripts\//,
  /^server\/public\//,
  /^server\/tests\/setup\//,
  /^server\/tests\/unit\/(?!.*\.(?:test|spec)\.[cm]?[jt]sx?$)/,
  /^docs\//,
  /^static\/schemas\/source\//,
  /^static\/compliance\/source\//,
  /^static\/registry\//,
  /^server\/vitest\.config\.ts$/,
  /^server\/tsconfig\.json$/,
  /^vitest\.config\.ts$/,
  /^package\.json$/,
  /^package-lock\.json$/,
  /^scripts\/generate-c2pa-cert\.sh$/,
  /^\.agents\//,
  /^\.claude\/agents\//,
];

function pathsFromNameStatus(output) {
  const tokens = output
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
  const paths = [];

  for (let i = 0; i < tokens.length;) {
    const status = tokens[i++];
    if (!status) break;

    if (status[0] === 'R' || status[0] === 'C') {
      const oldPath = tokens[i++];
      const newPath = tokens[i++];
      if (oldPath) paths.push(oldPath);
      if (newPath) paths.push(newPath);
      continue;
    }

    const file = tokens[i++];
    if (file) paths.push(file);
  }

  return paths.map((file) => file.replace(/\\/g, '/'));
}

function stagedFiles() {
  const output = execFileSync('git', ['diff', '--cached', '--name-status', '--diff-filter=ACMRD', '-z']);
  return pathsFromNameStatus(output);
}

function planServerUnitRun(files, fileExists = () => true) {
  const normalized = files.map((file) => file.replace(/\\/g, '/'));

  if (normalized.some((file) => FULL_SERVER_UNIT_PATTERNS.some((pattern) => pattern.test(file)))) {
    return { kind: 'full', files: [] };
  }

  const testFiles = [...new Set(normalized.filter((file) => SERVER_UNIT_TEST_RE.test(file) && fileExists(file)))].sort();
  if (testFiles.length > 0) {
    return { kind: 'files', files: testFiles };
  }

  return { kind: 'skip', files: [] };
}

function run(command, args) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  if (result.error) {
    console.error(result.error.message);
    return 1;
  }

  return result.status ?? 1;
}

function main() {
  const plan = planServerUnitRun(stagedFiles(), existsSync);

  if (plan.kind === 'skip') {
    console.log('No staged server unit changes; skipping server unit precommit check.');
    return 0;
  }

  if (plan.kind === 'full') {
    console.log('Server implementation/config/schema changed; running full server unit suite.');
    return run('npm', ['run', 'test:server-unit']);
  }

  console.log(`Running ${plan.files.length} changed server unit test file(s).`);
  return run('npm', ['exec', '--', 'vitest', 'run', ...plan.files]);
}

if (require.main === module) {
  process.exit(main());
}

module.exports = {
  planServerUnitRun,
  pathsFromNameStatus,
  SERVER_UNIT_TEST_RE,
  FULL_SERVER_UNIT_PATTERNS,
};
