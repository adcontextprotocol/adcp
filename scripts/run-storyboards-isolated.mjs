#!/usr/bin/env node

/**
 * Run each applicable storyboard in a fresh process group.
 *
 * This orchestrator deliberately has no dependency on the training agent or
 * @adcp/sdk. The child runner discovers applicable IDs and executes exactly
 * one ID per process, so SDK/module state cannot leak between storyboards.
 */

import { spawn } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const LIST_PREFIX = 'ADCP_STORYBOARD_LIST ';
const RESULT_PREFIX = 'ADCP_STORYBOARD_RESULT ';
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_RSS_LIMIT_MB = 4_096;
const DEFAULT_RSS_POLL_MS = 250;
const DEFAULT_OUTPUT_LIMIT_MB = 16;
const DEFAULT_CHILD_MAX_OLD_SPACE_MB = 2_048;
const MAX_CHILD_LINE_BYTES = 1024 * 1024;
const STORYBOARD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,255}$/;
let activeChildPid;

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

function parseArgs(argv) {
  const knownValueOptions = new Set([
    '--shard-index',
    '--shard-count',
    '--timeout-ms',
    '--rss-limit-mb',
    '--rss-poll-ms',
    '--output-limit-mb',
    '--telemetry-file',
    '--results-file',
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

  return {
    shardIndex,
    shardCount,
    timeoutMs,
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

function childEnvironment(maxOldSpaceMb) {
  const environment = { ...process.env };
  const nodeOptions = environment.NODE_OPTIONS ?? '';
  if (!/(?:^|\s)--max[-_]old[-_]space[-_]size(?:=|\s|$)/.test(nodeOptions)) {
    environment.NODE_OPTIONS = `${nodeOptions} --max-old-space-size=${maxOldSpaceMb}`.trim();
  }
  return environment;
}

function terminateActiveChild(signal) {
  try {
    killProcessGroup(activeChildPid);
  } finally {
    process.exit(signal === 'SIGINT' ? 130 : 143);
  }
}

process.once('SIGINT', () => terminateActiveChild('SIGINT'));
process.once('SIGTERM', () => terminateActiveChild('SIGTERM'));

function childInvocation(extraArgs) {
  const fixtureRunner = process.env.STORYBOARD_RUNNER_BIN;
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

function killProcessGroup(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return;
  try {
    process.kill(process.platform === 'win32' ? pid : -pid, 'SIGKILL');
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
}

function linuxProcessGroupRssBytes(processGroupId) {
  let totalKb = 0;
  for (const entry of readdirSync('/proc', { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    try {
      const stat = readFileSync(join('/proc', entry.name, 'stat'), 'utf8');
      const afterCommand = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
      if (Number(afterCommand[2]) !== processGroupId) continue;
      const status = readFileSync(join('/proc', entry.name, 'status'), 'utf8');
      const match = status.match(/^VmRSS:\s+(\d+)\s+kB$/m);
      if (match) totalKb += Number(match[1]);
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ESRCH') throw error;
    }
  }
  return totalKb * 1024;
}

async function portableProcessGroupRssBytes(processGroupId) {
  if (process.platform === 'linux') return linuxProcessGroupRssBytes(processGroupId);
  return await new Promise((resolveRss) => {
    const ps = spawn('ps', ['-axo', 'pgid=,rss='], { stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '';
    ps.stdout.setEncoding('utf8');
    ps.stdout.on('data', chunk => { output += chunk; });
    ps.once('error', () => resolveRss(0));
    ps.once('close', () => {
      let totalKb = 0;
      for (const line of output.split('\n')) {
        const [pgid, rss] = line.trim().split(/\s+/).map(Number);
        if (pgid === processGroupId && Number.isFinite(rss)) totalKb += rss;
      }
      resolveRss(totalKb * 1024);
    });
  });
}

function telemetryLine(record) {
  return `ADCP_STORYBOARD_TELEMETRY ${JSON.stringify(record)}`;
}

async function runManagedChild({
  storyboardId,
  childArgs,
  expectedPrefix,
  config,
  validateEnvelope = () => true,
  persistResult = false,
  streamOutput = false,
}) {
  const invocation = childInvocation(childArgs);
  const startedAt = Date.now();
  const child = spawn(invocation.command, invocation.args, {
    cwd: process.cwd(),
    // Keep large schema-validation storyboards below the outer RSS guard by
    // asking V8 to collect earlier. Explicit caller limits remain authoritative.
    env: childEnvironment(config.childMaxOldSpaceMb),
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  activeChildPid = child.pid;
  const exitPromise = new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('close', (code, closeSignal) => resolveExit({ exitCode: code, signal: closeSignal }));
  });

  let envelope;
  let peakRssBytes = 0;
  let timedOut = false;
  let resourceLimited = false;
  let outputLimited = false;
  let outputBytes = 0;
  let stdoutBuffer = '';
  let stderrBuffer = '';
  let sampling = false;
  let completed = false;
  let monitorError;
  let teardownError;
  let teardownErrorCode;

  const requestGroupKill = () => {
    try {
      killProcessGroup(child.pid);
    } catch (error) {
      // A fast child may exit before its final pipe data is delivered. On
      // macOS the now-vacant PGID can report EPERM instead of ESRCH; there is
      // no owned process group left to tear down in that state.
      if (error?.code === 'EPERM' && (child.exitCode !== null || child.signalCode !== null)) return;
      teardownError ??= error instanceof Error ? error.message : String(error);
      teardownErrorCode ??= error?.code;
    }
  };

  const accountOutput = (chunk) => {
    if (outputLimited) return false;
    outputBytes += Buffer.byteLength(chunk);
    if (outputBytes <= config.outputLimitBytes) return true;
    if (!outputLimited) {
      outputLimited = true;
      process.stderr.write(
        `::error::${storyboardId ?? 'discovery'} exceeded child output limit of ${config.outputLimitBytes} bytes\n`,
      );
      requestGroupKill();
    }
    return false;
  };

  const safeLogLine = (line) => {
    const withoutControls = line
      .replace(/\r/g, '')
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '\ufffd');
    return /^\s*::/.test(withoutControls) ? `[child] ${withoutControls}` : withoutControls;
  };

  const persistEnvelope = (parsed) => {
    if (persistResult && config.resultsFile) {
      appendFileSync(config.resultsFile, `${JSON.stringify(parsed)}\n`, 'utf8');
    }
    envelope = parsed;
    // The envelope has reached the orchestrator (and the result artifact when
    // configured), so no child disposal path is needed for correctness.
    requestGroupKill();
  };

  const handleLine = (line) => {
    if (line.startsWith(expectedPrefix)) {
      try {
        const parsed = JSON.parse(line.slice(expectedPrefix.length));
        if (!validateEnvelope(parsed)) throw new Error('envelope failed completeness validation');
        persistEnvelope(parsed);
      } catch (error) {
        process.stderr.write(`Unable to accept result envelope from ${storyboardId ?? 'discovery'}: ${error.message}\n`);
      }
      return;
    }
    if (!streamOutput) return;
    if (/^\s*--- Totals ---\s*$/.test(line)) {
      process.stdout.write('--- Child result ---\n');
    } else if (/^\s*storyboards:/.test(line)) {
      process.stdout.write(line.replace('storyboards:', 'child storyboards:') + '\n');
    } else if (/^\s*steps:/.test(line)) {
      process.stdout.write(line.replace('steps:', 'child steps:') + '\n');
    } else {
      process.stdout.write(`${safeLogLine(line)}\n`);
    }
  };

  const handleStderrLine = (line) => {
    process.stderr.write(`[child stderr] ${safeLogLine(line)}\n`);
  };

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    if (!accountOutput(chunk)) return;
    stdoutBuffer += chunk;
    if (Buffer.byteLength(stdoutBuffer) > MAX_CHILD_LINE_BYTES) {
      outputLimited = true;
      requestGroupKill();
      return;
    }
    const lines = stdoutBuffer.split('\n');
    stdoutBuffer = lines.pop() ?? '';
    for (const line of lines) handleLine(line.replace(/\r$/, ''));
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    if (!accountOutput(chunk)) return;
    stderrBuffer += chunk;
    if (Buffer.byteLength(stderrBuffer) > MAX_CHILD_LINE_BYTES) {
      outputLimited = true;
      requestGroupKill();
      return;
    }
    const lines = stderrBuffer.split('\n');
    stderrBuffer = lines.pop() ?? '';
    for (const line of lines) handleStderrLine(line.replace(/\r$/, ''));
  });

  const timeout = setTimeout(() => {
    if (envelope !== undefined) return;
    timedOut = true;
    requestGroupKill();
  }, config.timeoutMs);

  let currentRssSample = Promise.resolve();
  const sampleRss = () => {
    if (completed || sampling || envelope !== undefined) return;
    sampling = true;
    currentRssSample = portableProcessGroupRssBytes(child.pid)
      .then((rssBytes) => {
        // Once a complete envelope is durable, disposal-time growth cannot
        // retroactively turn the storyboard into a resource failure.
        if (completed || envelope !== undefined) return;
        peakRssBytes = Math.max(peakRssBytes, rssBytes);
        if (rssBytes > config.rssLimitBytes) {
          resourceLimited = true;
          requestGroupKill();
        }
      })
      .catch((error) => {
        if (completed || envelope !== undefined) return;
        monitorError = error instanceof Error ? error.message : String(error);
        requestGroupKill();
      })
      .finally(() => {
        sampling = false;
      });
    return currentRssSample;
  };
  let rssPoll;
  let exit;
  try {
    await sampleRss();
    rssPoll = setInterval(() => { void sampleRss(); }, config.rssPollMs);
    exit = await exitPromise;
  } finally {
    completed = true;
    clearTimeout(timeout);
    if (rssPoll) clearInterval(rssPoll);
    await currentRssSample;
    requestGroupKill();
    if (activeChildPid === child.pid) activeChildPid = undefined;
  }
  const { exitCode, signal } = exit;
  if (stdoutBuffer && !outputLimited) handleLine(stdoutBuffer.replace(/\r$/, ''));
  if (stderrBuffer && !outputLimited) handleStderrLine(stderrBuffer.replace(/\r$/, ''));

  const effectiveTeardownError = teardownErrorCode === 'EPERM' && exitCode !== null
    ? null
    : teardownError ?? null;
  const record = {
    storyboard_id: storyboardId,
    elapsed_ms: Date.now() - startedAt,
    peak_rss_bytes: peakRssBytes,
    output_bytes: outputBytes,
    exit_code: exitCode,
    signal,
    timed_out: timedOut,
    resource_limited: resourceLimited,
    output_limited: outputLimited,
    monitor_error: monitorError ?? null,
    teardown_error: effectiveTeardownError,
    result_received: envelope !== undefined,
  };
  process.stdout.write(`${telemetryLine(record)}\n`);
  if (config.telemetryFile) appendFileSync(config.telemetryFile, `${JSON.stringify(record)}\n`, 'utf8');
  return { envelope, record };
}

function totalsFromEnvelope(envelope, storyboardId) {
  const totals = envelope?.totals;
  const countFields = ['passed', 'failed', 'skipped', 'not_applicable'];
  const expectedSummaryIds = storyboardId === 'signed_requests'
    ? ['signed_requests-strict', 'signed_requests-strict-required', 'signed_requests-strict-forbidden']
    : [storyboardId];
  if (
    envelope?.version !== 1
    || envelope.storyboard_id !== storyboardId
    || !Array.isArray(envelope.summaries)
    || envelope.summaries.length !== expectedSummaryIds.length
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

function addTotals(target, source) {
  target.clean += source.clean;
  target.total += source.total;
  target.passed += source.passed;
  target.failed += source.failed;
  target.skipped += source.skipped;
  target.not_applicable += source.not_applicable;
}

function validDiscoveryEnvelope(envelope) {
  const applicableIds = envelope?.storyboard_ids;
  return envelope?.version === 1
    && Array.isArray(applicableIds)
    && applicableIds.every(id => typeof id === 'string' && STORYBOARD_ID_PATTERN.test(id))
    && new Set(applicableIds).size === applicableIds.length;
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

  const discovery = await runManagedChild({
    storyboardId: null,
    childArgs: [...config.passthrough, '--list-applicable-json'],
    expectedPrefix: LIST_PREFIX,
    config,
    validateEnvelope: envelope => validDiscoveryEnvelope(envelope),
  });
  const applicableIds = discovery.envelope?.storyboard_ids;
  if (!validDiscoveryEnvelope(discovery.envelope)) {
    throw new Error('Storyboard discovery did not emit a complete ID envelope');
  }

  const start = Math.floor(applicableIds.length * config.shardIndex / config.shardCount);
  const end = Math.floor(applicableIds.length * (config.shardIndex + 1) / config.shardCount);
  const storyboardIds = applicableIds.slice(start, end);
  process.stdout.write(
    `\nIsolated orchestrator ${config.shardIndex + 1}/${config.shardCount}: `
    + `${storyboardIds.length} of ${applicableIds.length} applicable storyboards\n`,
  );

  const aggregate = { clean: 0, total: 0, passed: 0, failed: 0, skipped: 0, not_applicable: 0 };
  let infrastructureFailures = 0;
  for (const storyboardId of storyboardIds) {
    process.stdout.write(`\n=== Isolated storyboard: ${storyboardId} ===\n`);
    const child = await runManagedChild({
      storyboardId,
      childArgs: [
        ...config.passthrough,
        '--storyboard-id', storyboardId,
        '--emit-result-envelope',
      ],
      expectedPrefix: RESULT_PREFIX,
      config,
      validateEnvelope: envelope => totalsFromEnvelope(envelope, storyboardId) !== undefined,
      persistResult: true,
      streamOutput: true,
    });
    const totals = totalsFromEnvelope(child.envelope, storyboardId);
    if (
      !totals
      || child.record.timed_out
      || child.record.resource_limited
      || child.record.output_limited
      || child.record.monitor_error
      || child.record.teardown_error
    ) {
      infrastructureFailures += 1;
      aggregate.total += 1;
      let reason = 'did not emit a complete result envelope';
      if (child.record.timed_out) reason = `timed out after ${config.timeoutMs}ms`;
      else if (child.record.resource_limited) reason = `exceeded RSS limit of ${config.rssLimitBytes} bytes`;
      else if (child.record.output_limited) reason = `exceeded output limit of ${config.outputLimitBytes} bytes`;
      else if (child.record.monitor_error) reason = `RSS monitoring failed: ${child.record.monitor_error}`;
      else if (child.record.teardown_error) reason = `process-group teardown failed: ${child.record.teardown_error}`;
      process.stderr.write(`::error::${storyboardId} ${reason}\n`);
      continue;
    }
    addTotals(aggregate, totals);
  }

  process.stdout.write('\n--- Totals ---\n');
  process.stdout.write(`  storyboards: ${aggregate.clean}/${aggregate.total} clean\n`);
  process.stdout.write(
    `  steps: ${aggregate.passed} passed | ${aggregate.failed} failed | `
    + `${aggregate.skipped} skipped | ${aggregate.not_applicable} not applicable\n`,
  );
  process.exitCode = infrastructureFailures > 0 ? 1 : 0;
}

main().catch(error => {
  process.stderr.write(`Fatal isolated storyboard runner error: ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
