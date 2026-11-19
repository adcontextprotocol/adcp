#!/usr/bin/env node

/**
 * Run each applicable storyboard under its own timeout, RSS, output and
 * envelope checks, in a fresh process group (the default) or, with
 * --storyboards-per-process K above 1, in batches of K per worker process.
 *
 * This orchestrator deliberately has no dependency on the training agent or
 * @adcp/sdk. The child runner discovers applicable IDs and executes either
 * exactly one ID per process, so SDK/module state cannot leak between
 * storyboards, or (as a worker) a fixed batch of K consecutive IDs, resetting
 * the training agent's process-local state before each.
 *
 * The local storyboard queue (scripts/run-storyboards-queue.mjs) reuses the
 * child management exported here to run many such children at once; run as a
 * script, this orchestrator behaves as before.
 */

import { spawn } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const LIST_PREFIX = 'ADCP_STORYBOARD_LIST ';
export const RESULT_PREFIX = 'ADCP_STORYBOARD_RESULT ';
// Worker protocol: BEGIN on stdout when a storyboard starts, END on stderr
// after its envelope (see run-storyboards.ts --storyboard-worker).
export const BEGIN_PREFIX = 'ADCP_STORYBOARD_BEGIN ';
export const END_PREFIX = 'ADCP_STORYBOARD_END ';
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_RSS_LIMIT_MB = 4_096;
const DEFAULT_RSS_POLL_MS = 250;
const DEFAULT_OUTPUT_LIMIT_MB = 16;
const DEFAULT_CHILD_MAX_OLD_SPACE_MB = 2_048;
const MAX_CHILD_LINE_BYTES = 1024 * 1024;
// A worker whose V8 heap in use is above three quarters of the default 2 GiB
// old space is replaced before its next storyboard.
const HEAP_RECYCLE_BYTES = 1.5 * 1024 * 1024 * 1024;
const STORYBOARD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,255}$/;
const activeChildPids = new Set();

function requiredPositiveInteger(raw, name, { allowZero = false } = {}) {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || (allowZero ? value < 0 : value < 1)) {
    throw new Error(`${name} requires ${allowZero ? 'a non-negative' : 'a positive'} integer`);
  }
  return value;
}

function optionValue(args, name, fallback) {
  // Last value wins so explicit CLI options can override wrapper/default
  // arguments in the same way they override environment defaults.
  const index = args.lastIndexOf(name);
  if (index === -1) return fallback;
  if (args[index + 1] === undefined) throw new Error(`${name} requires a value`);
  return args[index + 1];
}

export function parseArgs(argv) {
  const knownValueOptions = new Set([
    '--shard-index',
    '--shard-count',
    '--timeout-ms',
    '--rss-limit-mb',
    '--rss-poll-ms',
    '--output-limit-mb',
    '--telemetry-file',
    '--results-file',
    '--storyboards-per-process',
    '--recycle-rss-mb',
  ]);
  const passthrough = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (knownValueOptions.has(arg)) {
      index += 1;
      if (argv[index] === undefined) throw new Error(`${arg} requires a value`);
      continue;
    }
    passthrough.push(arg);
  }

  const shardIndexRaw = optionValue(argv, '--shard-index', undefined);
  const shardCountRaw = optionValue(argv, '--shard-count', undefined);
  if ((shardIndexRaw === undefined) !== (shardCountRaw === undefined)) {
    throw new Error('--shard-index and --shard-count must be supplied together');
  }
  const shardCount = shardCountRaw === undefined
    ? 1
    : requiredPositiveInteger(shardCountRaw, '--shard-count');
  const shardIndex = shardIndexRaw === undefined
    ? 0
    : requiredPositiveInteger(shardIndexRaw, '--shard-index', { allowZero: true });
  if (shardIndex >= shardCount) {
    throw new Error('--shard-index must be between 0 and --shard-count - 1');
  }

  const timeoutMs = requiredPositiveInteger(
    optionValue(argv, '--timeout-ms', process.env.STORYBOARD_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS),
    '--timeout-ms',
  );
  const rssLimitMb = requiredPositiveInteger(
    optionValue(argv, '--rss-limit-mb', process.env.STORYBOARD_RSS_LIMIT_MB ?? DEFAULT_RSS_LIMIT_MB),
    '--rss-limit-mb',
  );
  const rssPollMs = requiredPositiveInteger(
    optionValue(argv, '--rss-poll-ms', process.env.STORYBOARD_RSS_POLL_MS ?? DEFAULT_RSS_POLL_MS),
    '--rss-poll-ms',
  );
  const outputLimitMb = requiredPositiveInteger(
    optionValue(argv, '--output-limit-mb', process.env.STORYBOARD_OUTPUT_LIMIT_MB ?? DEFAULT_OUTPUT_LIMIT_MB),
    '--output-limit-mb',
  );

  const storyboardsPerProcess = requiredPositiveInteger(
    optionValue(argv, '--storyboards-per-process', 1),
    '--storyboards-per-process',
  );
  const recycleRssRaw = optionValue(argv, '--recycle-rss-mb', undefined);
  const recycleRssMb = recycleRssRaw === undefined
    ? rssLimitMb / 2
    : requiredPositiveInteger(recycleRssRaw, '--recycle-rss-mb');

  return {
    shardIndex,
    shardCount,
    timeoutMs,
    storyboardsPerProcess,
    recycleRssBytes: recycleRssMb * 1024 * 1024,
    rssLimitBytes: rssLimitMb * 1024 * 1024,
    rssPollMs,
    outputLimitBytes: outputLimitMb * 1024 * 1024,
    childMaxOldSpaceMb: requiredPositiveInteger(
      process.env.STORYBOARD_CHILD_MAX_OLD_SPACE_MB ?? DEFAULT_CHILD_MAX_OLD_SPACE_MB,
      'STORYBOARD_CHILD_MAX_OLD_SPACE_MB',
    ),
    telemetryFile: optionValue(argv, '--telemetry-file', process.env.STORYBOARD_TELEMETRY_FILE),
    resultsFile: optionValue(argv, '--results-file', process.env.STORYBOARD_RESULTS_FILE),
    passthrough,
  };
}

