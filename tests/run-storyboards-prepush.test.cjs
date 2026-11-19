#!/usr/bin/env node

'use strict';

// scripts/run-storyboards-matrix.sh and scripts/run-storyboards-prepush.sh,
// driven through their CLIs with the fake runner
// tests/fixtures/storyboard-matrix-runner.cjs injected as STORYBOARD_RUNNER_BIN
// and ADCP_STORYBOARD_TEST_SKIP_BUILDS=1. Both run every training-agent
// process (single-process tenants, isolated discoveries and isolated
// storyboard children) from one queue (scripts/run-storyboards-queue.mjs).
//
// A `node`/`npx` tripwire on PATH records, and refuses, any schema or
// compliance build and any real `npx tsx` runner, so these tests can never
// start the real storyboard matrix or rewrite the tree. The current surface
// reads a placeholder dist/ (ADCP_STORYBOARD_TEST_BUILT_DIST: an index.json
// in schemas/latest and compliance/latest), since the fake runners read no
// schema or storyboard; the 3.0-compat surface reads the committed release
// bundles. Concurrency is proven with the live-marker probe; no assertion
// reads a clock. Every run is asynchronous (runChild), so the runner's
// --test-timeout bounds it.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const test = require('node:test');
const { isAlive, readObserved } = require('./fixtures/storyboard-live-marker.cjs');
const { makeReapedWorkspace, runChild, trackProcess } = require('./fixtures/storyboard-process-reaper.cjs');

const REPO_ROOT = path.join(__dirname, '..');
const MATRIX = path.join(REPO_ROOT, 'scripts', 'run-storyboards-matrix.sh');
const PREPUSH = path.join(REPO_ROOT, 'scripts', 'run-storyboards-prepush.sh');
const FAKE_RUNNER = path.join(REPO_ROOT, 'tests', 'fixtures', 'storyboard-matrix-runner.cjs');
const SURFACES = ['current', '3.0-compat'];
const REAL_MKTEMP = execFileSync('sh', ['-c', 'command -v mktemp'], { encoding: 'utf8' }).trim();

const PACKAGE_VERSION = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).version;

// --- Plans derived from the matrix's own floors and required lists ---------

function matrixConfig() {
  const source = fs.readFileSync(MATRIX, 'utf8');
  const arrays = {};
  for (const match of source.matchAll(/^([A-Z][A-Z0-9_]*)=\(\n([\s\S]*?)\n\)/gm)) {
    arrays[match[1]] = [...match[2].matchAll(/^\s*"([^"]+)"/gm)].map(entry => entry[1]);
  }
  const tenantBlocks = [...source.matchAll(/^\s*TENANTS=\(\n([\s\S]*?)\n\s*\)/gm)].map(match => (
    [...match[1].matchAll(/^\s*"([a-z-]+):(\d+):(\d+)"/gm)].map(entry => ({
      tenant: entry[1],
      clean: Number(entry[2]),
      passed: Number(entry[3]),
    }))
  ));
  assert.equal(tenantBlocks.length, 2, 'expected the 3.0-compat and current TENANTS blocks');
  const floors = { '3.0-compat': tenantBlocks[0], current: tenantBlocks[1] };
  assert.ok(floors.current.some(entry => entry.tenant === 'sales' && entry.clean === 191));
  assert.ok(floors['3.0-compat'].some(entry => entry.tenant === 'sales' && entry.clean === 39));
  return { arrays, floors };
}

const CONFIG = matrixConfig();

function isIsolated(surface, tenant) {
  return (surface === 'current' && tenant === 'sales') || tenant === 'creative-builder';
}

function floorOf(surface, tenant) {
  return CONFIG.floors[surface].find(entry => entry.tenant === tenant);
}

function requiredRows(surface, tenant) {
  const key = tenant.toUpperCase().replace(/-/g, '_');
  const clean = surface === 'current'
    ? CONFIG.arrays[`REQUIRED_CLEAN_CURRENT_${key}`] ?? []
    : CONFIG.arrays[`REQUIRED_CLEAN_THREE_ZERO_${key}`] ?? [];
  const exact = surface === 'current' ? CONFIG.arrays[`REQUIRED_EXACT_CURRENT_${key}`] ?? [] : [];
  const rows = new Map(clean.map(id => [id, { id, passed: 1, skipped: 0 }]));
  for (const requirement of exact) {
    const [id, passed, skipped] = requirement.split(/:(?=\d+:\d+$)|:(?=\d+$)/);
    rows.set(id, { id, passed: Number(passed), skipped: Number(skipped) });
  }
  return [...rows.values()];
}

/**
 * passing: every tenant meets its floor and required rows.
 * below: tenants one clean storyboard under their floor.
 * small: isolated tenants with three storyboards only (below floor, cheap).
 */
function tenantPlan(surface, tenant, { below = false, small = false } = {}) {
  const floor = floorOf(surface, tenant);
  const rows = requiredRows(surface, tenant);
  if (!isIsolated(surface, tenant)) {
    const clean = below ? floor.clean - 1 : floor.clean;
    return { mode: 'monolithic', rows, totals: { clean, total: clean, passed: floor.passed } };
  }
  if (small) {
    // Healthy children plus one of each failure the orchestrator reports, so
    // output identity covers failure sections too.
    return {
      mode: 'isolated',
      storyboards: [
        { id: `${tenant}_small_a`, passed: 1, skipped: 0 },
        { id: `${tenant}_small_crash`, passed: 1, skipped: 0, behavior: 'crash' },
        { id: `${tenant}_small_b`, passed: 1, skipped: 0 },
        { id: `${tenant}_small_malformed`, passed: 1, skipped: 0, behavior: 'malformed' },
        { id: `${tenant}_small_chatter`, passed: 1, skipped: 0, behavior: 'chatter' },
        { id: `${tenant}_small_c`, passed: 1, skipped: 0 },
      ],
    };
  }
  const fillerCount = Math.max(0, floor.clean - rows.length - (below ? 1 : 0));
  const rowPassed = rows.reduce((sum, entry) => sum + entry.passed, 0);
  const fillerPassed = Math.max(1, Math.ceil(Math.max(0, floor.passed - rowPassed) / Math.max(1, fillerCount)));
  const fillers = Array.from({ length: fillerCount }, (_, index) => ({
    id: `${tenant}_filler_${index}`,
    passed: fillerPassed,
    skipped: 0,
  }));
  return { mode: 'isolated', storyboards: [...rows, ...fillers] };
}

