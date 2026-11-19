'use strict';

/**
 * Live-marker overlap probe for storyboard concurrency tests.
 *
 * A participant creates `<dir>/live/<pid>` on start, samples how many live
 * markers (markers whose pid is still alive) exist while it runs, records the
 * largest count it saw in `<dir>/observed/<pid>.json`, and removes its marker
 * on exit. Tests assert on the recorded counts, never on elapsed time.
 *
 * Environment:
 *   FIXTURE_MARKER_DIR      shared directory; unset = do not participate
 *   FIXTURE_MARKER_GROUP    label stored in the marker (for example a surface)
 *   FIXTURE_MARKER_PEERS    stop waiting once this many markers are live (2)
 *   FIXTURE_MARKER_GROUPS   ...and this many distinct groups are live (1)
 *   FIXTURE_MARKER_WAIT_MS  give up waiting for peers after this long (1000)
 *   FIXTURE_MARKER_HOLD_MS  keep the marker and keep sampling this long (100)
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function envNumber(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function readLive(dir) {
  const liveDir = path.join(dir, 'live');
  let names;
  try {
    names = fs.readdirSync(liveDir);
  } catch {
    return [];
  }
  const markers = [];
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    if (!isAlive(pid)) continue;
    let group;
    try {
      group = fs.readFileSync(path.join(liveDir, name), 'utf8');
    } catch {
      continue;
    }
    markers.push({ pid, group });
  }
  return markers;
}

function createMarker(dir, group) {
  const liveDir = path.join(dir, 'live');
  fs.mkdirSync(liveDir, { recursive: true });
  const marker = path.join(liveDir, String(process.pid));
  const temporary = path.join(dir, `.marker-${process.pid}`);
  fs.writeFileSync(temporary, group);
  fs.renameSync(temporary, marker);
  const remove = () => fs.rmSync(marker, { force: true });
  process.once('exit', remove);
  return remove;
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, JSON.stringify(value));
  fs.renameSync(temporary, file);
}

/** Runs the overlap probe when FIXTURE_MARKER_DIR is set; otherwise a no-op. */
function participate(group = process.env.FIXTURE_MARKER_GROUP ?? '') {
  const dir = process.env.FIXTURE_MARKER_DIR;
  if (!dir) return;
  const peers = envNumber('FIXTURE_MARKER_PEERS', 2);
  const groups = envNumber('FIXTURE_MARKER_GROUPS', 1);
  const waitMs = envNumber('FIXTURE_MARKER_WAIT_MS', 1000);
  const holdMs = envNumber('FIXTURE_MARKER_HOLD_MS', 100);

  const remove = createMarker(dir, group);
  let max = 0;
  const seenGroups = new Set();
  const sample = () => {
    const live = readLive(dir);
    max = Math.max(max, live.length);
    for (const marker of live) seenGroups.add(marker.group);
    return live;
  };

  const waitUntil = Date.now() + waitMs;
  for (;;) {
    const live = sample();
    const liveGroups = new Set(live.map(marker => marker.group)).size;
    if ((live.length >= peers && liveGroups >= groups) || Date.now() >= waitUntil) break;
    sleepSync(20);
  }
  const holdUntil = Date.now() + holdMs;
  while (Date.now() < holdUntil) {
    sleepSync(20);
    sample();
  }
  sample();
  writeJsonAtomic(path.join(dir, 'observed', `${process.pid}.json`), {
    pid: process.pid,
    group,
    max,
    groups: [...seenGroups].sort(),
  });
  remove();
}

/** Every participant's record, in no particular order. */
function readObserved(dir) {
  const observedDir = path.join(dir, 'observed');
  if (!fs.existsSync(observedDir)) return [];
  return fs.readdirSync(observedDir)
    .filter(name => name.endsWith('.json'))
    .map(name => JSON.parse(fs.readFileSync(path.join(observedDir, name), 'utf8')));
}

/**
 * Spawns a descendant that never exits, records `{ child, descendant, ...extra }`
 * in `recordFile`, and keeps this process alive forever.
 */
function hangWithDescendant(recordFile, extra = {}) {
  const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });
  if (recordFile) {
    writeJsonAtomic(recordFile, { ...extra, child: process.pid, descendant: descendant.pid });
  }
  setInterval(() => {}, 1_000);
}

module.exports = {
  hangWithDescendant,
  isAlive,
  participate,
  readLive,
  readObserved,
};
