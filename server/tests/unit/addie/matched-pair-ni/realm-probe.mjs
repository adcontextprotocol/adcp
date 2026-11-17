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
import { MessageChannel, Worker } from 'node:worker_threads';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Upper bound for probes whose failure mode is non-termination. */
export const TERMINATION_BOUND_MS = 20_000;

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

function probeFileUrl(source) {
  probeDirectory ??= mkdtempSync(join(tmpdir(), 'matched-ni-realm-probe-'));
  const file = join(probeDirectory, `probe-${process.pid}-${++probeSequence}.mjs`);
  writeFileSync(file, source);
  return pathToFileURL(file);
}

/**
 * Runs an ES module source in a fresh Worker realm. Resolves when the Worker
 * exits or, after `deadlineMs`, once it has been terminated.
 */
export function runRealmProbe(source, { execArgv = [], deadlineMs = TERMINATION_BOUND_MS, workerData } = {}) {
  return new Promise((resolve) => {
    const worker = track(new Worker(probeFileUrl(source), { execArgv, workerData, stdout: true, stderr: true }));
    let stderr = '';
    let error;
    let timedOut = false;
    worker.stdout.resume();
    worker.stderr.setEncoding('utf8');
    worker.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => { timedOut = true; void worker.terminate(); }, deadlineMs);
    worker.on('error', (cause) => { error = cause; });
    worker.once('exit', (code) => {
      clearTimeout(timer);
      resolve({ code: timedOut ? null : code, timedOut, error: error === undefined ? undefined : String(error?.stack ?? error), stderr });
    });
  });
}

/**
 * Runs a probe that is expected never to finish. The probe receives
 * `workerData.entered`, an Int32Array over a SharedArrayBuffer, and must set
 * element 0 to 1 immediately before entering its infinite loop. The result
 * records whether the loop was entered and whether the Worker exited during
 * the confirmation window that follows; the Worker is then terminated.
 */
export async function runHangProbe(source, { execArgv = [], enterBoundMs = TERMINATION_BOUND_MS, confirmMs = 500 } = {}) {
  const entered = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  const worker = track(new Worker(probeFileUrl(source), { execArgv, workerData: { entered }, stdout: true, stderr: true }));
  worker.stdout.resume();
  worker.stderr.resume();
  let exitCode = null;
  let error;
  let exited = false;
  worker.on('error', (cause) => { error = cause; });
  const exit = new Promise((resolve) => worker.once('exit', (code) => { exited = true; exitCode = code; resolve(); }));
  const startedAt = Date.now();
  while (Atomics.load(entered, 0) !== 1 && !exited && Date.now() - startedAt < enterBoundMs) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const loopEntered = Atomics.load(entered, 0) === 1;
  if (loopEntered && !exited) await new Promise((resolve) => setTimeout(resolve, confirmMs));
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
  { source: "Object.defineProperty(Array.prototype, 'map', { value() { for (;;) {} }, configurable: true })", expected: 'normal_completion' },
  { source: "Object.defineProperty(Array.prototype, Symbol.iterator, { value() { for (;;) {} }, configurable: true })", expected: 'normal_completion' },
  { source: "Object.defineProperty(RegExp.prototype, 'test', { value() { for (;;) {} }, configurable: true })", expected: 'safe_refusal' },
  { source: "Object.defineProperty(String.prototype, 'startsWith', { value() { for (;;) {} }, configurable: true })", expected: 'safe_refusal' },
  { source: "Object.defineProperty(String.prototype, 'indexOf', { value() { for (;;) {} }, configurable: true })", expected: 'safe_refusal' },
  { source: "Object.defineProperty(String.prototype, 'slice', { value() { for (;;) {} }, configurable: true })", expected: 'safe_refusal' },
  { source: "Object.defineProperty(String.prototype, 'endsWith', { value() { for (;;) {} }, configurable: true })", expected: 'safe_refusal' },
  { source: "Object.defineProperty(Map.prototype, 'get', { value() { for (;;) {} }, configurable: true })", expected: 'safe_refusal' },
  { source: "Object.defineProperty(Map.prototype, 'set', { value() { for (;;) {} }, configurable: true })", expected: 'safe_refusal' },
  { source: "Object.defineProperty(Map.prototype, 'has', { value() { for (;;) {} }, configurable: true })", expected: 'safe_refusal' },
  { source: "Object.defineProperty(WeakSet.prototype, 'add', { value() { for (;;) {} }, configurable: true })", expected: 'safe_refusal' },
  { source: "Object.defineProperty(WeakSet.prototype, 'has', { value() { for (;;) {} }, configurable: true })", expected: 'safe_refusal' },
]);

