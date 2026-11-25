// Fresh-realm probes for the matched-pair NI engine tests.
//
// Each probe runs in its own Worker: a new V8 realm with unmodified
// intrinsics, so a probe can poison Array.prototype and friends without
// touching the caller, and Worker#terminate() stops a `for (;;) {}` the way
// killing a child process does. `process.exit(n)` inside a probe becomes the
// Worker's exit code. The test imports this module for TypeScript-source
// probes (execArgv ['--import', 'tsx']); for emitted-JavaScript probes it runs
// this file as a plain `node` child (no TypeScript loader anywhere in that
// process) with a JSON file of cases, and reads one JSON result per line.
//
// Outcomes come from events, not clocks. A poison announces that it was
// entered (POISON_LOOP) before it spins, so a probe that reaches its poison
// fails the moment it does; a probe that does not exits on its own. The
// deadlines below only bound a realm that hangs without entering a poison.
import { MessageChannel, Worker } from 'node:worker_threads';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Hang guard for a probe that neither exits nor enters its poison. */
export const TERMINATION_BOUND_MS = 20_000;

/**
 * The body of every poisoned intrinsic: record entry, wake the parent, spin.
 * The probe realm's flag is `globalThis.__poisonEntered`, set from
 * `workerData.poisonEntered` before the probe's own code runs.
 */
export const POISON_LOOP = '{ Atomics.store(globalThis.__poisonEntered, 0, 1); Atomics.notify(globalThis.__poisonEntered, 0); for (;;) {} }';
const FLAG_PRELUDE = "import { workerData as __probeWorkerData } from 'node:worker_threads'; globalThis.__poisonEntered = __probeWorkerData.poisonEntered;";

const ENTERED = 1;
const RELEASED = 2;
const newFlag = () => new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

/**
 * Resolves 'entered' once the realm stores ENTERED, 'released' once the
 * parent releases the flag (the realm exited first), or 'timed-out' after
 * `boundMs` with neither.
 */
function poisonEntry(flag, boundMs) {
  const wait = Atomics.waitAsync(flag, 0, 0, boundMs);
  const settle = (value) => (value === 'timed-out' ? 'timed-out' : Atomics.load(flag, 0) === ENTERED ? 'entered' : 'released');
  return wait.async ? wait.value.then(settle) : Promise.resolve(settle(wait.value));
}

/** The realm exited without entering its poison: wake the pending wait. */
function releaseFlag(flag) {
  Atomics.compareExchange(flag, 0, 0, RELEASED);
  Atomics.notify(flag, 0);
}

const liveWorkers = new Set();
let probeDirectory;
let probeSequence = 0;

function track(worker) {
  liveWorkers.add(worker);
  worker.once('exit', () => liveWorkers.delete(worker));
  return worker;
}

/** Stops every Worker a failed or timed-out probe left running. */
export async function terminateLiveWorkers() {
  const workers = [...liveWorkers];
  liveWorkers.clear();
  await Promise.all(workers.map((worker) => worker.terminate().catch(() => undefined)));
}

export function removeProbeFiles() {
  if (probeDirectory) rmSync(probeDirectory, { recursive: true, force: true });
  probeDirectory = undefined;
}

function probeFile(name, source, directory) {
  if (directory === undefined) probeDirectory ??= mkdtempSync(join(tmpdir(), 'matched-ni-realm-probe-'));
  const file = join(directory ?? probeDirectory, `${name}-${process.pid}-${++probeSequence}.mjs`);
  writeFileSync(file, source);
  return pathToFileURL(file);
}

/**
 * Writes a preload (for a Worker's execArgv `--import`) that counts
 * WorkBudget charges in the realm: `workerData.chargeCounter[0]` counts
 * charge() calls and `[1]` is set to 1 once the counter is installed.
 * `workBudgetUrl` must be the module the engine imports, so both share one
 * WorkBudget class. Returns the preload's file URL.
 */
