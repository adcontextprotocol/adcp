#!/usr/bin/env node
/**
 * Tests for `scripts/lint-test-git-env.cjs`.
 *
 *   1. Source-tree guard: every test file that runs git uses the shared
 *      fixture environment or opts out for a read of the enclosing checkout.
 *   2. Rule coverage: the launch forms the lint must catch, including the ones
 *      a single-line or case-insensitive pattern would get wrong, and the
 *      forms it must accept.
 */

'use strict';

const path = require('node:path');
const assert = require('node:assert/strict');

const { gitTestFiles, lint, scanSource } = require('../scripts/lint-test-git-env.cjs');

const rules = (source) => scanSource(source).map((v) => v.rule);
const FLAGGED = ['test-git-without-fixture-env'];

test('source tree passes the lint', () => {
  const violations = lint();
  if (violations.length > 0) {
    const summary = violations.map((v) => `${path.relative(process.cwd(), v.file)}:${v.line}  [${v.rule}]`).join('\n');
    assert.fail(`Expected zero violations, got ${violations.length}:\n${summary}`);
  }
});

test('discovers the real-git test files, including helper-only users', () => {
  const files = gitTestFiles();
  for (const file of ['tests/release-supersession.test.cjs', 'tests/ipr-check-and-record.test.mjs', 'tests/immutable-release-artifacts.test.cjs']) {
    assert.ok(files.includes(file), `${file} not discovered`);
  }
});

test('flags git launched with the caller environment', () => {
  assert.deepEqual(rules("execFileSync('git', ['init', '-q'], { cwd: dir });"), FLAGGED);
  assert.deepEqual(rules('const out = execFileSync(realGit, args, { cwd: dir, encoding: "utf8" });'), FLAGGED);
  assert.deepEqual(rules("spawnSync(REAL_GIT, ['commit', '-qm', 'x'], { env: { ...process.env, GIT_AUTHOR_DATE: d } });"), FLAGGED);
});

test('flags the forms a single-line or naive pattern would miss', () => {
  // executable on the next line, double quotes
  assert.deepEqual(rules(`releaseConfig = JSON.parse(execFileSync(
      "git",
      ["show", ref + ":docs.json"],
      { cwd: rootDir }));`), FLAGGED);
  // a command string
  assert.deepEqual(rules('execSync(`git add dist/schemas/${version}/`, { cwd: root });'), FLAGGED);
  // a binary variable named for git
  assert.deepEqual(rules("spawn(gitBin, ['fetch'], { cwd });"), FLAGGED);
  // fixtureEnv mentioned elsewhere in the file does not cover this launch
  assert.deepEqual(rules(`const env = fixtureEnv();
    execFileSync('git', ['init'], { cwd: dir });`), FLAGGED);
});

test('accepts the shared fixture environment, process isolation and opt-outs', () => {
  assert.deepEqual(rules("execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: fixtureEnv() });"), []);
  assert.deepEqual(rules(`execFileSync('git', args, {
      cwd: dir,
      env: fixtureEnv({ identity: false }),
    });`), []);
  assert.deepEqual(rules(`const { isolateGitEnv } = require('./helpers/git-object-fixture.cjs');
    isolateGitEnv({ identity: false });
    execFileSync(realGit, ['init', '-q', '--bare', bare]);`), []);
  assert.deepEqual(rules(`// lint-allow-caller-git: lists the enclosing checkout's own files
    const output = execFileSync('git', ['ls-files'], { cwd: ROOT });`), []);
});

test('ignores launches of other programs', () => {
  assert.deepEqual(rules("execFileSync(process.execPath, ['scripts/check.cjs']);"), []);
  assert.deepEqual(rules("spawnSync(digits, ['x']); spawnSync(legitTool, []); execFileSync('github-cli', []);"), []);
  assert.deepEqual(rules("const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();"), []);
});