/**
 * One cell of the poisoned recreated-worker matrix. The emitted worker is
 * poisoned by a preload before module evaluation; with `sourceResolution` an
 * entry module loads the TypeScript engine through the loader first, then
 * poisons before the engine's queued core work. Trace events are read only
 * after the authorization port has closed: the engine closes it before it
 * posts its result, so every event has arrived by then.
 */
export async function runPoisonedWorkerCase({ engineUrl, workerLoader, sourceResolution = false, taskIndex, poisonIndex, deadlineMs = TERMINATION_BOUND_MS }) {
  const task = POISONED_WORKER_TASKS[taskIndex];
  const poison = POISONED_WORKER_POISONS[poisonIndex];
  const directory = mkdtempSync(join(tmpdir(), 'matched-ni-poisoned-worker-'));
  const preload = join(directory, sourceResolution ? 'entry.mjs' : 'poison.mjs');
  if (sourceResolution) {
    writeFileSync(preload, `import ${JSON.stringify(engineUrl)}; import { workerData } from 'node:worker_threads'; workerData.authorizationPort.postMessage('import_complete'); ${poison.source}; workerData.authorizationPort.postMessage('poison_ack');`);
  } else {
    writeFileSync(preload, `import { workerData } from 'node:worker_threads'; ${poison.source}; workerData.authorizationPort.postMessage('poison_ack');`);
  }
  const events = [];
  try {
    const channel = new MessageChannel();
    const portClosed = new Promise((resolve) => channel.port1.once('close', resolve));
    const worker = track(new Worker(new URL(sourceResolution ? pathToFileURL(preload).href : engineUrl), {
      workerData: { exactMatchedPairNiWorker: true, task: task.task, authorizationPort: channel.port2, payload: task.payload(), trace: true },
      transferList: [channel.port2],
      execArgv: sourceResolution ? [...workerLoader] : [...workerLoader, '--import', pathToFileURL(preload).href],
      stdout: true, stderr: true,
    }));
    worker.stdout.resume();
    worker.stderr.resume();
    let result;
    let error;
    try {
      result = await new Promise((resolve, reject) => {
        let ready = false; let poisonAck = false; let imported = !sourceResolution;
        const timer = setTimeout(() => reject(new Error(`timeout after ${events.join(',')}`)), deadlineMs);
        channel.port1.on('message', (message) => {
          events.push(String(message));
          ready ||= message === 'exact_matched_pair_ni_ready';
          poisonAck ||= message === 'poison_ack';
          imported ||= message === 'import_complete';
          if (ready && poisonAck && imported) { events.push('authorized'); channel.port1.postMessage('exact_matched_pair_ni_authorized'); }
        });
        worker.once('message', (message) => { clearTimeout(timer); resolve(message); });
        worker.once('error', (cause) => { clearTimeout(timer); reject(cause); });
        worker.once('exit', (code) => { clearTimeout(timer); reject(new Error(`worker exited ${code}; events=${events.join(',')}`)); });
      });
    } catch (cause) {
      error = String(cause?.message ?? cause);
    }
    await worker.terminate();
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
      const passed = testCase.kind === 'poisoned_worker' ? outcome.pass : outcome.code === 0 && !outcome.timedOut && outcome.error === undefined;
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