function buildPlan({ surfaces = SURFACES, below = [], small = [] } = {}) {
  const plan = {};
  for (const surface of surfaces) {
    for (const { tenant } of CONFIG.floors[surface]) {
      plan[`${surface}:${tenant}`] = tenantPlan(surface, tenant, {
        below: below.includes(`${surface}:${tenant}`),
        small: small.includes(surface),
      });
    }
  }
  return plan;
}

// --- Harness ---------------------------------------------------------------

function makeHarness(t, plan) {
  const work = fs.realpathSync(makeReapedWorkspace(t, 'adcp-prepush-test-'));
  const bin = path.join(work, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'node'), `#!/bin/sh
case "$*" in
  *build-schemas.cjs*|*build-compliance.cjs*)
    printf 'blocked-build %s\\n' "$*" >> "$FAKE_EVENTS_LOG"
    exit 98
    ;;
  *ensureBuiltSchemas*|*built-schemas*)
    "$FAKE_REAL_NODE" "$@"
    status=$?
    printf 'ensure-done %s\\n' "$status" >> "$FAKE_EVENTS_LOG"
    exit "$status"
    ;;
esac
exec "$FAKE_REAL_NODE" "$@"
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'npx'), `#!/bin/sh
printf 'blocked-npx %s\\n' "$*" >> "$FAKE_EVENTS_LOG"
exit 97
`, { mode: 0o755 });
  // macOS `mktemp -t` ignores TMPDIR (it uses DARWIN_USER_TEMP_DIR). Keep its
  // naming (prefix.XXXXXXXX) but always create under $TMPDIR, as GNU mktemp
  // does, so every temporary file or directory a run creates is observable.
  fs.writeFileSync(path.join(bin, 'mktemp'), `#!/bin/sh
directory=""
base="\${TMPDIR:-/tmp}"
prefix=""
template=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -d) directory="-d"; shift ;;
    -q|-u) shift ;;
    -p) base="$2"; shift 2 ;;
    -t) prefix="$2"; shift 2 ;;
    -dt|-td) directory="-d"; prefix="$2"; shift 2 ;;
    *) template="$1"; shift ;;
  esac
done
if [ -n "$prefix" ]; then
  template="$base/$prefix.XXXXXXXX"
elif [ -z "$template" ]; then
  template="$base/tmp.XXXXXXXX"
