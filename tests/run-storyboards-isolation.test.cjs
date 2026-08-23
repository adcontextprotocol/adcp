#!/usr/bin/env node

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const REPO_ROOT = path.join(__dirname, '..');
const ORCHESTRATOR = path.join(REPO_ROOT, 'scripts', 'run-storyboards-isolated.mjs');
const FIXTURE = path.join(REPO_ROOT, 'tests', 'fixtures', 'storyboard-isolation-runner.cjs');

function runFixture(t, storyboardIds, extraArgs = []) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-isolation-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const telemetryFile = path.join(directory, 'telemetry.jsonl');
  const resultsFile = path.join(directory, 'results.jsonl');
  const descendantPidFile = path.join(directory, 'descendant.pid');
  const result = spawnSync(process.execPath, [
    ORCHESTRATOR,
    '--timeout-ms', '3000',
    '--rss-limit-mb', '256',
    '--rss-poll-ms', '20',
    '--output-limit-mb', '4',
    '--telemetry-file', telemetryFile,
    '--results-file', resultsFile,
    ...extraArgs,
  ], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 15_000,
    env: {
      ...process.env,
      STORYBOARD_RUNNER_BIN: FIXTURE,
      FIXTURE_STORYBOARDS: storyboardIds.join(','),
      FIXTURE_DESCENDANT_PID_FILE: descendantPidFile,
    },
  });
  assert.ok(fs.existsSync(telemetryFile), result.stderr || result.stdout);
  assert.ok(fs.existsSync(resultsFile), result.stderr || result.stdout);
  const telemetry = fs.readFileSync(telemetryFile, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
  const results = fs.readFileSync(resultsFile, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
  const descendantPid = fs.existsSync(descendantPidFile)
    ? Number(fs.readFileSync(descendantPidFile, 'utf8'))
    : undefined;
  return { result, telemetry, results, descendantPid };
}

async function assertProcessExited(pid) {
  assert.ok(Number.isSafeInteger(pid), 'fixture did not record a descendant PID');
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === 'ESRCH') return;
      throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {}
  assert.fail(`descendant process ${pid} survived process-group teardown`);
}

test('orchestrator does not load the training agent or SDK', () => {
  const source = fs.readFileSync(ORCHESTRATOR, 'utf8');
  assert.doesNotMatch(source, /(?:import|require)\s*\(?['"][^'"]*@adcp\/sdk/);
  assert.doesNotMatch(source, /server\/src\/training-agent/);
  assert.match(source, /detached: true/);
  assert.match(source, /process\.platform === 'win32' \? pid : -pid/);
});

test('a timed-out child group is reported without losing successful siblings', async (t) => {
  const { result, telemetry, results, descendantPid } = runFixture(
    t,
    ['healthy_before', 'hang', 'healthy_after'],
    ['--timeout-ms', '300'],
  );

  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /storyboards: 2\/3 clean/);
  assert.match(result.stdout, /healthy_after/);
  assert.deepEqual(results.map(entry => entry.storyboard_id), ['healthy_before', 'healthy_after']);
  const hang = telemetry.find(entry => entry.storyboard_id === 'hang');
  assert.equal(hang.timed_out, true);
  assert.equal(hang.result_received, false);
  assert.equal(hang.signal, 'SIGKILL');
  await assertProcessExited(descendantPid);
});

test('a result is persisted before a post-result child group is killed', async (t) => {
  const { result, telemetry, results, descendantPid } = runFixture(t, ['post_result_hang', 'healthy_after']);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /storyboards: 2\/2 clean/);
  assert.deepEqual(results.map(entry => entry.storyboard_id), ['post_result_hang', 'healthy_after']);
  const hanging = telemetry.find(entry => entry.storyboard_id === 'post_result_hang');
  assert.equal(hanging.result_received, true);
  assert.equal(hanging.timed_out, false);
  assert.equal(hanging.signal, 'SIGKILL');
  await assertProcessExited(descendantPid);
});

test('a malformed envelope fails closed without stopping siblings', (t) => {
  const { result, telemetry, results } = runFixture(t, ['malformed_result', 'healthy_after']);

  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /storyboards: 1\/2 clean/);
  assert.deepEqual(results.map(entry => entry.storyboard_id), ['healthy_after']);
  const malformed = telemetry.find(entry => entry.storyboard_id === 'malformed_result');
  assert.equal(malformed.result_received, false);
  assert.equal(malformed.exit_code, 0);
});

test('an internally inconsistent envelope fails closed', (t) => {
  const { result, telemetry, results } = runFixture(t, ['inconsistent_result', 'healthy_after']);

  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /storyboards: 1\/2 clean/);
  assert.deepEqual(results.map(entry => entry.storyboard_id), ['healthy_after']);
  assert.equal(telemetry.find(entry => entry.storyboard_id === 'inconsistent_result').result_received, false);
});

test('a coherent but partial multi-variant envelope fails closed', (t) => {
  const { result, telemetry, results } = runFixture(t, ['signed_requests', 'healthy_after']);

  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /storyboards: 1\/2 clean/);
  assert.deepEqual(results.map(entry => entry.storyboard_id), ['healthy_after']);
  assert.equal(telemetry.find(entry => entry.storyboard_id === 'signed_requests').result_received, false);
});

test('a child crash is isolated without losing successful siblings', (t) => {
  const { result, telemetry, results } = runFixture(t, ['healthy_before', 'crash', 'healthy_after']);

  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /storyboards: 2\/3 clean/);
  assert.deepEqual(results.map(entry => entry.storyboard_id), ['healthy_before', 'healthy_after']);
  assert.equal(telemetry.find(entry => entry.storyboard_id === 'crash').exit_code, 17);
});

test('excessive child output is bounded and siblings continue', (t) => {
  const { result, telemetry, results } = runFixture(
    t,
    ['healthy_before', 'noisy', 'healthy_after'],
    ['--output-limit-mb', '1', '--timeout-ms', '3000'],
  );

  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /storyboards: 2\/3 clean/);
  assert.deepEqual(results.map(entry => entry.storyboard_id), ['healthy_before', 'healthy_after']);
  assert.equal(telemetry.find(entry => entry.storyboard_id === 'noisy').output_limited, true);
});

test('embedded carriage returns cannot forge workflow log commands', (t) => {
  const { result } = runFixture(t, ['log_commands']);

  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /\r/);
  assert.doesNotMatch(result.stderr, /\r/);
  assert.match(result.stdout, /stdout prefix::error::forged stdout command/);
  assert.match(result.stderr, /stderr prefix::warning::forged stderr command/);
});

test('an RSS breach is isolated and reported without stopping siblings', (t) => {
  const { result, telemetry, results } = runFixture(
    t,
    ['healthy_before', 'leak', 'healthy_after'],
    ['--rss-limit-mb', '80', '--timeout-ms', '3000'],
  );

  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /storyboards: 2\/3 clean/);
  assert.deepEqual(results.map(entry => entry.storyboard_id), ['healthy_before', 'healthy_after']);
  const leak = telemetry.find(entry => entry.storyboard_id === 'leak');
  assert.equal(leak.resource_limited, true);
  assert.equal(leak.result_received, false);
  assert.ok(leak.peak_rss_bytes > 80 * 1024 * 1024);
});
