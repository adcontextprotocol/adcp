'use strict';

/**
 * Records calls to functions of a Node built-in module, for work-count
 * guards: the processes a test starts, the files a setup reads or copies.
 *
 *   const spawns = require('./helpers/spawn-counter.cjs').install();
 *   const before = spawns.count;  ...  spawns.commands.slice(before)
 *
 *   const fsCalls = recordCalls('node:fs', ['readFileSync', 'cpSync']);
 *   ...  fsCalls.calls  ...  fsCalls.restore();
 *
 * The wrappers replace the functions on the module's exports and call
 * module.syncBuiltinESMExports(), so `import { spawnSync } from
 * 'node:child_process'` sees them too, from then on. A module that
 * destructured a function from require() before keeps the unwrapped one, so
 * install spawn counting before the modules under test load (in vitest, from
 * vi.hoisted). A wrapped function that calls another wrapped one (exec
 * through execFile) is recorded once.
 */

const { syncBuiltinESMExports } = require('node:module');

/**
 * Wraps `names` of the built-in module `id`; each outermost call appends
 * { name, target, argv } to `calls`: the first argument as a string, and the
 * second when it is an array (a launcher's arguments).
 */
function recordCalls(id, names) {
  const exports = require(id);
  const calls = [];
  const originals = new Map();
  let depth = 0;
  for (const name of names) {
    const original = exports[name];
    originals.set(name, original);
    exports[name] = function recordedCall(...args) {
      if (depth === 0) calls.push({ name, target: String(args[0]), argv: Array.isArray(args[1]) ? args[1].map(String) : [] });
      depth += 1;
      try {
        return original.apply(this, args);
      } finally {
        depth -= 1;
      }
    };
  }
  syncBuiltinESMExports();
  return {
    calls,
    restore() {
      for (const [name, original] of originals) exports[name] = original;
      syncBuiltinESMExports();
    },
  };
}

const LAUNCHERS = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'];
const STATE = Symbol.for('adcp.tests.spawnCounter');

/**
 * Counts the child processes this process starts from now on, through any
 * public launcher of node:child_process; `commands` holds each one's command
 * and `argvs` its arguments.
 */
function install() {
  const childProcess = require('node:child_process');
  if (childProcess[STATE]) return childProcess[STATE];
  const { calls } = recordCalls('node:child_process', LAUNCHERS);
  const state = {
    get count() { return calls.length; },
    get commands() { return calls.map((call) => call.target); },
    get argvs() { return calls.map((call) => call.argv); },
  };
  childProcess[STATE] = state;
  return state;
}

module.exports = { install, recordCalls };
