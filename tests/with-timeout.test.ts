// scripts/with-timeout.sh without coreutils `timeout` (macOS by default):
// the bash fallback must stop everything the command started, not only its
// direct child. A vitest forks-pool worker whose main process is killed would
// otherwise run on, waiting for it forever.
//
// Each case runs the real script under bash with a PATH that has no
// `timeout` or `gtimeout`, against a main process that forks a worker the way
// a forks pool does, and checks the worker is gone once the script returns.
//
// The deadline case must find the worker up when the deadline fires, however
// slowly node starts on a loaded machine. The fallback's watcher measures the
// deadline with `sleep <secs>`, so the fixture's `sleep` runs the real one and
// then, for that call only, also waits for the worker: the deadline fires at
// <secs> or once the worker is up, whichever is later.
import { execFileSync, spawn } from 'node:child_process';
import {
  closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WITH_TIMEOUT = join(REPO_ROOT, 'scripts', 'with-timeout.sh');

// Every bash a caller may get: the one on PATH and the system one (bash 3.2
// on macOS), once each.
const BASHES = [...new Set(
  [execFileSync('/bin/sh', ['-c', 'command -v bash'], { encoding: 'utf8' }).trim(), '/bin/bash']
    .filter((p) => existsSync(p))
    .map((p) => realpathSync(p)),
)];

// The tools the script and the fixture need, and nothing else.
const TOOLS = ['node', 'sleep', 'date', 'awk'];

// Forks the worker; in `crash` mode SIGKILLs itself once the worker is up,
// as an OOM kill would. Otherwise both keep a timer until stopped.
const MAIN = `
const worker = require('node:child_process').fork(require('node:path').join(__dirname, 'worker.cjs'));
worker.on('message', () => { if (process.argv[2] === 'crash') process.kill(process.pid, 'SIGKILL'); });
setInterval(() => {}, 1000);
`;
const WORKER = `
require('node:fs').writeFileSync(require('node:path').join(__dirname, 'worker.pid'), String(process.pid));
setInterval(() => {}, 1000);
process.send('ready');
`;

const dirs: string[] = [];
const groups: number[] = [];

afterEach(() => {
  for (const pgid of groups.splice(0)) {
    try { process.kill(-pgid, 'SIGKILL'); } catch { /* gone */ }
  }
  for (const dir of dirs.splice(0)) {
    const pidFile = join(dir, 'worker.pid');
    if (existsSync(pidFile)) {
      try { process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL'); } catch { /* gone */ }
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

const toolPath = (tool: string) => execFileSync('/bin/sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).trim();

/**
 * `sleep` that sleeps as asked and, when asked for the deadline, then waits
 * for ../worker.pid (at most 6 s, inside the 10 s test timeout). The real
 * sleep sits in real/ under its own name.
 */
const deadlineSleep = (secs: number) => [
  '#!/bin/sh',
  'real="${0%/*}/real/sleep"',
  '"$real" "$@" || exit',
  `[ "$1" = ${secs} ] || exit 0`,
  'i=0',
  'while [ ! -e "${0%/*}/../worker.pid" ] && [ "$i" -lt 120 ]; do "$real" 0.05; i=$((i+1)); done',
  '',
].join('\n');

function fixture(deadline?: number): { dir: string; bin: string } {
  const dir = mkdtempSync(join(tmpdir(), 'with-timeout-'));
  dirs.push(dir);
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  for (const tool of TOOLS) {
    if (tool === 'sleep' && deadline !== undefined) {
      mkdirSync(join(bin, 'real'));
      symlinkSync(toolPath(tool), join(bin, 'real', tool));
      writeFileSync(join(bin, tool), deadlineSleep(deadline), { mode: 0o755 });
    } else {
      symlinkSync(toolPath(tool), join(bin, tool));
    }
  }
  writeFileSync(join(dir, 'main.cjs'), MAIN);
  writeFileSync(join(dir, 'worker.cjs'), WORKER);
  return { dir, bin };
}

/**
 * Runs `bash with-timeout.sh <secs> node main.cjs <mode>` in its own process
 * group, output to a file (a leftover worker would hold a pipe open). With
 * waitForWorker, the deadline does not fire before the worker is up.
 */
function runWithTimeout(
  bash: string, secs: number, mode: string, { waitForWorker = false } = {},
): Promise<{ code: number | null; output: string; dir: string }> {
  const { dir, bin } = fixture(waitForWorker ? secs : undefined);
  const log = join(dir, 'output.log');
  const out = openSync(log, 'w');
  const child = spawn(bash, [WITH_TIMEOUT, String(secs), 'node', 'main.cjs', mode], {
    cwd: dir, env: { PATH: bin, HOME: dir }, detached: true, stdio: ['ignore', out, out],
  });
  closeSync(out);
  groups.push(child.pid!);
  return new Promise((resolveRun) => {
    child.on('exit', (code) => resolveRun({ code, output: readFileSync(log, 'utf8'), dir }));
  });
}

function workerPid(dir: string, output: string): number {
  const pidFile = join(dir, 'worker.pid');
  expect(existsSync(pidFile), `the worker never started; output:\n${output}`).toBe(true);
  return Number(readFileSync(pidFile, 'utf8'));
}

describe.each(BASHES)('with-timeout.sh fallback under %s', (bash) => {
  it('stops the command\'s forked workers at the deadline, prints the marker and exits 143', async () => {
    const { code, output, dir } = await runWithTimeout(bash, 1, 'hold', { waitForWorker: true });

    const pid = workerPid(dir, output);
    expect(alive(pid), `worker ${pid} outlived the timeout`).toBe(false);
    expect(code, output).toBe(143);
    expect(output).toMatch(/^⏰ TIMEOUT: with-timeout killed the command after 1s \(exit 143, elapsed \d+s\): node main\.cjs hold$/m);
  });

  it('stops the command\'s forked workers when its main process is SIGKILLed before the deadline, and exits 137', async () => {
    const { code, output, dir } = await runWithTimeout(bash, 30, 'crash');

    const pid = workerPid(dir, output);
    expect(alive(pid), `worker ${pid} outlived its main process`).toBe(false);
    expect(code, output).toBe(137);
    expect(output).not.toContain('TIMEOUT');
  });
});