export function writeChargeCounterPreload(workBudgetUrl, directory) {
  return probeFile('charge-counter', `import { workerData } from 'node:worker_threads';
import { WorkBudget } from ${JSON.stringify(workBudgetUrl)};
const counter = workerData.chargeCounter;
const charge = WorkBudget.prototype.charge;
WorkBudget.prototype.charge = function (units) { Atomics.add(counter, 0, 1); return charge.call(this, units); };
Atomics.store(counter, 1, 1);`, directory).href;
}

/**
 * Runs an ES module source in a fresh Worker realm. Resolves when the Worker
 * exits, when it enters a poison (it is then terminated), or after
 * `deadlineMs` with neither (terminated, `timedOut`).
 */
export async function runRealmProbe(source, { execArgv = [], deadlineMs = TERMINATION_BOUND_MS, workerData } = {}) {
  const flag = newFlag();
  const worker = track(new Worker(probeFile('probe', `${FLAG_PRELUDE}\n${source}`), {
    execArgv, workerData: { ...workerData, poisonEntered: flag }, stdout: true, stderr: true,
  }));
  let stderr = '';
  let error;
  worker.stdout.resume();
  worker.stderr.setEncoding('utf8');
  worker.stderr.on('data', (chunk) => { stderr += chunk; });
  worker.on('error', (cause) => { error = cause; });
  const exit = new Promise((resolve) => worker.once('exit', (code) => { releaseFlag(flag); resolve(code); }));
  const first = await Promise.race([exit.then((code) => ({ kind: 'exit', code })), poisonEntry(flag, deadlineMs).then((kind) => ({ kind }))]);
  if (first.kind !== 'exit') await worker.terminate();
  const code = await exit;
  const poisonEntered = Atomics.load(flag, 0) === ENTERED;
  const timedOut = first.kind === 'timed-out';
  return { code: first.kind === 'exit' ? code : null, timedOut, poisonEntered, error: error === undefined ? undefined : String(error?.stack ?? error), stderr };
}

/**
 * Runs a probe that is expected never to finish: its infinite loop is a
 * POISON_LOOP, which records entry and wakes the parent immediately before it
 * spins. The result records whether the loop was entered and whether the
 * Worker had exited before that; the Worker is then terminated.
 */
export async function runHangProbe(source, { execArgv = [], enterBoundMs = TERMINATION_BOUND_MS } = {}) {
  const flag = newFlag();
  const worker = track(new Worker(probeFile('probe', `${FLAG_PRELUDE}\n${source}`), {
    execArgv, workerData: { poisonEntered: flag }, stdout: true, stderr: true,
  }));
  worker.stdout.resume();
  worker.stderr.resume();
  let exitCode = null;
  let error;
  let exited = false;
  worker.on('error', (cause) => { error = cause; });
  const exit = new Promise((resolve) => worker.once('exit', (code) => { exited = true; exitCode = code; releaseFlag(flag); resolve(); }));
  await poisonEntry(flag, enterBoundMs);
  const loopEntered = Atomics.load(flag, 0) === ENTERED;
  const exitedBeforeTermination = exited;
  if (!exited) await worker.terminate();
  await exit;
  return { loopEntered, exitedBeforeTermination, exitCode: exitedBeforeTermination ? exitCode : null, error: error === undefined ? undefined : String(error?.stack ?? error) };
}

/** Recreated-worker tasks of the poisoned matrix (payloads as in the original harness). */
export const POISONED_WORKER_TASKS = Object.freeze([
  { task: 'restricted_score', payload: () => ({ counts: { n11: 1, n10: 3, n01: 0, n00: 0 }, margin: { numerator: 7n, denominator: 100n }, alpha: { numerator: 1n, denominator: 20n } }) },
  { task: 'null_size', payload: () => ({ n: 4, margin: { numerator: 7n, denominator: 100n }, alpha: { numerator: 1n, denominator: 20n } }) },
]);