function childEnvironment(maxOldSpaceMb, baseEnvironment = process.env) {
  const environment = { ...baseEnvironment };
  const nodeOptions = environment.NODE_OPTIONS ?? '';
  if (!/(?:^|\s)--max[-_]old[-_]space[-_]size(?:=|\s|$)/.test(nodeOptions)) {
    environment.NODE_OPTIONS = `${nodeOptions} --max-old-space-size=${maxOldSpaceMb}`.trim();
  }
  return environment;
}

/** Kills the process group of every child runManagedChild has running. */
export function killActiveChildren() {
  for (const pid of activeChildPids) {
    try {
      killProcessGroup(pid);
    } catch {}
  }
}

function terminateActiveChild(signal) {
  try {
    killActiveChildren();
  } finally {
    process.exit(signal === 'SIGINT' ? 130 : 143);
  }
}

function childInvocation(extraArgs, baseEnvironment = process.env) {
  const fixtureRunner = baseEnvironment.STORYBOARD_RUNNER_BIN;
  if (fixtureRunner) {
    const resolvedRunner = resolve(fixtureRunner);
    if (/\.(?:c?js|mjs)$/.test(resolvedRunner)) {
      return { command: process.execPath, args: [resolvedRunner, ...extraArgs] };
    }
    return { command: resolvedRunner, args: extraArgs };
  }
  return {
    command: process.execPath,
    args: ['--import', 'tsx', 'server/tests/manual/run-storyboards.ts', ...extraArgs],
  };
}

export function killProcessGroup(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return;
  try {
    process.kill(process.platform === 'win32' ? pid : -pid, 'SIGKILL');
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
}

// RSS in kB per process group, for the groups of the children running now.
function linuxProcessGroupRssKb() {
  const totals = new Map();
  // Request names only. Asking readdir for Dirents makes Node lstat each
  // volatile /proc/<pid> entry, and a process exiting during that scan can
  // surface ENOENT before the per-entry race handling below gets a chance to
  // ignore it.
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = readFileSync(join('/proc', entry, 'stat'), 'utf8');
      const afterCommand = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
      const processGroupId = Number(afterCommand[2]);
      if (!activeChildPids.has(processGroupId)) continue;
      const status = readFileSync(join('/proc', entry, 'status'), 'utf8');
      const match = status.match(/^VmRSS:\s+(\d+)\s+kB$/m);
      if (match) totals.set(processGroupId, (totals.get(processGroupId) ?? 0) + Number(match[1]));
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ESRCH') throw error;
    }
  }
  return totals;
}

