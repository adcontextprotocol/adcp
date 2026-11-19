#!/usr/bin/env node

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { runChild } = require('./fixtures/storyboard-process-reaper.cjs');

const REPO_ROOT = path.join(__dirname, '..');
const ORCHESTRATOR = path.join(REPO_ROOT, 'scripts', 'run-storyboards-isolated.mjs');
const FIXTURE = path.join(REPO_ROOT, 'tests', 'fixtures', 'storyboard-isolation-runner.cjs');

function runFixture(t, storyboardIds, extraArgs = [], extraEnv = {}) {
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
      ...extraEnv,
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

test('Linux RSS sampling tolerates processes exiting during /proc scans', () => {
  const source = fs.readFileSync(ORCHESTRATOR, 'utf8');
  assert.match(source, /readdirSync\('\/proc'\)/);
  assert.doesNotMatch(source, /readdirSync\('\/proc',\s*\{\s*withFileTypes:\s*true\s*\}\)/);
});

test('child V8 heap is bounded without discarding caller Node options', (t) => {
  const { result } = runFixture(t, ['node_options'], [], { NODE_OPTIONS: '--trace-warnings' });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /NODE_OPTIONS=--trace-warnings --max-old-space-size=2048/);
});

test('a timed-out child group is reported without losing successful siblings', async (t) => {
  const { result, telemetry, results, descendantPid } = runFixture(
    t,
    ['healthy_before', 'hang', 'healthy_after'],
    ['--timeout-ms', '300'],
  );

  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /storyboards: 2\/3 clean/);
  assert.match(result.stdout, /selection: 3 applicable \| 1 not applicable \| 1 quarantined \| 5 corpus/);
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
  assert.match(result.stdout, /selection: 2 applicable \| 1 not applicable \| 1 quarantined \| 4 corpus/);
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

test('the current required-profile signed-request envelope is aggregated', (t) => {
  const { result, telemetry, results } = runFixture(
    t,
    ['signed_requests'],
    [],
    { FIXTURE_SIGNED_REQUESTS_SHAPE: 'current' },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /storyboards: 1\/1 clean/);
  assert.match(result.stdout, /steps: 1 passed/);
  assert.deepEqual(results.map(entry => entry.storyboard_id), ['signed_requests']);
  assert.equal(telemetry.find(entry => entry.storyboard_id === 'signed_requests').result_received, true);
});

test('the exact three legacy signed-request profiles are aggregated', (t) => {
  const { result, telemetry, results } = runFixture(
    t,
    ['signed_requests'],
    [],
    { FIXTURE_SIGNED_REQUESTS_SHAPE: 'legacy' },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /storyboards: 3\/3 clean/);
  assert.match(result.stdout, /steps: 3 passed/);
  assert.deepEqual(results.map(entry => entry.storyboard_id), ['signed_requests']);
  assert.equal(telemetry.find(entry => entry.storyboard_id === 'signed_requests').result_received, true);
});

test('duplicate signed-request profile summaries fail closed', (t) => {
  const { result, telemetry, results } = runFixture(
    t,
    ['signed_requests', 'healthy_after'],
    [],
    { FIXTURE_SIGNED_REQUESTS_SHAPE: 'duplicate' },
  );

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

// --- Many storyboards per worker process (--storyboards-per-process) -------
//
// Driven through the CLI with the fake runner. The fake records every process
// it starts and every storyboard each process runs (FIXTURE_START_LOG), so
// process counts and batch membership are observed independently of the
// orchestrator's telemetry. stdout and stderr share one file, so the section
// a line lands in is the order the orchestrator wrote it.

const TODAY_TELEMETRY_KEYS = [
  'storyboard_id',
  'elapsed_ms',
  'peak_rss_bytes',
  'output_bytes',
  'exit_code',
  'signal',
  'timed_out',
  'resource_limited',
  'output_limited',
  'monitor_error',
  'teardown_error',
  'result_received',
];
const WORKER_TELEMETRY_KEYS = [...TODAY_TELEMETRY_KEYS, 'worker_pid', 'worker_sequence', 'heap_used_bytes'];
const HEAP_RECYCLE_BOUND_BYTES = 1.5 * 1024 * 1024 * 1024;

function readJsonLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
}

// Asynchronous, so the runner's --test-timeout bounds a hung orchestrator;
// teardown kills its process group.
async function runOrchestrator(t, storyboardIds, extraArgs = [], extraEnv = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-isolation-worker-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const telemetryFile = path.join(directory, 'telemetry.jsonl');
  const resultsFile = path.join(directory, 'results.jsonl');
  const descendantPidFile = path.join(directory, 'descendant.pid');
  const startLog = path.join(directory, 'starts.jsonl');
  const outputFile = path.join(directory, 'output.log');
  const fd = fs.openSync(outputFile, 'w');
  let result;
  try {
    result = await runChild(t, process.execPath, [
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
      stdio: ['ignore', fd, fd],
      env: {
        ...process.env,
        STORYBOARD_RUNNER_BIN: FIXTURE,
        FIXTURE_STORYBOARDS: storyboardIds.join(','),
        FIXTURE_DESCENDANT_PID_FILE: descendantPidFile,
        FIXTURE_START_LOG: startLog,
        ...extraEnv,
      },
    });
  } finally {
    fs.closeSync(fd);
  }
  const output = fs.readFileSync(outputFile, 'utf8');
  const events = readJsonLines(startLog);
  const processes = events.filter(entry => entry.event === 'start');
  const workers = processes.filter(entry => entry.role === 'worker');
  const ranBy = pid => events
    .filter(entry => entry.event === 'run' && entry.pid === pid)
    .map(entry => entry.storyboard_id);
  return {
    result,
    output,
    telemetry: readJsonLines(telemetryFile),
    results: readJsonLines(resultsFile),
    descendantPid: fs.existsSync(descendantPidFile) ? Number(fs.readFileSync(descendantPidFile, 'utf8')) : undefined,
    processes,
    workers,
    // The storyboards each worker ran, workers in start order.
    batches: workers.map(worker => ranBy(worker.pid)),
  };
}

function withK(k, ...args) {
  return ['--storyboards-per-process', String(k), ...args];
}

function recordFor(run, storyboardId) {
  const records = run.telemetry.filter(entry => entry.storyboard_id === storyboardId);
  assert.equal(records.length, 1, `expected one telemetry record for ${storyboardId}:\n${run.output}`);
  return records[0];
}

// The orchestrator's output, split into its storyboard sections.
function sections(output) {
  const found = new Map();
  let current;
  for (const line of output.split('\n')) {
    const header = line.match(/^=== Isolated storyboard: (.+) ===$/);
    if (header) {
      current = header[1];
      found.set(current, []);
    } else if (/^--- Totals ---$/.test(line)) {
      current = undefined;
    } else if (current !== undefined) {
      found.get(current).push(line);
    }
  }
  return found;
}

function errorLines(output) {
  return output.split('\n').filter(line => line.startsWith('::error::'));
}

function withoutTelemetry(output) {
  return output.split('\n').filter(line => !line.startsWith('ADCP_STORYBOARD_TELEMETRY ')).join('\n');
}

function assertNoProtocolLines(run) {
  assert.doesNotMatch(run.output, /ADCP_STORYBOARD_BEGIN|ADCP_STORYBOARD_END/, 'a worker protocol line reached the output');
}

async function assertAllExited(pids) {
  for (const pid of pids) await assertProcessExited(pid);
}

function workerPids(run) {
  return run.workers.map(worker => worker.pid);
}

test('K = 1 is the fresh-process model: one process per storyboard, today\'s output and telemetry, options never passed to the runner', async (t) => {
  const ids = ['healthy_before', 'crash', 'healthy_after'];
  const today = await runOrchestrator(t, ids, ['--fixture-passthrough-probe']);
  const explicit = await runOrchestrator(t, ids, [
    '--fixture-passthrough-probe',
    ...withK(1),
    '--recycle-rss-mb', '100',
  ]);

  for (const run of [today, explicit]) {
    assert.equal(run.result.status, 1, run.output);
    assert.deepEqual(run.processes.map(entry => entry.role), ['discovery', 'isolated', 'isolated', 'isolated']);
    for (const entry of run.processes) {
      assert.ok(entry.args.includes('--fixture-passthrough-probe'), `passthrough lost: ${entry.args.join(' ')}`);
      assert.ok(!entry.args.includes('--storyboards-per-process'), `--storyboards-per-process reached the runner: ${entry.args.join(' ')}`);
      assert.ok(!entry.args.includes('--recycle-rss-mb'), `--recycle-rss-mb reached the runner: ${entry.args.join(' ')}`);
      assert.ok(!entry.args.includes('--storyboard-worker'), `K = 1 started a worker: ${entry.args.join(' ')}`);
    }
    assert.deepEqual(
      run.processes.filter(entry => entry.role === 'isolated').map(entry => entry.args.slice(-3)),
      ids.map(id => ['--storyboard-id', id, '--emit-result-envelope']),
    );
    for (const record of run.telemetry.filter(entry => entry.storyboard_id !== null)) {
      assert.deepEqual(Object.keys(record), TODAY_TELEMETRY_KEYS, `K = 1 changed the telemetry record of ${record.storyboard_id}`);
    }
    assert.deepEqual(errorLines(run.output), ['::error::crash did not emit a complete result envelope']);
  }
  assert.equal(withoutTelemetry(explicit.output), withoutTelemetry(today.output));
  assert.deepEqual(explicit.results, today.results);
});

test('invalid --storyboards-per-process and --recycle-rss-mb values are rejected before any runner starts', async (t) => {
  for (const [option, value] of [
    ['--storyboards-per-process', '0'],
    ['--storyboards-per-process', '-2'],
    ['--storyboards-per-process', '1.5'],
    ['--storyboards-per-process', 'many'],
    ['--recycle-rss-mb', '0'],
    ['--recycle-rss-mb', 'half'],
  ]) {
    const run = await runOrchestrator(t, ['healthy_before'], [option, value]);
    assert.notEqual(run.result.status, 0, `${option} ${value} was accepted:\n${run.output}`);
    assert.match(run.output, new RegExp(option), `${option} ${value}: the error does not name the option`);
    assert.deepEqual(run.processes, [], `${option} ${value}: a runner process started`);
  }
});

test('K > 1 runs each contiguous batch of K storyboards in one worker and reports every storyboard as a fresh process would', async (t) => {
  const ids = ['h_1', 'h_2', 'h_3', 'h_4', 'h_5', 'h_6', 'h_7'];
  const fresh = await runOrchestrator(t, ids, ['--fixture-passthrough-probe']);
  const first = await runOrchestrator(t, ids, ['--fixture-passthrough-probe', ...withK(3)]);
  const second = await runOrchestrator(t, ids, ['--fixture-passthrough-probe', ...withK(3)]);

  assert.equal(fresh.result.status, 0, fresh.output);
  for (const run of [first, second]) {
    assert.equal(run.result.status, 0, run.output);
    assert.match(run.output, /storyboards: 7\/7 clean/);
    assert.match(run.output, /steps: 7 passed \| 0 failed/);
    assert.deepEqual(run.processes.map(entry => entry.role), ['discovery', 'worker', 'worker', 'worker']);
    // Fixed batches in applicable order, so a storyboard's predecessors in
    // its worker follow from K alone.
    assert.deepEqual(run.batches, [['h_1', 'h_2', 'h_3'], ['h_4', 'h_5', 'h_6'], ['h_7']]);
    for (const worker of run.workers) {
      assert.ok(worker.args.includes('--storyboard-worker'), worker.args.join(' '));
      assert.ok(worker.args.includes('--emit-result-envelope'), worker.args.join(' '));
      assert.ok(worker.args.includes('--fixture-passthrough-probe'), `passthrough lost: ${worker.args.join(' ')}`);
      assert.ok(!worker.args.includes('--storyboard-id'), worker.args.join(' '));
      assert.ok(!worker.args.includes('--storyboards-per-process'), worker.args.join(' '));
    }
    assert.deepEqual(run.results.map(entry => entry.storyboard_id), ids);
    ids.forEach((id, index) => {
      const record = recordFor(run, id);
      assert.deepEqual(Object.keys(record).sort(), [...WORKER_TELEMETRY_KEYS].sort(), `${id} telemetry fields`);
      assert.equal(record.worker_pid, run.workers[Math.floor(index / 3)].pid, `${id} worker_pid`);
      assert.equal(record.worker_sequence, (index % 3) + 1, `${id} worker_sequence`);
      assert.ok(Number.isSafeInteger(record.heap_used_bytes) && record.heap_used_bytes > 0, `${id} heap_used_bytes`);
      assert.equal(record.result_received, true);
      assert.equal(record.timed_out, false);
      // Every worker ends after its last window closed, never inside one.
      assert.equal(record.exit_code, null, `${id} exit_code`);
      assert.equal(record.signal, null, `${id} signal`);
    });
    assertNoProtocolLines(run);
    // Each storyboard keeps exactly the section a fresh process gives it.
    assert.equal(withoutTelemetry(run.output), withoutTelemetry(fresh.output));
    await assertAllExited(workerPids(run));
  }
  assert.deepEqual(
    second.telemetry.map(entry => [entry.storyboard_id, entry.worker_sequence]),
    first.telemetry.map(entry => [entry.storyboard_id, entry.worker_sequence]),
  );

  // Batches are cut from this shard's storyboards only.
  const shard = await runOrchestrator(t, ids, [...withK(2), '--shard-index', '1', '--shard-count', '2']);
  assert.equal(shard.result.status, 0, shard.output);
  assert.match(shard.output, /Isolated orchestrator 2\/2: 4 of 7 applicable storyboards/);
  assert.deepEqual(shard.batches, [['h_4', 'h_5'], ['h_6', 'h_7']]);
});

test('each storyboard\'s timeout starts when its id is written, so a batch may outlast one timeout', async (t) => {
  const ids = ['slow_1', 'slow_2', 'slow_3', 'slow_4'];
  // Each storyboard takes 400 ms against a 1000 ms timeout; the batch takes
  // at least 1600 ms.
  const run = await runOrchestrator(t, ids, [...withK(4), '--timeout-ms', '1000'], { FIXTURE_SLOW_MS: '400' });

  assert.equal(run.result.status, 0, run.output);
  assert.match(run.output, /storyboards: 4\/4 clean/);
  assert.doesNotMatch(run.output, /timed out/);
  assert.deepEqual(run.batches, [ids]);
  for (const id of ids) assert.equal(recordFor(run, id).timed_out, false);
});

test('the output limit applies to each storyboard, not to the worker', async (t) => {
  // About 400 KiB each against a 1 MiB limit: 1.6 MiB per worker.
  const ids = ['chatty_1', 'chatty_2', 'chatty_3', 'chatty_4'];
  const run = await runOrchestrator(t, ids, [...withK(4), '--output-limit-mb', '1']);

  assert.equal(run.result.status, 0, errorLines(run.output).join('\n'));
  assert.match(run.output, /storyboards: 4\/4 clean/);
  assert.deepEqual(run.batches, [ids]);
  for (const id of ids) assert.equal(recordFor(run, id).output_limited, false);
});

const WORKER_FAILURES = [
  {
    bad: 'crash',
    reason: 'did not emit a complete result envelope',
    check: (record) => {
      assert.equal(record.exit_code, 17);
      assert.equal(record.signal, null);
    },
  },
  {
    bad: 'hang',
    args: ['--timeout-ms', '400'],
    reason: 'timed out after 400ms',
    descendant: true,
    check: (record) => {
      assert.equal(record.timed_out, true);
      assert.equal(record.signal, 'SIGKILL');
    },
  },
  {
    bad: 'leak',
    reason: `exceeded RSS limit of ${256 * 1024 * 1024} bytes`,
    check: (record) => {
      assert.equal(record.resource_limited, true);
      assert.ok(record.peak_rss_bytes > 256 * 1024 * 1024);
    },
  },
  {
    bad: 'noisy',
    args: ['--output-limit-mb', '1'],
    reason: `exceeded output limit of ${1024 * 1024} bytes`,
    // As in a fresh process, the limit is announced when it is hit.
    precedingErrors: [`::error::noisy exceeded child output limit of ${1024 * 1024} bytes`],
    check: record => assert.equal(record.output_limited, true),
  },
  {
    bad: 'malformed_result',
    reason: 'did not emit a complete result envelope',
    output: /Unable to accept result envelope from malformed_result/,
  },
  {
    // A complete envelope for h_c, the next storyboard: never h_c's result.
    bad: 'wrong_id',
    reason: 'did not emit a complete result envelope',
  },
];

for (const failure of WORKER_FAILURES) {
  test(`${failure.bad} in a worker fails only that storyboard, names its predecessors, and the batch finishes in a fresh worker`, async (t) => {
    const ids = ['h_a', 'h_b', failure.bad, 'h_c', 'h_d'];
    const run = await runOrchestrator(t, ids, [...withK(5), ...(failure.args ?? [])]);

    assert.equal(run.result.status, 1, run.output);
    assert.match(run.output, /storyboards: 4\/5 clean/);
    assert.match(run.output, /steps: 4 passed \| 0 failed/);
    assert.deepEqual(run.results.map(entry => entry.storyboard_id), ['h_a', 'h_b', 'h_c', 'h_d']);
    assert.deepEqual(errorLines(run.output), [
      ...(failure.precedingErrors ?? []),
      `::error::${failure.bad} ${failure.reason}; earlier in this worker: h_a, h_b`,
    ]);
    assert.ok(
      sections(run.output).get(failure.bad).includes(`::error::${failure.bad} ${failure.reason}; earlier in this worker: h_a, h_b`),
      `the failure is not reported in the ${failure.bad} section:\n${run.output}`,
    );
    if (failure.output) assert.match(run.output, failure.output);
    assert.deepEqual(run.batches, [['h_a', 'h_b', failure.bad], ['h_c', 'h_d']]);

    const bad = recordFor(run, failure.bad);
    assert.equal(bad.result_received, false);
    assert.equal(bad.worker_pid, run.workers[0].pid);
    assert.equal(bad.worker_sequence, 3);
    failure.check?.(bad);
    const next = recordFor(run, 'h_c');
    assert.equal(next.result_received, true);
    assert.equal(next.worker_pid, run.workers[1].pid);
    assert.equal(next.worker_sequence, 1);
    assertNoProtocolLines(run);
    await assertAllExited(workerPids(run));
    if (failure.descendant) await assertProcessExited(run.descendantPid);
  });
}

test('a failure as the first storyboard of a worker is reported exactly as today', async (t) => {
  const run = await runOrchestrator(t, ['crash', 'h_a'], withK(2));

  assert.equal(run.result.status, 1, run.output);
  assert.match(run.output, /storyboards: 1\/2 clean/);
  assert.deepEqual(errorLines(run.output), ['::error::crash did not emit a complete result envelope']);
  assert.deepEqual(run.batches, [['crash'], ['h_a']]);
  assert.equal(recordFor(run, 'crash').exit_code, 17);
  assert.equal(recordFor(run, 'h_a').worker_sequence, 1);
});

test('a worker that dies before its first storyboard begins fails that storyboard once and never loops', async (t) => {
  const ids = ['h_a', 'h_b', 'h_c'];
  const run = await runOrchestrator(t, ids, withK(3), { FIXTURE_WORKER_STARTUP_EXIT: '19' });

  assert.equal(run.result.status, 1, run.output);
  assert.match(run.output, /storyboards: 0\/3 clean/);
  assert.deepEqual(run.results, []);
  // One fresh worker per storyboard: each first window counts, no retry.
  assert.deepEqual(run.processes.map(entry => entry.role), ['discovery', 'worker', 'worker', 'worker']);
  assert.deepEqual(errorLines(run.output), ids.map(id => `::error::${id} did not emit a complete result envelope`));
  for (const id of ids) {
    const record = recordFor(run, id);
    assert.equal(record.exit_code, 19);
    assert.equal(record.worker_sequence, 1);
    assert.equal(record.heap_used_bytes, null);
  }
  await assertAllExited(workerPids(run));
});

test('a valid result without its END marker stands; the worker is killed and the batch continues', async (t) => {
  const run = await runOrchestrator(t, ['h_a', 'post_result_hang', 'h_b'], [...withK(3), '--timeout-ms', '500']);

  assert.equal(run.result.status, 0, run.output);
  assert.match(run.output, /storyboards: 3\/3 clean/);
  assert.deepEqual(errorLines(run.output), []);
  assert.doesNotMatch(run.output, /timed out/);
  assert.deepEqual(run.results.map(entry => entry.storyboard_id), ['h_a', 'post_result_hang', 'h_b']);
  assert.deepEqual(run.batches, [['h_a', 'post_result_hang'], ['h_b']]);
  const hanging = recordFor(run, 'post_result_hang');
  assert.equal(hanging.result_received, true);
  assert.equal(hanging.timed_out, false);
  assert.equal(hanging.heap_used_bytes, null);
  assert.equal(hanging.worker_pid, run.workers[0].pid);
  assert.equal(recordFor(run, 'h_b').worker_pid, run.workers[1].pid);
  assertNoProtocolLines(run);
  await assertAllExited(workerPids(run));
  await assertProcessExited(run.descendantPid);
});

test('late async failure from a clean storyboard fails the next one, whose reason names the earlier storyboards', async (t) => {
  const ids = ['h_a', 'late_throw', 'slow_victim', 'h_b'];
  const run = await runOrchestrator(t, ids, withK(4), { FIXTURE_SLOW_MS: '300' });

  assert.equal(run.result.status, 1, run.output);
  assert.match(run.output, /storyboards: 3\/4 clean/);
  assert.deepEqual(run.results.map(entry => entry.storyboard_id), ['h_a', 'late_throw', 'h_b']);
  assert.deepEqual(
    errorLines(run.output),
    ['::error::slow_victim did not emit a complete result envelope; earlier in this worker: h_a, late_throw'],
  );
  assert.equal(recordFor(run, 'late_throw').result_received, true);
  const victim = recordFor(run, 'slow_victim');
  assert.equal(victim.result_received, false);
  assert.equal(victim.exit_code, 1);
  assert.equal(victim.worker_sequence, 3);
  // The throw is printed where it happened: in slow_victim's window.
  const bySection = sections(run.output);
  assert.ok(bySection.get('slow_victim').some(line => line.includes('late failure from late_throw')), run.output);
  assert.ok(!bySection.get('late_throw').some(line => line.includes('late failure from late_throw')), run.output);
  assert.deepEqual(run.batches, [['h_a', 'late_throw', 'slow_victim'], ['h_b']]);
  assert.equal(recordFor(run, 'h_b').worker_sequence, 1);
  await assertAllExited(workerPids(run));
});

test('a worker that exits after a clean storyboard and before the next begins does not fail the next one', async (t) => {
  const ids = ['h_a', 'exit_after_end', 'h_b', 'h_c'];
  const run = await runOrchestrator(t, ids, withK(4));

  assert.equal(run.result.status, 0, run.output);
  assert.match(run.output, /storyboards: 4\/4 clean/);
  assert.deepEqual(errorLines(run.output), []);
  assert.deepEqual(run.results.map(entry => entry.storyboard_id), ids);
  assert.deepEqual(run.batches, [['h_a', 'exit_after_end'], ['h_b', 'h_c']]);
  // The worker ended outside every window.
  const exited = recordFor(run, 'exit_after_end');
  assert.equal(exited.exit_code, null);
  assert.equal(exited.signal, null);
  const next = recordFor(run, 'h_b');
  assert.equal(next.worker_pid, run.workers[1].pid);
  assert.equal(next.worker_sequence, 1);
  assert.equal(next.exit_code, null);
  await assertAllExited(workerPids(run));
});

test('a worker above --recycle-rss-mb after a clean storyboard is replaced; the default bound is half of --rss-limit-mb', async (t) => {
  const ids = ['h_a', 'retain', 'h_b', 'h_c'];
  // retain keeps 320 MiB: above the default 256 MiB bound of a 512 MiB limit,
  // below an explicit 480 MiB bound, and below the limit itself.
  const environment = { FIXTURE_RETAIN_MB: '320' };
  const byDefault = await runOrchestrator(t, ids, [...withK(4), '--rss-limit-mb', '512'], environment);
  const raised = await runOrchestrator(t, ids, [...withK(4), '--rss-limit-mb', '512', '--recycle-rss-mb', '480'], environment);

  for (const run of [byDefault, raised]) {
    assert.equal(run.result.status, 0, run.output);
    assert.match(run.output, /storyboards: 4\/4 clean/);
    assert.deepEqual(errorLines(run.output), []);
    assert.deepEqual(run.results.map(entry => entry.storyboard_id), ids);
    assert.equal(recordFor(run, 'retain').resource_limited, false);
    await assertAllExited(workerPids(run));
  }
  assert.deepEqual(byDefault.batches, [['h_a', 'retain'], ['h_b', 'h_c']]);
  assert.deepEqual(raised.batches, [ids]);
});

test('a worker whose END marker reports more than 1.5 GiB of V8 heap is replaced; exactly 1.5 GiB is not', async (t) => {
  const ids = ['h_a', 'heap_at_bound', 'h_b', 'heap_heavy', 'h_c', 'h_d'];
  const run = await runOrchestrator(t, ids, withK(6));

  assert.equal(run.result.status, 0, run.output);
  assert.match(run.output, /storyboards: 6\/6 clean/);
  assert.deepEqual(run.batches, [['h_a', 'heap_at_bound', 'h_b', 'heap_heavy'], ['h_c', 'h_d']]);
  assert.equal(recordFor(run, 'heap_at_bound').heap_used_bytes, HEAP_RECYCLE_BOUND_BYTES);
  assert.equal(recordFor(run, 'heap_heavy').heap_used_bytes, HEAP_RECYCLE_BOUND_BYTES + 1);
  assert.equal(recordFor(run, 'h_c').worker_sequence, 1);
});

test('stderr up to a storyboard\'s END marker stays in that storyboard\'s section', async (t) => {
  const run = await runOrchestrator(t, ['h_a', 'stderr_around_result', 'h_b'], withK(3));

  assert.equal(run.result.status, 0, run.output);
  assert.match(run.output, /storyboards: 3\/3 clean/);
  const bySection = sections(run.output);
  for (const line of [
    '[child stderr] stderr before the result of stderr_around_result',
    '[child stderr] stderr after the result of stderr_around_result',
  ]) {
    assert.ok(bySection.get('stderr_around_result').includes(line), `${line} left its section:\n${run.output}`);
    assert.ok(!bySection.get('h_b').includes(line), `${line} landed in the next section:\n${run.output}`);
  }
  assertNoProtocolLines(run);
});
