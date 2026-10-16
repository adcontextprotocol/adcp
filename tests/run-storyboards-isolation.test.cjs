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

// --- Manual reporter grading contract -------------------------------------
//
// The manual runner grades raw SDK step results. It must never credit an
// optional raw diagnostic as coverage, never rewrite a failed optional step to
// passed, and never render a success pill for a storyboard the SDK rejected.
// These cases extract the real functions from the runner source and exercise
// them directly, so they stay pinned to the shipped implementation rather than
// a copy. No agent, no network, no production fixtures.

const ts = require('typescript');
const vm = require('node:vm');

function loadGrader() {
  const source = fs.readFileSync(
    path.join(REPO_ROOT, 'server', 'tests', 'manual', 'run-storyboards.ts'),
    'utf8',
  );
  const mapStart = source.indexOf('const KNOWN_FAILING_STEPS:');
  assert.ok(mapStart >= 0, 'KNOWN_FAILING_STEPS marker moved; extraction would be stale');
  const mapEnd = source.indexOf('\n]);', mapStart) + '\n]);'.length;
  const fnStart = source.indexOf('interface StepWaiverEvidence');
  const fnEnd = source.indexOf('\nasync function main()');
  // Without these the slice runs to end-of-file and drags in the module's top-level
  // main().catch(() => process.exit(1)), which would kill the test runner mid-suite.
  assert.ok(fnStart >= 0, 'StepWaiverEvidence marker moved; extraction would be stale');
  assert.ok(fnEnd > fnStart, 'main() marker moved; extraction would swallow module top level');
  const functions = source.slice(fnStart, fnEnd);
  const probe = `${source.slice(mapStart, mapEnd)}
const THREE_ZERO_COMPAT_KNOWN_FAILING_STEPS = new Map();
const isThreeZeroCompatRun = false;
const verbose = false;
function isRecord(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function formatStepFailureDetail(error, validations) {
  return error ?? (validations ?? []).filter(v => !v.passed).map(v => v.description ?? v.check).join('; ');
}
${functions}
module.exports = { applyStepSkipList, summarize };`;
  const compiled = ts.transpileModule(probe, {
    reportDiagnostics: true,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  assert.deepEqual(compiled.diagnostics, [], 'grader extraction must transpile cleanly');
  const sandbox = { module: { exports: {} }, console, process };
  vm.runInNewContext(compiled.outputText, sandbox);
  return sandbox.module.exports;
}

const grader = loadGrader();
const passStep = id => ({ step_id: id, passed: true, validations: [] });
const failStep = (id, more = {}) => ({
  step_id: id,
  passed: false,
  validations: [{ check: 'field_present', passed: false, description: 'raw diagnostic retained' }],
  ...more,
});
// A real entry from the live KNOWN_FAILING_STEPS map.
const WAIVED_STEP = 'check_governance_drift';

test('the waiver these cases depend on is still live', () => {
  // Without this, retiring the waiver leaves the assertGates cases below passing for
  // the wrong reason: no waiver, so nothing to cancel.
  const source = fs.readFileSync(
    path.join(REPO_ROOT, 'server', 'tests', 'manual', 'run-storyboards.ts'),
    'utf8',
  );
  assert.match(source, /'governance_delivery_monitor\/check_governance_drift'/);
});

function grade({ required = [passStep('read')], optional = [], overall = true, failed = 0, assertions, extraPhase }) {
  const phases = [
    { phase_id: 'required', passed: required.every(s => s.passed), steps: required },
    { phase_id: 'optional', passed: optional.every(s => s.passed), steps: optional },
    ...(extraPhase ? [extraPhase] : []),
  ];
  const sb = {
    id: 'governance_delivery_monitor',
    title: 'fixture',
    phases: phases.map(p => ({
      id: p.phase_id,
      optional: p.phase_id === 'optional',
      steps: p.steps.map(s => ({ id: s.step_id })),
    })),
  };
  const result = { overall_passed: overall, failed_count: failed, assertions, phases };
  const waivers = grader.applyStepSkipList(sb, result);
  return { result, summary: grader.summarize(sb, result, waivers), waivers };
}

const assertGates = out =>
  assert.ok(out.summary.failed > 0 || out.summary.error, `must gate: ${JSON.stringify(out.summary)}`);
const assertClean = out => {
  assert.equal(out.summary.failed, 0);
  assert.equal(out.summary.error, undefined);
};

test('optional raw diagnostic is non-gating and its raw evidence is left intact', () => {
  const out = grade({ optional: [failStep('legacy_probe')] });
  assertClean(out);
  assert.equal(out.summary.nonGatingFailures.length, 1);
  // The SDK step itself must NOT be rewritten to passed/skipped.
  assert.equal(out.result.phases[1].steps[0].passed, false);
  assert.equal(out.result.phases[1].steps[0].validations[0].passed, false);
  assert.equal(out.summary.nonGatingFailures[0].error, 'raw diagnostic retained');
});

test('a required-phase failure is never diverted, even when the SDK aggregate is clean', () => {
  // The diversion is scoped to AUTHORED optional phases. Without that scope an
  // inconsistent input - required-phase red alongside a clean aggregate - would leave
  // every counter and render a success pill with no passing steps.
  const out = grade({ required: [failStep('required_buy')], overall: true, failed: 0 });
  assertGates(out);
  assert.equal(out.summary.failed, 1, 'it must stay in the failure count');
  assert.equal(out.summary.nonGatingFailures.length, 0, 'it must not become a diagnostic');
});

test('a diverted optional red inflates neither passing nor skipped coverage', () => {
  const out = grade({ optional: [failStep('legacy_probe')] });
  assertClean(out);
  assert.equal(out.summary.nonGatingFailures.length, 1);
  // Counted in no status bucket: it executed and failed, so it is not skip coverage.
  assert.equal(out.summary.skipped, 0, 'a failed probe is never reported as skipped');
  assert.equal(out.summary.passed, 1, 'only the genuinely passing step counts');
});

test('an explicit counts_toward_failure marker suppresses only its own step', () => {
  const out = grade({
    required: [passStep('read'), failStep('required_buy')],
    optional: [failStep('probe', { counts_toward_failure: false })],
    overall: false,
    failed: 1,
  });
  assertGates(out);
  assert.equal(out.summary.failed, 1);
  assert.equal(out.summary.nonGatingFailures.length, 1);
});

test('a required failure still gates when an optional probe also failed', () => {
  assertGates(grade({
    required: [passStep('read'), failStep('required_buy')],
    optional: [failStep('probe')],
    overall: false,
    failed: 1,
  }));
});

test('a failure inside an authored optional phase still gates when the SDK rejected the run', () => {
  assertGates(grade({ optional: [failStep('oauth_metadata')], overall: false, failed: 1 }));
});

test('a failed step assertion is never suppressed by a marker or a clean aggregate', () => {
  assertGates(grade({
    optional: [failStep('probe', {
      counts_toward_failure: false,
      validations: [{ check: 'assertion', passed: false }],
    })],
  }));
});

test('a detached onEnd assertion gates even with zero failed_count', () => {
  assertGates(grade({ overall: false, failed: 0, assertions: [{ passed: false, scope: 'storyboard' }] }));
});

test('overall_passed false with no executed required step still gates', () => {
  assertGates(grade({ required: [], overall: false, failed: 0 }));
});

test('an ordinary known required-step waiver keeps its existing effect', () => {
  const out = grade({ required: [passStep('read'), failStep(WAIVED_STEP)], overall: false, failed: 1 });
  assertClean(out);
  assert.equal(out.summary.skipped, 1);
  assert.equal(out.waivers.requiredStepKeys.size, 1);
});

test('a known waiver in an OPTIONAL phase cannot cancel a required aggregate failure', () => {
  const out = grade({ optional: [failStep(WAIVED_STEP)], overall: false, failed: 1 });
  assertGates(out);
  assert.equal(out.waivers.requiredStepKeys.size, 0, 'optional waivers are never aggregate credit');
});

test('a known required waiver does not erase a second required failure', () => {
  assertGates(grade({
    required: [passStep('read'), failStep(WAIVED_STEP), failStep('unknown_required')],
    overall: false,
    failed: 2,
  }));
});

test('a known required waiver does not erase a detached onEnd failure', () => {
  assertGates(grade({
    required: [passStep('read'), failStep(WAIVED_STEP)],
    overall: false,
    failed: 1,
    assertions: [{ passed: false, scope: 'storyboard' }],
  }));
});

test('a known required waiver cannot explain more aggregate failures than itself', () => {
  assertGates(grade({ required: [passStep('read'), failStep(WAIVED_STEP)], overall: false, failed: 2 }));
});

test('a known waiver never erases a failed step assertion', () => {
  const out = grade({
    required: [passStep('read'), failStep(WAIVED_STEP, { validations: [{ check: 'assertion', passed: false }] })],
    overall: false,
    failed: 1,
  });
  assertGates(out);
  assert.equal(out.result.phases[0].steps[1].passed, false, 'the assertion failure stays visible');
  assert.equal(out.waivers.requiredStepKeys.size, 0);
});

test('an unexplained failed required phase survives an unrelated known waiver', () => {
  assertGates(grade({
    required: [passStep('read'), failStep(WAIVED_STEP)],
    overall: false,
    failed: 1,
    extraPhase: { phase_id: 'missing_state', passed: false, steps: [] },
  }));
});

test('a hard prerequisite skip in the waived phase is not hidden by the waiver', () => {
  assertGates(grade({
    required: [
      passStep('read'),
      failStep(WAIVED_STEP),
      { step_id: 'missing_state', passed: false, skipped: true, validations: [] },
    ],
    overall: false,
    failed: 1,
  }));
});

test('a counts_toward_failure marker cannot turn an SDK-wide rejection green', () => {
  assertGates(grade({
    optional: [failStep('probe', { counts_toward_failure: false })],
    overall: false,
    failed: 0,
  }));
});

test('a waived-only execution cannot manufacture required coverage', () => {
  assertGates(grade({ required: [failStep(WAIVED_STEP)], overall: false, failed: 1 }));
});

// --- End-to-end: non-gating diagnostics survive isolation ------------------
//
// These two exercise the ISOLATOR's pre-envelope passthrough and its envelope
// coherence validator, using a fixture that prints representative lines. They do
// NOT invoke summarize() or the pill renderer - the grading cases above cover
// those directly against the shipped functions. The JSON projection carries counts
// and status only; it deliberately does NOT gain a diagnostics field.

test('a pre-envelope non-gating diagnostic stays visible and its clean envelope is accepted', (t) => {
  const { result, results } = runFixture(t, ['non_gating_diagnostic']);

  assert.match(result.stdout, /--- Non-gating step diagnostics ---/);
  assert.match(result.stdout, /get_products_legacy_format: EXPECTED AND NON-GATING/);
  const envelope = results.find(entry => entry.storyboard_id === 'non_gating_diagnostic');
  assert.ok(envelope, 'the clean envelope must still be persisted');
  assert.equal(envelope.summaries[0].has_error, false);
  assert.equal(envelope.summaries[0].passed, 8);
  assert.equal(envelope.totals.clean, 1);
});

test('an SDK rejection with no failed step contributes no clean storyboard and no success pill', (t) => {
  const { result, results } = runFixture(t, ['runner_rejected_no_failed_step']);

  // The isolator exits 0 for a coherently failed storyboard - exit status
  // signals infrastructure failures only. The aggregate floors and the
  // required-exact grep are what grade the result.
  assert.equal(result.status, 0, result.stderr);
  const envelope = results.find(entry => entry.storyboard_id === 'runner_rejected_no_failed_step');
  assert.ok(envelope, 'the rejected envelope must still be persisted');
  assert.equal(envelope.summaries[0].has_error, true, 'has_error carries the rejection');
  assert.equal(envelope.totals.clean, 0, 'a rejected storyboard is never clean');
  // The required-exact grep keys on the success pill; it must not match here.
  assert.match(result.stdout, /runner_rejected_no_failed_step ✗ /);
  assert.doesNotMatch(result.stdout, /runner_rejected_no_failed_step\s+✓/);
});
