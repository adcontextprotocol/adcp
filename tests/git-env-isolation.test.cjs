#!/usr/bin/env node
/**
 * Every test file that runs real git must leave the caller's repository alone
 * when it runs inside a git hook.
 *
 * In a linked worktree, git exports GIT_DIR=<repo>/.git/worktrees/<name> and
 * GIT_INDEX_FILE to its hooks, and a test run by the hook inherits both. A
 * test git call that keeps them (`git init` in a temp directory, `git add`
 * in a fixture) acts on the caller's repository instead of the fixture: an
 * inherited worktree GIT_DIR makes `git init` write core.bare=true into the
 * shared common config, which breaks every worktree of the repository.
 *
 * This guard builds a throwaway repository with a linked worktree, runs each
 * real-git test file with that worktree's GIT_DIR and GIT_INDEX_FILE in its
 * environment, the way a hook would, and asserts that the throwaway
 * repository's config, index files, HEADs and refs are byte-for-byte
 * unchanged. The environment also carries a caller git config (a hooks path,
 * set the way a shell profile sets it); the fixtures must not run its hooks. The test files' own pass/fail is theirs to report; this file
 * checks only that they did not write to the caller's repository.
 */

'use strict';

const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { fixtureEnv } = require('./helpers/git-object-fixture.cjs');
const { gitTestFiles } = require('../scripts/lint-test-git-env.cjs');

const ROOT = path.resolve(__dirname, '..');
const SELF = path.relative(ROOT, __filename);
const FILE_TIMEOUT_MS = 15 * 60 * 1000;
// Hooks a fixture's commits, checkouts, merges, pushes and ref updates fire.
const CALLER_HOOKS = ['pre-commit', 'prepare-commit-msg', 'commit-msg', 'post-commit', 'post-checkout', 'post-merge',
  'pre-push', 'pre-receive', 'update', 'post-receive', 'post-update', 'reference-transaction', 'post-rewrite', 'pre-rebase'];
const CONCURRENCY = Math.max(1, Math.min(4, os.availableParallelism() - 2));

function setupGit(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: fixtureEnv() });
}

/** A throwaway repository with one commit and one linked worktree. */
function hookParent() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'git-env-isolation-')));
  const repo = path.join(root, 'parent');
  fs.mkdirSync(repo);
  setupGit(repo, ['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'parent\n');
  setupGit(repo, ['add', 'tracked.txt']);
  setupGit(repo, ['commit', '-q', '-m', 'parent']);
  setupGit(repo, ['worktree', 'add', '-q', '-b', 'linked', path.join(root, 'linked')]);
  const gitDir = path.join(repo, '.git', 'worktrees', 'linked');
  assert.ok(fs.existsSync(path.join(gitDir, 'index')), 'linked worktree has its own index');
  const callerHooks = path.join(root, 'caller-hooks');
  const callerHookLog = path.join(root, 'caller-hooks.log');
  fs.mkdirSync(callerHooks);
  for (const hook of CALLER_HOOKS) {
    fs.writeFileSync(path.join(callerHooks, hook), `#!/bin/sh\necho ${hook} >> '${callerHookLog}'\ncat > /dev/null 2>&1 || true\nexit 0\n`, { mode: 0o755 });
  }
  return { root, repo, gitDir, callerHooks, callerHookLog };
}

function listFiles(dir, base = dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? listFiles(full, base) : [path.relative(base, full)];
  }).sort();
}

/** Everything a stray git call through the inherited GIT_DIR could rewrite. */
function snapshot({ repo, gitDir }) {
  const common = path.join(repo, '.git');
  const files = ['config', 'index', 'HEAD', 'packed-refs'].map((name) => path.join(common, name))
    .concat(['index', 'HEAD', 'config.worktree', 'commondir', 'gitdir'].map((name) => path.join(gitDir, name)));
  const bytes = Object.fromEntries(files.map((file) => [path.relative(common, file), fs.existsSync(file) ? fs.readFileSync(file, 'base64') : null]));
  const refs = listFiles(path.join(common, 'refs')).map((ref) => `${ref} ${fs.readFileSync(path.join(common, 'refs', ref), 'utf8').trim()}`);
  return { bytes, refs, worktrees: listFiles(path.join(common, 'worktrees')) };
}

