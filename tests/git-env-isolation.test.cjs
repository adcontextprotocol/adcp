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
 * set the way a shell profile sets it); the fixtures must not run its hooks.
 * Each file must also pass under that environment: a file that fails or
 * stops early proves nothing about the calls it never made.
 *
 * Each file gets one test, registered when its run ends, so a test never waits
 * for other files. The run itself is bounded by this file's own test timeout
 * (--test-timeout, N). A node:test child runs with the same N, which bounds its
 * asynchronous tests, and with tests/helpers/test-progress-hooks.cjs, which
 * records each test's start and end as it happens. The guard kills the
 * child's process group after N with no test starting or ending: a test that
 * blocks synchronously (node:test cannot time those out), a hang at load, in a
 * hook or at exit. A vitest child records the same lines through
 * tests/helpers/vitest-progress-reporter.mjs; vitest bounds each test itself.
 * tests/git-env-isolation-guard.test.cjs checks each fault on a fixture.
 */

'use strict';

const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const test = require('node:test');
const assert = require('node:assert/strict');

const { fixtureEnv } = require('./helpers/git-object-fixture.cjs');
const { gitTestFiles } = require('../scripts/lint-test-git-env.cjs');

const ROOT = path.resolve(__dirname, '..');
const SELF = path.relative(ROOT, __filename);
const PROGRESS_HOOKS = path.join(__dirname, 'helpers', 'test-progress-hooks.cjs');
const VITEST_PROGRESS = path.join(__dirname, 'helpers', 'vitest-progress-reporter.mjs');

/** This file's own --test-timeout in ms (node --test passes it to each file); 0 when unbounded. */
function ownTestBound() {
  const argv = process.execArgv;
  for (let i = 0; i < argv.length; i++) {
    const match = /^--test-timeout(?:=(.*))?$/.exec(argv[i]);
    if (match) {
      const value = Number(match[1] ?? argv[i + 1]);
      return Number.isFinite(value) && value > 0 ? value : 0;
    }
  }
  return 0;
}
const BOUND_MS = ownTestBound();
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

/** The command for one file; both kinds record test progress in TEST_PROGRESS_FILE. */
function commandFor(file) {
  if (file.endsWith('.cjs')) {
    return { command: process.execPath, args: [`--require=${PROGRESS_HOOKS}`, '--test', '--test-force-exit',
      ...(BOUND_MS > 0 ? [`--test-timeout=${BOUND_MS}`] : []), file] };
  }
  return { command: process.execPath, args: [path.join(ROOT, 'node_modules/vitest/vitest.mjs'), 'run',
    '--dir', 'tests/', '--reporter=default', `--reporter=${VITEST_PROGRESS}`, file] };
}

/** The last line of the progress file and when it was written (ms), or null. */
function lastProgressOf(progressFile) {
  if (!fs.existsSync(progressFile)) return null;
  // Complete lines only: the child may be part-way through appending one.
  const text = fs.readFileSync(progressFile, 'utf8');
  const lines = text.slice(0, text.lastIndexOf('\n') + 1).split('\n').filter(Boolean);
  if (lines.length === 0) return null;
  const line = lines.at(-1);
  return { at: Number(line.slice(0, line.indexOf(' '))), line: line.slice(line.indexOf(' ') + 1), times: lines.map((l) => Number(l.slice(0, l.indexOf(' ')))) };
}