fi
exec "$FAKE_REAL_MKTEMP" $directory "$template"
`, { mode: 0o755 });
  const planFile = path.join(work, 'plan.json');
  fs.writeFileSync(planFile, JSON.stringify(plan));
  const schemaRoot = path.join(work, 'schema-root');
  fs.mkdirSync(schemaRoot);
  fs.writeFileSync(path.join(schemaRoot, 'index.json'), '{}\n');
  // What the matrix reads of the built current surface: the schema root it
  // snapshots (a nested file shows the copy is recursive) and the compliance
  // index whose version picks the floor set.
  const builtDist = path.join(work, 'built-dist');
  fs.mkdirSync(path.join(builtDist, 'schemas', 'latest', 'core'), { recursive: true });
  fs.writeFileSync(path.join(builtDist, 'schemas', 'latest', 'index.json'), '{ "$id": "https://adcontextprotocol.org/schemas/latest/index.json" }\n');
  fs.writeFileSync(path.join(builtDist, 'schemas', 'latest', 'core', 'account.json'), '{}\n');
  fs.mkdirSync(path.join(builtDist, 'compliance', 'latest'), { recursive: true });
  fs.writeFileSync(path.join(builtDist, 'compliance', 'latest', 'index.json'), `${JSON.stringify({ published_version: PACKAGE_VERSION, adcp_version: PACKAGE_VERSION })}\n`);
  let runs = 0;

  const prepare = (label, extraEnv = {}) => {
    runs += 1;
    const dir = path.join(work, `${label}-${runs}`);
    const tmp = path.join(dir, 'tmp');
    fs.mkdirSync(tmp, { recursive: true });
    const eventsLog = path.join(dir, 'events.log');
    fs.writeFileSync(eventsLog, '');
    const logDir = path.join(dir, 'logs');
    const env = { ...process.env };
    for (const name of [
      'ADCP_STORYBOARD_JOBS',
      'ADCP_STORYBOARD_LOG_DIR',
      'ADCP_SCHEMA_ROOT',
      'ADCP_COMPLIANCE_DIR',
      'ADCP_STORYBOARD_CANDIDATE_VERSION_MODE',
      'STORYBOARD_TIMEOUT_MS',
      'FIXTURE_MARKER_DIR',
      'FAKE_HANG_DIR',
      'PUBLIC_TEST_AGENT_TOKEN',
      'ADCP_VALIDATOR_CACHE_DIR',
      'STORYBOARD_STORYBOARDS_PER_PROCESS',
      'ADCP_STORYBOARD_TEST_BUILT_DIST',
    ]) delete env[name];
    Object.assign(env, {
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      TMPDIR: tmp,
      FAKE_REAL_NODE: process.execPath,
      FAKE_REAL_MKTEMP: REAL_MKTEMP,
      FAKE_EVENTS_LOG: eventsLog,
      FAKE_STORYBOARD_PLAN: planFile,
      STORYBOARD_RUNNER_BIN: FAKE_RUNNER,
      ADCP_STORYBOARD_TEST_SKIP_BUILDS: '1',
      ADCP_STORYBOARD_TEST_BUILT_DIST: builtDist,
      ADCP_STORYBOARD_LOG_DIR: logDir,
      // One fresh process per isolated storyboard, CI's process model. The
      // tests of the batched default (workers of 12) pass
      // STORYBOARD_STORYBOARDS_PER_PROCESS: undefined to unset it.
      STORYBOARD_STORYBOARDS_PER_PROCESS: '1',
    }, extraEnv);
    for (const [name, value] of Object.entries(env)) {
      if (value === undefined) delete env[name];
    }
    return { dir, tmp, eventsLog, logDir, env, builtDist };
  };
  const run = (command, args, env) => runChild(t, command, args, { cwd: REPO_ROOT, directory: work, env });

  return { work, schemaRoot, builtDist, prepare, run };
}

function readEvents(eventsLog) {
  return fs.readFileSync(eventsLog, 'utf8').split('\n').filter(Boolean).map((line) => {
    if (line.startsWith('{')) return JSON.parse(line);
    const [event, ...rest] = line.split(' ');
    return { event, detail: rest.join(' ') };
  });
}

function starts(events) {
  return events.filter(entry => entry.event === 'start');
}

function assertNoRealBuildsOrRunners(events) {
  const blocked = events.filter(entry => entry.event === 'blocked-build' || entry.event === 'blocked-npx');
  assert.deepEqual(blocked, [], 'a schema/compliance build or the real npx tsx runner was started');
}

function maskTelemetryRecord(record) {
  const masked = { ...record, elapsed_ms: '<n>', peak_rss_bytes: '<n>', output_bytes: '<n>' };
  if (record.result_received) {
    masked.exit_code = '<exit>';
    masked.signal = '<exit>';
  }
  return masked;
}

// A child's stdout and stderr reach the orchestrator through two pipes, so
// their relative order is not defined, in a serial run or a concurrent one.
// Each stream keeps its own order; compare that, with every "[child stderr]"
// line moved after the stdout lines of its storyboard section.
function groupChildStderr(text) {
  const sections = text.split(/(?=^=== Isolated storyboard: )/m);
  return sections.map((section) => {
    const lines = section.split('\n');
    const stderr = lines.filter(line => line.startsWith('[child stderr] '));
    if (stderr.length === 0) return section;
    return [...lines.filter(line => !line.startsWith('[child stderr] ')), ...stderr].join('\n');
  }).join('');
}

function maskOutput(text, { tmp, logDir }, maskRecord = maskTelemetryRecord) {
  return groupChildStderr(text
    .split(logDir).join('<LOGS>')
    .split(tmp).join('<TMP>')
    .replace(/<TMP>\/[^\s)]+/g, '<TMP>/<file>')
    .replace(/^(.*)ADCP_STORYBOARD_TELEMETRY (\{.*\})$/gm, (_line, prefix, json) => (
      `${prefix}ADCP_STORYBOARD_TELEMETRY ${JSON.stringify(maskRecord(JSON.parse(json)))}`
    )));
}

function leftovers(tmp) {
  return fs.readdirSync(tmp).sort();
}

// Temporary state (schema snapshot, 3.0 bundle, queue state, spill files,
// buffered output) is always removed.
function assertNoTemporaryState(tmp) {
  assert.deepEqual(leftovers(tmp), [], 'temporary files or directories were left behind');
}

// Every tenant log of a graded surface stays, passing or failing, so the
// per-storyboard rows of one run can be compared with another's.
function assertTenantLogsKept(run, surface) {
  const directory = path.join(run.logDir, surface);
  const expected = CONFIG.floors[surface].map(({ tenant }) => `${tenant}.log`).sort();
  assert.deepEqual(fs.readdirSync(directory).sort(), expected, `${surface}: expected one kept log per tenant`);
  for (const name of expected) {
    assert.match(fs.readFileSync(path.join(directory, name), 'utf8'), /storyboards: \d+\/\d+ clean/, `${surface}/${name} has no totals`);
  }
}

function tenantLog(run, surface, tenant) {
  return fs.readFileSync(path.join(run.logDir, surface, `${tenant}.log`), 'utf8');
}

// What ran: one monolithic run per monolithic tenant, one discovery per
// isolated tenant and one child per planned isolated storyboard.
// Processes that join the overlap probe: single-process tenants and isolated
// children that reach their result (healthy or chatter).
function expectedParticipants(plan, surfaces) {
  let count = 0;
  for (const surface of surfaces) {
    for (const { tenant } of CONFIG.floors[surface]) {
      const entry = plan[`${surface}:${tenant}`];
      if (entry.mode === 'monolithic') count += 1;
      else count += entry.storyboards.filter(storyboard => !['crash', 'malformed'].includes(storyboard.behavior)).length;
    }
  }
  return count;
}

function expectedStarts(plan, surfaces) {
  const expected = [];
  for (const surface of surfaces) {
    for (const { tenant } of CONFIG.floors[surface]) {
      const tenantPlanEntry = plan[`${surface}:${tenant}`];
      if (tenantPlanEntry.mode === 'monolithic') {
        expected.push(`${surface} ${tenant} monolithic`);
      } else {
        expected.push(`${surface} ${tenant} discovery`);
        for (const storyboard of tenantPlanEntry.storyboards) {
          expected.push(`${surface} ${tenant} isolated ${storyboard.id}`);
        }
      }
    }
  }
  return expected.sort();
}

function actualStarts(events) {
  return starts(events)
    .map(entry => [entry.surface, entry.tenant, entry.role, entry.storyboard_id].filter(Boolean).join(' '))
    .sort();
}

function summaryLine(stdout, surfaceLabel, tenant) {
  const start = stdout.indexOf(`Storyboard matrix summary (${surfaceLabel}`);
  assert.notEqual(start, -1, `missing ${surfaceLabel} summary`);
  const line = stdout.slice(start).split('\n').find(candidate => candidate.startsWith(`  /${tenant}: `));
  assert.ok(line, `missing /${tenant} summary row`);
  return line;
}

// --- run-storyboards-matrix.sh ---------------------------------------------

test('matrix output is identical at ADCP_STORYBOARD_JOBS=1 and 4 while tenants run concurrently', async (t) => {
  const plan = buildPlan({ surfaces: ['current'], below: ['current:governance'], small: ['current'] });
  const harness = makeHarness(t, plan);
  const runAt = async (jobs) => {
    const run = harness.prepare(`matrix-jobs-${jobs}`);
    const markerDir = path.join(run.dir, 'markers');
    const result = await harness.run('bash', [MATRIX], {
      ...run.env,
      ADCP_STORYBOARD_JOBS: String(jobs),
      ADCP_SCHEMA_ROOT: harness.schemaRoot,
      FIXTURE_MARKER_DIR: markerDir,
      FIXTURE_MARKER_PEERS: '2',
      FIXTURE_MARKER_WAIT_MS: '800',
      FIXTURE_MARKER_HOLD_MS: '100',
    });
    const observed = readObserved(markerDir);
    return {
      ...run,
      result,
      events: readEvents(run.eventsLog),
      observedCount: observed.length,
      maxLive: observed.length === 0 ? 0 : Math.max(...observed.map(entry => entry.max)),
    };
  };
  const serial = await runAt(1);
  const concurrent = await runAt(4);

  for (const run of [serial, concurrent]) {
    assertNoRealBuildsOrRunners(run.events);
    assert.deepEqual(
      run.events.filter(entry => entry.event === 'ensure-done'),
      [],
      'ADCP_STORYBOARD_TEST_SKIP_BUILDS=1 must skip the matrix schema ensure',
    );
    assert.deepEqual(actualStarts(run.events), expectedStarts(plan, ['current']));
    assert.equal(
      run.observedCount,
      expectedParticipants(plan, ['current']),
      'every single-process tenant and healthy isolated child must report its overlap observation',
    );
  }

  // ADCP_STORYBOARD_JOBS=1 is the serial escape hatch; 4 runs tenants and
  // isolated children side by side but never more than four training-agent
  // processes at once.
  assert.equal(serial.maxLive, 1, 'ADCP_STORYBOARD_JOBS=1 overlapped tenant processes');
  assert.ok(concurrent.maxLive >= 2, `ADCP_STORYBOARD_JOBS=4 never overlapped tenants (max live ${concurrent.maxLive})`);
  assert.ok(concurrent.maxLive <= 4, `ADCP_STORYBOARD_JOBS=4 ran ${concurrent.maxLive} tenant processes at once`);

  // Same inputs per process, whatever the job count.
  const inputs = run => starts(run.events)
    .map(entry => JSON.stringify([
      entry.surface, entry.tenant, entry.role, entry.storyboard_id,
      entry.candidate_version_mode, entry.compliance_dir, entry.schema_root, entry.token,
    ]))
    .sort();
  assert.deepEqual(inputs(concurrent), inputs(serial));

  // Grading: below-floor and isolated tenants fail, the rest pass, exit 1.
  for (const run of [serial, concurrent]) {
    assert.equal(run.result.status, 1, run.result.stderr);
    const governance = floorOf('current', 'governance');
    assert.match(
      summaryLine(run.result.stdout, 'current compliance source', 'governance'),
      new RegExp(`^ {2}/governance: ✗ clean storyboards ${governance.clean - 1} < ${governance.clean} \\(log: `),
    );
    const si = floorOf('current', 'si');
    assert.match(summaryLine(run.result.stdout, 'current compliance source', 'si'), new RegExp(`^  /si: ✓ ${si.clean} clean, ${si.passed} steps;`));
    assert.match(summaryLine(run.result.stdout, 'current compliance source', 'signals'), /^ {2}\/signals: ✓/);
    assert.match(summaryLine(run.result.stdout, 'current compliance source', 'sales'), /^ {2}\/sales: ✗ clean storyboards 4 < 191/);
    // The crashed and malformed children are reported in their own sections.
    assert.match(run.result.stdout, /::error::sales_small_crash did not emit a complete result envelope/);
    assert.match(run.result.stdout, /Unable to accept result envelope from sales_small_malformed/);
    assert.match(run.result.stdout, /✗ One or more tenants regressed below floor — push blocked\./);
    assertNoTemporaryState(run.tmp);
    assertTenantLogsKept(run, 'current');
  }

  assert.equal(maskOutput(concurrent.result.stdout, concurrent), maskOutput(serial.result.stdout, serial));
  assert.equal(maskOutput(concurrent.result.stderr, concurrent), maskOutput(serial.result.stderr, serial));
});

test('an isolated child queued longer than its timeout is not reported as timed out', async (t) => {
  // One job: the five single-process tenants run first and each holds the
  // queue for 400 ms (it waits for peers that never come), so the isolated
  // children wait about 2 s, longer than their 1.5 s timeout.
  const plan = buildPlan({ surfaces: ['current'] });
  for (const tenant of ['sales', 'creative-builder']) {
    plan[`current:${tenant}`] = {
      mode: 'isolated',
      storyboards: ['queued_a', 'queued_b'].map(id => ({ id: `${tenant}_${id}`, passed: 1, skipped: 0 })),
    };
  }
  const harness = makeHarness(t, plan);
  const run = harness.prepare('matrix-queued');
  const markerDir = path.join(run.dir, 'markers');
  const result = await harness.run('bash', [MATRIX], {
    ...run.env,
    ADCP_STORYBOARD_JOBS: '1',
    STORYBOARD_TIMEOUT_MS: '1500',
    ADCP_SCHEMA_ROOT: harness.schemaRoot,
    FIXTURE_MARKER_DIR: markerDir,
    FIXTURE_MARKER_PEERS: '99',
    FIXTURE_MARKER_WAIT_MS: '400',
    FIXTURE_MARKER_HOLD_MS: '0',
  });
  const events = readEvents(run.eventsLog);
  assertNoRealBuildsOrRunners(events);
  const order = starts(events).map(entry => entry.role);
  assert.ok(
    order.lastIndexOf('monolithic') < order.indexOf('isolated'),
    `isolated children must queue behind the single-process tenants (${order.join(', ')})`,
  );
  assert.equal(Math.max(...readObserved(markerDir).map(entry => entry.max)), 1, 'ADCP_STORYBOARD_JOBS=1 overlapped processes');
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /timed out/);
  for (const tenant of ['sales', 'creative-builder']) {
    const text = tenantLog(run, 'current', tenant);
    assert.match(text, /storyboards: 2\/2 clean/);
    for (const line of text.split('\n').filter(entry => entry.startsWith('ADCP_STORYBOARD_TELEMETRY '))) {
      const record = JSON.parse(line.slice('ADCP_STORYBOARD_TELEMETRY '.length));
      assert.equal(record.timed_out, false, `${record.storyboard_id} was charged for queueing time`);
      assert.equal(record.result_received, true);
    }
  }
});

// --- Many storyboards per worker (the matrix default) ----------------------
//
// The matrix passes --storyboards-per-process
// ${STORYBOARD_STORYBOARDS_PER_PROCESS:-12} to every isolated tenant, so each
// isolated tenant starts its discovery plus one worker per batch of 12, and a
// fresh worker for the rest of a batch after a failed storyboard.

const STORYBOARDS_PER_WORKER = 12;

// 26 storyboards: a crash at 3 and a malformed envelope at 15 each end their
// worker; chatter at 20 interleaves stdout and stderr.
function batchedTenantPlan(tenant) {
  const behaviors = { 3: 'crash', 15: 'malformed', 20: 'chatter' };
  return {
    mode: 'isolated',
    storyboards: Array.from({ length: 26 }, (_, index) => {
      const behavior = behaviors[index];
      return {
        id: `${tenant}_batch_${String(index).padStart(2, '0')}${behavior ? `_${behavior}` : ''}`,
        passed: 1,
        skipped: 0,
        ...(behavior ? { behavior } : {}),
      };
    }),
  };
}

function chunk(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

// The storyboards each worker of a tenant ran, as reported by the fake runner,
// ordered by their first storyboard (workers of one tenant may start in any
// order when the pool runs several batches at once).
function workerBatches(events, surface, tenant) {
  const workers = starts(events).filter(entry => (
    entry.role === 'worker' && entry.surface === surface && entry.tenant === tenant
  ));
  return workers
    .map(worker => events
      .filter(entry => entry.event === 'run' && entry.pid === worker.pid)
      .map(entry => entry.storyboard_id))
    .sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));
}

function expectedBatchedStarts(plan, surfaces, workersOf) {
  const expected = [];
  for (const surface of surfaces) {
    for (const { tenant } of CONFIG.floors[surface]) {
      const entry = plan[`${surface}:${tenant}`];
      if (entry.mode === 'monolithic') {
        expected.push(`${surface} ${tenant} monolithic`);
      } else {
        expected.push(`${surface} ${tenant} discovery`);
        for (let index = 0; index < workersOf(surface, tenant, entry); index += 1) {
          expected.push(`${surface} ${tenant} worker`);
        }
      }
    }
  }
  return expected.sort();
}

function maskBatchedTelemetryRecord(record) {
  const masked = maskTelemetryRecord(record);
  if ('worker_pid' in record) masked.worker_pid = '<pid>';
  if (record.heap_used_bytes !== null && record.heap_used_bytes !== undefined) masked.heap_used_bytes = '<n>';
  // A rejected envelope makes the orchestrator kill the worker. Whether the
  // worker's END marker (stderr, which carries the heap figure) is read
  // before that depends on the order of two pipes, as with the stderr lines
  // above, so the figure may be a number or null in any run.
  if (!record.result_received && 'heap_used_bytes' in record) masked.heap_used_bytes = '<n or null>';
  return masked;
}

// What a storyboard section says, whatever the process model: telemetry lines
// dropped, and the worker's earlier storyboards dropped from failure reasons.
function sectionsWithoutProcessModel(text, run) {
  return maskOutput(text, run)
    .split('\n')
    .filter(line => !line.includes('ADCP_STORYBOARD_TELEMETRY '))
    .map(line => line.replace(/; earlier in this worker: .*$/, ''))
    .join('\n');
}

function assertNoProtocolLines(text, label) {
  assert.doesNotMatch(text, /ADCP_STORYBOARD_BEGIN|ADCP_STORYBOARD_END/, `${label}: a worker protocol line reached the output`);
}

const ISOLATED_CURRENT = ['sales', 'creative-builder'];

test('the matrix runs isolated tenants in workers of 12 by default, with identical output at ADCP_STORYBOARD_JOBS=1 and 4', async (t) => {
  const plan = buildPlan({ surfaces: ['current'] });
  for (const tenant of ISOLATED_CURRENT) plan[`current:${tenant}`] = batchedTenantPlan(tenant);
  const harness = makeHarness(t, plan);
  const runAt = async (jobs, perProcess, { probe = true } = {}) => {
    const run = harness.prepare(`matrix-batched-${jobs}-${perProcess ?? 'default'}`);
    const markerDir = path.join(run.dir, 'markers');
    const env = {
      ...run.env,
      ADCP_STORYBOARD_JOBS: String(jobs),
      ADCP_SCHEMA_ROOT: harness.schemaRoot,
      ...(probe ? {
        FIXTURE_MARKER_DIR: markerDir,
        FIXTURE_MARKER_PEERS: '2',
        FIXTURE_MARKER_WAIT_MS: '400',
        FIXTURE_MARKER_HOLD_MS: '50',
      } : {}),
    };
    if (perProcess === undefined) delete env.STORYBOARD_STORYBOARDS_PER_PROCESS;
    else env.STORYBOARD_STORYBOARDS_PER_PROCESS = perProcess;
    const result = await harness.run('bash', [MATRIX], env);
    const observed = probe ? readObserved(markerDir) : [];
    return {
      ...run,
      result,
      events: readEvents(run.eventsLog),
      observedCount: observed.length,
      maxLive: observed.length === 0 ? 0 : Math.max(...observed.map(entry => entry.max)),
    };
  };
  const serial = await runAt(1);
  const concurrent = await runAt(4);
  const perStoryboard = await runAt(4, '1', { probe: false });

  const expectedBatches = tenant => [
    [0, 1, 2, 3],
    [4, 5, 6, 7, 8, 9, 10, 11],
    [12, 13, 14, 15],
    [16, 17, 18, 19, 20, 21, 22, 23],
    [24, 25],
  ].map(indexes => indexes.map(index => plan[`current:${tenant}`].storyboards[index].id));
  const monolithicCount = CONFIG.floors.current.filter(({ tenant }) => plan[`current:${tenant}`].mode === 'monolithic').length;

  for (const run of [serial, concurrent]) {
    assertNoRealBuildsOrRunners(run.events);
    // Per isolated tenant: its discovery, one worker per batch of 12 (three
    // batches) and one fresh worker after each failed storyboard (two).
    assert.deepEqual(actualStarts(run.events), expectedBatchedStarts(plan, ['current'], () => 5));
    assert.deepEqual(starts(run.events).filter(entry => entry.role === 'isolated'), [], 'a storyboard got its own process');
    for (const tenant of ISOLATED_CURRENT) {
      assert.deepEqual(workerBatches(run.events, 'current', tenant), expectedBatches(tenant), `${tenant} batches`);
    }
    // Every single-process tenant and every worker joins the overlap probe once.
    assert.equal(run.observedCount, monolithicCount + 2 * 5);

    assert.equal(run.result.status, 1, run.result.stderr);
    assert.match(summaryLine(run.result.stdout, 'current compliance source', 'sales'), /^ {2}\/sales: ✗ clean storyboards 24 < 191/);
    for (const tenant of ISOLATED_CURRENT) {
      const log = tenantLog(run, 'current', tenant);
      const id = index => plan[`current:${tenant}`].storyboards[index].id;
      assert.match(log, /storyboards: 24\/26 clean/);
      assert.ok(log.split('\n').includes(
        `::error::${id(3)} did not emit a complete result envelope; earlier in this worker: ${id(0)}, ${id(1)}, ${id(2)}`,
      ), `${tenant}: crash reason\n${log}`);
      assert.ok(log.split('\n').includes(
        `::error::${id(15)} did not emit a complete result envelope; earlier in this worker: ${id(12)}, ${id(13)}, ${id(14)}`,
      ), `${tenant}: malformed reason\n${log}`);
      assert.match(log, new RegExp(`Unable to accept result envelope from ${id(15)}`));
      assertNoProtocolLines(log, `${tenant}.log`);
    }
    assertNoProtocolLines(run.result.stdout, 'stdout');
    assertNoProtocolLines(run.result.stderr, 'stderr');
    assertNoTemporaryState(run.tmp);
    assertTenantLogsKept(run, 'current');
  }
  assert.equal(serial.maxLive, 1, 'ADCP_STORYBOARD_JOBS=1 overlapped training-agent processes');
  assert.ok(concurrent.maxLive >= 2, `ADCP_STORYBOARD_JOBS=4 never overlapped processes (max live ${concurrent.maxLive})`);
  assert.ok(concurrent.maxLive <= 4, `ADCP_STORYBOARD_JOBS=4 ran ${concurrent.maxLive} processes at once`);

  const mask = (text, run) => maskOutput(text, run, maskBatchedTelemetryRecord);
  assert.equal(mask(concurrent.result.stdout, concurrent), mask(serial.result.stdout, serial));
  assert.equal(mask(concurrent.result.stderr, concurrent), mask(serial.result.stderr, serial));
  for (const tenant of ISOLATED_CURRENT) {
    assert.equal(
      mask(tenantLog(concurrent, 'current', tenant), concurrent),
      mask(tenantLog(serial, 'current', tenant), serial),
      `${tenant}.log differs between ADCP_STORYBOARD_JOBS=1 and 4`,
    );
  }

  // STORYBOARD_STORYBOARDS_PER_PROCESS=1 restores one process per storyboard,
  // and every storyboard section reads as it does in a worker.
  assertNoRealBuildsOrRunners(perStoryboard.events);
  assert.deepEqual(actualStarts(perStoryboard.events), expectedStarts(plan, ['current']));
  assert.equal(perStoryboard.result.status, 1, perStoryboard.result.stderr);
  for (const tenant of ISOLATED_CURRENT) {
    assert.equal(
      sectionsWithoutProcessModel(tenantLog(serial, 'current', tenant), serial),
      sectionsWithoutProcessModel(tenantLog(perStoryboard, 'current', tenant), perStoryboard),
      `${tenant}.log: a storyboard section differs between workers and one process per storyboard`,
    );
  }
});

// --- run-storyboards-prepush.sh --------------------------------------------

async function runPrepush(harness, label, extraEnv = {}) {
  const run = harness.prepare(label, { ADCP_STORYBOARD_JOBS: '8', ...extraEnv });
  const result = await harness.run('bash', [PREPUSH], run.env);
  return { ...run, result, events: readEvents(run.eventsLog) };
}

const CURRENT_LABEL = 'current compliance source';
const COMPAT_LABEL = 'released compliance bundle: 3.0.';

// The current surface streams first; the buffered 3.0-compat output follows
// it whole, never interleaved.
function splitSurfaces(stdout) {
  const currentSummary = stdout.indexOf(`Storyboard matrix summary (${CURRENT_LABEL})`);
  const compatStart = stdout.indexOf(`Using explicit compliance and schema roots (${COMPAT_LABEL}`);
  assert.notEqual(currentSummary, -1, 'missing the current surface summary');
  assert.notEqual(compatStart, -1, 'missing the 3.0-compat surface output');
  assert.ok(currentSummary < compatStart, '3.0-compat output was printed before the current surface finished');
  const current = stdout.slice(0, compatStart);
  const compat = stdout.slice(compatStart);
  assert.doesNotMatch(current, /released compliance bundle/);
  assert.doesNotMatch(compat, new RegExp(`\\(${CURRENT_LABEL}\\)`));
  assert.equal((current.match(/^Storyboards · \//gm) ?? []).length, CONFIG.floors.current.length);
  assert.equal((compat.match(/^Storyboards · \//gm) ?? []).length, CONFIG.floors['3.0-compat'].length);
  return { current, compat };
}

function assertSurfaceInputs(run) {
  const records = starts(run.events);
  const builtLatest = path.join(run.builtDist, 'schemas', 'latest');
  // The matrix's shared validator cache reaches every process the queue
  // starts, on both surfaces.
  const validatorCache = path.join(REPO_ROOT, 'node_modules', '.cache', 'adcp-sdk-validators');
  for (const entry of records) {
    assert.equal(entry.validator_cache_dir, validatorCache, `${entry.surface}:${entry.tenant}: no shared validator cache`);
  }
  for (const entry of records.filter(record => record.surface === 'current')) {
    // Candidate mode as the hook passes it today; the immutable schema
    // snapshot, never the live dist/schemas/latest.
    assert.equal(entry.candidate_version_mode, '1', `${entry.tenant}: current surface must run in candidate mode`);
    assert.equal(entry.compliance_dir, path.join(run.builtDist, 'compliance', 'latest'));
    assert.ok(entry.schema_root && path.resolve(entry.schema_root) !== builtLatest, `${entry.tenant}: no schema snapshot`);
  }
  for (const entry of records.filter(record => record.surface === '3.0-compat')) {
    assert.equal(entry.candidate_version_mode, '0', `${entry.tenant}: 3.0-compat must not use candidate mode`);
    assert.match(path.basename(entry.schema_root ?? ''), /^3\.0\.\d+$/);
  }
}

// The fake runs skip the builds (ADCP_STORYBOARD_TEST_SKIP_BUILDS); the
// build-cache work belongs to tp-jyw.22. What must hold here: no real build or
// runner starts, and the wrapper itself never builds.
function assertNoBuildsFromTheWrapper(events) {
  assertNoRealBuildsOrRunners(events);
  assert.deepEqual(events.filter(entry => entry.event === 'ensure-done'), [], 'the wrapper must not build schemas itself');
}

test('pre-push wrapper runs both surfaces, prints current then 3.0-compat, exits 0 when both pass', async (t) => {
  const plan = buildPlan();
  const harness = makeHarness(t, plan);
  const run = await runPrepush(harness, 'prepush-pass');

  assert.equal(run.result.status, 0, `${run.result.stdout.slice(-4000)}\n${run.result.stderr}`);
  const { current, compat } = splitSurfaces(run.result.stdout);
  assert.match(current, /✓ All tenants meet floors\./);
  assert.match(compat, /✓ All tenants meet floors\./);
  assertNoBuildsFromTheWrapper(run.events);
  assert.deepEqual(actualStarts(run.events), expectedStarts(plan, SURFACES));
  assertSurfaceInputs(run);
  assertNoTemporaryState(run.tmp);
  for (const surface of SURFACES) assertTenantLogsKept(run, surface);
  assert.match(run.result.stdout, /Storyboard queue: up to 8 training-agent processes at once/);
});

test('pre-push wrapper exits 1 when only the buffered 3.0-compat surface fails', async (t) => {
  const plan = buildPlan({ below: ['3.0-compat:signals'] });
  const harness = makeHarness(t, plan);
  const run = await runPrepush(harness, 'prepush-compat-fails');

  assert.equal(run.result.status, 1, run.result.stderr);
  const { current, compat } = splitSurfaces(run.result.stdout);
  assert.match(current, /✓ All tenants meet floors\./);
  const signals = floorOf('3.0-compat', 'signals');
  assert.match(compat, new RegExp(`/signals: ✗ clean storyboards ${signals.clean - 1} < ${signals.clean}`));
  assert.match(compat, /✗ One or more tenants regressed below floor — push blocked\./);
  assertNoTemporaryState(run.tmp);
  for (const surface of SURFACES) assertTenantLogsKept(run, surface);
});

test('pre-push wrapper exits 1 when only the current surface fails', async (t) => {
  const plan = buildPlan({ below: ['current:si'], small: [] });
  const harness = makeHarness(t, plan);
  const run = await runPrepush(harness, 'prepush-current-fails');

  assert.equal(run.result.status, 1, run.result.stderr);
  const { current, compat } = splitSurfaces(run.result.stdout);
  const si = floorOf('current', 'si');
  assert.match(current, new RegExp(`/si: ✗ clean storyboards ${si.clean - 1} < ${si.clean}`));
  assert.match(compat, /✓ All tenants meet floors\./);
  assertNoTemporaryState(run.tmp);
  for (const surface of SURFACES) assertTenantLogsKept(run, surface);
});

test('pre-push wrapper at the default runs every isolated tenant of both surfaces in workers of 12 and passes', async (t) => {
  const plan = buildPlan();
  const harness = makeHarness(t, plan);
  const run = await runPrepush(harness, 'prepush-batched', { STORYBOARD_STORYBOARDS_PER_PROCESS: undefined });

  assert.equal(run.result.status, 0, `${run.result.stdout.slice(-4000)}\n${run.result.stderr}`);
  const { current, compat } = splitSurfaces(run.result.stdout);
  assert.match(current, /✓ All tenants meet floors\./);
  assert.match(compat, /✓ All tenants meet floors\./);
  assertNoBuildsFromTheWrapper(run.events);
  assert.deepEqual(starts(run.events).filter(entry => entry.role === 'isolated'), [], 'a storyboard got its own process');
  assert.deepEqual(
    actualStarts(run.events),
    expectedBatchedStarts(plan, SURFACES, (_surface, _tenant, entry) => Math.ceil(entry.storyboards.length / STORYBOARDS_PER_WORKER)),
  );
  for (const surface of SURFACES) {
    for (const { tenant } of CONFIG.floors[surface]) {
      const entry = plan[`${surface}:${tenant}`];
      if (entry.mode !== 'isolated') continue;
      const ids = entry.storyboards.map(storyboard => storyboard.id);
      const byFirst = (left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0);
      assert.deepEqual(
        workerBatches(run.events, surface, tenant),
        chunk(ids, STORYBOARDS_PER_WORKER).sort(byFirst),
        `${surface}:${tenant}: workers must run contiguous batches of ${STORYBOARDS_PER_WORKER} in applicable order`,
      );
      assertNoProtocolLines(tenantLog(run, surface, tenant), `${surface}/${tenant}.log`);
    }
  }
  assertNoProtocolLines(run.result.stdout, 'stdout');
  assertSurfaceInputs(run);
  assertNoTemporaryState(run.tmp);
  for (const surface of SURFACES) assertTenantLogsKept(run, surface);
});

function descendantsOf(rootPid) {
  const children = new Map();
  for (const line of execFileSync('ps', ['-A', '-o', 'pid=', '-o', 'ppid='], { encoding: 'utf8' }).split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(ppid)) continue;
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(pid);
  }
  const found = [];
  const queue = [rootPid];
  while (queue.length > 0) {
    for (const child of children.get(queue.shift()) ?? []) {
      found.push(child);
      queue.push(child);
    }
  }
  return found;
}

function killQuietly(pid, signal = 'SIGKILL') {
  if (!Number.isSafeInteger(pid)) return;
  try {
    process.kill(pid, signal);
  } catch {}
}

async function assertSigtermLeavesNothing(t, label, extraEnv = {}) {
  const plan = buildPlan({ small: SURFACES });
  const harness = makeHarness(t, plan);
  const run = harness.prepare(label, { ADCP_STORYBOARD_JOBS: '24', ...extraEnv });
  const hangDir = path.join(run.dir, 'hang');
  fs.mkdirSync(hangDir);
  const hangRecords = () => fs.readdirSync(hangDir)
    .filter(name => name.endsWith('.json'))
    .map(name => JSON.parse(fs.readFileSync(path.join(hangDir, name), 'utf8')));

  const wrapper = spawn('bash', [PREPUSH], {
    cwd: REPO_ROOT,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...run.env, FAKE_HANG_DIR: hangDir },
  });
  trackProcess(run.dir, wrapper.pid);
  let output = '';
  wrapper.stdout.setEncoding('utf8');
  wrapper.stderr.setEncoding('utf8');
  wrapper.stdout.on('data', (chunk) => { output += chunk; });
  wrapper.stderr.on('data', (chunk) => { output += chunk; });
  const closed = new Promise(resolve => wrapper.once('close', (code, signal) => resolve({ code, signal })));
  let tracked = [];
  t.after(() => {
    killQuietly(-wrapper.pid);
    for (const pid of tracked) killQuietly(pid);
    let records = [];
    try {
      records = hangRecords();
    } catch {}
    for (const record of records) {
      killQuietly(-record.child);
      killQuietly(record.child);
      killQuietly(record.descendant);
    }
  });

  // Both surfaces have training-agent processes (with descendants) alive at
  // the same time before the signal arrives. The waits below report a fault
  // well inside the runner's 30 s --test-timeout.
  for (let attempt = 0; ; attempt += 1) {
    const surfaces = new Set(hangRecords().map(record => record.surface));
    if (surfaces.has('current') && surfaces.has('3.0-compat')) break;
    if (wrapper.exitCode !== null) assert.fail(`wrapper exited ${wrapper.exitCode} before both surfaces ran:\n${output}`);
    if (attempt >= 300) assert.fail(`both surfaces never ran at once (live: ${[...surfaces].join(', ') || 'none'})\n${output}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  tracked = [
    ...descendantsOf(wrapper.pid),
    ...hangRecords().flatMap(record => [record.child, record.descendant]),
  ];

  process.kill(wrapper.pid, 'SIGTERM');
  const exit = await Promise.race([
    closed,
    new Promise(resolve => setTimeout(() => resolve({ hung: true }), 8_000)),
  ]);
  assert.equal(exit.hung, undefined, `wrapper did not exit after SIGTERM:\n${output}`);
  assert.ok(exit.code !== 0, `wrapper exited 0 after SIGTERM:\n${output}`);

  for (const pid of tracked) {
    for (let attempt = 0; attempt < 80 && isAlive(pid); attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  const survivors = tracked.filter(isAlive);
  assert.deepEqual(survivors, [], 'descendants of the wrapper survived SIGTERM');

  const events = readEvents(run.eventsLog);
  assertNoRealBuildsOrRunners(events);
  // Tenant logs live in ADCP_STORYBOARD_LOG_DIR; nothing may stay in TMPDIR:
  // no schema snapshot, 3.0 bundle, queue state, spill file or buffered output.
  const unexpected = leftovers(run.tmp);
  assert.deepEqual(unexpected, [], 'SIGTERM left temporary state behind');
  return { events };
}

test('SIGTERM to the pre-push wrapper leaves no descendant and no temporary state', async (t) => {
  await assertSigtermLeavesNothing(t, 'prepush-sigterm');
});

test('SIGTERM to the pre-push wrapper at the batched default kills every worker and its descendants', async (t) => {
  const { events } = await assertSigtermLeavesNothing(t, 'prepush-sigterm-batched', { STORYBOARD_STORYBOARDS_PER_PROCESS: undefined });
  assert.ok(starts(events).some(entry => entry.role === 'worker'), 'no worker was running when SIGTERM arrived');
  assert.deepEqual(starts(events).filter(entry => entry.role === 'isolated'), [], 'a storyboard got its own process');
});