function commandFor(file) {
  if (file.endsWith('.cjs')) return [process.execPath, ['--test', '--test-force-exit', file]];
  return [process.execPath, [path.join(ROOT, 'node_modules/vitest/vitest.mjs'), 'run', '--dir', 'tests/', '--pool=threads', file]];
}

/** Runs one test file with the parent's linked-worktree hook environment. */
function runUnderHookEnv(file, parent) {
  const env = {};
  // NODE_TEST_* would make a nested `node --test` report to this runner instead of running.
  for (const [key, value] of Object.entries(process.env)) if (!key.startsWith('GIT_') && !key.startsWith('NODE_TEST_')) env[key] = value;
  env.GIT_DIR = parent.gitDir;
  env.GIT_INDEX_FILE = path.join(parent.gitDir, 'index');
  // The caller's own git config, as a shell profile exports it: a hooks path
  // whose hooks record that they ran. Fixture git must not load it (it runs
  // the caller's hook shims on every commit and ref update, ~6x slower).
  env.GIT_CONFIG_COUNT = '1';
  env.GIT_CONFIG_KEY_0 = 'core.hooksPath';
  env.GIT_CONFIG_VALUE_0 = parent.callerHooks;
  const [command, args] = commandFor(file);
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => { output = (output + chunk).slice(-4000); });
    child.stderr.on('data', (chunk) => { output = (output + chunk).slice(-4000); });
    const timer = setTimeout(() => child.kill('SIGKILL'), FILE_TIMEOUT_MS);
    child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, output }); });
  });
}

// GIT_ENV_ISOLATION_FILES=a,b limits a run to those files (to reproduce one).
const only = (process.env.GIT_ENV_ISOLATION_FILES ?? '').split(',').filter(Boolean);
const files = gitTestFiles().filter((file) => file !== SELF && (only.length === 0 || only.includes(file)));

test('discovers the real-git test files', () => {
  assert.ok(only.length > 0 ? files.length === only.length : files.length >= 10, `expected the real-git test files, found ${files.join(', ')}`);
});

// Run the files a few at a time, each against its own throwaway parent.
const queue = files.slice();
const runs = new Map();
function next() {
  const file = queue.shift();
  if (!file) return;
  const parent = hookParent();
  const before = snapshot(parent);
  runs.set(file, runUnderHookEnv(file, parent).then((result) => {
    const after = snapshot(parent);
    const callerHooksRan = fs.existsSync(parent.callerHookLog) ? [...new Set(fs.readFileSync(parent.callerHookLog, 'utf8').split('\n').filter(Boolean))].sort() : [];
    fs.rmSync(parent.root, { recursive: true, force: true });
    next();
    return { ...result, before, after, callerHooksRan };
  }));
}
for (let i = 0; i < CONCURRENCY; i++) next();

for (const file of files) {
  test(`${file} leaves the caller repository of an inherited worktree GIT_DIR unchanged`, { timeout: FILE_TIMEOUT_MS + 60_000 }, async () => {
    while (!runs.has(file)) await new Promise((resolve) => setTimeout(resolve, 200));
    const { before, after, code, signal, output } = await runs.get(file);
    assert.deepEqual(after, before, `${file} (exit ${code}${signal ? `, ${signal}` : ''}) wrote to the caller repository through the inherited GIT_DIR/GIT_INDEX_FILE.\n${output.slice(-1500)}`);
  });
  test(`${file} runs fixture git without the caller's git config`, { timeout: FILE_TIMEOUT_MS + 60_000 }, async () => {
    while (!runs.has(file)) await new Promise((resolve) => setTimeout(resolve, 200));
    const { callerHooksRan } = await runs.get(file);
    assert.deepEqual(callerHooksRan, [], `${file} ran the caller's configured git hooks (core.hooksPath from GIT_CONFIG_COUNT)`);
  });
}