// Children run in their own process groups so a stalled one is killed with
// everything it started. If this runner is interrupted, they go with it.
const liveGroups = new Set();
function killGroup(pid) {
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}
function killLiveGroups() {
  for (const pid of liveGroups) killGroup(pid);
}
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    killLiveGroups();
    process.kill(process.pid, signal);
  });
}
process.once('exit', killLiveGroups);

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
  const progressFile = path.join(parent.root, 'progress.log');
  env.TEST_PROGRESS_FILE = progressFile;
  const { command, args } = commandFor(file);
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    liveGroups.add(child.pid);
    let output = '';
    let stalled = false;
    let timer;
    const started = Date.now();
    // Kill the group after BOUND_MS with no test starting or ending. At each
    // expiry the timer re-arms for whatever is left since the last progress
    // line, so the bound is exact without polling. It stays armed after
    // 'exit' until 'close', so a grandchild holding the pipes open is killed.
    const lastActivity = () => Math.max(started, lastProgressOf(progressFile)?.at || 0);
    const arm = (delay) => {
      timer = setTimeout(() => {
        const left = lastActivity() + BOUND_MS - Date.now();
        if (left > 0) return arm(left);
        stalled = true;
        killGroup(child.pid);
      }, delay);
    };
    if (BOUND_MS > 0) arm(BOUND_MS);
    child.stdout.on('data', (chunk) => { output = (output + chunk).slice(-4000); });
    child.stderr.on('data', (chunk) => { output = (output + chunk).slice(-4000); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      liveGroups.delete(child.pid);
      // Whatever the child left in its group goes with it.
      killGroup(child.pid);
      const ended = Date.now();
      const last = lastProgressOf(progressFile);
      const marks = [started, ...(last?.times ?? []), ended];
      const longestSilence = Math.max(...marks.slice(1).map((time, i) => time - marks[i]));
      resolve({ code, signal, output, stalled, lastProgress: last?.line ?? '', progressLines: last?.times.length ?? 0, wallMs: ended - started, longestSilence });
    });
  });
}

// GIT_ENV_ISOLATION_FILES=a,b runs exactly those files (repository-relative)
// instead of the discovered ones: to reproduce one, or to run a fixture.
const only = (process.env.GIT_ENV_ISOLATION_FILES ?? '').split(',').filter(Boolean);
const files = only.length > 0 ? only : gitTestFiles().filter((file) => file !== SELF);

test('discovers the real-git test files', () => {
  if (only.length > 0) {
    for (const file of only) assert.ok(fs.existsSync(path.join(ROOT, file)), `GIT_ENV_ISOLATION_FILES names a missing file: ${file}`);
  } else {
    assert.ok(files.length >= 10, `expected the real-git test files, found ${files.join(', ')}`);
  }
});

/** The failures of one file's run: its exit status, the caller repository, the caller's hooks. */
function problemsOf(file, { code, signal, output, stalled, lastProgress, before, after, callerHooksRan }) {
  const problems = [];
  if (code !== 0 || signal !== null) {
    const how = signal !== null ? `was killed by ${signal}` : `exited with code ${code}`;
    const why = stalled ? ` after ${BOUND_MS} ms with no test starting or ending (last: ${lastProgress || 'none'})` : '';
    problems.push(`${file} ${how}${why} under the hook environment.\n${output.slice(-2500)}`);
  }
  if (!isDeepStrictEqual(after, before)) {
    const changed = Object.keys(before.bytes).filter((name) => before.bytes[name] !== after.bytes[name]);
    if (!isDeepStrictEqual(after.refs, before.refs)) changed.push('refs');
    if (!isDeepStrictEqual(after.worktrees, before.worktrees)) changed.push('worktrees');
    problems.push(`${file} wrote to the caller repository through the inherited GIT_DIR/GIT_INDEX_FILE: ${changed.join(', ')} changed.`);
  }
  if (callerHooksRan.length > 0) {
    problems.push(`${file} ran the caller's configured git hooks (core.hooksPath from GIT_CONFIG_COUNT): ${callerHooksRan.join(', ')}.`);
  }
  return problems;
}

// Run the files a few at a time, each against its own throwaway parent. Each
// file's test is registered when its run ends, so it checks a finished run.
const queue = files.slice();
function next() {
  const file = queue.shift();
  if (!file) return;
  const parent = hookParent();
  const before = snapshot(parent);
  runUnderHookEnv(file, parent).then((result) => {
    const after = snapshot(parent);
    const callerHooksRan = fs.existsSync(parent.callerHookLog) ? [...new Set(fs.readFileSync(parent.callerHookLog, 'utf8').split('\n').filter(Boolean))].sort() : [];
    fs.rmSync(parent.root, { recursive: true, force: true });
    const problems = problemsOf(file, { ...result, before, after, callerHooksRan });
    test(`${file} passes and leaves the caller repository unchanged under a linked-worktree hook environment`, (t) => {
      // How close the run came to the bound: the longest stretch with no test
      // starting or ending (a vitest file's whole run).
      t.diagnostic(`run ${result.wallMs} ms, ${result.progressLines} progress lines, longest silence ${result.longestSilence} ms, bound ${BOUND_MS || 'none'} ms`);
      assert.equal(problems.length, 0, problems.join('\n'));
    });
    next();
  });
}
for (let i = 0; i < CONCURRENCY; i++) next();
