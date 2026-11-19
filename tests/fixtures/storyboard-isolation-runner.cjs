#!/usr/bin/env node

'use strict';

/**
 * Fake storyboard runner for tests/run-storyboards-isolation.test.cjs,
 * injected with STORYBOARD_RUNNER_BIN.
 *
 *   --list-applicable-json   discovery: FIXTURE_STORYBOARDS (comma separated)
 *   --storyboard-id <id>     one storyboard, then exit
 *   --storyboard-worker      storyboard ids from stdin, one per line
 *                            (tests/fixtures/storyboard-runner-protocol.cjs)
 *
 * The storyboard id selects its behavior (see handle below); any id without a
 * behavior is healthy.
 *
 * FIXTURE_START_LOG: append one JSON line per process start
 *   ({ event: 'start', pid, role, args }) and per storyboard a process starts
 *   ({ event: 'run', pid, storyboard_id, sequence }), so tests count
 *   processes and batches independently of the orchestrator's telemetry.
 * FIXTURE_WORKER_STARTUP_EXIT: a worker exits with this code before it reads
 *   its first id.
 * FIXTURE_SLOW_MS: how long slow* storyboards take (250).
 * FIXTURE_RETAIN_MB: how much incompressible memory `retain` keeps (320).
 * FIXTURE_CHATTY_KB: how many 1 KiB lines chatty* storyboards print (400).
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { participate } = require('./storyboard-live-marker.cjs');
const { runStoryboards, storyboardMode, writeAll } = require('./storyboard-runner-protocol.cjs');

const args = process.argv.slice(2);
const storyboardIds = (process.env.FIXTURE_STORYBOARDS ?? 'healthy').split(',').filter(Boolean);
const role = args.includes('--list-applicable-json')
  ? 'discovery'
  : storyboardMode(args) === 'worker' ? 'worker' : 'isolated';
const HEAP_RECYCLE_BOUND_BYTES = 1.5 * 1024 * 1024 * 1024;

function record(entry) {
  if (process.env.FIXTURE_START_LOG) {
    fs.appendFileSync(process.env.FIXTURE_START_LOG, `${JSON.stringify({ ...entry, pid: process.pid })}\n`);
  }
}

record({ event: 'start', role, args });

if (role === 'discovery') {
  writeAll(1, `ADCP_STORYBOARD_LIST ${JSON.stringify({
    version: 1,
    storyboard_ids: storyboardIds,
    selection: {
      corpus: storyboardIds.length + 2,
      applicable: storyboardIds.length,
      not_applicable: 1,
      quarantined: 1,
    },
  })}\n`);
  process.exit(0);
}

if (role === 'worker' && process.env.FIXTURE_WORKER_STARTUP_EXIT) {
  process.exit(Number(process.env.FIXTURE_WORKER_STARTUP_EXIT));
}

function resultFor(storyboardId) {
  return {
    version: 1,
    storyboard_id: storyboardId,
    summaries: [{
      id: storyboardId,
      title: storyboardId,
      passed: 1,
      failed: 0,
      skipped: 0,
      not_applicable: 0,
      has_error: false,
    }],
    totals: {
      clean: 1,
      total: 1,
      passed: 1,
      failed: 0,
      skipped: 0,
      not_applicable: 0,
    },
  };
}

function row(storyboardId) {
  return `  ${storyboardId.padEnd(40)} ✓ 1P / 0S / 0N/A`;
}

function spawnHangingDescendant(storyboardId) {
  const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });
  if (process.env.FIXTURE_DESCENDANT_PID_FILE) {
    fs.writeFileSync(process.env.FIXTURE_DESCENDANT_PID_FILE, String(descendant.pid));
  }
  // Concurrent hanging children each record their own and their descendant's
  // pid, so a test can prove every one of them is gone after teardown.
  if (process.env.FIXTURE_DESCENDANT_PID_DIR) {
    const file = path.join(process.env.FIXTURE_DESCENDANT_PID_DIR, `${encodeURIComponent(storyboardId)}.json`);
    fs.writeFileSync(`${file}.tmp`, JSON.stringify({ child: process.pid, descendant: descendant.pid }));
    fs.renameSync(`${file}.tmp`, file);
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const retained = [];

async function handle(storyboardId, ctx) {
  const result = resultFor(storyboardId);
  if (storyboardId.startsWith('hang')) {
    spawnHangingDescendant(storyboardId);
    return ctx.hang();
  }
  if (storyboardId === 'leak') {
    const leaked = [];
    setInterval(() => {
      // Allocate and touch every page so RSS, rather than virtual memory, grows.
      leaked.push(Buffer.alloc(16 * 1024 * 1024, 1));
    }, 10);
    return ctx.hang();
  }
  if (storyboardId === 'post_result_hang') {
    // A valid result, then a stall: no exit and, in a worker, no END marker.
    spawnHangingDescendant(storyboardId);
    ctx.result(result);
    return ctx.hang();
  }
  if (storyboardId === 'noisy') {
    ctx.write(1, 'x'.repeat(2 * 1024 * 1024));
    return ctx.hang();
  }
  if (storyboardId === 'log_commands') {
    ctx.write(1, 'stdout prefix\r::error::forged stdout command\n');
    ctx.write(2, 'stderr prefix\r::warning::forged stderr command\n');
    ctx.result(result);
    return undefined;
  }
  if (storyboardId === 'crash') process.exit(17);
  if (storyboardId === 'inconsistent_result') {
    ctx.result({ ...result, totals: { ...result.totals, passed: 999 } });
    return undefined;
  }
  if (storyboardId === 'signed_requests') {
    const signedShape = process.env.FIXTURE_SIGNED_REQUESTS_SHAPE ?? 'partial';
    const summaryIds = signedShape === 'current'
      ? ['signed_requests-strict-required']
      : signedShape === 'legacy'
        ? ['signed_requests-strict', 'signed_requests-strict-required-legacy', 'signed_requests-strict-forbidden']
        : signedShape === 'duplicate'
          ? ['signed_requests-strict-required', 'signed_requests-strict-required', 'signed_requests-strict-required']
          : ['signed_requests-strict'];
    const summaries = summaryIds.map(id => ({ ...result.summaries[0], id }));
    ctx.result({
      ...result,
      summaries,
      totals: {
        ...result.totals,
        clean: summaries.length,
        total: summaries.length,
        passed: summaries.length,
      },
    });
    return undefined;
  }
  if (storyboardId === 'malformed_result') {
    ctx.result({ version: 1, storyboard_id: storyboardId, totals: { clean: 1 } });
    return undefined;
  }
  if (storyboardId === 'wrong_id') {
    // A complete, valid envelope, but for the storyboard after this one.
    const next = storyboardIds[storyboardIds.indexOf(storyboardId) + 1] ?? 'healthy';
    ctx.out(row(storyboardId));
    ctx.result(resultFor(next));
    return undefined;
  }
  if (storyboardId === 'node_options') {
    ctx.out(`NODE_OPTIONS=${process.env.NODE_OPTIONS ?? ''}`);
    ctx.result(result);
    return undefined;
  }
  if (storyboardId.startsWith('slow')) {
    await sleep(Number(process.env.FIXTURE_SLOW_MS ?? 250));
    ctx.out(row(storyboardId));
    ctx.result(result);
    return undefined;
  }
  if (storyboardId.startsWith('chatty')) {
    const line = `  ${storyboardId} ${'c'.repeat(1000)}`;
    for (let index = 0; index < Number(process.env.FIXTURE_CHATTY_KB ?? 400); index += 1) ctx.out(line);
    ctx.out(row(storyboardId));
    ctx.result(result);
    return undefined;
  }
  if (storyboardId === 'exit_after_end') {
    // A clean storyboard whose worker exits before it reads the next id.
    ctx.out(row(storyboardId));
    ctx.result(result);
    ctx.end();
    process.exit(0);
  }
  if (storyboardId === 'late_throw') {
    // Clean, but leaves async work behind that throws once the next
    // storyboard has begun in this process.
    ctx.out(row(storyboardId));
    ctx.result(result);
    ctx.onNextBegin(() => setTimeout(() => {
      throw new Error('late failure from late_throw');
    }, 10));
    return undefined;
  }
  if (storyboardId === 'retain') {
    // Incompressible memory that stays after this storyboard's result.
    const chunks = Math.ceil(Number(process.env.FIXTURE_RETAIN_MB ?? 320) / 16);
    for (let index = 0; index < chunks; index += 1) {
      retained.push(crypto.randomFillSync(Buffer.allocUnsafeSlow(16 * 1024 * 1024)));
    }
    ctx.out(row(storyboardId));
    ctx.result(result);
    return undefined;
  }
  if (storyboardId === 'heap_heavy' || storyboardId === 'heap_at_bound') {
    // The END marker reports V8 heap in use just above, or exactly at, the
    // 1.5 GiB recycle bound.
    ctx.out(row(storyboardId));
    ctx.result(result);
    ctx.end(storyboardId === 'heap_heavy' ? HEAP_RECYCLE_BOUND_BYTES + 1 : HEAP_RECYCLE_BOUND_BYTES);
    return undefined;
  }
  if (storyboardId === 'stderr_around_result') {
    // stderr written just before the envelope, and after it but before END.
    ctx.err('stderr before the result of stderr_around_result');
    ctx.out(row(storyboardId));
    ctx.result(result);
    await sleep(50);
    ctx.err('stderr after the result of stderr_around_result');
    return undefined;
  }
  // Overlap probe (FIXTURE_MARKER_DIR): healthy children report how many
  // storyboard children were alive at once.
  if (ctx.mode === 'single') participate('storyboard');
  ctx.out(row(storyboardId));
  ctx.result(result);
  return undefined;
}

runStoryboards({
  args,
  isApplicable: id => storyboardIds.includes(id),
  handler: handle,
  onRun: ({ storyboard_id: storyboardId, sequence }) => record({ event: 'run', storyboard_id: storyboardId, sequence }),
});