/**
 * Array poison must complete because the core does not invoke Array helpers
 * or the iterator. Each named non-Array intrinsic must instead settle with the
 * worker's conservative `{ ok: false }` response before core telemetry.
 */
export const POISONED_WORKER_POISONS = Object.freeze([
  { source: `Object.defineProperty(Array.prototype, 'map', { value() ${POISON_LOOP}, configurable: true })`, expected: 'normal_completion' },
  { source: `Object.defineProperty(Array.prototype, Symbol.iterator, { value() ${POISON_LOOP}, configurable: true })`, expected: 'normal_completion' },
  { source: `Object.defineProperty(RegExp.prototype, 'test', { value() ${POISON_LOOP}, configurable: true })`, expected: 'safe_refusal' },
  { source: `Object.defineProperty(String.prototype, 'startsWith', { value() ${POISON_LOOP}, configurable: true })`, expected: 'safe_refusal' },
  { source: `Object.defineProperty(String.prototype, 'indexOf', { value() ${POISON_LOOP}, configurable: true })`, expected: 'safe_refusal' },
  { source: `Object.defineProperty(String.prototype, 'slice', { value() ${POISON_LOOP}, configurable: true })`, expected: 'safe_refusal' },
  { source: `Object.defineProperty(String.prototype, 'endsWith', { value() ${POISON_LOOP}, configurable: true })`, expected: 'safe_refusal' },
  { source: `Object.defineProperty(Map.prototype, 'get', { value() ${POISON_LOOP}, configurable: true })`, expected: 'safe_refusal' },
  { source: `Object.defineProperty(Map.prototype, 'set', { value() ${POISON_LOOP}, configurable: true })`, expected: 'safe_refusal' },
  { source: `Object.defineProperty(Map.prototype, 'has', { value() ${POISON_LOOP}, configurable: true })`, expected: 'safe_refusal' },
  { source: `Object.defineProperty(WeakSet.prototype, 'add', { value() ${POISON_LOOP}, configurable: true })`, expected: 'safe_refusal' },
  { source: `Object.defineProperty(WeakSet.prototype, 'has', { value() ${POISON_LOOP}, configurable: true })`, expected: 'safe_refusal' },
]);

/**
 * One cell of the poisoned recreated-worker matrix. The emitted worker is
 * poisoned by a preload before module evaluation; with `sourceResolution` an
 * entry module loads the TypeScript engine through the loader first, then
 * poisons before the engine's queued core work. Trace events are read only
 * after the authorization port has closed: the engine closes it before it
 * posts its result, so every event has arrived by then. A realm that
 * enters a poison is terminated at once. Node delivers every message a Worker
 * posted before its 'exit' event, so the case then has the engine's result
 * exactly when the engine replied before the realm reached the poison; code
 * that runs in the realm after the result (worker teardown, the loader) is
 * outside the claim.
 */