function psProcessGroupRssKb() {
  return new Promise((resolveRss) => {
    const ps = spawn('ps', ['-axo', 'pgid=,rss='], { stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '';
    ps.stdout.setEncoding('utf8');
    ps.stdout.on('data', chunk => { output += chunk; });
    ps.once('error', () => resolveRss(new Map()));
    ps.once('close', () => {
      const totals = new Map();
      for (const line of output.split('\n')) {
        const [pgid, rss] = line.trim().split(/\s+/).map(Number);
        if (Number.isFinite(pgid) && Number.isFinite(rss)) totals.set(pgid, (totals.get(pgid) ?? 0) + rss);
      }
      resolveRss(totals);
    });
  });
}

// Concurrent children (the local queue) share one process-table scan. On
// Linux a scan younger than LINUX_SCAN_REUSE_MS serves every child that
// samples in that window, so N children cost one /proc walk per window, not
// N walks per poll interval. One child polls less often than the window, so
// it always gets a fresh scan, as before. Elsewhere a sample requested while
// a ps scan is in flight waits for that scan.
const LINUX_SCAN_REUSE_MS = 50;
let linuxScan;
let inFlightPsScan;
async function portableProcessGroupRssBytes(processGroupId, { fresh = false } = {}) {
  if (process.platform === 'linux') {
    const now = Date.now();
    if (fresh || !linuxScan || now - linuxScan.at >= LINUX_SCAN_REUSE_MS || !linuxScan.totals.has(processGroupId)) {
      linuxScan = { at: now, totals: linuxProcessGroupRssKb() };
    }
    return (linuxScan.totals.get(processGroupId) ?? 0) * 1024;
  }
  const scan = fresh
    ? psProcessGroupRssKb()
    : (inFlightPsScan ??= psProcessGroupRssKb().finally(() => { inFlightPsScan = undefined; }));
  const totals = await scan;
  return (totals.get(processGroupId) ?? 0) * 1024;
}

function telemetryLine(record) {
  return `ADCP_STORYBOARD_TELEMETRY ${JSON.stringify(record)}`;
}

const processSink = {
  out: text => process.stdout.write(text),
  err: text => process.stderr.write(text),
};

/**
 * Starts one child in its own detached process group under the orchestrator's
 * checks, and splits what it prints into windows: one per storyboard (or the
 * discovery). `window()` opens the next window and resolves when it closes.
 *
 * Single mode (`worker: false`): the child runs one storyboard (or the
 * discovery) and its one window opens at spawn. A complete envelope is
 * persisted and the group is killed; the window closes when the child does,
 * so the section, exit status and telemetry are those of a fresh process.
 *
 * Worker mode (`worker: true`): the child is
 * `run-storyboards.ts --storyboard-worker` and reads storyboard ids from
 * stdin. A window opens when its id is written. Per window the child prints
 * BEGIN on stdout, the storyboard's output, its envelope, then END on stderr.
 * Stdout lines go to the open window until its envelope and stderr lines
 * until its END marker; the window closes cleanly when both have arrived, and
 * the process stays up for the next id. A window also closes when the child
 * exits. Every check (timeout, RSS, output and line limits, envelope) applies
 * to the open window only, and any failure kills the whole group.
 */
function startManagedProcess({ childArgs, config, env, worker }) {
  const invocation = childInvocation(childArgs, env);
  const child = spawn(invocation.command, invocation.args, {
    cwd: process.cwd(),
    // Keep large schema-validation storyboards below the outer RSS guard by
    // asking V8 to collect earlier. Explicit caller limits remain authoritative.
    env: childEnvironment(config.childMaxOldSpaceMb, env),
    detached: true,
    stdio: [worker ? 'pipe' : 'ignore', 'pipe', 'pipe'],
  });
  activeChildPids.add(child.pid);
  // A worker that exits before it reads its next id must not take the
  // orchestrator (and every tenant in the queue) down with EPIPE.
  child.stdin?.on('error', () => {});

  let open;
  let lastClosed;
  let exited;
  let stdoutBuffer = '';
  let stderrBuffer = '';
  let sampling = false;
  let currentRssSample = Promise.resolve();
  let rssPoll;
  let opened = 0;
  let pendingTeardownError;
  // Output a worker prints between two windows (late async work of the
  // storyboard before) is held for the next window.
  let gapChunks = [];

  const noteTeardownError = (error) => {
    const target = open ?? lastClosed;
    const message = error instanceof Error ? error.message : String(error);
    if (!target) {
      pendingTeardownError ??= { message, code: error?.code };
      return;
    }
    target.teardownError ??= message;
    target.teardownErrorCode ??= error?.code;
  };

  const requestGroupKill = () => {
    try {
      killProcessGroup(child.pid);
    } catch (error) {
      // A fast child may exit before its final pipe data is delivered. On
      // macOS the now-vacant PGID can report EPERM instead of ESRCH; there is
      // no owned process group left to tear down in that state.
      if (error?.code === 'EPERM' && (child.exitCode !== null || child.signalCode !== null)) return;
      noteTeardownError(error);
    }
  };

  const closeOpenWindow = () => {
    const closing = open;
    if (!closing) return;
    open = undefined;
    lastClosed = closing;
    closing.closedAt = Date.now();
    clearTimeout(closing.timer);
    closing.resolveClose();
  };

  const accountOutput = (chunk) => {
    if (!open || open.outputLimited) return false;
    open.outputBytes += Buffer.byteLength(chunk);
    if (open.outputBytes <= config.outputLimitBytes) return true;
    open.outputLimited = true;
    open.sink.err(
      `::error::${open.storyboardId ?? 'discovery'} exceeded child output limit of ${config.outputLimitBytes} bytes\n`,
    );
    requestGroupKill();
    return false;
  };

  const acceptEnvelope = (parsed) => {
    if (open.persistResult && config.resultsFile) {
      appendFileSync(config.resultsFile, `${JSON.stringify(parsed)}\n`, 'utf8');
    }
    open.envelope = parsed;
    if (!worker) {
      // The envelope has reached the orchestrator (and the result artifact
      // when configured), so no child disposal path is needed for correctness.
      requestGroupKill();
    } else if (open.ended) {
      closeOpenWindow();
    }
  };

  const markerFor = (line, prefix) => {
    try {
      const marker = JSON.parse(line.slice(prefix.length));
      return marker?.version === 1 && marker.storyboard_id === open.storyboardId ? marker : undefined;
    } catch {
      return undefined;
    }
  };

  const handleStdoutLine = (line) => {
    if (!open) return;
    if (worker && line.startsWith(BEGIN_PREFIX)) {
      if (markerFor(line, BEGIN_PREFIX)) open.began = true;
      return;
    }
    if (line.startsWith(open.expectedPrefix)) {
      if (open.envelope !== undefined) return;
      try {
        const parsed = JSON.parse(line.slice(open.expectedPrefix.length));
        if (!open.validateEnvelope(parsed)) throw new Error('envelope failed completeness validation');
        acceptEnvelope(parsed);
      } catch (error) {
        open.sink.err(`Unable to accept result envelope from ${open.storyboardId ?? 'discovery'}: ${error.message}\n`);
        if (worker) {
          open.envelopeRejected = true;
          requestGroupKill();
        }
      }
      return;
    }
    if (open.streamOutput) open.sink.out(formatChildLine(line));
  };

  const handleStderrLine = (line) => {
    if (!open) return;
    if (worker && line.startsWith(END_PREFIX)) {
      const marker = markerFor(line, END_PREFIX);
      if (!marker) return;
      open.ended = true;
      open.heapUsedBytes = Number.isSafeInteger(marker.heap_used_bytes) ? marker.heap_used_bytes : null;
      // The envelope may still be in the stdout pipe; the window closes when
      // it arrives, or its timeout reports that it never did.
      if (open.envelope !== undefined) closeOpenWindow();
      return;
    }
    open.sink.err(`[child stderr] ${safeLogLine(line)}\n`);
  };

  const onData = (stream) => (chunk) => {
    if (!open) {
      gapChunks.push([stream, chunk]);
      return;
    }
    if (!accountOutput(chunk)) return;
    const buffered = (stream === 'out' ? stdoutBuffer : stderrBuffer) + chunk;
    if (Buffer.byteLength(buffered) > MAX_CHILD_LINE_BYTES) {
      if (stream === 'out') stdoutBuffer = buffered;
      else stderrBuffer = buffered;
      if (open) open.outputLimited = true;
      requestGroupKill();
      return;
    }
    const lines = buffered.split('\n');
    const rest = lines.pop() ?? '';
    if (stream === 'out') stdoutBuffer = rest;
    else stderrBuffer = rest;
    const handle = stream === 'out' ? handleStdoutLine : handleStderrLine;
    for (const line of lines) handle(line.replace(/\r$/, ''));
  };
  const stdoutData = onData('out');
  const stderrData = onData('err');
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', stdoutData);
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', stderrData);

  const sampleRss = () => {
    if (exited || sampling) return currentRssSample;
    // Once a window's complete envelope is durable, later growth cannot
    // retroactively turn its storyboard into a resource failure.
    if (!open || open.envelope !== undefined) return currentRssSample;
    const sampled = open;
    sampling = true;
    currentRssSample = portableProcessGroupRssBytes(child.pid)
      .then((rssBytes) => {
        if (exited || open !== sampled || sampled.envelope !== undefined) return;
        sampled.peakRssBytes = Math.max(sampled.peakRssBytes, rssBytes);
        if (rssBytes > config.rssLimitBytes) {
          sampled.resourceLimited = true;
          requestGroupKill();
        }
      })
      .catch((error) => {
        if (exited || open !== sampled || sampled.envelope !== undefined) return;
        sampled.monitorError = error instanceof Error ? error.message : String(error);
        requestGroupKill();
      })
      .finally(() => {
        sampling = false;
      });
    return currentRssSample;
  };

  const closed = new Promise((resolveClosed, rejectClosed) => {
    child.once('error', rejectClosed);
    child.once('close', (exitCode, signal) => resolveClosed({ exitCode, signal }));
  }).then(async (exit) => {
    exited = exit;
    if (open) clearTimeout(open.timer);
    if (rssPoll) clearInterval(rssPoll);
    await currentRssSample;
    // Tear down whatever the child left in its group.
    requestGroupKill();
    activeChildPids.delete(child.pid);
    if (open) {
      if (stdoutBuffer && !open.outputLimited) handleStdoutLine(stdoutBuffer.replace(/\r$/, ''));
      if (stderrBuffer && !open.outputLimited) handleStderrLine(stderrBuffer.replace(/\r$/, ''));
      stdoutBuffer = '';
      stderrBuffer = '';
    }
    if (open) {
      open.exit = exit;
      closeOpenWindow();
    }
    return exit;
  }, (error) => {
    exited = { exitCode: null, signal: null };
    if (rssPoll) clearInterval(rssPoll);
    activeChildPids.delete(child.pid);
    if (open) open.rejectClose(error);
    throw error;
  });
  closed.catch(() => {});

  const windowRecord = (closedWindow) => {
    const exitCode = closedWindow.exit?.exitCode ?? null;
    const signal = closedWindow.exit?.signal ?? null;
    const record = {
      storyboard_id: closedWindow.storyboardId,
      elapsed_ms: closedWindow.closedAt - closedWindow.startedAt,
      peak_rss_bytes: closedWindow.peakRssBytes,
      output_bytes: closedWindow.outputBytes,
      exit_code: exitCode,
      signal,
      timed_out: closedWindow.timedOut,
      resource_limited: closedWindow.resourceLimited,
      output_limited: closedWindow.outputLimited,
      monitor_error: closedWindow.monitorError ?? null,
      teardown_error: closedWindow.teardownErrorCode === 'EPERM' && exitCode !== null
        ? null
        : closedWindow.teardownError ?? null,
      result_received: closedWindow.envelope !== undefined,
    };
    if (worker) {
      record.worker_pid = child.pid;
      record.worker_sequence = closedWindow.sequence;
      record.heap_used_bytes = closedWindow.heapUsedBytes ?? null;
    }
    return record;
  };

  return {
    pid: child.pid,

    /**
     * Opens the next window (in worker mode, by writing its id) and resolves
     * when it closes, to { envelope, window } with the window's outcome:
     * `clean` (envelope and END), `started` (the worker printed BEGIN), and
     * the checks that fired.
     */
    window({
      storyboardId,
      expectedPrefix,
      validateEnvelope = () => true,
      persistResult = false,
      streamOutput = false,
      sink = processSink,
    }) {
      if (open) throw new Error('a window is already open');
      opened += 1;
      const current = {
        storyboardId,
        expectedPrefix,
        validateEnvelope,
        persistResult,
        streamOutput,
        sink,
        sequence: opened,
        startedAt: Date.now(),
        peakRssBytes: 0,
        outputBytes: 0,
        timedOut: false,
        resourceLimited: false,
        outputLimited: false,
        envelopeRejected: false,
        began: !worker,
        ended: false,
        heapUsedBytes: null,
      };
      if (pendingTeardownError) {
        current.teardownError = pendingTeardownError.message;
        current.teardownErrorCode = pendingTeardownError.code;
        pendingTeardownError = undefined;
      }
      const done = new Promise((resolveClose, rejectClose) => {
        current.resolveClose = resolveClose;
        current.rejectClose = rejectClose;
      });
      if (exited) {
        current.exit = exited;
        lastClosed = current;
        current.closedAt = current.startedAt;
        current.resolveClose();
      } else {
        open = current;
        // The window's clock starts now, so time spent waiting in the pool or
        // on earlier storyboards of this worker is never charged to it.
        current.timer = setTimeout(() => {
          if (open !== current) return;
          if (current.envelope === undefined) {
            // A storyboard that sent END without a valid envelope is reported
            // as such, not as slow.
            if (!current.ended) current.timedOut = true;
          } else if (!worker) {
            return;
          }
          // In a worker, a valid envelope whose END never came: the result
          // stands and only the worker goes.
          requestGroupKill();
        }, config.timeoutMs);
        if (worker) child.stdin.write(`${storyboardId}\n`);
        const held = gapChunks;
        gapChunks = [];
        for (const [stream, chunk] of held) {
          if (open !== current) break;
          (stream === 'out' ? stdoutData : stderrData)(chunk);
        }
        if (!rssPoll) {
          rssPoll = setInterval(() => { void sampleRss(); }, config.rssPollMs);
        }
        void sampleRss();
      }
      return done.then(() => ({
        envelope: current.envelope,
        window: current,
        get record() { return windowRecord(current); },
        clean: current.envelope !== undefined && current.ended,
        // A worker that ended after a clean window and before it began this
        // one never started it.
        started: current.began || current.sequence === 1,
        failedCheck: current.timedOut || current.resourceLimited || current.outputLimited
          || current.envelopeRejected || current.monitorError !== undefined,
      }));
    },

    /** The group's RSS now, from a fresh process-table scan. */
    rssBytes() {
      return portableProcessGroupRssBytes(child.pid, { fresh: true });
    },

    /** Kills the group and resolves when the child has exited. */
    async stop() {
      if (!exited) requestGroupKill();
      try {
        await closed;
      } catch {}
    },

    /** Resolves to the child's exit; rejects when it could not start. */
    closed,
  };
}

function formatChildLine(line) {
  if (/^\s*--- Totals ---\s*$/.test(line)) return '--- Child result ---\n';
  if (/^\s*storyboards:/.test(line)) return `${line.replace('storyboards:', 'child storyboards:')}\n`;
  if (/^\s*selection:/.test(line)) return `${line.replace('selection:', 'child selection:')}\n`;
  if (/^\s*steps:/.test(line)) return `${line.replace('steps:', 'child steps:')}\n`;
  return `${safeLogLine(line)}\n`;
}

function safeLogLine(line) {
  const withoutControls = line
    .replace(/\r/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '�');
  return /^\s*::/.test(withoutControls) ? `[child] ${withoutControls}` : withoutControls;
}

/**
 * Runs one child for one storyboard (or the discovery) in a fresh process
 * group with the timeout, RSS, output and envelope checks. `sink` receives
 * everything this orchestrator prints for the child (stdout and stderr, in
 * order); `env` is the environment the child starts from.
 */
export async function runManagedChild({
  storyboardId,
  childArgs,
  expectedPrefix,
  config,
  validateEnvelope = () => true,
  persistResult = false,
  streamOutput = false,
  sink = processSink,
  env = process.env,
}) {
  const managed = startManagedProcess({ childArgs, config, env, worker: false });
  const outcome = await managed.window({
    storyboardId,
    expectedPrefix,
    validateEnvelope,
    persistResult,
    streamOutput,
    sink,
  });
  return emitTelemetry(outcome.envelope, outcome.record, sink, config);
}

function emitTelemetry(envelope, record, sink, config) {
  sink.out(`${telemetryLine(record)}\n`);
  if (config.telemetryFile) appendFileSync(config.telemetryFile, `${JSON.stringify(record)}\n`, 'utf8');
  return { envelope, record };
}

export function totalsFromEnvelope(envelope, storyboardId) {
  const totals = envelope?.totals;
  const countFields = ['passed', 'failed', 'skipped', 'not_applicable'];
  const expectedSummaryIdSets = storyboardId === 'signed_requests'
    ? [
        // Current AdCP 3.2 runs only the required-digest 3.2-profile route.
        // Frozen 3.0 compatibility runs retain all three legacy digest
        // variants, with required coverage on the legacy-profile route.
        ['signed_requests-strict-required'],
        ['signed_requests-strict', 'signed_requests-strict-required-legacy', 'signed_requests-strict-forbidden'],
      ]
    : [[storyboardId]];
  const expectedSummaryIds = expectedSummaryIdSets.find(expectedIds => (
    envelope?.summaries?.length === expectedIds.length
    && envelope.summaries.every(summary => expectedIds.includes(summary?.id))
  ));
  if (
    envelope?.version !== 1
    || envelope.storyboard_id !== storyboardId
    || !Array.isArray(envelope.summaries)
    || !expectedSummaryIds
    || !totals
    || !['clean', 'total', ...countFields].every(field => Number.isSafeInteger(totals[field]) && totals[field] >= 0)
  ) {
    return undefined;
  }
  const validSummaries = envelope.summaries.every(summary => (
    summary
    && typeof summary === 'object'
    && expectedSummaryIds.includes(summary.id)
    && countFields.every(field => Number.isSafeInteger(summary[field]) && summary[field] >= 0)
    && typeof summary.has_error === 'boolean'
  ));
  if (!validSummaries || new Set(envelope.summaries.map(summary => summary.id)).size !== expectedSummaryIds.length) {
    return undefined;
  }

  const expected = envelope.summaries.reduce((acc, summary) => {
    for (const field of countFields) acc[field] += summary[field];
    if (summary.failed === 0 && !summary.has_error) acc.clean += 1;
    return acc;
  }, { clean: 0, passed: 0, failed: 0, skipped: 0, not_applicable: 0 });
  if (
    totals.total !== envelope.summaries.length
    || totals.clean !== expected.clean
    || countFields.some(field => totals[field] !== expected[field])
  ) return undefined;
  return totals;
}

export function addTotals(target, source) {
  target.clean += source.clean;
  target.total += source.total;
  target.passed += source.passed;
  target.failed += source.failed;
  target.skipped += source.skipped;
  target.not_applicable += source.not_applicable;
}

export function validDiscoveryEnvelope(envelope) {
  const applicableIds = envelope?.storyboard_ids;
  const selection = envelope?.selection;
  return envelope?.version === 1
    && Array.isArray(applicableIds)
    && applicableIds.every(id => typeof id === 'string' && STORYBOARD_ID_PATTERN.test(id))
    && new Set(applicableIds).size === applicableIds.length
    && selection
    && ['corpus', 'applicable', 'not_applicable', 'quarantined'].every(
      field => Number.isSafeInteger(selection[field]) && selection[field] >= 0,
    )
    && selection.applicable === applicableIds.length
    && selection.corpus === selection.applicable + selection.not_applicable + selection.quarantined;
}

async function main() {
  const config = parseArgs(process.argv.slice(2));
  if (!config.resultsFile) {
    const temporaryDirectory = mkdtempSync(join(tmpdir(), 'adcp-storyboard-results-'));
    config.resultsFile = join(temporaryDirectory, 'results.jsonl');
    process.once('exit', () => rmSync(temporaryDirectory, { recursive: true, force: true }));
  }
  const secureCreateOptions = { encoding: 'utf8', flag: 'wx', mode: 0o600 };
  if (config.telemetryFile) writeFileSync(config.telemetryFile, '', secureCreateOptions);
  writeFileSync(config.resultsFile, '', secureCreateOptions);

  process.exitCode = await orchestrateIsolated({ config, pool: createPool(1) });
}

/**
 * A plain in-process job pool: at most `size` jobs run at once. Jobs wait in
 * lanes; a free slot takes the oldest job of the first non-empty lane in
 * `laneOrder`. `run` resolves or rejects with the job's own result.
 */
export function createPool(size, laneOrder = ['discovery', 'child']) {
  const lanes = new Map(laneOrder.map(lane => [lane, []]));
  let running = 0;
  const next = () => {
    for (const queue of lanes.values()) {
      if (queue.length > 0) return queue.shift();
    }
    return undefined;
  };
  const pump = () => {
    while (running < size) {
      const entry = next();
      if (!entry) return;
      running += 1;
      Promise.resolve()
        .then(entry.job)
        .then(entry.resolve, entry.reject)
        .finally(() => {
          running -= 1;
          pump();
        });
    }
  };
  return {
    size,
    run(lane, job) {
      const queue = lanes.get(lane);
      if (!queue) throw new Error(`unknown pool lane ${lane}`);
      return new Promise((resolveJob, rejectJob) => {
        queue.push({ job, resolve: resolveJob, reject: rejectJob });
        pump();
      });
    },
  };
}

/**
 * Per-storyboard output in applicable order. The earliest unfinished child
 * writes straight to the sink; a later child that runs at the same time keeps
 * its output, both streams in order, in a spill file (or in memory when no
 * spill directory is given) until every child before it has been written, so
 * concurrent children print exactly what a serial run prints while the
 * orchestrator's memory stays bounded (#6778).
 */
function orderedSinks(count, sink, spillDirectory) {
  const buffers = Array.from({ length: count }, (_, index) => ({
    file: spillDirectory ? join(spillDirectory, `child-${index}.jsonl`) : undefined,
    events: [],
    done: false,
  }));
  let head = 0;
  const writeEvent = (stream, text) => sink[stream](text);
  const drain = (buffer) => {
    if (buffer.file) {
      let content = '';
      try {
        content = readFileSync(buffer.file, 'utf8');
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      for (const line of content.split('\n')) {
        if (line) writeEvent(...JSON.parse(line));
      }
      rmSync(buffer.file, { force: true });
    } else {
      for (const event of buffer.events) writeEvent(...event);
    }
    buffer.events = [];
  };
  const forChild = (index) => {
    const buffer = buffers[index];
    const write = stream => (text) => {
      if (index === head) writeEvent(stream, text);
      else if (buffer.file) appendFileSync(buffer.file, `${JSON.stringify([stream, text])}\n`, 'utf8');
      else buffer.events.push([stream, text]);
    };
    return {
      out: write('out'),
      err: write('err'),
      finish() {
        buffer.done = true;
        while (head < count && buffers[head].done) {
          head += 1;
          if (head < count) drain(buffers[head]);
        }
      },
    };
  };
  return { forChild };
}

/**
 * Discovers the applicable storyboards, then runs this shard's storyboards
 * through `pool`, and writes the discovery, one section per storyboard in
 * applicable order, and the totals to `sink`. Resolves to the exit status: 1
 * when any storyboard had an infrastructure failure. Throws when discovery
 * fails.
 *
 * `config.storyboardsPerProcess` (K) sets the process model. With K = 1 each
 * storyboard runs in its own fresh process group. With K > 1 the storyboards
 * are cut into contiguous batches of K in applicable order, and each batch
 * runs in one worker process (run-storyboards.ts --storyboard-worker), so a
 * storyboard's predecessors in its process follow from K alone. Each
 * storyboard keeps its own timeout, output limit, RSS check and envelope
 * check. Any failure ends the worker, and the rest of the batch continues in
 * a fresh one; so does a clean storyboard after which the worker is above
 * the recycle bound (RSS above `config.recycleRssBytes`, or V8 heap in use
 * above 1.5 GiB).
 *
 * The CLI runs it with a pool of one. The local storyboard queue
 * (scripts/run-storyboards-queue.mjs) runs every isolated tenant through one
 * shared pool, with the tenant log as the sink.
 */
export async function orchestrateIsolated({ config, pool, sink = processSink, env = process.env, spillDirectory }) {
  const discovery = await pool.run('discovery', () => runManagedChild({
    storyboardId: null,
    childArgs: [...config.passthrough, '--list-applicable-json'],
    expectedPrefix: LIST_PREFIX,
    config,
    validateEnvelope: envelope => validDiscoveryEnvelope(envelope),
    sink,
    env,
  }));
  const applicableIds = discovery.envelope?.storyboard_ids;
  if (!validDiscoveryEnvelope(discovery.envelope)) {
    throw new Error('Storyboard discovery did not emit a complete ID envelope');
  }

  const start = Math.floor(applicableIds.length * config.shardIndex / config.shardCount);
  const end = Math.floor(applicableIds.length * (config.shardIndex + 1) / config.shardCount);
  const storyboardIds = applicableIds.slice(start, end);
  sink.out(
    `\nIsolated orchestrator ${config.shardIndex + 1}/${config.shardCount}: `
    + `${storyboardIds.length} of ${applicableIds.length} applicable storyboards\n`,
  );

  const aggregate = { clean: 0, total: 0, passed: 0, failed: 0, skipped: 0, not_applicable: 0 };
  let infrastructureFailures = 0;
  const sinks = orderedSinks(storyboardIds.length, sink, spillDirectory);
  const window = storyboardId => ({
    storyboardId,
    expectedPrefix: RESULT_PREFIX,
    validateEnvelope: envelope => totalsFromEnvelope(envelope, storyboardId) !== undefined,
    persistResult: true,
    streamOutput: true,
  });

  // Adds one storyboard's result to the totals, or reports its failure.
  // `earlier` names the storyboards its worker ran before it.
  const account = (storyboardId, childSink, envelope, record, earlier = []) => {
    const totals = totalsFromEnvelope(envelope, storyboardId);
    if (
      !totals
      || record.timed_out
      || record.resource_limited
      || record.output_limited
      || record.monitor_error
      || record.teardown_error
    ) {
      infrastructureFailures += 1;
      aggregate.total += 1;
      let reason = 'did not emit a complete result envelope';
      if (record.timed_out) reason = `timed out after ${config.timeoutMs}ms`;
      else if (record.resource_limited) reason = `exceeded RSS limit of ${config.rssLimitBytes} bytes`;
      else if (record.output_limited) reason = `exceeded output limit of ${config.outputLimitBytes} bytes`;
      else if (record.monitor_error) reason = `RSS monitoring failed: ${record.monitor_error}`;
      else if (record.teardown_error) reason = `process-group teardown failed: ${record.teardown_error}`;
      const context = earlier.length > 0 ? `; earlier in this worker: ${earlier.join(', ')}` : '';
      childSink.err(`::error::${storyboardId} ${reason}${context}\n`);
      return;
    }
    addTotals(aggregate, totals);
  };

  // One storyboard in its own fresh process group.
  const runAlone = async ({ storyboardId, index }) => {
    const childSink = sinks.forChild(index);
    try {
      childSink.out(`\n=== Isolated storyboard: ${storyboardId} ===\n`);
      // The child's clock (timeout, elapsed_ms) starts when it is spawned, so
      // time spent waiting in the pool is never charged to it.
      const child = await runManagedChild({
        ...window(storyboardId),
        childArgs: [
          ...config.passthrough,
          '--storyboard-id', storyboardId,
          '--emit-result-envelope',
        ],
        config,
        sink: childSink,
        env,
      });
      account(storyboardId, childSink, child.envelope, child.record);
    } finally {
      childSink.finish();
    }
  };

  // One batch of storyboards in as few worker processes as its outcomes allow.
  const runBatch = async (batch) => {
    const pending = [...batch];
    const headed = new Set();
    while (pending.length > 0) {
      const managed = startManagedProcess({
        childArgs: [...config.passthrough, '--storyboard-worker', '--emit-result-envelope'],
        config,
        env,
        worker: true,
      });
      const earlier = [];
      try {
        while (pending.length > 0) {
          const { storyboardId, index } = pending[0];
          const childSink = sinks.forChild(index);
          if (!headed.has(index)) {
            headed.add(index);
            childSink.out(`\n=== Isolated storyboard: ${storyboardId} ===\n`);
          }
          const outcome = await managed.window({ ...window(storyboardId), sink: childSink });
          // The worker ended after its last clean storyboard and before it
          // began this one: it runs in a fresh worker, as if never sent.
          if (!outcome.started && !outcome.failedCheck) break;
          pending.shift();
          const last = pending.length === 0;
          let recycle = !outcome.clean;
          if (!recycle && !last) {
            recycle = outcome.window.heapUsedBytes > HEAP_RECYCLE_BYTES
              || await managed.rssBytes() > config.recycleRssBytes;
          }
          // The worker's last storyboard is reported after the worker is
          // gone, so a teardown failure is charged to it as it would be to a
          // fresh process.
          if (last || recycle) await managed.stop();
          emitTelemetry(outcome.envelope, outcome.record, childSink, config);
          account(storyboardId, childSink, outcome.envelope, outcome.record, earlier);
          childSink.finish();
          earlier.push(storyboardId);
          if (recycle) break;
        }
      } finally {
        await managed.stop();
      }
    }
  };

  const perProcess = config.storyboardsPerProcess;
  const batches = [];
  for (let first = 0; first < storyboardIds.length; first += perProcess) {
    batches.push(storyboardIds.slice(first, first + perProcess).map((storyboardId, offset) => ({
      storyboardId,
      index: first + offset,
    })));
  }
  await Promise.all(batches.map(batch => pool.run('child', () => (
    perProcess === 1 ? runAlone(batch[0]) : runBatch(batch)
  ))));

  sink.out('\n--- Totals ---\n');
  sink.out(`  storyboards: ${aggregate.clean}/${aggregate.total} clean\n`);
  sink.out(
    `  selection: ${discovery.envelope.selection.applicable} applicable | `
    + `${discovery.envelope.selection.not_applicable} not applicable | `
    + `${discovery.envelope.selection.quarantined} quarantined | `
    + `${discovery.envelope.selection.corpus} corpus\n`,
  );
  sink.out(
    `  steps: ${aggregate.passed} passed | ${aggregate.failed} failed | `
    + `${aggregate.skipped} skipped | ${aggregate.not_applicable} not applicable\n`,
  );
  return infrastructureFailures > 0 ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.once('SIGINT', () => terminateActiveChild('SIGINT'));
  process.once('SIGTERM', () => terminateActiveChild('SIGTERM'));
  main().catch(error => {
    process.stderr.write(`Fatal isolated storyboard runner error: ${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
