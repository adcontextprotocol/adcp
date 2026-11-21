'use strict';

/**
 * Test workspaces that never leak processes.
 *
 * Storyboard orchestration tests start orchestrators that start detached
 * child process groups, some of which hang on purpose. If a test fails or
 * times out before its own teardown, those groups are reparented to init and
 * keep running. A reaped workspace prevents that:
 *
 * - every process a test starts is tracked in the workspace
 *   (`trackProcess`), and every fixture records its own pid and its
 *   descendants' pids inside the workspace (`*.json` records with `pid`,
 *   `child` or `descendant` fields, `*.pid` files, `live/<pid>` markers);
 * - teardown kills the tracked processes first, then every recorded process
 *   group, rescanning until nothing new appears, and fails the test if any
 *   recorded process is still alive; then it removes the workspace;
 * - a process `exit` handler does the same for workspaces whose teardown
 *   never ran (for example under --test-force-exit).
 */

const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TRACKED_DIR = '.tracked-processes';
const REPO_ROOT = path.join(__dirname, '..', '..');
// A recorded pid may have exited and been reused by an unrelated process.
// Only processes started from this checkout or a test workspace, or the
// fixtures' hanging `node -e setInterval` descendants, are ever signalled.
const OWNED_COMMAND = [REPO_ROOT, fs.realpathSync(os.tmpdir()), os.tmpdir(), 'setInterval(() => {}'];
const openWorkspaces = new Set();

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function ownedByTests(pid) {
  let command;
  try {
    command = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return false;
  }
  return OWNED_COMMAND.some(fragment => command.includes(fragment));
}

function kill(pid) {
  if (!isAlive(pid) || !ownedByTests(pid)) return;
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, 'SIGKILL');
    } catch {}
  }
}

function pidsIn(value, out) {
  if (!value || typeof value !== 'object') return;
  for (const key of ['pid', 'child', 'descendant']) {
    if (Number.isSafeInteger(value[key]) && value[key] > 1) out.add(value[key]);
  }
}

function recordedPids(directory) {
  const tracked = new Set();
  const recorded = new Set();
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      const inTracked = path.basename(dir) === TRACKED_DIR;
      const inLive = path.basename(dir) === 'live' && /^\d+$/.test(entry.name);
      if (inLive) recorded.add(Number(entry.name));
      let text;
      try {
        text = fs.readFileSync(full, 'utf8');
      } catch {
        continue;
      }
      if (entry.name.endsWith('.pid') || inTracked) {
        const pid = Number(text.trim());
        if (Number.isSafeInteger(pid) && pid > 1) (inTracked ? tracked : recorded).add(pid);
      } else if (entry.name.endsWith('.json') || entry.name.endsWith('.jsonl')) {
        for (const line of text.split('\n')) {
          try {
            pidsIn(JSON.parse(line), recorded);
          } catch {}
        }
      }
    }
  };
  walk(directory);
  recorded.delete(process.pid);
  tracked.delete(process.pid);
  return { tracked, recorded };
}

/** Kills everything recorded in the workspace; returns the pids it knew. */
function reap(directory) {
  const known = new Set();
  for (let round = 0; round < 5; round += 1) {
    const { tracked, recorded } = recordedPids(directory);
    // Stop the parents first so they cannot start new children mid-reap.
    for (const pid of tracked) kill(pid);
    const fresh = [...tracked, ...recorded].filter(pid => !known.has(pid));
    for (const pid of recorded) kill(pid);
    for (const pid of fresh) known.add(pid);
    if (fresh.length === 0) break;
  }
  return known;
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function survivors(pids) {
  const owned = pid => isAlive(pid) && ownedByTests(pid);
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (![...pids].some(isAlive)) return [];
    sleepSync(25);
  }
  return [...pids].filter(owned);
}

function closeWorkspace(directory) {
  const known = reap(directory);
  const alive = survivors(known);
  fs.rmSync(directory, { recursive: true, force: true });
  openWorkspaces.delete(directory);
  return alive;
}

process.on('exit', () => {
  for (const directory of [...openWorkspaces]) {
    try {
      closeWorkspace(directory);
    } catch {}
  }
});

/**
 * A temporary directory whose teardown kills every process recorded in it
 * and fails the test if one survives.
 */
function makeReapedWorkspace(t, prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  openWorkspaces.add(directory);
  t.after(() => {
    const alive = closeWorkspace(directory);
    if (alive.length > 0) {
      throw new Error(`test left processes alive after teardown: ${alive.join(', ')}`);
    }
  });
  return directory;
}

/** Records a process the test started, so teardown kills it before anything else. */
function trackProcess(directory, pid) {
  if (!Number.isSafeInteger(pid)) return;
  const dir = path.join(directory, TRACKED_DIR);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${pid}`), String(pid));
}

/**
 * Runs a command to completion without blocking the event loop, so the test
 * runner's --test-timeout bounds it, and resolves { status, signal, stdout,
 * stderr } as spawnSync returns them. The child leads its own process group;
 * if the test ends first, teardown kills that group (`t` is a TestContext, or
 * any object whose after(fn) runs fn at teardown), and with `directory`
 * the process is also tracked in that reaped workspace. Pass `stdio` to send
 * output elsewhere (stdout and stderr are then empty strings).
 */
function runChild(t, command, args, { directory, ...options } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options, detached: true });
    if (directory) trackProcess(directory, child.pid);
    let closed = false;
    t.after(() => {
      if (closed) return;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {}
    });
    const output = { stdout: '', stderr: '' };
    for (const name of ['stdout', 'stderr']) {
      if (!child[name]) continue;
      child[name].setEncoding('utf8');
      child[name].on('data', (chunk) => { output[name] += chunk; });
    }
    child.once('error', reject);
    child.once('close', (status, signal) => {
      closed = true;
      resolve({ status, signal, ...output });
    });
  });
}

/** A reaped directory for suite-level state; close it in a `test.after`. */
function openReapedDirectory(prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  openWorkspaces.add(directory);
  return directory;
}

/** Reaps and removes a directory from openReapedDirectory; returns survivors. */
function closeReapedDirectory(directory) {
  return closeWorkspace(directory);
}

module.exports = { closeReapedDirectory, makeReapedWorkspace, openReapedDirectory, runChild, trackProcess };