export async function runPoisonedWorkerCase({ engineUrl, workerLoader, sourceResolution = false, taskIndex, poisonIndex, deadlineMs = TERMINATION_BOUND_MS }) {
  const task = POISONED_WORKER_TASKS[taskIndex];
  const poison = POISONED_WORKER_POISONS[poisonIndex];
  const directory = mkdtempSync(join(tmpdir(), 'matched-ni-poisoned-worker-'));
  const preload = join(directory, sourceResolution ? 'entry.mjs' : 'poison.mjs');
  const flagSetup = "globalThis.__poisonEntered = workerData.poisonEntered;";
  if (sourceResolution) {
    writeFileSync(preload, `import ${JSON.stringify(engineUrl)}; import { workerData } from 'node:worker_threads'; ${flagSetup} workerData.authorizationPort.postMessage('import_complete'); ${poison.source}; workerData.authorizationPort.postMessage('poison_ack');`);
  } else {
    writeFileSync(preload, `import { workerData } from 'node:worker_threads'; ${flagSetup} ${poison.source}; workerData.authorizationPort.postMessage('poison_ack');`);
  }
  const flag = newFlag();
  const events = [];
  try {
    const channel = new MessageChannel();
    const portClosed = new Promise((resolve) => channel.port1.once('close', resolve));
    const worker = track(new Worker(new URL(sourceResolution ? pathToFileURL(preload).href : engineUrl), {
      workerData: { exactMatchedPairNiWorker: true, task: task.task, authorizationPort: channel.port2, payload: task.payload(), trace: true, poisonEntered: flag },
      transferList: [channel.port2],
      execArgv: sourceResolution ? [...workerLoader] : [...workerLoader, '--import', pathToFileURL(preload).href],
      stdout: true, stderr: true,
    }));
    worker.stdout.resume();
    worker.stderr.resume();
    const exit = new Promise((resolve) => worker.once('exit', () => { releaseFlag(flag); resolve(); }));
    let result;
    let error;
    try {
      result = await new Promise((resolve, reject) => {
        let ready = false; let poisonAck = false; let imported = !sourceResolution;
        poisonEntry(flag, deadlineMs).then((kind) => {
          if (kind === 'entered') void worker.terminate();
          else if (kind === 'timed-out') reject(new Error(`timeout after ${events.join(',')}`));
        });
        channel.port1.on('message', (message) => {
          events.push(String(message));
          ready ||= message === 'exact_matched_pair_ni_ready';
          poisonAck ||= message === 'poison_ack';
          imported ||= message === 'import_complete';
          if (ready && poisonAck && imported) { events.push('authorized'); channel.port1.postMessage('exact_matched_pair_ni_authorized'); }
        });
        worker.once('message', (message) => resolve(message));
        worker.once('error', (cause) => reject(cause));
        worker.once('exit', (code) => reject(new Error(Atomics.load(flag, 0) === ENTERED
          ? `entered its poisoned intrinsic before replying; events=${events.join(',')}`
          : `worker exited ${code}; events=${events.join(',')}`)));
      });
    } catch (cause) {
      error = String(cause?.message ?? cause);
    }
    await worker.terminate();
    await exit;
    await portClosed;
    channel.port1.close();
    const poisonAt = events.indexOf('poison_ack'); const startAt = events.indexOf('core_start'); const resultAt = events.indexOf('core_complete');
    const importSeen = !sourceResolution || events.indexOf('import_complete') >= 0;
    const pass = error === undefined && (poison.expected === 'normal_completion'
      ? result?.ok === true && poisonAt >= 0 && startAt > poisonAt && resultAt > startAt && importSeen
      : result?.ok === false && poisonAt >= 0 && startAt === -1 && resultAt === -1 && importSeen);
    return { pass, expected: poison.expected, ok: result?.ok, events, error };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/**
 * Child mode: `node realm-probe.mjs <cases.json>` prints one JSON result per
 * case and stops after the first failing case, as an assertion would.
 */
async function runCases(casesPath) {
  const cases = JSON.parse(readFileSync(casesPath, 'utf8'));
  try {
    for (const testCase of cases) {
      const outcome = testCase.kind === 'poisoned_worker'
        ? await runPoisonedWorkerCase(testCase)
        : await runRealmProbe(testCase.source, { execArgv: testCase.execArgv ?? [], deadlineMs: testCase.deadlineMs ?? TERMINATION_BOUND_MS });
      process.stdout.write(`${JSON.stringify({ name: testCase.name, ...outcome })}\n`);
      const passed = testCase.kind === 'poisoned_worker' ? outcome.pass : outcome.code === 0 && !outcome.timedOut && !outcome.poisonEntered && outcome.error === undefined;
      if (!passed) break;
    }
  } finally {
    await terminateLiveWorkers();
    removeProbeFiles();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await runCases(process.argv[2]);
}
