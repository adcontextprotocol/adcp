'use strict';
/**
 * A node:test file whose runner stops reading its output before the file
 * ends, as a runner on a loaded machine does
 * (tests/profile-precommit-node-test-report.test.ts).
 *
 * Under `node --test`, each file runs in a child process that sends every
 * test event to the runner over its stdout. With --test-force-exit the child
 * calls process.exit() as soon as its reporter stream has handed the last
 * event to stdout, and a write the runner has not read yet is still queued
 * in the child. process.exit() discards the queue, the runner sees fewer
 * tests than ran, and the child still exits 0.
 *
 * The file makes that state certain instead of load-dependent:
 *   1. Five tests run, and `let the runner read` yields to the event loop, so
 *      their events reach the runner.
 *   2. `runner stops reading` stops the runner (SIGSTOP) and fills the stdout
 *      pipe until a write would block. A detached shell resumes the runner
 *      once this process has exited, or after RUNNER_STOPS_READING_MAX_MS
 *      (default 10000). With stdout blocking the fill waits for the runner,
 *      so this process cannot exit first and the bound decides; any bound
 *      gives a complete report then, so callers that preload it pass a short
 *      one.
 *   3. Five more tests run. Their events can only queue behind the full pipe.
 *
 * 12 tests run. With --test-force-exit the runner reports the first 5; with
 * stdout blocking (scripts/profile-precommit/node-test-blocking-stdout.cjs) or
 * without --test-force-exit it reports all 12.
 *
 * Only a runner's child acts. Run directly, the file only declares its tests,
 * so it never stops the shell that started it.
 */

const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const underRunner = process.env.NODE_TEST_CONTEXT === 'child-v8';
const maxPolls = Math.ceil(Number(process.env.RUNNER_STOPS_READING_MAX_MS || 10000) / 50);

for (let i = 1; i <= 5; i++) test(`reported ${i}`, () => {});

test('let the runner read', () => new Promise((resolve) => setTimeout(resolve, 50)));

test('runner stops reading', () => {
  if (!underRunner) return;
  const runner = process.ppid;
  // process.exit() runs 'exit' listeners before it discards the queue.
  const exited = path.join(os.tmpdir(), `runner-stops-reading-${process.pid}.exited`);
  process.on('exit', () => fs.writeFileSync(exited, ''));
  // The shell removes the marker once the resumed runner has reaped this
  // process (at most 5 s later).
  const resume = [
    `i=0; while [ ! -e '${exited}' ] && [ $i -lt ${maxPolls} ]; do sleep 0.05; i=$((i+1)); done`,
    `kill -CONT ${runner}`,
    `i=0; while kill -0 ${process.pid} 2>/dev/null && [ $i -lt 100 ]; do sleep 0.05; i=$((i+1)); done`,
    `rm -f '${exited}'`,
  ].join('; ');
  spawn('/bin/sh', ['-c', resume], { detached: true, stdio: 'ignore' }).unref();
  process.kill(runner, 'SIGSTOP');
  // Fill the pipe until a write would block (at most 1 MiB, above any pipe or
  // socket buffer). Newlines reach the runner as plain stdout, which no
  // reporter counts as a test.
  const chunk = Buffer.alloc(4096, 0x0a);
  try {
    for (let n = 0; n < 256; n++) fs.writeSync(1, chunk);
  } catch (error) {
    if (error.code !== 'EAGAIN') throw error;
  }
});

for (let i = 6; i <= 10; i++) test(`queued ${i}`, () => {});
