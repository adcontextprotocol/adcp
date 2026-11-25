#!/usr/bin/env node
// Runs one npm call the way `npm` runs it, with one Node process for the
// whole chain of nested calls instead of one npm process per nested call.
//
//   node tests/helpers/npm-call-replay.cjs <npm-cli.js> <npm-arg>...
//
// The call (<npm-arg>... with this process's working directory and
// environment) runs with npm's own CLI code: the Npm class next to
// <npm-cli.js>, as lib/cli/entry.js drives it. The `npm` on PATH is expected
// to be a recorder: when a script that call runs invokes npm, it writes its
// working directory, argv and environment to a new file in
// $HOOK_SHIM_NPM_QUEUE and exits 0. This process then replays every recorded
// call the same way (the recorded environment, working directory and argv, a
// fresh Npm per call). Calls that a replay records are replayed in turn until
// none is left.
//
// A replayed call must succeed. The recorder answers 0 for every call, so the
// chain around a call behaves as it would under real npm only when the real
// call would have exited 0; a failing replay exits this process with 1.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const [npmCli, ...npmArgs] = process.argv.slice(2);
const queue = process.env.HOOK_SHIM_NPM_QUEUE;
if (!npmCli || !queue || npmArgs.length === 0) {
  console.error('usage: HOOK_SHIM_NPM_QUEUE=<dir> node npm-call-replay.cjs <npm-cli.js> <npm-arg>...');
  process.exit(2);
}

const npmRoot = path.resolve(path.dirname(npmCli), '..');
// What lib/cli/entry.js does before it loads npm.
require(require.resolve('graceful-fs', { paths: [npmRoot] })).gracefulify(fs);
const Npm = require(path.join(npmRoot, 'lib', 'npm.js'));

/** One recorded call: NUL-separated cwd, argc, argv, then `env -0` output. */
function readCall(file) {
  const fields = fs.readFileSync(file, 'utf8').split('\0');
  const cwd = fields[0];
  const argc = Number(fields[1]);
  const argv = fields.slice(2, 2 + argc);
  const env = {};
  for (const entry of fields.slice(2 + argc)) {
    if (!entry) continue;
    const eq = entry.indexOf('=');
    env[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return { cwd, argv, env };
}

async function replay({ cwd, argv, env }) {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, env);
  process.chdir(cwd);
  process.argv = [process.execPath, npmCli, ...argv];
  process.exitCode = undefined;
  const npm = new Npm();
  try {
    const { exec, command, args } = await npm.load();
    if (!exec || !command) throw new Error(`npm ${argv.join(' ')}: no command to run`);
    await npm.exec(command, args);
  } finally {
    npm.unload();
  }
  if (process.exitCode) throw new Error(`npm ${argv.join(' ')} exited ${process.exitCode}`);
}

async function main() {
  await replay({ cwd: process.cwd(), argv: npmArgs, env: { ...process.env } });
  const done = new Set();
  for (;;) {
    const pending = fs.readdirSync(queue).filter((name) => !done.has(name)).sort();
    if (pending.length === 0) break;
    for (const name of pending) {
      done.add(name);
      await replay(readCall(path.join(queue, name)));
    }
  }
  process.stdout.write(`replayed ${done.size + 1} npm call(s)\n`);
}

main().then(
  () => process.exit(0),
  (err) => { console.error(err && err.stack ? err.stack : err); process.exit(1); },
);
