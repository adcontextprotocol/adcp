#!/usr/bin/env node
/**
 * The guard in tests/git-env-isolation.test.cjs must fail for each fault it
 * claims to catch, and only for that fault. Each case runs the guard through
 * its command line on one fixture from tests/fixtures/git-env-isolation/,
 * selected with GIT_ENV_ISOLATION_FILES, and checks the guard's exit status
 * and which of its checks failed:
 *
 *   - the rerun file fails (node:test and vitest);
 *   - it writes to the caller repository through the inherited GIT_DIR;
 *   - it runs the caller's git hooks;
 *   - it stalls in an asynchronous test, blocks in a synchronous one, or
 *     stalls before any test starts, where the guard
 *     must stop it within its own test timeout and leave no process behind.
 */

'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const ROOT = path.resolve(__dirname, '..');
const GUARD = 'tests/git-env-isolation.test.cjs';
const FIXTURES = 'tests/fixtures/git-env-isolation';
// The guard's own test timeout for the stall cases: short, so a stall is
// stopped in seconds instead of after the repository's 30 s default.
const STALL_BOUND_MS = 2000;

const SNAPSHOT_FAILED = /wrote to the caller repository/;
const HOOKS_FAILED = /ran the caller's configured git hooks/;
const EXIT_FAILED = /exited with code [1-9]|was killed by SIG/;

/** Runs the guard on the named fixtures; resolves with its exit status, output and wall time. */
function runGuard(t, fixtures, { bound, env = {} } = {}) {
  const childEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('GIT_') && !key.startsWith('NODE_TEST_')) childEnv[key] = value;
  }
  Object.assign(childEnv, env, { GIT_ENV_ISOLATION_FILES: fixtures.map((name) => `${FIXTURES}/${name}`).join(',') });
  const args = ['--test', ...(bound ? [`--test-timeout=${bound}`] : []), GUARD];
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: ROOT, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    // SIGTERM, not SIGKILL: the guard then kills its children's process groups.
    t.signal.addEventListener('abort', () => child.kill('SIGTERM'), { once: true });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, output, ms: Date.now() - started }));
  });
}

/** The guard's result lines (✔/✖ name) for one fixture, to tell which check failed. */
function failedChecks(output) {
  return output.split('\n').filter((line) => /^\s*✖/.test(line));
}

// The guard's per-file diagnostic: "run N ms, K progress lines, ...". Each
// test start and end is one line, so a run with no lines never reported progress.
const PROGRESS_LINES = /run \d+ ms, (\d+) progress lines/;

test('a passing fixture passes the guard, with its progress recorded', async (t) => {
  const result = await runGuard(t, ['passes.cjs']);
  assert.equal(result.code, 0, result.output);
  assert.equal(Number(PROGRESS_LINES.exec(result.output)?.[1]), 4, result.output);
});

test('a failing node:test file fails the guard, and only its exit-status check', async (t) => {
  const result = await runGuard(t, ['fails.cjs']);
  assert.notEqual(result.code, 0, result.output);
  assert.match(result.output, EXIT_FAILED);
  assert.match(result.output, /fails on purpose/, 'the guard names the failing inner test');
  assert.doesNotMatch(result.output, SNAPSHOT_FAILED);
  assert.doesNotMatch(result.output, HOOKS_FAILED);
});

for (const mode of ['pass', 'fail']) {
  test(`a vitest file that should ${mode} ${mode === 'pass' ? 'passes' : 'fails'} the guard`, async (t) => {
    const result = await runGuard(t, ['vitest-mode.test.ts'], { env: { ISOLATION_FIXTURE_MODE: mode } });
    if (mode === 'pass') {
      assert.equal(result.code, 0, result.output);
      assert.equal(Number(PROGRESS_LINES.exec(result.output)?.[1]), 2, result.output);
    } else {
      assert.notEqual(result.code, 0, result.output);
      assert.match(result.output, EXIT_FAILED);
      assert.match(result.output, /fails only when the guard meta-test asks it to/, 'the guard names the failing vitest test');
      assert.doesNotMatch(result.output, SNAPSHOT_FAILED);
    }
  });
}

test('a file that writes through the inherited GIT_DIR fails only the snapshot check', async (t) => {
  const result = await runGuard(t, ['writes-caller.cjs']);
  assert.notEqual(result.code, 0, result.output);
  assert.match(result.output, SNAPSHOT_FAILED);
  assert.doesNotMatch(result.output, EXIT_FAILED);
  assert.doesNotMatch(result.output, HOOKS_FAILED);
});

test("a file that runs the caller's git hooks fails only the hooks check", async (t) => {
  const result = await runGuard(t, ['runs-caller-hook.cjs']);
  assert.notEqual(result.code, 0, result.output);
  assert.match(result.output, HOOKS_FAILED);
  assert.doesNotMatch(result.output, EXIT_FAILED);
  assert.doesNotMatch(result.output, SNAPSHOT_FAILED);
});

test('stalls in a test, a blocking test and a stall before the first test are each stopped within the bound, together', async (t) => {
  const pidDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-env-isolation-guard-'));
  t.after(() => fs.rmSync(pidDir, { recursive: true, force: true }));
  const result = await runGuard(t, ['stalls-in-test.cjs', 'blocks-in-test.cjs', 'stalls-at-load.cjs'], {
    bound: STALL_BOUND_MS,
    env: { ISOLATION_FIXTURE_PID_DIR: pidDir },
  });
  assert.notEqual(result.code, 0, result.output);
  const failed = failedChecks(result.output);
  assert.ok(failed.some((line) => line.includes('stalls-in-test.cjs')), result.output);
  assert.ok(failed.some((line) => line.includes('stalls-at-load.cjs')), result.output);
  assert.ok(failed.some((line) => line.includes('blocks-in-test.cjs')), result.output);
  assert.match(result.output, /blocks-in-test\.cjs was killed by SIGKILL after \d+ ms with no test starting or ending \(last: start blocks past the timeout\)/);
  // Each fixture stalls for 60 s. Run side by side, each is stopped after
  // about one bound; the guard's own start and teardown add a few seconds.
  assert.ok(result.ms < 10 * STALL_BOUND_MS, `the guard took ${result.ms} ms\n${result.output}`);
  const pid = Number(fs.readFileSync(path.join(pidDir, 'stalls-at-load.pid'), 'utf8'));
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, `the stalled child ${pid} is still running`);
});
